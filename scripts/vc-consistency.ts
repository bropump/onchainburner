/**
 * validate_config vs. a REAL burn, both directions.
 *
 * The whole value of on-chain validation is that it is the SAME code the burn
 * runs, so the two can never disagree. This suite proves it empirically: for
 * each configuration, it simulates `validate_config` AND runs a real
 * `swap_and_burn_split` (via `runSplitCase`) on the fork, and asserts they
 * reach the same verdict.
 *
 *   - a config validate_config ACCEPTS must burn;
 *   - a config validate_config REJECTS must fail a real burn with the SAME
 *     burner-attributed code.
 *
 * A disagreement would make the instruction worse than useless, so it is the
 * highest-value thing this suite can find.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  deriveSplitPda,
  ERROR_NAMES,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  TOKENS,
} from "./surfpool-split-e2e";
import {
  buildValidateConfigInstruction,
  resolveLegs,
  simulateValidate,
} from "./vc-validate-config";

// The property proven here is ADMISSION AGREEMENT, which is all
// validate_config claims: the burner's admission verdict equals
// validate_config's.
//
//   - expect "admit": validate_config accepts, and the real burn is NOT
//     rejected at a burner admission code — it either completes, or fails
//     DOWNSTREAM in Jupiter / an AMM (an `external` rejection). Both mean the
//     burner admitted the config. A Surfpool fork pins pool state while
//     Jupiter quotes live mainnet, so a route can fail to execute even for a
//     perfectly admissible config; validate_config explicitly does not (and
//     cannot) promise routability, so an external route failure is agreement,
//     a burner admission-code rejection would be the disagreement.
//   - expect <code>: validate_config rejects with <code>, and the real burn
//     is rejected by the BURNER with the same <code>.
//
// Every config is Jupiter-routable to its first leg so the real burn reaches
// the burner: USDC, META and a duplicate JTO all build a route, then the
// burner refuses them at admission — exactly where validate_config does.
type Scenario = {
  name: string;
  launch: typeof TOKENS[keyof typeof TOKENS];
  legs: Leg[];
  expect: "admit" | number;
};

/** Burner admission codes: everything the burner can raise BEFORE it hands
 * the route to Jupiter. If validate_config accepts a config, none of these may
 * appear from a real burn — that is the agreement. (6019/6021/6023 and the
 * Jupiter-side codes are execution outcomes, not admission, and are allowed to
 * differ with fork route state.) */
const ADMISSION_CODES = new Set([
  6009, 6010, 6011, 6012, 6013, 6014, 6015, 6016, 6024, 6025, 6032, 6033, 6034,
  6035, 6036, 6037, 6038,
]);

