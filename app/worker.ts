/**
 * Cloudflare Worker fronting the static app.
 *
 * Beyond serving assets it exposes a narrow Solana JSON-RPC proxy at `/rpc`
 * and the private quote-service binding at `/api`.
 *
 * Why this exists at all: the app previously read its RPC endpoint from
 * `VITE_RPC_URL`, and Vite inlines `VITE_*` into the JavaScript bundle at
 * build time. On a public deployment that publishes the key to every visitor.
 * There is no way to put a key in a static bundle safely, so the key lives
 * here and the browser talks to same-origin `/rpc` instead.
 *
 * The proxy is deliberately NOT a general passthrough. An open RPC relay on a
 * paid endpoint is someone else's free quota: the method allowlist below is
 * what this app actually calls, and nothing else is forwarded.
 */

import {
  communityLeaderboard,
  communityLaunchSummary,
  communityVaultSummary,
  indexFinalizedBurns,
} from "./community-indexer";

type AppEnv = Pick<Env, "SOLANA_RPC_URL" | "COMMUNITY_DB"> & {
  BURN_SERVICE?: Pick<Fetcher, "fetch">;
  ASSETS: Pick<Fetcher, "fetch">;
  RPC_LIMITER?: Pick<RateLimit, "limit">;
  API_LIMITER?: Pick<RateLimit, "limit">;
};

type RateLimiter = AppEnv["RPC_LIMITER"];

/** Client IP as Cloudflare sees it. Absent only outside the CF edge. */
function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Returns a 429 when over the limit, or null to proceed. */
async function rateLimited(
  limiter: RateLimiter,
  request: Request,
  units = 1
): Promise<Response | null> {
  // A missing binding must fail closed. Silently proceeding here would turn a
  // config/deployment mistake into an unlimited relay.
  if (!limiter) {
    return jsonError(
      "RATE_LIMIT_UNAVAILABLE",
      "this endpoint is temporarily unavailable",
      503
    );
  }
  const key = clientKey(request);
  for (let unit = 0; unit < units; unit += 1) {
    const { success } = await limiter.limit({ key });
    if (!success) {
      return new Response(
        JSON.stringify({
          code: "RATE_LIMITED",
          message: "too many requests; slow down",
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "60",
          },
        }
      );
    }
  }
  return null;
}

/**
 * Exactly the methods the app and its reference discovery use. Adding one is
 * a deliberate act: every entry here is quota a stranger can spend.
 *
 * `getProgramAccounts` is the expensive one and is required — pool discovery
 * enumerates candidate pools by program with dataSize/memcmp filters. It
 * cannot be served by a forked RPC, which is why local dev needs this proxy
 * too, not just production.
 */
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getSlot",
  "getBlockHeight",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getProgramAccounts",
  "getSignatureStatuses",
  "getTransaction",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "simulateTransaction",
  "sendTransaction",
  "getVersion",
]);

/**
 * Rate-limit units reflect provider cost, not merely JSON-RPC object count.
 * Pool enumeration is intentionally expensive: one filtered
 * getProgramAccounts must not cost the same as one getSlot.
 */
const RPC_METHOD_UNITS: Readonly<Record<string, number>> = {
  getProgramAccounts: 20,
  simulateTransaction: 5,
  sendTransaction: 5,
  getTransaction: 3,
  getTokenLargestAccounts: 2,
  getMultipleAccounts: 2,
};
const MAX_RPC_UNITS_PER_REQUEST = 120;

/** A single JSON-RPC request body is small; a batch of them is still small. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * Bounds how much work one request can ask for. @solana/web3.js batches
 * internally (its own limit is 100 per flush), so this must sit above normal
 * app traffic; 100 matches the client and still stops a single request from
 * queueing thousands of upstream calls.
 */
