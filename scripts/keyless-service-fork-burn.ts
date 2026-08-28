/**
 * KEYLESS quote-service fork proof: drives the REAL QuoteService pipeline
 * (reference resolution, program-floor mirror, 7-account keyless layout,
 * single-signer transaction, submission) against a running Surfpool fork
 * with the keyless program deployed, and lands REAL burns.
 *
 * Two burns, covering both service paths:
 *   1. one-shot `execute` — the keeper shape: service pays, signs, submits;
 *   2. `prepare` -> local caller signature -> `assertSubmittableSignedTransaction`
 *      -> raw submission — the caller-paid shape the app uses.
 *
 * The vault is funded with a bare SystemProgram.transfer. That is the
 * documented, program-equivalent funding path (the vault is provenance
 * blind); the REAL Pump creator-fee chain (create_v2 -> fee share ->
 * distributeCreatorFeesV2 -> burn) is covered separately by
 * prototypes/switchboard-stateless-surfpool/fable-ps-*.mjs. This script is
 * therefore a SERVICE-pipeline proof, not a Pump integration test.
 *
 * Refuses to run against anything but a loopback RPC.
 *
 * Env:
 *   RPC                 fork RPC url            (default http://127.0.0.1:8899)
 *   BURNER_PROGRAM_ID   deployed keyless program (REQUIRED)
 *   PAYER_KEYPAIR       fee payer json           (default ~/.config/solana/id.json)
 *   TARGET_MINT         leg mint                (default NEIRO)
 *   TARGET_REFERENCE    bound reference pool    (default NEIRO Raydium v4 pool)
 *   LAUNCH_MINT         namespace mint          (default TARGET_MINT)
 *   BURN_LAMPORTS       per-burn input          (default 50_000_000)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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
  assertSubmittableSignedTransaction,
  deriveVault,
  InMemoryVaultLeaseStore,
  JupiterBuildParams,
  JupiterClient,
  PrivateSubmitter,
  QuoteService,
} from "../quote-service/core";
import {
  JupiterV2HttpClient,
  LocalKeypairMessageSigner,
  SolanaRpcGateway,
} from "../quote-service/adapters";
import { resolveReference } from "../quote-service/reference";

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:8899";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ??
    (() => {
      throw new Error(
        "BURNER_PROGRAM_ID is required (the deployed keyless program)"
      );
    })()
);
const NEIRO = "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump";
const NEIRO_POOL = "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV";
const TARGET_MINT = new PublicKey(process.env.TARGET_MINT ?? NEIRO);
const TARGET_REFERENCE = new PublicKey(
  process.env.TARGET_REFERENCE ?? NEIRO_POOL
);
const LAUNCH_MINT = new PublicKey(process.env.LAUNCH_MINT ?? TARGET_MINT);
const BURN_LAMPORTS = BigInt(process.env.BURN_LAMPORTS ?? "50000000");

/** Fork-only route shaping: pool venues a fork can serve, fixed slippage. */
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

