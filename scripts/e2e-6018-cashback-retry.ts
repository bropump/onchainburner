/**
 * Coverage for 6018 `WsolNotFullyConsumed`: the one postcondition failure that
 * live routes actually produce, previously observed twice on cashback Pump
 * targets and covered nowhere.
 *
 * # Established mechanism (reproduced deterministically on this fork)
 *
 * Jupiter V2's PumpSwap adapter, routing a buy through a pool whose coin has
 * Pump's cashback mode enabled (`is_cashback_coin`), appends `ClaimCashback` +
 * `CloseUserVolumeAccumulator` after `BuyExactQuoteIn`. PumpSwap's
 * `claim_cashback` pays the just-accrued cashback (~32bps of the buy) in WSOL
 * into `user_wsol_token_account` -- for a burn, the vault's own WSOL ATA. The
 * buy itself consumes exactly the authorized input; the claim then credits
 * WSOL back, so the post-route balance sits ABOVE the pre-funding snapshot and
 * the burner's exact WSOL-conservation check reverts with 6018. Measured on
 * this fork: 100_000_000 in, all consumed, then +323_770 WSOL credited by the
 * claim. The vault is untouched either way -- that is what this suite proves.
 *
 * Unlike the raw-curve reward (route_v2 variant 0x98, whose route plan carries
 * a `track_volume` byte the harness clears on 6019), the PumpSwap variant
 * (0x93) carries NO flag: the claim cannot be disabled client-side. The only
 * recovery is a re-quote that routes around the cashback-paying venue, which
 * is exactly what this suite demonstrates and what the quote service should do
 * on a burner-attributed 6018.
 *
 * # Why 6018 is transient and route-dependent in the wild
 *
 * It occurs only when Jupiter picks a cashback-coin Pump pool as a direct
 * `route_v2` leg. A re-quote that lands on another venue (or a multi-hop
 * shared route, where the in-route user is Jupiter's own authority rather
 * than the vault) burns clean -- which is why the original failures did not
 * reproduce on retry.
 *
 * # Cases
 *
 *  1. provoke: quote the leg via "Pump.fun Amm" only. PASSES only if the
 *     BURNER rejected with exactly 6018 AND the vault gained exactly its
 *     case funding AND the WSOL + target ATA balances are byte-identical.
 *  2. re-quote: the same vault, fresh quotes, Pump venues excluded (the
 *     documented, tested venue exclusion for this failure). PASSES only if
 *     the burn lands ("burned" -- runSplitCase itself then asserts exact
 *     spend, full burn, and empty ATAs). External fork drift (stale
 *     DLMM/CLMM state) is retried with fresh quotes; any burner-attributed
 *     failure fails immediately.
 *
 * A provocation that BURNS means the environment no longer serves the
 * cashback shape (coin's cashback disabled, or the adapter changed); that is
 * reported as a loud failure so the suite is re-pointed at a live cashback
 * coin rather than silently passing without covering 6018.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  CaseResult,
  deriveSplitPda,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  solToLamports,
} from "./surfpool-split-e2e";

/**
 * A graduated Pump coin with cashback mode enabled and at least one non-Pump
 * pool (so the recovery leg has somewhere to route). Both properties are
 * environment state; override when this mint stops satisfying them.
 */
const PROVOKE_MINT = new PublicKey(
  process.env.CASHBACK_6018_MINT ??
    "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump"
);
const TOTAL_SOL = process.env.CASHBACK_6018_SOL ?? "0.1";

/** The fork pool profile minus both Pump venues: the recovery route set. */
const POOL_DEXES_WITHOUT_PUMP = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
];

const RECOVERY_ATTEMPTS = 3;

type Verdict = { name: string; pass: boolean; why: string; result: CaseResult };

