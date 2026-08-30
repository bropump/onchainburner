/**
 * Token names from the mint itself.
 *
 * A Pump `create_v2` mint carries its name and symbol in a Token-2022
 * TokenMetadata extension (TLV type 19), so a freshly launched coin can be
 * labelled without any registry, indexer or API — the bytes are already on
 * chain and we already read that account for admission.
 *
 * Layout inside the type-19 value, per spl-token-metadata-interface:
 *   update_authority  32 bytes
 *   mint              32 bytes
 *   name              u32 length + utf8
 *   symbol            u32 length + utf8
 *   uri               u32 length + utf8
 *
 * Every read is bounds-checked and returns undefined rather than throwing —
 * this is a cosmetic label, and a malformed mint must never break a page. (The
 * service learned that the hard way: an unchecked 4-byte header read on a
 * 2-byte tail threw RangeError and surfaced as "mint is absent or
 * uninitialized" on a perfectly good coin.)
 */
import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { BURN_SERVICE_URL } from "../config";

export type TokenName = { name: string; symbol: string; uri?: string };

const TLV_START = 166;
const TYPE_TOKEN_METADATA = 19;

function readString(
  data: Uint8Array,
  offset: number
): { value: string; next: number } | undefined {
  if (offset + 4 > data.length) return undefined;
  const len =
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24);
  const start = offset + 4;
  if (len < 0 || start + len > data.length) return undefined;
  return {
    value: new TextDecoder().decode(data.subarray(start, start + len)),
    next: start + len,
  };
}

/** Parse name/symbol out of a raw mint account, or undefined if absent. */
export function parseTokenName(data: Uint8Array): TokenName | undefined {
  let cursor = TLV_START;
  while (cursor + 4 <= data.length) {
    const type = data[cursor] | (data[cursor + 1] << 8);
    const length = data[cursor + 2] | (data[cursor + 3] << 8);
    if (type === 0) return undefined;
    const value = cursor + 4;
    if (value + length > data.length) return undefined;
    if (type === TYPE_TOKEN_METADATA) {
      const name = readString(data, value + 64);
      if (!name) return undefined;
      const symbol = readString(data, name.next);
      if (!symbol) return undefined;
      const uri = readString(data, symbol.next);
      const trimmedName = name.value.trim();
      const trimmedSymbol = symbol.value.trim();
      if (!trimmedName && !trimmedSymbol) return undefined;
      return {
        name: trimmedName,
        symbol: trimmedSymbol,
        uri: uri?.value.trim() || undefined,
      };
    }
    cursor = value + length;
  }
  return undefined;
}

const cache = new Map<string, TokenName | null>();
const nameInFlight = new Map<string, Promise<TokenName | undefined>>();

/** Fetch and cache a mint's on-chain name. null means "looked, none there". */
export async function fetchTokenName(
  connection: Connection,
  mint: string
): Promise<TokenName | undefined> {
  const hit = cache.get(mint);
  if (hit !== undefined) return hit ?? undefined;
  const pending = nameInFlight.get(mint);
  if (pending) return pending;
  const work = (async () => {
    let parsed: TokenName | undefined;
    let completed = false;
    try {
      const info = await connection.getAccountInfo(new PublicKey(mint));
      if (info) parsed = parseTokenName(info.data);
      // Legacy SPL mints (82 bytes, Tokenkeg-owned) carry no TLV metadata — older
      // Pump coins land here. Their name lives in a Metaplex metadata account.
      if (!parsed) parsed = await fetchMetaplexName(connection, mint);
      completed = true;
    } catch {
      // A cosmetic label is never worth surfacing an error for.
    }
    // A timeout is not evidence that metadata is absent. Keeping that miss in
    // the page-wide cache made identities stay blank after RPC recovered.
    if (parsed || completed) cache.set(mint, parsed ?? null);
    return parsed;
  })();
  nameInFlight.set(mint, work);
  try {
    return await work;
  } finally {
    nameInFlight.delete(mint);
  }
}

/** Synchronous cache read, for labels rendered before the fetch resolves. */
export function cachedTokenName(mint: string): TokenName | undefined {
  return cache.get(mint) ?? undefined;
}

/**
 * Resolve names for a set of mints, re-rendering once they land. Cheap: one
 * account read per mint, cached process-wide, and failures are silent.
 */
export function useTokenNames(
  connection: Connection,
  mints: readonly string[]
): ReadonlyMap<string, TokenName> {
  const [names, setNames] = useState<ReadonlyMap<string, TokenName>>(new Map());
  const key = mints.join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = new Map<string, TokenName>();
      const resolved = await Promise.all(
        mints.map(
          async (mint) =>
            [mint, await fetchTokenName(connection, mint)] as const
        )
      );
      for (const [mint, n] of resolved) if (n) found.set(mint, n);
      if (!cancelled && found.size) setNames(found);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);
  return names;
}

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Metaplex Metadata: key(1) + update_authority(32) + mint(32), then the
 *  length-prefixed name and symbol. Bounds-checked like the TLV path. */
async function fetchMetaplexName(
  connection: Connection,
  mint: string
): Promise<TokenName | undefined> {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("metadata"),
      METAPLEX.toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    METAPLEX
  );
  const info = await connection.getAccountInfo(pda);
  if (!info) return undefined;
  const data = info.data;
  const name = readString(data, 65);
  if (!name) return undefined;
  const symbol = readString(data, name.next);
  if (!symbol) return undefined;
  const uriField = readString(data, symbol.next);
  const clean = (s: string) => s.replace(/\0+$/, "").trim();
  const n = clean(name.value);
  const s = clean(symbol.value);
  if (!n && !s) return undefined;
  return {
    name: n,
    symbol: s,
    uri: uriField ? clean(uriField.value) : undefined,
  };
}

