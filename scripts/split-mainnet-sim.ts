/**
 * e2e verification: LIVE-mainnet readiness of `swap_and_burn_split` under the
 * Jupiter V2 regime the deployed program actually enforces.
 *
 * This REPLACES the pre-V2 checker that lived under this name: that one
 * requested `/swap/v1` routes and asserted the v1 `route` discriminator and
 * the v1 platform-fee `None` sentinel — an instruction shape the deployed
 * program now refuses (6005), so it ran green while testing something that
 * no longer exists. This script checks the v2 guards, byte-for-byte the same checks
 * `validate_jupiter_route` performs on chain (mirrored from the audited
 * client-side `assertV2Build` in surfpool-split-e2e.ts):
 *
 *   - discriminator is route_v2 OR shared_accounts_route_v2
 *   - the embedded in_amount equals the per-leg amount the program derives
 *   - platform_fee_bps AND positive_slippage_fee_bps are zero
 *   - account pins per variant (authority=PDA, source=vault WSOL ATA,
 *     destination=vault target ATA, source/destination mints, both token
 *     programs, pinned JUPITER_EVENT_AUTHORITY, Jupiter program id)
 *   - no route account is a signer other than the burn PDA
 *   - exact split arithmetic reconstructs the total
 *   - the complete signed-size transaction fits 1232 bytes / 64 locks when
 *     compiled with the same ALT layout production uses (Jupiter's own
 *     tables plus a synthetic vault+shared table whose contents mirror what
 *     the launcher builds on chain).
 *
 * Read-only: quotes are requested from Jupiter and mainnet accounts are
 * read; NOTHING is signed for value and NOTHING is sent anywhere.
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  buildSplitInstruction,
  deriveSplitPda,
  fetchJson,
  PreparedLeg,
  PROGRAM,
  JUPITER_PROGRAM,
  splitAmounts,
  TOKENS,
} from "./surfpool-split-e2e";

const MAINNET =
  process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const JUPITER_API = process.env.JUPITER_API_URL ?? "https://api.jup.ag/swap/v2";
const JUPITER_EVENT_AUTHORITY = new PublicKey(
  "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
);
const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";
const MAX_TRANSACTION_BYTES = 1232;
const MAX_LOCKS = 64;

type LegSpec = { label: string; mint: PublicKey; bps: number };

type LegCheck = {
  leg: string;
  ok: boolean;
  variant?: string;
  venues?: string;
  tokenProgram?: string;
  routeAccounts?: number;
  slippageBps?: number;
  pins?: Record<string, boolean>;
  foreignSigners?: string[];
  reason?: string;
};

/** The exact per-variant validation the program performs, applied to a live build. */
function checkV2Build(
  build: any,
  pda: PublicKey,
  wsolAta: PublicKey,
  targetMint: PublicKey,
  targetAta: PublicKey,
  targetTokenProgram: PublicKey,
  amountIn: bigint
): LegCheck {
  const out: LegCheck = { leg: "", ok: false };
  if (build.error) {
    out.reason = `build failed: ${String(build.error).slice(0, 100)}`;
    return out;
  }
  if (build.swapMode !== "ExactIn" || BigInt(build.inAmount) !== amountIn) {
    out.reason = `input changed: mode=${build.swapMode} amount=${build.inAmount}`;
    return out;
  }
  if (build.swapInstruction?.programId !== JUPITER_PROGRAM.toBase58()) {
    out.reason = "non-Jupiter swap instruction";
    return out;
  }
  const data = Buffer.from(build.swapInstruction.data, "base64");
  const discriminator = data.subarray(0, 8).toString("hex");
  const shared = discriminator === SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR;
  if (!shared && discriminator !== ROUTE_V2_DISCRIMINATOR) {
    out.reason = `not a v2 route: ${discriminator}`;
    return out;
  }
  out.variant = shared ? "shared_accounts_route_v2" : "route_v2";
  const offsets = shared
    ? {
        input: 9,
        platformFee: 27,
        positiveSlippageFee: 29,
        authority: 1,
        source: 2,
        destination: 5,
        sourceMint: 6,
        destinationMint: 7,
        sourceTokenProgram: 8,
        destinationTokenProgram: 9,
        eventAuthority: 10,
        program: 11,
      }
    : {
        input: 8,
        platformFee: 26,
        positiveSlippageFee: 28,
        authority: 0,
        source: 1,
        destination: 2,
        sourceMint: 3,
        destinationMint: 4,
        sourceTokenProgram: 5,
        destinationTokenProgram: 6,
        eventAuthority: 8,
        program: 9,
      };
  const accounts = build.swapInstruction.accounts;
  const at = (i: number) => accounts[i]?.pubkey;
  const pins: Record<string, boolean> = {
    inputAmountExact: data.readBigUInt64LE(offsets.input) === amountIn,
    platformFeeZero: data.readUInt16LE(offsets.platformFee) === 0,
    positiveSlippageFeeZero:
      data.readUInt16LE(offsets.positiveSlippageFee) === 0,
    authorityIsPda: at(offsets.authority) === pda.toBase58(),
    sourceIsWsolAta: at(offsets.source) === wsolAta.toBase58(),
    destinationIsTargetAta: at(offsets.destination) === targetAta.toBase58(),
    sourceMintIsWsol: at(offsets.sourceMint) === NATIVE_MINT.toBase58(),
    destinationMintIsTarget:
      at(offsets.destinationMint) === targetMint.toBase58(),
    sourceTokenProgram:
      at(offsets.sourceTokenProgram) === TOKEN_PROGRAM_ID.toBase58(),
    destinationTokenProgram:
      at(offsets.destinationTokenProgram) === targetTokenProgram.toBase58(),
    eventAuthorityPinned:
      at(offsets.eventAuthority) === JUPITER_EVENT_AUTHORITY.toBase58(),
    programPinned: at(offsets.program) === JUPITER_PROGRAM.toBase58(),
  };
  if (!shared) {
    pins.directDestinationSlot7 = at(7) === targetAta.toBase58();
  }
  const foreignSigners = accounts
    .filter((a: any) => a.isSigner && a.pubkey !== pda.toBase58())
    .map((a: any) => a.pubkey);
  out.pins = pins;
  out.foreignSigners = foreignSigners;
  out.ok = Object.values(pins).every(Boolean) && foreignSigners.length === 0;
  if (!out.ok && !out.reason) out.reason = "pin failure";
  return out;
}