async function tokenAmountOrZero(
  connection: Connection,
  address: PublicKey
): Promise<bigint> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const mint = PROVOKE_MINT;
  const total = solToLamports(TOTAL_SOL);
  const baseLeg = { label: "cashback", mint, bps: 10000 };

  const [pda] = deriveSplitPda(mint, [baseLeg]);
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo) throw new Error(`mint ${mint.toBase58()} missing on fork`);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetAta = getAssociatedTokenAddressSync(
    mint,
    pda,
    true,
    mintInfo.owner
  );
  const verdicts: Verdict[] = [];

  // ---- 1. provoke a real burner 6018 -------------------------------------
  const vaultBefore = BigInt(await connection.getBalance(pda, "confirmed"));
  const wsolBefore = await tokenAmountOrZero(connection, wsolAta);
  const targetBefore = await tokenAmountOrZero(connection, targetAta);

  process.stderr.write(
    `provoking 6018 via Pump.fun Amm on ${mint.toBase58()} ... `
  );
  const provoke = await runSplitCase(
    connection,
    payer,
    quoteAuthority,
    "wsol-6018-provoke",
    mint,
    [{ ...baseLeg, dexes: ["Pump.fun Amm"] }],
    TOTAL_SOL,
    { slippageBps: 1500, maxAccountsPerLeg: 0 }
  );
  process.stderr.write(
    `${provoke.status}${
      provoke.errorCode ? ` (${provoke.errorCode} ${provoke.errorName})` : ""
    }\n`
  );

  const vaultAfter = BigInt(await connection.getBalance(pda, "confirmed"));
  const wsolAfter = await tokenAmountOrZero(connection, wsolAta);
  const targetAfter = await tokenAmountOrZero(connection, targetAta);

  // The vault must hold exactly what the case funded it (runSplitCase
  // transfers `total` in before attempting the burn) and not one lamport
  // more or less; both token balances must be byte-identical. The specific
  // code and burner attribution are required -- `code === undefined` is a
  // failure, exactly as the reviewed pass criteria demand.
  const rejected6018 =
    provoke.status === "rejected" &&
    provoke.rejectedBy === "burner" &&
    provoke.errorCode === 6018;
  const untouched =
    vaultAfter === vaultBefore + total &&
    wsolAfter === wsolBefore &&
    targetAfter === targetBefore;
  verdicts.push({
    name: "wsol-6018-provoke",
    pass: rejected6018 && untouched,
    why: rejected6018
      ? untouched
        ? "burner rejected 6018; vault gained exactly its funding, WSOL and target ATA identical"
        : `6018 but funds moved: vault ${vaultBefore}+${total}->${vaultAfter}, ` +
          `wsol ${wsolBefore}->${wsolAfter}, target ${targetBefore}->${targetAfter}`
      : provoke.status === "burned"
      ? "environment no longer provokes 6018 (cashback shape not served); " +
        "re-point CASHBACK_6018_MINT at a live cashback coin"
      : `expected burner 6018, got ${provoke.status} ` +
        `${provoke.errorCode ?? "no-code"} by ${provoke.rejectedBy ?? "n/a"}`,
    result: provoke,
  });

  // ---- 2. a re-quote around the cashback venue recovers -------------------
  // Only run when the provocation actually left a rejected-but-funded vault;
  // recovery of a state this suite failed to create would prove nothing.
  if (verdicts[0].pass) {
    let recovery: CaseResult | undefined;
    let why = "";
    for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS; attempt += 1) {
      process.stderr.write(
        `re-quote ${attempt}/${RECOVERY_ATTEMPTS} without Pump venues ... `
      );
      recovery = await runSplitCase(
        connection,
        payer,
        quoteAuthority,
        "wsol-6018-requote-recovers",
        mint,
        [{ ...baseLeg, dexes: POOL_DEXES_WITHOUT_PUMP }],
        TOTAL_SOL,
        { slippageBps: 1500, maxAccountsPerLeg: 0 }
      );
      process.stderr.write(
        `${recovery.status}${
          recovery.errorCode
            ? ` (${recovery.errorCode} ${recovery.errorName})`
            : ""
        }\n`
      );
      if (recovery.status === "burned") {
        why = `burned on attempt ${attempt}: ${recovery.burned?.join(
          ","
        )} via ${recovery.routes?.join(",")}`;
        break;
      }
      if (recovery.rejectedBy === "burner") {
        why = `burner-attributed ${recovery.errorCode} on the recovery leg`;
        break;
      }
      why = `no burn in ${attempt} attempt(s); last: ${recovery.status} ${
        recovery.errorName ?? recovery.detail?.slice(0, 120) ?? ""
      }`;
    }
    verdicts.push({
      name: "wsol-6018-requote-recovers",
      pass: recovery?.status === "burned",
      why,
      result: recovery!,
    });
  } else {
    process.stderr.write("skipping recovery case: provocation did not pass\n");
  }

  console.log(JSON.stringify(verdicts, null, 2));
  const passed = verdicts.filter((verdict) => verdict.pass).length;
  console.error(`\n${passed}/${verdicts.length} 6018 cases passed`);
  for (const verdict of verdicts) {
    console.error(
      `  ${verdict.pass ? "PASS" : "FAIL"} ${verdict.name}: ${verdict.why}`
    );
  }
  process.exit(passed === verdicts.length && verdicts.length === 2 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
