/**
 * Authoritative, repeated test of whether Pump venues can now be burned.
 *
 * Runs a real 1-leg 100% burn against N distinct tokens on each Pump venue,
 * with the client-side pre-creation in place (volume accumulator + every
 * missing route ATA, all paid by the caller, never the vault). Reports the
 * per-venue pass rate and attributes every failure, so a Jupiter/AMM problem
 * is never counted as a burner limitation.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  fetchJson, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports,
} from "./surfpool-split-e2e";

const VENUES = [
  ["PumpSwap", "Pump.fun Amm"],
  ["bonding curve", "Pump.fun"],
] as const;
const PER_VENUE = Number(process.env.PER_VENUE ?? "4");

async function tokensOn(venue: string, want: number) {
  const seen = new Map<string, any>();
  for (const f of [
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
    "https://lite-api.jup.ag/tokens/v2/recent?limit=100",
    "https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100",
  ]) {
    try { for (const t of await fetchJson<any[]>(f)) if (t?.id?.endsWith("pump")) seen.set(t.id, t); }
    catch {}
  }
  const out: any[] = [];
  for (const t of seen.values()) {
    if (out.length >= want) break;
    const u = new URL("https://lite-api.jup.ag/swap/v1/quote");
    u.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    u.searchParams.set("outputMint", t.id);
    u.searchParams.set("amount", "150000000");
    u.searchParams.set("slippageBps", "1500");
    u.searchParams.set("dexes", venue);
    try {
      const q = await fetchJson<any>(u.toString());
      if (!q.error && q.routePlan?.length)
        out.push({ mint: t.id, symbol: (t.symbol ?? t.id.slice(0,6)).replace(/[^\x20-\x7e]/g,"") });
    } catch {}
  }
  return out;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const rows: any[] = [];

  for (const [label, venue] of VENUES) {
    const tokens = await tokensOn(venue, PER_VENUE);
    console.error(`\n=== ${label} (${venue}): ${tokens.length} tokens ===`);
    for (const t of tokens) {
      const mint = new PublicKey(t.mint);
      const before = await connection.getBalance(payer.publicKey, "confirmed");
      const r = await runSplitCase(
        connection, payer, quoteAuthority,
        `verdict-${label}-${t.symbol}`.replace(/[^a-zA-Z0-9-]/g, ""),
        mint, [{ label: t.symbol, mint, bps: 10000, dexes: [venue] }], "0.15",
        { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
      );
      const after = await connection.getBalance(payer.publicKey, "confirmed");
      rows.push({
        venue: label, token: t.symbol, mint: t.mint,
        status: r.status, code: r.errorCode, by: r.rejectedBy, name: r.errorName,
        cu: r.computeUnits, burned: r.burned,
        callerSetupCostSol: ((before - after) / 1e9).toFixed(6),
        burnerFault: r.status !== "burned" && r.rejectedBy === "burner",
      });
      console.error(
        `  ${t.symbol.padEnd(12)} ${r.status.padEnd(9)} ${String(r.errorCode ?? "").padEnd(5)} ` +
          `${(r.rejectedBy ?? "").padEnd(8)} callerCost=${((before-after)/1e9).toFixed(5)} SOL`
      );
      await new Promise((x) => setTimeout(x, 2000));
    }
  }

  console.log(JSON.stringify(rows, null, 2));
  for (const [label] of VENUES) {
    const v = rows.filter((r) => r.venue === label);
    const ok = v.filter((r) => r.status === "burned").length;
    const mine = v.filter((r) => r.burnerFault).length;
    console.error(`\n${label}: ${ok}/${v.length} burned; ${mine} rejected BY THE BURNER`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
