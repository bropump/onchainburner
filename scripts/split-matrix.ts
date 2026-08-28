/**
 * The split burn matrix: weights, leg counts, token mixes, and sizes.
 *
 * Every case is a distinct vault (the configuration is the PDA seed), funded
 * directly, then burned in one atomic call. Positive cases assert all legs
 * burned and the vault spent exactly the authorized total; negative cases
 * assert the burner rejected with a specific code and moved nothing.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  CaseResult,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  TOKENS,
  fetchJson,
} from "./surfpool-split-e2e";

const t = TOKENS;

/**
 * Recently-graduated Pump tokens that Jupiter already routes, used as the
 * "fresh pair" leg. Discovered rather than hardcoded so the matrix keeps
 * covering new launches instead of a frozen snapshot.
 */
async function discoverFreshPumpTargets(limit: number): Promise<Leg[]> {
  try {
    const results = await fetchJson<any[]>(
      "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=60"
    );
    return results
      .filter(
        (token) =>
          typeof token.id === "string" &&
          token.id.endsWith("pump") &&
          Number(token.liquidity ?? 0) > 150_000 &&
          !Object.values(t).some((known) => known.toBase58() === token.id)
      )
      .slice(0, limit)
      .map((token) => ({
        label: `fresh:${token.symbol ?? token.id.slice(0, 4)}`,
        mint: new PublicKey(token.id),
        bps: 0,
      }));
  } catch {
    return [];
  }
}

function weighted(legs: Leg[], bps: number[]): Leg[] {
  return legs.map((leg, index) => ({ ...leg, bps: bps[index] }));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const fresh = await discoverFreshPumpTargets(3);
  console.error(
    `fresh pump targets: ${fresh.map((leg) => `${leg.label}=${leg.mint.toBase58()}`).join(", ") || "(none discovered)"}`
  );

  const NEIRO: Leg = { label: "NEIRO", mint: t.NEIRO, bps: 0 };
  const PUMP: Leg = { label: "PUMP", mint: t.PUMP, bps: 0 };
  const JTO: Leg = { label: "JTO", mint: t.JTO, bps: 0 };
  const BONK: Leg = { label: "BONK", mint: t.BONK, bps: 0 };
  const WIF: Leg = { label: "WIF", mint: t.WIF, bps: 0 };
  const FART: Leg = { label: "FARTCOIN", mint: t.FARTCOIN, bps: 0 };
  const POPCAT: Leg = { label: "POPCAT", mint: t.POPCAT, bps: 0 };

  type Case = {
    name: string;
    launch: PublicKey;
    legs: Leg[];
    total: string;
    options?: Parameters<typeof runSplitCase>[7];
  };

  const cases: Case[] = [
    // ---- the headline configuration, and the weights around it ------------
    {
      name: "headline-15-15-70",
      launch: t.FARTCOIN,
      legs: weighted([NEIRO, PUMP, fresh[0] ?? JTO], [1500, 1500, 7000]),
      total: "0.5",
    },
    {
      name: "10-10-80",
      launch: t.POPCAT,
      legs: weighted([NEIRO, PUMP, fresh[1] ?? JTO], [1000, 1000, 8000]),
      total: "0.5",
    },
    {
      name: "50-25-25",
      launch: t.WIF,
      legs: weighted([JTO, NEIRO, PUMP], [5000, 2500, 2500]),
      total: "0.5",
    },
    {
      name: "33-33-34",
      launch: t.BONK,
      legs: weighted([BONK, WIF, JTO], [3300, 3300, 3400]),
      total: "0.6",
    },
    // ---- extremes ---------------------------------------------------------
    {
      name: "extreme-1-1-98",
      launch: t.RAY,
      legs: weighted([NEIRO, PUMP, JTO], [100, 100, 9800]),
      total: "2",
    },
    {
      name: "extreme-99-1",
      launch: t.JTO,
      legs: weighted([JTO, NEIRO], [9900, 100]),
      total: "1",
    },
    {
      name: "extreme-9-91",
      launch: t.NEIRO,
      legs: weighted([NEIRO, JTO], [900, 9100]),
      total: "1",
    },
    {
      name: "extreme-1-9999",
      launch: t.WIF,
      legs: weighted([NEIRO, WIF], [1, 9999]),
      total: "5",
    },
    // ---- leg counts -------------------------------------------------------
    {
      name: "single-leg-100",
      launch: t.POPCAT,
      legs: weighted([JTO], [10000]),
      total: "0.25",
    },
    {
      name: "four-leg-25x4",
      launch: t.FARTCOIN,
      legs: weighted([NEIRO, JTO, BONK, WIF], [2500, 2500, 2500, 2500]),
      total: "0.8",
    },
    {
      name: "four-leg-70-10-10-10",
      launch: t.RAY,
      legs: weighted([JTO, NEIRO, BONK, WIF], [7000, 1000, 1000, 1000]),
      total: "1",
    },
    // ---- token mixes ------------------------------------------------------
    {
      name: "token2022-first",
      launch: t.BONK,
      legs: weighted([PUMP, BONK, JTO], [4000, 3000, 3000]),
      total: "0.5",
    },
    {
      name: "all-legacy",
      launch: t.PUMP,
      legs: weighted([BONK, WIF, POPCAT], [3000, 3000, 4000]),
      total: "0.6",
    },
    {
      name: "fresh-pump-heavy",
      launch: t.JTO,
      legs: weighted(
        [fresh[0] ?? FART, fresh[1] ?? POPCAT, NEIRO],
        [4500, 4500, 1000]
      ),
      total: "0.4",
    },
    // ---- sizes ------------------------------------------------------------
    {
      name: "size-small-0.05",
      launch: t.WIF,
      legs: weighted([NEIRO, JTO, BONK], [1500, 1500, 7000]),
      total: "0.05",
    },
    {
      name: "size-large-25",
      launch: t.POPCAT,
      legs: weighted([JTO, BONK, WIF], [1500, 1500, 7000]),
      total: "25",
    },
    {
      name: "size-large-100",
      launch: t.NEIRO,
      legs: weighted([JTO, BONK], [3000, 7000]),
      total: "100",
    },
    // ---- partial burn: vault keeps a rent-exempt remainder ---------------
    {
      name: "partial-chunk-leaves-remainder",
      launch: t.RAY,
      legs: weighted([NEIRO, JTO, PUMP], [1500, 1500, 7000]),
      total: "0.3",
      options: { fundExtra: 500_000_000n },
    },
  ];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    process.stderr.write(`running ${testCase.name} ... `);
    const result = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      testCase.name,
      testCase.launch,
      testCase.legs,
      testCase.total,
      testCase.options ?? {}
    );
    results.push(result);
    // Jupiter's free tier rate-limits a tight loop of quote + swap-instruction
    // pairs; a case that dies on a 429 says nothing about the program.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    process.stderr.write(
      `${result.status}${result.errorName ? ` (${result.errorName})` : ""} ` +
        `${result.computeUnits ?? "?"}cu ${result.txBytes ?? "?"}b ${result.accountLocks ?? "?"}locks\n`
    );
  }

  console.log(JSON.stringify(results, null, 2));
  const burned = results.filter((result) => result.status === "burned").length;
  console.error(`\n${burned}/${results.length} burned`);
  process.exit(burned === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