class ForkJupiter implements JupiterClient {
  constructor(private readonly inner: JupiterClient) {}
  async build(params: JupiterBuildParams) {
    const excluded = new Set(params.excludeDexes ?? []);
    return this.inner.build({
      ...params,
      excludeDexes: undefined,
      dexes: POOL_ONLY_FORK_DEXES.filter((venue) => !excluded.has(venue)),
      slippageBps: params.slippageBps ?? 1_500,
    });
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

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readKeypair();
  const chain = new SolanaRpcGateway(connection);
  console.log(`fork ${RPC_URL} program ${PROGRAM.toBase58()}`);
  console.log(`payer ${payer.publicKey.toBase58()}`);

  // Resolve the leg's reference exactly as the service will, and derive the
  // reference-committed vault address.
  const reference = await resolveReference(
    chain,
    TARGET_MINT,
    TARGET_REFERENCE
  );
  console.log(
    `reference ${reference.pool.toBase58()} (${reference.venue}), cap ${
      reference.capLamports
    } lamports`
  );
  const legs = [
    { targetMint: TARGET_MINT, bps: 10_000, refSeed: reference.seed },
  ];
  const vault = deriveVault(PROGRAM, LAUNCH_MINT, legs);
  console.log(`vault ${vault.toBase58()}`);

  // Setup: vault ATAs (payer-funded, idempotent) + funding transfers for two
  // burns. A bare transfer is the documented provenance-blind funding path.
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetAta = getAssociatedTokenAddressSync(
    TARGET_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );
  await sendPlain(connection, payer, [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      wsolAta,
      vault,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      targetAta,
      vault,
      TARGET_MINT,
      TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: vault,
      lamports: BURN_LAMPORTS * 2n,
    }),
  ]);
  console.log(`setup complete; vault funded with ${BURN_LAMPORTS * 2n}`);

  const service = new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter: new ForkJupiter(
      new JupiterV2HttpClient(
        process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
        process.env.JUPITER_API_KEY
      )
    ),
    feePayerSigner: new LocalKeypairMessageSigner(payer),
    submitter: new RpcSubmitter(connection),
    leaseStore: new InMemoryVaultLeaseStore(),
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
    onEvent: (fields) => console.log(`  event ${JSON.stringify(fields)}`),
  });

  const request = (requestId: string) => ({
    requestId,
    launchMint: LAUNCH_MINT.toBase58(),
    amountIn: BURN_LAMPORTS.toString(),
    legs: [
      {
        targetMint: TARGET_MINT.toBase58(),
        bps: 10_000,
        reference: TARGET_REFERENCE.toBase58(),
      },
    ],
  });

  const vaultBefore = BigInt(await connection.getBalance(vault, "confirmed"));

  // ---- burn 1: one-shot keeper path (execute) -----------------------------
  const receipt = await service.execute(request(`fork-exec-${Date.now()}`));
  const executed = await confirm(connection, receipt.submissionId);
  if (executed.meta?.err) {
    throw new Error(
      `execute burn landed but FAILED on chain: ${JSON.stringify(
        executed.meta.err
      )}`
    );
  }
  console.log(
    `PASS execute burn ${receipt.submissionId} — ${executed.meta?.computeUnitsConsumed} CU, minOut ${receipt.minimumOutputs[0]}`
  );

  // ---- burn 2: caller-paid path (prepare -> sign -> gate -> submit) -------
  const prepared = await service.prepare(
    request(`fork-prep-${Date.now()}`),
    payer.publicKey
  );
  prepared.transaction.sign([payer]);
  const wire = Buffer.from(prepared.transaction.serialize());
  const gate = assertSubmittableSignedTransaction(wire, PROGRAM);
  if (gate.messageSha256 !== prepared.messageSha256) {
    throw new Error("submission gate digest differs from preparation digest");
  }
  const signature = await connection.sendRawTransaction(wire, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const landed = await confirm(connection, signature);
  if (landed.meta?.err) {
    throw new Error(
      `prepared burn landed but FAILED on chain: ${JSON.stringify(
        landed.meta.err
      )}`
    );
  }
  console.log(
    `PASS prepared burn ${signature} — ${landed.meta?.computeUnitsConsumed} CU, minOut ${prepared.minimumOutputs[0]}`
  );

  // The program's 6019 postcondition is an exact equality, so across two
  // burns the vault must have emitted exactly the two authorized inputs.
  const vaultAfter = BigInt(await connection.getBalance(vault, "confirmed"));
  const spent = vaultBefore - vaultAfter;
  console.log(
    `vault ${vaultBefore} -> ${vaultAfter} (burn input consumed: ${spent}; expected ${
      BURN_LAMPORTS * 2n
    })`
  );
  if (spent !== BURN_LAMPORTS * 2n) {
    throw new Error("vault lamport delta does not equal the two burn inputs");
  }
  console.log("PASS keyless service fork proof: 2/2 burns landed");
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
