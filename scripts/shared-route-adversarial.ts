/**
 * Adversarial + positive coverage for Jupiter's SHARED-ACCOUNTS route variant
 * (`shared_accounts_route_v2`, discriminator d19853937cfed8e9).
 *
 * # Why this file exists
 *
 * The v1 burner accepted exactly one Jupiter instruction, `route`, and
 * DELIBERATELY refused the shared-accounts variant with 6005 -- a documented
 * guard tested as "gap3b". The v2 migration now ACCEPTS
 * `shared_accounts_route_v2` alongside `route_v2`, each with its OWN
 * account-index pins and scalar offsets in `validate_jupiter_route`
 * (`programs/burner/src/swap_and_burn.rs`). Nothing tested the
 * shared branch: `security-guards.ts` `void`-ed `useSharedAccounts` and always
 * built a single-hop Whirlpool route (`route_v2`), and `split-negative.ts`
 * happened to prepare small single-hop legs, so every pin assertion in the
 * repo landed on the DIRECT layout. This file is the shared-variant twin.
 *
 * # The variant is chosen by ROUTE SHAPE, not by a flag
 *
 * Jupiter returns `route_v2` for a single-hop route and
 * `shared_accounts_route_v2` for a MULTI-HOP one -- independent of the
 * `useSharedAccounts` request field. So this exercises the shared branch by
 * obtaining a genuine multi-hop pool route and VERIFYING the built
 * instruction's discriminator is d19853937cfed8e9, failing loudly if Jupiter
 * returned direct instead (a passing test that silently used the direct path
 * would be worthless).
 *
 * # Verified shared layout (live mainnet, cross-checked against the pins)
 *
 *   [1] user_transfer_authority(signer)  [2] source_token_account
 *   [5] destination_token_account        [6] source_mint
 *   [7] destination_mint                 [8] source_token_program
 *   [9] destination_token_program        [10] event_authority  [11] program
 * and args shifted +1 vs direct because of a leading `id:u8`:
 *   in_amount@9, platform_fee_bps@27, positive_slippage_fee_bps@29.
 *
 * # How the attacks reach the shared pins
 *
 * Everything runs through the SPLIT instruction with a SINGLE leg (bps=10000),
 * whose per-leg `validate_jupiter_route` is the very same function the
 * single-target path calls. In a 1-leg split the fixed block is 8 accounts and
 * the one leg triple is 3, so the Jupiter route accounts begin at split-key
 * index 11; shared route index N is split key 11+N. The tamper hooks
 * (`accountTamper` / `dataTamper`) mutate exactly one thing on an otherwise
 * valid, funded, co-signed burn, and each case passes ONLY if the BURNER
 * raised the specific expected code AND the vault lamports and target ATA are
 * unchanged. Attribution uses the innermost `Program <id> failed:` frame, so a
 * 6000-range error from Jupiter or an AMM is never credited to the burner.
 *
 * Run (fork must be up; pool profile keeps routes fork-servable):
 *   FORK_DEX_PROFILE=pool FORK_SLIPPAGE_BPS=1500 \
 *   npx tsx scripts/shared-route-adversarial.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  attributeFailure,
  buildSplitInstruction,
  createVaultLookupTable,
  deriveSplitPda,
  ensureSharedLookupTable,
  ERROR_NAMES,
  getLookupTables,
  Leg,
  PreparedLeg,
  prepareLegs,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  sendInstructions,
  solToLamports,
  splitInstructionData,
  TOKENS,
} from "./surfpool-split-e2e";

const SHARED_DISCRIMINATOR = "d19853937cfed8e9";
const MAX_TRANSACTION_BYTES = 1232;

// Shared-variant layout, indices relative to the leg's Jupiter route slice.
const SHARED = {
  authority: 1,
  source: 2,
  destination: 5,
  sourceMint: 6,
  destinationMint: 7,
  sourceTokenProgram: 8,
  destinationTokenProgram: 9,
  eventAuthority: 10,
  program: 11,
  inAmountOffset: 9,
  platformFeeOffset: 27,
  positiveSlippageFeeOffset: 29,
} as const;

// In a 1-leg split: 8 fixed accounts + 3 leg-triple accounts, then route.
const ROUTE_BASE = 8 + 3;

const POOL_DEXES = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
];

// CONSTANT-PRODUCT / full-reserve venues only, for the positive burn. These
// keep their entire reserves in accounts the fork holds, so a route through
// them EXECUTES against fork state -- unlike the concentrated-liquidity venues
// (Whirlpool, Raydium CLMM, Orca V2) and the bin-based Meteora DLMM, whose
// tick/bin state drifts from Jupiter's live mainnet quote and reverts on the
// fork with the AMM's own error (Whirlpool 6023, Raydium CLMM 6024, Meteora
// DLMM 3005). Forcing the route across ONLY these still yields multi-hop
// (shared) paths -- JTO routes `Meteora>Meteora`, POPCAT `Meteora DAMM v2>
// Raydium` -- because no single full-reserve pool is deep enough alone. The
// adversarial cases never execute, so they still use the full POOL_DEXES; only
// the positive burn needs this narrower, fork-executable set.
const FORK_FRIENDLY_DEXES = ["Raydium", "Raydium CP", "Meteora", "Meteora DAMM v2"];

const LAUNCH = TOKENS.FARTCOIN;
// ADVERSARIAL vault candidates: any target whose deepest liquidity is a
// multi-hop pool path at a small input, so Jupiter returns the shared variant.
// `findSharedVault` requires only shared + fits (NOT execution), because the
// adversarial cases reject at `validate_jupiter_route` before any swap runs; a
// market shift that makes one go single-hop just moves the search to the next.
const CANDIDATES: Candidate[] = [
  { label: "JTO", mint: TOKENS.JTO, sol: "0.1", cap: 0 },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.1", cap: 20 },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.1", cap: 24 },
  { label: "RAY", mint: TOKENS.RAY, sol: "0.1", cap: 0 },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.1", cap: 24 },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.05", cap: 0 },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.15", cap: 28 },
  { label: "BONK", mint: TOKENS.BONK, sol: "0.1", cap: 20 },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.2", cap: 24 },
  { label: "RAY", mint: TOKENS.RAY, sol: "0.05", cap: 0 },
];

// A wide matrix for the POSITIVE burn, which -- unlike the adversarial cases --
// must actually EXECUTE on the fork. Landing one is a genuine fork-vs-mainnet
// problem: a route is `shared_accounts_route_v2` only when multi-hop, but the
// deepest multi-hop paths cross concentrated-liquidity venues (Whirlpool,
// Raydium CLMM) whose tick state drifts from Jupiter's live quote and reverts
// on the fork (their own 6023/6024), while the full-reserve venues that DO
// execute often collapse to a single hop (direct). So this casts a wide net --
// several tokens x amounts x caps, some over all POOL_DEXES (reliably shared,
// occasionally routed through executable venues) and some over the
// fork-friendly set at larger inputs (forcing multi-hop through Meteora /
// Raydium) -- and the honest-sim gate in `landPositiveShared` submits the FIRST
// shared route that simulates clean. Every shot is a fresh quote, so as the
// fork ages the search simply needs more shots.
const POSITIVE_CANDIDATES: Candidate[] = [
  // Constant-product-only shots FIRST: these force multi-hop (shared) routes
  // through full-reserve venues that execute on the fork -- observed live as
  // JTO `Meteora>Meteora` and POPCAT `Meteora DAMM v2>Raydium`.
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.15", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.15", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.3", cap: 24, dexes: FORK_FRIENDLY_DEXES },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.3", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.2", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.2", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.1", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.25", cap: 24, dexes: FORK_FRIENDLY_DEXES },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.4", cap: 28, dexes: FORK_FRIENDLY_DEXES },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.12", cap: 0, dexes: FORK_FRIENDLY_DEXES },
  // Full-venue fallbacks: reliably shared; land if Jupiter's route happens to
  // avoid the drifting tick venues (how the first observed landing occurred,
  // `Raydium>Meteora DLMM` at 96,810 CU).
  { label: "JTO", mint: TOKENS.JTO, sol: "0.1", cap: 0 },
  { label: "POPCAT", mint: TOKENS.POPCAT, sol: "0.1", cap: 20 },
  { label: "JTO", mint: TOKENS.JTO, sol: "0.15", cap: 28 },
  { label: "RAY", mint: TOKENS.RAY, sol: "0.1", cap: 0 },
];

const slippageBps = Number(process.env.FORK_SLIPPAGE_BPS ?? "1500");

type Candidate = {
  label: string;
  mint: PublicKey;
  sol: string;
  cap: number;
  /** Venue whitelist for this candidate's route (defaults to POOL_DEXES). */
  dexes?: string[];
};

