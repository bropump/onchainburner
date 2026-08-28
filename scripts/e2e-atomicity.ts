/**
 * e2e verification: ATOMICITY. When one leg of a multi-leg burn fails, the
 * whole transaction reverts and the vault is untouched.
 *
 * Method: build a real, fully-routable 3-leg burn, then raise the MIDDLE
 * leg's signed minimum-output beyond any achievable fill so that leg 1 fails
 * 6021 (SlippageExceeded) AFTER leg 0 has already swapped-and-burned inside
 * the same instruction. Read the vault's lamports and every target ATA (and
 * the WSOL ATA) before and after. Because the runtime rolls back the whole
 * transaction on any leg's revert, all balances must be byte-identical
 * afterwards, and the vault must have spent nothing.
 *
 * The failure is attributed to the burner's own program-id log frame: only a
 * 6021 raised by the burner (not by Jupiter or an AMM) counts.
 */
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
  ERROR_NAMES,
  getLookupTables,
  Leg,
  prepareLegs,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  sendInstructions,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const LAUNCH = TOKENS.FARTCOIN;
const LEGS: Leg[] = [
  { label: "JTO", mint: TOKENS.JTO, bps: 3400 },
  { label: "NEIRO", mint: TOKENS.NEIRO, bps: 3300 },
  { label: "BONK", mint: TOKENS.BONK, bps: 3300 },
];
const TOTAL = solToLamports("0.5");

async function readState(
  connection: Connection,
  pda: PublicKey,
  wsolAta: PublicKey,
  legs: Awaited<ReturnType<typeof prepareLegs>>
) {
  const lamports = BigInt(await connection.getBalance(pda, "confirmed"));
  const wsol = await getAccount(connection, wsolAta, "confirmed", TOKEN_PROGRAM_ID)
    .then((a) => a.amount)
    .catch(() => 0n);
  const atas: Record<string, bigint> = {};
  for (const leg of legs) {
    atas[leg.label] = await getAccount(
      connection,
      leg.ata,
      "confirmed",
      leg.tokenProgram
    )
      .then((a) => a.amount)
      .catch(() => 0n);
  }
  return { lamports, wsol, atas };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const [pda] = deriveSplitPda(LAUNCH, LEGS);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );

  // Create the vault's ATAs and fund it.
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      wsolAta,
      pda,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
  ];
  for (const leg of LEGS) {
    const info = await connection.getAccountInfo(leg.mint, "confirmed");
    if (!info) throw new Error(`mint ${leg.label} missing on fork`);
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        getAssociatedTokenAddressSync(leg.mint, pda, true, info.owner),
        pda,
        leg.mint,
        info.owner
      )
    );
  }
  await sendInstructions(connection, payer, "atomicity-atas", ataIxs);
  await sendInstructions(connection, payer, "atomicity-fund", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: pda,
      lamports: TOTAL,
    }),
  ]);

  const prepared = await prepareLegs(
    connection,
    payer,
    pda,
    wsolAta,
    LEGS,
    TOTAL,
    1500,
    16
  );

  const vaultTable = await createVaultLookupTable(
    connection,
    payer,
    "atomicity",
    pda,
    wsolAta,
    LAUNCH,
    prepared
  );
  const lookupTables = await getLookupTables(connection, [
    ...new Set([
      ...prepared.flatMap((leg) => leg.lookupTables),
      (await ensureSharedLookupTable(connection, payer)).toBase58(),
      vaultTable.toBase58(),
    ]),
  ]);

  const before = await readState(connection, pda, wsolAta, prepared);

  // Sabotage ONLY the middle leg: demand more output than any fill can give.
  const minimumOutputOverride = prepared.map((leg, index) =>
    index === 1 ? (1n << 63n) : leg.minimumOutput
  );
  const instruction = buildSplitInstruction(
    payer.publicKey,
    quoteAuthority.publicKey,
    pda,
    wsolAta,
    LAUNCH,
    prepared,
    TOTAL,
    { minimumOutputOverride }
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      instruction,
    ],
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, quoteAuthority]);

  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
  });
  const attributed = attributeFailure(
    simulation.value.logs,
    simulation.value.err
  );

  // Confirm the burn log order: leg 0 (JTO) burns, then leg 1 fails, so only
  // ONE `log_burn` line (0x0-tagged) should appear before the revert.
  const burnLogs = (simulation.value.logs ?? []).filter((line) =>
    /^Program log: 0x0, 0x0, 0x0, 0x[0-9a-f]+, 0x[0-9a-f]+$/.test(line)
  );

  // Send it too, so the assertion is against committed chain state, not only
  // a simulation. It must land as a failed (reverted) transaction.
  let landedErr: unknown = simulation.value.err;
  let sendRejected = true;
  try {
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: true, maxRetries: 3 }
    );
    const conf = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    landedErr = conf.value.err;
    sendRejected = conf.value.err !== null;
  } catch {
    sendRejected = true;
  }

  const after = await readState(connection, pda, wsolAta, prepared);

  const vaultUnchanged = before.lamports === after.lamports;
  const wsolUnchanged = before.wsol === after.wsol;
  const atasUnchanged = LEGS.every(
    (leg) => before.atas[leg.label] === after.atas[leg.label]
  );
  const burnerRejected = attributed.isBurner && attributed.code === 6021;

  const report = {
    vault: pda.toBase58(),
    total: TOTAL.toString(),
    sabotagedLeg: LEGS[1].label,
    rejectedBy: attributed.isBurner ? "burner" : attributed.programId ?? "?",
    errorCode: attributed.code,
    errorName: attributed.code ? ERROR_NAMES[attributed.code] : undefined,
    burnLogLinesBeforeRevert: burnLogs.length,
    before: {
      lamports: before.lamports.toString(),
      wsol: before.wsol.toString(),
      atas: Object.fromEntries(
        Object.entries(before.atas).map(([k, v]) => [k, v.toString()])
      ),
    },
    after: {
      lamports: after.lamports.toString(),
      wsol: after.wsol.toString(),
      atas: Object.fromEntries(
        Object.entries(after.atas).map(([k, v]) => [k, v.toString()])
      ),
    },
    vaultUnchanged,
    wsolUnchanged,
    atasUnchanged,
    transactionReverted: sendRejected && landedErr !== null,
    burnerRejectedWith6021: burnerRejected,
  };
  console.log(JSON.stringify(report, null, 2));

  const ok =
    burnerRejected &&
    vaultUnchanged &&
    wsolUnchanged &&
    atasUnchanged &&
    report.transactionReverted;
  console.error(
    `\natomicity: middle leg ${LEGS[1].label} forced to fail -> ` +
      `burner ${burnerRejected ? "rejected 6021" : "did NOT reject 6021"}, ` +
      `vault ${vaultUnchanged ? "UNCHANGED" : "CHANGED"}, ` +
      `all ATAs ${atasUnchanged ? "UNCHANGED" : "CHANGED"}, ` +
      `tx ${report.transactionReverted ? "reverted" : "did NOT revert"}. ${ok ? "PASS" : "FAIL"}`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
