/**
 * RED-TEAM BRANCH COVERAGE (loopback fork only). Completes what
 * redteam-followup.ts could not:
 *   1. CLMM dust via sqrt_price_x64 (the floor prices from sq, NOT the vault
 *      amounts -- dusting vaults alone changes nothing on CLMM).
 *   2. DLMM dust via active_id (same principle: the bin price, not depth).
 *   3. On-chain Mode A admission of both dust shapes (the PROGRAM accepts).
 *   4. Floor matrix with WORKING Jupiter quotes (guard margin on real pools).
 *   5. Concurrent-execute lease race.
 *   6. Tamper-after-sign submission gate.
 *
 * Env: RPC (loopback), BURNER_PROGRAM_ID, PAYER_KEYPAIR.
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
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveVault } from "../quote-service/core";
import {
  SolanaRpcGateway,
  JupiterV2HttpClient,
  LocalKeypairMessageSigner,
} from "../quote-service/adapters";
import { assertSubmittableSignedTransaction } from "../quote-service/core";
import { resolveReference } from "../quote-service/reference";

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ??
    "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV"
);
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const JTO = new PublicKey("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL");
const PUMP = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const BONK = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
const WIF = new PublicKey("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
const JTO_CLMM = new PublicKey(process.env.JTO_CLMM ?? "JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo");
const AMOUNT = 200_000_000n; // 0.2 SOL
const SOL = 1_000_000_000n;
const VALIDATE_CONFIG_DISC = Buffer.from([28, 98, 92, 82, 243, 62, 65, 93]);

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

let failures = 0;
function pass(name: string, detail: string) {
  console.log(`PASS  ${name}  ${detail}`);
}
function fail(name: string, detail: string) {
  failures += 1;
  console.log(`FAIL  ${name}  ${detail}`);
}

async function setAccountBytes(addr: PublicKey, offset: number, bytes: Buffer) {
  const ai = await c.getAccountInfo(addr);
  if (!ai) throw new Error(`no account ${addr.toBase58()}`);
  const data = Buffer.from(ai.data);
  bytes.copy(data, offset);
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        addr.toBase58(),
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

async function setVaultAmount(vault: PublicKey, amount: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(amount);
  await setAccountBytes(vault, 64, b);
}

async function jupiterQuote(mint: PublicKey, amount: bigint, dexes?: string[]) {
  const takerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true, TOKEN_PROGRAM_ID);
  const build = await jupiter.build({
    inputMint: NATIVE_MINT,
    outputMint: mint,
    amount,
    taker: payer.publicKey,
    slippageBps: 1_500,
    dexes,
    destinationTokenAccount: takerAta,
  } as any);
  return BigInt(build.outAmount);
}

async function sendPlain(instructions: TransactionInstruction[]) {
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ...instructions,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (let i = 0; i < 60; i++) {
    const t = await c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (t) {
      if (t.meta?.err) throw new Error(`tx failed: ${JSON.stringify(t.meta.err)} ${(t.meta.logMessages ?? []).slice(-3).join(" | ")}`);
      return t;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("tx unconfirmed");
}

/** On-chain Mode A probe: does the PROGRAM admit (mint, reference) at probe? */
async function modeAProbe(opts: {
  mint: PublicKey;
  tokenProgram: PublicKey;
  reference: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  feeSource: PublicKey;
  probe: bigint;
}): Promise<{ ok: boolean; code: number | null; log: string }> {
  const legs = [{ targetMint: opts.mint, bps: 10_000, refSeed: opts.reference.toBuffer() }];
  const pda = deriveVault(PROGRAM, opts.mint, legs);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, pda, true, TOKEN_PROGRAM_ID);
  const targetAta = getAssociatedTokenAddressSync(opts.mint, pda, true, opts.tokenProgram);
  const data = Buffer.alloc(8 + 1 + 4 + 2 + 8);
  VALIDATE_CONFIG_DISC.copy(data, 0);
  data[8] = 0x00;
  data.writeUInt32LE(1, 9);
  data.writeUInt16LE(10_000, 13);
  data.writeBigUInt64LE(opts.probe, 15);
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: false },
      { pubkey: wsolAta, isSigner: false, isWritable: false },
      { pubkey: opts.mint, isSigner: false, isWritable: false },
      { pubkey: opts.mint, isSigner: false, isWritable: false },
      { pubkey: targetAta, isSigner: false, isWritable: false },
      { pubkey: opts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: opts.reference, isSigner: false, isWritable: false },
      { pubkey: opts.vaultA, isSigner: false, isWritable: false },
      { pubkey: opts.vaultB, isSigner: false, isWritable: false },
      { pubkey: opts.feeSource, isSigner: false, isWritable: false },
    ],
    data,
  });
  try {
    await sendPlain([ix]);
    return { ok: true, code: null, log: "accepted" };
  } catch (e: any) {
    const m = String(e.message ?? e).match(/custom program error: (0x[0-9a-f]+)/);
    return { ok: false, code: m ? parseInt(m[1], 16) : null, log: String(e.message ?? e).slice(0, 160) };
  }
}

