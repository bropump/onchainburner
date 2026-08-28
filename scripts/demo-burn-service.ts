/**
 * Demo burn service: the LOCAL stand-in for the production burn service,
 * for driving the frontend against a Surfpool fork.
 *
 * KEYLESS 2026-08-26: there is no quote authority and nothing here signs
 * anything but the demo payer's own fee. Burns run through the REAL
 * QuoteService pipeline (quote-service/core.ts): reference resolution, the
 * program-floor mirror, the 7-account keyless leg layout, Jupiter v2 route
 * construction, simulation, submission — the exact code path the production
 * service runs, wired to the local fork.
 *
 * DEMO-ONLY endpoints (airdrop, market-buy simulation, fee distribution)
 * exist so a browser can watch the full product loop — launch, fees accrue,
 * payouts land in the vault, burn — without a wallet extension or real
 * traders. They hold no place in production and refuse to start against a
 * non-local RPC.
 *
 *   GET  /health             -> { ok, mode, slot, program, payer }
 *   GET  /reference/markets  -> ?mint=… => the keyless reference selection:
 *                               Pump branch or REAL market enumeration
 *                               (gPA per venue), ranked locked-CP then main
 *                               AMM then largest-oldest concentrated
 *   POST /burn               -> { launchMint, legs:[{mint,bps,reference?}],
 *                               amountInLamports }
 *                               => receipt { signature, burned[], ... }
 *   POST /demo/airdrop       -> { address, lamports }     (payer transfer)
 *   POST /demo/trade         -> { mint, solAmounts[] }    (real Pump buys)
 *   POST /demo/distribute    -> { mint, vault }           (creator-fee payout)
 *
 * Run: npx tsx scripts/demo-burn-service.ts   (port 8787, RPC 127.0.0.1:8899)
 */
import http from "http";
import {
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  deriveVault,
  InMemoryVaultLeaseStore,
  JupiterBuildParams,
  JupiterClient,
  PolicyError,
  PrivateSubmitter,
  QuoteService,
} from "../quote-service/core";
import {
  JupiterV2HttpClient,
  LocalKeypairMessageSigner,
  PumpDirectCurveClient,
  SolanaRpcGateway,
} from "../quote-service/adapters";
import {
  deriveBondingCurveV2,
  derivePumpCurve,
  deriveUserVolumeAccumulator,
  DIRECT_CURVE_VENUE,
} from "../quote-service/directcurve";
import {
  resolveReference,
  ResolvedReference,
} from "../quote-service/reference";
import {
  MarketCandidate,
  ProgramAccountsReader,
  resolveCandidate,
  selectReference,
} from "../quote-service/markets";
import type { AccountDataReader } from "../quote-service/reference";
import {
  attributeFailure,
  PROGRAM as DEFAULT_PROGRAM,
  readPayer,
  RPC_URL,
  sendInstructions,
} from "./surfpool-split-e2e";

/** Fork deploys get fresh program ids; the env override points at one. */
const PROGRAM = process.env.BURNER_PROGRAM_ID
  ? new PublicKey(process.env.BURNER_PROGRAM_ID)
  : DEFAULT_PROGRAM;

const {
  OnlinePumpSdk,
  PUMP_SDK,
  PumpSdk,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
} = require("@pump-fun/pump-sdk");
const BN = require("bn.js");
const { getMint } = require("@solana/spl-token");

const PORT = Number(process.env.DEMO_SERVICE_PORT ?? 8787);
/** Fixed slippage tolerance for fork burns. Jupiter's RTSE estimates from
 * LIVE mainnet state while the fork's pools are frozen at the fork slot, so
 * the drift between them lands as spurious Jupiter 0x1771 rejections. A
 * fixed tolerance isolates that drift (same convention as the fork suites). */
const DEMO_SLIPPAGE_BPS = Number(process.env.DEMO_SLIPPAGE_BPS ?? 1500);
/** Attempts per burn: Jupiter returns a different route per /build call and
 * some routes reference venue state a fork cannot serve, so an EXTERNALLY
 * attributed failure is retried with a fresh route. Burner-attributed
 * rejections are deterministic and never retried. */
const MAX_BURN_ATTEMPTS = Number(process.env.DEMO_BURN_ATTEMPTS ?? 4);

if (!/127\.0\.0\.1|localhost/.test(RPC_URL)) {
  console.error(
    `refusing to start: demo service is fork-only, RPC is ${RPC_URL}`
  );
  process.exit(1);
}

const connection = new Connection(RPC_URL, "confirmed");
const payer = readPayer();
const onlinePump = new OnlinePumpSdk(connection);

/** Venues a Surfpool fork can serve (the FORK_DEX_PROFILE=pool equivalent —
 * mandatory for any fork burn, per CLAUDE.md). */
const POOL_ONLY_FORK_DEXES = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
  "Pump.fun Amm",
  "Pump.fun",
];

type TimingContext = Readonly<{
  requestId: string;
  burnAttempt: number;
}>;

function logStructured(fields: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify(fields));
}

async function timedPhase<T>(
  context: TimingContext,
  phase: string,
  fields: Readonly<Record<string, string | number>>,
  action: () => Promise<T>
): Promise<T> {
  const started = performance.now();
  let outcome = "ok";
  let errorCode = "";
  try {
    return await action();
  } catch (error) {
    outcome = "error";
    errorCode = error instanceof PolicyError ? error.code : "";
    throw error;
  } finally {
    logStructured({
      event: "phase-timing",
      requestId: context.requestId,
      burnAttempt: context.burnAttempt,
      phase,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      outcome,
      errorCode,
      ...fields,
    });
  }
}

