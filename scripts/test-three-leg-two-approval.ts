/**
 * Surfpool proof for a two-approval 80/10/10 launch.
 *
 * Approval 1: create_v2 + create/extend the vault ALT.
 * Between prompts: an app-paid permissionless Pump prerequisite transaction.
 * Approval 2: fee share + validate_config + ATAs + post-share creator rent.
 * Then a real three-leg burn is built by QuoteService using that same ALT.
 *
 * The payer is an ephemeral keypair funded only by Surfpool's airdrop RPC.
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
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
import BN from "bn.js";
import {
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
  PumpDirectCurveClient,
  SolanaRpcGateway,
} from "../quote-service/adapters";
import {
  BONDING_CURVE_V2_RENT_FLOOR,
  deriveBondingCurveV2,
  derivePumpCurve,
  deriveUserVolumeAccumulator,
} from "../quote-service/directcurve";
import { resolveReference } from "../quote-service/reference";
import {
  buildCreateV2Instruction,
  buildFeeShareInstructions,
  feeSharingConfigPda,
} from "../app/src/chain/pump";
import { deriveSplitPda, splitAmounts, type Leg } from "../app/src/chain/derive";
import {
  buildAtaInstructions,
  buildValidateConfigModeA,
  measureTransaction,
  sendWithWallet,
  type ResolvedLeg,
} from "../app/src/chain/instructions";
import { collectVaultAltAddresses } from "../app/src/chain/lookupTable";
import { loadSetupLookupTable } from "../app/src/chain/setupLookupTable";
import { PROGRAM } from "../app/src/chain/constants";

const RPC = process.env.RPC ?? "http://127.0.0.1:9900";
const SETUP_LUT = new PublicKey(
  process.env.SETUP_LUT ?? "9VFHxVgyQ9GLLogeKHZp8X91w4dszB7ui8rkSbRQkxyY"
);
const COOK = new PublicKey("EBmJhqzjyfd3SUrTjUu8Gzi8zMQWDXmyuDhg2a7cCjxW");
const WIF = new PublicKey("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
const WIF_POOL = new PublicKey("EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx");
const NEIRO = new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump");
const NEIRO_POOL = new PublicKey("HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV");
const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const INIT_USER_VOLUME_ACCUMULATOR = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);
const MAX_BYTES = 1232;
const BURN_AMOUNT = 30_000_000n;
const USE_WIF_CONTROL = process.env.SECOND_LEG === "WIF";
const SECOND_MINT = USE_WIF_CONTROL ? WIF : COOK;
const SECOND_POOL = USE_WIF_CONTROL ? WIF_POOL : undefined;
const { PumpSdk } = require("@pump-fun/pump-sdk") as {
  PumpSdk: new (connection: Connection) => {
    getBuyInstructionRaw(args: {
      user: PublicKey;
      mint: PublicKey;
      creator: PublicKey;
      amount: BN;
      solAmount: BN;
      tokenProgram: PublicKey;
    }): Promise<TransactionInstruction>;
    decodeGlobal(info: unknown): { buybackFeeRecipients: PublicKey[] };
  };
};

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC)) {
  throw new Error(`refusing non-loopback RPC ${RPC}`);
}
if (process.env.FORK_DEX_PROFILE !== "pool") {
  throw new Error("FORK_DEX_PROFILE=pool is mandatory for this fork burn proof");
}

const POOL_DEXES = [
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
  private queue: Promise<void> = Promise.resolve();
  private readonly publicClient = new JupiterV2HttpClient(
    "https://api.jup.ag/swap/v2/"
  );
  async build(params: JupiterBuildParams) {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.buildUnlocked(params);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      release();
    }
  }

  private async buildUnlocked(params: JupiterBuildParams) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.publicClient.build(params);
      } catch (error) {
        if (!String(error).includes("HTTP 429") || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 12_000 * (attempt + 1)));
      }
    }
  }
}

class RpcSubmitter implements PrivateSubmitter {
  constructor(private readonly connection: Connection) {}
  async submit(transaction: Uint8Array) {
    return {
      submissionId: await this.connection.sendRawTransaction(Buffer.from(transaction), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      }),
    };
  }
}

function wallet(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    async signTransaction(transaction: VersionedTransaction) {
      transaction.sign([keypair]);
      return transaction;
    },
  };
}

async function waitForTransaction(connection: Connection, signature: string) {
  for (let i = 0; i < 80; i += 1) {
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }).catch(() => null);
    if (transaction) return transaction;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`transaction ${signature} did not confirm`);
}

function initAccumulator(payer: PublicKey, user: PublicKey): TransactionInstruction {
  const accumulator = deriveUserVolumeAccumulator(user);
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_FUN
  );
  return new TransactionInstruction({
    programId: PUMP_FUN,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: accumulator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN, isSigner: false, isWritable: false },
    ],
    data: INIT_USER_VOLUME_ACCUMULATOR,
  });
}

async function waitForLookupTable(
  connection: Connection,
  address: PublicKey,
  expected: PublicKey[]
): Promise<AddressLookupTableAccount> {
  for (let i = 0; i < 80; i += 1) {
    const table = (await connection.getAddressLookupTable(address, { commitment: "confirmed" })).value;
    const have = new Set(table?.state.addresses.map((key) => key.toBase58()));
    if (table && expected.every((key) => have.has(key.toBase58()))) return table;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`lookup table ${address.toBase58()} did not activate`);
}

async function warmCurveInstructions(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  includeRentFunding: boolean
): Promise<TransactionInstruction[]> {
  const sdk = new PumpSdk(connection);
  const curve = derivePumpCurve(mint);
  const [curveInfo, mintInfo] = await Promise.all([
    connection.getAccountInfo(curve, "confirmed"),
    connection.getAccountInfo(mint, "confirmed"),
  ]);
  if (!curveInfo || !mintInfo) throw new Error("warm buy needs a live curve and mint");
  const creator = new PublicKey(curveInfo.data.subarray(49, 81));
  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_FUN
  );
  const bcv2 = deriveBondingCurveV2(mint);
  const [bcv2Info, creatorVaultInfo] = await Promise.all([
    connection.getAccountInfo(bcv2, "confirmed"),
    connection.getAccountInfo(creatorVault, "confirmed"),
  ]);
  const instructions: TransactionInstruction[] = [];
  const creatorFunding =
    includeRentFunding &&
    (!creatorVaultInfo || BigInt(creatorVaultInfo.lamports) < BONDING_CURVE_V2_RENT_FLOOR)
      ? SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: creatorVault,
          lamports: Number(
            BONDING_CURVE_V2_RENT_FLOOR - BigInt(creatorVaultInfo?.lamports ?? 0)
          ),
        })
      : null;
  if (
    includeRentFunding &&
    (!bcv2Info ||
      (bcv2Info.owner.equals(SystemProgram.programId) &&
        BigInt(bcv2Info.lamports) < BONDING_CURVE_V2_RENT_FLOOR))
  ) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: bcv2,
        lamports: Number(BONDING_CURVE_V2_RENT_FLOOR - BigInt(bcv2Info?.lamports ?? 0)),
      })
    );
  }
  if (bcv2Info?.owner.equals(PUMP_FUN)) {
    if (creatorFunding) instructions.push(creatorFunding);
    return instructions;
  }
  const payerAta = getAssociatedTokenAddressSync(mint, payer, false, mintInfo.owner);
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      payerAta,
      payer,
      mint,
      mintInfo.owner
    )
  );
  const raw = await sdk.getBuyInstructionRaw({
    user: payer,
    mint,
    creator,
    amount: new BN(1),
    solAmount: new BN(1_000_000),
    tokenProgram: mintInfo.owner,
  });
  const globalAddress = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_FUN
  )[0];
  const globalInfo = await connection.getAccountInfo(globalAddress, "confirmed");
  if (!globalInfo) throw new Error("Pump global missing");
  const global = sdk.decodeGlobal(globalInfo);
  const data = Buffer.alloc(25);
  Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]).copy(data, 0);
  data.writeBigUInt64LE(1_000_000n, 8);
  data.writeBigUInt64LE(1n, 16);
  data[24] = 0;
  instructions.push(
    new TransactionInstruction({
      programId: PUMP_FUN,
      data,
      keys: [
        ...raw.keys.slice(0, 16),
        { pubkey: bcv2, isSigner: false, isWritable: true },
        { pubkey: global.buybackFeeRecipients[0], isSigner: false, isWritable: true },
      ],
    })
  );
  // A tiny warm buy can consume/close an empty creator vault. Fund it after
  // the warm so the real burner does not pay Pump's lazy zero-data rent.
  if (creatorFunding) instructions.push(creatorFunding);
  return instructions;
}

async function sendOperatorInstructions(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[]
) {
  if (!instructions.length) return null;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ...instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
  });
  await waitForTransaction(connection, signature);
  return signature;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.generate();
  const operator = Keypair.generate();
  const mint = Keypair.generate();
  const payerWallet = wallet(payer);
  const airdrop = await connection.requestAirdrop(payer.publicKey, 20_000_000_000);
  await waitForTransaction(connection, airdrop);
  const operatorAirdrop = await connection.requestAirdrop(
    operator.publicKey,
    5_000_000_000
  );
  await waitForTransaction(connection, operatorAirdrop);

  const chain = new SolanaRpcGateway(connection);
  // One-time infrastructure for the fixed COOK leg, not a per-launch user
  // approval. Once Pump owns bonding_curve_v2 this never repeats.
  const cookWarmSignature = USE_WIF_CONTROL
    ? null
    : await sendOperatorInstructions(
        connection,
        operator,
        await warmCurveInstructions(connection, operator.publicKey, COOK, true)
      );
  const [secondReference, neiroReference] = await Promise.all([
    resolveReference(chain, SECOND_MINT, SECOND_POOL),
    resolveReference(chain, NEIRO, NEIRO_POOL),
  ]);
  const seedToRef = (seed: Buffer) => seed.equals(Buffer.alloc(32)) ? undefined : new PublicKey(seed);
  const legs: Leg[] = [
    { mint: mint.publicKey, bps: 8_000 },
    { mint: SECOND_MINT, bps: 1_000, ref: seedToRef(secondReference.seed) },
    { mint: NEIRO, bps: 1_000, ref: seedToRef(neiroReference.seed) },
  ];
  const [vault] = deriveSplitPda(mint.publicKey, legs);
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  const targetPrograms = [
    TOKEN_2022_PROGRAM_ID,
    USE_WIF_CONTROL ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
  ];
  const targetAtas = legs.map((leg, index) =>
    getAssociatedTokenAddressSync(leg.mint, vault, true, targetPrograms[index])
  );
  const poolKeys = [derivePumpCurve(mint.publicKey), secondReference.pool, neiroReference.pool];

  const setupTable = await loadSetupLookupTable(connection, SETUP_LUT.toBase58());
  if (!setupTable) throw new Error("shared setup LUT missing");
  const createV2 = await buildCreateV2Instruction({
    mint: mint.publicKey,
    name: "Three Leg Surfpool Proof",
    symbol: "3LEG",
    uri: "https://example.com/three-leg-proof.json",
    creator: payer.publicKey,
  });
  const slot = await connection.getSlot("confirmed");
  const [createTable, vaultTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot - 1,
  });

  const required = [vault, wsol, ...targetAtas, ...poolKeys];
  const allCandidates = collectVaultAltAddresses({
    vault,
    launchMint: mint.publicKey,
    legs: [
      {
        mint: mint.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        pool: poolKeys[0],
        vaultA: poolKeys[0],
        vaultB: poolKeys[0],
        feeSource: poolKeys[0],
      },
      {
        mint: SECOND_MINT,
        tokenProgram: targetPrograms[1],
        pool: secondReference.pool,
        vaultA: secondReference.vaultA,
        vaultB: secondReference.vaultB,
        feeSource: secondReference.feeSource,
      },
      {
        mint: NEIRO,
        tokenProgram: TOKEN_PROGRAM_ID,
        pool: neiroReference.pool,
        vaultA: neiroReference.vaultA,
        vaultB: neiroReference.vaultB,
        feeSource: neiroReference.feeSource,
      },
    ],
  });
  const chosen = [...new Map(required.map((key) => [key.toBase58(), key])).values()];
  const extras = allCandidates.filter(
    (key) => !chosen.some((entry) => entry.equals(key))
  );
  const surfpoolMintRentTopup = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: mint.publicKey,
    lamports: 5_000_000,
  });
  const buildFirst = (addresses: PublicKey[]) => [
    createTable,
    AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: vaultTableAddress,
      addresses,
    }),
    surfpoolMintRentTopup,
    createV2,
  ];
  if (measureTransaction(payer.publicKey, buildFirst(chosen), [setupTable]) > MAX_BYTES) {
    throw new Error("minimum create_v2 + vault LUT transaction exceeds 1232 bytes");
  }
  for (const extra of extras) {
    const next = [...chosen, extra];
    if (measureTransaction(payer.publicKey, buildFirst(next), [setupTable]) <= MAX_BYTES) {
      chosen.push(extra);
    }
  }
  const firstInstructions = buildFirst(chosen);
  const firstBytes = measureTransaction(payer.publicKey, firstInstructions, [setupTable]);
  const firstSignature = await sendWithWallet(
    connection,
    payerWallet,
    firstInstructions,
    [mint],
    [setupTable]
  );
  const firstLanded = await waitForTransaction(connection, firstSignature);
  console.log(
    `approval1 landed ${firstBytes} bytes ${firstSignature} (${chosen.length} LUT addresses)`
  );
  const vaultTable = await waitForLookupTable(connection, vaultTableAddress, chosen);

  const ownReference = await resolveReference(chain, mint.publicKey, undefined);
  if (!ownReference.seed.equals(Buffer.alloc(32))) {
    throw new Error("fresh Pump reference unexpectedly changed the precomputed vault seed");
  }
  const references = [ownReference, secondReference, neiroReference];
  const resolved: ResolvedLeg[] = legs.map((leg, index) => ({
    ...leg,
    tokenProgram: targetPrograms[index],
    ata: targetAtas[index],
    referenceBlock: {
      pool: references[index].pool,
      vaultA: references[index].vaultA,
      vaultB: references[index].vaultB,
      feeSource: references[index].feeSource,
    },
  }));
  const quoteVault = deriveVault(
    PROGRAM,
    mint.publicKey,
    resolved.map((leg, index) => ({
      targetMint: leg.mint,
      bps: leg.bps,
      refSeed: references[index].seed,
    }))
  );
  if (!quoteVault.equals(vault)) throw new Error("app and quote-service derived different vaults");

  // Per-launch app-paid preparation between the user's two approvals. Any
  // payer may do both jobs; neither instruction controls the vault.
  const operatorPrepSignature = await sendOperatorInstructions(
    connection,
    operator,
    [
      ...(await warmCurveInstructions(
        connection,
        operator.publicKey,
        mint.publicKey,
        true
      )),
      ...(!(await connection.getAccountInfo(
        deriveUserVolumeAccumulator(vault),
        "confirmed"
      ))
        ? [initAccumulator(operator.publicKey, vault)]
        : []),
    ]
  );
  console.log(`operator preparation landed ${operatorPrepSignature}`);

  const setupInstructions = [
    ...(await buildFeeShareInstructions({
      creator: payer.publicKey,
      mint: mint.publicKey,
      vault,
    })),
    buildValidateConfigModeA(
      vault,
      mint.publicKey,
      resolved,
      splitAmounts(BURN_AMOUNT, [8_000, 1_000, 1_000])
    ),
    ...buildAtaInstructions(payer.publicKey, vault, resolved),
  ];
  const [postShareCreatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), feeSharingConfigPda(mint.publicKey).toBuffer()],
    PUMP_FUN
  );
  setupInstructions.push(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: postShareCreatorVault,
      lamports: 1_000_000,
    })
  );
  // Test funding only: production receives SOL from Pump creator fees.
  setupInstructions.push(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: vault,
      lamports: Number(BURN_AMOUNT + 10_000_000n),
    })
  );
  const lookupTables = [setupTable, vaultTable];
  const secondBytes = measureTransaction(payer.publicKey, setupInstructions, lookupTables);
  if (secondBytes > MAX_BYTES) {
    throw new Error(`atomic setup is ${secondBytes} bytes, over 1232`);
  }
  const secondSignature = await sendWithWallet(
    connection,
    payerWallet,
    setupInstructions,
    [],
    lookupTables
  );
  const secondLanded = await waitForTransaction(connection, secondSignature);
  console.log(`approval2 landed ${secondBytes} bytes ${secondSignature}`);

  const jupiter = new ForkJupiter();
  const serviceEvents: Array<Record<string, string>> = [];
  const service = new QuoteService({
    burnerProgram: PROGRAM,
    chain,
    jupiter,
    directCurve: new PumpDirectCurveClient(connection),
    feePayerSigner: new LocalKeypairMessageSigner(payer),
    submitter: new RpcSubmitter(connection),
    leaseStore: new InMemoryVaultLeaseStore(),
    policy: {
      production: false,
      maxAmountPerBurn: 200_000_000_000n,
      maxSlippageBps: 2_000,
      maxPriceImpactBps: 2_500,
      computeUnitLimit: 1_400_000,
      minRemainingBlockHeights: 20,
      leaseTtlMs: 180_000,
      fittingMaxAccounts: [40, 32, 26, 20, 16, 12],
      approvedLookupTables: new Set([vaultTableAddress.toBase58()]),
    },
    onEvent: (event) => {
      serviceEvents.push({ ...event });
      if (event.transactionBytes) {
        console.log(
          `burn built ${event.transactionBytes} bytes ${event.accountLocks ?? "?"} locks`
        );
      }
    },
  });
  const burnRequest = {
    requestId: `three-leg-two-approval-${Date.now()}`,
    launchMint: mint.publicKey.toBase58(),
    amountIn: BURN_AMOUNT.toString(),
    legs: [
      { targetMint: mint.publicKey.toBase58(), bps: 8_000 },
      {
        targetMint: SECOND_MINT.toBase58(),
        bps: 1_000,
        ...(SECOND_POOL ? { reference: SECOND_POOL.toBase58() } : {}),
      },
      { targetMint: NEIRO.toBase58(), bps: 1_000, reference: NEIRO_POOL.toBase58() },
    ],
    lookupTableAddresses: [vaultTableAddress.toBase58()],
  };
  let receipt;
  try {
    receipt = await service.execute(burnRequest);
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          result: "BURN_FAILED_AFTER_TWO_APPROVAL_SETUP",
          approval1: { bytes: firstBytes, signature: firstSignature },
          approval2: { bytes: secondBytes, signature: secondSignature },
          lookupTable: vaultTableAddress.toBase58(),
          operatorPreparation: operatorPrepSignature,
          serviceEvents,
          error: String((error as Error).message ?? error),
        },
        null,
        2
      )
    );
    throw error;
  }
  const burn = await waitForTransaction(connection, receipt.submissionId);
  if (burn.meta?.err) throw new Error(`burn failed: ${JSON.stringify(burn.meta.err)}`);

  console.log(JSON.stringify({
    result: "PASS",
    policy: `own token 80% / ${USE_WIF_CONTROL ? "WIF" : "COOK"} 10% / NEIRO 10%`,
    walletApprovalsForLaunchAndSetup: 2,
    approval1: {
      bytes: firstBytes,
      locks: firstLanded.transaction.message.staticAccountKeys.length,
      computeUnits: firstLanded.meta?.computeUnitsConsumed ?? null,
      signature: firstSignature,
      includes: "create_v2 + create/extend vault LUT",
    },
    lookupTable: {
      address: vaultTableAddress.toBase58(),
      addresses: chosen.length,
    },
    oneTimeCookWarmup: cookWarmSignature,
    perLaunchOperatorPreparation: operatorPrepSignature,
    approval2: {
      bytes: secondBytes,
      locks: secondLanded.transaction.message.staticAccountKeys.length +
        (secondLanded.meta?.loadedAddresses?.writable.length ?? 0) +
        (secondLanded.meta?.loadedAddresses?.readonly.length ?? 0),
      computeUnits: secondLanded.meta?.computeUnitsConsumed ?? null,
      signature: secondSignature,
      includes: "fee share + validate + ATAs + burn prerequisites",
    },
    burn: {
      bytes: receipt.transactionBytes,
      locks: receipt.accountLocks,
      simulatedUnits: receipt.simulatedUnits ?? null,
      computeUnits: burn.meta?.computeUnitsConsumed ?? null,
      signature: receipt.submissionId,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
