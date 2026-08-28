/**
 * The shipping configuration, end to end: the user picks ONE token, we fix the
 * other two legs as $PUMP and NEIRO.
 *
 * Two separate budgets are checked, because they fail for different reasons
 * and at different times:
 *
 *   CREATION -- the one-shot atomic setup transaction
 *     [createFeeSharingConfig][updateFeeSharesV2][validate_config][create ATAs]
 *     against the 1232-byte wire limit. This is the transaction that must not
 *     split, because the Pump fee share is irreversible (0x1779 on every
 *     re-point) and must only commit alongside proof the vault is admissible.
 *
 *   BURN -- the real swap-and-burn, which is a different and usually WIDER
 *     transaction because it carries live Jupiter routes. It is measured by
 *     actually running it, not by planning it.
 *
 * The user's token is leg 0 AND the launch-mint namespace, which is the cheap
 * shape: the launch mint is already an account in the setup transaction, so
 * naming it as a target adds only its ATA rather than another 32-byte lock.
 *
 * $PUMP is deliberately included: it is Token-2022 and routes multi-hop as
 * `shared_accounts_route_v2`, so it exercises the widest leg the product ships.
 */
import { Connection, PublicKey, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  deriveSplitPda,
  Leg,
  PROGRAM,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const { PUMP_SDK } = require("@pump-fun/pump-sdk");
const VALIDATE_CONFIG_DISCRIMINATOR = Buffer.from([28, 98, 92, 82, 243, 62, 65, 93]);
const MAX_TRANSACTION_BYTES = 1232;

/** The two legs the product fixes for every vault. */
const FIXED_LEGS = [
  { label: "PUMP", mint: TOKENS.PUMP },
  { label: "NEIRO", mint: TOKENS.NEIRO },
];

/**
 * The user's token. A brand-new Pump mint has no Jupiter route at all until
 * Jupiter indexes it, so a fresh fork launch cannot be BURNED — that is a
 * Jupiter indexing property, not a burner limitation. A live, routable Pump
 * token stands in for "the user's token once it is tradable", which is the
 * only state in which a burn is meaningful.
 */
const USER_TOKENS = [
  { label: "FARTCOIN", mint: TOKENS.FARTCOIN },   // pump-launched, legacy SPL
  { label: "BONK", mint: TOKENS.BONK },           // legacy SPL, deep liquidity
  { label: "WIF", mint: TOKENS.WIF },             // legacy SPL
  { label: "JTO", mint: TOKENS.JTO },             // legacy SPL, governance
  { label: "POPCAT", mint: TOKENS.POPCAT },       // legacy SPL
  { label: "RAY", mint: TOKENS.RAY },             // legacy SPL, AMM-native
];

/** Weight splits worth checking: the flagship, even, and both extremes. */
const SPLITS: { name: string; bps: [number, number, number] }[] = [
  { name: "flagship 70/15/15", bps: [7000, 1500, 1500] },
  { name: "even 34/33/33", bps: [3400, 3300, 3300] },
  { name: "user-heavy 90/5/5", bps: [9000, 500, 500] },
  { name: "user-light 10/45/45", bps: [1000, 4500, 4500] },
  { name: "half 50/25/25", bps: [5000, 2500, 2500] },
];

function measureMessage(message: any): number {
  const keys = message.staticAccountKeys.length;
  let instructionBytes = 0;
  for (const compiled of message.compiledInstructions) {
    instructionBytes +=
      1 + 1 + compiled.accountKeyIndexes.length + 1 + compiled.data.length;
  }
  // 2 signatures + header + shortvec(keys) + keys + blockhash + shortvec(ix) + ix + ALT byte
  return 1 + 2 * 64 + 3 + 1 + keys * 32 + 32 + 1 + instructionBytes + 1;
}

function validateConfigInstruction(
  vault: PublicKey,
  wsolAta: PublicKey,
  launchMint: PublicKey,
  legs: Leg[],
  tokenPrograms: PublicKey[]
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 2 * legs.length);
  VALIDATE_CONFIG_DISCRIMINATOR.copy(data, 0);
  data.writeUInt32LE(legs.length, 8);
  legs.forEach((leg, i) => data.writeUInt16LE(leg.bps, 12 + 2 * i));
  const keys = [
    { pubkey: vault, isSigner: false, isWritable: false },
    { pubkey: wsolAta, isSigner: false, isWritable: false },
    { pubkey: launchMint, isSigner: false, isWritable: false },
  ];
  legs.forEach((leg, i) => {
    keys.push({ pubkey: leg.mint, isSigner: false, isWritable: false });
    keys.push({
      pubkey: getAssociatedTokenAddressSync(leg.mint, vault, true, tokenPrograms[i]),
      isSigner: false,
      isWritable: false,
    });
    keys.push({ pubkey: tokenPrograms[i], isSigner: false, isWritable: false });
  });
  return new TransactionInstruction({ programId: PROGRAM, keys, data });
}

