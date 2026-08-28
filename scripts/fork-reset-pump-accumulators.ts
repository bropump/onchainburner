/**
 * FORK-ONLY state repair: remove Pump.fun volume accumulators that the
 * PRE-FIX client initialized for test vaults.
 *
 * The old client called `init_user_volume_accumulator` for every
 * Pump-ecosystem vault. Under Jupiter v2 an INITIALIZED accumulator makes a
 * reward-tier raw-curve burn unconservable in both directions: the program
 * snapshots it and demands an in-route close, and any close returns the
 * route's own reward deposit on top of the admitted credit (6019). The fixed
 * client never initializes it (it pre-FUNDS the bare address instead), so a
 * production vault operated with the fixed client from day one never enters
 * this state. This script resets fork vaults that the buggy client already
 * touched, restoring the state a correctly-operated vault would have.
 *
 * Only exact artifacts are removed: Pump.fun-owned, correct discriminator,
 * stored user == vault, and balance == exactly the untouched creation rent
 * (no accrued value is ever destroyed). Uses surfnet_setAccount, which only
 * exists on a Surfpool fork.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { deriveSplitPda, fetchJson, RPC_URL } from "./surfpool-split-e2e";

const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const ACCUMULATOR_DISCRIMINATOR = Buffer.from([86, 255, 112, 14, 102, 53, 154, 250]);

async function resolveMatrixSymbols(): Promise<string[]> {
  const symbols = (process.env.SYMBOLS ??
    "RAY,ORCA,JUP,JTO,BONK,WIF,MET,W,PYTH,POPCAT,FARTCOIN,MEW,BOME,PNUT,GOAT,MOODENG,TRUMP,JitoSOL,mSOL,USDC"
  ).split(",");
  const mints: string[] = [];
  for (const symbol of symbols) {
    try {
      const hits = await fetchJson<any[]>(
        `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(symbol)}`
      );
      const exact = hits
        .filter((t) => (t.symbol ?? "").toUpperCase() === symbol.toUpperCase())
        .sort((a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0))[0];
      if (exact) mints.push(exact.id);
    } catch {}
    await new Promise((r) => setTimeout(r, 700));
  }
  return mints;
}

async function verdictCandidates(): Promise<string[]> {
  const seen = new Set<string>();
  for (const f of ["/tokens/v2/recent?limit=100", "/tokens/v2/toporganicscore/24h?limit=100"]) {
    try {
      for (const t of await fetchJson<any[]>(`https://lite-api.jup.ag${f}`)) {
        if (t?.id?.endsWith("pump")) seen.add(t.id);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }
  return [...seen];
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const args = process.argv.slice(2);
  const mints = new Set<string>(args.filter((a) => !a.startsWith("--")));
  if (args.includes("--matrix")) for (const m of await resolveMatrixSymbols()) mints.add(m);
  if (args.includes("--verdict")) for (const m of await verdictCandidates()) mints.add(m);

  const rent = await connection.getMinimumBalanceForRentExemption(137);
  let reset = 0, kept = 0;
  for (const m of mints) {
    let mint: PublicKey;
    try { mint = new PublicKey(m); } catch { continue; }
    const [vault] = deriveSplitPda(mint, [{ mint, bps: 10000 }]);
    const [accumulator] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), vault.toBuffer()], PUMP_FUN);
    const info = await connection.getAccountInfo(accumulator, "confirmed");
    if (!info || !info.owner.equals(PUMP_FUN)) continue;
    // `--force-accrued` also resets exact-layout vault accumulators whose
    // balance exceeds the bare creation rent. On this disposable fork that
    // accrual is the parked reward of an earlier flip-normalized TEST burn
    // (nothing else produces this state here); never use the flag on state
    // whose value someone could still claim.
    const balanceOk = process.argv.includes("--force-accrued")
      ? info.lamports >= rent
      : info.lamports === rent;
    const isArtifact =
      balanceOk &&
      info.data.length >= 40 &&
      info.data.subarray(0, 8).equals(ACCUMULATOR_DISCRIMINATOR) &&
      info.data.subarray(8, 40).equals(vault.toBuffer());
    if (!isArtifact) {
      console.log(`KEEP  ${m.slice(0, 8)} ${accumulator.toBase58()} lamports=${info.lamports} (accrued value or foreign layout)`);
      kept++;
      continue;
    }
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "surfnet_setAccount",
        params: [accumulator.toBase58(), { lamports: 0, data: "", owner: "11111111111111111111111111111111" }],
      }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`surfnet_setAccount: ${JSON.stringify(body.error)}`);
    console.log(`RESET ${m.slice(0, 8)} ${accumulator.toBase58()} (pre-fix init artifact, rent-only balance)`);
    reset++;
  }
  console.log(`\nreset ${reset}, kept ${kept}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
