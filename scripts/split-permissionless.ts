/**
 * The permissionless property: anyone can make the burn happen, whenever they
 * want, and it works.
 *
 * The caller here is a keypair generated in this run. It did not create the
 * launch, did not configure the split, does not own the vault, and holds
 * nothing but enough SOL for transaction fees. It builds a burn, signs as
 * the sole required signer, submits, and the burn lands.
 *
 * Then the same stranger mutates the signed bytes; that must fail as a
 * signature failure, with the vault untouched.
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
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
  RPC_URL,
  runSplitCase,
  sendInstructions,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const LAUNCH = TOKENS.FARTCOIN;
const LEGS: Leg[] = [
  { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
  { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
  { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
];

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const launcher = readPayer();
  const report: any = {};

  // A wallet that has never touched this system before.
  const stranger = Keypair.generate();
  await sendInstructions(connection, launcher, "fund-stranger", [
    SystemProgram.transfer({
      fromPubkey: launcher.publicKey,
      toPubkey: stranger.publicKey,
      lamports: solToLamports("0.05"),
    }),
  ]);
  report.stranger = stranger.publicKey.toBase58();
  report.strangerFundedWith = "0.05 SOL, for transaction fees only";

  // ---- 1. the stranger burns a vault set up entirely by someone else -----
  const burned = await runSplitCase(
    connection,
    launcher,
    launcher,
    "permissionless-stranger-burn",
    LAUNCH,
    LEGS,
    "0.4",
    { burnCaller: stranger }
  );
  report.strangerBurn = burned;
  console.error(
    `stranger burn: ${burned.status} ${burned.computeUnits ?? "?"}cu ${(burned.burned ?? []).join(" ")}`
  );

  // ---- 2. the same stranger, without the quote service ------------------
  // Set up a second, independent vault so the negative cases have funds and
  // cannot be confused with leftovers from the first burn.
  const [pda] = deriveSplitPda(TOKENS.POPCAT, LEGS);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      launcher.publicKey,
      wsolAta,
      pda,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
  ];
  for (const leg of LEGS) {
    const info = await connection.getAccountInfo(leg.mint, "confirmed");
    if (!info) throw new Error(`mint ${leg.label} missing`);
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        launcher.publicKey,
        getAssociatedTokenAddressSync(leg.mint, pda, true, info.owner),
        pda,
        leg.mint,
        info.owner
      )
    );
  }
  await sendInstructions(connection, launcher, "permissionless-atas", ataIxs);
  const total = solToLamports("0.4");
  await sendInstructions(connection, launcher, "permissionless-fund", [
    SystemProgram.transfer({
      fromPubkey: launcher.publicKey,
      toPubkey: pda,
      lamports: total * 2n,
    }),
  ]);

  const legs = await prepareLegs(
    connection,
    launcher,
    pda,
    wsolAta,
    LEGS,
    total,
    Number(process.env.FORK_SLIPPAGE_BPS ?? "1500"),
    16
  );
  const vaultTable = await createVaultLookupTable(
    connection,
    launcher,
    "permissionless",
    pda,
    wsolAta,
    TOKENS.POPCAT,
    legs
  );
  const lookupTables = await getLookupTables(connection, [
    ...new Set([
      ...legs.flatMap((leg) => leg.lookupTables),
      (await ensureSharedLookupTable(connection, launcher)).toBase58(),
      vaultTable.toBase58(),
    ]),
  ]);

  async function strangerAttempt(
    label: string,
    overrides?: Parameters<typeof buildSplitInstruction>[7]
  ) {
    const lamportsBefore = await connection.getBalance(pda, "confirmed");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: stranger.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        buildSplitInstruction(
          stranger.publicKey,
          stranger.publicKey,
          pda,
          wsolAta,
          TOKENS.POPCAT,
          legs,
          total,
          overrides
        ),
      ],
    }).compileToV0Message(lookupTables);
    let transaction = new VersionedTransaction(message);
    transaction.sign([stranger]);

    let outcome: any = { label };
    try {
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: true,
      });
      if (!simulation.value.err) {
        outcome.result = "ACCEPTED";
        outcome.computeUnits = simulation.value.unitsConsumed;
      } else {
        const attributed = attributeFailure(
          simulation.value.logs,
          simulation.value.err
        );
        outcome.result = "rejected";
        outcome.code = attributed.code;
        outcome.codeName = attributed.code ? ERROR_NAMES[attributed.code] : undefined;
        outcome.by = attributed.isBurner ? "burner" : attributed.programId ?? "runtime";
      }
    } catch (error) {
      outcome.result = "rejected";
      outcome.by = "runtime";
      outcome.detail =
        error instanceof Error ? error.message.slice(0, 140) : String(error);
    }
    outcome.vaultUnchanged =
      lamportsBefore === (await connection.getBalance(pda, "confirmed"));
    console.error(
      `${label}: ${outcome.result} ${outcome.code ?? outcome.by ?? ""} ${outcome.codeName ?? ""}`
    );
    return outcome;
  }

  report.tamperedAfterSigning = await (async () => {
    const lamportsBefore = await connection.getBalance(pda, "confirmed");
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: stranger.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        buildSplitInstruction(
          stranger.publicKey,
          stranger.publicKey,
          pda,
          wsolAta,
          TOKENS.POPCAT,
          legs,
          total
        ),
      ],
    }).compileToV0Message(lookupTables);
    const transaction = new VersionedTransaction(message);
    transaction.sign([stranger]);

    const burnerIx = transaction.message.compiledInstructions[1];
    burnerIx.data[burnerIx.data.length - 1] ^= 0xff;

    const outcome: any = { label: "route-changed-after-signing" };
    try {
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: true,
      });
      outcome.result = simulation.value.err ? "rejected" : "ACCEPTED";
      outcome.err = JSON.stringify(simulation.value.err ?? null).slice(0, 120);
    } catch (error) {
      outcome.result = "rejected";
      outcome.err =
        error instanceof Error ? error.message.slice(0, 140) : String(error);
    }
    outcome.signatureRejected = /signature/i.test(outcome.err ?? "");
    outcome.vaultUnchanged =
      lamportsBefore === (await connection.getBalance(pda, "confirmed"));
    console.error(
      `route-changed-after-signing: ${outcome.result} signatureRejected=${outcome.signatureRejected}`
    );
    return outcome;
  })();

  report.strangerCanBurnAgain = await strangerAttempt("same-stranger-second-burn");

  console.log(JSON.stringify(report, null, 2));
  const ok =
    burned.status === "burned" &&
    report.tamperedAfterSigning.result === "rejected" &&
    report.tamperedAfterSigning.signatureRejected &&
    report.tamperedAfterSigning.vaultUnchanged &&
    report.strangerCanBurnAgain.result === "ACCEPTED";
  console.error(ok ? "\npermissionless properties hold" : "\nFAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