class ForkJupiter implements JupiterClient {
  /**
   * Free-tier pacing, MEASURED rather than assumed (2026-08-26). The old
   * version slept an unconditional 6s after EVERY call, so a 2-leg burn
   * carried 12s of self-imposed sleep per attempt (the live 8788 log shows
   * a 12.3-12.4s cadence per attempt, ~97% of it the sleep) and a 3-leg
   * burn 18s — while the same-day harness campaign ran 61 burns in ~25min
   * on the same free tier with NO spacing, only retry-on-429. Probes here
   * confirmed it: 39 rapid calls, 19 of them 429s, every one absorbed by a
   * 1.5s-stepped retry, ~100ms average network time per call. So: serialize
   * (one call in flight), no spacing, and back off ONLY when Jupiter
   * actually says 429.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** Venues excluded for every leg of the CURRENT burn request — the
   * stale-fork reroute lever (see executeBurn). Demo-only: the demo serves
   * one operator, so a request-scoped reset in executeBurn is enough. */
  readonly excludedVenues = new Set<string>();
  /** Cumulative counters; executeBurn snapshots them per request. */
  readonly stats = {
    calls: 0,
    http429: 0,
    networkMs: 0,
    backoffMs: 0,
    queueWaitMs: 0,
  };
  constructor(private readonly inner: JupiterClient) {}
  build(params: JupiterBuildParams): ReturnType<JupiterClient["build"]> {
    const queuedAt = performance.now();
    const run = this.queue.then(async () => {
      this.stats.queueWaitMs += performance.now() - queuedAt;
      const excluded = new Set([
        ...(params.excludeDexes ?? []),
        ...this.excludedVenues,
      ]);
      for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        try {
          const result = await this.inner.build({
            ...params,
            excludeDexes: undefined,
            dexes: POOL_ONLY_FORK_DEXES.filter((venue) => !excluded.has(venue)),
            slippageBps: params.slippageBps ?? DEMO_SLIPPAGE_BPS,
          });
          this.stats.calls += 1;
          this.stats.networkMs += Date.now() - started;
          return result;
        } catch (error) {
          this.stats.calls += 1;
          this.stats.networkMs += Date.now() - started;
          const message = String((error as Error).message ?? error);
          if (/429/.test(message) && attempt < 5) {
            this.stats.http429 += 1;
            const backoff = 1_500 * (attempt + 1);
            this.stats.backoffMs += backoff;
            await new Promise((resolve) => setTimeout(resolve, backoff));
            continue;
          }
          throw error;
        }
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

class RpcSubmitter implements PrivateSubmitter {
  async submit(transaction: Uint8Array) {
    const submissionId = await connection.sendRawTransaction(
      Buffer.from(transaction),
      { skipPreflight: false, preflightCommitment: "confirmed" }
    );
    return { submissionId };
  }
}

const chain = new SolanaRpcGateway(connection);
const discoveryJupiter = new JupiterV2HttpClient(
  process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
  process.env.JUPITER_API_KEY
);
const jupiter = new ForkJupiter(discoveryJupiter);
const directCurve = new PumpDirectCurveClient(connection);
/** Hoisted so executeBurn can settle a vault's lease the moment its burn is
 * CONFIRMED. Without this a successful burn kept its vault refusing
 * VAULT_BUSY for the full 180s TTL (observed live 2026-08-26). */
const leaseStore = new InMemoryVaultLeaseStore();
/** Mutable on purpose: the demo maintains one lookup table per vault for
 * direct-curve burns (18 Pump accounts would otherwise be static keys and
 * blow the 1232-byte wire limit) and approves each table it creates. */
const approvedLookupTables = new Set<string>();
const service = new QuoteService({
  burnerProgram: PROGRAM,
  chain,
  jupiter,
  directCurve,
  feePayerSigner: new LocalKeypairMessageSigner(payer),
  submitter: new RpcSubmitter(),
  leaseStore,
  policy: {
    production: false,
    maxAmountPerBurn: 200_000_000_000n,
    maxSlippageBps: 2_000,
    maxPriceImpactBps: 2_500,
    computeUnitLimit: 1_400_000,
    minRemainingBlockHeights: 50,
    leaseTtlMs: 180_000,
    // Keep total Jupiter calls low on the shared free-tier IP: no internal
    // pipeline retry; the demo's own outer loop retries with a hard backoff.
    retryAttempts: 0,
    fittingMaxAccounts: [40, 32, 26, 20, 16, 12],
    approvedLookupTables,
  },
  onEvent: (fields) => {
    const burnAttempt = /-(\d+)$/.exec(fields.requestId ?? "")?.[1];
    logStructured({
      ...fields,
      ...(burnAttempt === undefined ? {} : { burnAttempt: Number(burnAttempt) }),
    });
  },
});

// ---------------------------------------------------------------------------
// Reference-market enumeration (GET /reference/markets)
// ---------------------------------------------------------------------------

const accountReader: AccountDataReader = {
  async getAccountData(address: PublicKey) {
    const info = await connection.getAccountInfo(address, "confirmed");
    return info
      ? { owner: info.owner, data: info.data, lamports: BigInt(info.lamports) }
      : null;
  },
};

/** Real enumeration through the fork RPC: Surfpool proxies filtered
 * getProgramAccounts to its datasource, so the addresses come from live
 * mainnet state and every candidate's CONTENT is then read (and later
 * authenticated) through the fork the burn will actually run on. */
const gpaReader: ProgramAccountsReader = {
  async getProgramAddresses(program, filters) {
    const result = await connection.getProgramAccounts(program, {
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
      filters: filters as never,
    });
    return result.map((entry) => entry.pubkey);
  },
};

async function referenceMarkets(mint: string) {
  const selection = await selectReference(
    accountReader,
    gpaReader,
    new PublicKey(mint),
    `getProgramAccounts via ${RPC_URL} (Surfpool fork proxying its mainnet datasource)`
  );
  // The ResolvedReference closure is not JSON; strip it for transport.
  const { chosen, ...rest } = selection;
  return {
    ...rest,
    chosen: chosen
      ? (({ reference: _reference, ...candidate }) => candidate)(chosen)
      : null,
  };
}

/**
 * The setup UI's reference verdict for one mint:
 *  - explicit pool ("pump" or an address) -> authenticate exactly that;
 *  - otherwise `selectReference` (Pump branch, else GPA + rankCandidates).
 * Jupiter's 1 SOL hop is not the default pick.
 */
async function resolveForMint(
  mint: PublicKey,
  pool: string | null
): Promise<{ candidate: MarketCandidate; discovery: string }> {
  const strip = (
    resolved: MarketCandidate & { reference: unknown },
    discovery: string
  ) => {
    const { reference: _reference, ...candidate } = resolved;
    return { candidate, discovery };
  };
  if (pool) {
    return strip(
      await resolveCandidate(
        accountReader,
        mint,
        pool === "pump" ? "pump" : new PublicKey(pool)
      ),
      pool === "pump" ? "Pump venue (derived)" : "explicit pool"
    );
  }
  const selection = await selectReference(
    accountReader,
    gpaReader,
    mint,
    `getProgramAccounts via ${RPC_URL} (Surfpool fork proxying its mainnet datasource)`
  );
  if (!selection.chosen) {
    throw new PolicyError("RESOLVE_FAILED", selection.pickReason);
  }
  return strip(selection.chosen, selection.pickReason);
}

// ---------------------------------------------------------------------------
// One-shot burn through the real QuoteService pipeline
// ---------------------------------------------------------------------------

type BurnRequestBody = {
  launchMint: string;
  legs: { mint: string; bps: number; reference?: string }[];
  amountInLamports: string;
  /** Creator-created per-vault lookup table(s) from the setup/vault UI. */
  lookupTableAddresses?: string[];
};

// ---------------------------------------------------------------------------
// Direct-curve leg support (the own-launch 80% leg).
//
// The program burns a live-curve leg by buying straight off the Pump curve
// (EMPTY route data selects that path); the QuoteService builds those legs
// via its DirectCurveClient. What the service CANNOT do is pay for setup, so
// the demo — playing the caller — provides the two things the harness that
// landed 22/22 own-curve burns provided (fable-ps-repeat-x.mjs setupVault):
//   1. Pump-side accounts the burn must not pay for itself: the vault's
//      user_volume_accumulator (any third party may init it) and the
//      pre-funded `bonding_curve_v2` PDA (rent pre-funded so Pump's lazy
//      creation never debits the vault, which exact conservation 6019
//      would refuse).
//   2. A per-vault address lookup table covering the deterministic burn
//      accounts (leg reference blocks + the 18 Pump buy accounts). Without
//      it those are static keys and a 3-leg burn exceeds 1232 wire bytes.
// ---------------------------------------------------------------------------

const PUMP_FUN_PROGRAM_PK = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** vault (base58) -> the demo-maintained lookup table for its burns. */
const vaultLookupTables = new Map<string, PublicKey>();

async function ensureCurveLegSetup(
  mint: PublicKey,
  vault: PublicKey,
  context: TimingContext,
  legIndex: number
) {
  const sdk = new PumpSdk(connection);
  const accumulator = deriveUserVolumeAccumulator(vault);
  const accumulatorInfo = await connection.getAccountInfo(
    accumulator,
    "confirmed"
  );
  if (!accumulatorInfo || !accumulatorInfo.owner.equals(PUMP_FUN_PROGRAM_PK)) {
    const ix = await sdk.initUserVolumeAccumulator({
      payer: payer.publicKey,
      user: vault,
    });
    await timedPhase(
      context,
      "setup-transaction",
      { setup: "accumulator-init", leg: legIndex },
      () =>
        sendInstructions(
          connection,
          payer,
          "init-vault-accumulator",
          Array.isArray(ix) ? ix : [ix]
        )
    );
  }
  const bondingCurveV2 = deriveBondingCurveV2(mint);
  const bcv2Info = await connection.getAccountInfo(bondingCurveV2, "confirmed");
  if (!bcv2Info || !bcv2Info.owner.equals(PUMP_FUN_PROGRAM_PK)) {
    // Rent pre-fund so Pump's lazy creation of its own PDA never bills the
    // vault; the harness proved this exact recipe (fund-bcv2 + warm buy).
    const rent = await connection.getMinimumBalanceForRentExemption(0);
    if ((bcv2Info?.lamports ?? 0) < rent) {
      await timedPhase(
        context,
        "setup-transaction",
        { setup: "bonding-curve-v2-rent", leg: legIndex },
        () =>
          sendInstructions(connection, payer, "fund-bcv2", [
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: bondingCurveV2,
              lamports: rent - (bcv2Info?.lamports ?? 0),
            }),
          ])
      );
    }
    // Best-effort warm: a tiny raw buy_exact_sol_in by the demo payer makes
    // Pump initialize bonding_curve_v2 now rather than during the burn.
    // Failure is tolerable — the rent pre-fund above already covers the
    // lazy-creation path — and the harness swallowed it identically.
    try {
      const curveInfo = await connection.getAccountInfo(
        derivePumpCurve(mint),
        "confirmed"
      );
      if (!curveInfo) throw new Error("no curve");
      const creator = new PublicKey(curveInfo.data.subarray(49, 81));
      const mintInfo = await connection.getAccountInfo(mint, "confirmed");
      const tokenProgram = mintInfo!.owner;
      const raw = await sdk.getBuyInstructionRaw({
        user: payer.publicKey,
        mint,
        creator,
        amount: new BN(1),
        solAmount: new BN(1_000_000),
        tokenProgram,
      });
      const data = Buffer.alloc(25);
      Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]).copy(data, 0);
      data.writeBigUInt64LE(1_000_000n, 8);
      data.writeBigUInt64LE(1n, 16);
      data[24] = 0;
      const global = sdk.decodeGlobal(
        await connection.getAccountInfo(
          PublicKey.findProgramAddressSync(
            [Buffer.from("global")],
            PUMP_FUN_PROGRAM_PK
          )[0]
        )
      );
      const payerAta = getAssociatedTokenAddressSync(
        mint,
        payer.publicKey,
        true,
        new PublicKey(tokenProgram)
      );
      const ataIx = new TransactionInstruction({
        programId: new PublicKey(
          "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        ),
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: payerAta, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: new PublicKey(tokenProgram),
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from([1]),
      });
      const warm = new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM_PK,
        data,
        keys: [
          ...raw.keys
            .slice(0, 16)
            .map(
              (k: {
                pubkey: PublicKey;
                isSigner: boolean;
                isWritable: boolean;
              }) => ({
                pubkey: k.pubkey,
                isSigner: k.isSigner,
                isWritable: k.isWritable,
              })
            ),
          { pubkey: bondingCurveV2, isSigner: false, isWritable: true },
          {
            pubkey: global.buybackFeeRecipients[0],
            isSigner: false,
            isWritable: true,
          },
        ],
      });
      await timedPhase(
        context,
        "setup-transaction",
        { setup: "bonding-curve-v2-warm-buy", leg: legIndex },
        () => sendInstructions(connection, payer, "warm-bcv2", [ataIx, warm])
      );
    } catch (warmError) {
      console.log(
        `warm-bcv2 skipped: ${String(
          (warmError as Error).message ?? warmError
        ).slice(0, 120)}`
      );
    }
  }
}

