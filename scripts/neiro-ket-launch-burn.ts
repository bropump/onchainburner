/**
 * Surfpool proof: Pump launch → real buys → distributeCreatorFeesV2 →
 * keyless 90/10 split burn of KET + NEIRO, against program
 * burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5.
 *
 * The fresh launch mint is the namespace only. Jupiter cannot index a mint
 * that exists only on this fork, so it is not a burn target. NEIRO is the
 * Raydium v4 pool; KET is the canonical Pump venue (omit reference).
 *
 * Env: RPC (default :9900), BURNER_PROGRAM_ID, PAYER_KEYPAIR / SOLANA_KEYPAIR,
 * FORK_DEX_PROFILE=pool (client-side pool dex list is applied regardless).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BN from "bn.js";
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  deriveVault,
  InMemoryVaultLeaseStore,
  JupiterBuildParams,
  JupiterClient,
  JupiterInstruction,
  PolicyError,
  PrivateSubmitter,
  QuoteService,
} from "../quote-service/core";
import {
  JupiterV2HttpClient,
  LocalKeypairMessageSigner,
  SolanaRpcGateway,
} from "../quote-service/adapters";
import { resolveReference } from "../quote-service/reference";

const {
  OnlinePumpSdk,
  PUMP_SDK,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
} = require("@pump-fun/pump-sdk");

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}

const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ?? "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5"
);
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const NEIRO_POOL = new PublicKey(
  "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV"
);
const KET = new PublicKey("9Pfync3ejPC9eHqVzq3nYQJAhyhjqpnB9UsaSfLxpump");
const VAULT_RENT_FLOOR = 890_880n;
/** Left in the vault after wrap so a PumpSwap route can create (then close)
 * the vault's user_volume_accumulator without System error 1. Two programs
 * × 1,844,400 lamports, plus slack. */