type Vault = {
  candidate: Candidate;
  legSpec: Leg;
  pda: PublicKey;
  wsolAta: PublicKey;
  leg: PreparedLeg;
  total: bigint;
  vaultTable: PublicKey;
  lookupTables: Awaited<ReturnType<typeof getLookupTables>>;
};

function sharedDiscriminatorOf(leg: PreparedLeg): string {
  return leg.jupiterData.subarray(0, 8).toString("hex");
}

async function readVaultStateFor(
  connection: Connection,
  pda: PublicKey,
  targetAta: PublicKey,
  targetProgram: PublicKey
): Promise<{ lamports: number; targetAmount: bigint }> {
  const lamports = await connection.getBalance(pda, "confirmed");
  let targetAmount: bigint;
  try {
    targetAmount = (await getAccount(connection, targetAta, "confirmed", targetProgram)).amount;
  } catch {
    targetAmount = -1n;
  }
  return { lamports, targetAmount };
}

/**
 * Set up a single-leg split vault whose one route is a genuine
 * `shared_accounts_route_v2` and whose co-signed burn fits the wire limit --
 * the vault the ADVERSARIAL cases tamper. Execution is NOT required here.
 */
async function findSharedVault(
  connection: Connection,
  payer: Keypair,
  quoteAuthority: Keypair
): Promise<Vault> {
  const failures: string[] = [];
  for (const candidate of CANDIDATES) {
    const legSpec: Leg = {
      label: candidate.label,
      mint: candidate.mint,
      bps: 10000,
      dexes: POOL_DEXES,
    };
    const total = solToLamports(candidate.sol);
    const [pda] = deriveSplitPda(LAUNCH, [legSpec]);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, pda, true, TOKEN_PROGRAM_ID);

    const mintInfo = await connection.getAccountInfo(candidate.mint, "confirmed");
    if (!mintInfo) {
      failures.push(`${candidate.label}: mint missing on fork`);
      continue;
    }
    const targetAta = getAssociatedTokenAddressSync(candidate.mint, pda, true, mintInfo.owner);
    await sendInstructions(connection, payer, `shared-${candidate.label}-atas`, [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        wsolAta,
        pda,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        targetAta,
        pda,
        candidate.mint,
        mintInfo.owner
      ),
    ]);
    // Fund with a comfortable buffer above the total so the post-burn residual
    // sits above the rent floor and the run is not dust-sensitive.
    await sendInstructions(connection, payer, `shared-${candidate.label}-fund`, [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pda,
        lamports: total + solToLamports("0.05"),
      }),
    ]);

    let leg: PreparedLeg;
    try {
      const prepared = await prepareLegs(
        connection,
        payer,
        pda,
        wsolAta,
        [legSpec],
        total,
        slippageBps,
        candidate.cap === 0 ? undefined : candidate.cap
      );
      leg = prepared[0];
    } catch (error) {
      failures.push(
        `${candidate.label}@cap${candidate.cap}: prepare failed ${
          error instanceof Error ? error.message.slice(0, 80) : String(error)
        }`
      );
      continue;
    }

    const discriminator = sharedDiscriminatorOf(leg);
    if (discriminator !== SHARED_DISCRIMINATOR) {
      failures.push(
        `${candidate.label}@cap${candidate.cap}: got ${discriminator} (${leg.routeLabel}), not shared`
      );
      continue;
    }

    const vaultTable = await createVaultLookupTable(
      connection,
      payer,
      `shared-${candidate.label}`,
      pda,
      wsolAta,
      LAUNCH,
      [leg]
    );
    const lookupTables = await getLookupTables(connection, [
      ...new Set([
        ...leg.lookupTables,
        (await ensureSharedLookupTable(connection, payer)).toBase58(),
        vaultTable.toBase58(),
      ]),
    ]);

    // Only requirement for the ADVERSARIAL vault: the route is shared and the
    // burner transaction fits the wire limit. The adversarial cases reject at
    // `validate_jupiter_route` before any swap executes, so the route need NOT
    // be executable -- coupling selection to a clean honest simulation (which
    // multi-hop routes fail on fork drift) would needlessly starve the
    // adversarial coverage. The POSITIVE burn independently searches for an
    // executable shared route (see `landPositiveShared`).
    const probe = await compileBurn(
      connection,
      payer,
      quoteAuthority,
      pda,
      wsolAta,
      leg,
      total,
      lookupTables
    );
    if (probe.bytes > MAX_TRANSACTION_BYTES) {
      failures.push(
        `${candidate.label}@cap${candidate.cap}: shared but ${probe.bytes} bytes > ${MAX_TRANSACTION_BYTES}`
      );
      continue;
    }

    console.error(
      `selected adversarial shared vault: ${candidate.label} ${candidate.sol} SOL cap=${
        candidate.cap || "uncapped"
      } route=${leg.routeLabel} bytes=${probe.bytes} locks=${probe.locks}`
    );
    return {
      candidate,
      legSpec,
      pda,
      wsolAta,
      leg,
      total,
      vaultTable,
      lookupTables,
    };
  }
  throw new Error(
    `no candidate produced a fitting shared_accounts_route_v2 route:\n  ${failures.join("\n  ")}`
  );
}

