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
  ASSETS: { fetch: (request: Request) => Promise<Response> };
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/rpc") return handleRpc(request, env);
    return env.ASSETS.fetch(request);
  },
};
