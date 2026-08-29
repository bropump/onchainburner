import assert from "node:assert/strict";
import worker from "../worker";

const WORKER_ORIGIN = "https://onchainburner.optical.workers.dev";

function limiter() {
  let calls = 0;
  return {
    binding: {
      async limit(): Promise<{ success: boolean }> {
        calls += 1;
        return { success: true };
      },
    },
    calls: () => calls,
  };
}

function environment(rpc = limiter(), api = limiter()) {
  return {
    SOLANA_RPC_URL: "https://rpc.example/key/secret-value-123456",
    BURN_SERVICE_ORIGIN: "https://service.example",
    ASSETS: { fetch: async () => new Response("asset") },
    RPC_LIMITER: rpc.binding,
    API_LIMITER: api.binding,
  };
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    {
      const api = limiter();
      const env = environment(limiter(), api);
      let destination: URL | undefined;
      let forwarded: Headers | undefined;
      globalThis.fetch = async (input, init) => {
        destination = new URL(String(input));
        forwarded = new Headers(init?.headers);
        return Response.json({ ok: true });
      };
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api//attacker.example/x`, {
          headers: {
            origin: WORKER_ORIGIN,
            accept: "application/json",
            authorization: "Bearer must-not-travel",
            cookie: "session=must-not-travel",
            referer: `${WORKER_ORIGIN}/private`,
            "cf-ray": "must-not-travel",
          },
        }),
        env
      );
      assert.equal(response.status, 200);
      assert.equal(destination?.origin, "https://service.example");
      assert.equal(destination?.pathname, "/attacker.example/x");
      assert.equal(forwarded?.get("origin"), WORKER_ORIGIN);
      assert.equal(forwarded?.get("accept"), "application/json");
      assert.equal(forwarded?.has("authorization"), false);
      assert.equal(forwarded?.has("cookie"), false);
      assert.equal(forwarded?.has("referer"), false);
      assert.equal(forwarded?.has("cf-ray"), false);
      assert.equal(api.calls(), 1);
    }

    {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return Response.json({ ok: true });
      };
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/health`, {
          method: "DELETE",
          headers: { origin: WORKER_ORIGIN },
        }),
        environment()
      );
      assert.equal(response.status, 405);
      assert.equal(fetched, false);
    }

    {
      const api = limiter();
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/health`, {
          headers: { "sec-fetch-site": "cross-site" },
        }),
        environment(limiter(), api)
      );
      assert.equal(response.status, 403);
      assert.equal(api.calls(), 0);
    }

    {
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/api/health`, {
          headers: { origin: "http://onchainburner.optical.workers.dev" },
        }),
        environment()
      );
      assert.equal(response.status, 403);
    }

    {
      const rpc = limiter();
      globalThis.fetch = async () =>
        Response.json([
          { jsonrpc: "2.0", id: 1, result: 1 },
          { jsonrpc: "2.0", id: 2, result: 2 },
          { jsonrpc: "2.0", id: 3, result: 3 },
        ]);
      const calls = [1, 2, 3].map((id) => ({
        jsonrpc: "2.0",
        id,
        method: "getSlot",
      }));
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/rpc`, {
          method: "POST",
          headers: {
            origin: WORKER_ORIGIN,
            "content-type": "application/json",
          },
          body: JSON.stringify(calls),
        }),
        environment(rpc)
      );
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(rpc.calls(), 3);
    }

    {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return Response.json({ ok: true });
      };
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSlot",
        params: ["é".repeat(140_000)],
      });
      assert.ok(body.length < 256 * 1024);
      assert.ok(new TextEncoder().encode(body).byteLength > 256 * 1024);
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/rpc`, {
          method: "POST",
          headers: { origin: WORKER_ORIGIN },
          body,
        }),
        environment()
      );
      assert.equal(response.status, 413);
      assert.equal(fetched, false);
    }

    {
      const secretUrl = "https://rpc.example/key/secret-value-123456";
      globalThis.fetch = async () =>
        new Response(`provider failed at ${secretUrl}`, {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/rpc`, {
          method: "POST",
          headers: { origin: WORKER_ORIGIN },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSlot",
          }),
        }),
        environment()
      );
      assert.equal(response.status, 500);
      assert.equal((await response.text()).includes(secretUrl), false);
    }

    {
      const secretUrl = "https://rpc.example/key/secret-value-123456";
      const encoder = new TextEncoder();
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(encoder.encode('{"jsonrpc":"2.0","result":"https://rpc.example/key/sec'));
              stream.enqueue(encoder.encode('ret-value-123456","id":1}'));
              stream.close();
            },
          }),
          { headers: { "content-type": "application/json" } }
        );
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/rpc`, {
          method: "POST",
          headers: { origin: WORKER_ORIGIN },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSlot",
          }),
        }),
        environment()
      );
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes(secretUrl), false);
      assert.equal(body.includes("secret-value-123456"), false);
      assert.doesNotThrow(() => JSON.parse(body));
    }

    {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return Response.json({ ok: true });
      };
      const { RPC_LIMITER: _omitted, ...env } = environment();
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}/rpc`, {
          method: "POST",
          headers: { origin: WORKER_ORIGIN },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSlot",
          }),
        }),
        env
      );
      assert.equal(response.status, 503);
      assert.equal(fetched, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await main();
console.log("worker security checks passed");