const SCENARIOS: Scenario[] = [
  {
    // The exact config `split-permissionless.ts` burns end-to-end, so this
    // case exercises a real completed burn when the fork's routes cooperate,
    // and an external route failure (still agreement) when they do not.
    name: "clean-3-leg-NEIRO-PUMP-JTO",
    launch: TOKENS.FARTCOIN,
    legs: [
      { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
      { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
      { label: "JTO", mint: TOKENS.JTO, bps: 7000 },
    ],
    expect: "admit",
  },
  {
    name: "freezable-USDC-leg",
    launch: TOKENS.FARTCOIN,
    legs: [
      { label: "USDC", mint: TOKENS.USDC, bps: 4000 },
      { label: "JTO", mint: TOKENS.JTO, bps: 6000 },
    ],
    expect: 6036,
  },
  {
    name: "mintable-META-leg",
    launch: TOKENS.FARTCOIN,
    legs: [
      { label: "META", mint: new PublicKey("METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m"), bps: 4000 },
      { label: "JTO", mint: TOKENS.JTO, bps: 6000 },
    ],
    expect: 6037,
  },
  {
    name: "duplicate-JTO",
    launch: TOKENS.FARTCOIN,
    legs: [
      { label: "JTO-a", mint: TOKENS.JTO, bps: 4000 },
      { label: "JTO-b", mint: TOKENS.JTO, bps: 6000 },
    ],
    expect: 6034,
  },
];

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  const rows: any[] = [];
  for (const scenario of SCENARIOS) {
    // ---- validate_config verdict (read-only simulation) ------------------
    const [pda] = deriveSplitPda(scenario.launch, scenario.legs);
    const legs = await resolveLegs(connection, pda, scenario.legs);
    const validateIx = buildValidateConfigInstruction(pda, scenario.launch, legs);
    const validate = await simulateValidate(connection, payer, validateIx);

    // ---- real burn verdict ----------------------------------------------
    // A reject scenario needs the burn instruction to actually REACH the
    // burner so it can raise its admission code; the burner rejects at
    // admission before it ever validates the Jupiter route, but `runSplitCase`
    // still asks Jupiter to BUILD a route first, and a transient Jupiter blip
    // yields an inconclusive `error` (no burner code) rather than a verdict.
    // Retry until the burn produces a conclusive result: a completed burn, or
    // any burner-attributed rejection. An admit scenario is conclusive on the
    // first run (a route failure there is itself agreement).
    let burn = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `consistency-${scenario.name}`,
      scenario.launch,
      scenario.legs,
      "0.3",
      { expectReject: scenario.expect !== "admit" }
    );
    if (scenario.expect !== "admit") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (burn.status === "burned" || burn.rejectedBy === "burner") break;
        burn = await runSplitCase(
          connection,
          payer,
          quoteAuthority,
          `consistency-${scenario.name}-retry${attempt}`,
          scenario.launch,
          scenario.legs,
          "0.3",
          { expectReject: true }
        );
      }
    }

    const validateVerdict = validate.accepted
      ? "accept"
      : validate.by === "burner"
      ? validate.code
      : `external:${validate.by}`;
    const burnVerdict =
      burn.status === "burned"
        ? "burn"
        : burn.rejectedBy === "burner"
        ? burn.errorCode
        : `external:${burn.rejectedBy ?? burn.status}:${burn.errorCode ?? "-"}`;

    // Did the burner REJECT this config at an admission code?
    const burnerAdmissionRejection =
      burn.status === "rejected" &&
      burn.rejectedBy === "burner" &&
      burn.errorCode !== undefined &&
      ADMISSION_CODES.has(burn.errorCode);

    let agree: boolean;
    if (scenario.expect === "admit") {
      // validate_config accepted; the burner must not reject at admission.
      // A completed burn or an external (Jupiter/AMM) route failure both mean
      // the burner admitted the config — that is the agreement.
      agree = validate.accepted && !burnerAdmissionRejection;
    } else {
      // validate_config rejected with a specific admission code; the real
      // burn must be rejected by the burner with the identical code.
      agree =
        !validate.accepted &&
        validate.by === "burner" &&
        validate.code === scenario.expect &&
        burn.status === "rejected" &&
        burn.rejectedBy === "burner" &&
        burn.errorCode === scenario.expect;
    }

    rows.push({
      name: scenario.name,
      expect: scenario.expect,
      validate: validateVerdict,
      validateName: validate.code ? ERROR_NAMES[validate.code] : undefined,
      burn: burnVerdict,
      burnName: burn.errorCode ? ERROR_NAMES[burn.errorCode] : undefined,
      burnDetail: burn.status === "error" ? burn.detail : undefined,
      agree,
    });
    process.stderr.write(
      `${agree ? "AGREE" : "DISAGREE"}  ${scenario.name}: validate=${validateVerdict} ` +
        `burn=${burnVerdict} (expected ${scenario.expect})\n`
    );
  }

  console.log(JSON.stringify(rows, null, 2));
  const agreed = rows.filter((r) => r.agree).length;
  process.stderr.write(`\n${agreed}/${rows.length} configs: validate_config and the real burn agree\n`);
  process.exit(agreed === rows.length ? 0 : 1);
}

// Only run when executed directly (`tsx <file>`), so importing the exported
// helpers from another suite does not fire this suite's side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
