/**
 * The reference-pool panel: shows, for every leg, WHICH pool will price its
 * burns, every market that was considered, the durability of each market's
 * depth, and why the auto-pick won — because the choice is baked into the
 * vault address and is PERMANENT once the vault is funded.
 *
 * The pick is automatic (owner decision: Pump coin -> Pump venue; anything
 * else -> enumerate all markets, locked-CP then main AMM then
 * largest-oldest concentrated). An advanced override can bind any other
 * candidate that clears the program's gates, behind an explicit
 * confirmation.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useApp } from "../state/AppContext";
import {
  knownSymbol,
  PUMP_FUN_PROGRAM,
  WITHDRAWABLE_ALLOWED,
} from "../chain/constants";
import { useTokenNames, useTokenPreview } from "../chain/tokenName";
import type { PolicyFixedLeg } from "../chain/policy";
import { KNOWN_REFERENCES } from "../chain/knownReferences";
import {
  fetchCandidate,
  fetchMarketSelection,
  legReferenceFrom,
  LegReference,
  MarketCandidate,
  MarketSelection,
} from "../chain/reference";
import { legLabel, shortAddress } from "../ui";
import { LegDraft, parseMint } from "./configEditor";

const PUMP_FEE_PROGRAM = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
);

function solText(lamports?: string): string {
  if (lamports === undefined) return "—";
  const value = Number(lamports) / 1e9;
  if (value >= 1000) return `${Math.round(value).toLocaleString()} SOL`;
  if (value >= 1) return `${value.toFixed(1)} SOL`;
  return `${value.toFixed(4)} SOL`;
}

/**
 * Flow A only: the creator's OWN token does not exist yet, but its reference
 * is fully determined — the DERIVED bonding curve, zero-sentinel seed. The
 * real admission probe runs on chain inside the setup transaction, after
 * `create_v2` has made the curve real.
 */
export function pendingPumpSelection(mint: string): MarketSelection {
  const parsed = new PublicKey(mint);
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), parsed.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  const [feeSource] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), PUMP_FUN_PROGRAM.toBuffer()],
    PUMP_FEE_PROGRAM
  );
  const candidate: MarketCandidate = {
    pool: curve.toBase58(),
    venue: "Pump curve (created by this launch)",
    depthLamports: "0",
    durability: "protocol-owned",
    meetsDepthFloor: true,
    seed: "zero-sentinel",
    vaultA: curve.toBase58(),
    vaultB: curve.toBase58(),
    feeSource: feeSource.toBase58(),
  };
  return {
    targetMint: mint,
    branch: "pump-curve",
    chosen: candidate,
    pickReason:
      "your own launch prices off its bonding curve — protocol-owned, exempt from the depth gate, and the binding migrates to the canonical PumpSwap pool at graduation without changing the vault address",
    candidates: [candidate],
    enumerationSource: "derived (Pump PDA, no enumeration needed)",
  };
}

export type ReferenceState = {
  loading: boolean;
  error: string | null;
  /** Selection per target mint (auto-pick plus the full candidate list). */
  byMint: Record<string, MarketSelection>;
  /** Advanced override: chosen candidate pool per mint. */
  overrides: Record<string, string>;
  setOverride: (mint: string, pool: string | null) => void;
  /** The bound reference per leg, in leg order; null while unresolved. */
  legReferences: (LegReference | null)[];
  /** True when every leg has an authenticated, bindable reference. */
  ready: boolean;
};

/**
 * Session cache: a mint's verdict does not change while the page is open,
 * and re-picking targets must never re-wait on one already resolved.
 */
const selectionCache = new Map<string, Promise<MarketSelection>>();