const PUMP_ROUTE_BUFFER = 5_000_000n;
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const PUMP_SWAP_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const INIT_USER_VOLUME_ACCUMULATOR = Buffer.from([
  94, 6, 202, 115, 255, 96, 232, 183,
]);
const EXTEND_ACCOUNT = Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]);
const BPS_TOTAL = 10_000;
const BUY_LAMPORTS = (process.env.PUMP_BUY_SOL ?? "5,10,25")
  .split(",")
  .map((s) => BigInt(Math.round(Number(s.trim()) * 1e9)));

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
  lastBuilds: Array<{
    mint: string;
    setup: readonly JupiterInstruction[];
    route: PublicKey[];
  }> = [];
  constructor(private readonly inner: JupiterClient) {}
  async build(params: JupiterBuildParams) {
    const excluded = new Set(params.excludeDexes ?? []);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const build = await this.inner.build({
          ...params,
          excludeDexes: undefined,
          dexes: POOL_ONLY_FORK_DEXES.filter((venue) => !excluded.has(venue)),
          slippageBps: params.slippageBps ?? 1_500,
        });
        this.lastBuilds.push({
          mint: params.outputMint.toBase58(),
          setup: build.setupInstructions ?? [],
          route: build.swapInstruction.accounts.map(
            (account) => new PublicKey(account.pubkey)
          ),
        });
        return build;
      } catch (error) {
        const text = String((error as Error).message ?? error);
        if (!text.includes("HTTP 429") || attempt >= 5) throw error;
        const waitMs = 12_000 * (attempt + 1);
        console.log(`  Jupiter 429, waiting ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
}

function splitAmounts(total: bigint, bpsList: readonly number[]): bigint[] {
  const quotient = total / BigInt(BPS_TOTAL);
  const remainder = total % BigInt(BPS_TOTAL);
  const amounts: bigint[] = [];
  let allocated = 0n;
  for (const [index, bps] of bpsList.entries()) {
    const amount =
      index + 1 === bpsList.length
        ? total - allocated
        : quotient * BigInt(bps) +
          (remainder * BigInt(bps)) / BigInt(BPS_TOTAL);
    amounts.push(amount);
    allocated += amount;
  }
  return amounts;
}

function initUserVolumeAccumulatorIx(
  program: PublicKey,
  payer: PublicKey,
  user: PublicKey
): TransactionInstruction {
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
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: accumulator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: INIT_USER_VOLUME_ACCUMULATOR,
  });
}

function payerFundedAtaSetup(
  instruction: JupiterInstruction,
  payer: PublicKey
): TransactionInstruction {
  const keys = instruction.accounts.map((account) => ({
    pubkey: new PublicKey(account.pubkey),
    isSigner: account.isSigner,
    isWritable: account.isWritable,
  }));
  keys[0] = { pubkey: payer, isSigner: true, isWritable: true };
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys,
    data: Buffer.from(instruction.data, "base64"),
  });
}

async function extendLiveBondingCurves(
  connection: Connection,
  payer: Keypair,
  mints: PublicKey[]
) {
  const instructions: TransactionInstruction[] = [];
  for (const mint of mints) {
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      PUMP_FUN_PROGRAM
    );
    const info = await connection.getAccountInfo(curve, "confirmed");
    if (!info || !info.owner.equals(PUMP_FUN_PROGRAM)) continue;
    if (info.data[48] !== 0) continue;
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      PUMP_FUN_PROGRAM
    );
    instructions.push(
      new TransactionInstruction({
        programId: PUMP_FUN_PROGRAM,
        keys: [
          { pubkey: curve, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: EXTEND_ACCOUNT,
      })
    );
  }
  if (instructions.length) {
    await sendPlain(
      connection,
      payer,
      instructions,
      [],
      "extend-bonding-curves"
    );
  }
}

async function prepayMissingRouteAtas(
  connection: Connection,
  payer: Keypair,
  vault: PublicKey,
  legs: Array<{ mint: PublicKey; tokenProgram: PublicKey; amount: bigint }>,
  jupiter: ForkJupiter
) {
  const instructions: TransactionInstruction[] = [];
  const seen = new Set<string>();
  for (const leg of legs) {
    const ata = getAssociatedTokenAddressSync(
      leg.mint,
      vault,
      true,
      leg.tokenProgram
    );
    const build = await jupiter.build({
      inputMint: NATIVE_MINT,
      outputMint: leg.mint,
      amount: leg.amount,
      taker: vault,
      destinationTokenAccount: ata,
    });
    for (const setup of build.setupInstructions ?? []) {
      if (
        setup.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() ||
        setup.data !== "AQ=="
      ) {
        throw new Error(
          `unsafe Jupiter setup for ${leg.mint.toBase58()}: ${setup.programId}`
        );
      }
      const ataKey = setup.accounts[1]?.pubkey;
      if (!ataKey || seen.has(ataKey)) continue;
      if (await connection.getAccountInfo(new PublicKey(ataKey), "confirmed")) {
        continue;
      }
      seen.add(ataKey);
      instructions.push(payerFundedAtaSetup(setup, payer.publicKey));
    }
    const routeKeys = build.swapInstruction.accounts.map(
      (account) => new PublicKey(account.pubkey)
    );
    const infos = await connection.getMultipleAccountsInfo(
      routeKeys,
      "confirmed"
    );
    for (const [index, info] of infos.entries()) {
      if (info) continue;
      const missing = routeKeys[index];
      const key = missing.toBase58();
      if (seen.has(key)) continue;
      for (const [candidateMint, candidateProgram] of [
        [NATIVE_MINT, TOKEN_PROGRAM_ID],
        [leg.mint, leg.tokenProgram],
      ] as const) {
        let matched = false;
        for (const owner of routeKeys) {
          let derived: PublicKey;
          try {
            derived = getAssociatedTokenAddressSync(
              candidateMint,
              owner,
              true,
              candidateProgram
            );
          } catch {
            continue;
          }
          if (!derived.equals(missing)) continue;
          seen.add(key);
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey,
              missing,
              owner,
              candidateMint,
              candidateProgram
            )
          );
          matched = true;
          break;
        }
        if (matched) break;
      }
    }
  }
  if (instructions.length) {
    await sendPlain(
      connection,
      payer,
      instructions,
      [],
      `prepay ${instructions.length} route ATAs`
    );
  } else {
    console.log("  no missing Jupiter/Pump ATAs");
  }
}

class RpcSubmitter implements PrivateSubmitter {
  constructor(private readonly connection: Connection) {}
  async submit(
    transaction: Uint8Array,
    _metadata: Readonly<Record<string, string>>
  ) {
    const submissionId = await this.connection.sendRawTransaction(
      Buffer.from(transaction),
      { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }
    );
    return { submissionId };
  }
}

function readPayer(): Keypair {
  const file =
    process.env.PAYER_KEYPAIR ??
    process.env.SOLANA_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[])
  );
}

async function confirm(connection: Connection, signature: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const tx = await connection
      .getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`unconfirmed ${signature}`);
}

async function sendPlain(
  connection: Connection,
  payer: Keypair,
  instructions: ConstructorParameters<
    typeof TransactionMessage
  >[0]["instructions"],
  extra: Keypair[] = [],
  label = "tx"
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
  transaction.sign([payer, ...extra]);
  const signature = await connection.sendRawTransaction(
    Buffer.from(transaction.serialize()),
    { skipPreflight: false, preflightCommitment: "confirmed" }
  );
  const landed = await confirm(connection, signature);
  if (landed.meta?.err) {
    throw new Error(
      `${label} failed ${signature}: ${JSON.stringify(landed.meta.err)}`
    );
  }
  console.log(`  ${label} ${signature}`);
  return signature;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const chain = new SolanaRpcGateway(connection);
  const programInfo = await connection.getAccountInfo(PROGRAM, "confirmed");
  if (!programInfo?.executable) {
    throw new Error(
      `program ${PROGRAM.toBase58()} is not executable on ${RPC_URL}`
    );
  }
  console.log(`fork ${RPC_URL} program ${PROGRAM.toBase58()}`);
  console.log(`payer ${payer.publicKey.toBase58()}`);

  const neiroRef = await resolveReference(chain, NEIRO, NEIRO_POOL);
  const ketRef = await resolveReference(chain, KET, undefined);
  console.log(
    `NEIRO ${neiroRef.venue} ${neiroRef.pool.toBase58()} cap ${
      neiroRef.capLamports
    }`
  );
  console.log(
    `KET ${ketRef.venue} ${ketRef.pool.toBase58()} cap ${ketRef.capLamports}`
  );

  const mint = Keypair.generate();
  const onlinePump = new OnlinePumpSdk(connection);
  await sendPlain(
    connection,
    payer,
    [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: "NEIRO KET Burn Test",
        symbol: "NKBT",
        uri: "https://example.com/nkbt.json",
        creator: payer.publicKey,
        user: payer.publicKey,
        mayhemMode: false,
        cashback: false,
      }),
    ],
    [mint],
    "create_v2"
  );

  const derivedLegs = [
    { targetMint: KET, bps: 9000, refSeed: ketRef.seed },
    { targetMint: NEIRO, bps: 1000, refSeed: neiroRef.seed },
  ];
  const vault = deriveVault(PROGRAM, mint.publicKey, derivedLegs);
  console.log(`launch ${mint.publicKey.toBase58()}`);
  console.log(`vault  ${vault.toBase58()}`);

  await sendPlain(
    connection,
    payer,
    [
      await PUMP_SDK.createFeeSharingConfig({
        creator: payer.publicKey,
        mint: mint.publicKey,
        pool: null,
      }),
    ],
    [],
    "fee-config"
  );
  await sendPlain(
    connection,
    payer,
    [
      await PUMP_SDK.updateFeeSharesV2({
        authority: payer.publicKey,
        mint: mint.publicKey,
        currentShareholders: [payer.publicKey],
        newShareholders: [{ address: vault, shareBps: 10_000 }],
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ],
    [],
    "fee-share-100pct"
  );

  const global = await onlinePump.fetchGlobal();
  const feeConfig = await onlinePump.fetchFeeConfig();
  let distributable = await onlinePump.getMinimumDistributableFee(
    mint.publicKey,
    payer.publicKey
  );
  for (const requested of BUY_LAMPORTS) {
    if (distributable.canDistribute) break;
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
      await onlinePump.fetchBuyState(
        mint.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      );
    const mintState = await getMint(
      connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const quoteAmount = new BN(requested.toString());
    await sendPlain(
      connection,
      payer,
      await PUMP_SDK.buyV2Instructions({
        global,
        feeConfig,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint: mint.publicKey,
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
        slippage: 1,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
      [],
      `buy ${requested} lamports`
    );
    distributable = await onlinePump.getMinimumDistributableFee(
      mint.publicKey,
      payer.publicKey
    );
  }
  if (!distributable.canDistribute) {
    throw new Error(
      `fees below Pump threshold: have ${distributable.distributableFees}, need ${distributable.minimumRequired}`
    );
  }

  const sharingConfigAddress = feeSharingConfigPda(mint.publicKey);
  const sharingConfigInfo = await connection.getAccountInfo(
    sharingConfigAddress,
    "confirmed"
  );
  if (!sharingConfigInfo) throw new Error("sharing config missing");
  const sharingConfig = PUMP_SDK.decodeSharingConfig(sharingConfigInfo);
  const beforeFees = await connection.getBalance(vault, "confirmed");
  await sendPlain(
    connection,
    payer,
    [
      await PUMP_SDK.distributeCreatorFeesV2({
        mint: mint.publicKey,
        sharingConfig,
        sharingConfigAddress,
        quoteMint: NATIVE_MINT,
        payer: payer.publicKey,
        shouldInitializeAta: true,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ],
    [],
    "distributeCreatorFeesV2"
  );
  const afterFees = await connection.getBalance(vault, "confirmed");
  const delivered = BigInt(afterFees - beforeFees);
  if (delivered <= 0n) throw new Error("Pump delivered no SOL to the vault");
  console.log(`fees delivered ${delivered} lamports`);

  const neiroInfo = await connection.getAccountInfo(NEIRO, "confirmed");
  const ketInfo = await connection.getAccountInfo(KET, "confirmed");
  if (!neiroInfo || !ketInfo)
    throw new Error("NEIRO or KET mint missing on fork");
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );
  await sendPlain(
    connection,
    payer,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        wsolAta,
        vault,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        getAssociatedTokenAddressSync(NEIRO, vault, true, neiroInfo.owner),
        vault,
        NEIRO,
        neiroInfo.owner
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        getAssociatedTokenAddressSync(KET, vault, true, ketInfo.owner),
        vault,
        KET,
        ketInfo.owner
      ),
    ],
    [],
    "vault-atas"
  );

  // Optional diagnostic top-up. The end-to-end proof runs with the default 0,
  // so every lamport burned came from Pump's creator-fee distribution.
  const extra = BigInt(process.env.EXTRA_BURN_LAMPORTS ?? "0");
  if (extra > 0n) {
    await sendPlain(
      connection,
      payer,
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: vault,
          lamports: extra,
        }),
      ],
      [],
      `top-up ${extra} lamports`
    );
  }
  const vaultFunded = BigInt(await connection.getBalance(vault, "confirmed"));
  const spendable =
    vaultFunded > VAULT_RENT_FLOOR
      ? vaultFunded - VAULT_RENT_FLOOR
      : vaultFunded;
  if (spendable < 10_000_000n) {
    throw new Error(`vault spendable ${spendable} is dust`);
  }

  // Pre-pay Pump's per-user bookkeeping outside the burn. Pump may close and
  // refund these accounts during the route; the burner validates that exact
  // credit without weakening lamport conservation.
  const accumulatorIxs: TransactionInstruction[] = [];
  for (const pumpProgram of [PUMP_FUN_PROGRAM, PUMP_SWAP_PROGRAM]) {
    const [accumulator] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), vault.toBuffer()],
      pumpProgram
    );
    if (!(await connection.getAccountInfo(accumulator, "confirmed"))) {
      accumulatorIxs.push(
        initUserVolumeAccumulatorIx(pumpProgram, payer.publicKey, vault)
      );
    }
  }
  if (accumulatorIxs.length) {
    await sendPlain(
      connection,
      payer,
      accumulatorIxs,
      [],
      "init-vault-pump-accumulators"
    );
  }

  const forkJupiter = new ForkJupiter(
    new JupiterV2HttpClient(
      process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
      process.env.JUPITER_API_KEY
    )
  );
  const legAmounts = splitAmounts(spendable, [9000, 1000]);
  await prepayMissingRouteAtas(
    connection,
    payer,
    vault,
    [
      { mint: KET, tokenProgram: ketInfo.owner, amount: legAmounts[0] },
      { mint: NEIRO, tokenProgram: neiroInfo.owner, amount: legAmounts[1] },
    ],
    forkJupiter
  );

  const service = new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter: forkJupiter,
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

  let receipt;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      receipt = await service.execute({
        requestId: `nkbt-${Date.now()}`,
        launchMint: mint.publicKey.toBase58(),
        amountIn: spendable.toString(),
        legs: [
          { targetMint: KET.toBase58(), bps: 9000 },
          {
            targetMint: NEIRO.toBase58(),
            bps: 1000,
            reference: NEIRO_POOL.toBase58(),
          },
        ],
      });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const text = String((error as Error).message ?? error);
      console.log(
        `  burn attempt ${attempt + 1} failed: ${text.slice(0, 180)}`
      );
      await new Promise((r) => setTimeout(r, 8_000 * (attempt + 1)));
    }
  }
  if (!receipt) throw lastError;
  const burned = await confirm(connection, receipt.submissionId);
  if (burned.meta?.err) {
    throw new Error(
      `burn landed but FAILED: ${JSON.stringify(burned.meta.err)}\n${(
        burned.meta.logMessages ?? []
      ).join("\n")}`
    );
  }
  const vaultAfter = BigInt(await connection.getBalance(vault, "confirmed"));
  console.log(
    JSON.stringify(
      {
        program: PROGRAM.toBase58(),
        launchMint: mint.publicKey.toBase58(),
        vault: vault.toBase58(),
        feesDeliveredLamports: delivered.toString(),
        burnedLamports: spendable.toString(),
        vaultAfterLamports: vaultAfter.toString(),
        burnSig: receipt.submissionId,
        cu: burned.meta?.computeUnitsConsumed,
        minimumOutputs: receipt.minimumOutputs,
      },
      null,
      2
    )
  );
  console.log("PASS launch + buy + distribute + KET 90 / NEIRO 10 burn");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