async function buildLeg(
  connection: Connection,
  pda: PublicKey,
  wsolAta: PublicKey,
  leg: LegSpec,
  amount: bigint,
  maxAccounts?: number
): Promise<{ check: LegCheck; prepared?: PreparedLeg; build?: any }> {
  const mintInfo = await connection.getAccountInfo(leg.mint, "confirmed");
  if (!mintInfo) {
    return {
      check: { leg: leg.label, ok: false, reason: "mint not on mainnet" },
    };
  }
  const tokenProgram = mintInfo.owner;
  const ata = getAssociatedTokenAddressSync(leg.mint, pda, true, tokenProgram);
  const url = new URL(`${JUPITER_API}/build`);
  url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
  url.searchParams.set("outputMint", leg.mint.toBase58());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("taker", pda.toBase58());
  url.searchParams.set("wrapAndUnwrapSol", "false");
  url.searchParams.set("destinationTokenAccount", ata.toBase58());
  url.searchParams.set("slippageBps", "rtse");
  if (maxAccounts) url.searchParams.set("maxAccounts", String(maxAccounts));
  const build = await fetchJson<any>(url.toString(), undefined, true);
  const check = checkV2Build(
    build,
    pda,
    wsolAta,
    leg.mint,
    ata,
    tokenProgram,
    amount
  );
  check.leg = leg.label;
  if (build.error) return { check };
  check.venues = (build.routePlan ?? [])
    .map((hop: any) => hop.swapInfo?.label)
    .filter(Boolean)
    .join(">");
  check.tokenProgram = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? "token-2022"
    : "legacy";
  check.routeAccounts = build.swapInstruction?.accounts?.length;
  check.slippageBps = Number(build.slippageBps);
  const prepared: PreparedLeg = {
    ...leg,
    tokenProgram,
    ata,
    amountIn: amount,
    minimumOutput: BigInt(build.otherAmountThreshold ?? 1),
    routeAccounts: build.swapInstruction.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: false,
      isWritable: a.isWritable,
    })),
    jupiterData: Buffer.from(build.swapInstruction.data, "base64"),
    lookupTables: Object.keys(build.addressesByLookupTableAddress ?? {}),
    resolvedLookupTables: Object.entries(
      build.addressesByLookupTableAddress ?? {}
    ).map(
      ([key, addresses]) =>
        new AddressLookupTableAccount({
          key: new PublicKey(key),
          state: {
            deactivationSlot: BigInt("18446744073709551615"),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            addresses: (addresses as string[]).map(
              (address) => new PublicKey(address)
            ),
          },
        })
    ),
    slippageBps: Number(build.slippageBps),
    slippageSource: "jupiter-rtse",
    routeLabel: check.venues ?? "",
  };
  return { check, prepared, build };
}