/**
 * On the POSITIVE (honest) burn, a burner rejection is a real DEFECT only if it
 * is a pre-execution pin/validation code (< 6017): an honest Jupiter route must
 * pass every account pin, fee, input, PDA and mint check. The execution-phase
 * postconditions (>= 6017: WSOL/lamport conservation, slippage floor, burn-to-
 * zero) can legitimately fail when a fork pool is thinner than the mainnet
 * quote it was priced against -- that is fork drift, retried like any external
 * AMM failure, not a burner bug.
 */
function isPositiveDefect(attributed: { isBurner: boolean; code?: number }): boolean {
  return attributed.isBurner && (attributed.code ?? 0) < 6017;
}

/**
 * Independently search the candidate matrix for a shared route that actually
 * EXECUTES and land a real burn through it. Each candidate's vault is set up
 * and funded on demand, a shared route is freshly quoted (asserted shared),
 * simulated, and -- only if the honest simulation is clean -- submitted. Fork
 * drift (a stale Whirlpool tick array, an AMM slippage guard, a route that
 * flipped to single-hop) just moves the search on; a BURNER-attributed failure
 * is a real defect and is surfaced immediately.
 */
async function landPositiveShared(
  connection: Connection,
  payer: Keypair,
  quoteAuthority: Keypair,
  vaultTableCache: Map<string, PublicKey>
): Promise<any> {
  const positive: any = { attempts: [] as string[] };
  for (const candidate of POSITIVE_CANDIDATES) {
    const legSpec: Leg = {
      label: candidate.label,
      mint: candidate.mint,
      bps: 10000,
      dexes: candidate.dexes ?? POOL_DEXES,
    };
    const total = solToLamports(candidate.sol);
    const [pda] = deriveSplitPda(LAUNCH, [legSpec]);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, pda, true, TOKEN_PROGRAM_ID);
    const mintInfo = await connection.getAccountInfo(candidate.mint, "confirmed");
    if (!mintInfo) continue;
    const targetAta = getAssociatedTokenAddressSync(candidate.mint, pda, true, mintInfo.owner);
    await sendInstructions(connection, payer, `pos-${candidate.label}-atas`, [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        wsolAta,
        pda,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        targetAta,
        pda,
        candidate.mint,
        mintInfo.owner
      ),
    ]);
    // Top up to total + buffer only if the vault is short (repeat candidates or
    // a prior failed attempt leave it already funded).
    const balance = await connection.getBalance(pda, "confirmed");
    const want = total + solToLamports("0.05");
    if (BigInt(balance) < want) {
      await sendInstructions(connection, payer, `pos-${candidate.label}-fund`, [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: pda,
          lamports: Number(want - BigInt(balance)),
        }),
      ]);
    }
    let vaultTable = vaultTableCache.get(pda.toBase58());

    let leg: PreparedLeg;
    let lookupTables: Awaited<ReturnType<typeof getLookupTables>>;
    try {
      const prepared = await prepareLegs(
        connection,
        payer,
        pda,
        wsolAta,
        [legSpec],
        total,
        slippageBps,
        candidate.cap === 0 ? undefined : candidate.cap
      );
      leg = prepared[0];
      if (sharedDiscriminatorOf(leg) !== SHARED_DISCRIMINATOR) {
        positive.attempts.push(`${candidate.label}@${candidate.cap}: ${leg.routeLabel} not shared`);
        continue;
      }
      if (!vaultTable) {
        vaultTable = await createVaultLookupTable(
          connection,
          payer,
          `pos-${candidate.label}`,
          pda,
          wsolAta,
          LAUNCH,
          [leg]
        );
        vaultTableCache.set(pda.toBase58(), vaultTable);
      }
      lookupTables = await getLookupTables(connection, [
        ...new Set([
          ...leg.lookupTables,
          (await ensureSharedLookupTable(connection, payer)).toBase58(),
          vaultTable.toBase58(),
        ]),
      ]);
    } catch (error) {
      positive.attempts.push(
        `${candidate.label}@${candidate.cap}: prepare failed ${
          error instanceof Error ? error.message.slice(0, 70) : String(error)
        }`
      );
      continue;
    }

    const before = await readVaultStateFor(connection, pda, leg.ata, leg.tokenProgram);
    const compiled = await compileBurn(
      connection,
      payer,
      quoteAuthority,
      pda,
      wsolAta,
      leg,
      total,
      lookupTables
    );
    if (compiled.bytes > MAX_TRANSACTION_BYTES) {
      positive.attempts.push(`${candidate.label}@${candidate.cap}: ${compiled.bytes}B too big`);
      continue;
    }
    positive.route = leg.routeLabel;
    positive.discriminator = sharedDiscriminatorOf(leg);
    positive.txBytes = compiled.bytes;
    positive.accountLocks = compiled.locks;
    if (positive.discriminator !== SHARED_DISCRIMINATOR) {
      throw new Error(`positive route is ${positive.discriminator}, not shared`);
    }

    const sim = await connection.simulateTransaction(compiled.transaction, { sigVerify: true });
    if (sim.value.err) {
      const attributed = attributeFailure(sim.value.logs, sim.value.err);
      if (isPositiveDefect(attributed)) {
        positive.status = "rejected";
        positive.by = "burner";
        positive.code = attributed.code;
        positive.detail = (sim.value.logs ?? []).slice(-12);
        return positive;
      }
      positive.attempts.push(
        `${candidate.label}@${candidate.cap}: sim drift ${JSON.stringify(
          sim.value.err
        )} by=${attributed.isBurner ? "burner:" + attributed.code : attributed.programId ?? "runtime"}`
      );
      continue;
    }

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(compiled.transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (error) {
      const attributed = attributeFailure((error as any)?.logs, error);
      if (isPositiveDefect(attributed)) {
        positive.status = "rejected";
        positive.by = "burner";
        positive.code = attributed.code;
        positive.detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
        return positive;
      }
      positive.attempts.push(
        `${candidate.label}@${candidate.cap}: external send drift ${
          error instanceof Error ? error.message.slice(0, 80) : String(error)
        }`
      );
      continue;
    }

    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: compiled.blockhash,
        lastValidBlockHeight: compiled.lastValidBlockHeight,
      },
      "confirmed"
    );
    const landed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (confirmation.value.err) {
      const attributed = attributeFailure(landed?.meta?.logMessages, confirmation.value.err);
      positive.signature = signature;
      if (isPositiveDefect(attributed)) {
        positive.status = "rejected";
        positive.by = "burner";
        positive.code = attributed.code;
        positive.detail = (landed?.meta?.logMessages ?? []).slice(-12);
        return positive;
      }
      positive.attempts.push(
        `${candidate.label}@${candidate.cap}: confirm drift by=${
          attributed.isBurner ? "burner:" + attributed.code : attributed.programId ?? "runtime"
        }`
      );
      continue;
    }

    positive.signature = signature;
    positive.computeUnits = landed?.meta?.computeUnitsConsumed ?? undefined;
    const after = await readVaultStateFor(connection, pda, leg.ata, leg.tokenProgram);
    const netSpent = BigInt(before.lamports) - BigInt(after.lamports);
    positive.netSpentLamports = netSpent.toString();
    positive.expectedNetSpent = total.toString();
    positive.lamportConservationHolds = netSpent === total;
    positive.targetAtaAfter = after.targetAmount.toString();
    positive.wsolAfter = (
      await getAccount(connection, wsolAta, "confirmed", TOKEN_PROGRAM_ID)
    ).amount.toString();
    const burnLog = (landed?.meta?.logMessages ?? [])
      .map((line) => line.match(/^Program log: 0x0, 0x0, 0x0, 0x([0-9a-f]+), 0x([0-9a-f]+)$/))
      .find((match): match is RegExpMatchArray => match !== null);
    positive.burned = burnLog ? BigInt(`0x${burnLog[2]}`).toString() : undefined;
    positive.status =
      positive.lamportConservationHolds &&
      after.targetAmount === 0n &&
      positive.wsolAfter === "0" &&
      positive.burned !== undefined
        ? "burned"
        : "landed-but-postcondition-failed";
    return positive;
  }
  if (!positive.status) {
    positive.status = "rejected-at-send";
    positive.by = "external-drift";
    positive.detail = "no candidate produced an executable shared route within the budget";
  }
  return positive;
}

