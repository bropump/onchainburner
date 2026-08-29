import assert from "node:assert/strict";
import worker from "./cloudflare-image-worker.mjs";

const id = "a".repeat(43);
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

globalThis.caches = {
  default: {
    match: async () => undefined,
    put: async () => undefined,
  },
};

try {
  globalThis.fetch = async () =>
    new Response(new Uint8Array(200_001), {
      headers: { "content-type": "image/webp" },
    });
  const oversized = await worker.fetch(
    new Request(`https://images.example/irys/${id}`),
    {},
    { waitUntil() {} }
  );
  assert.equal(oversized.status, 502);

  globalThis.fetch = async () =>
    new Response(new TextEncoder().encode("not really webp"), {
      headers: { "content-type": "image/webp" },
    });
  const forged = await worker.fetch(
    new Request(`https://images.example/irys/${id}`),
    {},
    { waitUntil() {} }
  );
  assert.equal(forged.status, 502);

  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);
  globalThis.fetch = async () =>
    new Response(webp, { headers: { "content-type": "image/webp" } });
  const valid = await worker.fetch(
    new Request(`https://images.example/irys/${id}`),
    {},
    { waitUntil() {} }
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(new Uint8Array(await valid.arrayBuffer()), webp);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
}

console.log("image worker security checks passed");