const MAX_BATCH_CALLS = 100;
/** Upstream deadline. A slow getProgramAccounts is the worst case. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Same-origin gate for /rpc and /api.
 *
 * What this DOES stop: another website using these endpoints from a visitor's
 * browser — someone embedding our paid RPC in their own app. That is the
 * realistic abuse, because it scales with their traffic and costs us.
 *
 * What it does NOT stop, and cannot: a determined person with curl. Origin is
 * a browser-supplied header, and a non-browser client sets it to anything.
 * There is no secret a public frontend can hold that its users cannot read, so
 * "only my frontend may call this" is not achievable in a browser app. Volume
 * abuse is bounded by rate limiting, not by this check.
 *
 * Origin is REQUIRED on state-changing methods. Per the Fetch spec a browser
 * always sends it on POST, regardless of same- or cross-origin, so requiring
 * it costs this app nothing and blocks the casual `curl https://.../rpc` that
 * sends no Origin at all. A forged header still passes — that is the limit of
 * this control, not an oversight.
 */
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Same-origin GET/HEAD commonly omit Origin. Fetch Metadata still lets us
    // reject blind cross-site resource loads and navigations in browsers.
    // A non-browser can omit or forge both headers; this is not authentication.
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const site = request.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Origin is an exact serialized origin, not merely a matching Host.
  if (parsed.origin !== origin) return false;
  const self = new URL(request.url).origin;
  if (parsed.origin === self) return true;
  // Local development against a deployed worker.
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parsed.host)
  );
}

function forbidden(): Response {
  return new Response(
    JSON.stringify({
      code: "FORBIDDEN_ORIGIN",
      message: "this endpoint serves its own site only",
    }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  status = 400
) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

/**
 * Validates one JSON-RPC call. Returns null when acceptable, or the reason it
 * is not. Batches are validated element-wise: one disallowed method rejects
 * the whole batch rather than silently forwarding the rest.
 */
function rejectReason(call: unknown): string | null {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    return "each request must be a JSON-RPC object";
  }
  const method = (call as { method?: unknown }).method;
  if (typeof method !== "string") return "missing method";
  if (!ALLOWED_METHODS.has(method)) return `method not allowed: ${method}`;
  return null;
}

function rpcUnits(call: unknown): number {
  const method = (call as { method: string }).method;
  return RPC_METHOD_UNITS[method] ?? 1;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "frame-src https:",
    "manifest-src 'self'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Read at most maxBytes from the wire; never buffer an unbounded body. */
async function readTextWithCap(
  request: Request,
  maxBytes: number
): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return null;
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request body too large");
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function rpcSecretPatterns(rawUrl: string): Uint8Array[] {
  const candidates = new Set<string>([rawUrl]);
  try {
    const url = new URL(rawUrl);
    candidates.add(url.href);
    for (const value of [
      url.username,
      url.password,
      ...url.searchParams.values(),
    ]) {
      if (value.length >= 6) candidates.add(value);
    }
    for (const label of url.hostname.split(".")) {
      if (label.length >= 6) candidates.add(label);
    }
    for (const field of url.search.slice(1).split("&")) {
      const rawValue = field.slice(field.indexOf("=") + 1);
      if (rawValue.length >= 6) candidates.add(rawValue);
    }
    for (const segment of url.pathname.split("/")) {
      if (segment.length >= 6) {
        candidates.add(segment);
        try {
          candidates.add(decodeURIComponent(segment));
        } catch {
          // The URL parser accepted it; the exact encoded form is still covered.
        }
      }
    }
  } catch {
    // fetch will reject an invalid configured URL. The raw value is still
    // redacted if a runtime error somehow returns it in a successful body.
  }
  for (const candidate of [...candidates]) {
    candidates.add(encodeURIComponent(candidate));
    candidates.add(candidate.replaceAll("/", "\\/"));
  }
  const encoder = new TextEncoder();
  return [...candidates]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((candidate) => encoder.encode(candidate));
}

function redactBytes(input: Uint8Array, patterns: readonly Uint8Array[]) {
  const output = input.slice();
  for (const pattern of patterns) {
    if (!pattern.byteLength || pattern.byteLength > input.byteLength) continue;
    outer: for (
      let start = 0;
      start <= input.byteLength - pattern.byteLength;
      start += 1
    ) {
      for (let offset = 0; offset < pattern.byteLength; offset += 1) {
        if (input[start + offset] !== pattern[offset]) continue outer;
      }
      output.fill(0x2a, start, start + pattern.byteLength);
    }
  }
  return output;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

/** Keep the deadline alive and redact the configured URL across chunk edges. */
function safeRpcResponseBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  timer: ReturnType<typeof setTimeout>,
  secretUrl: string
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const patterns = rpcSecretPatterns(secretUrl);
  const retainedBytes = Math.max(
    0,
    ...patterns.map((pattern) => pattern.byteLength - 1)
  );
  let pending = new Uint8Array();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
  };
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (pending.byteLength) {
              stream.enqueue(redactBytes(pending, patterns));
              pending = new Uint8Array();
            }
            finish();
            stream.close();
            return;
          }
          const combined = concatenate(pending, value);
          const redacted = redactBytes(combined, patterns);
          const emitBytes = Math.max(0, combined.byteLength - retainedBytes);
          pending = redacted.slice(emitBytes);
          if (emitBytes > 0) {
            stream.enqueue(redacted.slice(0, emitBytes));
            return;
          }
        }
      } catch (error) {
        finish();
        stream.error(error);
      }
    },
    async cancel(reason) {
      finish();
      controller.abort();
      await reader.cancel(reason);
    },
  });
}