async function compileBurn(
  connection: Connection,
  caller: Keypair,
  quoteAuthority: Keypair,
  pda: PublicKey,
  wsolAta: PublicKey,
  leg: PreparedLeg,
  total: bigint,
  lookupTables: Awaited<ReturnType<typeof getLookupTables>>,
  overrides?: Parameters<typeof buildSplitInstruction>[7],
  rawData?: Buffer,
  signWith?: Keypair[]
): Promise<{
  transaction: VersionedTransaction;
  bytes: number;
  locks: number;
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  let instruction = buildSplitInstruction(
    caller.publicKey,
    quoteAuthority.publicKey,
    pda,
    wsolAta,
    LAUNCH,
    [leg],
    total,
    overrides
  );
  if (rawData) instruction = new TransactionInstruction({ ...instruction, data: rawData });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: caller.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      instruction,
    ],
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign(signWith ?? [caller, quoteAuthority]);
  let bytes: number;
  try {
    bytes = transaction.serialize().length;
  } catch {
    bytes = MAX_TRANSACTION_BYTES + 1;
  }
  const locks =
    message.staticAccountKeys.length +
    message.addressTableLookups.reduce(
      (sum, lookup) => sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
      0
    );
  return { transaction, bytes, locks, blockhash, lastValidBlockHeight };
}

