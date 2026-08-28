/**
 * Conclusive 3-leg burn matrix on a FRESH fork.
 *
 * The question this answers is narrow and it is the shipping question: does a
 * 3-leg vault burn, atomically, across the target mix and weight splits the
 * product actually offers — a freshly launched Pump token, $PUMP (Token-2022,
 * multi-hop `shared_accounts_route_v2`), NEIRO, JTO, and MET.
 *
 * Rules learned the hard way and enforced here:
 *
 *   - `FORK_DEX_PROFILE=pool` is MANDATORY. Without it Jupiter routes through
 *     market-maker / RFQ venues (SolFi, HumidiFi and friends) that quote off
 *     private state a fork has no copy of; those fail with venue-specific
 *     errors like 0xfaded that have nothing to do with the burner. Two earlier
 *     measurement runs were invalidated by exactly this.
 *   - Pass criteria are strict. A case PASSES only if the burn LANDED and every
 *     leg burned to zero. A burner-attributed rejection is a FAILURE. An
 *     externally-attributed rejection is reported separately as fork/venue
 *     weather, never silently counted as a pass.
 *   - Route width is a compute lever as well as a wire-size one, so
 *     `runSplitCase` now narrows on compute exhaustion too; `computeNarrowedTo`
 *     records when that fired.
 *
 * A freshly created Pump mint has no Jupiter route until Jupiter indexes it,
 * so the fresh launch is exercised as the NAMESPACE (which is what funds the
 * vault in production) while the burn targets are live routable mints.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  deriveSplitPda,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  sendInstructions,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const { PUMP_SDK } = require("@pump-fun/pump-sdk");

const MET = new PublicKey("METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL");

type Target = { label: string; mint: PublicKey };

const TARGETS: Record<string, Target> = {
  PUMP: { label: "PUMP", mint: TOKENS.PUMP },
  NEIRO: { label: "NEIRO", mint: TOKENS.NEIRO },
  JTO: { label: "JTO", mint: TOKENS.JTO },
  MET: { label: "MET", mint: MET },
  BONK: { label: "BONK", mint: TOKENS.BONK },
  RAY: { label: "RAY", mint: TOKENS.RAY },
  POPCAT: { label: "POPCAT", mint: TOKENS.POPCAT },
  FARTCOIN: { label: "FARTCOIN", mint: TOKENS.FARTCOIN },
};

/** Every case is 3 legs. Splits deliberately span flagship, even, and extremes. */
const CASES: { targets: string[]; bps: [number, number, number]; sol: string }[] = [
  { targets: ["PUMP", "NEIRO", "JTO"], bps: [7000, 1500, 1500], sol: "0.3" },
  { targets: ["PUMP", "NEIRO", "JTO"], bps: [3400, 3300, 3300], sol: "0.2" },
  { targets: ["NEIRO", "JTO", "MET"], bps: [5000, 2500, 2500], sol: "0.3" },
  { targets: ["JTO", "MET", "PUMP"], bps: [8000, 1000, 1000], sol: "0.15" },
  { targets: ["MET", "NEIRO", "PUMP"], bps: [1000, 4500, 4500], sol: "0.25" },
  { targets: ["BONK", "NEIRO", "JTO"], bps: [6000, 2000, 2000], sol: "0.2" },
  { targets: ["RAY", "PUMP", "NEIRO"], bps: [4000, 3000, 3000], sol: "0.3" },
  { targets: ["POPCAT", "JTO", "MET"], bps: [7000, 1500, 1500], sol: "0.15" },
  { targets: ["FARTCOIN", "PUMP", "NEIRO"], bps: [5000, 3000, 2000], sol: "0.25" },
  { targets: ["NEIRO", "PUMP", "BONK"], bps: [9000, 500, 500], sol: "0.2" },
  { targets: ["JTO", "RAY", "POPCAT"], bps: [3333, 3333, 3334], sol: "0.3" },
  { targets: ["PUMP", "MET", "FARTCOIN"], bps: [2000, 4000, 4000], sol: "0.2" },
];

async function launchFreshPumpToken(connection: Connection, payer: Keypair) {
  const mint = Keypair.generate();
  await sendInstructions(
    connection,
    payer,
    "matrix-launch",
    [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: "burn-matrix",
        symbol: "BMTX",
        uri: "https://example.com/bmtx.json",
        creator: payer.publicKey,
        user: payer.publicKey,
      }),
    ],
    [mint]
  );
  return mint.publicKey;
}