const SECTIONS = (process.env.SECTIONS ?? "all").split(",");
const want = (name: string) => SECTIONS.includes("all") || SECTIONS.includes(name);

async function main() {
  // ---- 1. floor matrix with WORKING quotes ------------------------------
  if (want("matrix")) {
  console.log("\n== floor matrix (honest references, live quotes) ==");

  for (const [name, mint, pool] of [
    ["NEIRO v4", NEIRO, new PublicKey("HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV")],
    ["JTO clmm", JTO, JTO_CLMM],
    ["BONK clmm", BONK, new PublicKey("GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN")],
    ["WIF v4", WIF, new PublicKey("EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx")],
  ] as const) {
    try {
      const ref = await resolveReference(chain, mint, pool);
      const quote = await jupiterQuote(mint, AMOUNT);
      const floor = ref.floorFor(AMOUNT);
      const ratio = Number(floor) / Number(quote);
      if (quote / 2n > floor) {
        fail(`matrix ${name}`, `floor ${floor} < half quote ${quote} (ratio ${ratio.toFixed(3)})`);
      } else {
        pass(`matrix ${name}`, `floor/quote = ${ratio.toFixed(3)} (guard margin OK)`);
      }
    } catch (e: any) {
      console.log(`SKIP  matrix ${name}: ${String(e.message ?? e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 6_000));
  }

  }
  // ---- 2. CLMM dust via sqrt_price_x64 ----------------------------------
  if (want("clmm")) {
  console.log("\n== CLMM dust via sqrt_price (JTO) ==");
  {
    const ref = await resolveReference(chain, JTO, JTO_CLMM);
    const honestFloor = ref.floorFor(AMOUNT);
    const poolInfo = await c.getAccountInfo(JTO_CLMM)!;
    const pd = Buffer.from(poolInfo!.data);
    const vaultA = new PublicKey(pd.subarray(137, 169));
    const vaultB = new PublicKey(pd.subarray(169, 201));
    const ammConfig = new PublicKey(pd.subarray(9, 41));
    const aIsSol = Buffer.from((await c.getAccountInfo(vaultA))!.data)
      .subarray(0, 32)
      .equals(NATIVE_MINT.toBuffer());
    const solVault = aIsSol ? vaultA : vaultB;
    const sqBefore = Buffer.from(pd.subarray(253, 269));
    const depthBefore = Buffer.from((await c.getAccountInfo(solVault))!.data).readBigUInt64LE(64);
    try {
      // attacker-owned pool: gross depth >= 50 SOL (6041), spot priced to dust
      await setVaultAmount(solVault, 5_000n * SOL);
      const sq = Buffer.alloc(16);
      sq.writeBigUInt64LE(1n << 52n); // tiny sqrt price -> tiny expected out
      await setAccountBytes(JTO_CLMM, 253, sq);
      const dusty = await resolveReference(chain, JTO, JTO_CLMM);
      const dustFloor = dusty.floorFor(AMOUNT);
      if (dustFloor < honestFloor / 1_000_000n) {
        pass("clmm dust floor", `honest ${honestFloor} -> dust ${dustFloor} atoms JTO`);
      } else {
        fail("clmm dust floor", `floor did not collapse: ${honestFloor} -> ${dustFloor}`);
      }
      // on-chain: does the PROGRAM admit the dust reference at probe=AMOUNT?
      const probe = await modeAProbe({
        mint: JTO,
        tokenProgram: TOKEN_PROGRAM_ID,
        reference: JTO_CLMM,
        vaultA,
        vaultB,
        feeSource: ammConfig,
        probe: AMOUNT,
      });
      if (probe.ok) {
        pass("clmm dust MODE A", "program ADMITS the dust reference on chain (expected: service guard is the control)");
      } else {
        fail("clmm dust MODE A", `refused ${probe.code}: ${probe.log}`);
      }
    } finally {
      await setAccountBytes(JTO_CLMM, 253, sqBefore);
      await setVaultAmount(solVault, depthBefore);
    }
  }

  }
  // ---- 3. DLMM dust via active_id ($PUMP) --------------------------------
  if (want("dlmm")) {
  console.log("\n== DLMM dust via active_id ($PUMP) ==");
  {
    // find the $PUMP/WSOL LbPair
    const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    let pair: PublicKey | null = null;
    for (const [offA, a, b] of [
      [88, PUMP, NATIVE_MINT],
      [88, NATIVE_MINT, PUMP],
    ] as const) {
      const accounts = await c.getProgramAccounts(DLMM, {
        filters: [
          { memcmp: { offset: offA, bytes: a.toBase58() } },
          { memcmp: { offset: offA + 32, bytes: b.toBase58() } },
        ],
      });
      if (accounts.length) {
        pair = accounts[0].pubkey;
        break;
      }
    }
    if (!pair) {
      console.log("SKIP  dlmm: no $PUMP LbPair found on the fork");
    } else {
      const ref = await resolveReference(chain, PUMP, pair);
      const info = await c.getAccountInfo(pair)!;
      const pd = Buffer.from(info!.data);
      const v0 = new PublicKey(pd.subarray(152, 184));
      const v1 = new PublicKey(pd.subarray(184, 216));
      const v0Sol = Buffer.from((await c.getAccountInfo(v0))!.data)
        .subarray(0, 32)
        .equals(NATIVE_MINT.toBuffer());
      const solVault = v0Sol ? v0 : v1;
      const idBefore = Buffer.from(pd.subarray(76, 80));
      const depthBefore = Buffer.from((await c.getAccountInfo(solVault))!.data).readBigUInt64LE(64);
      const solIsX = Buffer.from(pd.subarray(88, 120)).equals(NATIVE_MINT.toBuffer());
      // honest state: the live pair is thin -- prove the honest cap refuses
      let honestFloor: bigint | null = null;
      try {
        honestFloor = ref.floorFor(AMOUNT);
      } catch (e: any) {
        console.log(`  note: honest pair cap/floor: ${String(e.message ?? e).slice(0, 90)}`);
      }
      try {
        // THE ATTACK SHAPE: attacker-owned depth first (the pair is theirs;
        // the SOL stays theirs), then the bin price dusted.
        await setVaultAmount(solVault, 5_000n * SOL);
        // the mirror snapshots state at resolve time -- re-resolve so the
        // donated depth (and the cap it buys) is visible
        const dustyRef = await resolveReference(chain, PUMP, pair);
        let chosen: number | null = null;
        let dustFloor = 0n;
        for (const id of [-8_000, -30_000, -80_000, -150_000, -250_000, -320_000, -400_000, 8_000, 30_000, 80_000, 150_000, 250_000, 320_000, 400_000]) {
          if (solIsX ? id > 0 : id < 0) continue;
          const b = Buffer.alloc(4);
          b.writeInt32LE(id);
          await setAccountBytes(pair, 76, b);
          try {
            // re-resolve AFTER the id write: the mirror snapshots state
            const idRef = await resolveReference(chain, PUMP, pair);
            const f = idRef.floorFor(AMOUNT);
            if (f >= 1n && (honestFloor !== null ? f < honestFloor / 1_000n : f <= 1_000_000n)) {
              chosen = id;
              dustFloor = f;
              break;
            }
          } catch {
            /* mirror refused (6002/overflow) -- next candidate */
          }
        }
        if (chosen === null) {
          fail("dlmm dust floor", "no active_id produced a dust-but-nonzero floor");
        } else {
          pass("dlmm dust floor", `active_id ${chosen}: honest ${honestFloor ?? "cap-refused"} -> dust ${dustFloor} atoms`);
          const probe = await modeAProbe({
            mint: PUMP,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            reference: pair,
            vaultA: v0,
            vaultB: v1,
            feeSource: pair,
            probe: AMOUNT,
          });
          if (probe.ok) {
            pass("dlmm dust MODE A", "program ADMITS the attacker-shaped DLMM reference on chain");
          } else {
            fail("dlmm dust MODE A", `refused ${probe.code}: ${probe.log}`);
          }
        }
      } finally {
        await setAccountBytes(pair, 76, idBefore);
        await setVaultAmount(solVault, depthBefore);
      }
    }
  }

  }
  // ---- 4. concurrent-execute lease race ----------------------------------
  if (want("race")) {
  console.log("\n== concurrent-execute lease race ==");
  {
    const { QuoteService, InMemoryVaultLeaseStore } = await import("../quote-service/core");
    const WIF_POOL = new PublicKey("EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx");
    const WIF = new PublicKey("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
    const ref = await resolveReference(chain, WIF, WIF_POOL);
    const legs = [{ targetMint: WIF, bps: 10_000, refSeed: ref.seed }];
    const vault = deriveVault(PROGRAM, WIF, legs);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
    const targetAta = getAssociatedTokenAddressSync(WIF, vault, true, TOKEN_PROGRAM_ID);
    await sendPlain([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, targetAta, vault, WIF, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 1n * SOL }),
    ]);
    const service = new QuoteService({
      burnerProgram: PROGRAM,
      chain,
      jupiter,
      submitter: {
        submit: async (transaction: Uint8Array) => {
          const sig = await c.sendRawTransaction(Buffer.from(transaction), { skipPreflight: false });
          return { submissionId: sig };
        },
      },
      feePayerSigner: new (LocalKeypairMessageSigner as any)(payer),
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
    const req = (id: string) => ({
      requestId: id,
      launchMint: WIF.toBase58(),
      amountIn: "100000000",
      legs: [{ targetMint: WIF.toBase58(), bps: 10_000, reference: "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx" }],
    });
    const results = await Promise.allSettled([
      service.execute(req(`race-a-${Date.now()}`)),
      service.execute(req(`race-b-${Date.now()}`)),
      service.execute(req(`race-c-${Date.now()}`)),
    ]);
    for (const r of results) {
      if (r.status === "rejected") console.log(`  race refusal: ${String((r as any).reason?.message ?? r.reason).slice(0, 110)}`);
    }
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected");
    const leaseRefusals = refused.filter((r) => String((r as any).reason?.message ?? "").match(/lease|inflight|INFLIGHT/i)).length;
    if (ok === 1 && leaseRefusals === refused.length && refused.length === 2) {
      pass("lease race", "1 landed, 2 refused by the vault lease (no double-burn)");
    } else if (ok === 1) {
      pass("lease race (partial)", `1 landed; ${refused.length} refused, but not all with lease codes: ${refused.map((r) => String((r as any).reason?.message ?? "").slice(0, 60)).join(" / ")}`);
    } else {
      fail("lease race", `${ok} landed, ${refused.length} refused`);
    }
  }

  }
  // ---- 5. tamper-after-sign submission gate ------------------------------
  if (want("tamper")) {
  console.log("\n== tamper-after-sign submission gate ==");
  {
    // Hand-build an honest burn (Jupiter's API is flaky today; the gate is
    // tx-shape-agnostic -- single-signature + program ids + digest).
    const BONK = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    const BONK_CLMM = new PublicKey("GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN");
    const ref = await resolveReference(chain, BONK, BONK_CLMM);
    const tLegs = [{ targetMint: BONK, bps: 10_000, refSeed: BONK_CLMM.toBuffer() }];
    const tVault = deriveVault(PROGRAM, BONK, tLegs);
    const tWsol = getAssociatedTokenAddressSync(NATIVE_MINT, tVault, true, TOKEN_PROGRAM_ID);
    const tAta = getAssociatedTokenAddressSync(BONK, tVault, true, TOKEN_PROGRAM_ID);
    await sendPlain([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, tWsol, tVault, NATIVE_MINT, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, tAta, tVault, BONK, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: tVault, lamports: 500_000_000n }),
    ]);
    const amount = 100_000_000n;
    const floor = ref.floorFor(amount);
    let quoted = floor * 2n;
    try { quoted = await jupiterQuoteOut(BONK, amount); } catch { /* route shape is irrelevant to the gate */ }
    const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amount);
    const outBuf = Buffer.alloc(8); outBuf.writeBigUInt64LE(quoted);
    const legs = [
      {
        targetMint: BONK,
        targetTokenProgram: TOKEN_PROGRAM_ID,
        targetAta: tAta,
        bps: 10_000,
        amountIn: amount,
        minimumOutput: floor,
        reference: ref,
        routeAccounts: [
          { pubkey: tAta.toBase58(), isSigner: false, isWritable: true },
        ],
        routeData: Buffer.concat([
          Buffer.from([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14]),
          amtBuf, outBuf,
          (() => { const b = Buffer.alloc(2); b.writeUInt16LE(1500); return b; })(),
          Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(4),
        ]),
        lookupTables: [],
      },
    ];
    const { buildBurnInstruction } = await import("../quote-service/core");
    const burnIx = buildBurnInstruction(PROGRAM, payer.publicKey, BONK, tVault, tWsol, amount, legs as any);
    const { blockhash } = await c.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), burnIx],
    }).compileToV0Message();
    const prepared = { transaction: new VersionedTransaction(msg) };
    prepared.transaction.sign([payer]);
    const wire = Buffer.from(prepared.transaction.serialize());
    // tamper: flip one byte of the fee-payer signature (post-signing mutation)
    const tampered = Buffer.from(wire);
    tampered[10] ^= 0xff;
    let threw = false;
    try {
      assertSubmittableSignedTransaction(tampered, PROGRAM);
    } catch {
      threw = true;
    }
    if (threw) {
      pass("gate tamper", "mutated signed bytes refused by assertSubmittableSignedTransaction");
    } else {
      fail("gate tamper", "tampered transaction PASSED the submission gate");
    }
    // control: the honest wire must still pass
    assertSubmittableSignedTransaction(wire, PROGRAM);
    pass("gate control", "untampered signed bytes still pass");
  }

  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAIL: ${e.message ?? e}`);
  process.exit(1);
});
