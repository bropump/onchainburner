/**
 * Which major Solana tokens can actually be burned?
 *
 * For each token: resolve the mint by symbol (highest liquidity wins, so
 * symbol collisions do not pick a random impostor), pre-screen the mint on
 * chain for the two things that cause an admission refusal (a live freeze
 * authority -> 6036, an active transfer hook or other disallowed Token-2022
 * extension -> 6024), then actually attempt a burn and attribute the result.
 *
 * A failure only counts against the burner if the BURNER raised it. Jupiter
 * and every AMM are Anchor programs whose error codes are also 6000-based, so
 * attribution comes from the innermost failing program frame.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  fetchJson, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports,
} from "./surfpool-split-e2e";

const SYMBOLS = (process.env.SYMBOLS ??
  "RAY,ORCA,JUP,JTO,BONK,WIF,MET,W,PYTH,POPCAT,FARTCOIN,MEW,BOME,PNUT,GOAT,MOODENG,TRUMP,JitoSOL,mSOL,USDC"
).split(",");

async function resolve(symbol: string) {
  try {
    const hits = await fetchJson<any[]>(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(symbol)}`
    );
    const exact = hits
      .filter((t) => (t.symbol ?? "").toUpperCase() === symbol.toUpperCase())
      .sort((a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0))[0];
    return exact ? { mint: new PublicKey(exact.id), liquidity: Number(exact.liquidity ?? 0) } : null;
  } catch {
    return null;
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer(), qa = readQuoteAuthority();
  const rows: any[] = [];

  for (const symbol of SYMBOLS) {
    const found = await resolve(symbol);
    if (!found) { console.error(`  ${symbol.padEnd(10)} could not resolve mint`); continue; }

    // Pre-screen so a refusal is explained rather than merely observed.
    const info = await connection.getAccountInfo(found.mint, "confirmed");
    if (!info) { console.error(`  ${symbol.padEnd(10)} mint not on fork`); continue; }
    const isT22 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
    const mint = await getMint(connection, found.mint, "confirmed", info.owner);
    const freezable = mint.freezeAuthority !== null;
    // TransferHook extension: program_id lives right after the authority in
    // the TLV; presence alone is not fatal, an ACTIVE one is.
    const hookActive = isT22 && info.data.length > 165 &&
      (() => { try { const { getTransferHook } = require("@solana/spl-token");
        const h = getTransferHook(mint as any);
        return !!h && h.programId && !h.programId.equals(PublicKey.default); } catch { return false; } })();

    const predicted = freezable ? "refuse 6036" : hookActive ? "refuse 6024" : "accept";

    const r = await runSplitCase(
      connection, payer, qa, `major-${symbol}`.replace(/[^a-zA-Z0-9-]/g, ""),
      NATIVE_MINT.equals(found.mint) ? found.mint : found.mint,
      [{ label: symbol, mint: found.mint, bps: 10000 }], "0.1",
      { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );
    const burnerFault = r.status !== "burned" && r.rejectedBy === "burner";
    rows.push({
      symbol, mint: found.mint.toBase58(), program: isT22 ? "token-2022" : "legacy",
      freezeAuthority: mint.freezeAuthority?.toBase58() ?? null, hookActive,
      predicted, status: r.status, code: r.errorCode, by: r.rejectedBy,
      cu: r.computeUnits, burnerRefused: burnerFault,
    });
    console.error(
      `  ${symbol.padEnd(10)} ${(isT22 ? "T22" : "spl").padEnd(4)} ` +
      `freeze=${(mint.freezeAuthority ? "YES" : "no").padEnd(4)} ` +
      `predicted=${predicted.padEnd(12)} -> ${r.status.padEnd(9)} ${String(r.errorCode ?? "").padEnd(5)} ${(r.rejectedBy ?? "").padEnd(8)}`
    );
    await new Promise((x) => setTimeout(x, 2200));
  }

  console.log(JSON.stringify(rows, null, 2));
  const burned = rows.filter((r) => r.status === "burned");
  const refused = rows.filter((r) => r.burnerRefused);
  const external = rows.filter((r) => r.status !== "burned" && !r.burnerRefused);
  console.error(`\nBURNED (${burned.length}): ${burned.map(r=>r.symbol).join(", ")}`);
  console.error(`REFUSED BY BURNER (${refused.length}): ${refused.map(r=>`${r.symbol}(${r.code})`).join(", ") || "none"}`);
  console.error(`external/fork failures (${external.length}): ${external.map(r=>`${r.symbol}(${r.code ?? "?"})`).join(", ") || "none"}`);
}
main().catch(e => { console.error(e); process.exit(1); });
