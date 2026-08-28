/**
 * MEASURE, do not estimate: serialized wire size of 2-leg keyless burns.
 *
 * Yesterday's finding (commit a2dd3a5): a 3-leg keyless burn is 1233 bytes
 * with no address lookup table — one byte over the 1232 limit, unfixable by
 * narrowing the route because the 8 fixed + 7-per-leg vault accounts are
 * inlined before any Jupiter account. The open question this script answers
 * with numbers instead of arithmetic: does a 2-LEG burn (8 + 14 = 22
 * vault-side keys) fit WITHOUT a lookup table, and does it fit for every
 * venue combination or only some?
 *
 * Method: for each target pair, resolve the same references the burns bind,
 * fetch real Jupiter routes (fork venue profile, exactly what the demo
 * service requests), assemble the REAL burn instruction via the service's
 * own `buildBurnInstruction`, and compile the v0 message twice —
 *   (a) with only Jupiter's route lookup tables (what "no lookup table"
 *       means in practice: the creator made no per-vault table), and
 *   (b) additionally with a synthetic per-vault table covering the same
 *       addresses `collectVaultAltAddresses` would put in a real one.
 * Repeats matter: Jupiter returns a different route per call, and the
 * variance IS the finding. Nothing here is submitted; sizes only.
 *
 * Env: RPC (default http://127.0.0.1:9900), BURNER_PROGRAM_ID (required),
 *      REPEATS (default 3), AMOUNT_LAMPORTS (default 100000000),
 *      JUPITER_API_KEY (optional).
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
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  buildBurnInstruction,
  deriveVault,
  JupiterBuild,
  JupiterBuildParams,
  MAX_TRANSACTION_BYTES,
  PreparedLeg,
} from "../quote-service/core";
import { JupiterV2HttpClient, SolanaRpcGateway } from "../quote-service/adapters";
import { resolveReference } from "../quote-service/reference";

const RPC_URL = process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC_URL)) {
  throw new Error(`refusing non-loopback RPC ${RPC_URL}`);
}
const PROGRAM = new PublicKey(
  process.env.BURNER_PROGRAM_ID ??
    (() => {
      throw new Error("BURNER_PROGRAM_ID is required");
    })()
);
const REPEATS = Number(process.env.REPEATS ?? "3");
const AMOUNT = BigInt(process.env.AMOUNT_LAMPORTS ?? "100000000");

/** Same venue include-list the demo service and fork harness use. */
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

/** Curated burn-proven pairs (app/src/chain/knownReferences.ts). */
const TOKENS: Record<string, { mint: string; pool: string; venue: string }> = {
  JTO: {
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    pool: "JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo",
    venue: "Raydium CLMM",
  },
  NEIRO: {
    mint: "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump",
    pool: "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV",
    venue: "Raydium v4",
  },
  PUMP: {
    mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    pool: "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
    venue: "Raydium CLMM",
  },
  BONK: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    pool: "GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN",
    venue: "Raydium CLMM",
  },
  WIF: {
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    pool: "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx",
    venue: "Raydium v4",
  },
  FARTCOIN: {
    mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    pool: "Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw",
    venue: "Raydium v4",
  },
  POPCAT: {
    mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    pool: "FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxRF2x9RwLLMo",
    venue: "Raydium v4",
  },
  RAY: {
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    pool: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
    venue: "Raydium v4",
  },
};

/** 90/10 pairs across venue combinations (leg0 90%, leg1 10%). */
const PAIRS: Array<[keyof typeof TOKENS, keyof typeof TOKENS]> = [
  ["NEIRO", "PUMP"], // v4 + CLMM — the classic-policy merge shape
  ["JTO", "NEIRO"], // CLMM + v4
  ["BONK", "WIF"], // CLMM + v4
  ["FARTCOIN", "POPCAT"], // v4 + v4
  ["JTO", "PUMP"], // CLMM + CLMM
  ["RAY", "NEIRO"], // v4 + v4
];

