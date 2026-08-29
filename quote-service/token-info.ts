/**
 * `/token` and `/token/image` — a token's name, ticker and icon.
 *
 * The frontend asks for these on every launch-page render (`tokenName.ts`).
 * Without them the picker falls back to the mint's own on-chain metadata,
 * which has no icon at all and is empty for tokens like RAY, so every burn
 * target renders unnamed and iconless.
 *
 * Ported from the demo service, which proved the behaviour, with the Node
 * pieces replaced: no Buffer, and no DNS lookup (a Worker has no private
 * network to be tricked into reaching, so the guard is on URL shape instead).
 */

/** Jupiter is the source: it curates name/ticker/icon for every tradeable mint. */
const JUPITER_TOKEN_SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query=";
const INFO_TIMEOUT_MS = 6_000;
const IMAGE_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 2_000_000;
/** Entries hold up to 2 MB each and mints are unbounded, so the cache is capped. */
const IMAGE_CACHE_MAX = 256;
const INFO_CACHE_MAX = 1_024;

export type TokenInfo =
  | { found: false }
  | { found: true; symbol: string | null; name: string | null; image: string | null };

/**
 * The body is an ArrayBuffer rather than a Uint8Array: both are valid Worker
 * response bodies, but only ArrayBuffer is a `BodyInit` under the Node lib
 * types this package also typechecks against.
 */
export type TokenImage = { body: ArrayBuffer; type: string };

/** A mint is base58 and 32 bytes; anything else is never forwarded upstream. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isPlausibleMint(mint: string | null): mint is string {
  return typeof mint === "string" && MINT_RE.test(mint);
}

function remember<K, V>(cache: Map<K, V>, max: number, key: K, value: V): V {
  if (cache.size >= max) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/**
 * Point IPFS content at a gateway that still exists.
 *
 * Only the HOST is swapped; the content hash is untouched, so this can never
 * change which bytes are addressed. Gateways rot — cf-ipfs.com and
 * nftstorage.link are already dead — and a frozen metadata URI still names them.
 */
const DEAD_OR_BARE_GATEWAYS =
  /^(?:ipfs:\/\/|https:\/\/(?:cf-ipfs\.com|cloudflare-ipfs\.com|nftstorage\.link|ipfs\.infura\.io)\/ipfs\/)/;

export function normalizeImageUrl(raw: string): string | null {
  try {
    const rewritten = raw.startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${raw.slice("ipfs://".length)}`
      : raw.replace(DEAD_OR_BARE_GATEWAYS, "https://ipfs.io/ipfs/");
    const url = new URL(rewritten);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const infoCache = new Map<string, TokenInfo>();

export async function tokenInfo(mint: string): Promise<TokenInfo> {
  const hit = infoCache.get(mint);
  if (hit !== undefined) return hit;
  let out: TokenInfo = { found: false };
  try {
    const res = await fetch(JUPITER_TOKEN_SEARCH + encodeURIComponent(mint), {
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as unknown;
      const first = Array.isArray(body) ? body[0] : body;
      if (first && typeof first === "object") {
        const t = first as { symbol?: string; name?: string; icon?: string };
        if (t.symbol || t.name) {
          out = {
            found: true,
            symbol: t.symbol ?? null,
            name: t.name ?? null,
            image: t.icon ? normalizeImageUrl(t.icon) : null,
          };
        }
      }
    }
  } catch {
    // An unnamed token is a cosmetic loss; never surface it as an error.
  }
  // A miss is cached too, so a token Jupiter does not know does not re-query
  // on every render — but only briefly, since the isolate is short-lived.
  return remember(infoCache, INFO_CACHE_MAX, mint, out);
}

/**
 * Whether this URL may be fetched server-side.
 *
 * Correcting the reasoning that keying by MINT makes this safe: the URL comes
 * from token metadata, and on Pump ANYONE can mint a token, so an attacker
 * chooses the address this service is asked to fetch. Mint-keying only adds a
 * step. A Worker has no private network reachable by URL, which removes the
 * classic SSRF target, but IP literals and credentialed URLs are still refused
 * so the only thing this can ever fetch is an ordinary public host by name.
 */
function fetchableIconUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // Reject IPv6 literals and anything that parses as a bare IPv4 address.
  if (url.hostname.startsWith("[")) return null;
  if (/^\d+(?:\.\d+){3}$/.test(url.hostname)) return null;
  if (!url.hostname.includes(".")) return null;
  return url;
}

const imageCache = new Map<string, TokenImage | null>();

/**
 * The icon bytes, fetched here rather than by the browser.
 *
 * MEASURED 2026-08-27: ipfs.io answers 200 to a plain client and 403 to any
 * browser User-Agent — it bot-blocks hotlinking — and Jupiter hands out
 * ipfs.io URLs for a large share of Pump coins ($PUMP, WIF, FARTCOIN, KET all
 * measured). Those icons can therefore NEVER load from a page, however the
 * <img> is written. Re-serving them from here is the only approach that does
 * not depend on a third party's opinion of the caller.
 */
export async function tokenImageBytes(mint: string): Promise<TokenImage | null> {
  const hit = imageCache.get(mint);
  if (hit !== undefined) return hit;
  let out: TokenImage | null = null;
  try {
    const info = await tokenInfo(mint);
    let next = info.found ? info.image : null;
    // Redirects are followed by hand so each new host is validated exactly
    // like the first, rather than trusting the fetch stack to stay on a
    // host this function already approved.
    for (let hop = 0; hop < 3 && next; hop++) {
      const url = fetchableIconUrl(next);
      next = null;
      if (!url) break;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location) next = new URL(location, url).toString();
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/")) {
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > 0 && bytes.byteLength <= MAX_IMAGE_BYTES) {
          // Only the media type is echoed back, never the upstream's own
          // headers: those can carry cookies and cache directives we did not
          // choose.
          out = { body: bytes, type: type.split(";", 1)[0]!.trim() };
        }
      }
      break;
    }
  } catch {
    // No icon is a fine outcome; never surface it.
  }
  return remember(imageCache, IMAGE_CACHE_MAX, mint, out);
}
