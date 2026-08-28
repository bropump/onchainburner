/**
 * The raw Pump bonding curve, with the lazy-migration pre-payment in place.
 *
 * Pump grows each token's bonding_curve 115 -> 151 bytes on the first buy
 * after its program upgrade and bills the buyer 250_560 lamports. That is per
 * TOKEN, which is why the failure looked intermittent. The client now sends an
 * idempotent `extend_account` for every target that still has a curve, paid by
 * the caller, so the vault never sees the charge and the 6019 guard is
 * untouched.
 *
 * Reports the curve size before/after so the migration is visible, and counts
 * only BURNER-attributed failures against the program.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  fetchJson, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports,
} from "./surfpool-split-e2e";

const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const curveOf = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_FUN)[0];

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const seen = new Map<string, any>();
  for (const f of ["/tokens/v2/recent?limit=100", "/tokens/v2/toporganicscore/24h?limit=100"]) {
    try { for (const t of await fetchJson<any[]>(`https://lite-api.jup.ag${f}`)) if (t?.id?.endsWith("pump")) seen.set(t.id, t); }
    catch {}
    await new Promise(r => setTimeout(r, 1500));
  }

  const rows: any[] = [];
  const want = Number(process.env.WANT ?? "6");
  for (const t of seen.values()) {
    if (rows.length >= want) break;
    const mint = new PublicKey(t.id);
    // Only raw-curve tokens: the curve must exist and not be complete.
    const info = await connection.getAccountInfo(curveOf(mint), "confirmed");
    if (!info || !info.owner.equals(PUMP_FUN) || info.data[48] !== 0) continue;
    const u = new URL("https://lite-api.jup.ag/swap/v1/quote");
    u.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    u.searchParams.set("outputMint", t.id);
    u.searchParams.set("amount", "150000000");
    u.searchParams.set("slippageBps", "1500");
    u.searchParams.set("dexes", "Pump.fun");
    try { const q = await fetchJson<any>(u.toString()); if (q.error || !q.routePlan?.length) continue; }
    catch { continue; }

    const sizeBefore = info.data.length;
    const sym = `${(t.symbol ?? "?").replace(/[^\x20-\x7e]/g, "")}-${t.id.slice(0, 4)}`;
    const r = await runSplitCase(
      connection, payer, quoteAuthority, `rawcurve-${sym}`.replace(/[^a-zA-Z0-9-]/g, ""),
      mint, [{ label: sym, mint, bps: 10000, dexes: ["Pump.fun"] }], "0.15",
      { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );
    const after = await connection.getAccountInfo(curveOf(mint), "confirmed");
    rows.push({
      token: sym, mint: t.id, curveBytesBefore: sizeBefore, curveBytesAfter: after?.data.length,
      migrated: sizeBefore !== after?.data.length,
      status: r.status, code: r.errorCode, by: r.rejectedBy, cu: r.computeUnits,
      burnerFault: r.status !== "burned" && r.rejectedBy === "burner",
      detail: r.status === "burned" ? undefined : (r.detail ?? "").slice(0, 110),
    });
    console.error(
      `  ${sym.padEnd(14)} curve ${sizeBefore}B->${after?.data.length}B ` +
      `${r.status.padEnd(9)} ${String(r.errorCode ?? "").padEnd(5)} ${(r.rejectedBy ?? "").padEnd(8)} ${r.computeUnits ?? "?"}cu`
    );
    await new Promise(x => setTimeout(x, 2500));
  }

  console.log(JSON.stringify(rows, null, 2));
  const burned = rows.filter(r => r.status === "burned").length;
  const faults = rows.filter(r => r.burnerFault);
  console.error(`\nraw bonding curve: ${burned}/${rows.length} burned, ${faults.length} BURNER-attributed failures`);
  for (const f of faults) console.error(`  !! ${f.token} ${f.code} -- ${f.detail}`);
  process.exit(faults.length === 0 && burned > 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