const imageCache = new Map<string, string | null>();

/**
 * The token's image, from the off-chain JSON its metadata URI points at.
 *
 * UNLIKE the name and ticker, this is NOT on-chain data: the URI is chosen by
 * whoever created the token and the JSON lives on whatever host they picked.
 * So it is fetched defensively — https only, a timeout, no credentials, and
 * any failure yields no image rather than an error. Treat the result as
 * decoration, never as evidence about what a token is.
 */
export async function fetchTokenImage(
  uri: string
): Promise<string | undefined> {
  const hit = imageCache.get(uri);
  if (hit !== undefined) return hit ?? undefined;
  let image: string | undefined;
  let completed = false;
  try {
    const url = new URL(rewriteGateway(uri));
    if (url.protocol !== "https:") throw new Error("non-https metadata uri");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      redirect: "follow",
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = (await res.json()) as { image?: unknown };
      if (typeof json.image === "string") {
        const img = new URL(rewriteGateway(json.image));
        if (img.protocol === "https:") image = img.toString();
      }
      completed = true;
    }
  } catch {
    // No image is a fine outcome; never surface this.
  }
  if (image || completed) imageCache.set(uri, image ?? null);
  return image;
}

/** Resolve one mint to its name, ticker and image, for the target picker. */
export function useTokenPreview(
  connection: Connection,
  mint: string | null
): { token?: TokenName; image?: string; loading: boolean } {
  const [state, setState] = useState<{
    token?: TokenName;
    image?: string;
    loading: boolean;
  }>({ loading: false });
  useEffect(() => {
    if (!mint) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      // Jupiter first: it already curates name/ticker/image for every tradeable
      // mint, including ones whose on-chain URI is empty (RAY) or points at a
      // gateway that no longer exists (NEIRO). Proxied through our service
      // because their token API sends no CORS headers.
      const viaJupiter = await fetchServiceToken(mint);
      if (cancelled) return;
      if (viaJupiter) {
        setState({
          token: { name: viaJupiter.name, symbol: viaJupiter.symbol },
          // Always route the icon through our own service rather than using
          // Jupiter's URL directly. Measured 2026-08-27: ipfs.io -- which
          // Jupiter returns for a large share of Pump coins -- answers 403 to
          // any browser User-Agent, so those icons cannot load from a page at
          // all. The service fetches them server-side, where that block does
          // not apply, and re-serves the bytes. `image` here is only used to
          // decide WHETHER an icon exists; the bytes come from the proxy.
          image: viaJupiter.image
            ? `${BURN_SERVICE_URL}/token/image?mint=${encodeURIComponent(mint)}`
            : undefined,
          loading: false,
        });
        return;
      }
      // A fork-only coin is unknown to Jupiter by definition, so fall back to
      // the mint's own metadata. Name and ticker only — no image host will
      // have anything for a token that exists on one machine.
      const token = await fetchTokenName(connection, mint);
      if (cancelled) return;
      setState({ token, loading: false });
      if (token?.uri) {
        const image = await fetchTokenImage(token.uri);
        if (!cancelled && image) setState({ token, image, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, mint]);
  return state;
}

/**
 * Point IPFS content at a gateway that still exists.
 *
 * Token metadata URIs are frozen at mint time, so they name whatever gateway
 * was fashionable then — and gateways die. Measured 2026-08-27: NEIRO's URI
 * points at cf-ipfs.com, which Cloudflare has shut down, so its image cannot
 * load however the fetch is written. Rewriting to a live gateway is the only
 * way to render those tokens.
 *
 * Only the HOST is swapped; the content hash is untouched, so this cannot
 * change which bytes are addressed.
 */
const DEAD_OR_BARE_GATEWAYS =
  /^(?:ipfs:\/\/|https:\/\/(?:cf-ipfs\.com|cloudflare-ipfs\.com|ipfs\.infura\.io)\/ipfs\/)/;

function rewriteGateway(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  }
  const match = uri.match(DEAD_OR_BARE_GATEWAYS);
  if (match && match[0].startsWith("https://")) {
    return uri.replace(DEAD_OR_BARE_GATEWAYS, "https://ipfs.io/ipfs/");
  }
  return uri;
}

type ServiceToken = { name: string; symbol: string; image?: string };
const serviceCache = new Map<string, ServiceToken | null>();
const serviceInFlight = new Map<string, Promise<ServiceToken | undefined>>();

/** Ask our service (which proxies Jupiter) for a mint's name, ticker and image. */
async function fetchServiceToken(
  mint: string
): Promise<ServiceToken | undefined> {
  const hit = serviceCache.get(mint);
  if (hit !== undefined) return hit ?? undefined;
  const pending = serviceInFlight.get(mint);
  if (pending) return pending;
  const work = (async () => {
    let out: ServiceToken | undefined;
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(
        `${BURN_SERVICE_URL}/token?mint=${encodeURIComponent(mint)}`,
        { signal: controller.signal }
      );
      if (res.ok) {
        const j = (await res.json()) as {
          found?: boolean;
          name?: string | null;
          symbol?: string | null;
          image?: string | null;
        };
        completed = true;
        if (j.found && (j.symbol || j.name)) {
          out = {
            name: j.name ?? "",
            symbol: j.symbol ?? "",
            image: j.image ?? undefined,
          };
        }
      }
    } catch {
      // Service down or offline: fall through to on-chain metadata.
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Cache a real `found: false`, but never cache a timeout/5xx as if the
    // token had no metadata. Transient failures must recover inside the SPA.
    if (out || completed) serviceCache.set(mint, out ?? null);
    return out;
  })();
  serviceInFlight.set(mint, work);
  try {
    return await work;
  } finally {
    serviceInFlight.delete(mint);
  }
}
