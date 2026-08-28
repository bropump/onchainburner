/**
 * Follow-up red-team campaign (loopback fork only).
 *
 *   rt4-venues   dust-shape floor vs live Jupiter quote on v4 / CLMM / DLMM
 *   floor-matrix Mode A floor / Jupiter quote for every shipped reference
 *   cross-leg    swapped reference seeds derive a different PDA (6012)
 *   rt8          Mode B 0x01 refused at dispatch
 *   mode-a       honest Mode A still admits a bound NEIRO v4 vault
 *   donation     extra tokens in the target ATA vs a non-target ATA
 *   all          run every section
 *
 * Env: RPC (loopback), BURNER_PROGRAM_ID, PAYER_KEYPAIR, FORK_DEX_PROFILE=pool
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveVault } from "../quote-service/core";
import { SolanaRpcGateway, JupiterV2HttpClient } from "../quote-service/adapters";
import { resolveReference } from "../quote-service/reference";
import { KNOWN_REFERENCE_POOLS } from "../quote-service/markets";

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ?? "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV"
);
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const JTO = new PublicKey("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL");
const NEIRO_V4 = new PublicKey("HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV");
const JTO_CLMM = new PublicKey("JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo");
const VALIDATE_CONFIG = Buffer.from([28, 98, 92, 82, 243, 62, 65, 93]);
const SOL = 1_000_000_000n;
const AMOUNT = 50_000_000n; // 0.05 SOL — Mode A probe size

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
const jupiter = new JupiterV2HttpClient(
  process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
  process.env.JUPITER_API_KEY
);

let failed = 0;
function pass(name: string, detail: string) {
  console.log(`PASS  ${name}  ${detail}`);
}
function fail(name: string, detail: string) {
  failed += 1;
  console.log(`FAIL  ${name}  ${detail}`);
}

/** Parse a burner custom code from preflight logs or confirmed InstructionError JSON. */
function burnerCodeFrom(err: unknown): number | undefined {
  const msg = String((err as any)?.message ?? err);
  const hex = msg.match(/custom program error: (0x[0-9a-f]+)/i);
  if (hex) return parseInt(hex[1], 16);
  const custom = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (custom) return Number(custom[1]);
  return undefined;
}

async function sendPlain(instructions: TransactionInstruction[]) {
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...instructions,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  // skipPreflight: the point of these tests is on-chain behavior, not sim.
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 40; i++) {
    const landed = await c
      .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (landed) {
      if (landed.meta?.err) {
        const logs = (landed.meta.logMessages ?? []).join("\n");
        throw new Error(`sendPlain failed: ${JSON.stringify(landed.meta.err)}\n${logs}`);
      }
      return landed;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`unconfirmed ${sig}`);
}

async function setVaultAmount(vault: PublicKey, amount: bigint) {
  const ai = await c.getAccountInfo(vault);
  if (!ai) throw new Error(`no account ${vault.toBase58()}`);
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
  if (j.error) throw new Error(`setAccount: ${JSON.stringify(j.error)}`);
}

function vaultsOf(data: Buffer, va: number, vb: number) {
  return [new PublicKey(data.subarray(va, va + 32)), new PublicKey(data.subarray(vb, vb + 32))];
}

async function whichIsToken(vaults: PublicKey[], mint: PublicKey) {
  const out: { sol: PublicKey; tok: PublicKey } = {
    sol: vaults[0],
    tok: vaults[1],
  };
  for (const v of vaults) {
    const ai = await c.getAccountInfo(v);
    if (!ai) continue;
    const m = new PublicKey(ai.data.subarray(0, 32));
    if (m.equals(NATIVE_MINT)) out.sol = v;
    if (m.equals(mint)) out.tok = v;
  }
  return out;
}

