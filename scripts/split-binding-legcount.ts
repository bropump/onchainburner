/**
 * On-chain confirmation of the split vault's leg-count binding (attack 3).
 *
 * `split-negative.ts` already proves on a funded fork vault that reweighting
 * (6012), reordering (6012), and mint substitution (6012) are pinned out with
 * the vault untouched. The one binding dimension it does not exercise on chain
 * is a change to the NUMBER of legs, because its single funded vault is 3-leg
 * and every case keeps that shape.
 *
 * This closes that gap. It funds one immutable 3-leg vault and then presents it
 * with a 2-leg burn and a 4-leg burn — same launch namespace, overlapping
 * targets — each of which derives a DIFFERENT address (`6 + 32 + 34n` is
 * injective in `n`) and must therefore be refused with 6012 InvalidBurnPda,
 * with the vault's lamports byte-identical afterwards.
 *
 * Pass criteria are the strict ones: the BURNER (attributed by the innermost
 * `Program <id> failed` frame, never Jupiter or an AMM) must reject with
 * exactly 6012, and nothing may move. Run with FORK_DEX_PROFILE=pool.
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
  PROGRAM,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  sendInstructions,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const LAUNCH = TOKENS.FARTCOIN;

// The funded, immutable 3-leg vault every attack starts from.
const FUNDED: Leg[] = [
  { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
  { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
  { label: "BONK", mint: TOKENS.BONK, bps: 1500 },
];

// A 4th mint whose ATA is also pre-created on the vault so a grow-a-leg route
// can be built and actually reach the program.
const EXTRA_MINT = TOKENS.WIF;

const TOTAL = solToLamports("0.3");
const SLIPPAGE = Number(process.env.FORK_SLIPPAGE_BPS ?? "1500");
const MAX_ACCOUNTS = 16;

type Case = { name: string; legs: Leg[] };

const CASES: Case[] = [
  {
    // Drop the minority BONK leg; the remaining two are reweighted to a valid
    // sum. Two mints + a 2-weight blob derive a different, unfunded address.
    name: "drop-to-2-legs",
    legs: [
      { label: "NEIRO", mint: TOKENS.NEIRO, bps: 3000 },
      { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
    ],
  },
  {
    // Append a WIF leg; four mints + a 4-weight blob derive a different,
    // unfunded address.
    name: "grow-to-4-legs",
    legs: [
      { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
      { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
      { label: "BONK", mint: TOKENS.BONK, bps: 500 },
      { label: "WIF", mint: EXTRA_MINT, bps: 1000 },
    ],
  },
];

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const [vault] = deriveSplitPda(LAUNCH, FUNDED);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );

  // Create the vault's WSOL ATA plus a target ATA for every mint any case
  // routes to (the funded three plus WIF), so prepareLegs can build routes.
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      wsolAta,
      vault,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
  ];
  const allMints = [TOKENS.NEIRO, TOKENS.JTO, TOKENS.BONK, EXTRA_MINT];
  for (const mint of allMints) {
    const info = await connection.getAccountInfo(mint, "confirmed");
    if (!info) throw new Error(`mint ${mint.toBase58()} missing on fork`);
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        getAssociatedTokenAddressSync(mint, vault, true, info.owner),
        vault,
        mint,
        info.owner
      )
    );
  }
  await sendInstructions(connection, payer, "legcount-atas", ataIxs);

  // Fund the 3-leg vault generously; no case should move any of it.
  await sendInstructions(connection, payer, "legcount-fund", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: vault,
      lamports: TOTAL * 4n,
    }),
  ]);

  const sharedTable = await ensureSharedLookupTable(connection, payer);

  const results: any[] = [];
  for (const testCase of CASES) {
    const outcome: any = { name: testCase.name, expect: 6012 };
    try {
      // Build the tampered instruction against the FUNDED 3-leg vault.
      const prepared = await prepareLegs(
        connection,
        payer,
        vault,
        wsolAta,
        testCase.legs,
        TOTAL,
        SLIPPAGE,
        MAX_ACCOUNTS
      );
      const vaultTable = await createVaultLookupTable(
        connection,
        payer,
        `legcount-${testCase.name}`,
        vault,
        wsolAta,
        LAUNCH,
        prepared
      );
      const lookupTables = await getLookupTables(connection, [
        ...new Set([
          ...prepared.flatMap((leg) => leg.lookupTables),
          sharedTable.toBase58(),
          vaultTable.toBase58(),
        ]),
      ]);

      const instruction = buildSplitInstruction(
        payer.publicKey,
        quoteAuthority.publicKey,
        vault,
        wsolAta,
        LAUNCH,
        prepared,
        TOTAL
      );

      const lamportsBefore = await connection.getBalance(vault, "confirmed");
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
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
        replaceRecentBlockhash: false,
      });

      if (!simulation.value.err) {
        outcome.result = "ACCEPTED";
      } else {
        const attributed = attributeFailure(
          simulation.value.logs,
          simulation.value.err
        );
        outcome.result = "rejected";
        outcome.code = attributed.code;
        outcome.codeName = attributed.code
          ? ERROR_NAMES[attributed.code]
          : undefined;
        outcome.by = attributed.isBurner
          ? "burner"
          : attributed.programId ?? "runtime";
      }

      const lamportsAfter = await connection.getBalance(vault, "confirmed");
      outcome.vaultUnchanged = lamportsBefore === lamportsAfter;
      outcome.derivedPda = deriveSplitPda(LAUNCH, testCase.legs)[0].toBase58();
    } catch (error) {
      // A client-side throw is NOT a burner rejection; record it as an error so
      // it can never be mistaken for a pass.
      outcome.result = "error";
      outcome.detail =
        error instanceof Error ? error.message.slice(0, 200) : String(error);
    }

    outcome.pass =
      outcome.result === "rejected" &&
      outcome.by === "burner" &&
      outcome.code === 6012 &&
      outcome.vaultUnchanged === true;

    results.push(outcome);
    process.stderr.write(
      `${outcome.pass ? "PASS" : "FAIL"}  ${testCase.name} -> ${
        outcome.code ?? outcome.result
      } ${outcome.codeName ?? outcome.by ?? ""} ` +
        `(vaultUnchanged=${outcome.vaultUnchanged})\n`
    );
  }

  console.log(JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.error(`\n${passed}/${results.length} leg-count attacks pinned out with 6012`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
