/**
 * e2e verification: retry the split-matrix shapes that failed EXTERNALLY
 * (stale Whirlpool/Raydium-CLMM tick arrays on the fork, or compute
 * exhaustion) to separate transient fork drift from anything systematic.
 * Fresh Jupiter quotes pick fresh routes; a shape that lands on retry was
 * never a program problem. Vault addresses differ from the matrix run only
 * where weights differ; identical shapes reuse the same PDA, which is fine —
 * the vault is funded per call.
 */
import { Connection } from "@solana/web3.js";
import {
  CaseResult,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  TOKENS,
} from "./surfpool-split-e2e";

const t = TOKENS;

function weighted(
  legs: { label: string; mint: any }[],
  bps: number[]
): Leg[] {
  return legs.map((leg, index) => ({ ...leg, bps: bps[index] }));
}

const NEIRO = { label: "NEIRO", mint: t.NEIRO };
const PUMP = { label: "PUMP", mint: t.PUMP };
const JTO = { label: "JTO", mint: t.JTO };
const BONK = { label: "BONK", mint: t.BONK };
const WIF = { label: "WIF", mint: t.WIF };
const POPCAT = { label: "POPCAT", mint: t.POPCAT };

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const cases = [
    {
      name: "retry-50-25-25",
      launch: t.WIF,
      legs: weighted([JTO, NEIRO, PUMP], [5000, 2500, 2500]),
      total: "0.5",
    },
    {
      name: "retry-33-33-34",
      launch: t.BONK,
      legs: weighted([BONK, WIF, JTO], [3300, 3300, 3400]),
      total: "0.6",
    },
    {
      name: "retry-extreme-1-9999",
      launch: t.WIF,
      legs: weighted([NEIRO, WIF], [1, 9999]),
      total: "5",
    },
    {
      name: "retry-single-leg-100",
      launch: t.POPCAT,
      legs: weighted([JTO], [10000]),
      total: "0.25",
    },
    {
      name: "retry-four-leg-25x4",
      launch: t.FARTCOIN,
      legs: weighted([NEIRO, JTO, BONK, WIF], [2500, 2500, 2500, 2500]),
      total: "0.8",
    },
    {
      name: "retry-four-leg-70-10-10-10",
      launch: t.RAY,
      legs: weighted([JTO, NEIRO, BONK, WIF], [7000, 1000, 1000, 1000]),
      total: "1",
    },
    {
      name: "retry-all-legacy",
      launch: t.PUMP,
      legs: weighted([BONK, WIF, POPCAT], [3000, 3000, 4000]),
      total: "0.6",
    },
    {
      name: "retry-size-large-100",
      launch: t.NEIRO,
      legs: weighted([JTO, BONK], [3000, 7000]),
      total: "100",
    },
  ];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    process.stderr.write(`running ${testCase.name} ... `);
    const result = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      testCase.name,
      testCase.launch,
      testCase.legs,
      testCase.total
    );
    results.push(result);
    process.stderr.write(
      `${result.status}${result.errorName ? ` (${result.errorName})` : ""} ` +
        `${result.computeUnits ?? "?"}cu ${result.txBytes ?? "?"}b ${result.accountLocks ?? "?"}locks\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log(JSON.stringify(results, null, 2));
  const burned = results.filter((result) => result.status === "burned").length;
  const burnerFaults = results.filter(
    (result) => result.status === "rejected" && result.rejectedBy === "burner"
  );
  console.error(
    `\n${burned}/${results.length} burned on retry; burner-attributed failures: ${
      burnerFaults.length
    }${burnerFaults.length ? " " + burnerFaults.map((r) => r.name).join(",") : ""}`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
