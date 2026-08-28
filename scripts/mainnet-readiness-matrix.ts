/**
 * Wide burn-coverage matrix for mainnet readiness.
 *
 * Burns many tokens across every venue class the product cares about, on the
 * Surfpool mainnet fork, with the Pump/launchpad pre-creation in place. Every
 * failure is attributed to the program that raised it, so a Jupiter/AMM/fork
 * problem is never counted against the burner. The bar for "ready" is: zero
 * failures attributed to the BURNER across the whole matrix.
 *
 * Tokens are a mix of fixed blue chips (JTO, NEIRO, $PUMP, BONK, WIF,
 * FARTCOIN, POPCAT, RAY) and live-discovered launchpad tokens (fresh Pump
 * curve, PumpSwap, Raydium Launchlab, Meteora DBC), so the run covers
 * new-launch through established.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  fetchJson, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports, TOKENS,
} from "./surfpool-split-e2e";

type Subject = { label: string; mint: PublicKey; dexes?: string[]; category: string };

const BLUE_CHIPS: Subject[] = [
  { label: "JTO",      mint: TOKENS.JTO,      category: "bluechip" },
  { label: "NEIRO",    mint: TOKENS.NEIRO,    category: "bluechip" },
  { label: "PUMP",     mint: TOKENS.PUMP,     category: "bluechip-t22" },
  { label: "BONK",     mint: TOKENS.BONK,     category: "bluechip" },
  { label: "WIF",      mint: TOKENS.WIF,      category: "bluechip" },
  { label: "FARTCOIN", mint: TOKENS.FARTCOIN, category: "bluechip" },
  { label: "POPCAT",   mint: TOKENS.POPCAT,   category: "bluechip" },
  { label: "RAY",      mint: TOKENS.RAY,      category: "bluechip" },
];

async function discover(venue: string, category: string, want: number, endsWith?: string): Promise<Subject[]> {
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
  const out: Subject[] = [];
  for (const t of seen.values()) {
    if (out.length >= want) break;
    if (endsWith && !t.id.endsWith(endsWith)) continue;
    const u = new URL("https://lite-api.jup.ag/swap/v1/quote");
    u.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    u.searchParams.set("outputMint", t.id);
    u.searchParams.set("amount", "150000000");
    u.searchParams.set("slippageBps", "1500");
    u.searchParams.set("dexes", venue);
    try {
      const q = await fetchJson<any>(u.toString());
      if (!q.error && q.routePlan?.length) {
        out.push({
          label: `${category}:${(t.symbol ?? t.id.slice(0, 5)).replace(/[^\x20-\x7e]/g, "")}`,
          mint: new PublicKey(t.id), dexes: [venue], category,
        });
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

  const discovered = [
    ...await discover("Pump.fun", "pump-curve", 3, "pump"),
    ...await discover("Pump.fun Amm", "pumpswap", 3, "pump"),
    ...await discover("Raydium Launchlab", "launchlab", 3),
    ...await discover("Dynamic Bonding Curve", "meteora-dbc", 3),
  ];
  const subjects = [...BLUE_CHIPS, ...discovered];
  console.error(`\n${subjects.length} subjects: ${BLUE_CHIPS.length} blue chips + ${discovered.length} discovered`);
  console.error(discovered.map((s) => s.label).join(", ") || "(none discovered)");

  const rows: any[] = [];
  for (const s of subjects) {
    // Vary size across the run so it isn't all one amount.
    const total = ["0.1", "0.3", "1"][rows.length % 3];
    const r = await runSplitCase(
      connection, payer, quoteAuthority,
      `ready-${s.label}`.replace(/[^a-zA-Z0-9-]/g, ""),
      s.mint, [{ label: s.label, mint: s.mint, bps: 10000, dexes: s.dexes }], total,
      { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );
    rows.push({
      category: s.category, label: s.label, mint: s.mint.toBase58(), totalSol: total,
      status: r.status, code: r.errorCode, by: r.rejectedBy, name: r.errorName,
      cu: r.computeUnits, locks: r.accountLocks,
      burnerFault: r.status !== "burned" && r.rejectedBy === "burner",
      detail: r.status === "burned" ? undefined : (r.detail ?? "").slice(0, 120),
    });
    console.error(
      `  ${s.label.padEnd(22)} ${total.padStart(4)} SOL  ${r.status.padEnd(9)} ` +
        `${String(r.errorCode ?? "").padEnd(5)} ${(r.rejectedBy ?? "").padEnd(8)} ${r.computeUnits ?? "?"}cu` +
        (r.status !== "burned" ? `  <- ${(r.detail ?? "").slice(0, 70).replace(/\n/g, " ")}` : "")
    );
    await new Promise((x) => setTimeout(x, 2500));
  }

  console.log(JSON.stringify(rows, null, 2));
  const burned = rows.filter((r) => r.status === "burned").length;
  const burnerFaults = rows.filter((r) => r.burnerFault);
  console.error(`\n${burned}/${rows.length} burned`);
  console.error(`BURNER-ATTRIBUTED FAILURES: ${burnerFaults.length}`);
  for (const f of burnerFaults) console.error(`  !! ${f.label} ${f.code} ${f.name} -- ${f.detail}`);
  const byCat: Record<string, { ok: number; n: number; burnerFaults: number }> = {};
  for (const r of rows) {
    (byCat[r.category] ||= { ok: 0, n: 0, burnerFaults: 0 });
    byCat[r.category].n += 1;
    if (r.status === "burned") byCat[r.category].ok += 1;
    if (r.burnerFault) byCat[r.category].burnerFaults += 1;
  }
  console.error("\nby category:");
  for (const [c, v] of Object.entries(byCat))
    console.error(`  ${c.padEnd(16)} ${v.ok}/${v.n} burned, ${v.burnerFaults} burner-fault`);
  // Ready = nothing the burner itself rejected.
  process.exit(burnerFaults.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
