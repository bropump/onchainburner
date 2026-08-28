/**
 * Regression proof for the RT4 fix: with the reference pool manipulated into
 * the attacker-owned dust shape (gross 5000 SOL / ~dust tokens), the SERVICE
 * must refuse to build the burn (REFERENCE_DOES_NOT_PRICE_MARKET) instead of
 * handing the caller a transaction that would legally extract ~100% of the
 * leg. Fork-only; loopback refused otherwise.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
  QuoteService,
} from "../quote-service/core";
import {
  JupiterV2HttpClient,
  SolanaRpcGateway,
} from "../quote-service/adapters";
import { resolveReference } from "../quote-service/reference";

const RPC_URL = process.env.RPC ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(process.env.BURNER_PROGRAM_ID ?? "");
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const NEIRO_V4_POOL = new PublicKey(
  "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV"
);
const SOL = 1_000_000_000n;

const c = new Connection(RPC_URL, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        process.env.PAYER_KEYPAIR ??
          path.join(os.homedir(), ".config", "solana", "id.json"),
        "utf8"
      ) as number[]
    )
  )
);
const chain = new SolanaRpcGateway(c);

async function setVaultAmount(vault: PublicKey, amount: bigint) {
  const ai = await c.getAccountInfo(vault);
  if (!ai) throw new Error(`no account at ${vault.toBase58()}`);
  const data = Buffer.from(ai.data);
  data.writeBigUInt64LE(amount, 64);
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        vault.toBase58(),
        {
          lamports: ai.lamports,
          owner: ai.owner.toBase58(),
          data: data.toString("hex"),
          executable: ai.executable,
        },
      ],
    }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`setAccount failed: ${JSON.stringify(j.error)}`);
}

async function main() {
  const ref = await resolveReference(chain, NEIRO, NEIRO_V4_POOL);
  const legs = [{ targetMint: NEIRO, bps: 10_000, refSeed: ref.seed }];
  const vault = deriveVault(PROGRAM, NEIRO, legs);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  const targetAta = getAssociatedTokenAddressSync(NEIRO, vault, true, TOKEN_PROGRAM_ID);
  const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, targetAta, vault, NEIRO, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 2n * SOL }),
    ],
  }).compileToV0Message();
  const setup = new VersionedTransaction(msg);
  setup.sign([payer]);
  await c.sendRawTransaction(setup.serialize(), { skipPreflight: false });
  console.log(`vault ${vault.toBase58()} funded (reference ${ref.venue}, honest depth ${Number(ref.depthLamports) / 1e9} SOL)`);

  const service = new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter: new JupiterV2HttpClient(
      process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
      process.env.JUPITER_API_KEY
    ),
    submitter: { submit: async () => ({ submissionId: "unused" }) },
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
  });

  const request = {
    requestId: `rt4-fix-${Date.now()}`,
    launchMint: NEIRO.toBase58(),
    amountIn: "500000000",
    legs: [{ targetMint: NEIRO.toBase58(), bps: 10_000, reference: NEIRO_V4_POOL.toBase58() }],
  };

  // 1. honest state: the service builds the burn.
  await service.prepare(request, payer.publicKey);
  console.log("PASS honest state: service builds the burn");

  // 2. attacker-owned dust shape: gross 5000 SOL / 100k atoms NEIRO.
  const poolData = await c.getAccountInfo(ref.pool)!;
  const d = Buffer.from(poolData!.data);
  const vaultA = new PublicKey(d.subarray(336, 368));
  const vaultB = new PublicKey(d.subarray(368, 400));
  const aIsSol = Buffer.from((await c.getAccountInfo(vaultA))!.data)
    .subarray(0, 32)
    .equals(NATIVE_MINT.toBuffer());
  await setVaultAmount(aIsSol ? vaultA : vaultB, 5_000n * SOL);
  await setVaultAmount(aIsSol ? vaultB : vaultA, 100_000n);
  const hostile = await resolveReference(chain, NEIRO, NEIRO_V4_POOL);
  console.log(`manipulated: depth ${Number(hostile.depthLamports) / 1e9} SOL, floor(0.5 SOL)=${hostile.floorFor(500_000_000n)} atoms`);

  try {
    await service.prepare(
      { ...request, requestId: `rt4-fix-hostile-${Date.now()}` },
      payer.publicKey
    );
    console.log("FAIL: service BUILT a burn against the hostile reference");
    process.exit(1);
  } catch (e: any) {
    const msg2 = String(e.message ?? e);
    if (msg2.includes("the bound reference prices this leg at")) {
      console.log("PASS hostile state: service refuses (REFERENCE_DOES_NOT_PRICE_MARKET)");
    } else {
      console.log(`refused with unexpected error: ${msg2.slice(0, 200)}`);
      process.exit(1);
    }
  }
}
main().catch((e) => { console.error(`FAIL: ${e.message ?? e}`); process.exit(1); });
