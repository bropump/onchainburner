/**
 * Random-token split coverage, and the question of whether Jupiter needs a
 * `maxAccounts` cap at all.
 *
 * Tokens are drawn at random from Jupiter's live top-organic list each run, so
 * this is not a frozen snapshot of the mints that happened to work once. Both
 * the majority burn token AND the 15% legs are randomised.
 *
 * Every case is attempted UNCAPPED first — no `maxAccounts`, Jupiter routes
 * however it likes. Only if that overflows the transaction is a cap applied,
 * and the report says which was needed. That answers the real question: the
 * cap is a client-side fitting lever, not something the program or Jupiter
 * requires.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  CaseResult,
  fetchJson,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  TOKENS,
} from "./surfpool-split-e2e";

type Candidate = {
  mint: PublicKey;
  symbol: string;
  liquidityUsd: number;
  venue: string;
  routeAccounts: number;
};

/** Pull a live pool of routable tokens and record how wide each route is. */
async function buildCandidatePool(want: number): Promise<Candidate[]> {
  const feeds = [
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
    "https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100",
  ];
  const seen = new Map<string, any>();
  for (const feed of feeds) {
    try {
      for (const token of await fetchJson<any[]>(feed)) {
        if (typeof token.id === "string" && Number(token.liquidity ?? 0) > 200_000) {
          seen.set(token.id, token);
        }
      }
    } catch {
      /* one feed down is not fatal */
    }
  }
  // Shuffle so each run picks a different set.
  const shuffled = [...seen.values()].sort(() => Math.random() - 0.5);

  const pool: Candidate[] = [];
  for (const token of shuffled) {
    if (pool.length >= want) break;
    const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    url.searchParams.set("outputMint", token.id);
    url.searchParams.set("amount", "200000000");
    url.searchParams.set("slippageBps", "1500");
    let quote: any;
    try {
      quote = await fetchJson<any>(url.toString());
    } catch {
      continue;
    }
    if (quote.error || !quote.routePlan?.length) continue;
    let swap: any;
    try {
      swap = await fetchJson<any>("https://lite-api.jup.ag/swap/v1/swap-instructions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: PublicKey.default.toBase58(),
          wrapAndUnwrapSol: false,
          useSharedAccounts: false,
        }),
      });
    } catch {
      continue;
    }
    if (!swap.swapInstruction) continue;
    pool.push({
      mint: new PublicKey(token.id),
      symbol: (token.symbol ?? token.id.slice(0, 6)).replace(/[^\x20-\x7e]/g, ""),
      liquidityUsd: Math.round(Number(token.liquidity ?? 0)),
      venue: quote.routePlan.map((h: any) => h.swapInfo?.label).join(">"),
      routeAccounts: swap.swapInstruction.accounts.length,
    });
  }
  return pool;
}

/**
 * Run one shape uncapped; fall back to a cap only if the transaction does not
 * fit, and record which path was taken.
 */
async function runAdaptive(
  connection: Connection,
  payer: any,
  quoteAuthority: any,
  name: string,
  launch: PublicKey,
  legs: Leg[],
  total: string
): Promise<CaseResult & { cap: string }> {
  const uncapped = await runSplitCase(
    connection,
    payer,
    quoteAuthority,
    `${name}-uncapped`,
    launch,
    legs,
    total,
    { maxAccountsPerLeg: 0 }
  );
  const didNotFit =
    uncapped.status !== "burned" &&
    /1232|overrun|too large|encoding/i.test(uncapped.detail ?? "");
  if (uncapped.status === "burned" || !didNotFit) {
    return { ...uncapped, cap: "none" };
  }
  const capped = await runSplitCase(
    connection,
    payer,
    quoteAuthority,
    `${name}-capped`,
    launch,
    legs,
    total,
    { maxAccountsPerLeg: legs.length >= 3 ? 16 : 26 }
  );
  return { ...capped, cap: legs.length >= 3 ? "16" : "26" };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const pool = await buildCandidatePool(8);
  console.error("candidate pool (random draw this run):");
  for (const c of pool) {
    console.error(
      `  ${c.symbol.padEnd(12)} $${String(c.liquidityUsd).padEnd(10)} ${String(c.routeAccounts).padStart(2)} route accts  ${c.venue}`
    );
  }
  if (pool.length < 5) throw new Error("could not assemble a candidate pool");

  const results: any[] = [];
  const pick = (i: number) => pool[i % pool.length];

  // 1 burn, 2 burns, 3 burns. The majority token and both 15% legs are drawn
  // from the random pool, not hardcoded.
  const shapes = [
    {
      name: "random-1-burn-100",
      legs: [{ label: pick(0).symbol, mint: pick(0).mint, bps: 10000 }],
      note: `100% ${pick(0).symbol}`,
    },
    {
      name: "random-2-burn-85-15",
      legs: [
        { label: pick(1).symbol, mint: pick(1).mint, bps: 8500 },
        { label: pick(2).symbol, mint: pick(2).mint, bps: 1500 },
      ],
      note: `85% ${pick(1).symbol} / 15% ${pick(2).symbol}`,
    },
    {
      name: "random-3-burn-70-15-15",
      legs: [
        { label: pick(3).symbol, mint: pick(3).mint, bps: 7000 },
        { label: pick(4).symbol, mint: pick(4).mint, bps: 1500 },
        { label: pick(5).symbol, mint: pick(5).mint, bps: 1500 },
      ],
      note: `70% ${pick(3).symbol} / 15% ${pick(4).symbol} / 15% ${pick(5).symbol}`,
    },
    {
      // The configuration the product is actually for: the creator's own token
      // as majority, two fixed community tokens at 15%.
      name: "random-own-70-neiro-15-pump-15",
      legs: [
        { label: pick(6).symbol, mint: pick(6).mint, bps: 7000 },
        { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
        { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
      ],
      note: `70% ${pick(6).symbol} / 15% NEIRO / 15% PUMP`,
    },
  ];

  for (const shape of shapes) {
    process.stderr.write(`\n${shape.name}: ${shape.note}\n  `);
    const result = await runAdaptive(
      connection,
      payer,
      quoteAuthority,
      shape.name,
      // The launch mint is a namespace only; use the majority token's mint,
      // which is what a creator burning their own token would configure.
      shape.legs[0].mint,
      shape.legs,
      "0.5"
    );
    results.push({
      name: shape.name,
      config: shape.note,
      cap: result.cap,
      status: result.status,
      computeUnits: result.computeUnits,
      txBytes: result.txBytes,
      accountLocks: result.accountLocks,
      burned: result.burned,
      routes: result.routes,
      detail: result.status === "burned" ? undefined : (result.detail ?? "").slice(0, 200),
    });
    process.stderr.write(
      `${result.status} cap=${result.cap} ${result.computeUnits ?? "?"}cu ${result.txBytes ?? "?"}b ${result.accountLocks ?? "?"}locks\n`
    );
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(JSON.stringify({ pool, results }, null, 2));
  const burned = results.filter((r) => r.status === "burned").length;
  const neededCap = results.filter((r) => r.cap !== "none").length;
  console.error(
    `\n${burned}/${results.length} burned; ${neededCap} of them needed a maxAccounts cap to fit`
  );
  process.exit(burned === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