/**
 * One mint's verdict.
 *
 * CURATED FIRST, enumeration only as a fallback. A mint in `KNOWN_REFERENCES`
 * resolves its recorded pool directly via `fetchCandidate(url, mint, pool)`,
 * which authenticates that exact account on chain (owner, discriminator,
 * vaults, depth, fee) -- the same checks enumeration would apply to whatever
 * it picked. Only an unknown mint pays for `GET /reference/markets`.
 *
 * WHY, measured 2026-08-28: live GPA enumeration took **127 s and then
 * returned HTTP 500** for a curated mint on the fork, so every leg sat on
 * "Checking..." forever and no vault could be configured. `markets.ts` says
 * as much -- "GPA on public RPC is slow/429-prone; that is accepted" -- but
 * it is not acceptable on the interactive path.
 *
 * It is also the safer order, not merely the faster one. RT4 (2026-08-28)
 * showed a hostile pool bound at setup prices every future burn at ~nothing,
 * permanently, because the reference is fixed in the vault address. A curated
 * entry is a pool that has actually burned; a ranked candidate is a heuristic
 * about a pool nobody has vetted. Ranking still decides for unknown mints --
 * this only stops it overriding a vetted answer we already have.
 */
async function resolveSelection(
  serviceUrl: string,
  mint: string
): Promise<MarketSelection> {
  const known = KNOWN_REFERENCES[mint];
  if (known) {
    try {
      const { candidate, discovery } = await fetchCandidate(
        serviceUrl,
        mint,
        known.pool
      );
      return {
        targetMint: mint,
        branch: known.pool === "pump" ? "pump-curve" : "market-enumeration",
        chosen: candidate,
        pickReason: `${known.venue} — ${known.reason}`,
        candidates: [candidate],
        enumerationSource: `curated (${discovery})`,
      };
    } catch {
      // A curated pool that no longer authenticates must not be trusted on
      // its table entry alone: fall through to live enumeration rather than
      // showing a stale verdict.
    }
  }
  try {
    return await fetchMarketSelection(serviceUrl, mint);
  } catch (error) {
    return {
      targetMint: mint,
      branch: "market-enumeration",
      chosen: null,
      pickReason: String((error as Error).message ?? error),
      candidates: [],
      enumerationSource: "live enumeration",
    };
  }
}

