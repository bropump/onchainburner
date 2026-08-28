/**
 * Which launchpad / AMM venues can actually be burned through?
 *
 * The burner pins the vault's lamport delta to exactly the authorized input,
 * so any venue that charges the BUYER extra SOL (account rent, a creator fee
 * paid in lamports) reverts with 6019 `BurnPdaLamportMismatch`. Pump.fun's
 * bonding curve and PumpSwap were already established that way. This runs the
 * same one-variable test across every venue a launch token is likely to live
 * on -- Raydium Launchlab, Meteora Dynamic Bonding Curve, Boop.fun, Virtuals,
 * and the pool AMMs -- with the burner in the loop.
 *
 * A venue is only reported as usable if a real 1-leg 100% burn LANDS through
 * it. Each vault is funded with a generous buffer so "ran out of lamports" can
 * never be mistaken for "forbidden from spending extra".
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  fetchJson,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  solToLamports,
} from "./surfpool-split-e2e";

const VENUES = [
  "Raydium Launchlab",
  "Dynamic Bonding Curve",
  "Boop.fun",
  "Virtuals",
  "Pump.fun Amm",
  "Pump.fun",
  "Meteora DAMM v2",
  "Meteora DLMM",
  "Raydium",
  "Whirlpool",
];

/** A token Jupiter will route through this specific venue and nothing else. */
async function findTokenOn(venue: string): Promise<{ mint: string; symbol: string } | null> {
  const feeds = [
    "https://lite-api.jup.ag/tokens/v2/recent?limit=100",
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
    "https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100",
  ];
  const seen = new Map<string, any>();
  for (const feed of feeds) {
    try {
      for (const t of await fetchJson<any[]>(feed)) if (t?.id) seen.set(t.id, t);
    } catch {
      /* a feed being down is not fatal */
    }
  }
  for (const token of seen.values()) {
    const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    url.searchParams.set("outputMint", token.id);
    url.searchParams.set("amount", "200000000");
    url.searchParams.set("slippageBps", "1500");
    url.searchParams.set("dexes", venue);
    try {
      const q = await fetchJson<any>(url.toString());
      if (!q.error && q.routePlan?.length) {
        return {
          mint: token.id,
          symbol: (token.symbol ?? token.id.slice(0, 6)).replace(/[^\x20-\x7e]/g, ""),
        };
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const rows: any[] = [];

  for (const venue of VENUES) {
    const token = await findTokenOn(venue);
    if (!token) {
      rows.push({ venue, result: "no token found routable on this venue" });
      console.error(`  ${venue.padEnd(24)} no routable token found`);
      continue;
    }
    const result = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `venue-${venue}-${token.symbol}`.replace(/[^a-zA-Z0-9-]/g, ""),
      new PublicKey(token.mint),
      [{ label: token.symbol, mint: new PublicKey(token.mint), bps: 10000, dexes: [venue] }],
      "0.2",
      { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05") }
    );
    rows.push({
      venue,
      token: token.symbol,
      mint: token.mint,
      status: result.status,
      errorCode: result.errorCode,
      errorName: result.errorName,
      rejectedBy: result.rejectedBy,
      computeUnits: result.computeUnits,
      accountLocks: result.accountLocks,
      txBytes: result.txBytes,
      burnable: result.status === "burned",
      detail: result.status === "burned" ? undefined : (result.detail ?? "").slice(0, 130),
    });
    console.error(
      `  ${venue.padEnd(24)} ${token.symbol.padEnd(12)} ${result.status.padEnd(9)} ` +
        `${result.errorCode ?? ""} ${result.errorName ?? ""}`
    );
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log(JSON.stringify(rows, null, 2));
  const ok = rows.filter((r) => r.burnable).map((r) => r.venue);
  const bad = rows.filter((r) => r.status && !r.burnable).map((r) => r.venue);
  console.error(`\nBURNABLE:     ${ok.join(", ") || "(none)"}`);
  console.error(`NOT BURNABLE: ${bad.join(", ") || "(none)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
