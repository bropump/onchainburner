/**
 * Adversarial coverage for `swap_and_burn_split`.
 *
 * Every case starts from a valid, fully-funded 3-leg burn and changes exactly
 * one thing. The assertion is that the burner rejects it with a specific code
 * AND that the vault's lamports and every target ATA are untouched afterwards
 * -- a rejection that still moved funds is a failure, not a pass.
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import {
  ComputeBudgetProgram,
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
  splitInstructionData,
  SPLIT_DISCRIMINATOR,
  TOKENS,
} from "./surfpool-split-e2e";

const LAUNCH = TOKENS.FARTCOIN;
const LEGS: Leg[] = [
  { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
  { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
  { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
];
const TOTAL = solToLamports("0.3");

type Attack = {
  name: string;
  /**
   * The burner error code this attack must produce, or "runtime" when the
   * mutation is structurally refused by the runtime before the program runs.
   * "runtime" is a real outcome, not a fallback -- it is only ever declared
   * where the program CANNOT be reached, and it still requires that nothing
   * moved.
   */
  expect: number | "runtime" | (number | "runtime")[];
  /** What the attacker changes about an otherwise valid transaction. */
  mutate: (context: Context) => Mutation;
};

type Mutation = {
  overrides?: Parameters<typeof buildSplitInstruction>[7];
  /** Extra keypairs that must sign, beyond the payer. */
  signWith?: Keypair[];
  /** Replace the whole instruction data. */
  rawData?: Buffer;
};

type Context = {
  pda: PublicKey;
  wsolAta: PublicKey;
  legs: Awaited<ReturnType<typeof prepareLegs>>;
  payer: Keypair;
  quoteAuthority: Keypair;
  /** A funded wallet standing in for an attacker with a key of their own. */
  imposter: Keypair;
};

const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";

function routeV2Shape(data: Buffer): {
  destinationIndexes: number[];
  platformFeeOffset: number;
} {
  const discriminator = data.subarray(0, 8).toString("hex");
  if (discriminator === ROUTE_V2_DISCRIMINATOR) {
    return { destinationIndexes: [2, 7], platformFeeOffset: 26 };
  }
  if (discriminator === SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR) {
    return { destinationIndexes: [5], platformFeeOffset: 27 };
  }
  throw new Error(`unexpected Jupiter V2 discriminator ${discriminator}`);
}