async function measureCreation(
  connection: Connection,
  payer: PublicKey,
  launchMint: PublicKey,
  legs: Leg[],
  tokenPrograms: PublicKey[]
): Promise<{ bytes: number; locks: number; fits: boolean }> {
  const [vault] = deriveSplitPda(launchMint, legs);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  const instructions: TransactionInstruction[] = [
    await PUMP_SDK.createFeeSharingConfig({ creator: payer, mint: launchMint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: payer,
      mint: launchMint,
      currentShareholders: [payer],
      newShareholders: [{ address: vault, shareBps: 10_000 }],
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
    validateConfigInstruction(vault, wsolAta, launchMint, legs, tokenPrograms),
    createAssociatedTokenAccountIdempotentInstruction(payer, wsolAta, vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
    ...legs.map((leg, i) =>
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        getAssociatedTokenAddressSync(leg.mint, vault, true, tokenPrograms[i]),
        vault,
        leg.mint,
        tokenPrograms[i]
      )
    ),
  ];
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const bytes = measureMessage(message);
  return { bytes, locks: message.staticAccountKeys.length, fits: bytes <= MAX_TRANSACTION_BYTES };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const burnSol = process.env.BURN_SOL ?? "0.3";

  const programOf = async (mint: PublicKey) => {
    const info = await connection.getAccountInfo(mint, "confirmed");
    if (!info) throw new Error(`${mint.toBase58()} not on this cluster`);
    return info.owner;
  };
  const fixedPrograms = [await programOf(FIXED_LEGS[0].mint), await programOf(FIXED_LEGS[1].mint)];
  console.log(`fixed legs $PUMP + NEIRO | flagship 70/15/15 | ${burnSol} SOL per case\n`);

  const rows: any[] = [];
  for (const USER_TOKEN of USER_TOKENS) {
    const split = SPLITS[0]; // flagship 70/15/15; weights provably do not affect size
    const legs: Leg[] = [
      { label: USER_TOKEN.label, mint: USER_TOKEN.mint, bps: split.bps[0] },
      { label: FIXED_LEGS[0].label, mint: FIXED_LEGS[0].mint, bps: split.bps[1] },
      { label: FIXED_LEGS[1].label, mint: FIXED_LEGS[1].mint, bps: split.bps[2] },
    ];

    const tokenPrograms = [await programOf(USER_TOKEN.mint), ...fixedPrograms];
    // The user's token is also the launch-mint namespace, exactly as shipped.
    const creation = await measureCreation(
      connection, payer.publicKey, USER_TOKEN.mint, legs, tokenPrograms);

    const burn = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `three-${USER_TOKEN.label}`,
      USER_TOKEN.mint,
      legs,
      burnSol,
      { fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );

    const burnerFault = burn.status !== "burned" && burn.rejectedBy === "burner";
    rows.push({
      split: `${USER_TOKEN.label} 70/15/15`,
      creationBytes: creation.bytes,
      creationLocks: creation.locks,
      creationFits: creation.fits,
      burnStatus: burn.status,
      burnBytes: burn.txBytes,
      burnLocks: burn.accountLocks,
      cu: burn.computeUnits,
      code: burn.errorCode,
      by: burn.rejectedBy,
      burnerFault,
      signature: burn.signature,
      burned: burn.burned,
      detail: burn.detail,
    });

    console.log(
      `  ${USER_TOKEN.label.padEnd(10)} ` +
        `creation ${String(creation.bytes).padStart(4)}B/${String(creation.locks).padStart(2)} ${creation.fits ? "FITS " : "OVER "} | ` +
        `burn ${burn.status.padEnd(8)} ${String(burn.txBytes ?? "-").padStart(4)}B/${String(burn.accountLocks ?? "-").padStart(2)} ` +
        `${burn.computeUnits ? `${burn.computeUnits}cu` : ""}` +
        (burnerFault ? `  <-- BURNER FAULT ${burn.errorCode}` : burn.status !== "burned" ? `  (${burn.errorCode ?? ""} ${burn.rejectedBy ?? ""})` : "")
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const burned = rows.filter((r) => r.burnStatus === "burned");
  const creationFits = rows.filter((r) => r.creationFits);
  const faults = rows.filter((r) => r.burnerFault);
  console.log(
    `\ncreation fits atomically: ${creationFits.length}/${rows.length}` +
      `   burns landed: ${burned.length}/${rows.length}` +
      `   burner-attributed failures: ${faults.length}`
  );
  if (burned.length) {
    const widest = burned.reduce((a, b) => ((b.burnBytes ?? 0) > (a.burnBytes ?? 0) ? b : a));
    console.log(
      `widest landed burn: ${widest.burnBytes}B / ${widest.burnLocks} locks / ${widest.cu}cu (${widest.split})`
    );
  }
  require("fs").writeFileSync("/tmp/three-leg-product.json", JSON.stringify(rows, null, 2));
  process.exit(faults.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
