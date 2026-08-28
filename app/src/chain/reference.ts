/**
 * KEYLESS reference selection, from the browser's side.
 *
 * Every leg of a vault binds a 32-byte REFERENCE seed into the vault
 * address (`build_split_seeds`): the zero sentinel for Pump-venue
 * references, the pool address for every other venue. The choice is
 * PERMANENT — there is no update instruction and no withdrawal — so the
 * app never asks the creator to pick a pool freehand. It asks the burn
 * service, which runs the owner-decided rule with the same resolver the
 * burns use (quote-service/markets.ts):
 *
 *   - Pump coin -> the Pump venue (curve, then the canonical PumpSwap pool
 *     after graduation; the binding migrates without changing the address);
 *   - anything else -> REAL market enumeration across Raydium v4/CP/CLMM
 *     and Meteora DLMM, ranked by durable locked depth first, otherwise
 *     absolute SOL-side depth. Jupiter's 1 SOL hop is not the default pick.
 *
 * The full candidate list is returned so the UI can SHOW the reasoning,
 * and an advanced override may choose any other candidate that clears the
 * program's gates — behind an explicit confirmation.
 */
import { PublicKey } from "@solana/web3.js";

export type MarketCandidate = {
  pool: string;
  venue: string;
  depthLamports: string;
  // Mirrors MarketDurability in quote-service/markets.ts. Keep the two in
  // step: a value the service emits but this union omits does not fail to
  // compile — it silently falls through every check that switches on it.
  durability:
    | "protocol-owned"
    | "burned"
    | "locked-by-custody"
    | "not-locked"
    | "unverified";
  lockedPct?: number;
  lockedDepthLamports?: string;
  meetsDepthFloor: boolean;
  feeBps?: number;
  capLamports?: string;
  vaultA?: string;
  vaultB?: string;
  feeSource?: string;
  seed?: "zero-sentinel" | "pool-address";
  rejected?: string;
};

export type MarketSelection = {
  targetMint: string;
  branch: "pump-curve" | "pump-swap-canonical" | "market-enumeration";
  chosen: MarketCandidate | null;
  pickReason: string;
  candidates: MarketCandidate[];
  enumerationSource: string;
};

/**
 * One leg's chosen reference with everything the setup instructions need:
 * the seed contribution for the derivation and the 7-account block's
 * reference quartet for `validate_config` Mode A.
 */
export type LegReference = {
  selection: MarketSelection;
  /** The candidate actually bound (auto-pick, or an explicit override). */
  candidate: MarketCandidate;
  /** undefined for zero-sentinel legs; the pool for address-bound legs. */
  ref?: PublicKey;
  pool: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  feeSource: PublicKey;
};

export class ReferenceError extends Error {
  constructor(message: string, readonly code = "REFERENCE_REQUEST_FAILED") {
    super(message);
    this.name = "ReferenceError";
  }
}

const REFERENCE_FETCH_DEADLINE_MS = 20_000;

async function fetchReference(
  url: string,
  operation: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    REFERENCE_FETCH_DEADLINE_MS
  );
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ReferenceError(
        `${operation} timed out after ${
          REFERENCE_FETCH_DEADLINE_MS / 1_000
        } seconds; retry`,
        "REFERENCE_DISCOVERY_TIMEOUT"
      );
    }
    throw new ReferenceError(`${operation} unreachable: ${error}`);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Authenticate a specific pool (`pool=` override, or "pump" for the Pump
 * venue), or with no pool let the service run `selectReference` (Pump
 * branch, else GPA + rankCandidates) and verify the pick on chain. Throws
 * ReferenceError with the service's plain-language reason when the mint
 * is not supported.
 */
export async function fetchCandidate(
  serviceUrl: string,
  mint: string,
  pool?: string
): Promise<{ candidate: MarketCandidate; discovery: string }> {
  const query = pool
    ? `mint=${encodeURIComponent(mint)}&pool=${encodeURIComponent(pool)}`
    : `mint=${encodeURIComponent(mint)}`;
  const response = await fetchReference(
    `${serviceUrl}/reference/resolve?${query}`,
    "burn service reference resolution"
  );
  const payload = (await response.json().catch(() => null)) as {
    candidate?: MarketCandidate;
    discovery?: string;
    code?: string;
    error?: string;
    message?: string;
  } | null;
  if (!response.ok || !payload?.candidate) {
    throw new ReferenceError(
      payload?.error ?? payload?.message ?? `HTTP ${response.status}`,
      payload?.code ?? "REFERENCE_RESOLVE_FAILED"
    );
  }
  return {
    candidate: payload.candidate,
    discovery: payload.discovery ?? "verified on chain",
  };
}

export async function fetchMarketSelection(
  serviceUrl: string,
  mint: string
): Promise<MarketSelection> {
  const response = await fetchReference(
    `${serviceUrl}/reference/markets?mint=${encodeURIComponent(mint)}`,
    "burn service market enumeration"
  );
  const payload = (await response.json().catch(() => null)) as
    | (MarketSelection & { code?: string; error?: string; message?: string })
    | null;
  if (!response.ok || !payload) {
    throw new ReferenceError(
      payload?.error ??
        payload?.message ??
        `market enumeration failed: HTTP ${response.status}`,
      payload?.code ?? "REFERENCE_MARKETS_FAILED"
    );
  }
  return payload;
}

/** Materialize a candidate into the leg reference the instructions carry. */
export function legReferenceFrom(
  selection: MarketSelection,
  candidate: MarketCandidate
): LegReference {
  if (!candidate.vaultA || !candidate.vaultB || !candidate.feeSource) {
    throw new ReferenceError(
      `candidate ${candidate.pool} was never authenticated by the resolver; it cannot be bound`
    );
  }
  return {
    selection,
    candidate,
    ref:
      candidate.seed === "pool-address"
        ? new PublicKey(candidate.pool)
        : undefined,
    pool: new PublicKey(candidate.pool),
    vaultA: new PublicKey(candidate.vaultA),
    vaultB: new PublicKey(candidate.vaultB),
    feeSource: new PublicKey(candidate.feeSource),
  };
}
