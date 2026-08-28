/** One 3-leg split burn, to prove the mechanics before running the matrix. */
import { Connection } from "@solana/web3.js";
import {
  readPayer,
  readQuoteAuthority,
  runSplitCase,
  RPC_URL,
  TOKENS,
} from "./surfpool-split-e2e";

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const result = await runSplitCase(
    connection,
    payer,
    quoteAuthority,
    "smoke-15-15-70",
    TOKENS.FARTCOIN, // stands in for the launch mint (namespace only)
    [
      { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
      { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
      { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
    ],
    "0.5"
  );
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "burned" ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
