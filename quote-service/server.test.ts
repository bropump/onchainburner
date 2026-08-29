import { expect } from "chai";
import { Readable } from "node:stream";
import type http from "node:http";
import {
  createBurnServer,
  createCloudflareImageCompressor,
  createIrysMetadataUploadExecutor,
  MetadataImageCompressor,
  MetadataUploadError,
} from "./server";

type TestRequest = Readonly<{
  method?: string;
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;

const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
]);

const testCompressor: MetadataImageCompressor = {
  compress: async () => ({ image: WEBP, contentType: "image/webp" }),
  deliveryUri: (permanentImageUri) =>
    permanentImageUri.replace(
      "https://gateway.irys.xyz/",
      "https://images.example/irys/"
    ),
};

function metadataResult() {
  return {
    uri: `https://gateway.irys.xyz/${"m".repeat(43)}`,
    imageUri: `https://gateway.irys.xyz/${"i".repeat(43)}`,
    deliveryImageUri: `https://images.example/irys/${"i".repeat(43)}`,
    originalImageBytes: 8,
    imageBytes: WEBP.length,
  };
}

/** Exercise the real http.Server request listener without opening a socket. */
async function dispatch(
  server: http.Server,
  input: TestRequest
): Promise<{
  status: number;
  headers: Headers;
  json: () => Promise<Record<string, any>>;
}> {
  const request = Readable.from(
    input.body === undefined ? [] : [Buffer.from(input.body)]
  ) as http.IncomingMessage;
  request.method = input.method ?? "GET";
  request.url = input.path;
  request.headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ])
  );
  Object.defineProperty(request, "socket", {
    value: { remoteAddress: "127.0.0.1" },
  });

  let status = 200;
  let headersSent = false;
  const headers = new Headers();
  const chunks: Buffer[] = [];
  const finishListeners: Array<() => void> = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const response = {
    get headersSent() {
      return headersSent;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name, String(value));
      return this;
    },
    writeHead(
      code: number,
      values?: Readonly<Record<string, string | number>>
    ) {
      status = code;
      headersSent = true;
      for (const [name, value] of Object.entries(values ?? {})) {
        headers.set(name, String(value));
      }
      return this;
    },
    once(event: string, listener: () => void) {
      if (event === "finish") finishListeners.push(listener);
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      headersSent = true;
      for (const listener of finishListeners) listener();
      finish();
      return this;
    },
    destroy() {
      finish();
      return this;
    },
  } as unknown as http.ServerResponse;
  server.emit("request", request, response);
  await completed;
  const body = Buffer.concat(chunks).toString("utf8");
  return {
    status,
    headers,
    json: async () => JSON.parse(body) as Record<string, any>,
  };
}