/** Fitting ladder mirroring the demo service policy. */
const CAPS: Array<number | undefined> = [undefined, 40, 32, 26, 20, 16, 12];

class ForkJupiter {
  constructor(private readonly inner: JupiterV2HttpClient) {}
  async build(params: JupiterBuildParams): Promise<JupiterBuild> {
    // 429s: same shape the demo service uses — stepped backoff, no spacing.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.inner.build({
          ...params,
          dexes: POOL_ONLY_FORK_DEXES,
          slippageBps: 1_500,
        });
      } catch (error) {
        const text = String((error as Error).message ?? error);
        if (/HTTP 429/.test(text) && attempt < 6) {
          await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }
}

const ACTIVE = BigInt("18446744073709551615");

function syntheticTable(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: PublicKey.unique(),
    state: {
      deactivationSlot: ACTIVE,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const chain = new SolanaRpcGateway(connection);
  const jupiter = new ForkJupiter(
    new JupiterV2HttpClient(
      process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
      process.env.JUPITER_API_KEY
    )
  );
  const feePayer = PublicKey.unique(); // size-only; nothing is signed or sent
  const rows: object[] = [];

  for (const [a, b] of PAIRS) {
    const legsSpec = [
      { ...TOKENS[a], symbol: a, bps: 9_000 },
      { ...TOKENS[b], symbol: b, bps: 1_000 },
    ];
    const launchMint = new PublicKey(legsSpec[0].mint);
    const references = [] as Awaited<ReturnType<typeof resolveReference>>[];
    for (const leg of legsSpec) {
      references.push(
        await resolveReference(
          chain,
          new PublicKey(leg.mint),
          new PublicKey(leg.pool)
        )
      );
    }
    const vault = deriveVault(
      PROGRAM,
      launchMint,
      legsSpec.map((leg, i) => ({
        targetMint: new PublicKey(leg.mint),
        bps: leg.bps,
        refSeed: references[i].seed,
      }))
    );
    const wsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      vault,
      true,
      TOKEN_PROGRAM_ID
    );
    const tokenPrograms: PublicKey[] = [];
    for (const leg of legsSpec) {
      const info = await connection.getAccountInfo(new PublicKey(leg.mint));
      if (!info) throw new Error(`mint ${leg.mint} not found`);
      tokenPrograms.push(info.owner);
    }
    const atas = legsSpec.map((leg, i) =>
      getAssociatedTokenAddressSync(
        new PublicKey(leg.mint),
        vault,
        true,
        tokenPrograms[i]
      )
    );
    // Mirrors app/src/chain/lookupTable.ts collectVaultAltAddresses.
    const vaultAltAddresses = [
      vault,
      wsolAta,
      launchMint,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ...legsSpec.flatMap((leg, i) => [
        new PublicKey(leg.mint),
        atas[i],
        tokenPrograms[i],
        references[i].pool,
        references[i].vaultA,
        references[i].vaultB,
        references[i].feeSource,
      ]),
    ];
    const seen = new Set<string>();
    const dedupedAlt = vaultAltAddresses.filter((k) => {
      const b = k.toBase58();
      if (seen.has(b)) return false;
      seen.add(b);
      return true;
    });

    const amounts = [
      (AMOUNT * 9_000n) / 10_000n,
      AMOUNT - (AMOUNT * 9_000n) / 10_000n,
    ];

    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      // Walk the ladder the way the service would: widest first, narrow
      // only if over. Record EVERY rung tried so the boundary is visible.
      for (const cap of CAPS) {
        const builds: JupiterBuild[] = [];
        let buildError: string | null = null;
        for (let i = 0; i < legsSpec.length; i += 1) {
          try {
            builds.push(
              await jupiter.build({
                inputMint: NATIVE_MINT,
                outputMint: new PublicKey(legsSpec[i].mint),
                amount: amounts[i],
                taker: vault,
                destinationTokenAccount: atas[i],
                maxAccounts: cap,
              })
            );
          } catch (error) {
            buildError = String((error as Error).message ?? error).slice(0, 160);
            break;
          }
        }
        if (buildError) {
          rows.push({
            pair: `${a}/${b}`,
            repeat,
            cap: cap ?? "none",
            error: buildError,
          });
          console.log(JSON.stringify(rows[rows.length - 1]));
          continue;
        }
        const legs: PreparedLeg[] = builds.map((build, i) => ({
          targetMint: new PublicKey(legsSpec[i].mint),
          targetTokenProgram: tokenPrograms[i],
          targetAta: atas[i],
          bps: legsSpec[i].bps,
          amountIn: amounts[i],
          minimumOutput: BigInt(build.otherAmountThreshold || "1"),
          reference: references[i],
          routeAccounts: build.swapInstruction.accounts,
          routeData: Buffer.from(build.swapInstruction.data, "base64"),
          lookupTables: Object.entries(
            build.addressesByLookupTableAddress ?? {}
          ).map(([key, addresses]) =>
            syntheticTable(addresses.map((x) => new PublicKey(x)))
          ),
        }));
        const burn = buildBurnInstruction(
          PROGRAM,
          feePayer,
          launchMint,
          vault,
          wsolAta,
          AMOUNT,
          legs
        );
        const compute = ComputeBudgetProgram.setComputeUnitLimit({
          units: 1_400_000,
        });
        const blockhash = PublicKey.unique().toBase58(); // size-only
        const measure = (tables: AddressLookupTableAccount[]) => {
          const message = new TransactionMessage({
            payerKey: feePayer,
            recentBlockhash: blockhash,
            instructions: [compute, burn],
          }).compileToV0Message(tables);
          const transaction = new VersionedTransaction(message);
          let bytes: number;
          try {
            bytes = transaction.serialize().length;
          } catch {
            bytes = -1; // >  u8 index overflow etc.
          }
          const locks =
            message.staticAccountKeys.length +
            message.addressTableLookups.reduce(
              (sum, l) =>
                sum + l.writableIndexes.length + l.readonlyIndexes.length,
              0
            );
          return { bytes, locks };
        };
        const jupiterTables = legs.flatMap((leg) => [...leg.lookupTables]);
        const noAlt = measure(jupiterTables);
        const withAlt = measure([syntheticTable(dedupedAlt), ...jupiterTables]);
        const routeAccounts = legs.map((leg) => leg.routeAccounts.length);
        const row = {
          pair: `${a}/${b}`,
          venues: `${legsSpec[0].venue} + ${legsSpec[1].venue}`,
          repeat,
          cap: cap ?? "none",
          amount: AMOUNT.toString(),
          routeAccounts,
          routeDataBytes: legs.map((leg) => leg.routeData.length),
          noAlt,
          withAlt,
          fitsNoAlt: noAlt.bytes > 0 && noAlt.bytes <= MAX_TRANSACTION_BYTES,
          fitsWithAlt:
            withAlt.bytes > 0 && withAlt.bytes <= MAX_TRANSACTION_BYTES,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
        // Ladder semantics: stop at the first fitting rung (no-ALT view).
        if (row.fitsNoAlt) break;
      }
    }
  }

  // Summary
  const summary: Record<
    string,
    { fitNoAltAtWidest: number; total: number; min: number; max: number }
  > = {};
  for (const row of rows as any[]) {
    if (row.error || row.cap !== "none") continue;
    const s = (summary[row.pair] ??= {
      fitNoAltAtWidest: 0,
      total: 0,
      min: Infinity,
      max: -Infinity,
    });
    s.total += 1;
    if (row.fitsNoAlt) s.fitNoAltAtWidest += 1;
    if (row.noAlt.bytes > 0) {
      s.min = Math.min(s.min, row.noAlt.bytes);
      s.max = Math.max(s.max, row.noAlt.bytes);
    }
  }
  console.log("SUMMARY (uncapped route, no vault ALT):");
  for (const [pair, s] of Object.entries(summary)) {
    console.log(
      `  ${pair}: fits ${s.fitNoAltAtWidest}/${s.total} at widest; bytes ${s.min}-${s.max}`
    );
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