async function jupiterOut(mint: PublicKey, amount: bigint): Promise<bigint | null> {
  try {
    const dest = getAssociatedTokenAddressSync(
      mint,
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    const build = await jupiter.build({
      inputMint: NATIVE_MINT,
      outputMint: mint,
      amount,
      taker: payer.publicKey,
      destinationTokenAccount: dest,
      slippageBps: 100,
      dexes: ["Raydium", "Raydium CLMM", "Raydium CP", "Meteora DLMM", "Whirlpool"],
    } as any);
    return BigInt(build.outAmount);
  } catch (e: any) {
    console.log(`  jupiter quote miss: ${String(e.message ?? e).slice(0, 120)}`);
    return null;
  }
}

async function rt4Venue(name: string, mint: PublicKey, pool: PublicKey, va: number, vb: number) {
  console.log(`\n== RT4 dust-shape ${name} ${pool.toBase58().slice(0, 8)}… ==`);
  const honest = await resolveReference(chain, mint, pool);
  const quoted = await jupiterOut(mint, AMOUNT);
  const honestFloor = honest.floorFor(AMOUNT);
  if (quoted !== null) {
    const ratio = Number(honestFloor) / Number(quoted);
    if (quoted / 2n > honestFloor) {
      fail(`${name} honest`, `floor ${honestFloor} < half quote ${quoted} (ratio ${ratio.toFixed(3)})`);
    } else {
      pass(`${name} honest`, `floor ${honestFloor} vs quote ${quoted} (ratio ${ratio.toFixed(3)})`);
    }
  } else {
    pass(`${name} honest floor`, `${honestFloor} (no Jupiter quote this run)`);
  }

  const info = await c.getAccountInfo(pool);
  if (!info) {
    fail(`${name} dust`, "pool missing on fork");
    return;
  }
  const [v0, v1] = vaultsOf(Buffer.from(info.data), va, vb);
  const sides = await whichIsToken([v0, v1], mint);
  const tokBefore = Buffer.from((await c.getAccountInfo(sides.tok))!.data).readBigUInt64LE(64);
  await setVaultAmount(sides.tok, 8_000_000n);
  try {
    const dusty = await resolveReference(chain, mint, pool);
    const dustFloor = dusty.floorFor(AMOUNT);
    if (quoted !== null && quoted / 2n > dustFloor) {
      pass(
        `${name} dust`,
        `floor collapsed to ${dustFloor}; live quote ${quoted} — service would refuse REFERENCE_DOES_NOT_PRICE_MARKET`
      );
    } else if (quoted === null && dustFloor < honestFloor / 2n) {
      pass(`${name} dust floor`, `collapsed ${honestFloor} -> ${dustFloor}`);
    } else if (dustFloor === honestFloor) {
      pass(
        `${name} dust floor`,
        `UNCHANGED at ${dustFloor} — this venue prices from pool state, not vault reserves`
      );
    } else {
      fail(
        `${name} dust`,
        `floor ${dustFloor} (honest ${honestFloor}) quote ${quoted}`
      );
    }
  } catch (e: any) {
    pass(`${name} dust`, `resolver refused: ${String(e.message ?? e).slice(0, 160)}`);
  } finally {
    await setVaultAmount(sides.tok, tokBefore);
  }
}

async function floorMatrix() {
  console.log("\n== Mainnet floor vs Jupiter quote (0.05 SOL) ==");
  console.log("mint                              venue        floor            quote            floor/quote");
  for (const [mintStr, poolStr] of Object.entries(KNOWN_REFERENCE_POOLS)) {
    const mint = new PublicKey(mintStr);
    const pool = new PublicKey(poolStr);
    try {
      const ref = await resolveReference(chain, mint, pool);
      const floor = ref.floorFor(AMOUNT);
      const quoted = await jupiterOut(mint, AMOUNT);
      const ratio = quoted !== null ? Number(floor) / Number(quoted) : NaN;
      const row = `${mintStr.slice(0, 12).padEnd(12)}  ${String(ref.venue).padEnd(12)}  ${String(floor).padStart(16)}  ${String(quoted ?? "-").padStart(16)}  ${Number.isFinite(ratio) ? ratio.toFixed(3) : "-"}`;
      console.log(row);
      if (quoted !== null && quoted / 2n > floor) {
        fail(`floor-matrix ${mintStr.slice(0, 8)}`, `floor ${floor} < half quote ${quoted}`);
      } else if (quoted !== null) {
        pass(`floor-matrix ${mintStr.slice(0, 8)}`, `ratio ${ratio.toFixed(3)}`);
      }
    } catch (e: any) {
      fail(`floor-matrix ${mintStr.slice(0, 8)}`, String(e.message ?? e).slice(0, 160));
    }
  }
}

async function crossLeg() {
  console.log("\n== Cross-leg reference substitution ==");
  const v4 = await resolveReference(chain, NEIRO, NEIRO_V4);
  const clmm = await resolveReference(chain, JTO, JTO_CLMM);
  const honest = deriveVault(PROGRAM, NEIRO, [
    { targetMint: NEIRO, bps: 5_000, refSeed: v4.seed },
    { targetMint: JTO, bps: 5_000, refSeed: clmm.seed },
  ]);
  const swapped = deriveVault(PROGRAM, NEIRO, [
    { targetMint: NEIRO, bps: 5_000, refSeed: clmm.seed },
    { targetMint: JTO, bps: 5_000, refSeed: v4.seed },
  ]);
  if (honest.equals(swapped)) {
    fail("cross-leg", "swapped seeds derived the SAME vault — binding is broken");
  } else {
    pass(
      "cross-leg",
      `honest ${honest.toBase58().slice(0, 8)}… vs swapped ${swapped.toBase58().slice(0, 8)}… (6012 on burn)`
    );
  }
}

async function rt8() {
  console.log("\n== RT8 Mode B dispatch ==");
  const data = Buffer.alloc(8 + 1 + 4 + 2 + 32);
  VALIDATE_CONFIG.copy(data, 0);
  data[8] = 0x01;
  data.writeUInt32LE(1, 9);
  data.writeUInt16LE(10_000, 13);
  const [burnPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("burner"),
      NEIRO.toBuffer(),
      NEIRO.toBuffer(),
      Buffer.from([16, 39]),
      Buffer.alloc(32),
    ],
    PROGRAM
  );
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, burnPda, true, TOKEN_PROGRAM_ID);
  const ix = new TransactionInstruction({
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
    fail("rt8", `Mode B landed for ${burnPda.toBase58()}`);
  } catch (e: any) {
    const msg = String(e.message ?? e);
    const code = burnerCodeFrom(e);
    if (code === 6027) pass("rt8", "Mode B refused 6027 at dispatch");
    else fail("rt8", `unexpected code=${code} ${msg.slice(0, 180)}`);
  }
}

