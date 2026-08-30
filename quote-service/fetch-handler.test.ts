import { expect } from "chai";
import { createBurnFetchHandler } from "./fetch-handler";

const ORIGIN = "https://app.example";

describe("quote-service Worker transport", () => {
  it("serves probes and preserves the production one-shot refusal", async () => {
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      { oneShotEnabled: false }
    );
    const health = await handler(new Request("https://internal/healthz"));
    expect(health.status).to.equal(200);
    expect(await health.json()).to.deep.equal({
      status: "ok",
      draining: false,
    });

    const burn = await handler(
      new Request("https://internal/burn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );
    expect(burn.status).to.equal(410);
    expect((await burn.json()).code).to.equal("CALLER_PAID_ONLY");
  });

  it("routes prepare and submit through the injected unchanged operations", async () => {
    const seen: string[] = [];
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      {
        oneShotEnabled: false,
        prepare: async () => {
          seen.push("prepare");
          return { preparationId: "p" };
        },
        submitSigned: async () => {
          seen.push("submit");
          return { submissionId: "s" };
        },
      }
    );
    for (const path of ["/burn/prepare", "/burn/submit"]) {
      const response = await handler(
        new Request(`https://internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      );
      expect(response.status).to.equal(200);
    }
    expect(seen).to.deep.equal(["prepare", "submit"]);
  });

  it("enforces byte-sized request caps before invoking an operation", async () => {
    let called = false;
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      {
        maxBodyBytes: 4,
        prepare: async () => {
          called = true;
          return {};
        },
      }
    );
    const response = await handler(
      new Request("https://internal/burn/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"x":1}',
      })
    );
    expect(response.status).to.equal(413);
    expect(called).to.equal(false);
  });

  it("keeps the paid metadata route behind an exact Origin", async () => {
    let called = false;
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      {
        allowedOrigins: [ORIGIN],
        metadataUpload: async () => {
          called = true;
          throw new Error("not expected");
        },
      }
    );
    const response = await handler(
      new Request("https://internal/metadata/upload", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: "{}",
      })
    );
    expect(response.status).to.equal(403);
    expect(called).to.equal(false);
    expect(response.headers.get("access-control-allow-origin")).to.equal(null);
  });

  it("uses the injected durable gate before any paid Irys write", async () => {
    let uploaded = 0;
    let acquiredFor = "";
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      {
        allowedOrigins: [ORIGIN],
        metadataUpload: async () => {
          uploaded += 1;
          throw new Error("rate-limited upload must never run");
        },
        metadataUploadGate: {
          acquire: async (ip) => {
            acquiredFor = ip;
            return { kind: "rate", retryAfter: 321 };
          },
          complete: async () => undefined,
          fail: async () => undefined,
          release: async () => undefined,
        },
      }
    );
    const response = await handler(
      new Request("https://internal/metadata/upload", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({
          requestId: "a".repeat(64),
          name: "Cooked",
          symbol: "COOK",
          description: "fixture",
          links: {},
          image: {
            contentType: "image/png",
            dataBase64: Buffer.from("89504e470d0a1a0a", "hex").toString(
              "base64"
            ),
          },
        }),
      })
    );
    expect(response.status).to.equal(429);
    expect(response.headers.get("retry-after")).to.equal("321");
    expect(acquiredFor).to.equal("203.0.113.10");
    expect(uploaded).to.equal(0);
  });

  it("replays a persisted receipt for the same paid upload request", async () => {
    const requestId = "d".repeat(64);
    const receipt = {
      uri: `https://gateway.irys.xyz/${"m".repeat(43)}`,
      imageUri: `https://gateway.irys.xyz/${"i".repeat(43)}`,
      deliveryImageUri: `https://images.example/irys/${"i".repeat(43)}`,
      originalImageBytes: 8,
      imageBytes: 12,
    };
    let uploaded = 0;
    let stored: typeof receipt | undefined;
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      {
        allowedOrigins: [ORIGIN],
        metadataUpload: async () => {
          uploaded += 1;
          return receipt;
        },
        metadataUploadGate: {
          acquire: async (_ip, id, fingerprint) => {
            expect(id).to.equal(requestId);
            expect(fingerprint).to.match(/^[0-9a-f]{64}$/);
            return stored
              ? { kind: "replay" as const, result: stored }
              : { kind: "acquired" as const, token: crypto.randomUUID() };
          },
          complete: async (_token, id, result) => {
            expect(id).to.equal(requestId);
            stored = result as typeof receipt;
          },
          fail: async () => undefined,
          release: async () => undefined,
        },
      }
    );
    const body = JSON.stringify({
      requestId,
      name: "Cooked",
      symbol: "COOK",
      description: "fixture",
      image: {
        contentType: "image/png",
        dataBase64: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      },
    });
    const send = () =>
      handler(
        new Request("https://internal/metadata/finalize", {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
          },
          body,
        })
      );
    expect((await send()).status).to.equal(200);
    const replay = await send();
    expect(replay.status).to.equal(200);
    expect(await replay.json()).to.deep.equal(receipt);
    expect(uploaded).to.equal(1);
  });

  it("prepares the image on Cloudflare without creating permanent metadata", async () => {
    let prepared = 0;
    let permanentlyUploaded = 0;
    const handler = createBurnFetchHandler(
      { execute: async () => ({ status: "unused" } as never) },
      {
        allowedOrigins: [ORIGIN],
        metadataImagePrepare: async (input) => {
          prepared += 1;
          expect(input.imageContentType).to.equal("image/png");
          return {
            imageBase64: Buffer.from(
              "524946460000000057454250",
              "hex"
            ).toString("base64"),
            imageContentType: "image/webp",
            originalImageBytes: input.image.length,
            imageBytes: 12,
          };
        },
        metadataUpload: async () => {
          permanentlyUploaded += 1;
          throw new Error("not expected before confirmation");
        },
      }
    );
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const response = await handler(
      new Request("https://internal/metadata/image/prepare", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          image: {
            contentType: "image/png",
            dataBase64: png.toString("base64"),
          },
        }),
      })
    );
    expect(response.status).to.equal(200);
    expect((await response.json()).imageContentType).to.equal("image/webp");
    expect(prepared).to.equal(1);
    expect(permanentlyUploaded).to.equal(0);
  });

  it("exposes only the routes implemented by the production quote service", async () => {
    const handler = createBurnFetchHandler({
      execute: async () => ({ status: "unused" } as never),
    });
    // /token, /token/search and /token/image ARE implemented: the launch
    // picker uses them to discover and render burn targets. The demo-only
    // routes stay absent.
    for (const path of ["/demo/curve", "/demo/trade"]) {
      const response = await handler(new Request(`https://internal${path}`));
      expect(response.status, path).to.equal(404);
    }
  });

  it("bounds token search before calling the public token index", async () => {
    const handler = createBurnFetchHandler({
      execute: async () => ({ status: "unused" } as never),
    });
    for (const query of ["", "x", "x".repeat(65), "%00bad"]) {
      const response = await handler(
        new Request(`https://internal/token/search?query=${query}`)
      );
      expect(response.status).to.equal(200);
      expect(await response.json()).to.deep.equal({ results: [] });
    }
  });
});