/** Create (or extend) the vault's lookup table so it covers `addresses`,
 * then wait until the fork serves the complete, active table. */
async function ensureVaultLookupTable(
  vault: PublicKey,
  addresses: PublicKey[],
  context: TimingContext
): Promise<PublicKey> {
  let table = vaultLookupTables.get(vault.toBase58()) ?? null;
  let existing = new Set<string>();
  if (table) {
    const live = (await connection.getAddressLookupTable(table)).value;
    if (live) {
      existing = new Set(live.state.addresses.map((a) => a.toBase58()));
    } else {
      table = null;
    }
  }
  if (!table) {
    const slot = await connection.getSlot("confirmed");
    const [createIx, tableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot - 1,
      });
    await timedPhase(
      context,
      "setup-transaction",
      { setup: "lookup-table-create", batch: 0 },
      () => sendInstructions(connection, payer, "alt-create", [createIx])
    );
    table = tableAddress;
    vaultLookupTables.set(vault.toBase58(), table);
  }
  const missing = [
    ...new Map(addresses.map((a) => [a.toBase58(), a])).values(),
  ].filter((a) => !existing.has(a.toBase58()));
  for (let i = 0; i < missing.length; i += 18) {
    await timedPhase(
      context,
      "setup-transaction",
      { setup: "lookup-table-extend", batch: i / 18 + 1 },
      () =>
        sendInstructions(connection, payer, "alt-extend", [
          AddressLookupTableProgram.extendLookupTable({
            payer: payer.publicKey,
            authority: payer.publicKey,
            lookupTable: table!,
            addresses: missing.slice(i, i + 18),
          }),
        ])
    );
  }
  if (missing.length) {
    // A lookup table is usable one slot after its last extension.
    await timedPhase(
      context,
      "lookup-table-activation",
      { addressCount: addresses.length },
      async () => {
        const extendedAt = await connection.getSlot("confirmed");
        for (let i = 0; i < 40; i++) {
          const slot = await connection.getSlot("confirmed");
          const live = (await connection.getAddressLookupTable(table!)).value;
          if (
            slot > extendedAt &&
            live &&
            addresses.every((a) =>
              live.state.addresses.some((entry) => entry.equals(a))
            )
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        // Preserve the existing behavior on timeout: the pipeline's live ALT
        // validation remains the authority and will fail closed if the table
        // is still unavailable.
      }
    );
  }
  return table;
}

/**
 * If any leg's bound reference is the live Pump bonding curve, make the
 * vault burnable: Pump-side setup plus the per-vault lookup table. Legs
 * whose reference fails to resolve are left for the pipeline, which reports
 * the precise verdict (REFERENCE_MIGRATING and friends) — this never masks
 * those.
 */
async function prepareDirectCurveSupport(
  request: BurnRequestBody,
  context: TimingContext
): Promise<{ lookupTableAddresses?: string[] }> {
  const legs = request.legs ?? [];
  const resolved = await timedPhase(
    context,
    "setup-reference-resolution",
    { legCount: legs.length },
    async () => {
      const results: (ResolvedReference | null)[] = [];
      for (const [legIndex, leg] of legs.entries()) {
        try {
          results.push(
            await timedPhase(
              context,
              "setup-reference-resolution-leg",
              { leg: legIndex, targetMint: leg.mint },
              () =>
                resolveReference(
                  accountReader,
                  new PublicKey(leg.mint),
                  leg.reference ? new PublicKey(leg.reference) : undefined
                )
            )
          );
        } catch {
          results.push(null);
        }
      }
      return results;
    }
  );
  if (resolved.some((reference) => reference === null)) return {};
  const references = resolved as ResolvedReference[];
  const curveLegIndexes = references.flatMap((reference, index) =>
    reference.venue === DIRECT_CURVE_VENUE ? [index] : []
  );
  if (!curveLegIndexes.length) return {};

  const launchMint = new PublicKey(request.launchMint);
  const vault = deriveVault(
    PROGRAM,
    launchMint,
    legs.map((leg, index) => ({
      targetMint: new PublicKey(leg.mint),
      bps: leg.bps,
      refSeed: references[index].seed,
    }))
  );
  for (const index of curveLegIndexes) {
    await timedPhase(
      context,
      "curve-leg-setup",
      { leg: index, targetMint: legs[index].mint },
      () =>
        ensureCurveLegSetup(
          new PublicKey(legs[index].mint),
          vault,
          context,
          index
        )
    );
  }

  const addresses = new Map<string, PublicKey>();
  const add = (key: PublicKey) => addresses.set(key.toBase58(), key);
  [
    vault,
    getAssociatedTokenAddressSync(WSOL_MINT, vault, true, TOKEN_PROGRAM_ID),
    launchMint,
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
  ].forEach(add);
  for (const [index, leg] of legs.entries()) {
    const mint = new PublicKey(leg.mint);
    const reference = references[index];
    const mintInfo = await connection.getAccountInfo(mint, "confirmed");
    if (!mintInfo) return {};
    const tokenProgram = mintInfo.owner;
    const targetAta = getAssociatedTokenAddressSync(
      mint,
      vault,
      true,
      tokenProgram
    );
    [
      mint,
      targetAta,
      tokenProgram,
      reference.pool,
      reference.vaultA,
      reference.vaultB,
      reference.feeSource,
    ].forEach(add);
    if (reference.venue === DIRECT_CURVE_VENUE) {
      const build = await directCurve.build({
        vault,
        targetMint: mint,
        tokenProgram,
        targetAta,
      });
      for (const account of build.accounts) add(new PublicKey(account.pubkey));
    }
  }
  const table = await timedPhase(
    context,
    "lookup-table-build",
    { addressCount: addresses.size },
    () => ensureVaultLookupTable(vault, [...addresses.values()], context)
  );
  approvedLookupTables.add(table.toBase58());
  return { lookupTableAddresses: [table.toBase58()] };
}

/**
 * DEMO-ONLY diagnosis for Jupiter's "No routes found": a token launched ON
 * THIS FORK can never be routed by mainnet Jupiter, so that refusal is
 * permanent until the program's direct-curve path is available through the
 * service — presenting it as retryable route weather sends the user in
 * circles (observed live 2026-08-26: an own-launch 80% leg looped 4
 * attempts x "No routes found" and the UI said "simply retry"). A mint is
 * fork-only when the fork serves it but the fork's upstream mainnet
 * datasource does not.
 */
const MAINNET_PROBE_RPC =
  process.env.MAINNET_PROBE_RPC ?? "https://api.mainnet-beta.solana.com";
async function forkOnlyMints(mints: string[]): Promise<string[]> {
  try {
    const upstream = new Connection(MAINNET_PROBE_RPC, "confirmed");
    const keys = mints.map((mint) => new PublicKey(mint));
    const onMainnet = await upstream.getMultipleAccountsInfo(keys);
    const missing = mints.filter((_, i) => onMainnet[i] === null);
    if (!missing.length) return [];
    const onFork = await connection.getMultipleAccountsInfo(
      missing.map((mint) => new PublicKey(mint))
    );
    return missing.filter((_, i) => onFork[i] !== null);
  } catch {
    return []; // probe unreachable: fall back to the generic attribution
  }
}

/** Concentrated-liquidity venues whose route ACCOUNTS are a function of the
 * pool's current price (tick/bin arrays). Jupiter selects those accounts
 * from LIVE mainnet state, but a fork executes against pool state frozen at
 * its cache slot — when the two prices sit in different arrays the route
 * fails deterministically inside the venue (e.g. Raydium CLMM 6024
 * InvalidFirstTickArrayAccount) no matter how many fresh quotes are taken.
 * Keyed by program id as attributed in the simulation failure message. */
const TICK_VENUE_BY_PROGRAM: Readonly<Record<string, string>> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
};
const TICK_ERROR_PATTERN =
  /InvalidFirstTickArrayAccount|InvalidTickArraySequence|TickArraySequenceInvalid|InvalidTickArray|BinArray|InvalidTimestamp/i;