describe("keyless HTTP boundary", () => {
  it("exposes the caller-paid prepare/submit contract and refuses one-shot /burn", async () => {
    const logs: Array<Readonly<Record<string, unknown>>> = [];
    const handle = createBurnServer(
      {
        execute: async () => Promise.reject(new Error("one-shot path used")),
      } as never,
      {
        burnEnabled: true,
        oneShotEnabled: false,
        log: (line) => logs.push(line),
        prepare: async () => ({
          preparationId: "request-1",
          requestId: "request-1",
          vault: "vault-public-key",
          callerPublicKey: "caller-public-key",
          transactionBase64: "A".repeat(128),
          messageSha256: "digest",
          lastValidBlockHeight: 123,
        }),
        submitSigned: async () => ({
          requestId: "request-1",
          submissionId: "relay-id",
          messageSha256: "digest",
          transactionBytes: 900,
        }),
      }
    );
    try {
      // No fee payer on this revision: one-shot /burn is gone for good.
      const oneShot = await dispatch(handle.server, {
        path: "/burn",
        method: "POST",
      });
      expect(oneShot.status).to.equal(410);

      const prepared = await dispatch(handle.server, {
        path: "/burn/prepare",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "request-1" }),
      });
      expect(prepared.status).to.equal(200);
      const preparation = (await prepared.json()) as {
        transactionBase64: string;
      };
      expect(preparation.transactionBase64).to.equal("A".repeat(128));

      const submitted = await dispatch(handle.server, {
        path: "/burn/submit",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "request-1",
          signedTransactionBase64: "B".repeat(88),
        }),
      });
      expect(submitted.status).to.equal(200);
      expect((await submitted.json()).submissionId).to.equal("relay-id");
      expect(JSON.stringify(logs)).not.to.contain("A".repeat(64));
      expect(JSON.stringify(logs)).not.to.contain("B".repeat(64));
    } finally {
      await handle.shutdown("test");
    }
  });

  it("serves minimal health/readiness responses and fails /burn closed", async () => {
    let executions = 0;
    let readinessChecks = 0;
    const handle = createBurnServer(
      {
        execute: async () => {
          executions += 1;
          throw new Error("must not execute");
        },
      } as never,
      {
        burnEnabled: false,
        readiness: async () => {
          readinessChecks += 1;
        },
        log: () => undefined,
      }
    );
    try {
      const health = await dispatch(handle.server, { path: "/healthz" });
      expect(health.status).to.equal(200);
      expect(await health.json()).to.deep.equal({
        status: "ok",
        draining: false,
      });

      const ready = await dispatch(handle.server, { path: "/readyz" });
      expect(ready.status).to.equal(200);
      expect(await ready.json()).to.deep.equal({ status: "ready" });
      expect(readinessChecks).to.equal(1);

      const burn = await dispatch(handle.server, {
        path: "/burn",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(burn.status).to.equal(503);
      expect(await burn.json()).to.deep.equal({
        code: "BURNS_DISABLED",
        message: "burn submission is disabled on this revision",
      });
      expect(executions).to.equal(0);
    } finally {
      await handle.shutdown("test");
    }
  });

  it("reports dependency failure as not-ready without leaking long payloads", async () => {
    const handle = createBurnServer(
      { execute: async () => Promise.reject(new Error("unused")) } as never,
      {
        burnEnabled: false,
        readiness: async () => {
          throw new Error(`rpc failure ${"A".repeat(128)}`);
        },
        log: () => undefined,
      }
    );
    try {
      const response = await dispatch(handle.server, { path: "/readyz" });
      expect(response.status).to.equal(503);
      const body = (await response.json()) as {
        status: string;
        reason: string;
      };
      expect(body.status).to.equal("not-ready");
      expect(body.reason).to.equal("rpc failure [redacted:128]");
    } finally {
      await handle.shutdown("test");
    }
  });

  it("bounds both interactive reference endpoints with a typed timeout", async () => {
    const never = () =>
      new Promise<Readonly<Record<string, unknown>>>(() => undefined);
    const handle = createBurnServer(
      { execute: async () => Promise.reject(new Error("unused")) } as never,
      {
        burnEnabled: false,
        referenceRequestDeadlineMs: 10,
        markets: never,
        resolve: never,
        log: () => undefined,
      }
    );
    try {
      for (const path of [
        "/reference/markets?mint=mint",
        "/reference/resolve?mint=mint",
      ]) {
        const response = await dispatch(handle.server, { path });
        expect(response.status).to.equal(504);
        expect(await response.json()).to.deep.equal({
          code: "REFERENCE_DISCOVERY_TIMEOUT",
          message: "reference request timed out after 10 ms; retry",
        });
      }
    } finally {
      await handle.shutdown("test");
    }
  });

  it("keeps metadata upload disabled without an injected upload pipeline", async () => {
    const handle = createBurnServer(
      { execute: async () => Promise.reject(new Error("unused")) } as never,
      { burnEnabled: false, log: () => undefined }
    );
    try {
      const response = await dispatch(handle.server, {
        path: "/metadata/upload",
        method: "POST",
        headers: {
          origin: "https://app.example",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).to.equal(503);
      expect(await response.json()).to.deep.equal({
        code: "METADATA_UPLOAD_DISABLED",
        message:
          "metadata upload is disabled because the server-side Irys and Cloudflare pipeline is not configured",
      });
      expect(response.headers.get("access-control-allow-origin")).to.equal(
        null
      );
    } finally {
      await handle.shutdown("test");
    }
  });

  it("uploads bounded, signature-checked metadata only for an allowed origin", async () => {
    const received: Array<{ image: Buffer; contentType: string }> = [];
    const handle = createBurnServer(
      { execute: async () => Promise.reject(new Error("unused")) } as never,
      {
        burnEnabled: false,
        allowedOrigins: ["https://app.example"],
        metadataUpload: async (input) => {
          received.push({
            image: input.image,
            contentType: input.imageContentType,
          });
          return metadataResult();
        },
        log: () => undefined,
      }
    );
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const request = {
      requestId: "a".repeat(64),
      name: "Burner",
      symbol: "BURN",
      description: "Permanent metadata",
      image: {
        contentType: "image/png",
        dataBase64: png.toString("base64"),
      },
    };
    try {
      const forbidden = await dispatch(handle.server, {
        path: "/metadata/upload",
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(forbidden.status).to.equal(403);
      expect((await forbidden.json()).code).to.equal("UPLOAD_ORIGIN_FORBIDDEN");

      const mismatched = await dispatch(handle.server, {
        path: "/metadata/upload",
        method: "POST",
        headers: {
          origin: "https://app.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...request,
          image: { ...request.image, contentType: "image/jpeg" },
        }),
      });
      expect(mismatched.status).to.equal(415);
      expect((await mismatched.json()).code).to.equal("IMAGE_TYPE_MISMATCH");

      const uploaded = await dispatch(handle.server, {
        path: "/metadata/upload",
        method: "POST",
        headers: {
          origin: "https://app.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(uploaded.status).to.equal(200);
      expect(uploaded.headers.get("access-control-allow-origin")).to.equal(
        "https://app.example"
      );
      expect(await uploaded.json()).to.deep.equal(metadataResult());
      expect(received).to.have.length(1);
      expect(received[0].contentType).to.equal("image/png");
      expect(received[0].image.equals(png)).to.equal(true);
    } finally {
      await handle.shutdown("test");
    }
  });

  it("rate-limits the paid endpoint per IP", async () => {
    const handle = createBurnServer(
      { execute: async () => Promise.reject(new Error("unused")) } as never,
      {
        burnEnabled: false,
        allowedOrigins: ["https://app.example"],
        metadataUploadRateLimitPerIp: 1,
        metadataUploadGlobalRateLimit: 10,
        metadataUpload: async () => metadataResult(),
        log: () => undefined,
      }
    );
    const body = JSON.stringify({
      requestId: "b".repeat(64),
      name: "Burner",
      symbol: "BURN",
      description: "",
      image: {
        contentType: "image/jpeg",
        dataBase64: Buffer.from("ffd8ff", "hex").toString("base64"),
      },
    });
    try {
      const postUpload = () =>
        dispatch(handle.server, {
          path: "/metadata/upload",
          method: "POST",
          headers: {
            origin: "https://app.example",
            "content-type": "application/json",
          },
          body,
        });
      expect((await postUpload()).status).to.equal(200);
      const limited = await postUpload();
      expect(limited.status).to.equal(429);
      expect((await limited.json()).code).to.equal("UPLOAD_RATE_LIMITED");
      expect(Number(limited.headers.get("retry-after"))).to.be.greaterThan(0);
    } finally {
      await handle.shutdown("test");
    }
  });

  it("authenticates the stateless Cloudflare transform and derives delivery from Irys", async () => {
    const token = "c".repeat(32);
    let requestUrl = "";
    let authorization = "";
    const compressor = createCloudflareImageCompressor(
      "https://images.example",
      token,
      async (input, init) => {
        requestUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(WEBP, {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
    );
    const compressed = await compressor.compress(
      Buffer.from("89504e470d0a1a0a", "hex"),
      "image/png"
    );
    expect(requestUrl).to.equal("https://images.example/compress");
    expect(authorization).to.equal(`Bearer ${token}`);
    expect(compressed.contentType).to.equal("image/webp");
    expect(compressed.image.equals(WEBP)).to.equal(true);
    expect(
      compressor.deliveryUri(`https://gateway.irys.xyz/${"i".repeat(43)}`)
    ).to.equal(`https://images.example/irys/${"i".repeat(43)}`);
  });

  it("compresses before Irys and keeps both permanent metadata URIs on Irys", async () => {
    const events: string[] = [];
    const writes: Buffer[] = [];
    const execute = createIrysMetadataUploadExecutor(
      {
        getBalance: async () => {
          events.push("irys-balance");
          return { toString: () => "100" };
        },
        getPrice: async (bytes) => {
          events.push(`irys-price-${bytes}`);
          return { toString: () => "1" };
        },
        upload: async (data) => {
          events.push(`irys-upload-${writes.length + 1}`);
          writes.push(Buffer.from(data));
          return {
            id: (writes.length === 1 ? "i" : "m").repeat(43),
          };
        },
        utils: { fromAtomic: (value) => value.toString() },
      },
      {
        compress: async () => {
          events.push("cloudflare-compress");
          return { image: WEBP, contentType: "image/webp" };
        },
        deliveryUri: testCompressor.deliveryUri,
      }
    );
    const source = Buffer.from("89504e470d0a1a0a", "hex");
    const result = await execute({
      name: "Burner",
      symbol: "BURN",
      description: "Permanent metadata",
      image: source,
      imageContentType: "image/png",
    });

    expect(events[0]).to.equal("cloudflare-compress");
    expect(events.indexOf("irys-upload-1")).to.be.greaterThan(
      events.indexOf("irys-balance")
    );
    expect(events.indexOf("irys-upload-2")).to.be.greaterThan(
      events.indexOf("irys-upload-1")
    );
    expect(writes[0].equals(WEBP)).to.equal(true);
    expect(JSON.parse(writes[1].toString("utf8"))).to.deep.equal({
      name: "Burner",
      symbol: "BURN",
      description: "Permanent metadata",
      image: `https://gateway.irys.xyz/${"i".repeat(43)}`,
    });
    expect(result).to.deep.equal({
      uri: `https://gateway.irys.xyz/${"m".repeat(43)}`,
      imageUri: `https://gateway.irys.xyz/${"i".repeat(43)}`,
      deliveryImageUri: `https://images.example/irys/${"i".repeat(43)}`,
      originalImageBytes: source.length,
      imageBytes: WEBP.length,
    });
  });

  it("accepts padded, serialized, and Axios-wrapped receipt shapes emitted in workerd", async () => {
    let writes = 0;
    const currentBase58Id =
      "Bo9c7TsQ1f83uTuXEeB4miA1dyExtV2Dh5otznEnwwif";
    const execute = createIrysMetadataUploadExecutor(
      {
        getBalance: async () => ({ toString: () => "100" }),
        getPrice: async () => ({ toString: () => "1" }),
        upload: async () => {
          writes += 1;
          return (writes === 1
            ? JSON.stringify({ id: currentBase58Id })
            : { data: JSON.stringify({ id: "m".repeat(43) }) }) as never;
        },
        utils: { fromAtomic: (value) => value.toString() },
      },
      {
        compress: async () => ({ image: WEBP, contentType: "image/webp" }),
        deliveryUri: testCompressor.deliveryUri,
      }
    );

    const result = await execute({
      name: "Burner",
      symbol: "BURN",
      description: "Worker receipts",
      image: Buffer.from("89504e470d0a1a0a", "hex"),
      imageContentType: "image/png",
    });
    expect(result.imageUri).to.equal(
      `https://gateway.irys.xyz/${currentBase58Id}`
    );
    expect(result.uri).to.equal(
      `https://gateway.irys.xyz/${"m".repeat(43)}`
    );
  });

  it("writes optional socials into the permanent metadata, omitting blanks", async () => {
    const writes: Buffer[] = [];
    const execute = createIrysMetadataUploadExecutor(
      {
        getBalance: async () => ({ toString: () => "100" }),
        getPrice: async () => ({ toString: () => "1" }),
        upload: async (data) => {
          writes.push(Buffer.from(data));
          return { id: (writes.length === 1 ? "i" : "m").repeat(43) };
        },
        utils: { fromAtomic: (value) => value.toString() },
      },
      {
        compress: async () => ({ image: WEBP, contentType: "image/webp" }),
        deliveryUri: testCompressor.deliveryUri,
      }
    );
    await execute({
      name: "Burner",
      symbol: "BURN",
      description: "With socials",
      links: {
        website: "https://burner.example/",
        twitter: "https://x.com/burner",
      },
      image: Buffer.from("89504e470d0a1a0a", "hex"),
      imageContentType: "image/png",
    });

    // telegram was never supplied, so it must not appear at all: an empty
    // key would be written to permanent storage and could never be removed.
    expect(JSON.parse(writes[1].toString("utf8"))).to.deep.equal({
      name: "Burner",
      symbol: "BURN",
      description: "With socials",
      image: `https://gateway.irys.xyz/${"i".repeat(43)}`,
      website: "https://burner.example/",
      twitter: "https://x.com/burner",
    });
  });

  it("reports insufficient Irys credits before writing either data item", async () => {
    let uploads = 0;
    const execute = createIrysMetadataUploadExecutor(
      {
        getBalance: async () => ({ toString: () => "1" }),
        getPrice: async () => ({ toString: () => "10" }),
        upload: async () => {
          uploads += 1;
          return { id: "x".repeat(43) };
        },
        utils: { fromAtomic: (value) => value.toString() },
      },
      testCompressor
    );
    let error: unknown;
    try {
      await execute({
        name: "Burner",
        symbol: "BURN",
        description: "",
        image: Buffer.from("ffd8ff", "hex"),
        imageContentType: "image/jpeg",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(MetadataUploadError);
    expect((error as MetadataUploadError).code).to.equal(
      "IRYS_INSUFFICIENT_FUNDS"
    );
    expect(uploads).to.equal(0);
  });

  it("returns no URI when the metadata write fails and discards SDK diagnostics", async () => {
    const secretLikeText = `[${Array.from({ length: 64 }, (_, i) => i).join(
      ","
    )}]`;
    let uploads = 0;
    const execute = createIrysMetadataUploadExecutor(
      {
        getBalance: async () => ({ toString: () => "100" }),
        getPrice: async () => ({ toString: () => "1" }),
        upload: async () => {
          uploads += 1;
          if (uploads === 1) return { id: "i".repeat(43) };
          throw new Error(`SDK wallet=${secretLikeText}`);
        },
        utils: { fromAtomic: (value) => value.toString() },
      },
      testCompressor
    );
    let error: unknown;
    try {
      await execute({
        name: "Burner",
        symbol: "BURN",
        description: "",
        image: Buffer.from("ffd8ff", "hex"),
        imageContentType: "image/jpeg",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(MetadataUploadError);
    expect((error as MetadataUploadError).code).to.equal("IRYS_UPLOAD_FAILED");
    expect((error as Error).message).to.equal("Irys metadata upload failed");
    expect((error as Error).message).not.to.contain(secretLikeText);
    expect(uploads).to.equal(2);
  });
});
