/**
 * Can we BUY AND BURN Pump tokens that carry a non-standard launch mode?
 *
 * This is the BURN-TARGET question, which is separate from the funding
 * question. Whether a launch's creator fees reach the vault (they do not for
 * cashback or a non-SOL quote mint) has nothing to do with whether that same
 * token can be swapped into and burned once it is a configured target. A
 * vault funded by ANY normal launch may name a cashback or mayhem coin among
 * its targets, so this has to hold independently.
 *
 * Discovery is by mode read off chain, not by trusting a label: every
 * candidate's Pump bonding curve is fetched and classified by
 * `is_mayhem_mode` (byte 81), `is_cashback_coin` (byte 82) and `quote_mint`
 * (bytes 83..115). Established non-Pump targets run in the same pass as the
 * control -- if they fail too, the fork's routing is the problem, not the mode.
 *
 * Pass = the burn lands, or fails with an EXTERNAL attribution. Any
 * burner-attributed failure is a real defect and fails the run.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchJson,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Namespace only -- a plain SOL transfer funds the vault, so mode is irrelevant here. */
const LAUNCH_NAMESPACE = TOKENS.NEIRO;

type Candidate = { mint: PublicKey; symbol: string; mode: string };

/** Pre-graduation curves only: `complete` is at byte 48 (discriminator + 5 u64). */
function isGraduated(data: Buffer): boolean {
  return data[48] === 1;
}

function classify(data: Buffer): string {
  const quote = new PublicKey(data.subarray(83, 115));
  if (!quote.equals(PublicKey.default)) {
    return quote.toBase58() === USDC ? "usdc-quote" : "other-quote";
  }
  if (data[81]) return "mayhem";
  if (data[82]) return "cashback";
  return "normal";
}

/** Pull a wide pool of Pump tokens and bucket them by on-chain mode. */
async function discover(connection: Connection, want: number): Promise<Candidate[]> {
  const feeds = [
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
    "https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100",
    "https://lite-api.jup.ag/tokens/v2/recent?limit=100",
  ];
  const seen = new Set<string>();
  const pool: { id: string; symbol: string }[] = [];
  for (const feed of feeds) {
    try {
      const rows = await fetchJson<any>(feed, undefined, true);
      for (const t of rows ?? []) {
        const id = String(t.id ?? "");
        if (!id.endsWith("pump") || seen.has(id)) continue;
        seen.add(id);
        pool.push({ id, symbol: String(t.symbol ?? id.slice(0, 4)) });
      }
    } catch {
      /* a feed being down must not abort discovery */
    }
  }

  const byMode = new Map<string, Candidate[]>();
  for (let i = 0; i < pool.length; i += 25) {
    const batch = pool.slice(i, i + 25);
    const curves = batch.map(
      (t) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from("bonding-curve"), new PublicKey(t.id).toBuffer()],
          PUMP_FUN
        )[0]
    );
    const infos = await connection.getMultipleAccountsInfo(curves, "confirmed");
    infos.forEach((info, j) => {
      // No curve = graduated to PumpSwap. Its launch mode is no longer
      // readable, so it cannot be classified and is skipped rather than
      // silently counted as normal.
      if (!info || info.data.length < 115) return;
      // Compare like with like: a graduated coin routes through PumpSwap, a
      // different code path from the raw bonding curve. Mixing them would
      // make a raw-curve problem look like a mode problem.
      const graduated = isGraduated(info.data);
      if (process.env.CURVE_ONLY === "1" && graduated) return;
      const mode = classify(info.data) + (graduated ? "-grad" : "-curve");
      const list = byMode.get(mode) ?? [];
      if (list.length < want) {
        list.push({
          mint: new PublicKey(batch[j].id),
          symbol: batch[j].symbol,
          mode,
        });
      }
      byMode.set(mode, list);
    });
  }
  console.log(
    "discovered by mode: " +
      [...byMode.entries()].map(([m, l]) => `${m}=${l.length}`).join("  ")
  );
  return [...byMode.values()].flat();
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const perMode = Number(process.env.PER_MODE ?? 3);

  const candidates = await discover(connection, perMode);
  const controls: Candidate[] = [
    { mint: TOKENS.JTO, symbol: "JTO", mode: "control" },
    { mint: TOKENS.RAY, symbol: "RAY", mode: "control" },
    { mint: TOKENS.PUMP, symbol: "PUMP", mode: "control" },
  ];
  const subjects = [...candidates, ...controls];
  console.log(`\nburning ${subjects.length} targets as 100% single legs\n`);

  const rows: any[] = [];
  for (const s of subjects) {
    const legs: Leg[] = [{ label: s.symbol.slice(0, 10), mint: s.mint, bps: 10000 }];
    const r = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `mode-${s.mode}-${s.symbol}`.replace(/[^a-zA-Z0-9-]/g, ""),
      LAUNCH_NAMESPACE,
      legs,
      process.env.BURN_SOL ?? "0.05",
      { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );
    const burnerFault = r.status !== "burned" && r.rejectedBy === "burner";
    rows.push({
      mode: s.mode,
      symbol: s.symbol,
      mint: s.mint.toBase58(),
      status: r.status,
      cu: r.computeUnits,
      code: r.errorCode,
      by: r.rejectedBy,
      burnerFault,
      signature: r.signature,
      detail: r.status === "burned" ? undefined : (r.detail ?? "").slice(0, 110),
    });
    console.log(
      `  ${s.mode.padEnd(11)} ${s.symbol.slice(0, 12).padEnd(13)} ${r.status.padEnd(9)} ` +
        `${String(r.errorCode ?? "").padEnd(5)} ${(r.rejectedBy ?? "").padEnd(9)} ` +
        `${r.computeUnits ?? "-"}cu` + (burnerFault ? "   <-- BURNER FAULT" : "")
    );
    await new Promise((x) => setTimeout(x, 1500));
  }

  console.log("\n=== by mode ===");
  const modes = [...new Set(rows.map((r) => r.mode))];
  for (const m of modes) {
    const inMode = rows.filter((r) => r.mode === m);
    const burned = inMode.filter((r) => r.status === "burned").length;
    const faults = inMode.filter((r) => r.burnerFault).length;
    console.log(
      `  ${m.padEnd(11)} burned ${burned}/${inMode.length}   burner faults: ${faults}`
    );
  }
  const totalFaults = rows.filter((r) => r.burnerFault).length;
  console.log(
    `\n${rows.filter((r) => r.status === "burned").length}/${rows.length} burned, ` +
      `${totalFaults} burner-attributed failures.`
  );
  require("fs").writeFileSync(
    "/tmp/mode-target-matrix.json",
    JSON.stringify(rows, null, 2)
  );
  process.exit(totalFaults === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