/** If `detail` names a tick/bin-array failure inside a concentrated venue
 * that is not yet excluded, exclude that venue for the rest of this request
 * and return its name; otherwise null. */
function excludeStaleTickVenue(detail: string): string | null {
  const attributed =
    /failed inside .+? ([1-9A-HJ-NP-Za-km-z]{32,44}) with ITS error/.exec(
      detail
    );
  const venue = attributed
    ? TICK_VENUE_BY_PROGRAM[attributed[1]]
    : undefined;
  if (!venue || !TICK_ERROR_PATTERN.test(detail)) return null;
  if (jupiter.excludedVenues.has(venue)) return null;
  jupiter.excludedVenues.add(venue);
  return venue;
}

async function executeBurn(request: BurnRequestBody) {
  const startedAt = performance.now();
  const burnId = `demo-${Date.now()}`;
  const jupiterBefore = { ...jupiter.stats };
  // Request-scoped: reroutes decided for one burn must not leak into the
  // next (the demo serves one operator, so no cross-request race in
  // practice).
  jupiter.excludedVenues.clear();
  const timings: Record<string, number> = {};
  let requestTimingLogged = false;
  const finishTimings = () => {
    const result = {
      ...timings,
      totalMs: Number((performance.now() - startedAt).toFixed(1)),
      jupiterCalls: jupiter.stats.calls - jupiterBefore.calls,
      jupiterHttp429: jupiter.stats.http429 - jupiterBefore.http429,
      jupiterNetworkMs: Number(
        (jupiter.stats.networkMs - jupiterBefore.networkMs).toFixed(1)
      ),
      jupiterBackoffMs: jupiter.stats.backoffMs - jupiterBefore.backoffMs,
      jupiterQueueWaitMs: Number(
        (jupiter.stats.queueWaitMs - jupiterBefore.queueWaitMs).toFixed(1)
      ),
    };
    if (!requestTimingLogged) {
      requestTimingLogged = true;
      logStructured({ event: "burn-request-timing", requestId: burnId, ...result });
    }
    return result;
  };
  // Direct-curve legs need caller-funded Pump setup and a lookup table; both
  // are no-ops for pure Jupiter burns.
  const setupStarted = performance.now();
  const curveSupport = await timedPhase(
    { requestId: burnId, burnAttempt: 0 },
    "setup-total",
    {},
    () =>
      prepareDirectCurveSupport(request, {
        requestId: burnId,
        burnAttempt: 0,
      })
  );
  timings.setupMs = Number((performance.now() - setupStarted).toFixed(1));
  let lastExternalDetail: string | null = null;
  for (let attempt = 1; attempt <= MAX_BURN_ATTEMPTS; attempt++) {
    const requestId = `${burnId}-${attempt}`;
    const attemptContext = { requestId, burnAttempt: attempt };
    const attemptStarted = performance.now();
    const attemptJupiterBefore = { ...jupiter.stats };
    let attemptTimingLogged = false;
    const finishAttempt = (outcome: string, reason = "") => {
      if (attemptTimingLogged) return;
      attemptTimingLogged = true;
      const elapsedMs = Number((performance.now() - attemptStarted).toFixed(1));
      timings[`attempt${attempt}Ms`] = elapsedMs;
      logStructured({
        event: "burn-attempt-timing",
        requestId,
        burnAttempt: attempt,
        outcome,
        reason,
        elapsedMs,
        jupiterCalls: jupiter.stats.calls - attemptJupiterBefore.calls,
        jupiterHttp429: jupiter.stats.http429 - attemptJupiterBefore.http429,
        jupiterNetworkMs: Number(
          (jupiter.stats.networkMs - attemptJupiterBefore.networkMs).toFixed(1)
        ),
        jupiterBackoffMs:
          jupiter.stats.backoffMs - attemptJupiterBefore.backoffMs,
        jupiterQueueWaitMs: Number(
          (
            jupiter.stats.queueWaitMs - attemptJupiterBefore.queueWaitMs
          ).toFixed(1)
        ),
      });
    };
    let receipt;
    try {
      receipt = await service.execute({
        requestId,
        launchMint: request.launchMint,
        amountIn: request.amountInLamports,
        legs: (request.legs ?? []).map((leg) => ({
          targetMint: leg.mint,
          bps: leg.bps,
          ...(leg.reference ? { reference: leg.reference } : {}),
        })),
        // The CALLER's per-vault lookup table (created and paid for by the
        // vault's creator in the setup/vault UI, never by this service) plus
        // any demo-side curve-leg table. A multi-leg Jupiter burn cannot fit
        // 1232 bytes without the caller's table; the pipeline accepts it
        // permissionlessly and the program re-validates every account.
        ...(() => {
          const tables = [
            ...(request.lookupTableAddresses ?? []),
            ...(curveSupport.lookupTableAddresses ?? []),
          ];
          return tables.length ? { lookupTableAddresses: tables } : {};
        })(),
      });
    } catch (error) {
      finishAttempt(
        "failed",
        error instanceof PolicyError
          ? error.code
          : String((error as Error).message ?? error).slice(0, 80)
      );
      if (
        error instanceof PolicyError &&
        error.code === "EXTERNAL_SIMULATION_FAILURE"
      ) {
        const detail = error.message;
        // Stale-fork tick-state reroute, MEASURED 2026-08-26: Jupiter picks
        // CLMM tick arrays for LIVE mainnet's price while the fork's pool
        // is frozen at its cached tick, so when the two prices sit in
        // different arrays every fresh quote fails with IDENTICAL values
        // (probed 3x at 7.313 SOL and at 1, 2, 3 SOL: byte-identical
        // "Left: 28200 | Right: 30000" from Raydium CLMM 6024). That is
        // deterministic fork-vs-mainnet divergence, NOT route weather —
        // excluding the venue and re-quoting landed the same request in
        // under a second, so that is the retry, not a same-shape re-quote.
        const rerouted = excludeStaleTickVenue(detail);
        if (rerouted !== null && attempt < MAX_BURN_ATTEMPTS) {
          console.log(
            `burn attempt ${attempt}: stale fork tick state in ${rerouted} — excluding it and re-quoting`
          );
          lastExternalDetail = detail;
          continue;
        }
        if (lastExternalDetail === detail) {
          // A byte-identical failure on a FRESH quote cannot be transient.
          // Stop burning attempts and Jupiter quota on it and say what it
          // actually is.
          return {
            status: "rejected",
            rejectedBy: "external",
            deterministic: true,
            attempts: attempt,
            headline:
              "The identical route failure reproduced on a fresh quote, so it is deterministic — on a fork that means pool state frozen at the fork's cache diverging from live-mainnet quotes, not transient route weather. Retrying the same request will not change it: try a different amount, or restart the fork to re-cache current mainnet state. The vault is untouched.",
            logsTail: [detail.slice(0, 600)],
            timings: finishTimings(),
          };
        }
        lastExternalDetail = detail;
        // NOT a refusal: the innermost failing frame was Jupiter or an AMM
        // (or authorship was unknown) — route weather. A fresh quote is the
        // fix, so retry inside the same attempt budget, and when that is
        // exhausted report it as EXTERNAL with retry advice — never as a
        // service refusal "retrying will not change it". 429 pacing lives
        // inside ForkJupiter now; no extra sleep here.
        console.log(
          `burn attempt ${attempt}: external simulation failure, ${
            attempt < MAX_BURN_ATTEMPTS ? "re-quoting" : "attempts exhausted"
          }: ${error.message.slice(0, 200)}`
        );
        if (attempt < MAX_BURN_ATTEMPTS) {
          continue;
        }
        const author =
          /failed inside (.+?) [1-9A-HJ-NP-Za-km-z]{32,44} with ITS error \d+ \(([^)]+)\)/.exec(
            error.message
          );
        return {
          status: "rejected",
          rejectedBy: "external",
          attempts: MAX_BURN_ATTEMPTS,
          headline: author
            ? `The route kept failing inside ${author[1]} (${author[2]}) across ${MAX_BURN_ATTEMPTS} fresh quotes. Nothing moved — try again in a moment.`
            : `The route kept failing outside the burner across ${MAX_BURN_ATTEMPTS} fresh quotes. Nothing moved — try again in a moment.`,
          logsTail: [`${error.code}: ${error.message}`.slice(0, 600)],
          timings: finishTimings(),
        };
      }
      {
        // The demo runs the pipeline with retryAttempts=0 (free-tier quota),
        // so the two ROUTE-WEATHER burner codes — 6021 (reference-priced
        // floor vs route-priced fill) and 6018 (PumpSwap cashback WSOL
        // kickback) — surface here instead of being re-quoted internally.
        // Retry them in this outer loop exactly as the proven fork harness
        // did (RETRYABLE = {6021, 6018}); when exhausted, report them as
        // BURNER rejections with their code, never as a service refusal.
        const retryableBurner =
          error instanceof PolicyError &&
          error.code === "SIMULATION_FAILED" &&
          /burner-attributed code (6021|6018)/.exec(error.message);
        if (retryableBurner) {
          const code = Number(retryableBurner[1]);
          console.log(
            `burn attempt ${attempt}: burner ${code} (route weather), ${
              attempt < MAX_BURN_ATTEMPTS ? "re-quoting" : "attempts exhausted"
            }`
          );
          if (attempt < MAX_BURN_ATTEMPTS) continue;
          return {
            status: "rejected",
            errorCode: code,
            rejectedBy: "burner",
            attempts: MAX_BURN_ATTEMPTS,
            headline: `The program's price floor refused ${MAX_BURN_ATTEMPTS} fresh quotes (${code}). Nothing moved — try again in a moment, or burn a smaller amount.`,
            logsTail: [`${(error as PolicyError).message}`.slice(0, 600)],
            timings: finishTimings(),
          };
        }
      }
      if (error instanceof PolicyError) {
        if (error.code === "VAULT_BUSY") {
          // NOT a standing refusal: the vault lock clears on its own —
          // seconds after the outstanding burn confirms (the service now
          // settles the lease on confirmation), or within the 180s TTL if
          // that request was abandoned. Presenting it as "retrying will
          // not change it" was wrong (observed live 2026-08-26).
          return {
            status: "rejected",
            rejectedBy: "external",
            headline:
              "Another burn on this vault is still settling. The lock clears seconds after that burn confirms, and expires on its own within 3 minutes if the request was abandoned — retry shortly.",
            logsTail: [`${error.code}: ${error.message}`.slice(0, 600)],
            timings: finishTimings(),
          };
        }
        // The service ANSWERED with a refusal — never present this as an
        // outage; the reason is specific and retrying does not change it.
        return {
          status: "rejected",
          rejectedBy: "service-refused",
          logsTail: [`${error.code}: ${error.message}`.slice(0, 600)],
          timings: finishTimings(),
        };
      }
      // Jupiter cannot route a fork-only mint, ever — do not spin three
      // more attempts or tell the user to retry.
      if (
        /No routes found|TOKEN_NOT_TRADABLE|COULD_NOT_FIND_ANY_ROUTE/i.test(
          String((error as Error).message ?? "")
        )
      ) {
        const forkOnly = await forkOnlyMints([
          request.launchMint,
          ...(request.legs ?? []).map((leg) => leg.mint),
        ]);
        if (forkOnly.length) {
          return {
            status: "rejected",
            rejectedBy: "service-refused",
            logsTail: [
              `NO_ROUTE_FORK_ONLY_MINT: Jupiter has no route for ${forkOnly.join(
                ", "
              )} because that token exists only on this fork — mainnet Jupiter ` +
                `can never route it, so retrying cannot help. A leg bound to a ` +
                `LIVE Pump bonding-curve reference burns via the program's ` +
                `direct-curve path and never asks Jupiter; reaching this error ` +
                `means this leg's bound reference is NOT a live curve (for ` +
                `example a graduated coin awaiting migration), so it must ` +
                `route through Jupiter, which cannot see a fork-only mint. ` +
                `The vault is untouched.`,
            ],
            timings: finishTimings(),
          };
        }
      }
      // Submission preflight failure: attribute it. Burner rejections are
      // deterministic; external ones get a fresh route.
      const logs: string[] = (error as { logs?: string[] }).logs ?? [];
      const attributed = attributeFailure(logs, String(error));
      console.log(
        `burn attempt ${attempt} failed: code ${attributed.code} by ${
          attributed.isBurner ? "burner" : attributed.programId ?? "unknown"
        }: ${String((error as Error).message ?? error).slice(0, 120)}`
      );
      if (!attributed.isBurner && attempt < MAX_BURN_ATTEMPTS) {
        // 429 pacing lives inside ForkJupiter (1.5s-stepped retries,
        // measured sufficient on the free tier 2026-08-26); a 429 that
        // still escapes it will not be fixed by sleeping 25s here.
        continue;
      }
      return {
        status: "rejected",
        stage: "preflight",
        errorCode: attributed.code,
        rejectedBy: attributed.isBurner ? "burner" : "external",
        logsTail: logs.length
          ? logs.slice(-6)
          : [String((error as Error).message ?? error).slice(0, 300)],
        timings: finishTimings(),
      };
    }
    const signature = receipt.submissionId;
    const confirmStarted = performance.now();
    const confirmationBlockhash = await timedPhase(
      attemptContext,
      "confirmation-blockhash",
      {},
      () => connection.getLatestBlockhash("confirmed")
    );
    const confirmed = await timedPhase(
      attemptContext,
      "confirmation",
      {},
      () =>
        connection.confirmTransaction(
          {
            signature,
            blockhash: confirmationBlockhash.blockhash,
            lastValidBlockHeight: receipt.lastValidBlockHeight,
          },
          "confirmed"
        )
    );
    const landed = await timedPhase(
      attemptContext,
      "transaction-fetch",
      {},
      () =>
        connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
    );
    timings.confirmMs = Number(
      (performance.now() - confirmStarted).toFixed(1)
    );
    // The submitted transaction has now settled on chain (landed or failed):
    // release the vault's lease immediately so the next burn on this vault
    // is not refused VAULT_BUSY for the remainder of the 180s TTL.
    await timedPhase(attemptContext, "lease-settle", {}, () =>
      leaseStore.settle(new PublicKey(receipt.vault))
    );
    if (confirmed.value.err || landed?.meta?.err) {
      finishAttempt("landed-failed", "transaction-error");
      const attributed = attributeFailure(
        landed?.meta?.logMessages ?? [],
        landed?.meta?.err
      );
      return {
        status: "rejected",
        signature,
        errorCode: attributed.code,
        rejectedBy: attributed.isBurner ? "burner" : "external",
        logsTail: (landed?.meta?.logMessages ?? []).slice(-6),
        timings: finishTimings(),
      };
    }
    // Per-leg receipts from the program's own burn log lines.
    const legLogs = (landed?.meta?.logMessages ?? [])
      .map((line) =>
        line.match(/^Program log: 0x0, 0x0, 0x0, 0x([0-9a-f]+), 0x([0-9a-f]+)$/)
      )
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({
        amountIn: BigInt(`0x${m[1]}`).toString(),
        burned: BigInt(`0x${m[2]}`).toString(),
      }));
    const vaultAfter = await timedPhase(
      attemptContext,
      "vault-balance-read",
      {},
      () => connection.getBalance(new PublicKey(receipt.vault), "confirmed")
    );
    finishAttempt("burned");
    return {
      status: "burned",
      signature,
      attempts: attempt,
      computeUnits: landed?.meta?.computeUnitsConsumed,
      legs: legLogs.map((log, i) => ({
        mint: request.legs[i]?.mint,
        ...log,
      })),
      vaultAfter: String(vaultAfter),
      ...(jupiter.excludedVenues.size
        ? { reroutedVenues: [...jupiter.excludedVenues] }
        : {}),
      timings: finishTimings(),
    };
  }
  throw new Error("burn attempts exhausted");
}