const ATTACKS: Attack[] = [
  {
    // The weights are in the PDA seeds, so re-weighting the call lands on a
    // different, unfunded address. This is the whole security argument for
    // the split: a caller cannot redirect 98% into a leg the config gave 15%.
    name: "reweight-15/15/70-to-1/1/98",
    expect: 6012,
    mutate: () => ({ overrides: { bpsOverride: [100, 100, 9800] } }),
  },
  {
    // Deliberately sum-preserving: [1500,1500,7000] -> [1500,7000,1500] moves
    // the majority onto a different target while still totalling 10000, so
    // the weights guard cannot fire and the PDA seeds are the only thing
    // standing between the caller and a redirected burn.
    name: "reweight-move-majority-sum-preserved",
    expect: 6012,
    mutate: () => ({ overrides: { bpsOverride: [1500, 7000, 1500] } }),
  },
  {
    name: "weights-do-not-sum-to-10000",
    expect: 6033,
    mutate: () => ({ overrides: { bpsOverride: [1500, 1500, 6000] } }),
  },
  {
    name: "zero-weight-leg",
    expect: 6033,
    mutate: () => ({ overrides: { bpsOverride: [0, 3000, 7000] } }),
  },
  {
    name: "reorder-legs",
    expect: 6012,
    mutate: (context) => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          // Swap leg 0's and leg 2's (mint, ata, program) triples.
          for (let i = 0; i < 3; i += 1) {
            const a = 8 + i;
            const b = 8 + 6 + i;
            [copy[a], copy[b]] = [copy[b], copy[a]];
          }
          return copy;
        },
      },
    }),
  },
  {
    name: "substitute-target-mint",
    expect: 6012,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[8] = { ...copy[8], pubkey: TOKENS.BONK };
          return copy;
        },
      },
    }),
  },
  {
    name: "duplicate-target-mint",
    expect: 6034,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          // Point leg 1's mint+ata at leg 0's.
          copy[11] = copy[8];
          copy[12] = copy[9];
          copy[13] = copy[10];
          return copy;
        },
      },
    }),
  },
  {
    // An attacker without the key cannot leave the authority marked as a
    // required signer, so they drop the flag and the program must catch it.
    //
    // Caller (account 0) marked non-signer. Fee payer still signs the
    // message; the program requires accounts[0].is_signer() (6029).
    name: "caller-marked-non-signer",
    expect: 6029,
    mutate: () => ({
      signWith: [],
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[0] = { ...copy[0], isSigner: false };
          return copy;
        },
      },
    }),
  },
  {
    name: "raise-minimum-output-beyond-fill",
    expect: 6021,
    mutate: (context) => ({
      overrides: {
        minimumOutputOverride: context.legs.map(
          (leg) => leg.minimumOutput * 1000n
        ),
      },
    }),
  },
  {
    name: "zero-minimum-output",
    expect: 6002,
    mutate: (context) => ({
      overrides: { minimumOutputOverride: context.legs.map(() => 0n) },
    }),
  },
  {
    name: "leg-count-zero",
    expect: 6032,
    mutate: () => {
      const header = Buffer.alloc(12);
      header.writeBigUInt64LE(TOTAL, 0);
      header.writeUInt32LE(0, 8);
      return { rawData: Buffer.concat([SPLIT_DISCRIMINATOR, header]) };
    },
  },
  {
    name: "leg-count-above-max",
    expect: 6032,
    mutate: () => {
      const header = Buffer.alloc(12);
      header.writeBigUInt64LE(TOTAL, 0);
      header.writeUInt32LE(5, 8);
      return { rawData: Buffer.concat([SPLIT_DISCRIMINATOR, header]) };
    },
  },
  {
    name: "trailing-bytes-after-legs",
    expect: 6027,
    mutate: () => ({
      overrides: {
        dataTamper: (data) => Buffer.concat([data, Buffer.from([0xff])]),
      },
    }),
  },
  {
    name: "truncated-leg-header",
    expect: 6027,
    mutate: () => ({
      overrides: { dataTamper: (data) => data.subarray(0, data.length - 1) },
    }),
  },
  {
    name: "overstated-route-account-count",
    expect: 6006,
    mutate: (context) => ({
      overrides: {
        dataTamper: (data) =>
          splitInstructionData(
            TOTAL,
            context.legs.map((leg, index) => ({
              bps: leg.bps,
              minimumOutput: leg.minimumOutput,
              // Leg 0 claims one more route account than it was given, so the
              // last leg runs out and the cursor check must catch it.
              routeAccountCount:
                index === 0
                  ? leg.routeAccounts.length + 1
                  : leg.routeAccounts.length,
              jupiterData: leg.jupiterData,
            }))
          ),
      },
    }),
  },
  {
    // Understating the LAST leg's route-account count by one has two real
    // outcomes, decided by the shape of the live route Jupiter picked for
    // that leg:
    //  - When the starved slice is too short for the route plan's account
    //    consumption, Jupiter's `RouteV2` CPI panics ("mid > len" in
    //    `extract_accounts.rs`) and the runtime aborts the transaction
    //    before any burner check runs -- the "runtime refusal" CLAUDE.md
    //    documents.
    //  - When the omitted TRAILING account is one the plan does not consume
    //    (v2 routes often end in an optional/duplicate account, e.g.
    //    Whirlpool's absent oracle), the CPI completes and the burner's own
    //    end-of-call `route_cursor != route_pool.len()` guard fires 6006 --
    //    the guard this case originally named, reached from this direction
    //    after all.
    // Both are exact rejections with the vault untouched; accepting either
    // arm keeps each one strict (burner must say SPECIFICALLY 6006, runtime
    // must produce no custom code). The 6006 guard is also covered
    // unconditionally by `extra-unaccounted-account-appended`.
    name: "understated-route-account-count",
    expect: [6006, "runtime"],
    mutate: (context) => ({
      overrides: {
        dataTamper: (data) =>
          splitInstructionData(
            TOTAL,
            context.legs.map((leg, index) => ({
              bps: leg.bps,
              minimumOutput: leg.minimumOutput,
              routeAccountCount:
                index === context.legs.length - 1
                  ? leg.routeAccounts.length - 1
                  : leg.routeAccounts.length,
              jupiterData: leg.jupiterData,
            }))
          ),
      },
    }),
  },
  {
    name: "extra-unaccounted-account-appended",
    expect: 6006,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => [
          ...keys,
          { pubkey: TOKENS.USDC, isSigner: false, isWritable: false },
        ],
      },
    }),
  },
  {
    name: "redirect-leg-output-to-another-legs-ata",
    expect: 6006,
    mutate: (context) => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          // Redirect every V2 user/destination output pinned by the burner.
          const routeBase = 8 + 9;
          for (const index of routeV2Shape(context.legs[0].jupiterData)
            .destinationIndexes) {
            copy[routeBase + index] = {
              ...copy[routeBase + index],
              pubkey: context.legs[2].ata,
            };
          }
          return copy;
        },
      },
    }),
  },
  {
    name: "swap-jupiter-program-for-imposter",
    expect: 6003,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[7] = { ...copy[7], pubkey: TOKENS.USDC };
          return copy;
        },
      },
    }),
  },
  {
    name: "zero-total-input",
    expect: 6000,
    mutate: (context) => ({
      overrides: {
        dataTamper: () =>
          splitInstructionData(
            0n,
            context.legs.map((leg) => ({
              bps: leg.bps,
              minimumOutput: leg.minimumOutput,
              routeAccountCount: leg.routeAccounts.length,
              jupiterData: leg.jupiterData,
            }))
          ),
      },
    }),
  },
  {
    // Substituting a leg's mint for a non-mint address is caught by the SEED
    // BINDING (6012), not the mint-owner check (6010) — the mints are PDA
    // seeds, so the derivation runs first and lands on a different, unfunded
    // address. That is the stronger guard, and it means 6010 is unreachable
    // by substitution in the split path: it can only fire for a vault
    // deliberately CONFIGURED with a non-mint target, which is bricked by
    // construction and covered by the launcher's test-burn requirement.
    name: "non-mint-substituted-for-a-target",
    expect: 6012,
    mutate: (context) => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          // Slot 8 is leg 0's mint. A PROGRAM account cannot be marked
          // writable, so substituting the System program trips the writability
          // check (6030) before the owner check is reached. Use a plain
          // never-created address instead: it is System-owned, writable, and
          // therefore reaches the mint-owner check.
          copy[8] = { ...copy[8], pubkey: context.imposter.publicKey };
          return copy;
        },
      },
    }),
  },
  {
    // 6011: the target token account must be owned by the token program.
    name: "target-ata-not-a-token-account",
    expect: 6011,
    mutate: (context) => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[9] = { ...copy[9], pubkey: context.imposter.publicKey };
          return copy;
        },
      },
    }),
  },
  {
    // 6007: V2 encodes platform_fee_bps in the stable scalar prefix. The
    // burner refuses any non-zero fee before invoking Jupiter.
    name: "platform-fee-bps-nonzero",
    expect: 6007,
    mutate: (context) => ({
      overrides: {
        dataTamper: () =>
          splitInstructionData(
            TOTAL,
            context.legs.map((leg, index) => {
              const jupiterData = Buffer.from(leg.jupiterData);
              if (index === 0) {
                jupiterData.writeUInt16LE(
                  1,
                  routeV2Shape(jupiterData).platformFeeOffset
                );
              }
              return {
                bps: leg.bps,
                minimumOutput: leg.minimumOutput,
                routeAccountCount: leg.routeAccounts.length,
                jupiterData,
              };
            })
          ),
      },
    }),
  },
  {
    // 6001: ask for more than the vault holds.
    name: "spend-more-than-the-vault-has",
    expect: 6001,
    mutate: (context) => ({
      overrides: {
        dataTamper: () =>
          splitInstructionData(
            1_000_000_000_000_000n,
            context.legs.map((leg) => ({
              bps: leg.bps,
              minimumOutput: leg.minimumOutput,
              routeAccountCount: leg.routeAccounts.length,
              jupiterData: leg.jupiterData,
            }))
          ),
      },
    }),
  },
  {
    // 6028: fewer accounts than the fixed block plus three per leg.
    name: "truncated-account-list",
    expect: 6028,
    mutate: () => ({
      overrides: { accountTamper: (keys) => keys.slice(0, 10) },
    }),
  },
  {
    // 6031: the System program slot must be the System program.
    name: "imposter-system-program",
    expect: 6031,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[5] = { ...copy[5], pubkey: TOKENS.USDC };
          return copy;
        },
      },
    }),
  },
  {
    // 6009: the shared SPL token program slot is pinned.
    name: "imposter-spl-token-program",
    expect: 6009,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[6] = { ...copy[6], pubkey: TOKENS.USDC };
          return copy;
        },
      },
    }),
  },
  {
    name: "burn-pda-not-writable",
    expect: 6030,
    mutate: () => ({
      overrides: {
        accountTamper: (keys) => {
          const copy = [...keys];
          copy[2] = { ...copy[2], isWritable: false };
          return copy;
        },
      },
    }),
  },
];

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  // ---- one valid, funded vault that every attack starts from --------------
  const [pda] = deriveSplitPda(LAUNCH, LEGS);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
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
    if (!info) throw new Error(`mint ${leg.label} missing`);
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
  await sendInstructions(connection, payer, "negative-atas", ataIxs);
  await sendInstructions(connection, payer, "negative-fund", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: pda,
      lamports: TOTAL * 4n,
    }),
  ]);

  const legs = await prepareLegs(
    connection,
    payer,
    pda,
    wsolAta,
    LEGS,
    TOTAL,
    Number(process.env.FORK_SLIPPAGE_BPS ?? "1500"),
    16
  );
  const imposter = Keypair.generate();
  await sendInstructions(connection, payer, "fund-imposter", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: imposter.publicKey,
      lamports: solToLamports("0.02"),
    }),
  ]);
  const context: Context = {
    pda,
    wsolAta,
    legs,
    payer,
    quoteAuthority,
    imposter,
  };

  const vaultTable = await createVaultLookupTable(
    connection,
    payer,
    "negative",
    pda,
    wsolAta,
    LAUNCH,
    legs
  );
  const lookupTables = await getLookupTables(connection, [
    ...new Set([
      ...legs.flatMap((leg) => leg.lookupTables),
      (await ensureSharedLookupTable(connection, payer)).toBase58(),
      vaultTable.toBase58(),
    ]),
  ]);

  const results: any[] = [];
  for (const attack of ATTACKS) {
    const lamportsBefore = await connection.getBalance(pda, "confirmed");
    const mutation = attack.mutate(context);
    let instruction = buildSplitInstruction(
      payer.publicKey,
      quoteAuthority.publicKey,
      pda,
      wsolAta,
      LAUNCH,
      legs,
      TOTAL,
      mutation.overrides
    );
    if (mutation.rawData) {
      instruction = { ...instruction, data: mutation.rawData } as any;
    }

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

    let outcome: any = { name: attack.name, expect: attack.expect };
    try {
      transaction.sign([
        payer,
        ...(mutation.signWith === undefined ? [] : mutation.signWith),
      ]);
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
    } catch (error) {
      // A transaction the runtime refuses to even accept (an unsigned
      // required signer) never reaches the program; that is still a rejection.
      outcome.result = "rejected";
      outcome.by = "runtime";
      outcome.detail =
        error instanceof Error ? error.message.slice(0, 120) : String(error);
    }

    const lamportsAfter = await connection.getBalance(pda, "confirmed");
    outcome.vaultUnchanged = lamportsBefore === lamportsAfter;
    for (const leg of legs) {
      const account = await getAccount(
        connection,
        leg.ata,
        "confirmed",
        leg.tokenProgram
      );
      if (account.amount !== 0n) outcome.vaultUnchanged = false;
    }
    // An attack passes only if the BURNER rejected it with the SPECIFIC code
    // the attack targets, and nothing moved.
    //
    // The previous criterion accepted `code === undefined`, which auto-passed
    // any rejection that produced no decodable code -- including transactions
    // that were never submitted at all, because a client-side throw lands in
    // the catch block with no code. It also computed `by` and never asserted
    // it, so an error raised by Jupiter or an AMM (all 6000-based) could be
    // mis-credited to the burner. Both produced real false greens.
    const acceptedOutcomes = Array.isArray(attack.expect)
      ? attack.expect
      : [attack.expect];
    outcome.pass =
      outcome.result === "rejected" &&
      outcome.vaultUnchanged &&
      acceptedOutcomes.some((expected) =>
        expected === "runtime"
          ? outcome.by === "runtime" && outcome.code === undefined
          : outcome.by === "burner" && outcome.code === expected
      );
    results.push(outcome);
    process.stderr.write(
      `${outcome.pass ? "PASS" : "FAIL"}  ${attack.name} -> ${
        outcome.code ?? outcome.by
      } ` + `${outcome.codeName ?? ""} (expected ${attack.expect})\n`
    );
  }

  console.log(JSON.stringify(results, null, 2));
  const passed = results.filter((result) => result.pass).length;
  console.error(`\n${passed}/${results.length} attacks rejected as expected`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