/**
 * Compile the complete burn transaction exactly as production would: compute
 * budget + split instruction, Jupiter's route ALTs plus a synthetic table
 * whose contents mirror the shared + per-vault tables the launcher creates.
 * Signature bytes are counted by construction (VersionedTransaction allocates
 * one zeroed 64-byte signature per required signer); nothing is signed.
 */
function compileFull(
  payer: PublicKey,
  pda: PublicKey,
  wsolAta: PublicKey,
  launchMint: PublicKey,
  legs: PreparedLeg[],
  total: bigint
): { bytes: number; locks: number } {
  const instruction = buildSplitInstruction(
    payer,
    PROGRAM,
    pda,
    wsolAta,
    launchMint,
    legs,
    total
  );
  const synthetic = new AddressLookupTableAccount({
    key: PublicKey.default,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [
        // shared table contents (ensureSharedLookupTable)
        PROGRAM,
        JUPITER_PROGRAM,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
        SystemProgram.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        NATIVE_MINT,
        ComputeBudgetProgram.programId,
        ...Object.values(TOKENS),
        // vault table contents (createVaultLookupTable)
        pda,
        wsolAta,
        launchMint,
        ...legs.flatMap((leg) => [leg.mint, leg.ata]),
      ],
    },
  });
  const lookupTables = [
    ...new Map(
      legs
        .flatMap((leg) => leg.resolvedLookupTables)
        .map((table) => [table.key.toBase58(), table])
    ).values(),
    synthetic,
  ];
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      instruction,
    ],
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  let bytes: number;
  try {
    bytes = transaction.serialize().length;
  } catch {
    bytes = MAX_TRANSACTION_BYTES + 1;
  }
  const locks =
    message.staticAccountKeys.length +
    message.addressTableLookups.reduce(
      (sum, lookup) =>
        sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
      0
    );
  return { bytes, locks };
}

