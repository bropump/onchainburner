/**
 * Do Raydium Launchlab and Meteora Dynamic Bonding Curve tokens burn?
 *
 * Both are launchpads of the same shape as Pump: a bonding curve that later
 * graduates to an LP pool. The program has no notion of venues -- it validates
 * account pins and postconditions -- so nothing has to be "added" for a venue.
 * The only question is whether the venue charges the BUYER extra lamports the
 * way Pump does, and if so whether the same client-side pre-creation (missing
 * route ATAs, paid by the caller) covers it.
 *
 * Any failure is attributed, so a Jupiter/AMM/fork problem is never reported
 * as a burner limitation.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  fetchJson, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports,
} from "./surfpool-split-e2e";

const SUBJECTS = [
  { venue: "Raydium Launchlab", label: "Raydium Launchlab" },
  { venue: "Dynamic Bonding Curve", label: "Meteora DBC" },
] as const;

async function tokensOn(venue: string, want: number) {
  const seen = new Map<string, any>();
  for (const f of [
    "/tokens/v2/recent?limit=100",
    "/tokens/v2/toporganicscore/24h?limit=100",
    "/tokens/v2/toptraded/24h?limit=100",
  ]) {
    try { for (const t of await fetchJson<any[]>(`https://lite-api.jup.ag${f}`)) if (t?.id) seen.set(t.id, t); }
    catch {}
    await new Promise((r) => setTimeout(r, 1200));
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
      if (!q.error && q.routePlan?.length) {
        out.push({ mint: t.id, symbol: (t.symbol ?? t.id.slice(0, 6)).replace(/[^\x20-\x7e]/g, "") });
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const rows: any[] = [];

  for (const s of SUBJECTS) {
    const tokens = await tokensOn(s.venue, Number(process.env.PER_VENUE ?? "3"));
    console.error(`\n=== ${s.label} — ${tokens.length} token(s) found ===`);
    if (!tokens.length) {
      rows.push({ venue: s.label, result: "UNTESTABLE: no live token routes through this venue" });
      console.error("  no token routes through this venue right now -> untestable, NOT 'working'");
      continue;
    }
    for (const t of tokens) {
      const mint = new PublicKey(t.mint);
      const r = await runSplitCase(
        connection, payer, quoteAuthority,
        `lp-${s.label}-${t.symbol}`.replace(/[^a-zA-Z0-9-]/g, ""),
        mint, [{ label: t.symbol, mint, bps: 10000, dexes: [s.venue] }], "0.15",
        { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
      );
      rows.push({
        venue: s.label, token: t.symbol, mint: t.mint,
        status: r.status, code: r.errorCode, by: r.rejectedBy, name: r.errorName,
        cu: r.computeUnits, locks: r.accountLocks, burned: r.burned,
        burnerFault: r.status !== "burned" && r.rejectedBy === "burner",
        detail: r.status === "burned" ? undefined : (r.detail ?? "").slice(0, 140),
      });
      console.error(
        `  ${t.symbol.padEnd(14)} ${r.status.padEnd(9)} ${String(r.code ?? r.errorCode ?? "").padEnd(5)} ` +
          `${(r.rejectedBy ?? "").padEnd(8)} ${r.computeUnits ?? "?"}cu`
      );
      await new Promise((x) => setTimeout(x, 2000));
    }
  }

  console.log(JSON.stringify(rows, null, 2));
  for (const s of SUBJECTS) {
    const v = rows.filter((r) => r.venue === s.label && r.status);
    if (!v.length) { console.error(`\n${s.label}: UNTESTABLE (no subject)`); continue; }
    console.error(
      `\n${s.label}: ${v.filter((r) => r.status === "burned").length}/${v.length} burned; ` +
        `${v.filter((r) => r.burnerFault).length} rejected BY THE BURNER`
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
