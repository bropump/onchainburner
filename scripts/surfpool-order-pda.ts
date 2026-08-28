/**
 * Surfpool proof for using Jupiter `/order` as the quote source while the
 * burner remains the atomic PDA-spend-and-burn executor.
 *
 * The order transaction itself cannot be used: its taker is the sole signer
 * and its setup transfers that taker's SOL into that taker's WSOL ATA. This
 * harness instead extracts the exact Jupiter route instruction and output
 * floor selected by `/order`, remaps only the taker-owned authority/source/
 * destination accounts to their immutable PDA equivalents, and submits that
 * route to the existing burner instruction.
 *
 * Cases:
 *   1. SOL -> JUP: `/order` charges 0 bps, so the exact route must burn.
 *   2. SOL -> BONK: `/order` charges 10 bps, so the exact route must atomically
 *      reject with 6007 and leave the vault unchanged.
 *   3. The same BONK route with only its platform-fee scalar normalized to
 *      zero. This is deliberately NOT claimed to be the exact order; it proves
 *      whether the fee scalar is the sole program-level incompatibility.
 *   4. BONK with `/order` used as the immutable fair-price floor and Jupiter
 *      `/build` used only for the fee-free, CPI-compatible route. The burner
 *      enforces the stricter of the order floor and build floor on chain.
 *   5. A `/build` mutation proof: after Jupiter responds, lower both its
 *      embedded quoted output and the burn floor to 1. The route still lands,
 *      proving that `/build` carries no reusable Jupiter authentication. The
 *      const current test signs with the caller only.
 *
 * Run against a mainnet Surfpool fork:
 *   FORK_DEX_PROFILE=pool npx tsx scripts/surfpool-order-pda.ts
 *   FORK_DEX_PROFILE=pool ORDER_CASES=build-mutation-only npx tsx scripts/surfpool-order-pda.ts
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
  getLookupTables,
  JUPITER_PROGRAM,
  PreparedLeg,
  prepareLegs,
  readPayer,
  RPC_URL,
  sendInstructions,
  TOKENS,
} from "./surfpool-split-e2e";

const ORDER_TAKER = new PublicKey(
  process.env.ORDER_TEST_TAKER ?? "4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ"
);
const JUP_MINT = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
const AMOUNT = 10_000_000n;
const RENT_SAFE_REMAINDER = 1_000_000n;
const ORDER_API = "https://api.jup.ag/swap/v2/order";

// Leave Whirlpool as the deterministic fork-executable venue. This is a fork
// measurement profile only; production routing remains unrestricted.
const EXCLUDED_FOR_FORK = [
  "SolFi",
  "HumidiFi",
  "GoonFi V2",
  "Aquifer",
  "AlphaQ",
  "Scorch",
  "Omnipair",
  "TesseraV",
  "SolFi V2",
  "ZeroFi",
  "BisonFi",
  "Saber",
  "PancakeSwap",
  "Quantum",
  "Flux",
  "Manifest",
  "JupLend AMM",
];

type Order = {
  transaction: string;
  requestId: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  feeBps: number;
  platformFee?: { feeBps: number; feeMint: string };
  router: string;
  mode: string;
  routePlan: Array<{ swapInfo?: { label?: string } }>;
  error?: string;
  errorMessage?: string;
};

const DIRECT = "bb64facc31c4af14";
const SHARED = "d19853937cfed8e9";

function discriminator(data: Buffer): string {
  return data.subarray(0, 8).toString("hex");
}

function platformFeeOffset(data: Buffer): number {
  const disc = discriminator(data);
  if (disc === DIRECT) return 26;
  if (disc === SHARED) return 27;
  throw new Error(`unsupported Jupiter instruction ${disc}`);
}

async function fetchOrder(targetMint: PublicKey): Promise<Order> {
  const url = new URL(ORDER_API);
  url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
  url.searchParams.set("outputMint", targetMint.toBase58());
  url.searchParams.set("amount", AMOUNT.toString());
  url.searchParams.set("taker", ORDER_TAKER.toBase58());
  url.searchParams.set("excludeRouters", "jupiterz,dflow,okx");
  url.searchParams.set("excludeDexes", EXCLUDED_FOR_FORK.join(","));
  // `/order` accepts the same Metis account-width bound. Keeping the route
  // narrow leaves room for the burner accounts in the composed fork proof.
  url.searchParams.set("maxAccounts", process.env.ORDER_MAX_ACCOUNTS ?? "16");
  const headers = process.env.JUPITER_API_KEY
    ? { "x-api-key": process.env.JUPITER_API_KEY }
    : undefined;
  const response = await fetch(url, { headers });
  const order = (await response.json()) as Order;
  if (!response.ok || !order.transaction) {
    throw new Error(
      `Jupiter /order ${response.status}: ${
        order.errorMessage ?? order.error ?? "no transaction"
      }`
    );
  }
  if (BigInt(order.inAmount) !== AMOUNT) {
    throw new Error(`order changed input to ${order.inAmount}`);
  }
  return order;
}

function dedupeTables(
  tables: AddressLookupTableAccount[]
): AddressLookupTableAccount[] {
  return [
    ...new Map(tables.map((table) => [table.key.toBase58(), table])).values(),
  ];
}

async function extractOrderLeg(
  connection: Connection,
  order: Order,
  targetMint: PublicKey,
  pda: PublicKey,
  wsolAta: PublicKey,
  targetAta: PublicKey,
  zeroPlatformFee: boolean,
  mutateQuotedOutput: boolean
): Promise<PreparedLeg> {
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64")
  );
  const lookupTables = await getLookupTables(
    connection,
    transaction.message.addressTableLookups.map((lookup) =>
      lookup.accountKey.toBase58()
    )
  );
  if (lookupTables.length !== transaction.message.addressTableLookups.length) {
    throw new Error("Surfpool could not resolve every /order lookup table");
  }
  const keys = transaction.message.getAccountKeys({
    addressLookupTableAccounts: lookupTables,
  });
  const route = transaction.message.compiledInstructions.find((instruction) => {
    const program = keys.get(instruction.programIdIndex);
    const data = Buffer.from(instruction.data);
    return (
      program?.equals(JUPITER_PROGRAM) &&
      (discriminator(data) === DIRECT || discriminator(data) === SHARED)
    );
  });
  if (!route)
    throw new Error("/order did not contain a supported Jupiter route");

  const originalWsol = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    ORDER_TAKER,
    false,
    TOKEN_PROGRAM_ID
  );
  const targetInfo = await connection.getAccountInfo(targetMint, "confirmed");
  if (!targetInfo) throw new Error(`target mint ${targetMint} missing on fork`);
  const targetProgram = targetInfo.owner;
  const originalTarget = getAssociatedTokenAddressSync(
    targetMint,
    ORDER_TAKER,
    false,
    targetProgram
  );

  const remap = (key: PublicKey): PublicKey => {
    if (key.equals(ORDER_TAKER)) return pda;
    if (key.equals(originalWsol)) return wsolAta;
    if (key.equals(originalTarget)) return targetAta;
    return key;
  };
  const routeAccounts = Array.from(route.accountKeyIndexes, (index) => {
    const key = keys.get(index);
    if (!key) throw new Error(`unresolved route account ${index}`);
    return {
      pubkey: remap(key),
      // The burner rebuilds CPI privileges and grants only the PDA signature.
      isSigner: false,
      isWritable: transaction.message.isAccountWritable(index),
    };
  });
  const data = Buffer.from(route.data);
  const feeOffset = platformFeeOffset(data);
  const embeddedFeeBps = data.readUInt16LE(feeOffset);
  if (embeddedFeeBps !== order.feeBps) {
    throw new Error(
      `order fee ${order.feeBps} != embedded fee ${embeddedFeeBps}`
    );
  }
  if (zeroPlatformFee) data.writeUInt16LE(0, feeOffset);
  if (mutateQuotedOutput) {
    const quotedOutputOffset = discriminator(data) === SHARED ? 17 : 16;
    const slippageOffset = discriminator(data) === SHARED ? 25 : 24;
    data.writeBigUInt64LE(1n, quotedOutputOffset);
    data.writeUInt16LE(0, slippageOffset);
  }

  return {
    label: targetMint.equals(JUP_MINT) ? "JUP" : "BONK",
    mint: targetMint,
    bps: 10_000,
    tokenProgram: targetProgram,
    ata: targetAta,
    amountIn: AMOUNT,
    minimumOutput: mutateQuotedOutput ? 1n : BigInt(order.otherAmountThreshold),
    routeAccounts,
    jupiterData: data,
    lookupTables: transaction.message.addressTableLookups.map((lookup) =>
      lookup.accountKey.toBase58()
    ),
    resolvedLookupTables: lookupTables,
    slippageBps: order.slippageBps,
    slippageSource: "jupiter-order",
    routeLabel: `${
      discriminator(data) === DIRECT ? "route_v2" : "shared"
    }:${order.routePlan.map((hop) => hop.swapInfo?.label).join(">")}`,
  };
}

async function runCase(
  connection: Connection,
  targetMint: PublicKey,
  label: string,
  zeroPlatformFee = false,
  mutateQuotedOutput = false
) {
  const payer = readPayer();
  const launchMint = TOKENS.JTO;
  const [pda] = deriveSplitPda(launchMint, [{ mint: targetMint, bps: 10_000 }]);
  const targetInfo = await connection.getAccountInfo(targetMint, "confirmed");
  if (!targetInfo) throw new Error(`missing target mint ${targetMint}`);
  const targetProgram = targetInfo.owner;
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetAta = getAssociatedTokenAddressSync(
    targetMint,
    pda,
    true,
    targetProgram
  );

  await sendInstructions(connection, payer, `${label}-order-atas`, [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      wsolAta,
      pda,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      targetAta,
      pda,
      targetMint,
      targetProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ]);
  const before = await connection.getBalance(pda, "confirmed");
  const required = AMOUNT + RENT_SAFE_REMAINDER;
  if (BigInt(before) < required) {
    await sendInstructions(connection, payer, `${label}-order-fund`, [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pda,
        lamports: Number(required - BigInt(before)),
      }),
    ]);
  }
  const funded = await connection.getBalance(pda, "confirmed");
  const order = await fetchOrder(targetMint);
  const leg = await extractOrderLeg(
    connection,
    order,
    targetMint,
    pda,
    wsolAta,
    targetAta,
    zeroPlatformFee,
    mutateQuotedOutput
  );
  const instruction = buildSplitInstruction(
    payer.publicKey,
    payer.publicKey,
    pda,
    wsolAta,
    launchMint,
    [leg],
    AMOUNT
  );
  const shared = await ensureSharedLookupTable(connection, payer);
  const vault = await createVaultLookupTable(
    connection,
    payer,
    `order-${label}-${
      mutateQuotedOutput
        ? "quote-mutated"
        : zeroPlatformFee
        ? "normalized"
        : "exact"
    }`,
    pda,
    wsolAta,
    launchMint,
    [{ mint: targetMint, ata: targetAta }]
  );
  const localTables = await getLookupTables(connection, [
    shared.toBase58(),
    vault.toBase58(),
  ]);
  const tables = dedupeTables([...leg.resolvedLookupTables, ...localTables]);
  const validity = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: validity.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      instruction,
    ],
  }).compileToV0Message(tables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const bytes = transaction.serialize().length;
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
  });
  const attributed = attributeFailure(
    simulation.value.logs,
    simulation.value.err
  );
  const result: Record<string, unknown> = {
    label,
    exactOrder: !zeroPlatformFee && !mutateQuotedOutput,
    quotedOutputMutated: mutateQuotedOutput,
    orderRouter: order.router,
    orderMode: order.mode,
    route: order.routePlan.map((hop) => hop.swapInfo?.label),
    orderFeeBps: order.feeBps,
    embeddedFeeBps: leg.jupiterData.readUInt16LE(
      platformFeeOffset(leg.jupiterData)
    ),
    orderSlippageBps: order.slippageBps,
    orderMinimumOutput: order.otherAmountThreshold,
    routeDiscriminator: discriminator(leg.jupiterData),
    routeFixedAccounts: leg.routeAccounts
      .slice(0, discriminator(leg.jupiterData) === SHARED ? 12 : 10)
      .map((account) => account.pubkey.toBase58()),
    orderTaker: ORDER_TAKER.toBase58(),
    burnCaller: payer.publicKey.toBase58(),
    vault: pda.toBase58(),
    txBytes: bytes,
    unitsConsumed: simulation.value.unitsConsumed,
    simulationError: simulation.value.err,
    burnerError: attributed.isBurner ? attributed.code : undefined,
    logs: simulation.value.err ? simulation.value.logs?.slice(-18) : undefined,
  };
  if (!simulation.value.err) {
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, maxRetries: 3 }
    );
    await connection.confirmTransaction(
      { signature, ...validity },
      "confirmed"
    );
    const after = await connection.getBalance(pda, "confirmed");
    const target = await getAccount(
      connection,
      targetAta,
      "confirmed",
      targetProgram
    );
    result.signature = signature;
    result.vaultSpent = funded - after;
    result.targetAtaAfter = target.amount.toString();
    result.burned = target.amount === 0n;
  } else {
    const after = await connection.getBalance(pda, "confirmed");
    const target = await getAccount(
      connection,
      targetAta,
      "confirmed",
      targetProgram
    );
    result.vaultUnchanged = after === funded;
    result.targetAtaAfter = target.amount.toString();
  }
  return result;
}

async function runOrderFloorBuildCase(
  connection: Connection,
  forceUnattainableFloor = false,
  mutateBuildQuote = false
) {
  const payer = readPayer();
  const targetMint = TOKENS.BONK;
  const launchMint = TOKENS.JTO;
  const [pda] = deriveSplitPda(launchMint, [{ mint: targetMint, bps: 10_000 }]);
  const targetInfo = await connection.getAccountInfo(targetMint, "confirmed");
  if (!targetInfo) throw new Error(`missing target mint ${targetMint}`);
  const targetProgram = targetInfo.owner;
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetAta = getAssociatedTokenAddressSync(
    targetMint,
    pda,
    true,
    targetProgram
  );

  await sendInstructions(connection, payer, "BONK-order-floor-atas", [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      wsolAta,
      pda,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      targetAta,
      pda,
      targetMint,
      targetProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ]);
  const required = AMOUNT + RENT_SAFE_REMAINDER;
  const beforeFunding = await connection.getBalance(pda, "confirmed");
  if (BigInt(beforeFunding) < required) {
    await sendInstructions(connection, payer, "BONK-order-floor-fund", [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pda,
        lamports: Number(required - BigInt(beforeFunding)),
      }),
    ]);
  }
  const funded = await connection.getBalance(pda, "confirmed");

  // The service obtains both responses itself. Caller-supplied order/build
  // bytes are never accepted. `/order` determines the fair-price floor;
  // `/build` contributes only an executable, fee-free Jupiter V2 route.
  const [order, prepared] = await Promise.all([
    fetchOrder(targetMint),
    prepareLegs(
      connection,
      payer,
      pda,
      wsolAta,
      [{ label: "BONK", mint: targetMint, bps: 10_000 }],
      AMOUNT,
      100,
      16
    ),
  ]);
  const builtLeg = prepared[0];
  const leg: PreparedLeg = {
    ...builtLeg,
    jupiterData: Buffer.from(builtLeg.jupiterData),
    minimumOutput: mutateBuildQuote ? 1n : builtLeg.minimumOutput,
  };
  if (mutateBuildQuote) {
    const quotedOutputOffset =
      discriminator(leg.jupiterData) === SHARED ? 17 : 16;
    const slippageOffset = discriminator(leg.jupiterData) === SHARED ? 25 : 24;
    leg.jupiterData.writeBigUInt64LE(1n, quotedOutputOffset);
    leg.jupiterData.writeUInt16LE(0, slippageOffset);
  }
  const orderFloor = BigInt(order.otherAmountThreshold);
  const fairFloor =
    orderFloor > leg.minimumOutput ? orderFloor : leg.minimumOutput;
  const enforcedFloor = mutateBuildQuote
    ? 1n
    : forceUnattainableFloor
    ? fairFloor * 2n
    : fairFloor;
  const instruction = buildSplitInstruction(
    payer.publicKey,
    payer.publicKey,
    pda,
    wsolAta,
    launchMint,
    [leg],
    AMOUNT,
    { minimumOutputOverride: [enforcedFloor] }
  );
  const shared = await ensureSharedLookupTable(connection, payer);
  const vault = await createVaultLookupTable(
    connection,
    payer,
    `order-floor-BONK-build-${
      mutateBuildQuote
        ? "quote-mutated"
        : forceUnattainableFloor
        ? "rollback"
        : "land"
    }`,
    pda,
    wsolAta,
    launchMint,
    [{ mint: targetMint, ata: targetAta }]
  );
  const localTables = await getLookupTables(connection, [
    shared.toBase58(),
    vault.toBase58(),
  ]);
  const tables = dedupeTables([...leg.resolvedLookupTables, ...localTables]);
  const validity = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: validity.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      instruction,
    ],
  }).compileToV0Message(tables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
  });
  const attributed = attributeFailure(
    simulation.value.logs,
    simulation.value.err
  );
  const result: Record<string, unknown> = {
    label: mutateBuildQuote
      ? "BONK-build-quote-mutated-after-response"
      : forceUnattainableFloor
      ? "BONK-unattainable-order-floor-rollback"
      : "BONK-order-floor-build-route",
    orderRole: mutateBuildQuote ? "comparison-only" : "fair-price-floor-only",
    executionRole: "fee-free-jupiter-build-cpi",
    buildQuoteMutatedAfterResponse: mutateBuildQuote,
    orderRouter: order.router,
    orderRoute: order.routePlan.map((hop) => hop.swapInfo?.label),
    orderFeeBps: order.feeBps,
    orderMinimumOutput: orderFloor.toString(),
    buildResponseMinimumOutput: builtLeg.minimumOutput.toString(),
    buildInstructionMinimumOutput: leg.minimumOutput.toString(),
    fairMinimumOutput: fairFloor.toString(),
    enforcedMinimumOutput: enforcedFloor.toString(),
    buildRoute: leg.routeLabel,
    buildEmbeddedFeeBps: leg.jupiterData.readUInt16LE(
      platformFeeOffset(leg.jupiterData)
    ),
    vault: pda.toBase58(),
    txBytes: transaction.serialize().length,
    unitsConsumed: simulation.value.unitsConsumed,
    simulationError: simulation.value.err,
    burnerError: attributed.isBurner ? attributed.code : undefined,
    logs: simulation.value.err ? simulation.value.logs?.slice(-22) : undefined,
  };
  if (!simulation.value.err) {
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, maxRetries: 3 }
    );
    await connection.confirmTransaction(
      { signature, ...validity },
      "confirmed"
    );
    const after = await connection.getBalance(pda, "confirmed");
    const target = await getAccount(
      connection,
      targetAta,
      "confirmed",
      targetProgram
    );
    result.signature = signature;
    result.vaultSpent = funded - after;
    result.targetAtaAfter = target.amount.toString();
    result.burned = target.amount === 0n;
  } else {
    const after = await connection.getBalance(pda, "confirmed");
    const target = await getAccount(
      connection,
      targetAta,
      "confirmed",
      targetProgram
    );
    result.vaultUnchanged = after === funded;
    result.targetAtaAfter = target.amount.toString();
  }
  if (forceUnattainableFloor && !mutateBuildQuote) {
    if (
      !simulation.value.err ||
      !attributed.isBurner ||
      attributed.code !== 6021 ||
      result.vaultUnchanged !== true ||
      result.targetAtaAfter !== "0"
    ) {
      throw new Error(
        `unattainable floor did not atomically roll back: ${JSON.stringify(
          result
        )}`
      );
    }
  } else if (
    simulation.value.err ||
    result.vaultSpent !== Number(AMOUNT) ||
    result.burned !== true
  ) {
    throw new Error(`order-floor burn failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function main() {
  if (process.env.FORK_DEX_PROFILE !== "pool") {
    throw new Error("set FORK_DEX_PROFILE=pool for this Surfpool measurement");
  }
  const connection = new Connection(RPC_URL, "confirmed");
  const results = [];
  if (process.env.ORDER_CASES === "mutation-only") {
    results.push(
      await runCase(
        connection,
        JUP_MINT,
        "JUP-order-quote-mutated",
        false,
        true
      )
    );
  } else if (process.env.ORDER_CASES === "build-mutation-only") {
    results.push(await runOrderFloorBuildCase(connection, false, true));
  } else if (process.env.ORDER_CASES !== "floor-only") {
    results.push(await runCase(connection, JUP_MINT, "JUP-exact-order"));
    results.push(await runCase(connection, TOKENS.BONK, "BONK-exact-order"));
    results.push(
      await runCase(connection, TOKENS.BONK, "BONK-fee-normalized", true)
    );
  }
  if (
    process.env.ORDER_CASES !== "mutation-only" &&
    process.env.ORDER_CASES !== "build-mutation-only"
  ) {
    results.push(await runOrderFloorBuildCase(connection));
    results.push(await runOrderFloorBuildCase(connection, true));
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