export function useLegReferences(
  legs: LegDraft[],
  options: { pendingMint?: string | null } = {}
): ReferenceState {
  const { service } = useApp();
  const [byMint, setByMint] = useState<Record<string, MarketSelection>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const mintsKey = JSON.stringify(
    legs.map((leg) => leg.mint).filter((mint) => parseMint(mint))
  );

  useEffect(() => {
    const id = ++runId.current;
    const mints: string[] = JSON.parse(mintsKey);
    if (!mints.length) return;
    setLoading(true);
    setError(null);
    (async () => {
      // CONCURRENT, and rendered AS EACH LEG LANDS. This was a serial `for`
      // loop that only called setByMint once every leg had resolved, so a
      // single slow leg hid the results of the fast ones: measured
      // 2026-08-28, a curated leg answers in ~5 ms while an unknown mint
      // falls through to a GPA enumeration that took 127 s and then 500'd,
      // leaving every leg -- including the instant ones -- on "Checking...".
      // One leg's latency must never gate another leg's verdict.
      const next: Record<string, MarketSelection> = {};
      await Promise.all(
        mints.map(async (mint) => {
          if (options.pendingMint && mint === options.pendingMint) {
            next[mint] = pendingPumpSelection(mint);
            if (runId.current === id) setByMint({ ...next });
            return;
          }
          let cached = selectionCache.get(`${service.baseUrl}|${mint}`);
          if (!cached) {
            cached = resolveSelection(service.baseUrl, mint);
            selectionCache.set(`${service.baseUrl}|${mint}`, cached);
          }
          const selection = await cached;
          // Never cache a failure: a transient service hiccup must not brand
          // a mint unsupported for the whole session.
          if (!selection.chosen) {
            selectionCache.delete(`${service.baseUrl}|${mint}`);
          }
          next[mint] = selection;
          // Publish this leg now rather than waiting for its slowest sibling.
          if (runId.current === id) setByMint({ ...next });
        })
      );
      if (runId.current !== id) return;
      setByMint({ ...next });
      setLoading(false);
    })().catch((fetchError) => {
      if (runId.current !== id) return;
      setError(String((fetchError as Error).message ?? fetchError));
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintsKey, options.pendingMint, service.baseUrl]);

  const legReferences = useMemo(
    () =>
      legs.map((leg) => {
        const selection = byMint[leg.mint];
        if (!selection) return null;
        const overridePool = overrides[leg.mint];
        const candidate = overridePool
          ? selection.candidates.find(
              (entry) =>
                entry.pool === overridePool &&
                entry.vaultA &&
                entry.meetsDepthFloor &&
                !entry.rejected
            ) ?? selection.chosen
          : selection.chosen;
        if (!candidate || !candidate.vaultA) return null;
        try {
          return legReferenceFrom(selection, candidate);
        } catch {
          return null;
        }
      }),
    [legs, byMint, overrides]
  );

  return {
    loading,
    error,
    byMint,
    overrides,
    setOverride: (mint, pool) =>
      setOverrides((current) => {
        const next = { ...current };
        if (pool === null) delete next[mint];
        else next[mint] = pool;
        return next;
      }),
    legReferences,
    ready:
      !loading &&
      !error &&
      legs.length > 0 &&
      legReferences.every((reference, index) => {
        if (!reference) return false;
        const candidate = reference.candidate;
        return (
          candidate.meetsDepthFloor &&
          !candidate.rejected &&
          isSupportedReference(legs[index].mint, candidate)
        );
      }),
  };
}

/**
 * Is this reference offerable? Owner decision 2026-08-27: withdrawable
 * liquidity is not supported unless the target is on the explicit exception
 * list. Protocol-owned (Pump) and locked LP always are.
 *
 * This is a PRESENTATION gate, not a security boundary — the program still
 * enforces its own depth gate (6041), fee cap (6040) and shape checks (6039)
 * on whatever is actually bound. It exists because a thin, withdrawable pool
 * can pass every on-chain check and still be a bad thing to marry a vault to
 * for life.
 */
export function isSupportedReference(
  mint: string,
  candidate: MarketCandidate
): boolean {
  if (candidate.durability === "protocol-owned") return true;
  if (candidate.durability === "locked-lp") return true;
  return WITHDRAWABLE_ALLOWED.includes(mint);
}

function referencePasses(mint: string, candidate: MarketCandidate): boolean {
  return (
    candidate.meetsDepthFloor &&
    !candidate.rejected &&
    isSupportedReference(mint, candidate)
  );
}

export function referencesAreSupported(
  legs: LegDraft[],
  state: ReferenceState
): boolean {
  return (
    legs.length > 0 &&
    legs.every((leg, index) => {
      const candidate = state.legReferences[index]?.candidate;
      return !!candidate && referencePasses(leg.mint, candidate);
    })
  );
}

function lockText(candidate: MarketCandidate): string {
  if (candidate.durability === "protocol-owned") return "LOCKED";
  if (candidate.durability === "locked-lp") {
    return candidate.lockedPct === undefined
      ? "LOCKED"
      : `LOCKED ${candidate.lockedPct.toFixed(1)}%`;
  }
  if (candidate.durability === "transient-positions") return "NOT LOCKED";
  return "UNKNOWN";
}

function initials(value: string): string {
  return value.replace(/^\$/, "").slice(0, 2).toUpperCase() || "?";
}

function ReferenceAvatar({ label, image }: { label: string; image?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = !!image && image !== failedSrc;
  return (
    <span className="reference-avatar" aria-hidden="true">
      {showImage ? (
        <img src={image} alt="" onError={() => setFailedSrc(image)} />
      ) : (
        initials(label)
      )}
    </span>
  );
}

function ReferenceFacts({
  mint,
  candidate,
  waiting,
}: {
  mint: string;
  candidate?: MarketCandidate;
  waiting: boolean;
}) {
  const supported = !!candidate && referencePasses(mint, candidate);
  return (
    <>
      <div className="reference-fact">
        <span>Pool</span>
        <strong title={candidate?.pool}>
          {candidate
            ? `${candidate.venue.replace(" (created by this launch)", "")} · ${shortAddress(candidate.pool, 4)}`
            : waiting
              ? "Checking…"
              : "No qualifying pool"}
        </strong>
      </div>
      <div className="reference-fact">
        <span>SOL depth</span>
        <strong>{candidate ? solText(candidate.depthLamports) : "—"}</strong>
      </div>
      <div
        className={`reference-fact${
          candidate?.durability === "protocol-owned" ||
          candidate?.durability === "locked-lp"
            ? " ok"
            : candidate
              ? " warn"
              : ""
        }`}
      >
        <span>Liquidity</span>
        <strong>{candidate ? lockText(candidate) : "—"}</strong>
      </div>
      <div className={`reference-fact${supported ? " ok" : waiting ? "" : " err"}`}>
        <span>Verdict</span>
        <strong>{waiting ? "CHECKING" : supported ? "SUPPORTED" : "NOT SUPPORTED"}</strong>
      </div>
    </>
  );
}

export type ReferenceHierarchy = {
  creatorMint: string;
  creatorBps: number;
  fixedLegs: readonly PolicyFixedLeg[];
  pendingMint?: string;
  primaryName?: string;
  primarySymbol?: string;
};

export function ReferencePanel({
  legs,
  state,
  labels = {},
  hierarchy,
}: {
  legs: LegDraft[];
  state: ReferenceState;
  labels?: Record<string, string>;
  /** Launch-only hierarchy. Other configuration pages keep the neutral list. */
  hierarchy?: ReferenceHierarchy;
}) {
  const { connection } = useApp();
  const tokenNames = useTokenNames(
    connection,
    useMemo(() => legs.map((leg) => leg.mint), [legs])
  );
  const primaryIsPending =
    !!hierarchy?.pendingMint && hierarchy.creatorMint === hierarchy.pendingMint;
  const primaryPreview = useTokenPreview(
    connection,
    hierarchy && !primaryIsPending ? hierarchy.creatorMint : null
  );

  const primaryIndex = hierarchy
    ? legs.findIndex((leg) => leg.mint === hierarchy.creatorMint)
    : -1;
  if (hierarchy && primaryIndex >= 0) {
    const primaryLeg = legs[primaryIndex];
    const primaryCandidate = state.legReferences[primaryIndex]?.candidate;
    const primaryWaiting = state.loading && !primaryCandidate;
    const primaryLabel =
      labels[primaryLeg.mint] || legLabel(primaryLeg.mint, tokenNames);
    const primaryName =
      hierarchy.primaryName?.trim() ||
      primaryPreview.token?.name ||
      primaryLabel;
    const primarySymbol =
      hierarchy.primarySymbol?.trim() ||
      primaryPreview.token?.symbol ||
      knownSymbol(primaryLeg.mint) ||
      "";
    const mergedFixedLeg = hierarchy.fixedLegs.find(
      (fixed) => fixed.mint === hierarchy.creatorMint
    );

    return (
      <div className="reference-hierarchy" aria-label="Permanent burn bindings">
        <section className="reference-primary" aria-label="Your burn choice">
          <div className="reference-primary-head">
            <div className="reference-primary-identity">
              <ReferenceAvatar
                label={primarySymbol || primaryName}
                image={primaryPreview.image}
              />
              <div className="reference-primary-copy">
                <span>Your burn choice</span>
                <div>
                  <strong>{primaryName}</strong>
                  {primarySymbol && primarySymbol !== primaryName && (
                    <span className="reference-primary-symbol">{primarySymbol}</span>
                  )}
                </div>
                <code title={primaryLeg.mint}>{shortAddress(primaryLeg.mint, 7)}</code>
              </div>
            </div>
            <div className="reference-primary-weight">
              <strong>{hierarchy.creatorBps / 100}%</strong>
              <span>your pick</span>
            </div>
          </div>
          {mergedFixedLeg && (
            <div className="reference-primary-merged">
              {primaryLeg.bps / 100}% submitted as one binding · includes the fixed{" "}
              {mergedFixedLeg.symbol} {mergedFixedLeg.bps / 100}% leg
            </div>
          )}
          <div className="reference-primary-facts">
            <ReferenceFacts
              mint={primaryLeg.mint}
              candidate={primaryCandidate}
              waiting={primaryWaiting}
            />
          </div>
        </section>

        <section className="reference-fixed" aria-label="Fixed platform fee legs">
          <div className="reference-fixed-head">
            <strong>Fixed platform fee legs</strong>
            <span>10% each</span>
          </div>
          <div className="reference-fixed-list">
            {hierarchy.fixedLegs.map((fixed) => {
              const legIndex = legs.findIndex((leg) => leg.mint === fixed.mint);
              const leg = legIndex >= 0 ? legs[legIndex] : undefined;
              const candidate =
                legIndex >= 0
                  ? state.legReferences[legIndex]?.candidate
                  : undefined;
              const waiting = state.loading && !candidate;
              const merged = fixed.mint === hierarchy.creatorMint;
              const supported = !!candidate && referencePasses(fixed.mint, candidate);

              if (merged && leg) {
                return (
                  <div className="reference-fixed-merged" key={fixed.mint}>
                    <div className="reference-fixed-token">
                      <strong>{fixed.symbol}</strong>
                      <span className="mono">{fixed.bps / 100}%</span>
                    </div>
                    <span>
                      Included in the {leg.bps / 100}% binding above
                    </span>
                    <strong
                      className={supported ? "ok" : waiting ? "" : "err"}
                    >
                      {waiting
                        ? "CHECKING"
                        : supported
                          ? "SUPPORTED"
                          : "NOT SUPPORTED"}
                    </strong>
                  </div>
                );
              }

              // ONE LINE, deliberately. These legs are FIXED: the creator did
              // not choose them and cannot change them, so pool address and SOL
              // depth are detail they can do nothing about -- noise next to the
              // 80% pick, which is the actual decision on this page.
              //
              // The VERDICT still shows, and that is not negotiable: an
              // unsupported fixed leg blocks the launch, and the creator is
              // committing a one-shot, irreversible fee share against these
              // bindings too. Compact is fine; silent is not.
              return (
                <div className="reference-fixed-merged" key={fixed.mint}>
                  <div className="reference-fixed-token">
                    <strong>{fixed.symbol}</strong>
                    <span className="mono">{fixed.bps / 100}%</span>
                  </div>
                  <span className="mono dim">
                    {candidate ? candidate.venue : waiting ? "checking" : ""}
                  </span>
                  <strong className={supported ? "ok" : waiting ? "" : "err"}>
                    {waiting ? "CHECKING" : supported ? "SUPPORTED" : "NOT SUPPORTED"}
                  </strong>
                </div>
              );

            })}
          </div>
        </section>
        {state.error && <p className="reference-error">{state.error}</p>}
      </div>
    );
  }

  return (
    <div className="reference-list" aria-label="Reference pool support">
      {legs.map((leg, index) => {
        const candidate = state.legReferences[index]?.candidate;
        const waiting = state.loading && !candidate;
        return (
          <div className="reference-row" key={leg.mint}>
            <div className="reference-token">
              <strong>{labels[leg.mint] || legLabel(leg.mint, tokenNames)}</strong>
              <span className="mono">{leg.bps / 100}%</span>
            </div>
            <ReferenceFacts
              mint={leg.mint}
              candidate={candidate}
              waiting={waiting}
            />
          </div>
        );
      })}
      {state.error && <p className="reference-error">{state.error}</p>}
    </div>
  );
}