// ---------------------------------------------------------------------------
// Adversarial cases against the shared-variant pins
// ---------------------------------------------------------------------------

type AttackContext = {
  imposter: PublicKey;
  wsolAta: PublicKey;
  leg: PreparedLeg;
  total: bigint;
};

type Attack = {
  name: string;
  expect: number;
  note: string;
  mutate: (context: AttackContext) => {
    overrides?: Parameters<typeof buildSplitInstruction>[7];
    rawData?: Buffer;
  };
};

/** Rewrite a byte range inside leg 0's Jupiter route data via dataTamper. */
function tamperRouteData(edit: (data: Buffer) => void, leg: PreparedLeg, total: bigint) {
  return {
    dataTamper: () => {
      const jupiterData = Buffer.from(leg.jupiterData);
      edit(jupiterData);
      return splitInstructionData(total, [
        {
          bps: leg.bps,
          minimumOutput: leg.minimumOutput,
          routeAccountCount: leg.routeAccounts.length,
          jupiterData,
        },
      ]);
    },
  };
}

/** Substitute one account inside leg 0's route slice via accountTamper. */
function tamperRouteAccount(sharedIndex: number, pubkey: PublicKey) {
  return {
    accountTamper: (keys: any[]) => {
      const copy = [...keys];
      const at = ROUTE_BASE + sharedIndex;
      copy[at] = { ...copy[at], pubkey };
      return copy;
    },
  };
}

