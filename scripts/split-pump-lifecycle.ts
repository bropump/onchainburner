/**
 * A Pump token is a burn target twice over, on two different venues:
 *
 *   1. ON the bonding curve, pre-graduation. Jupiter routes it through the
 *      Pump.fun program itself.
 *   2. AFTER graduation, once the curve completes and liquidity migrates.
 *      Jupiter routes it through PumpSwap ("Pump.fun Amm") or whatever pool
 *      it landed in.
 *
 * These are different programs with different account layouts, so "a Pump
 * token burns" is two claims. This classifies live mainnet Pump tokens into
 * the two states by probing each venue in isolation, then runs a real split
 * burn against one of each with the Pump token as the majority leg.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  fetchJson,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  TOKENS,
} from "./surfpool-split-e2e";

const BONDING_CURVE_VENUE = "Pump.fun";
const GRADUATED_VENUES = ["Pump.fun Amm", "Raydium", "Raydium CLMM", "Whirlpool"];
const PROBE_LAMPORTS = "50000000"; // 0.05 SOL

async function routableOn(mint: string, dexes: string[]): Promise<boolean> {
  const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
  url.searchParams.set("outputMint", mint);
  url.searchParams.set("amount", PROBE_LAMPORTS);
  url.searchParams.set("slippageBps", "1500");
  url.searchParams.set("dexes", dexes.join(","));
  try {
    const quote = await fetchJson<any>(url.toString());
    return !quote.error && Array.isArray(quote.routePlan) && quote.routePlan.length > 0;
  } catch {
    return false;
  }
}

async function classifyPumpTokens() {
  const feeds = [
    "https://lite-api.jup.ag/tokens/v2/recent?limit=100",
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
  ];
  const seen = new Map<string, any>();
  for (const feed of feeds) {
    try {
      for (const token of await fetchJson<any[]>(feed)) {
        if (typeof token.id === "string" && token.id.endsWith("pump")) {
          seen.set(token.id, token);
        }
      }
    } catch {
      /* one feed being unavailable is not fatal */
    }
  }

  const onCurve: any[] = [];
  const graduated: any[] = [];
  for (const token of [...seen.values()].sort(
    (a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0)
  )) {
    if (onCurve.length >= 2 && graduated.length >= 2) break;
    if (graduated.length < 2 && (await routableOn(token.id, GRADUATED_VENUES))) {
      graduated.push(token);
      continue;
    }
    if (onCurve.length < 2 && (await routableOn(token.id, [BONDING_CURVE_VENUE]))) {
      onCurve.push(token);
    }
  }
  return { onCurve, graduated };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const { onCurve, graduated } = await classifyPumpTokens();
  console.error(
    `bonding curve: ${onCurve.map((t) => t.symbol ?? t.id.slice(0, 6)).join(", ") || "(none)"}`
  );
  console.error(
    `graduated:     ${graduated.map((t) => t.symbol ?? t.id.slice(0, 6)).join(", ") || "(none)"}`
  );

  const report: any = { bondingCurve: [], graduated: [] };

  for (const [state, tokens, venues] of [
    ["bondingCurve", onCurve, [BONDING_CURVE_VENUE]],
    ["graduated", graduated, GRADUATED_VENUES],
  ] as const) {
    for (const token of tokens) {
      const mint = new PublicKey(token.id);
      const symbol = token.symbol ?? token.id.slice(0, 6);
      const own = (bps: number) => ({
        label: `OWN:${symbol}`,
        mint,
        bps,
        dexes: [...venues],
      });
      // A Pump bonding-curve route is ~40 accounts by itself, so the number
      // of OTHER legs that still fit alongside it is the real question. Walk
      // the configurations from widest to narrowest and record where it stops.
      const shapes = [
        { name: "3-leg-70-15-15", legs: [own(7000), { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 }, { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 }] },
        { name: "2-leg-85-15", legs: [own(8500), { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 }] },
        { name: "1-leg-100", legs: [own(10000)] },
      ];
      for (const shape of shapes) {
        const result = await runSplitCase(
          connection,
          payer,
          quoteAuthority,
          `pump-${state}-${symbol}-${shape.name}`.replace(/[^a-zA-Z0-9-]/g, ""),
          mint,
          shape.legs,
          "0.4",
          // Do not cap the route: the point is to measure what a real Pump
          // route costs, not to force it into a budget it cannot meet.
          { maxAccountsPerLeg: 0 }
        );
        report[state].push({
          mint: token.id,
          symbol,
          shape: shape.name,
          liquidityUsd: Math.round(Number(token.liquidity ?? 0)),
          status: result.status,
          computeUnits: result.computeUnits,
          txBytes: result.txBytes,
          accountLocks: result.accountLocks,
          burned: result.burned,
          routes: result.routes,
          detail:
            result.status === "burned" ? undefined : (result.detail ?? "").slice(0, 160),
        });
        console.error(
          `${state} ${symbol} ${shape.name}: ${result.status} ${result.computeUnits ?? "?"}cu ` +
            `${result.txBytes ?? "?"}b ${result.accountLocks ?? "?"}locks`
        );
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const curveOk = report.bondingCurve.some((r: any) => r.status === "burned");
  const gradOk = report.graduated.some((r: any) => r.status === "burned");
  console.error(
    "\nwidest shape that fits per state: " +
      JSON.stringify(
        Object.fromEntries(
          ["bondingCurve", "graduated"].map((state) => [
            state,
            report[state].find((r: any) => r.status === "burned")?.shape ?? "none",
          ])
        )
      )
  );
  console.error(
    `\nbonding-curve burn: ${curveOk ? "OK" : "FAILED"} | graduated burn: ${gradOk ? "OK" : "FAILED"}`
  );
  process.exit(curveOk && gradOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
