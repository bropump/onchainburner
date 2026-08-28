import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { useTokenNames } from "../chain/tokenName";
import { useApp } from "../state/AppContext";
import { deriveSplitPda, legsFromParam, splitAmounts } from "../chain/derive";
import { fetchCandidate } from "../chain/reference";
import { sendWithWallet, simulateValidateConfig } from "../chain/instructions";
import {
  collectVaultAltAddresses,
  createVaultLookupTable,
  estimateLookupTableRentLamports,
  lookupTableCovers,
  type LegAltInput,
} from "../chain/lookupTable";
import {
  ERROR_EXPLANATIONS,
  ERROR_NAMES,
  VAULT_RENT_FLOOR_LAMPORTS,
} from "../chain/constants";
import { BURN_DEADLINE_MS, ServiceError } from "../chain/service";
import type { BurnReceipt, CurveState } from "../chain/service";
import {
  AddressBlock,
  CopyButton,
  formatRaw,
  lamportsToSol,
  legLabel,
  shortAddress,
  WeightBar,
} from "../ui";
export type VaultSearch = { launch: string; legs: string; label?: string };

type ReceiptEntry = { at: number; amount: string; receipt: BurnReceipt };

export function VaultPage({ search }: { search: VaultSearch }) {
  const {
    connection,
    service,
    wallet,
    isDemo,
    removeVaultConfig,
    vaultLookupTable,
    setVaultLookupTable,
    rpcUrl,
    health,
  } = useApp();
  const demoEnabled = import.meta.env.DEV && isDemo;
  const navigate = useNavigate();
  const legs = useMemo(() => legsFromParam(search.legs), [search.legs]);
  // Label legs by the coin's own on-chain name where there is no curated
  // symbol — a freshly launched Pump coin is otherwise just a truncated mint.
  const tokenNames = useTokenNames(
    connection,
    useMemo(() => (legs ?? []).map((l) => l.mint), [legs])
  );
  const launch = useMemo(() => {
    try {
      return new PublicKey(search.launch);
    } catch {
      return null;
    }
  }, [search.launch]);

  const vault = useMemo(() => {
    if (!launch || !legs) return null;
    try {
      return deriveSplitPda(
        launch,
        legs.map((leg) => ({
          mint: new PublicKey(leg.mint),
          bps: leg.bps,
          ref: leg.ref ? new PublicKey(leg.ref) : undefined,
        }))
      )[0];
    } catch {
      return null;
    }
  }, [launch, legs]);

  const [balance, setBalance] = useState<bigint | null>(null);
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  /** Config mints that do NOT exist on the connected chain (stale config
   * from another fork/network). null = not checked yet. */
  const [missingMints, setMissingMints] = useState<string[] | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [receipts, setReceipts] = useState<ReceiptEntry[]>([]);
  /** Demo-only live Pump bonding-curve state, so the trade control shows how
   * close the coin is to graduating and reports a completed curve exactly
   * once (the button disables off `complete`) instead of ten failures. */
  const [curve, setCurve] = useState<CurveState | null>(null);
  const balanceRef = useRef<bigint | null>(null);

  /**
   * Per-leg reference caps, resolved through the same service verdict the
   * burn uses, so the CAP is visible BEFORE pressing burn. The program's
   * 6040 refusal (leg input > pool depth x fee) is a feature — a burn much
   * larger than its reference pool moves the price against itself and is
   * exactly the size worth front-running — so the UI's job is to say the
   * burnable amount up front and offer it, not to report a raw lamport
   * number after a failed round trip. Re-resolved after every receipt:
   * caps move with pool state.
   */
  type LegCap = {
    mint: string;
    bps: number;
    capLamports: bigint | null;
    venue?: string;
    note?: string;
  };
  const [legCaps, setLegCaps] = useState<LegCap[] | null>(null);
  useEffect(() => {
    if (!legs) return;
    let cancelled = false;
    (async () => {
      const resolved: LegCap[] = [];
      for (const leg of legs) {
        try {
          const { candidate } = await fetchCandidate(
            service.baseUrl,
            leg.mint,
            leg.ref
          );
          resolved.push({
            mint: leg.mint,
            bps: leg.bps,
            capLamports: candidate.capLamports
              ? BigInt(candidate.capLamports)
              : null,
            venue: candidate.venue,
          });
        } catch (error) {
          resolved.push({
            mint: leg.mint,
            bps: leg.bps,
            capLamports: null,
            note: String((error as Error).message ?? error).slice(0, 600),
          });
        }
      }
      if (!cancelled) setLegCaps(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [legs, service.baseUrl, receipts.length]);

  /** Largest TOTAL that clears every leg's cap simultaneously — the binding
   * constraint is whichever leg hits its cap first once the total is split,
   * so invert the per-leg division and verify with the exact split. */
  const capTotal = useMemo(() => {
    if (!legCaps || legCaps.some((leg) => leg.capLamports === null)) {
      return null;
    }
    let total: bigint | null = null;
    for (const leg of legCaps) {
      const bound = (leg.capLamports! * 10_000n) / BigInt(leg.bps);
      if (total === null || bound < total) total = bound;
    }
    if (total === null) return null;
    for (let guard = 0; guard < 8 && total > 0n; guard++) {
      const amounts = splitAmounts(
        total,
        legCaps.map((leg) => leg.bps)
      );
      const over = amounts.findIndex(
        (amountForLeg, index) => amountForLeg > legCaps[index].capLamports!
      );
      if (over === -1) break;
      const excess = amounts[over] - legCaps[over].capLamports!;
      total -= (excess * 10_000n) / BigInt(legCaps[over].bps) + 1n;
    }
    return total > 0n ? total : 0n;
  }, [legCaps]);

  /**
   * The vault's creator-owned address lookup table. A keyless split burn
   * inlines 8 fixed + 7-per-leg vault accounts before any Jupiter route
   * account. At 3+ legs the burn cannot fit Solana's 1232-byte transaction
   * without a table compressing those keys (measured 1233 bytes minimum),
   * so the table is REQUIRED and burning is gated on it. At 2 legs it is
   * strongly RECOMMENDED but not gated: measured 2026-08-27
   * (scripts/measure-2leg-size.ts), uncapped routes fit only 7/18 walks and
   * the service must narrow the route to land the rest, with margins as
   * thin as 1230/1232 bytes — the table is what makes 2-leg burns reliable.
   * Per the permissionless design the burn service never creates the table
   * itself; the creator makes it here once, pays its rent, and owns it
   * (deactivatable/reclaimable, not frozen).
   */
  const needsLookupTable = legs !== null && legs.length >= 2;
  const requiresLookupTable = legs !== null && legs.length >= 3;
  const [lookupTable, setLookupTable] = useState<string | null>(null);
  /** null = not yet checked; true/false = on-chain active & covering. */
  const [lookupTableReady, setLookupTableReady] = useState<boolean | null>(
    null
  );
  const [altBusy, setAltBusy] = useState(false);
  const [altLog, setAltLog] = useState<string[]>([]);

  // Load the remembered table pointer for this vault, then verify on chain.
  useEffect(() => {
    if (!vault) return;
    const stored = vaultLookupTable(vault.toBase58());
    setLookupTable(stored);
    setLookupTableReady(stored ? null : false);
  }, [vault?.toBase58(), vaultLookupTable]);

  /** Resolve every leg's reference quartet + token program — the exact
   * deterministic accounts the table must cover. Used to verify an existing
   * table and to build a new one. */
  const resolveAltInputs = useCallback(async (): Promise<LegAltInput[]> => {
    if (!legs) throw new Error("no legs");
    const inputs: LegAltInput[] = [];
    for (const leg of legs) {
      const { candidate } = await fetchCandidate(
        service.baseUrl,
        leg.mint,
        leg.ref
      );
      if (!candidate.vaultA || !candidate.vaultB || !candidate.feeSource) {
        throw new Error(
          `reference for ${legLabel(leg.mint, tokenNames)} is not fully resolved yet`
        );
      }
      const mintInfo = await connection.getAccountInfo(
        new PublicKey(leg.mint),
        "confirmed"
      );
      if (!mintInfo) throw new Error(`mint ${leg.mint} not found on chain`);
      inputs.push({
        mint: new PublicKey(leg.mint),
        tokenProgram: mintInfo.owner,
        pool: new PublicKey(candidate.pool),
        vaultA: new PublicKey(candidate.vaultA),
        vaultB: new PublicKey(candidate.vaultB),
        feeSource: new PublicKey(candidate.feeSource),
      });
    }
    return inputs;
  }, [legs, service.baseUrl, connection]);

  // Verify a remembered table is still active and covers the vault accounts.
  useEffect(() => {
    if (!vault || !launch || !lookupTable || !needsLookupTable) return;
    let cancelled = false;
    (async () => {
      try {
        const inputs = await resolveAltInputs();
        const required = collectVaultAltAddresses({
          vault,
          launchMint: launch,
          legs: inputs,
        });
        const ok = await lookupTableCovers(
          connection,
          new PublicKey(lookupTable),
          required
        );
        if (!cancelled) setLookupTableReady(ok);
      } catch {
        if (!cancelled) setLookupTableReady(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault?.toBase58(), launch?.toBase58(), lookupTable, needsLookupTable]);

  const createLookupTable = useCallback(async () => {
    if (!vault || !launch || !wallet) return;
    setAltBusy(true);
    setAltLog([]);
    try {
      const inputs = await resolveAltInputs();
      const addresses = collectVaultAltAddresses({
        vault,
        launchMint: launch,
        legs: inputs,
      });
      const table = await createVaultLookupTable(
        connection,
        wallet,
        addresses,
        (line) => setAltLog((current) => [...current.slice(-6), line])
      );
      setVaultLookupTable(vault.toBase58(), table.toBase58());
      setLookupTable(table.toBase58());
      setLookupTableReady(true);
    } catch (error) {
      setAltLog((current) => [
        ...current.slice(-6),
        `failed: ${String((error as Error).message ?? error).slice(0, 240)}`,
      ]);
    } finally {
      setAltBusy(false);
    }
  }, [
    vault?.toBase58(),
    launch?.toBase58(),
    wallet,
    connection,
    resolveAltInputs,
    setVaultLookupTable,
  ]);

  const pushLog = (line: string) =>
    setLog((current) => [...current.slice(-11), line]);

  // live balance
  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const value = BigInt(await connection.getBalance(vault, "confirmed"));
        if (!cancelled) {
          balanceRef.current = value;
          setBalance(value);
        }
      } catch {
        /* fork unreachable; badge covers it */
      }
    };
    poll();
    const timer = setInterval(poll, 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, vault]);

  // Decimals for receipt formatting, plus existence of every config mint on
  // the CONNECTED chain. Vault configs live only in this browser and survive
  // a fork restart or network change, so a saved config can name mints
  // (typically a fork-launched token) that simply do not exist on the chain
  // the app now points at. That must be said plainly — the burn service
  // would otherwise refuse with a bare INVALID_MINT.
  useEffect(() => {
    if (!legs || !launch) return;
    let cancelled = false;
    (async () => {
      const mints = [
        search.launch,
        ...legs.map((leg) => leg.mint).filter((m) => m !== search.launch),
      ];
      const infos = await connection.getMultipleAccountsInfo(
        mints.map((mint) => new PublicKey(mint)),
        "confirmed"
      );
      if (cancelled) return;
      const map: Record<string, number> = {};
      const absent: string[] = [];
      mints.forEach((mint, i) => {
        const data = infos[i]?.data;
        if (!infos[i]) absent.push(mint);
        if (data && data.length >= 82) map[mint] = data[44];
      });
      setDecimals(map);
      setMissingMints(absent);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, search.launch, search.legs]);

  // one-off on-chain admission verdict
  useEffect(() => {
    if (!launch || !legs || !vault) return;
    let cancelled = false;
    (async () => {
      try {
        const health = await service.health();
        const payer =
          wallet?.publicKey ??
          (health.payer ? new PublicKey(health.payer) : null);
        if (!payer) return;
        // Mode A needs resolved reference blocks. The vault URL has
        // addresses only, so skip rather than invent a second encoding.
        const result = await simulateValidateConfig(
          connection,
          payer,
          launch,
          legs.map((leg) => ({
            mint: new PublicKey(leg.mint),
            bps: leg.bps,
            ref: leg.ref ? new PublicKey(leg.ref) : undefined,
          }))
        );
        if (cancelled) return;
        if (result.skipped) {
          setVerdict(null);
          return;
        }
        setVerdict(
          result.ok
            ? "admissible (validate_config passes on chain)"
            : `INADMISSIBLE — ${result.code ?? "?"} ${result.name ?? ""}`
        );
      } catch {
        if (!cancelled) setVerdict(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, launch?.toBase58(), search.legs, vault?.toBase58()]);

  // Live curve state (demo only): drives the progress bar and the
  // graduated-once handling. Re-polled after each trade so progress moves.
  useEffect(() => {
    if (!demoEnabled || !search.launch) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const state = await service.demoCurve(search.launch);
        if (!cancelled) setCurve(state);
      } catch {
        /* not a Pump curve, or service unreachable — badge covers it */
      }
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoEnabled, search.launch, receipts.length, log.length]);

  const runDemo = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setBusy(label);
      try {
        pushLog(await action());
      } catch (error) {
        pushLog(
          `${label} failed: ${String((error as Error).message ?? error).slice(
            0,
            200
          )}`
        );
      } finally {
        setBusy(null);
      }
    },
    []
  );

  if (!launch || !legs || !vault) {
    return (
      <div className="panel">
        <h2>Vault</h2>
        <p className="sub">
          This page needs a full configuration in the URL
          (?launch=…&amp;legs=mint:bps,…) — the config IS the address, and it
          cannot be read back from the chain. Open a vault from the home page
          list, or re-enter its config.
        </p>
      </div>
    );
  }

  const spendable =
    balance !== null && balance > VAULT_RENT_FLOOR_LAMPORTS
      ? balance - VAULT_RENT_FLOOR_LAMPORTS
      : 0n;

  const parseAmount = (): bigint | null => {
    if (!amount.trim()) return null;
    try {
      const [whole, frac = ""] = amount.trim().split(".");
      return (
        BigInt(whole || "0") * 1_000_000_000n +
        BigInt((frac + "000000000").slice(0, 9))
      );
    } catch {
      return null;
    }
  };
  const burnLamports = parseAmount();

  /** A split burn is atomic: if ANY leg cannot price against its bound
   * reference right now (graduation migration window, unresolvable pool),
   * NO amount can burn — every leg reverts together. There is no valid
   * number to offer, so burning is disabled with the reason, rather than
   * pre-filling a figure guaranteed to fail. */
  const capsUnknown =
    legCaps !== null && legCaps.some((leg) => leg.capLamports === null);
  const maxBurnNow =
    capTotal !== null && capTotal < spendable ? capTotal : spendable;
  const burnsNeeded =
    capTotal !== null && capTotal > 0n && spendable > capTotal
      ? Number((spendable + capTotal - 1n) / capTotal)
      : null;
  const overCapLeg = (() => {
    if (
      !burnLamports ||
      burnLamports <= 0n ||
      !legCaps ||
      legCaps.some((leg) => leg.capLamports === null)
    ) {
      return null;
    }
    const amounts = splitAmounts(
      burnLamports,
      legCaps.map((leg) => leg.bps)
    );
    const index = amounts.findIndex(
      (amountForLeg, i) => amountForLeg > legCaps[i].capLamports!
    );
    return index === -1
      ? null
      : { index, amount: amounts[index], cap: legCaps[index].capLamports! };
  })();

  async function burn() {
    if (!burnLamports || burnLamports <= 0n) return;
    setBusy("burn");
    try {
      const receipt = await service.burn(
        {
          launchMint: search.launch,
          legs: legs!.map((leg) => ({
            mint: leg.mint,
            bps: leg.bps,
            reference: leg.ref,
          })),
          amountInLamports: burnLamports.toString(),
          ...(lookupTable ? { lookupTableAddresses: [lookupTable] } : {}),
        },
        wallet ?? undefined
      );
      setReceipts((current) => [
        { at: Date.now(), amount: burnLamports.toString(), receipt },
        ...current,
      ]);
    } catch (error) {
      // Attribution decides the advice, never the transport path:
      //  - EXTERNAL_SIMULATION_FAILURE: the innermost failing program was
      //    Jupiter or an AMM (route weather) -> external, retry with a
      //    fresh quote;
      //  - a browser deadline expiry -> the request was abandoned HERE and
      //    may still land; never call that a refusal;
      //  - a service refusal (it answered with a specific reason) -> only
      //    then say retrying will not change it.
      const serviceError = error instanceof ServiceError ? error : null;
      const rejectedBy = serviceError?.timedOut
        ? ("deadline" as const)
        : serviceError?.code === "EXTERNAL_SIMULATION_FAILURE"
        ? ("external" as const)
        : serviceError?.refused
        ? ("service-refused" as const)
        : ("service" as const);
      setReceipts((current) => [
        {
          at: Date.now(),
          amount: burnLamports.toString(),
          receipt: {
            status: "rejected",
            rejectedBy,
            logsTail: [String((error as Error).message ?? error).slice(0, 600)],
          },
        },
        ...current,
      ]);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="hero-copy">
        <h1>{search.label ? `${search.label} vault` : "Vault"}</h1>
        <p>
          Namespace{" "}
          <code className="mono">{shortAddress(search.launch, 6)}</code>
          {" · "}
          {legs.map((leg, i) => (
            <span key={i} className="mono">
              {i > 0 && " / "}
              {legLabel(leg.mint, tokenNames)} {(leg.bps / 100).toFixed(1)}%
            </span>
          ))}
          {verdict && (
            <span
              className="mono"
              style={{
                marginLeft: 12,
                fontSize: 12,
                color: verdict.startsWith("INADMISSIBLE")
                  ? "var(--err)"
                  : "var(--ok)",
              }}
            >
              {verdict}
            </span>
          )}
        </p>
      </div>

      {missingMints !== null && missingMints.length > 0 && (
        <div className="plain-message error-copy" style={{ marginBottom: 16 }}>
          <strong>
            This vault's configuration does not exist on the connected chain.
          </strong>{" "}
          {missingMints.length === 1 ? "The mint" : "The mints"}{" "}
          {missingMints.map((mint, i) => (
            <span key={mint}>
              {i > 0 && ", "}
              <code className="mono">{shortAddress(mint, 6)}</code>
            </span>
          ))}{" "}
          {missingMints.length === 1 ? "is" : "are"} absent from{" "}
          <code className="mono">{rpcUrl}</code> — this config was most likely
          created against a different fork or network (fork-launched tokens
          vanish when the fork restarts). Burning and setup will be refused
          here; that is a property of this chain, not of the vault. Reconnect
          the app to the chain this vault was created on, or remove the saved
          config from this browser.
          <div style={{ marginTop: 10 }}>
            <button
              className="btn small"
              onClick={() => {
                removeVaultConfig(search.launch, search.legs);
                navigate({ to: "/" });
              }}
            >
              remove this config from this browser
            </button>
          </div>
        </div>
      )}

      <div className="grid2">
        <div>
          <div className="panel">
            <h2>Vault address — send SOL here</h2>
            <AddressBlock value={vault.toBase58()} hero />
            <div style={{ marginTop: 16 }}>
              <div className="bignum">
                {balance === null ? "…" : lamportsToSol(balance)}
                <span className="unit">SOL in vault</span>
              </div>
              <p className="sub" style={{ marginTop: 4 }}>
                spendable {lamportsToSol(spendable)} SOL — a burn must leave the
                0.00089088 SOL rent floor (or empty the vault exactly)
              </p>
            </div>
            <WeightBar legs={legs} />
          </div>

          {demoEnabled && (
            <div className="panel">
              <h2>
                Demo loop <span className="demo-tag">DEMO ONLY</span>
              </h2>
              <p className="sub">
                Real Pump buys accrue creator fees on the launch token; the
                distribute call pays them to the vault as SOL. Absent on mainnet
                — there, real traders and Pump payouts do this.
              </p>
              {curve && curve.exists && !curve.complete && (
                <div style={{ margin: "8px 0" }}>
                  <div className="sub" style={{ marginBottom: 4 }}>
                    curve progress <strong>{curve.progressPct}%</strong> —{" "}
                    {lamportsToSol(curve.realSolLamports)} of ~85 SOL raised
                    {curve.progressPct >= 85 && (
                      <span style={{ color: "var(--err)" }}>
                        {" "}
                        · approaching graduation — trading pauses near 80 SOL to
                        keep this coin testable
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      height: 8,
                      borderRadius: 4,
                      background: "var(--panel-2, #22222a)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, curve.progressPct)}%`,
                        height: "100%",
                        background:
                          curve.progressPct >= 85
                            ? "var(--err)"
                            : "var(--accent, #e0662f)",
                      }}
                    />
                  </div>
                </div>
              )}
              {curve && curve.complete && (
                <div className="plain-message error-copy" style={{ margin: "8px 0" }}>
                  <strong>This coin has graduated.</strong> Its bonding curve is
                  complete, so the demo "trade" buys are closed (Pump 6005) — no
                  more creator fees can be generated on the curve.{" "}
                  {curve.poolExists ? (
                    <>
                      Its canonical PumpSwap pool exists, so this coin is still a
                      valid burn target and any vault holding its fees can burn.
                    </>
                  ) : (
                    <>
                      On mainnet Pump's migrator creates its PumpSwap pool within
                      minutes; a local fork never runs that, so the own-leg burn
                      is paused (REFERENCE_MIGRATING) until you crank the
                      migration below. The vault's SOL is safe throughout.
                    </>
                  )}
                  <div
                    style={{
                      marginTop: 10,
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    {!curve.poolExists && (
                      <button
                        className="btn small"
                        disabled={busy !== null}
                        onClick={() =>
                          runDemo("migrate", async () => {
                            const result = await service.demoMigrate(
                              search.launch
                            );
                            return result.alreadyExisted
                              ? `canonical PumpSwap pool already exists (${shortAddress(
                                  result.pool,
                                  6
                                )})`
                              : `migrated: canonical PumpSwap pool ${shortAddress(
                                  result.pool,
                                  6
                                )} created — the own-leg burn can now proceed`;
                          })
                        }
                      >
                        {busy === "migrate" ? <span className="spin" /> : null}{" "}
                        create PumpSwap pool (crank migration)
                      </button>
                    )}
                  </div>
                  <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
                    To keep testing burns on this graduated coin, fund the vault
                    directly with the demo airdrop below (clearly demo-only SOL,
                    not creator-fee revenue).
                  </p>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  disabled={busy !== null || Boolean(curve?.complete)}
                  title={
                    curve?.complete
                      ? "the curve has graduated — buys are closed"
                      : undefined
                  }
                  onClick={() =>
                    runDemo("trade", async () => {
                      const result = await service.demoTrade(search.launch);
                      if (result.graduated) {
                        return "curve graduated — buys are closed (Pump 6005); fund the vault directly (demo) to keep testing";
                      }
                      if (result.nearGraduation) {
                        return (
                          result.message ??
                          "curve near graduation — trading paused to keep this coin testable"
                        );
                      }
                      return `trade: ${
                        result.buys.length
                      } Pump buy${result.buys.length === 1 ? "" : "s"} (${result.buys
                        .map((b) => lamportsToSol(b))
                        .join(" + ")} SOL) — creator fees accrued${
                        result.progressPct !== undefined
                          ? `, curve ${result.progressPct}%`
                          : ""
                      }`;
                    })
                  }
                >
                  {busy === "trade" ? <span className="spin" /> : null} trade
                  the token
                </button>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    runDemo("distribute", async () => {
                      const result = await service.demoDistribute(
                        search.launch,
                        vault.toBase58()
                      );
                      return `distribute: vault +${lamportsToSol(
                        result.vaultLamportsDelta
                      )} SOL (now ${lamportsToSol(result.vaultLamports)})`;
                    })
                  }
                >
                  {busy === "distribute" ? <span className="spin" /> : null}{" "}
                  distribute fees → vault
                </button>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    runDemo("fund", async () => {
                      await service.demoAirdrop(
                        vault.toBase58(),
                        25_000_000_000n
                      );
                      return "funded vault with 25 SOL (airdrop)";
                    })
                  }
                >
                  {busy === "fund" ? <span className="spin" /> : null} airdrop 25
                  SOL to vault
                </button>
              </div>
              {log.length > 0 && (
                <div className="logs" style={{ marginTop: 12 }}>
                  {log.join("\n")}
                </div>
              )}
            </div>
          )}

          {wallet && (
            <div className="panel">
              <h2>Fund from your wallet</h2>
              <p className="sub">
                The vault is an ordinary System account: any SOL transfer funds
                it, from any source.
              </p>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  runDemo("wallet-fund", async () => {
                    const ix: TransactionInstruction = SystemProgram.transfer({
                      fromPubkey: wallet.publicKey,
                      toPubkey: vault,
                      lamports: 1_000_000_000n,
                    });
                    const signature = await sendWithWallet(connection, wallet, [
                      ix,
                    ]);
                    return `sent 1 SOL from ${wallet.label}: ${shortAddress(
                      signature,
                      8
                    )}`;
                  })
                }
              >
                send 1 SOL to the vault
              </button>
            </div>
          )}
        </div>

        <div>
          <div className="panel">
            <h2>Burn</h2>
            <p className="sub">
              The burn service builds the Jupiter swap-and-burn; your wallet is
              the only signer, and every rule — including the price floor — is
              enforced by the program on chain.
            </p>
            {needsLookupTable && (
              <div
                className={`plain-message${
                  lookupTable && lookupTableReady !== false ? "" : " error-copy"
                }`}
                style={{ margin: "8px 0" }}
              >
                {lookupTable ? (
                  <>
                    <strong>Address lookup table ready.</strong>{" "}
                    <code className="mono">{shortAddress(lookupTable, 6)}</code>{" "}
                    covers this vault's accounts so the {legs.length}-leg burn
                    fits in one transaction.
                    {lookupTableReady === false && (
                      <div style={{ marginTop: 6, color: "var(--err)" }}>
                        The remembered table is no longer active or complete on{" "}
                        <code className="mono">{rpcUrl}</code>. Create a new one.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <strong>
                      {requiresLookupTable
                        ? `This ${legs.length}-leg vault needs an address lookup table before it can burn.`
                        : `This 2-leg vault should have an address lookup table.`}
                    </strong>{" "}
                    {requiresLookupTable
                      ? "A 3+ leg keyless burn inlines the vault's own accounts and cannot fit Solana's 1232-byte transaction without one."
                      : "A 2-leg burn only fits without one when the service narrows the Jupiter route, and even then sometimes by just 2 bytes — with the table it fits comfortably every time."}{" "}
                    You (the creator) create and own it — roughly{" "}
                    {lamportsToSol(
                      estimateLookupTableRentLamports(8 + legs.length * 7)
                    )}{" "}
                    SOL of rent, reclaimable later (it is not frozen). The burn
                    service never creates it, so anyone's builder can use it.
                  </>
                )}
                {(!lookupTable || lookupTableReady === false) && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      className="btn small"
                      disabled={altBusy || !wallet}
                      title={!wallet ? "connect a wallet first" : undefined}
                      onClick={createLookupTable}
                    >
                      {altBusy ? <span className="spin" /> : null} create lookup
                      table
                    </button>
                  </div>
                )}
                {altLog.length > 0 && (
                  <div className="logs" style={{ marginTop: 10 }}>
                    {altLog.join("\n")}
                  </div>
                )}
              </div>
            )}
            {legCaps && capTotal !== null && (
              <div className="sub" style={{ margin: "8px 0" }}>
                <p className="sub" style={{ margin: 0 }}>
                  per-burn max <strong>{lamportsToSol(maxBurnNow)} SOL</strong>
                  {burnsNeeded !== null && (
                    <> · ~{burnsNeeded} burns to empty</>
                  )}
                </p>
                <p className="sub" style={{ marginTop: 6 }}>
                  The program caps each leg at its reference pool's depth × fee
                  (6040): burns stay small enough relative to their pool that
                  moving the price against you is not worth anyone's while. A
                  vault above the cap burns over several transactions.
                </p>
                <p className="sub mono" style={{ marginTop: 4 }}>
                  {legCaps
                    .filter((leg) => leg.capLamports !== null)
                    .map(
                      (leg) =>
                        `${legLabel(leg.mint, tokenNames)} ≤ ${lamportsToSol(
                          leg.capLamports!
                        )} SOL (${(leg.bps / 100).toFixed(0)}%)`
                    )
                    .join(" · ")}
                </p>
              </div>
            )}
            {capsUnknown && (
              <div style={{ margin: "8px 0" }}>
                <p className="sub" style={{ margin: 0 }}>
                  <strong>No burnable amount right now.</strong> A split burn is
                  atomic — a leg that cannot price means no leg burns. The
                  vault's SOL is safe and stays put.
                </p>
                <div>
                  {legCaps!
                    .filter((leg) => leg.capLamports === null)
                    .map((leg) => (
                      <p
                        className="sub"
                        key={leg.mint}
                        style={{ marginTop: 6 }}
                      >
                        {legLabel(leg.mint, tokenNames)}: {leg.note ?? "no cap available"}
                      </p>
                    ))}
                </div>
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <label
                className="field"
                style={{ flex: 1, minWidth: 180, marginBottom: 0 }}
              >
                <span className="name">Amount (SOL)</span>
                <input
                  type="text"
                  className="mono"
                  value={amount}
                  placeholder="0.0"
                  style={
                    overCapLeg
                      ? { borderColor: "var(--bad, #c0392b)" }
                      : undefined
                  }
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <button
                className="btn small"
                disabled={spendable === 0n || capsUnknown}
                title={
                  capsUnknown
                    ? "a leg cannot price right now — no amount can burn"
                    : undefined
                }
                onClick={() =>
                  setAmount(lamportsToSol(maxBurnNow).replace(/,/g, ""))
                }
              >
                burn max
              </button>
              <button
                className="btn primary"
                disabled={
                  busy !== null ||
                  !wallet ||
                  capsUnknown ||
                  (requiresLookupTable && !lookupTable) ||
                  !burnLamports ||
                  burnLamports <= 0n ||
                  (balance !== null && burnLamports > balance) ||
                  (missingMints !== null && missingMints.length > 0)
                }
                title={
                  requiresLookupTable && !lookupTable
                    ? "create the vault's address lookup table first"
                    : undefined
                }
                onClick={burn}
              >
                {busy === "burn" ? (
                  <>
                    <span className="spin" /> burning…
                  </>
                ) : (
                  "burn"
                )}
              </button>
            </div>
            {overCapLeg && legCaps && (
              <p
                className="sub"
                style={{ marginTop: 8, color: "var(--bad, #c0392b)" }}
              >
                Max {capTotal !== null ? lamportsToSol(capTotal) : "?"} SOL —
                the {legLabel(legCaps[overCapLeg.index].mint)} leg is the limit
                (program refusal 6040).
              </p>
            )}
            {busy === "burn" && (
              <p className="sub" style={{ marginTop: 10 }}>
                Burn request in flight — the service resolves references,
                quotes each leg, simulates, and submits. Keyless: no co-signer
                exists; on mainnet your wallet is the only signature the burn
                needs.
                {typeof health === "object" && health?.jupiter?.keyed === false
                  ? " Jupiter access is UNKEYED (free tier): a burn typically lands in seconds; a rate-limit burst adds brief retries (~1.5-7s each). Set JUPITER_API_KEY on the service to raise the limit."
                  : ""}{" "}
                The browser stops waiting at{" "}
                {Math.round(BURN_DEADLINE_MS / 1000)}s; if that happens the
                service may still land the burn — watch the vault balance.
              </p>
            )}
          </div>

          {receipts.map((entry, i) => (
            <Receipt
              key={entry.at + "-" + i}
              entry={entry}
              decimals={decimals}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Receipt({
  entry,
  decimals,
}: {
  entry: ReceiptEntry;
  decimals: Record<string, number>;
}) {
  const { receipt } = entry;
  if (receipt.status === "submitted") {
    return (
      <div className="panel receipt ok" style={{ padding: 0 }}>
        <div className="head">
          <span className="status">SUBMITTED PRIVATELY</span>
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-2)" }}
          >
            {new Date(entry.at).toLocaleTimeString()} ·{" "}
            {receipt.simulatedUnits?.toLocaleString() ?? "—"} CU simulated
          </span>
        </div>
        <div className="bodyrows">
          <div className="kv">
            <dt>Relay submission</dt>
            <dd>
              {receipt.submissionId} <CopyButton value={receipt.submissionId} />
            </dd>
            <dt>Message digest</dt>
            <dd className="mono">{receipt.messageSha256}</dd>
            <dt>Input</dt>
            <dd>{lamportsToSol(entry.amount)} SOL</dd>
          </div>
        </div>
      </div>
    );
  }
  if (receipt.status === "burned") {
    return (
      <div className="panel receipt ok" style={{ padding: 0 }}>
        <div className="head">
          <span className="status">
            BURNED
            {receipt.attempts !== undefined && receipt.attempts > 1
              ? ` (attempt ${receipt.attempts} — route weather auto-retried)`
              : ""}
          </span>
          <span
            className="mono"
            style={{ fontSize: 12, color: "var(--ink-2)" }}
          >
            {new Date(entry.at).toLocaleTimeString()} ·{" "}
            {receipt.computeUnits?.toLocaleString()} CU
          </span>
        </div>
        <div className="bodyrows">
          <div className="kv">
            <dt>Signature</dt>
            <dd>
              {receipt.signature} <CopyButton value={receipt.signature} />
            </dd>
            <dt>Input</dt>
            <dd>{lamportsToSol(entry.amount)} SOL</dd>
            <dt>Vault after</dt>
            <dd>{lamportsToSol(receipt.vaultAfter)} SOL</dd>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Leg</th>
                <th className="num">SOL in</th>
                <th className="num">Burned</th>
              </tr>
            </thead>
            <tbody>
              {receipt.legs.map((leg, i) => (
                <tr key={i}>
                  {/* No map in this sub-component; the page above has
                      already populated the process-wide cache. */}
                  <td>{legLabel(leg.mint)}</td>
                  <td className="num">{lamportsToSol(leg.amountIn)}</td>
                  <td className="num">
                    {formatRaw(leg.burned, decimals[leg.mint] ?? null)}{" "}
                    <span style={{ color: "var(--ink-3)" }}>
                      ({leg.burned} raw)
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  const code = receipt.errorCode;
  return (
    <div className="panel receipt bad" style={{ padding: 0 }}>
      <div className="head">
        <span className="status">
          {receipt.rejectedBy === "deadline"
            ? "ABANDONED — outcome unknown"
            : "REJECTED — vault untouched"}
        </span>
        <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {new Date(entry.at).toLocaleTimeString()}
        </span>
      </div>
      <div className="bodyrows">
        <div className="kv">
          <dt>Rejected by</dt>
          <dd>
            {receipt.rejectedBy === "burner"
              ? "the burner program"
              : receipt.rejectedBy === "service"
              ? "nobody — the request never reached the burn service"
              : receipt.rejectedBy === "service-refused"
              ? "the burn service — it refused the request before building anything"
              : receipt.rejectedBy === "deadline"
              ? "nobody — the browser stopped waiting at its deadline"
              : "an external program (venue/route)"}
          </dd>
          {code !== undefined && (
            <>
              <dt>Code</dt>
              <dd>
                {code} {ERROR_NAMES[code] ?? ""}
              </dd>
            </>
          )}
        </div>
        {code !== undefined &&
          ERROR_EXPLANATIONS[code] &&
          receipt.rejectedBy === "burner" && (
            <div className="plain-message error-copy" style={{ margin: 0 }}>
              {ERROR_EXPLANATIONS[code]}
            </div>
          )}
        {receipt.rejectedBy === "external" && (
          <div className="plain-message" style={{ margin: 0 }}>
            The route failed outside the burner — nothing moved and the burn can
            simply be retried. On a fork this is usually price drift between
            Jupiter's live quotes and the frozen fork state.
          </div>
        )}
        {receipt.rejectedBy === "service" && (
          <div className="plain-message" style={{ margin: 0 }}>
            The burn service could not be reached, so no transaction was built,
            signed, or submitted — the vault is untouched. Retry when the
            service badge in the header is live again.
          </div>
        )}
        {receipt.rejectedBy === "deadline" && (
          <div className="plain-message" style={{ margin: 0 }}>
            The browser gave up waiting, but the service may still be working on
            this request — the burn CAN still land. Watch the vault balance for
            a drop before retrying; retrying while the original is still in
            flight is refused by the service's one-burn-per-vault lease.
          </div>
        )}
        {receipt.rejectedBy === "service-refused" && (
          <div className="plain-message" style={{ margin: 0 }}>
            The burn service answered and refused this request before building
            any transaction — the vault is untouched. The reason below is
            specific; retrying will not change it until the condition it names
            does.
          </div>
        )}
        {receipt.headline && (
          <p className="sub" style={{ margin: 0 }}>
            {receipt.headline}
          </p>
        )}
        {receipt.logsTail.length > 0 &&
          (receipt.headline ||
          receipt.rejectedBy === "external" ||
          receipt.rejectedBy === "burner" ? (
            <div>
              <p className="sub" style={{ margin: "8px 0 4px" }}>Raw detail</p>
              <div className="logs">{receipt.logsTail.join("\n")}</div>
            </div>
          ) : (
            <div className="logs">{receipt.logsTail.join("\n")}</div>
          ))}
      </div>
    </div>
  );
}