// ---------------------------------------------------------------------------
// Demo-only loop endpoints (unchanged: they never touch the burner)
// ---------------------------------------------------------------------------

/**
 * A Pump bonding curve completes (graduates) when its real token reserves
 * reach zero, at ~85 SOL of real SOL raised. `realSolReserves` is the u64 at
 * offset 32 of the BondingCurve struct (disc 8, virtual token 8, virtual SOL
 * 8, real token 8, real SOL 8, supply 8, complete@48). Progress toward
 * graduation is that raised amount over the ~85 SOL threshold — the signal
 * the demo shows so a test coin is never walked to completion by surprise.
 */
const GRADUATION_SOL_LAMPORTS = 85_000_000_000n;
/** Stop the demo trade this far below completion, so a single buy can never
 * tip a coin over the edge; the operator keeps a usable test coin. */
const TRADE_SAFETY_STOP_LAMPORTS = 80_000_000_000n;

async function readCurveState(mint: PublicKey): Promise<{
  exists: boolean;
  complete: boolean;
  realSolLamports: string;
  progressPct: number;
  canonicalPool: string;
  poolExists: boolean;
}> {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM_PK
  );
  const info = await connection.getAccountInfo(curve, "confirmed");
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    PUMP_FUN_PROGRAM_PK
  );
  const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const [canonicalPool] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      Buffer.from([0, 0]),
      poolAuthority.toBuffer(),
      mint.toBuffer(),
      WSOL_MINT.toBuffer(),
    ],
    PUMP_AMM
  );
  // The curve PDA must be OWNED by Pump with the full struct — a lamport-
  // dusted System account at that address (observed for $PUMP) is not a curve.
  if (
    !info ||
    !info.owner.equals(PUMP_FUN_PROGRAM_PK) ||
    info.data.length < 49
  ) {
    return {
      exists: false,
      complete: false,
      realSolLamports: "0",
      progressPct: 0,
      canonicalPool: canonicalPool.toBase58(),
      poolExists: false,
    };
  }
  const complete = info.data[48] === 1;
  const realSol = info.data.readBigUInt64LE(32);
  const poolInfo = await connection.getAccountInfo(canonicalPool, "confirmed");
  const poolExists = Boolean(poolInfo && poolInfo.owner.equals(PUMP_AMM));
  const progress = complete
    ? 100
    : Math.min(
        100,
        Number((realSol * 10_000n) / GRADUATION_SOL_LAMPORTS) / 100
      );
  return {
    exists: true,
    complete,
    realSolLamports: realSol.toString(),
    progressPct: Math.round(progress * 10) / 10,
    canonicalPool: canonicalPool.toBase58(),
    poolExists,
  };
}