async function handleRpc(
  request: Request,
  env: AppEnv,
  initialRateUnitConsumed: boolean
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonRpcError(null, -32600, "POST required", 405);
  }
  if (!env.SOLANA_RPC_URL) {
    // Fail closed and say why, without naming the variable's value.
    return jsonRpcError(
      null,
      -32603,
      "rpc proxy is not configured on this deployment",
      503
    );
  }

  const raw = await readTextWithCap(request, MAX_BODY_BYTES);
  if (raw === null) {
    return jsonRpcError(null, -32600, "request too large", 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonRpcError(null, -32700, "invalid JSON");
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (!calls.length) return jsonRpcError(null, -32600, "empty batch");
  if (calls.length > MAX_BATCH_CALLS) {
    return jsonRpcError(
      null,
      -32600,
      `batch of ${calls.length} exceeds ${MAX_BATCH_CALLS}`,
      413
    );
  }
  for (const call of calls) {
    const reason = rejectReason(call);
    if (reason) {
      const id = (call as { id?: unknown } | null)?.id ?? null;
      return jsonRpcError(id, -32601, reason);
    }
  }

  const requestedUnits = calls.reduce(
    (total, call) => total + rpcUnits(call),
    0
  );
  if (requestedUnits > MAX_RPC_UNITS_PER_REQUEST) {
    return jsonRpcError(
      null,
      -32600,
      `request cost ${requestedUnits} exceeds ${MAX_RPC_UNITS_PER_REQUEST}`,
      413
    );
  }

  // The edge consumed one unit before reading the body. Consume the weighted
  // remainder, so an expensive pool scan cannot masquerade as a cheap call.
  const remainingUnits = requestedUnits - (initialRateUnitConsumed ? 1 : 0);
  if (remainingUnits > 0) {
    const limited = await rateLimited(env.RPC_LIMITER, request, remainingUnits);
    if (limited) return limited;
  }

  // Forward the RE-SERIALIZED body, never the caller's raw bytes.
  //
  // With a duplicate key — {"method":"requestAirdrop","method":"getSlot"} —
  // JSON.parse keeps the LAST value, so validation sees getSlot and passes.
  // Forwarding the raw string would then hand the upstream a body whose first
  // `method` is a blocked one, and any parser that keeps the FIRST occurrence
  // executes it. Verified against this proxy before the fix: that exact body
  // was accepted and forwarded. Re-serializing makes the upstream see exactly
  // what was validated, so the two parsers cannot disagree.
  const forwardBody = JSON.stringify(parsed);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let bodyOwnsTimer = false;
  try {
    // Workers' fetch supports redirect "follow" | "manual" only — "error"
    // throws before the request is made. "manual" is what we want anyway: a
    // redirect from the RPC endpoint is not something to follow blindly, since
    // the destination would receive the request body.
    const upstream = await fetch(env.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: forwardBody,
      signal: controller.signal,
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return jsonRpcError(null, -32603, "rpc upstream redirected", 502);
    }
    if (!upstream.ok) {
      // Provider error pages sometimes echo their request URL. Never relay an
      // HTTP-level upstream body because that URL contains the secret key.
      await upstream.body?.cancel();
      return jsonRpcError(
        null,
        -32603,
        "rpc upstream rejected request",
        upstream.status
      );
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(contentType)) {
      await upstream.body?.cancel();
      return jsonRpcError(null, -32603, "invalid rpc upstream response", 502);
    }
    const body = upstream.body
      ? safeRpcResponseBody(
          upstream.body,
          controller,
          timer,
          env.SOLANA_RPC_URL
        )
      : null;
    bodyOwnsTimer = body !== null;
    // Pass the body through as-is, but never the upstream's headers: they can
    // carry provider identifiers, and the URL itself must never be echoed.
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    // Never surface the upstream error text: it can contain the endpoint URL.
    return jsonRpcError(
      null,
      -32603,
      aborted ? "rpc upstream timed out" : "rpc upstream unavailable",
      aborted ? 504 : 502
    );
  } finally {
    if (!bodyOwnsTimer) clearTimeout(timer);
  }
}

/**
 * `/api/*` is the quote service. It MUST NOT fall through to the SPA: the
 * asset handler answers any unmatched path with index.html and a 200, so a
 * missing service returned an HTML page that every layer read as success
 * until something tried to use a field. Answer in JSON, with a status that
 * means what it says.
 */
async function handleApi(request: Request, env: AppEnv): Promise<Response> {
  if (!env.BURN_SERVICE) {
    return new Response(
      JSON.stringify({
        code: "BURN_SERVICE_NOT_CONFIGURED",
        message: "the burn service is not configured on this deployment",
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(request.method)) {
    return jsonError("METHOD_NOT_ALLOWED", "method not allowed", 405);
  }

  const url = new URL(request.url);

  // Service-binding URLs are routing labels, not public network destinations.
  // Still collapse leading slashes so the downstream sees one unambiguous
  // pathname and can never parse a protocol-relative URL differently.
  const suffix = url.pathname.slice("/api".length).replace(/^\/+/, "/");
  const target = new URL("https://quote-service.internal");
  target.pathname = suffix || "/";
  target.search = url.search;

  // Forward only what the service needs. Passing request.headers wholesale
  // sends the visitor's cookies, Authorization, Referer, and arbitrary CF-*
  // headers downstream. Origin is retained because the paid metadata endpoint
  // validates it. CF-Connecting-IP is the one trusted edge value retained so
  // the downstream paid-upload limiter can key by the actual client.
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "origin",
    "cf-connecting-ip",
  ] as const) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const upstream = await env.BURN_SERVICE.fetch(
    new Request(target, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    })
  );
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return jsonError("BURN_SERVICE_REDIRECTED", "burn service redirected", 502);
  }
  const responseHeaders = new Headers();
  for (const name of [
    "content-type",
    "cache-control",
    "retry-after",
    "allow",
  ] as const) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }
  if (!responseHeaders.has("cache-control")) {
    responseHeaders.set("cache-control", "no-store");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.cooked.diy") {
      url.hostname = "cooked.diy";
      return withSecurityHeaders(Response.redirect(url, 308));
    }
    const isEndpoint =
      url.pathname === "/rpc" ||
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/");
    if (isEndpoint) {
      try {
        if (!isAllowedOrigin(request)) return withSecurityHeaders(forbidden());
        if (url.pathname === "/rpc") {
          const limited = await rateLimited(env.RPC_LIMITER, request);
          return withSecurityHeaders(
            limited ?? (await handleRpc(request, env, true))
          );
        }
        const limited = await rateLimited(env.API_LIMITER, request);
        if (limited) return withSecurityHeaders(limited);
        if (url.pathname === "/api/community-vaults") {
          if (request.method !== "GET" && request.method !== "HEAD") {
            return jsonError("METHOD_NOT_ALLOWED", "GET required", 405);
          }
          const vault = url.searchParams.get("vault");
          const launch = url.searchParams.get("launch");
          const response = vault
            ? await communityVaultSummary(env, vault)
            : launch
            ? await communityLaunchSummary(env, launch)
            : await communityLeaderboard(env);
          return withSecurityHeaders(
            request.method === "HEAD"
              ? new Response(null, {
                  status: response.status,
                  headers: response.headers,
                })
              : response
          );
        }
        return withSecurityHeaders(await handleApi(request, env));
      } catch {
        // Cloudflare's 1101 page is generic, but key secrecy should not depend
        // on platform error rendering. Never return exception text or a URL.
        return withSecurityHeaders(
          jsonError("UPSTREAM_UNAVAILABLE", "upstream unavailable", 502)
        );
      }
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      indexFinalizedBurns(env)
        .then(({ signatures, legs }) => {
          console.log({ event: "community_indexed", signatures, legs });
        })
        .catch(() => {
          // Never include the configured RPC URL or provider response text.
          console.error({ event: "community_index_failed" });
        })
    );
  },
} satisfies ExportedHandler<Env>;