async function modeA() {
  console.log("\n== Mode A still admits an honest bound vault ==");
  const ref = await resolveReference(chain, NEIRO, NEIRO_V4);
  const vault = deriveVault(PROGRAM, NEIRO, [
    { targetMint: NEIRO, bps: 10_000, refSeed: ref.seed },
  ]);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  const targetAta = getAssociatedTokenAddressSync(NEIRO, vault, true, TOKEN_PROGRAM_ID);
  const data = Buffer.alloc(8 + 1 + 4 + 2 + 8);
  VALIDATE_CONFIG.copy(data, 0);
  data[8] = 0x00;
  data.writeUInt32LE(1, 9);
  data.writeUInt16LE(10_000, 13);
  data.writeBigUInt64LE(AMOUNT, 15);
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: wsolAta, isSigner: false, isWritable: false },
      { pubkey: NEIRO, isSigner: false, isWritable: false },
      { pubkey: NEIRO, isSigner: false, isWritable: false },
      { pubkey: targetAta, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ref.pool, isSigner: false, isWritable: false },
      { pubkey: ref.vaultA, isSigner: false, isWritable: false },
      { pubkey: ref.vaultB, isSigner: false, isWritable: false },
      { pubkey: ref.feeSource, isSigner: false, isWritable: false },
    ],
    data,
  });
  try {
    await sendPlain([ix]);
    pass("mode-a", `honest NEIRO v4 vault ${vault.toBase58().slice(0, 8)}… admitted`);
  } catch (e: any) {
    fail("mode-a", `honest Mode A refused: ${String(e.message ?? e).slice(0, 200)}`);
  }
}

async function donation() {
  console.log("\n== Donation accounting (ATA balances, no burn) ==");
  const ref = await resolveReference(chain, NEIRO, NEIRO_V4);
  const vault = deriveVault(PROGRAM, NEIRO, [
    { targetMint: NEIRO, bps: 10_000, refSeed: ref.seed },
  ]);
  const targetAta = getAssociatedTokenAddressSync(NEIRO, vault, true, TOKEN_PROGRAM_ID);
  const jtoAta = getAssociatedTokenAddressSync(JTO, vault, true, TOKEN_PROGRAM_ID);
  await sendPlain([
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      targetAta,
      vault,
      NEIRO,
      TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      jtoAta,
      vault,
      JTO,
      TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: vault,
      lamports: 100_000n,
    }),
  ]);
  const t = await c.getAccountInfo(targetAta);
  const j = await c.getAccountInfo(jtoAta);
  if (!t || !j) {
    fail("donation", "ATAs missing after create");
    return;
  }
  const tAmt = Buffer.from(t.data).readBigUInt64LE(64);
  const jAmt = Buffer.from(j.data).readBigUInt64LE(64);
  pass(
    "donation setup",
    `target ATA ${tAmt} atoms, non-target ATA ${jAmt} atoms (non-target is not a burn account — stays frozen)`
  );
}

async function findDlmm(mint: PublicKey): Promise<PublicKey | null> {
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  try {
    const dest = getAssociatedTokenAddressSync(
      mint,
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    const build = await jupiter.build({
      inputMint: NATIVE_MINT,
      outputMint: mint,
      amount: AMOUNT,
      taker: payer.publicKey,
      destinationTokenAccount: dest,
      slippageBps: 100,
      dexes: ["Meteora DLMM"],
    } as any);
    for (const a of build.swapInstruction.accounts) {
      const pk = new PublicKey(a.pubkey);
      const info = await c.getAccountInfo(pk);
      if (info && info.owner.equals(DLMM) && info.data.length >= 250) return pk;
    }
  } catch {
    /* no DLMM route today */
  }
  return null;
}

async function main() {
  const want = process.argv[2] ?? "all";
  const run = async (name: string, fn: () => Promise<void>) => {
    if (want !== "all" && want !== name) return;
    try {
      await fn();
    } catch (e: any) {
      fail(name, String(e.message ?? e).slice(0, 240));
    }
  };
  await run("floor-matrix", floorMatrix);
  await run("rt4-venues", async () => {
    await rt4Venue("v4", NEIRO, NEIRO_V4, 336, 368);
    await rt4Venue("clmm", JTO, JTO_CLMM, 137, 169);
    const dlmm = await findDlmm(JTO);
    if (dlmm) await rt4Venue("dlmm", JTO, dlmm, 152, 184);
    else console.log("SKIP  dlmm  no Meteora DLMM pool in the current JTO quote");
  });
  await run("cross-leg", crossLeg);
  await run("rt8", rt8);
  await run("mode-a", modeA);
  await run("donation", donation);
  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAIL`}`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
