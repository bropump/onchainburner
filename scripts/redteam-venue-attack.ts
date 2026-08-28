/**
 * Live venue attacks on a loopback fork. Honest burns first (liveness),
 * then hostile shapes (theft / pin / Mode A). Not a floor-read survey.
 *
 *   discover | honest | attack | all
 *
 * Env: RPC, BURNER_PROGRAM_ID, PAYER_KEYPAIR, FORK_DEX_PROFILE=pool
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
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  buildBurnInstruction,
  deriveVault,
  InMemoryVaultLeaseStore,
  JupiterBuildParams,
  JupiterClient,
  QuoteService,
} from "../quote-service/core";
import {
  JupiterV2HttpClient,
  LocalKeypairMessageSigner,
  PumpDirectCurveClient,
  SolanaRpcGateway,
} from "../quote-service/adapters";
import {
  resolveReference,
} from "../quote-service/reference";
import {
  BONDING_CURVE_V2_RENT_FLOOR,
  deriveBondingCurveV2,
  derivePumpCurve,
} from "../quote-service/directcurve";

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ?? "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5"
);
const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const JTO = new PublicKey("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL");
const PUMP = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const NEIRO_V4 = new PublicKey("HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV");
const JTO_CLMM = new PublicKey("JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo");
const PUMP_CLMM = new PublicKey("45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5");
const PUMP_SWAP = new PublicKey("539m4mVWt6iduB6W8rDGPMarzNCMesuqY5eUTiiYHAgR");
const AMOUNT = 50_000_000n;
const SOL = 1_000_000_000n;
const VALIDATE_CONFIG = Buffer.from([28, 98, 92, 82, 243, 62, 65, 93]);
const INIT_UVA = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);
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

const c = new Connection(RPC_URL, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        process.env.PAYER_KEYPAIR ??
          path.join(os.homedir(), ".config", "solana", "id.json"),
        "utf8"
      )
    )
  )
);
const chain = new SolanaRpcGateway(c);
const jupiterInner = new JupiterV2HttpClient(
  process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
  process.env.JUPITER_API_KEY
);

class ForkJupiter implements JupiterClient {
  async build(params: JupiterBuildParams) {
    const excluded = new Set(params.excludeDexes ?? []);
    return jupiterInner.build({
      ...params,
      excludeDexes: undefined,
      dexes: (params.dexes?.length ? params.dexes : POOL_DEXES).filter(
        (v) => !excluded.has(v)
      ),
      slippageBps: params.slippageBps ?? 1_500,
    });
  }
}

let failed = 0;
function pass(name: string, detail: string) {
  console.log(`PASS  ${name}  ${detail}`);
}
function fail(name: string, detail: string) {
  failed += 1;
  console.log(`FAIL  ${name}  ${detail}`);
}

async function confirm(sig: string) {
  for (let i = 0; i < 60; i++) {
    const t = await c
      .getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`unconfirmed ${sig}`);
}

async function sendPlain(ixs: TransactionInstruction[]) {
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...ixs,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const landed = await confirm(sig);
  if (landed.meta?.err) {
    throw new Error(
      `sendPlain failed: ${JSON.stringify(landed.meta.err)}\n${(landed.meta.logMessages ?? []).slice(-6).join("\n")}`
    );
  }
  return landed;
}

async function setAccountBytes(addr: PublicKey, offset: number, bytes: Buffer) {
  const ai = await c.getAccountInfo(addr);
  if (!ai) throw new Error(`missing ${addr.toBase58()}`);
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

async function tokenProgramOf(mint: PublicKey) {
  const ai = await c.getAccountInfo(mint);
  if (!ai) throw new Error(`no mint ${mint.toBase58()}`);
  return ai.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

function uvaIx(program: PublicKey, user: PublicKey) {
  const [accumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    program
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    program
  );
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: accumulator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: INIT_UVA,
  });
}

async function setupVault(
  mint: PublicKey,
  ref: Awaited<ReturnType<typeof resolveReference>>,
  extra: TransactionInstruction[] = [],
  amount: bigint = AMOUNT
) {
  const tp = await tokenProgramOf(mint);
  const vault = deriveVault(PROGRAM, mint, [
    { targetMint: mint, bps: 10_000, refSeed: ref.seed },
  ]);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetAta = getAssociatedTokenAddressSync(mint, vault, true, tp);
  await sendPlain([
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
      mint,
      tp
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: vault,
      lamports: amount + 2_000_000n,
    }),
    ...extra,
  ]);
  return { vault, wsolAta, targetAta, tp };
}

function service() {
  return new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter: new ForkJupiter(),
    directCurve: new PumpDirectCurveClient(c),
    feePayerSigner: new LocalKeypairMessageSigner(payer),
    submitter: {
      async submit(transaction: Uint8Array) {
        const submissionId = await c.sendRawTransaction(Buffer.from(transaction), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        return { submissionId };
      },
    },
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
    onEvent: (fields) => {
      if (fields.event === "error" || fields.event === "retry") {
        console.log(`    event ${JSON.stringify(fields).slice(0, 220)}`);
      }
    },
  });
}

async function honestBurn(
  name: string,
  mint: PublicKey,
  pool: PublicKey,
  dexes?: string[],
  amount: bigint = AMOUNT
) {
  console.log(`\n== honest burn ${name} ==`);
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const ref = await resolveReference(chain, mint, pool);
    console.log(
      `  venue=${ref.venue} cap=${Number(ref.capLamports) / 1e9} SOL floor=${ref.floorFor(amount)}`
    );
    const extras: TransactionInstruction[] = [];
    if (ref.venue.includes("Pump") || ref.venue === "Pump curve") {
      extras.push(uvaIx(PUMP_FUN, deriveVault(PROGRAM, mint, [{ targetMint: mint, bps: 10_000, refSeed: ref.seed }])));
      extras.push(uvaIx(PUMP_AMM, deriveVault(PROGRAM, mint, [{ targetMint: mint, bps: 10_000, refSeed: ref.seed }])));
      const v2 = deriveBondingCurveV2(mint);
      const v2Info = await c.getAccountInfo(v2);
      if (!v2Info) {
        extras.push(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: v2,
            lamports: BONDING_CURVE_V2_RENT_FLOOR,
          })
        );
      }
    }
    await setupVault(mint, ref, extras, amount);
    const qs = service();
    const receipt = await qs.execute({
      requestId: `venue-${name}-${Date.now()}`,
      launchMint: mint.toBase58(),
      amountIn: amount.toString(),
      legs: [
        {
          targetMint: mint.toBase58(),
          bps: 10_000,
          reference: pool.toBase58(),
        },
      ],
    });
    const landed = await confirm(receipt.submissionId);
    if (landed.meta?.err) {
      fail(
        `honest ${name}`,
        `landed with err ${JSON.stringify(landed.meta.err)} ${(landed.meta.logMessages ?? []).slice(-4).join(" | ")}`
      );
      return;
    }
    const spent = amount;
    pass(
      `honest ${name}`,
      `${receipt.submissionId.slice(0, 8)}… ${landed.meta?.computeUnitsConsumed} CU minOut=${receipt.minimumOutputs[0]} spent=${spent}`
    );
  } catch (e: any) {
    const msg = String(e.message ?? e);
    if (/6040|6041|REFERENCE_CAP|REFERENCE_TOO_SHALLOW|REFERENCE_DOES_NOT/i.test(msg)) {
      console.log(`SKIP  honest ${name}  ${msg.slice(0, 180)}`);
      return;
    }
    fail(`honest ${name}`, msg.slice(0, 280));
  }
}

async function modeA(opts: {
  mint: PublicKey;
  tokenProgram: PublicKey;
  reference: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  feeSource: PublicKey;
  probe: bigint;
  seed?: Buffer;
}) {
  const seed = opts.seed ?? opts.reference.toBuffer();
  const pda = deriveVault(PROGRAM, opts.mint, [
    { targetMint: opts.mint, bps: 10_000, refSeed: seed },
  ]);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetAta = getAssociatedTokenAddressSync(
    opts.mint,
    pda,
    true,
    opts.tokenProgram
  );
  const data = Buffer.alloc(8 + 1 + 4 + 2 + 8);
  VALIDATE_CONFIG.copy(data, 0);
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
    return { ok: true as const, code: null as number | null };
  } catch (e: any) {
    const msg = String(e.message ?? e);
    const hex = msg.match(/custom program error: (0x[0-9a-f]+)/i);
    const json = msg.match(/"Custom"\s*:\s*(\d+)/);
    const code = hex ? parseInt(hex[1], 16) : json ? Number(json[1]) : null;
    return { ok: false as const, code, log: msg.slice(0, 180) };
  }
}

function bigIntToLE(v: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

async function hostileJupiterBurn(opts: {
  mint: PublicKey;
  ref: Awaited<ReturnType<typeof resolveReference>>;
  vault: PublicKey;
  wsolAta: PublicKey;
  targetAta: PublicKey;
  tp: PublicKey;
  amount: bigint;
  minimumOutput: bigint;
  dexes: string[];
  patchQuotedOut: boolean;
}) {
  const build = await jupiterInner.build({
    inputMint: NATIVE_MINT,
    outputMint: opts.mint,
    amount: opts.amount,
    taker: opts.vault,
    slippageBps: 1_500,
    dexes: opts.dexes,
    destinationTokenAccount: opts.targetAta,
  } as any);
  const swapIx = build.swapInstruction;
  if (!swapIx) throw new Error("no swap instruction");
  let routeData = Buffer.from(swapIx.data, "base64");
  if (opts.patchQuotedOut) {
    const direct = routeData.subarray(8, 16).equals(bigIntToLE(opts.amount));
    const off = direct ? 16 : 17;
    routeData = Buffer.from(routeData);
    routeData.writeBigUInt64LE(1n, off);
  }
  const ix = buildBurnInstruction(
    PROGRAM,
    payer.publicKey,
    opts.mint,
    opts.vault,
    opts.wsolAta,
    opts.amount,
    [
      {
        targetMint: opts.mint,
        targetTokenProgram: opts.tp,
        targetAta: opts.targetAta,
        bps: 10_000,
        amountIn: opts.amount,
        minimumOutput: opts.minimumOutput,
        reference: opts.ref,
        routeAccounts: swapIx.accounts,
        routeData,
        lookupTables: [],
      },
    ]
  );
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ix,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const landed = await confirm(sig);
  const logs = (landed.meta?.logMessages ?? []).join("\n");
  const codeMatch = logs.match(/custom program error: (0x[0-9a-fA-F]+)/);
  const burnLog = [
    ...logs.matchAll(/Program log: 0x0, 0x0, 0x0, 0x([0-9a-f]+), 0x([0-9a-f]+)/g),
  ];
  const burned = burnLog.length
    ? BigInt("0x" + burnLog[burnLog.length - 1][2])
    : -1n;
  return {
    err: landed.meta?.err ?? null,
    code: codeMatch ? parseInt(codeMatch[1], 16) : null,
    received: burned,
    logs,
    sig,
  };
}

async function findDlmm(mint: PublicKey): Promise<PublicKey | null> {
  for (const [a, b] of [
    [mint, NATIVE_MINT],
    [NATIVE_MINT, mint],
  ] as const) {
    try {
      const accounts = await c.getProgramAccounts(DLMM, {
        filters: [
          { memcmp: { offset: 88, bytes: a.toBase58() } },
          { memcmp: { offset: 120, bytes: b.toBase58() } },
        ],
      });
      if (accounts.length) return accounts[0].pubkey;
    } catch (e: any) {
      console.log(`  dlmm scan: ${String(e.message ?? e).slice(0, 80)}`);
    }
  }
  return null;
}

async function findLiveCurve(): Promise<{ mint: PublicKey; curve: PublicKey } | null> {
  try {
    const res = await fetch(
      "https://lite-api.jup.ag/tokens/v2/recent?limit=80"
    );
    const tokens = (await res.json()) as any[];
    for (const t of tokens ?? []) {
      if (!t?.id?.endsWith("pump")) continue;
      const mint = new PublicKey(t.id);
      const curve = derivePumpCurve(mint);
      const info = await c.getAccountInfo(curve);
      if (!info || !info.owner.equals(PUMP_FUN)) continue;
      if (info.data[48] !== 0) continue; // complete
      if (info.data[81] !== 0 || info.data[82] !== 0) continue; // mayhem/cashback
      return { mint, curve };
    }
  } catch (e: any) {
    console.log(`  curve scan: ${String(e.message ?? e).slice(0, 120)}`);
  }
  return null;
}

async function discover() {
  console.log("== discover ==");
  const dlmm = await findDlmm(PUMP);
  const curve = await findLiveCurve();
  for (const [name, mint, pool] of [
    ["NEIRO v4", NEIRO, NEIRO_V4],
    ["JTO CLMM", JTO, JTO_CLMM],
    ["$PUMP CLMM", PUMP, PUMP_CLMM],
    ["$PUMP PumpSwap", PUMP, PUMP_SWAP],
  ] as const) {
    const info = await c.getAccountInfo(pool);
    if (!info) {
      console.log(`  MISS  ${name}  ${pool.toBase58()} (no account)`);
      continue;
    }
    try {
      const ref = await resolveReference(chain, mint, pool);
      console.log(
        `  OK    ${name}  ${ref.venue}  cap=${(Number(ref.capLamports) / 1e9).toFixed(3)} SOL  owner=${info.owner.toBase58().slice(0, 8)}…`
      );
    } catch (e: any) {
      console.log(`  BAD   ${name}  ${String(e.message ?? e).slice(0, 140)}`);
    }
  }
  if (dlmm) {
    try {
      const ref = await resolveReference(chain, PUMP, dlmm);
      console.log(
        `  OK    $PUMP DLMM  ${dlmm.toBase58()}  cap=${(Number(ref.capLamports) / 1e9).toFixed(3)} SOL`
      );
    } catch (e: any) {
      console.log(`  BAD   $PUMP DLMM  ${String(e.message ?? e).slice(0, 140)}`);
    }
  } else {
    console.log("  MISS  $PUMP DLMM");
  }
  if (curve) {
    try {
      const ref = await resolveReference(chain, curve.mint, curve.curve);
      console.log(
        `  OK    live curve  ${curve.mint.toBase58()}  cap=${(Number(ref.capLamports) / 1e9).toFixed(3)} SOL`
      );
    } catch (e: any) {
      console.log(`  BAD   live curve  ${String(e.message ?? e).slice(0, 140)}`);
    }
  } else {
    console.log("  MISS  live bonding curve");
  }
  return { dlmm, curve };
}

async function honestAll() {
  const d = await discover();
  await honestBurn("neiro-v4", NEIRO, NEIRO_V4, ["Raydium"]);
  await honestBurn("jto-clmm", JTO, JTO_CLMM, ["Raydium CLMM"]);
  await honestBurn("pump-clmm", PUMP, PUMP_CLMM, ["Raydium CLMM"]);
  await honestBurn("pump-pumpswap", PUMP, PUMP_SWAP, ["Pump.fun Amm"], 20_000_000n);
  if (d.dlmm) await honestBurn("pump-dlmm", PUMP, d.dlmm, ["Meteora DLMM"]);
  else fail("honest pump-dlmm", "no $PUMP LbPair on fork");
  if (d.curve)
    await honestBurn("live-curve", d.curve.mint, d.curve.curve, ["Pump.fun"]);
  else fail("honest live-curve", "no ungraduated normal Pump curve found");
}

async function attackAll() {
  const d = await discover();
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      fail(name, String(e.message ?? e).slice(0, 240));
    }
  };

  console.log("\n== ATTACK CLMM sqrt_price (JTO) ==");
  {
    const ref = await resolveReference(chain, JTO, JTO_CLMM);
    const honestFloor = ref.floorFor(AMOUNT);
    const pd = Buffer.from((await c.getAccountInfo(JTO_CLMM))!.data);
    const vaultA = new PublicKey(pd.subarray(137, 169));
    const vaultB = new PublicKey(pd.subarray(169, 201));
    const ammConfig = new PublicKey(pd.subarray(9, 41));
    const aIsSol = Buffer.from((await c.getAccountInfo(vaultA))!.data)
      .subarray(0, 32)
      .equals(NATIVE_MINT.toBuffer());
    const solVault = aIsSol ? vaultA : vaultB;
    const sqBefore = Buffer.from(pd.subarray(253, 269));
    const depthBefore = Buffer.from(
      (await c.getAccountInfo(solVault))!.data
    ).readBigUInt64LE(64);
    try {
      const sq = Buffer.alloc(16);
      sq.writeBigUInt64LE(1n << 52n);
      await setAccountBytes(solVault, 64, (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(5_000n * SOL);
        return b;
      })());
      await setAccountBytes(JTO_CLMM, 253, sq);
      let dustFloor: bigint | null = null;
      try {
        const dusty = await resolveReference(chain, JTO, JTO_CLMM);
        dustFloor = dusty.floorFor(AMOUNT);
      } catch (e: any) {
        if (String(e.message ?? e).includes("zero") || e.code === "REFERENCE_FLOOR_ZERO") {
          dustFloor = 0n;
        } else {
          throw e;
        }
      }
      if (dustFloor === 0n) {
        pass("clmm floor", `honest ${honestFloor} -> 0 (6002) — this sq is too hostile to admit`);
      } else if (dustFloor < honestFloor / 1_000n) {
        pass("clmm floor", `honest ${honestFloor} -> dust ${dustFloor}`);
      } else {
        fail("clmm floor", `${honestFloor} -> ${dustFloor}`);
      }
      const admitted = await modeA({
        mint: JTO,
        tokenProgram: TOKEN_PROGRAM_ID,
        reference: JTO_CLMM,
        vaultA,
        vaultB,
        feeSource: ammConfig,
        probe: AMOUNT,
      });
      if (dustFloor === 0n) {
        if (!admitted.ok && (admitted.code === 6002 || admitted.code === 6039)) {
          pass("clmm Mode A", `zero-floor dust refused ${admitted.code} (cannot extract)`);
        } else if (admitted.ok) {
          fail("clmm Mode A", "zero floor was admitted");
        } else {
          pass("clmm Mode A", `refused ${admitted.code}`);
        }
      } else if (admitted.ok) {
        pass("clmm Mode A", "program ADMITS dust reference");
      } else {
        fail("clmm Mode A", `refused ${admitted.code} ${admitted.log}`);
      }

      if (dustFloor !== null && dustFloor > 0n) {
        const dusty = await resolveReference(chain, JTO, JTO_CLMM);
        const { vault, wsolAta, targetAta, tp } = await setupVault(JTO, dusty);
        const r = await hostileJupiterBurn({
          mint: JTO,
          ref: dusty,
          vault,
          wsolAta,
          targetAta,
          tp,
          amount: AMOUNT,
          minimumOutput: dustFloor,
          dexes: ["Raydium CLMM"],
          patchQuotedOut: true,
        });
        if (!r.err && r.received >= 0n && r.received < honestFloor / 1_000n) {
          fail(
            "clmm theft",
            `BURN LANDED at ${r.received} atoms vs honest floor ${honestFloor} — RT4 analogue on CLMM`
          );
        } else if (r.err) {
          pass(
            "clmm theft blocked-or-liveness",
            `err=${JSON.stringify(r.err)} code=${r.code} received=${r.received}`
          );
        } else {
          fail("clmm theft", `unexpected success received=${r.received}`);
        }
      } else {
        pass("clmm theft", "skipped — zero floor is 6002, not an extractable RT4");
      }
    } finally {
      await setAccountBytes(JTO_CLMM, 253, sqBefore);
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(depthBefore);
      await setAccountBytes(solVault, 64, b);
    }
  }

  console.log("\n== ATTACK DLMM active_id ($PUMP) ==");
  if (!d.dlmm) {
    fail("dlmm", "no pair");
  } else {
    const pair = d.dlmm;
    const ref = await resolveReference(chain, PUMP, pair);
    let honestFloor: bigint | null = null;
    try {
      honestFloor = ref.floorFor(AMOUNT);
    } catch (e: any) {
      console.log(`  honest floor: ${String(e.message ?? e).slice(0, 100)}`);
    }
    const pd = Buffer.from((await c.getAccountInfo(pair))!.data);
    const v0 = new PublicKey(pd.subarray(152, 184));
    const v1 = new PublicKey(pd.subarray(184, 216));
    const v0Sol = Buffer.from((await c.getAccountInfo(v0))!.data)
      .subarray(0, 32)
      .equals(NATIVE_MINT.toBuffer());
    const solVault = v0Sol ? v0 : v1;
    const idBefore = Buffer.from(pd.subarray(76, 80));
    const depthBefore = Buffer.from(
      (await c.getAccountInfo(solVault))!.data
    ).readBigUInt64LE(64);
    const solIsX = Buffer.from(pd.subarray(88, 120)).equals(NATIVE_MINT.toBuffer());
    try {
      await setAccountBytes(solVault, 64, (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(5_000n * SOL);
        return b;
      })());
      let dustFloor: bigint | null = null;
      let chosen: number | null = null;
      for (const id of [-8000, -20000, -50000, 8000, 20000, 50000, 120000]) {
        if (solIsX ? id < 0 : id > 0) continue;
        const b = Buffer.alloc(4);
        b.writeInt32LE(id);
        await setAccountBytes(pair, 76, b);
        try {
          const dusty = await resolveReference(chain, PUMP, pair);
          const f = dusty.floorFor(AMOUNT);
          if (f >= 1n && (honestFloor === null || f < honestFloor / 100n)) {
            dustFloor = f;
            chosen = id;
            break;
          }
        } catch {
          /* next */
        }
      }
      if (chosen === null || dustFloor === null) {
        fail("dlmm floor", "no active_id produced a dust floor");
      } else {
        pass("dlmm floor", `id=${chosen} honest ${honestFloor} -> ${dustFloor}`);
        const admitted = await modeA({
          mint: PUMP,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          reference: pair,
          vaultA: v0,
          vaultB: v1,
          feeSource: pair,
          probe: AMOUNT,
        });
        if (admitted.ok) pass("dlmm Mode A", "program ADMITS dust DLMM");
        else fail("dlmm Mode A", `refused ${admitted.code} ${admitted.log}`);
      }
    } finally {
      await setAccountBytes(pair, 76, idBefore);
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(depthBefore);
      await setAccountBytes(solVault, 64, b);
    }
  }

  console.log("\n== ATTACK PumpSwap creator pin ($PUMP pool) ==");
  {
    const pool = PUMP_SWAP;
    const info = await c.getAccountInfo(pool);
    if (!info) {
      fail("pumpswap pin", "539m4m pool missing on fork");
    } else {
      const pd = Buffer.from(info.data);
      const v0 = new PublicKey(pd.subarray(139, 171));
      const v1 = new PublicKey(pd.subarray(171, 203));
      const creatorBefore = Buffer.from(pd.subarray(11, 43));
      const fake = Buffer.from(payer.publicKey.toBytes());
      try {
        await setAccountBytes(pool, 11, fake);
        const admitted = await modeA({
          mint: PUMP,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          reference: pool,
          vaultA: v0,
          vaultB: v1,
          feeSource: pool,
          probe: AMOUNT,
          seed: Buffer.alloc(32),
        });
        if (!admitted.ok && admitted.code === 6039) {
          pass("pumpswap pin", "mutated creator refused 6039");
        } else if (admitted.ok) {
          fail("pumpswap pin", "mutated creator was ADMITTED");
        } else {
          fail("pumpswap pin", `unexpected ${admitted.code} ${admitted.log}`);
        }
      } finally {
        await setAccountBytes(pool, 11, creatorBefore);
      }
    }
  }

  console.log("\n== ATTACK PumpSwap vault-dust ($PUMP canonical pool) ==");
  try {
    const pool = PUMP_SWAP;
    const ref = await resolveReference(chain, PUMP, pool);
    const probeAmt = 20_000_000n;
    const honestFloor = ref.floorFor(probeAmt);
    const pd = Buffer.from((await c.getAccountInfo(pool))!.data);
    const v0 = new PublicKey(pd.subarray(139, 171));
    const v1 = new PublicKey(pd.subarray(171, 203));
    const sides = await Promise.all(
      [v0, v1].map(async (v) => {
        const d = Buffer.from((await c.getAccountInfo(v))!.data);
        return { v, mint: new PublicKey(d.subarray(0, 32)), amt: d.readBigUInt64LE(64) };
      })
    );
    const tok = sides.find((s) => s.mint.equals(PUMP));
    if (!tok) {
      fail("pumpswap dust", "token vault not found");
    } else {
    try {
      const dust = Buffer.alloc(8);
      dust.writeBigUInt64LE(8_000_000n);
      await setAccountBytes(tok.v, 64, dust);
      const dusty = await resolveReference(chain, PUMP, pool);
      const dustFloor = dusty.floorFor(probeAmt);
      if (dustFloor < honestFloor / 1_000n) {
        pass(
          "pumpswap dust floor",
          `collapsed ${honestFloor} -> ${dustFloor} (canonical protocol pool)`
        );
      } else {
        pass("pumpswap dust floor", `${honestFloor} -> ${dustFloor}`);
      }
    } finally {
      const restore = Buffer.alloc(8);
      restore.writeBigUInt64LE(tok.amt);
      await setAccountBytes(tok.v, 64, restore);
    }
    }
  } catch (e: any) {
    fail("pumpswap dust", String(e.message ?? e).slice(0, 200));
  }

  if (d.curve) {
    console.log("\n== ATTACK live curve: Mode A on honest curve + swapped mint ==");
    try {
    const { mint, curve } = d.curve;
    const ref = await resolveReference(chain, mint, curve);
    const tp = await tokenProgramOf(mint);
    const honest = await modeA({
      mint,
      tokenProgram: tp,
      reference: curve,
      vaultA: curve,
      vaultB: curve,
      feeSource: ref.feeSource,
      probe: AMOUNT,
      seed: Buffer.alloc(32),
    });
    if (honest.ok) pass("curve Mode A", `live ${mint.toBase58().slice(0, 8)}… admitted`);
    else fail("curve Mode A", `honest curve refused ${honest.code} ${honest.log}`);

    const wrong = await modeA({
      mint: NEIRO,
      tokenProgram: TOKEN_PROGRAM_ID,
      reference: curve,
      vaultA: curve,
      vaultB: curve,
      feeSource: ref.feeSource,
      probe: AMOUNT,
      seed: Buffer.alloc(32),
    });
    if (!wrong.ok) pass("curve bind", `NEIRO-as-user of foreign curve refused ${wrong.code}`);
    else fail("curve bind", "foreign mint was admitted against another coin's curve");
    } catch (e: any) {
      fail("curve", String(e.message ?? e).slice(0, 200));
    }
  }
}

async function main() {
  const want = process.argv[2] ?? "all";
  if (want === "discover") {
    await discover();
    return;
  }
  if (want === "honest") await honestAll();
  else if (want === "pumpswap-grad") {
    await honestBurn(
      "fone-pumpswap",
      new PublicKey("CTPoyCwkjMvoJwU4xvZZqoD8tiYk6yDchySiN5gGpump"),
      new PublicKey("3dcwhqJp6JBTJPq8ga335HWgSQVS7uQmdmeX7iGjMNpj"),
      ["Pump.fun Amm"],
      20_000_000n
    );
  }
  else if (want === "attack") await attackAll();
  else {
    await honestAll();
    await attackAll();
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