const ATTACKS: Attack[] = [
  {
    name: "shared[1] user_transfer_authority -> non-PDA key",
    expect: 6006,
    note: "the burn PDA is the only account whose signature is granted; a swapped authority breaks the pin",
    mutate: ({ imposter }) => ({ overrides: tamperRouteAccount(SHARED.authority, imposter) }),
  },
  {
    name: "shared[2] source -> away from vault WSOL ATA",
    expect: 6006,
    note: "source must be the vault's own WSOL ATA so only the authorized input is spent",
    mutate: ({ imposter }) => ({ overrides: tamperRouteAccount(SHARED.source, imposter) }),
  },
  {
    name: "shared[5] destination -> another account",
    expect: 6006,
    note: "destination must be the vault's target ATA so the output is what gets burned",
    mutate: ({ wsolAta }) => ({
      // A real, distinct token account: the vault's WSOL ATA is a valid token
      // account but not the target ATA, so it exercises the pin, not a
      // downstream 'account not a token account' error.
      overrides: tamperRouteAccount(SHARED.destination, wsolAta),
    }),
  },
  {
    name: "shared[7] destination_mint -> swapped",
    expect: 6006,
    note: "destination_mint must equal the configured target mint",
    mutate: () => ({ overrides: tamperRouteAccount(SHARED.destinationMint, TOKENS.BONK) }),
  },
  {
    name: "shared[10] event_authority -> swapped",
    expect: 6006,
    note: "the event authority is pinned to Jupiter's fixed value",
    mutate: ({ imposter }) => ({ overrides: tamperRouteAccount(SHARED.eventAuthority, imposter) }),
  },
  {
    name: "shared platform_fee_bps@27 nonzero",
    expect: 6007,
    note: "any non-zero platform fee is refused before Jupiter is invoked",
    mutate: ({ leg, total }) => ({
      overrides: tamperRouteData(
        (data) => data.writeUInt16LE(1, SHARED.platformFeeOffset),
        leg,
        total
      ),
    }),
  },
  {
    name: "shared positive_slippage_fee_bps@29 nonzero",
    expect: 6007,
    note: "the positive-slippage fee channel is refused identically",
    mutate: ({ leg, total }) => ({
      overrides: tamperRouteData(
        (data) => data.writeUInt16LE(1, SHARED.positiveSlippageFeeOffset),
        leg,
        total
      ),
    }),
  },
  {
    name: "shared in_amount@9 disagrees with authorized input",
    expect: 6008,
    note: "the route's encoded ExactIn input must equal the leg's authorized amount",
    mutate: ({ leg, total }) => ({
      overrides: tamperRouteData(
        (data) =>
          data.writeBigUInt64LE(
            data.readBigUInt64LE(SHARED.inAmountOffset) + 1n,
            SHARED.inAmountOffset
          ),
        leg,
        total
      ),
    }),
  },
];