async function demoTrade(body: { mint: string; solAmounts?: string[] }) {
  const mint = new PublicKey(body.mint);
  const curveState = await readCurveState(mint);
  // A completed curve refuses every buy (Pump 6005 BondingCurveComplete);
  // say so ONCE (the UI disables the button off this flag) with the exact
  // recovery path instead of printing ten 0x1775 failures.
  if (curveState.complete) {
    return {
      buys: [],
      graduated: true,
      progressPct: 100,
      poolExists: curveState.poolExists,
      canonicalPool: curveState.canonicalPool,
    };
  }
  // PREVENT ACCIDENTAL GRADUATION. Default buys are SMALL (1 SOL, not the old
  // 5+10 that walked a fresh curve to completion in ~6 rounds), and the demo
  // refuses to trade once the curve is within the safety band of completion —
  // so a test coin stays usable indefinitely and never graduates by surprise.
  const realSol = BigInt(curveState.realSolLamports);
  if (realSol >= TRADE_SAFETY_STOP_LAMPORTS) {
    return {
      buys: [],
      nearGraduation: true,
      progressPct: curveState.progressPct,
      message:
        `this curve has raised ${(Number(realSol) / 1e9).toFixed(2)} SOL of ` +
        `~85 SOL — trading is paused here so the coin does not graduate out ` +
        `of your test loop. Fund the vault directly (demo) to keep testing ` +
        `burns, or let it graduate and migrate it.`,
    };
  }
  // Demo buy size. Was 5+10 SOL, which walked a fresh curve to graduation in
  // ~6 clicks; then 1 SOL, which was too slow to accrue testable fees. 5 SOL
  // gives ~16 clicks before TRADE_SAFETY_STOP_LAMPORTS (80 of ~85 SOL) pauses
  // trading, so a test coin stays usable while still earning fees quickly.
  // Override per call with solAmounts[], or globally with DEMO_TRADE_LAMPORTS.
  const defaultBuy = process.env.DEMO_TRADE_LAMPORTS ?? "5000000000";
  const amounts = (body.solAmounts ?? [defaultBuy]).map((v) => new BN(v));
  const global = await onlinePump.fetchGlobal();
  const feeConfig = await onlinePump.fetchFeeConfig();
  const done: string[] = [];
  for (const quoteAmount of amounts) {
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
      await onlinePump.fetchBuyState(
        mint,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      );
    const mintState = await getMint(
      connection,
      mint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    await sendInstructions(
      connection,
      payer,
      "demo-buy",
      await PUMP_SDK.buyV2Instructions({
        global,
        feeConfig,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint,
        user: payer.publicKey,
        amount: getBuyTokenAmountFromSolAmount({
          global,
          feeConfig,
          mintSupply: new BN(mintState.supply.toString()),
          bondingCurve,
          amount: quoteAmount,
          quoteMint: NATIVE_MINT,
        }),
        quoteAmount,
        slippage: 2,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      })
    );
    done.push(quoteAmount.toString());
  }
  const after = await readCurveState(mint);
  return {
    buys: done,
    progressPct: after.progressPct,
    realSolLamports: after.realSolLamports,
  };
}

/**
 * Crank Pump's `migrate_v2` for a graduated coin so its canonical PumpSwap
 * pool exists. On mainnet Pump's migrator does this automatically minutes
 * after graduation; a local fork never runs that cron, so a graduated coin's
 * pool never appears and its own-leg burn is blocked (REFERENCE_MIGRATING)
 * forever. migrate_v2 has NO permission constraint on its `user` signer
 * (verified against the live on-chain IDL), so any keeper — here the demo
 * payer — can crank it; the two remaining "boost" accounts are
 * boost_vault = PDA(["boost_vault", pool], PumpAMM) and its classic-SPL WSOL
 * ATA. DEMO-ONLY: this only stands in for the mainnet migrator on the fork.
 */
async function demoMigrate(body: { mint: string }) {
  const mint = new PublicKey(body.mint);
  const state = await readCurveState(mint);
  if (!state.exists) throw new Error("no Pump bonding curve for this mint");
  if (!state.complete) {
    throw new Error(
      "curve has not graduated yet; migration only applies to a completed curve"
    );
  }
  if (state.poolExists) {
    return { pool: state.canonicalPool, alreadyExisted: true };
  }
  const PUMP = PUMP_FUN_PROGRAM_PK;
  const AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const T22 = TOKEN_2022_PROGRAM_ID;
  const TOK = TOKEN_PROGRAM_ID;
  const ATAP = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
  const ata = (o: PublicKey, m: PublicKey, tp: PublicKey) =>
    getAssociatedTokenAddressSync(m, o, true, tp);
  const [global] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP
  );
  const withdrawAuthority = new PublicKey(
    "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
  );
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP
  );
  const [poolAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    PUMP
  );
  const pool = new PublicKey(state.canonicalPool);
  const [ammGlobalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    AMM
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), pool.toBuffer()],
    AMM
  );
  const [pumpAmmEventAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    AMM
  );
  const [eventAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP
  );
  const [boostVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("boost_vault"), pool.toBuffer()],
    AMM
  );
  const boostVaultWsol = ata(boostVault, WSOL_MINT, TOK);
  const keys = (
    [
      [global, 0, 0],
      [withdrawAuthority, 0, 1],
      [mint, 0, 0],
      [WSOL_MINT, 0, 0],
      [curve, 0, 1],
      [ata(curve, mint, T22), 0, 1],
      [ata(curve, WSOL_MINT, TOK), 0, 1],
      [payer.publicKey, 1, 1],
      [SystemProgram.programId, 0, 0],
      [AMM, 0, 0],
      [pool, 0, 1],
      [poolAuth, 0, 1],
      [ata(poolAuth, mint, T22), 0, 1],
      [ata(poolAuth, WSOL_MINT, TOK), 0, 1],
      [ammGlobalConfig, 0, 0],
      [lpMint, 0, 1],
      [ata(poolAuth, lpMint, T22), 0, 1],
      [ata(pool, mint, T22), 0, 1],
      [ata(pool, WSOL_MINT, TOK), 0, 1],
      [T22, 0, 0],
      [TOK, 0, 0],
      [T22, 0, 0],
      [ATAP, 0, 0],
      [pumpAmmEventAuth, 0, 0],
      [RENT, 0, 0],
      [eventAuth, 0, 0],
      [PUMP, 0, 0],
      [boostVault, 0, 1],
      [boostVaultWsol, 0, 1],
    ] as Array<[PublicKey, number, number]>
  ).map(([pubkey, s, w]) => ({
    pubkey,
    isSigner: Boolean(s),
    isWritable: Boolean(w),
  }));
  const ix = new TransactionInstruction({
    programId: PUMP,
    keys,
    data: Buffer.from("bbcb121fceedfe29", "hex"),
  });
  await sendInstructions(connection, payer, "demo-migrate", [ix]);
  const now = await readCurveState(mint);
  return {
    pool: state.canonicalPool,
    alreadyExisted: false,
    poolExists: now.poolExists,
  };
}

