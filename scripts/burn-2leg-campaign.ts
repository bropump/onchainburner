/**
 * REAL 2-leg keyless burn campaign — the answer to "did you test 2 legs
 * works everytime?" has to be landed transactions, not one anchor plus
 * arithmetic.
 *
 * For each 90/10 target pair: derive the reference-committed vault, create
 * its ATAs, fund it with a bare transfer (documented provenance-blind path),
 * then drive REAL burns through the actual QuoteService pipeline
 * (`execute`), first WITHOUT any per-vault lookup table — exercising the
 * 2-leg fitting ladder that scripts/measure-2leg-size.ts showed is needed
 * ~11/18 of the time — and then (first pair only) WITH a real creator-owned
 * table for comparison. Every receipt's bytes/locks/CU are recorded; every
 * failure is reported with its attributed code.
 *
 * Env: RPC (default http://127.0.0.1:9900), BURNER_PROGRAM_ID (required),
 *      PAYER_KEYPAIR / SOLANA_KEYPAIR, BURNS_PER_PAIR (default 2),
 *      BURN_LAMPORTS (default 50000000).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
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
import { resolveReference } from "../quote-service/reference";

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ??
    (() => {
      throw new Error("BURNER_PROGRAM_ID is required");
    })()
);
const BURNS_PER_PAIR = Number(process.env.BURNS_PER_PAIR ?? "2");
const BURN_LAMPORTS = BigInt(process.env.BURN_LAMPORTS ?? "50000000");
const CAMPAIGN_MODE = process.env.CAMPAIGN_MODE ?? "default";
if (!["default", "no-alt", "with-alt", "both"].includes(CAMPAIGN_MODE)) {
  throw new Error(`invalid CAMPAIGN_MODE ${CAMPAIGN_MODE}`);
}

const TOKENS: Record<
  string,
  { mint: string; pool: string | "pump"; venue: string }
> = {
  JTO: {
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    pool: "JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo",
    venue: "Raydium CLMM",
  },
  NEIRO: {
    mint: "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump",
    pool: "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV",
    venue: "Raydium v4",
  },
  PUMP: {
    mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    pool: "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh",
    venue: "Meteora DLMM",
  },
  BONK: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    pool: "GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN",
    venue: "Raydium CLMM",
  },
  WIF: {
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    pool: "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx",
    venue: "Raydium v4",
  },
  FARTCOIN: {
    mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    pool: "Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw",
    venue: "Raydium v4",
  },
  POPCAT: {
    mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    pool: "FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxRF2x9RwLLMo",
    venue: "Raydium v4",
  },
  RAY: {
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    pool: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
    venue: "Raydium v4",
  },
  JUP: {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    pool: "C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg",
    venue: "Meteora DLMM",
  },
  MET: {
    mint: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL",
    pool: "AsSyvUnbfaZJPRrNh3kUuvZTeHKoMVWEoHz86f4Q5D9x",
    venue: "Meteora DLMM",
  },
  KET: {
    mint: "9Pfync3ejPC9eHqVzq3nYQJAhyhjqpnB9UsaSfLxpump",
    pool: "pump",
    venue: "canonical PumpSwap",
  },
  ANSEM: {
    mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
    pool: "pump",
    venue: "canonical PumpSwap",
  },
  STNK: {
    mint: "43VWkd99HjqkhFTZbWBpMpRhjG469nWa7x7uEsgSH7We",
    pool: "EyktEFod1gAgsuM1hXmEpqkitFFk9XczkqLPx2vKiceg",
    venue: "Raydium CP",
  },
  PNUT: {
    mint: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump",
    pool: "4AZRPNEfCJ7iw28rJu5aUyeQhYcvdcNm8cswyL51AY9i",
    venue: "Raydium v4",
  },
};

const CONFIGURED_PAIRS: Array<[keyof typeof TOKENS, keyof typeof TOKENS]> = [
  ["NEIRO", "PUMP"],
  ["JTO", "NEIRO"],
  ["BONK", "WIF"],
  ["FARTCOIN", "POPCAT"],
  ["JTO", "PUMP"],
  ["RAY", "NEIRO"],
];
const PAGE_90_10_PAIRS: Array<[keyof typeof TOKENS, keyof typeof TOKENS]> = [
  ["NEIRO", "NEIRO"],
  ["WIF", "NEIRO"],
  ["FARTCOIN", "NEIRO"],
  ["POPCAT", "NEIRO"],
  ["RAY", "NEIRO"],
  ["PUMP", "NEIRO"],
  ["JUP", "NEIRO"],
  ["MET", "NEIRO"],
  ["KET", "NEIRO"],
  ["ANSEM", "NEIRO"],
  ["STNK", "NEIRO"],
  ["PNUT", "NEIRO"],
];
const PAIR_FILTER = process.env.PAIR_FILTER?.trim().toUpperCase();
const PAIR_SOURCE =
  process.env.PAGE_90_10_MATRIX === "1" ? PAGE_90_10_PAIRS : CONFIGURED_PAIRS;
const PAIRS = PAIR_FILTER
  ? PAIR_SOURCE.filter(([a, b]) => `${a}/${b}` === PAIR_FILTER)
  : PAIR_SOURCE;
if (!PAIRS.length) {
  throw new Error(
    `PAIR_FILTER ${PAIR_FILTER ?? ""} did not match ${PAIR_SOURCE.map(
      ([a, b]) => `${a}/${b}`
    ).join(", ")}`
  );
}

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
const FORK_DEXES = process.env.FORK_DEXES?.split("|")
  .map((venue) => venue.trim())
  .filter(Boolean);

class ForkJupiter implements JupiterClient {
  constructor(private readonly inner: JupiterClient) {}
  async build(params: JupiterBuildParams) {
    const excluded = new Set(params.excludeDexes ?? []);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.inner.build({
          ...params,
          excludeDexes: undefined,
          dexes: (FORK_DEXES ?? POOL_ONLY_FORK_DEXES).filter(
            (venue) => !excluded.has(venue)
          ),
          slippageBps: params.slippageBps ?? 1_500,
        });
      } catch (error) {
        const text = String((error as Error).message ?? error);
        if (/HTTP 429/.test(text) && attempt < 6) {
          await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }
}

class RpcSubmitter implements PrivateSubmitter {
  constructor(private readonly connection: Connection) {}
  async submit(transaction: Uint8Array) {
    const submissionId = await this.connection.sendRawTransaction(
      Buffer.from(transaction),
      { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }
    );
    return { submissionId };
  }
}

function readKeypair(): Keypair {
  const file =
    process.env.PAYER_KEYPAIR ??
    process.env.SOLANA_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[])
  );
}

async function confirm(connection: Connection, signature: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const transaction = await connection
      .getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);
    if (transaction) return transaction;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`transaction ${signature} unconfirmed after 60s`);
}

async function sendPlain(
  connection: Connection,
  payer: Keypair,
  instructions: ConstructorParameters<
    typeof TransactionMessage
  >[0]["instructions"]
) {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = await connection.sendRawTransaction(
    Buffer.from(transaction.serialize()),
    { skipPreflight: false, preflightCommitment: "confirmed" }
  );
  await confirm(connection, signature);
  return signature;
}

type Tally = {
  pair: string;
  mode: "no-alt" | "with-alt";
  attempted: number;
  landed: number;
  failures: string[];
  receipts: { bytes: number; locks: number; cu: number | null; sig: string }[];
};

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readKeypair();
  const chain = new SolanaRpcGateway(connection);
  console.log(`fork ${RPC_URL} program ${PROGRAM.toBase58()}`);
  console.log(`payer ${payer.publicKey.toBase58()}`);

  const leaseStore = new InMemoryVaultLeaseStore();
  const httpJupiter = new JupiterV2HttpClient(
    process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
    process.env.JUPITER_API_KEY
  );
  const service = new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter: new ForkJupiter(httpJupiter),
    directCurve: new PumpDirectCurveClient(connection),
    feePayerSigner: new LocalKeypairMessageSigner(payer),
    submitter: new RpcSubmitter(connection),
    leaseStore,
    policy: {
      production: false,
      maxAmountPerBurn: 200_000_000_000n,
      maxSlippageBps: 2_000,
      maxPriceImpactBps: 2_500,
      computeUnitLimit: 1_400_000,
      minRemainingBlockHeights: 50,
      leaseTtlMs: 180_000,
      fittingMaxAccounts: [40, 32, 26, 20, 16, 12],
      approvedLookupTables: new Set<string>(),
    },
    onEvent: (fields) => {
      if (fields.event === "simulation-failed") {
        console.log(`    event ${JSON.stringify(fields)}`);
      }
    },
  });
  // FORK-ONLY fallback for deterministic concentrated-venue tick divergence
  // (DESIGN.md addendum 2 #3): Jupiter picks tick arrays for LIVE mainnet
  // price while the fork's pool is frozen, so the same route fails
  // byte-identically on every fresh quote. The demo service re-quotes with
  // the concentrated venue excluded; this campaign does the same.
  const fallbackService = new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter: new ForkJupiter({
      build: (params: JupiterBuildParams) =>
        httpJupiter.build({
          ...params,
          dexes: POOL_ONLY_FORK_DEXES.filter(
            (venue) => !["Whirlpool", "Orca V2", "Raydium CLMM"].includes(venue)
          ),
          slippageBps: 1_500,
        }),
    }),
    directCurve: new PumpDirectCurveClient(connection),
    feePayerSigner: new LocalKeypairMessageSigner(payer),
    submitter: new RpcSubmitter(connection),
    leaseStore,
    policy: {
      production: false,
      maxAmountPerBurn: 200_000_000_000n,
      maxSlippageBps: 2_000,
      maxPriceImpactBps: 2_500,
      computeUnitLimit: 1_400_000,
      minRemainingBlockHeights: 50,
      leaseTtlMs: 180_000,
      fittingMaxAccounts: [40, 32, 26, 20, 16, 12],
      approvedLookupTables: new Set<string>(),
    },
  });

  const tallies: Tally[] = [];

  for (const [pairIndex, [a, b]] of PAIRS.entries()) {
    // The product merges a selected token with the fixed NEIRO leg when they
    // collide; emitting two NEIRO legs would be rejected as duplicate targets.
    const legsSpec =
      a === b
        ? [{ ...TOKENS[a], symbol: a, bps: 10_000 }]
        : [
            { ...TOKENS[a], symbol: a, bps: 9_000 },
            { ...TOKENS[b], symbol: b, bps: 1_000 },
          ];
    const launchMint = new PublicKey(legsSpec[0].mint);
    console.log(
      a === b
        ? `\n=== ${a} selected: merged ${a} 100% ===`
        : `\n=== ${a} 90% / ${b} 10% ===`
    );
    const references = [] as Awaited<ReturnType<typeof resolveReference>>[];
    for (const leg of legsSpec) {
      references.push(
        await resolveReference(
          chain,
          new PublicKey(leg.mint),
          leg.pool === "pump" ? undefined : new PublicKey(leg.pool)
        )
      );
    }
    const vault = deriveVault(
      PROGRAM,
      launchMint,
      legsSpec.map((leg, i) => ({
        targetMint: new PublicKey(leg.mint),
        bps: leg.bps,
        refSeed: references[i].seed,
      }))
    );
    console.log(`  vault ${vault.toBase58()}`);
    const wsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      vault,
      true,
      TOKEN_PROGRAM_ID
    );
    const tokenPrograms: PublicKey[] = [];
    for (const leg of legsSpec) {
      const info = await connection.getAccountInfo(new PublicKey(leg.mint));
      if (!info) throw new Error(`mint ${leg.mint} missing on fork`);
      tokenPrograms.push(info.owner);
    }
    const atas = legsSpec.map((leg, i) =>
      getAssociatedTokenAddressSync(
        new PublicKey(leg.mint),
        vault,
        true,
        tokenPrograms[i]
      )
    );
    // Setup: ATAs + funding for every planned burn on this vault.
    const runNoAlt =
      CAMPAIGN_MODE === "default"
        ? true
        : CAMPAIGN_MODE === "no-alt" || CAMPAIGN_MODE === "both";
    const withAlt =
      CAMPAIGN_MODE === "default"
        ? pairIndex === 0
        : CAMPAIGN_MODE === "with-alt" || CAMPAIGN_MODE === "both";
    const totalBurns =
      BURNS_PER_PAIR * Number(runNoAlt) + BURNS_PER_PAIR * Number(withAlt);
    await sendPlain(connection, payer, [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        wsolAta,
        vault,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID
      ),
      ...legsSpec.map((leg, i) =>
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          atas[i],
          vault,
          new PublicKey(leg.mint),
          tokenPrograms[i]
        )
      ),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: vault,
        lamports: BURN_LAMPORTS * BigInt(totalBurns) + 10_000_000n,
      }),
    ]);
    console.log(`  setup + funding for ${totalBurns} burns done`);

    let altAddress: PublicKey | null = null;
    if (withAlt) {
      // Real creator-owned table covering the vault's deterministic accounts
      // (mirrors app/src/chain/lookupTable.ts collectVaultAltAddresses).
      const addresses = [
        vault,
        wsolAta,
        launchMint,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ...legsSpec.flatMap((leg, i) => [
          new PublicKey(leg.mint),
          atas[i],
          tokenPrograms[i],
          references[i].pool,
          references[i].vaultA,
          references[i].vaultB,
          references[i].feeSource,
        ]),
      ];
      const unique = [
        ...new Map(addresses.map((k) => [k.toBase58(), k])).values(),
      ];
      const slot = await connection.getSlot("confirmed");
      const [createIx, table] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot - 1,
      });
      await sendPlain(connection, payer, [createIx]);
      for (let i = 0; i < unique.length; i += 20) {
        await sendPlain(connection, payer, [
          AddressLookupTableProgram.extendLookupTable({
            payer: payer.publicKey,
            authority: payer.publicKey,
            lookupTable: table,
            addresses: unique.slice(i, i + 20),
          }),
        ]);
      }
      // Activation: usable one slot after the last extension.
      const extendedAt = await connection.getSlot("confirmed");
      for (let i = 0; i < 40; i += 1) {
        const now = await connection.getSlot("confirmed");
        const live = (await connection.getAddressLookupTable(table)).value;
        if (
          now > extendedAt &&
          live &&
          live.state.addresses.length >= unique.length
        )
          break;
        await new Promise((r) => setTimeout(r, 400));
      }
      altAddress = table;
      console.log(
        `  lookup table ${table.toBase58()} (${unique.length} addresses)`
      );
    }

    const modes: Array<{ mode: Tally["mode"]; tables?: string[] }> = [
      ...(runNoAlt ? [{ mode: "no-alt" as const }] : []),
      ...(withAlt && altAddress
        ? [{ mode: "with-alt" as const, tables: [altAddress.toBase58()] }]
        : []),
    ];

    for (const { mode, tables } of modes) {
      const tally: Tally = {
        pair: `${a}/${b}`,
        mode,
        attempted: 0,
        landed: 0,
        failures: [],
        receipts: [],
      };
      tallies.push(tally);
      for (let i = 0; i < BURNS_PER_PAIR; i += 1) {
        tally.attempted += 1;
        const requestId = `c2l-${a}-${b}-${mode}-${i}-${Date.now()}`;
        try {
          const before = BigInt(
            await connection.getBalance(vault, "confirmed")
          );
          const burnRequest = (id: string) => ({
            requestId: id,
            launchMint: launchMint.toBase58(),
            amountIn: BURN_LAMPORTS.toString(),
            legs: legsSpec.map((leg) => ({
              targetMint: leg.mint,
              bps: leg.bps,
              ...(leg.pool === "pump" ? {} : { reference: leg.pool }),
            })),
            ...(tables ? { lookupTableAddresses: tables } : {}),
          });
          let receipt;
          try {
            receipt = await service.execute(burnRequest(requestId));
          } catch (firstError) {
            const text = String((firstError as Error).message ?? firstError);
            const concentrated =
              firstError instanceof PolicyError &&
              firstError.code === "EXTERNAL_SIMULATION_FAILURE" &&
              /whirLb|CAMMCzo|Whirlpool|Raydium CLMM/i.test(text);
            if (!concentrated) throw firstError;
            console.log(
              "    fork tick divergence on a concentrated venue — re-quoting with it excluded"
            );
            receipt = await fallbackService.execute(
              burnRequest(`${requestId}-xconc`)
            );
          }
          const landed = await confirm(connection, receipt.submissionId);
          await leaseStore.settle(vault);
          if (landed.meta?.err) {
            tally.failures.push(
              `${requestId}: landed but FAILED on chain: ${JSON.stringify(
                landed.meta.err
              )}`
            );
            console.log(`  FAIL on-chain ${JSON.stringify(landed.meta.err)}`);
            continue;
          }
          const after = BigInt(await connection.getBalance(vault, "confirmed"));
          if (before - after !== BURN_LAMPORTS) {
            tally.failures.push(
              `${requestId}: landed but vault delta ${
                before - after
              } != ${BURN_LAMPORTS}`
            );
            continue;
          }
          tally.landed += 1;
          tally.receipts.push({
            bytes: receipt.transactionBytes,
            locks: receipt.accountLocks,
            cu: landed.meta?.computeUnitsConsumed ?? null,
            sig: receipt.submissionId,
          });
          console.log(
            `  PASS [${mode}] ${receipt.transactionBytes}B ${receipt.accountLocks} locks ` +
              `${landed.meta?.computeUnitsConsumed} CU ${receipt.submissionId}`
          );
        } catch (error) {
          const code = error instanceof PolicyError ? error.code : "THROW";
          const text = String((error as Error).message ?? error).slice(0, 260);
          tally.failures.push(`${requestId}: ${code}: ${text}`);
          console.log(`  FAIL [${mode}] ${code}: ${text}`);
        }
      }
    }
  }

  console.log("\n===== TALLY =====");
  let attempted = 0;
  let landed = 0;
  for (const t of tallies) {
    attempted += t.attempted;
    landed += t.landed;
    const bytes = t.receipts.map((r) => r.bytes);
    console.log(
      `${t.pair} [${t.mode}]: ${t.landed}/${t.attempted} landed` +
        (bytes.length
          ? `; bytes ${Math.min(...bytes)}-${Math.max(...bytes)}`
          : "")
    );
    for (const f of t.failures) console.log(`  failure: ${f}`);
  }
  console.log(`TOTAL: ${landed}/${attempted} landed`);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