async function main() {
  const connection = new Connection(MAINNET, "confirmed");
  const version = await connection.getVersion();
  const slot = await connection.getSlot();
  console.error(`mainnet solana-core ${version["solana-core"]} at slot ${slot}\n`);

  // Any pubkey works as the fee payer for a size estimate.
  const payer = Keypair.generate().publicKey;

  const shapes: { name: string; launch: PublicKey; legs: LegSpec[]; total: bigint; maxAccounts?: number }[] = [
    {
      name: "1-leg-100 JTO",
      launch: TOKENS.JTO,
      legs: [{ label: "JTO", mint: TOKENS.JTO, bps: 10000 }],
      total: 1_000_000_000n,
    },
    {
      name: "2-leg-85-15 JTO/NEIRO",
      launch: TOKENS.JTO,
      legs: [
        { label: "JTO", mint: TOKENS.JTO, bps: 8500 },
        { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
      ],
      total: 1_000_000_000n,
      maxAccounts: 26,
    },
    {
      name: "3-leg-70-15-15 FARTCOIN/NEIRO/PUMP",
      launch: TOKENS.FARTCOIN,
      legs: [
        { label: "FARTCOIN", mint: TOKENS.FARTCOIN, bps: 7000 },
        { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
        { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
      ],
      total: 1_000_000_000n,
      maxAccounts: 16,
    },
    {
      name: "4-leg-25x4 JTO/BONK/WIF/POPCAT",
      launch: TOKENS.JTO,
      legs: [
        { label: "JTO", mint: TOKENS.JTO, bps: 2500 },
        { label: "BONK", mint: TOKENS.BONK, bps: 2500 },
        { label: "WIF", mint: TOKENS.WIF, bps: 2500 },
        { label: "POPCAT", mint: TOKENS.POPCAT, bps: 2500 },
      ],
      total: 2_000_000_000n,
      maxAccounts: 12,
    },
  ];

  const report: any[] = [];
  for (const shape of shapes) {
    const [pda] = deriveSplitPda(shape.launch, shape.legs);
    const wsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      pda,
      true,
      TOKEN_PROGRAM_ID
    );
    const amounts = splitAmounts(
      shape.total,
      shape.legs.map((leg) => leg.bps)
    );
    const splitSumsExactly =
      amounts.reduce((a, b) => a + b, 0n) === shape.total;

    const legChecks: LegCheck[] = [];
    const preparedLegs: PreparedLeg[] = [];
    for (const [index, leg] of shape.legs.entries()) {
      const result = await buildLeg(
        connection,
        pda,
        wsolAta,
        leg,
        amounts[index],
        shape.maxAccounts
      );
      legChecks.push(result.check);
      if (result.prepared) preparedLegs.push(result.prepared);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    let fit: { bytes: number; locks: number } | undefined;
    if (preparedLegs.length === shape.legs.length) {
      fit = compileFull(
        payer,
        pda,
        wsolAta,
        shape.launch,
        preparedLegs,
        shape.total
      );
      // One narrowing retry, mirroring the harness's fitting loop.
      if (
        (fit.bytes > MAX_TRANSACTION_BYTES || fit.locks > MAX_LOCKS) &&
        shape.maxAccounts !== undefined
      ) {
        const narrower = Math.max(8, shape.maxAccounts - 4);
        const retryLegs: PreparedLeg[] = [];
        let allOk = true;
        for (const [index, leg] of shape.legs.entries()) {
          const result = await buildLeg(
            connection,
            pda,
            wsolAta,
            leg,
            amounts[index],
            narrower
          );
          if (result.prepared && result.check.ok) {
            retryLegs.push(result.prepared);
          } else {
            allOk = false;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (allOk) {
          const retryFit = compileFull(
            payer,
            pda,
            wsolAta,
            shape.launch,
            retryLegs,
            shape.total
          );
          if (retryFit.bytes < fit.bytes) fit = retryFit;
        }
      }
    }

    const row = {
      shape: shape.name,
      vault: pda.toBase58(),
      splitSumsExactly,
      perLegLamports: amounts.map(String),
      allPinsHold:
        legChecks.every((check) => check.ok) &&
        legChecks.length === shape.legs.length,
      txBytes: fit?.bytes,
      accountLocks: fit?.locks,
      fitsWire: fit ? fit.bytes <= MAX_TRANSACTION_BYTES : undefined,
      fitsLocks: fit ? fit.locks <= MAX_LOCKS : undefined,
      legs: legChecks,
    };
    report.push(row);
    console.error(
      `${shape.name}\n  v2 pins hold: ${row.allPinsHold} | split exact: ${splitSumsExactly} | ` +
        `bytes: ${fit?.bytes ?? "?"}/${MAX_TRANSACTION_BYTES} | locks: ${fit?.locks ?? "?"}/${MAX_LOCKS}`
    );
    for (const check of legChecks) {
      const failing = Object.entries(check.pins ?? {})
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      console.error(
        `    ${check.leg.padEnd(10)} ${check.ok ? "OK " : "BAD"} ` +
          `${(check.variant ?? "").padEnd(24)} ${(check.venues ?? check.reason ?? "").padEnd(30)} ` +
          `${check.tokenProgram ?? ""} ${check.routeAccounts ?? "?"} accts rtse=${check.slippageBps ?? "?"}bps` +
          (failing.length ? ` FAILING: ${failing.join(",")}` : "") +
          (check.foreignSigners?.length
            ? ` FOREIGN SIGNERS: ${check.foreignSigners}`
            : "")
      );
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const allOk = report.every(
    (row) =>
      row.allPinsHold &&
      row.splitSumsExactly &&
      row.fitsWire !== false &&
      row.fitsLocks !== false
  );
  console.error(
    `\nall live-mainnet v2 routes satisfy the deployed program's static guards: ${allOk}`
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
