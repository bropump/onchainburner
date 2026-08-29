/**
 * Cloudflare Worker fronting the static app.
 *
 * Its only job beyond serving assets is `POST /rpc`: a narrow Solana JSON-RPC
 * proxy that holds the upstream endpoint (which carries an API key) as a
 * SERVER-SIDE secret.
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

interface Env {
  /** Full upstream RPC URL including any key. Set with `wrangler secret put`. */
  SOLANA_RPC_URL?: string;
  /**
   * Origin of the quote service, e.g. https://burn-service.example. When set,
   * `/api/*` is proxied there with the `/api` prefix stripped. When absent,
   * `/api/*` returns a JSON 503 rather than falling through to the SPA.
   */
  BURN_SERVICE_ORIGIN?: string;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  RPC_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
  API_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
}

/** Client IP as Cloudflare sees it. Absent only outside the CF edge. */
function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Returns a 429 when over the limit, or null to proceed. */
async function rateLimited(
  limiter: Env["RPC_LIMITER"],
  request: Request
): Promise<Response | null> {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key: clientKey(request) });
  if (success) return null;
  return new Response(
    JSON.stringify({
      code: "RATE_LIMITED",
      message: "too many requests; slow down",
    }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "60" },
    }
  );
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
    // GET/HEAD may legitimately omit it; POST may not.
    return request.method === "GET" || request.method === "HEAD";
  }
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const self = new URL(request.url).host;
  if (host === self) return true;
  // Local development against a deployed worker.
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
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

function jsonRpcError(id: unknown, code: number, message: string, status = 400) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
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

async function handleRpc(request: Request, env: Env): Promise<Response> {
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

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
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
      return jsonRpcError(null, -32603, "rpc upstream redirected", 502);
    }
    // Pass the body through as-is, but never the upstream's headers: they can
    // carry provider identifiers, and the URL itself must never be echoed.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
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
    clearTimeout(timer);
  }
}

/**
 * `/api/*` is the quote service. It MUST NOT fall through to the SPA: the
 * asset handler answers any unmatched path with index.html and a 200, so a
 * missing service returned an HTML page that every layer read as success
 * until something tried to use a field. Answer in JSON, with a status that
 * means what it says.
 */
async function handleApi(request: Request, env: Env): Promise<Response> {
  if (!env.BURN_SERVICE_ORIGIN) {
    return new Response(
      JSON.stringify({
        code: "BURN_SERVICE_NOT_CONFIGURED",
        message:
          "the burn service is not configured on this deployment; set BURN_SERVICE_ORIGIN",
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }
  const url = new URL(request.url);

  // Build the target from the configured origin and a path that cannot
  // change the host.
  //
  // Resolving the client path against the origin directly is an SSRF: for
  // `/api//evil.example/x` the remainder is `//evil.example/x`, which is a
  // PROTOCOL-RELATIVE url, so new URL() keeps only the base's scheme and
  // sends the request — with headers — to evil.example. Verified before this
  // fix. Collapsing leading slashes removes that, and the origin is asserted
  // afterwards so any future parsing surprise fails closed rather than
  // silently forwarding somewhere else.
  const base = new URL(env.BURN_SERVICE_ORIGIN);
  const suffix = url.pathname.slice("/api".length).replace(/^\/+/, "/");
  const target = new URL(base.origin);
  target.pathname = suffix || "/";
  target.search = url.search;
  if (target.origin !== base.origin) {
    return new Response(
      JSON.stringify({ code: "BAD_GATEWAY", message: "refusing to proxy" }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  // Forward only what the service needs. Passing request.headers wholesale
  // sends the visitor's cookies and this site's CF headers to a third-party
  // origin; nothing downstream reads them, so they should not travel.
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isEndpoint =
      url.pathname === "/rpc" ||
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/");
    if (isEndpoint && !isAllowedOrigin(request)) return forbidden();
    if (url.pathname === "/rpc") {
      const limited = await rateLimited(env.RPC_LIMITER, request);
      return limited ?? handleRpc(request, env);
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const limited = await rateLimited(env.API_LIMITER, request);
      return limited ?? handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
