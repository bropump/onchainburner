/** Run one runSplitCase for a given mint and dump the full CaseResult. */
import { Connection, PublicKey } from "@solana/web3.js";
import { readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports } from "./surfpool-split-e2e";

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const qa = readQuoteAuthority();
  const mint = new PublicKey(process.argv[2]);
  const sol = process.argv[3] ?? "0.1";
  const r = await runSplitCase(
    connection, payer, qa, `diag-${mint.toBase58().slice(0, 6)}`, mint,
    [{ label: "leg", mint, bps: 10000 }], sol,
    { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
  );
  console.log(JSON.stringify(r, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