async function main() {
  if (process.env.FORK_DEX_PROFILE !== "pool" && !process.env.FORK_DEXES) {
    console.error(
      "refusing to run: set FORK_DEX_PROFILE=pool (or FORK_DEXES). Without it\n" +
        "Jupiter routes through market-maker venues a fork cannot serve, and the\n" +
        "results measure the fork rather than the burner."
    );
    process.exit(2);
  }
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  console.log(`fork slot ${await connection.getSlot()}`);
  const launchMint = await launchFreshPumpToken(connection, payer);
  console.log(`fresh Pump launch (namespace): ${launchMint.toBase58()}`);
  console.log(`${CASES.length} three-leg cases, pool venues only\n`);

  const rows: any[] = [];
  for (const [index, testCase] of CASES.entries()) {
    const legs: Leg[] = testCase.targets.map((key, i) => ({
      label: TARGETS[key].label,
      mint: TARGETS[key].mint,
      bps: testCase.bps[i],
    }));
    const [vault] = deriveSplitPda(launchMint, legs);
    const name = testCase.targets.join("+");
    const split = testCase.bps.map((b) => b / 100).join("/");

    const result = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `mx${index}`,
      launchMint,
      legs,
      testCase.sol,
      { fundExtra: solToLamports("0.05"), slippageBps: 1500 }
    );

    const burnerFault =
      result.status !== "burned" && result.rejectedBy === "burner";
    const legsBurned = (result.burned ?? []).length;
    const pass = result.status === "burned" && legsBurned === 3;

    rows.push({
      case: index,
      targets: name,
      split,
      sol: testCase.sol,
      vault: vault.toBase58(),
      status: result.status,
      pass,
      burnerFault,
      code: result.errorCode,
      name_: result.errorName,
      by: result.rejectedBy,
      cu: result.computeUnits,
      bytes: result.txBytes,
      locks: result.accountLocks,
      narrowedTo: (result as any).computeNarrowedTo,
      signature: result.signature,
      burned: result.burned,
      detail: result.status === "burned" ? undefined : (result.detail ?? "").slice(0, 150),
    });

    console.log(
      `  ${String(index).padStart(2)} ${name.padEnd(24)} ${split.padEnd(16)} ` +
        `${(pass ? "BURNED" : result.status.toUpperCase()).padEnd(8)} ` +
        `${String(result.computeUnits ?? "-").padStart(8)}cu ` +
        `${String(result.txBytes ?? "-").padStart(4)}B/${String(result.accountLocks ?? "-").padStart(2)}lk` +
        ((result as any).computeNarrowedTo ? ` narrowed@${(result as any).computeNarrowedTo}` : "") +
        (burnerFault ? `   <<< BURNER FAULT ${result.errorCode} ${result.errorName}` : "") +
        (!pass && !burnerFault ? `   (${result.errorCode ?? ""} ${result.rejectedBy ?? "external"})` : "")
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const passed = rows.filter((r) => r.pass);
  const faults = rows.filter((r) => r.burnerFault);
  const external = rows.filter((r) => !r.pass && !r.burnerFault);
  console.log(
    `\n${passed.length}/${rows.length} burned all three legs` +
      `   |   burner faults: ${faults.length}` +
      `   |   external/venue: ${external.length}`
  );
  if (passed.length) {
    const cu = passed.map((r) => r.cu).filter(Boolean) as number[];
    console.log(
      `CU across landed burns: min ${Math.min(...cu)}  max ${Math.max(...cu)}  (ceiling 1,400,000)`
    );
    const narrowed = passed.filter((r) => r.narrowedTo);
    if (narrowed.length) {
      console.log(
        `compute-narrowing rescued ${narrowed.length} burn(s) that would otherwise have exhausted the budget`
      );
    }
  }
  for (const row of faults) {
    console.log(`BURNER FAULT case ${row.case} ${row.targets}: ${row.code} ${row.name_}\n  ${row.detail}`);
  }
  require("fs").writeFileSync("/tmp/burn-matrix-3leg.json", JSON.stringify(rows, null, 2));
  process.exit(faults.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
