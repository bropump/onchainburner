/**
 * Two burns on the SAME vault, showing (a) setup is a first-time cost only,
 * and (b) nothing accumulates in the vault's token accounts.
 *
 * The accounts persist -- they hold their rent forever and are never closed --
 * but their BALANCES are driven to zero every burn: WSOL back to its baseline
 * by the conservation postcondition, and each target ATA to exactly 0 by the
 * burn-to-zero postcondition (6022 if not).
 */
import { Connection } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveSplitPda, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports, TOKENS } from "./surfpool-split-e2e";

const sol = (l: number) => (l / 1e9).toFixed(6);

async function main() {
  const c = new Connection(RPC_URL, "confirmed");
  const payer = readPayer(), qa = readQuoteAuthority();
  const legs = [
    { label: "NEIRO", mint: TOKENS.NEIRO, bps: 5000 },
    { label: "JTO", mint: TOKENS.JTO, bps: 5000 },
  ];
  const [vault] = deriveSplitPda(TOKENS.WIF, legs);
  console.error(`vault ${vault.toBase58()}\n`);

  for (const pass of [1, 2]) {
    const before = await c.getBalance(payer.publicKey, "confirmed");
    const r = await runSplitCase(
      c, payer, qa, `lifecycle-pass${pass}`, TOKENS.WIF, legs, "0.1",
      { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );
    const after = await c.getBalance(payer.publicKey, "confirmed");
    // The funded amount goes INTO the vault; subtract it to isolate setup+fees.
    const overhead = before - after - Number(solToLamports("0.15"));
    console.error(`burn ${pass}: ${r.status}${r.errorCode ? "/" + r.errorCode : ""}  ` +
      `callerOverhead=${sol(overhead)} SOL  accumulators=${JSON.stringify(r.pumpAccumulatorsCreated)}`);

    // What is left sitting in the vault's token accounts?
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
    const w = await getAccount(c, wsol, "confirmed", TOKEN_PROGRAM_ID).catch(() => null);
    console.error(`   WSOL ATA   open=${!!w} tokenBalance=${w ? w.amount.toString() : "-"} rentHeld=${w ? sol(Number((await c.getAccountInfo(wsol,"confirmed"))!.lamports)) : "-"} SOL`);
    for (const l of legs) {
      const mi = await c.getAccountInfo(l.mint, "confirmed");
      const ata = getAssociatedTokenAddressSync(l.mint, vault, true, mi!.owner);
      const a = await getAccount(c, ata, "confirmed", mi!.owner).catch(() => null);
      const info = await c.getAccountInfo(ata, "confirmed");
      console.error(`   ${l.label.padEnd(10)} open=${!!a} tokenBalance=${a ? a.amount.toString() : "-"} rentHeld=${info ? sol(info.lamports) : "-"} SOL`);
    }
    console.error("");
  }
}
main().catch(e => { console.error(e); process.exit(1); });
