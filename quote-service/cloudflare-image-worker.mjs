const MAX_INPUT_BYTES = 10_000_000;
const MAX_OUTPUT_BYTES = 200_000;
const INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ENCODING_PASSES = [
  { width: 512, quality: 82 },
  { width: 512, quality: 70 },
  { width: 384, quality: 65 },
];

function fixedResponse(status, message) {
  return Response.json(
    { code: "IMAGE_PIPELINE_ERROR", message },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }
  );
}

async function authorized(request, secret) {
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret ?? "")),
  ]);
  const left = new Uint8Array(suppliedHash);
  const right = new Uint8Array(expectedHash);
  let difference = supplied.length > 0 && secret ? 0 : 1;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function readBoundedBody(body, maxBytes) {
  if (!body) return null;
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isWebP(bytes) {
  return (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

async function compress(request, env) {
  if (!(await authorized(request, env.IMAGE_PIPELINE_TOKEN))) {
    return fixedResponse(401, "unauthorized");
  }
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!INPUT_TYPES.has(contentType)) {
    return fixedResponse(415, "unsupported image type");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) {
    return fixedResponse(413, "image is too large");
  }
  const source = await readBoundedBody(request.body, MAX_INPUT_BYTES);
  if (!source?.byteLength)
    return fixedResponse(413, "image is empty or too large");

  try {
    for (const pass of ENCODING_PASSES) {
      const stream = new Blob([source], { type: contentType }).stream();
      const transformed = await env.IMAGES.input(stream)
        .transform({
          width: pass.width,
          height: pass.width,
          fit: "scale-down",
        })
        .output({ format: "image/webp", quality: pass.quality, anim: false });
      const response = transformed.response();
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength <= MAX_OUTPUT_BYTES && isWebP(bytes)) {
        return new Response(bytes, {
          headers: {
            "content-type": "image/webp",
            "content-length": String(bytes.byteLength),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }
  } catch {
    // Decoder/encoder diagnostics are intentionally not returned.
  }
  return fixedResponse(422, "image could not be compressed to the target size");
}

async function deliverIrys(request, url, context) {
  const match = url.pathname.match(/^\/irys\/([A-Za-z0-9_-]{43})$/);
  if (!match || url.search || url.hash) return fixedResponse(404, "not found");

  const cache = caches.default;
  const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(`https://gateway.irys.xyz/${match[1]}`, {
    redirect: "error",
  });
  if (
    !upstream.ok ||
    !/^image\/webp\b/i.test(upstream.headers.get("content-type") ?? "")
  ) {
    return fixedResponse(502, "permanent image is unavailable");
  }
  const response = new Response(upstream.body, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, s-maxage=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/compress") {
      return compress(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/irys/")) {
      return deliverIrys(request, url, context);
    }
    return fixedResponse(404, "not found");
  },
};