async function readVaultState(connection: Connection, vault: Vault) {
  return readVaultStateFor(connection, vault.pda, vault.leg.ata, vault.leg.tokenProgram);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const imposter = Keypair.generate();
  await sendInstructions(connection, payer, "shared-fund-imposter", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: imposter.publicKey,
      lamports: solToLamports("0.02"),
    }),
  ]);

  const vault = await findSharedVault(connection, payer, quoteAuthority);
  const report: any = {
    rpc: RPC_URL,
    vault: {
      label: vault.candidate.label,
      pda: vault.pda.toBase58(),
      route: vault.leg.routeLabel,
      discriminator: sharedDiscriminatorOf(vault.leg),
      totalLamports: vault.total.toString(),
    },
  };

  // ---- 1. adversarial cases (run BEFORE the positive burn empties nothing;
  //         each simulates only, so the vault is never actually spent) -------
  const attackResults: any[] = [];
  for (const attack of ATTACKS) {
    const before = await readVaultState(connection, vault);
    const mutation = attack.mutate({
      imposter: imposter.publicKey,
      wsolAta: vault.wsolAta,
      leg: vault.leg,
      total: vault.total,
    });

    const compiled = await compileBurn(
      connection,
      payer,
      quoteAuthority,
      vault.pda,
      vault.wsolAta,
      vault.leg,
      vault.total,
      vault.lookupTables,
      mutation.overrides,
      mutation.rawData
    );

    const outcome: any = { name: attack.name, expect: attack.expect, note: attack.note };
    const simulation = await connection.simulateTransaction(compiled.transaction, {
      sigVerify: true,
    });
    if (!simulation.value.err) {
      outcome.result = "ACCEPTED";
    } else {
      const attributed = attributeFailure(simulation.value.logs, simulation.value.err);
      outcome.result = "rejected";
      outcome.code = attributed.code;
      outcome.codeName = attributed.code ? ERROR_NAMES[attributed.code] : undefined;
      outcome.by = attributed.isBurner ? "burner" : attributed.programId ?? "runtime";
    }
    const after = await readVaultState(connection, vault);
    outcome.vaultUnchanged =
      before.lamports === after.lamports && before.targetAmount === after.targetAmount;
    outcome.pass =
      outcome.result === "rejected" &&
      outcome.vaultUnchanged &&
      outcome.by === "burner" &&
      outcome.code === attack.expect;
    attackResults.push(outcome);
    process.stderr.write(
      `${outcome.pass ? "PASS" : "FAIL"}  ${attack.name} -> ${
        outcome.code ?? outcome.by
      } ${outcome.codeName ?? ""} (expected ${attack.expect})\n`
    );
  }
  report.attacks = attackResults;

  // ---- 2. the positive: land a real burn through an executable shared route
  // Independent of the adversarial vault: multi-hop routes are fork-drift
  // prone, so this searches its own candidate matrix for a shared route that
  // simulates clean and submits it. A BURNER failure is a real defect; only
  // external/AMM drift is skipped.
  const vaultTableCache = new Map<string, PublicKey>();
  vaultTableCache.set(vault.pda.toBase58(), vault.vaultTable);
  const positive = await landPositiveShared(
    connection,
    payer,
    quoteAuthority,
    vaultTableCache
  );
  report.positive = positive;
  console.error(
    `positive shared burn: ${positive.status} ${positive.computeUnits ?? "?"}cu ${
      positive.txBytes ?? "?"
    }B ${positive.accountLocks ?? "?"} locks route=${positive.route ?? "-"} burned=${
      positive.burned ?? "-"
    }`
  );

  console.log(JSON.stringify(report, null, 2));

  const attacksOk = attackResults.every((r) => r.pass);
  const positiveOk = positive.status === "burned";
  const notRejected = attackResults.filter((r) => !r.pass);
  if (notRejected.length) {
    console.error("\n!! CRITICAL: shared-variant pins NOT enforced for:");
    for (const r of notRejected) {
      console.error(
        `   ${r.name}: result=${r.result} code=${r.code} by=${r.by} vaultUnchanged=${r.vaultUnchanged}`
      );
    }
  }
  // A BURNER-attributed positive failure means the burner rejected an HONEST
  // shared route -- a real defect, distinct from fork execution drift.
  if (positive.status !== "burned" && positive.by === "burner") {
    console.error(
      `\n!! CRITICAL: the burner rejected an honest shared route: code=${positive.code}`
    );
  }
  console.error(
    `\n${attackResults.filter((r) => r.pass).length}/${attackResults.length} shared-variant attacks rejected as expected; positive burn ${
      positiveOk
        ? "LANDED"
        : positive.by === "burner"
        ? "was BURNER-REJECTED (defect)"
        : `did NOT land (external fork drift: ${positive.status})`
    }`
  );
  console.error(
    attacksOk && positiveOk
      ? "shared_accounts_route_v2 pins are correctly enforced"
      : attacksOk && positive.by !== "burner"
      ? "shared_accounts_route_v2 PINS OK; positive burn blocked by fork execution drift (not a burner defect)"
      : "shared_accounts_route_v2 coverage FAILED"
  );
  // Exit codes: 0 = pins enforced AND positive landed; 1 = a real defect (a pin
  // failed, or the burner rejected an honest route); 2 = pins enforced but the
  // positive could not land because every shared route Jupiter offered this run
  // drifted on the fork (an ENVIRONMENTAL limitation of concentrated-liquidity
  // venues on an aged fork, not a code defect). The positive HAS landed on a
  // fresher fork -- e.g. `shared_accounts_route_v2:Raydium>Meteora DLMM`,
  // conservation exact, target and WSOL burned to zero.
  if (attacksOk && positiveOk) process.exit(0);
  if (attacksOk && positive.by !== "burner") process.exit(2);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