async function demoDistribute(body: { mint: string; vault: string }) {
  const mint = new PublicKey(body.mint);
  const vault = new PublicKey(body.vault);
  const before = await connection.getBalance(vault, "confirmed");
  const sharingConfigAddress = feeSharingConfigPda(mint);
  const sharingConfigInfo = await connection.getAccountInfo(
    sharingConfigAddress
  );
  if (!sharingConfigInfo)
    throw new Error("no fee sharing config for this mint");
  const sharingConfig = PUMP_SDK.decodeSharingConfig(sharingConfigInfo);
  await sendInstructions(connection, payer, "demo-distribute", [
    await PUMP_SDK.distributeCreatorFeesV2({
      mint,
      sharingConfig,
      sharingConfigAddress,
      quoteMint: NATIVE_MINT,
      payer: payer.publicKey,
      shouldInitializeAta: true,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  const after = await connection.getBalance(vault, "confirmed");
  return { vaultLamportsDelta: after - before, vaultLamports: after };
}

/**
 * Token name, ticker and image — proxied from Jupiter.
 *
 * Jupiter already curates this for every tradeable mint, including tokens whose
 * on-chain metadata URI is empty (RAY) or points at a gateway that no longer
 * exists (NEIRO -> cf-ipfs.com, shut down). Reading chain metadata and chasing
 * IPFS ourselves reproduced that work badly and could not fix either case.
 *
 * It is proxied rather than called from the browser because Jupiter's token API
 * sends no CORS headers. Server-side there is no such restriction, and this
 * service already sets its own.
 *
 * A fork-only coin is unknown to Jupiter by definition, so the caller falls
 * back to on-chain metadata for those.
 */
/**
 * Point IPFS images at a gateway that still serves bytes.
 *
 * Measured 2026-08-27: WIF's icon is a `<cid>.ipfs.nftstorage.link` subdomain
 * URL that now 302s to an HTML landing page, so the <img> silently fails.
 * FARTCOIN's ipfs.io URL returns 200 image/png. Gateways in frozen metadata
 * rot; only the host is rewritten, never the content id, so this cannot change
 * which bytes are addressed.
 */
const DEAD_IPFS_HOSTS = [
  "nftstorage.link",
  "cf-ipfs.com",
  "cloudflare-ipfs.com",
  "ipfs.infura.io",
];

function normalizeImageUrl(raw: string): string {
  try {
    if (raw.startsWith("ipfs://")) {
      return `https://ipfs.io/ipfs/${raw.slice("ipfs://".length)}`;
    }
    const url = new URL(raw);
    // Subdomain form: <cid>.ipfs.<host>
    const sub = url.hostname.match(/^([a-z0-9]+)\.ipfs\.(.+)$/i);
    if (sub && DEAD_IPFS_HOSTS.some((h) => sub[2].endsWith(h))) {
      return `https://ipfs.io/ipfs/${sub[1]}${url.pathname === "/" ? "" : url.pathname}`;
    }
    // Path form: https://<host>/ipfs/<cid>
    if (DEAD_IPFS_HOSTS.some((h) => url.hostname.endsWith(h))) {
      const m = url.pathname.match(/^\/ipfs\/(.+)$/);
      if (m) return `https://ipfs.io/ipfs/${m[1]}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

async function tokenInfo(mint: string | null) {
  if (!mint) return { error: "mint required" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      { signal: controller.signal }
    );
    if (!res.ok) return { found: false as const };
    const body = (await res.json()) as unknown;
    const first = Array.isArray(body) ? body[0] : body;
    if (!first || typeof first !== "object") return { found: false as const };
    const t = first as { symbol?: string; name?: string; icon?: string };
    return {
      found: true as const,
      symbol: t.symbol ?? null,
      name: t.name ?? null,
      image: t.icon ? normalizeImageUrl(t.icon) : null,
    };
  } catch {
    return { found: false as const };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serve a token's icon bytes through this service.
 *
 * MEASURED 2026-08-27: `ipfs.io` answers 200 to a plain client and **403 to any
 * browser User-Agent** -- it bot-blocks hotlinking. Jupiter hands out ipfs.io
 * URLs for a large share of Pump coins ($PUMP, WIF, FARTCOIN, KET all measured),
 * so those icons can NEVER load from a page, no matter how the <img> is written.
 * Rewriting to another public gateway only moves the problem: gateways rot
 * (nftstorage.link, cf-ipfs.com are already dead) and each has its own blocking.
 *
 * Fetching server-side and re-serving is the only approach that does not depend
 * on a third party's opinion of the caller.
 *
 * Keyed by MINT, never by a caller-supplied URL: the client cannot ask this
 * service to fetch an arbitrary address, so it is not an open proxy / SSRF hole.
 * The URL is whatever Jupiter reported for that mint, and only https is followed.
 */
const imageBytesCache = new Map<string, { body: Buffer; type: string } | null>();
/** Bound the cache: entries are up to 2 MB and mints are unbounded in number. */
const IMAGE_CACHE_MAX = 256;

/**
 * Reject a URL whose host resolves to a private, loopback or link-local address.
 *
 * WHY THIS IS NEEDED, correcting an earlier mistake in this file's design: the
 * endpoint is keyed by MINT rather than by a caller-supplied URL, and that was
 * originally argued to make it "not an open proxy". That reasoning is WRONG.
 * The URL comes from the token's metadata, the metadata is chosen by whoever
 * created the token, and on Pump ANYONE can create a token. So an attacker mints
 * a coin whose icon points at an address of their choosing and then asks this
 * service to fetch it. Mint-keying only adds a step; it does not remove the
 * capability. The fetch target must therefore be validated on its own merits.
 */
async function hostIsPubliclyRoutable(hostname: string): Promise<boolean> {
  const { lookup } = await import("node:dns/promises");
  try {
    const results = await lookup(hostname, { all: true });
    if (!results.length) return false;
    return results.every(({ address, family }) => {
      if (family === 6) {
        const a = address.toLowerCase();
        // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local, and any
        // v4-mapped form is re-checked as v4 below.
        if (a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8")) return false;
        const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (!mapped) return true;
        address = mapped[1];
      }
      const o = address.split(".").map(Number);
      if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false;
      if (o[0] === 10 || o[0] === 127 || o[0] === 0) return false;          // private / loopback / this-host
      if (o[0] === 192 && o[1] === 168) return false;                        // private
      if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;            // private
      if (o[0] === 169 && o[1] === 254) return false;                        // link-local (cloud metadata)
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;           // CGNAT
      if (o[0] >= 224) return false;                                         // multicast / reserved
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Serve a token's icon bytes through this service.
 *
 * MEASURED 2026-08-27: `ipfs.io` answers 200 to a plain client and **403 to any
 * browser User-Agent** -- it bot-blocks hotlinking. Jupiter hands out ipfs.io
 * URLs for a large share of Pump coins ($PUMP, WIF, FARTCOIN, KET all measured),
 * so those icons can NEVER load from a page. Fetching server-side and re-serving
 * is the only approach that does not depend on a third party's opinion of the
 * caller.
 *
 * Redirects are followed MANUALLY (max 2 hops) so every hop is re-validated:
 * `redirect: "follow"` would let an attacker-controlled https URL bounce to
 * http, or to a private address, after the initial check had already passed.
 */
async function tokenImageBytes(
  mint: string | null
): Promise<{ body: Buffer; type: string } | null> {
  if (!mint) return null;
  const hit = imageBytesCache.get(mint);
  if (hit !== undefined) return hit;
  let out: { body: Buffer; type: string } | null = null;
  try {
    const info = await tokenInfo(mint);
    let next = info.found ? info.image : null;
    for (let hop = 0; hop < 3 && next; hop++) {
      const url = new URL(next);
      next = null;
      if (url.protocol !== "https:") break;
      if (!(await hostIsPubliclyRoutable(url.hostname))) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
      clearTimeout(timer);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        // Re-enter the loop so the new host is validated exactly like the first.
        if (location) next = new URL(location, url).toString();
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0 && buf.length <= 2_000_000) out = { body: buf, type };
      }
      break;
    }
  } catch {
    // No icon is a fine outcome; never surface it.
  }
  if (imageBytesCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageBytesCache.keys().next();
    if (!oldest.done) imageBytesCache.delete(oldest.value);
  }
  imageBytesCache.set(mint, out);
  return out;
}

async function demoAirdrop(body: { address: string; lamports?: string }) {
  const to = new PublicKey(body.address);
  const lamports = BigInt(body.lamports ?? "10000000000");
  await sendInstructions(connection, payer, "demo-airdrop", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports,
    }),
  ]);
  return { funded: to.toBase58(), lamports: lamports.toString() };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    const [path, query] = (req.url ?? "/").split("?");
    if (req.method === "GET" && path === "/health") {
      return reply(200, {
        ok: true,
        mode: "demo-keyless",
        slot: await connection.getSlot(),
        program: PROGRAM.toBase58(),
        payer: payer.publicKey.toBase58(),
        // Pacing honesty: NO fixed spacing. Calls are serialized and a 429
        // backs off 1.5s-stepped (up to 5 retries) — measured sufficient on
        // the free tier 2026-08-26 (61-burn harness campaign in ~25min, and
        // probes with 19/39 calls 429ing, all absorbed). A key raises the
        // rate limit further; a multi-leg burn typically lands in seconds.
        jupiter: {
          keyed: Boolean(process.env.JUPITER_API_KEY),
          quoteSpacingMs: 0,
          rateLimitBackoffMs: 1_500,
        },
      });
    }
    if (req.method === "GET" && path === "/reference/markets") {
      const mint = new URLSearchParams(query ?? "").get("mint");
      if (!mint) return reply(400, { error: "mint query parameter required" });
      return reply(200, await referenceMarkets(mint));
    }
    if (req.method === "GET" && path === "/token/image") {
      const got = await tokenImageBytes(
        new URLSearchParams(query ?? "").get("mint")
      );
      if (!got) {
        res.writeHead(404, { "access-control-allow-origin": "*" });
        return res.end();
      }
      res.writeHead(200, {
        "content-type": got.type,
        "content-length": String(got.body.length),
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      });
      return res.end(got.body);
    }
    if (req.method === "GET" && path === "/token") {
      return reply(
        200,
        await tokenInfo(new URLSearchParams(query ?? "").get("mint"))
      );
    }
    if (req.method === "GET" && path === "/demo/curve") {
      const mint = new URLSearchParams(query ?? "").get("mint");
      if (!mint) return reply(400, { error: "mint query parameter required" });
      return reply(200, await readCurveState(new PublicKey(mint)));
    }
    if (req.method === "GET" && path === "/reference/resolve") {
      const params = new URLSearchParams(query ?? "");
      const mint = params.get("mint");
      const pool = params.get("pool");
      if (!mint) return reply(400, { error: "mint query parameter required" });
      try {
        return reply(200, await resolveForMint(new PublicKey(mint), pool));
      } catch (error) {
        return reply(422, {
          // Full sentence, never cut mid-thought: the resolver's verdicts
          // (REFERENCE_MIGRATING above all) are written to be shown whole.
          error: String((error as Error).message ?? error).slice(0, 800),
        });
      }
    }
    if (req.method !== "POST") return reply(404, { error: "not found" });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (path === "/burn") return reply(200, await executeBurn(body));
    if (path === "/demo/airdrop") return reply(200, await demoAirdrop(body));
    if (path === "/demo/trade") return reply(200, await demoTrade(body));
    if (path === "/demo/migrate") return reply(200, await demoMigrate(body));
    if (path === "/demo/distribute")
      return reply(200, await demoDistribute(body));
    return reply(404, { error: "not found" });
  } catch (error) {
    reply(500, {
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        400
      ),
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `keyless demo burn service on http://127.0.0.1:${PORT} -> ${RPC_URL}`
  );
  console.log(
    `program ${PROGRAM.toBase58()}  payer ${payer.publicKey.toBase58()}`
  );
});
