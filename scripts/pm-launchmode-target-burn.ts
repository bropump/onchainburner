/**
 * THE DECISIVE TEST for the "normal pump tokens only" scope question.
 *
 * Two very different questions were being conflated:
 *
 *   (1) mode token as the BURN TARGET  -- can we swap-and-burn a mayhem /
 *       cashback / agent coin itself?
 *   (2) mode token as the LAUNCH NAMESPACE (the product's actual flow) --
 *       a creator launches in some mode, its fees fund the vault, and the
 *       vault burns ESTABLISHED targets (NEIRO / JTO / RAY / $PUMP).
 *
 * Prior runs only ever touched (1). This script tests (2), which is what the
 * product does.
 *
 * The program-level prediction is that mode CANNOT matter here:
 * `validate_launch_mint` (token.rs:163) reads exactly two things -- that the
 * owner is a token program, and the decimals. It never reads the bonding
 * curve, where `is_mayhem_mode` (byte 81) and `is_cashback_coin` (byte 82)
 * actually live. The launch mint is a pure namespace seed. This run either
 * demonstrates that on chain or falsifies it.
 *
 * Each mode gets a REAL fork launch, a vault derived from it, a plain SOL
 * transfer as funding, and a 4-leg burn of live mainnet targets. Pass = the
 * burn lands with zero burner-attributed failures and the targets burn to
 * zero, identically to the normal-mode control.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  attributeFailure,
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
const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** The established targets a real creator would actually burn. */
const BASKETS: Record<string, Leg[]> = {
  jto: [{ label: "JTO", mint: TOKENS.JTO, bps: 10000 }],
  neiro: [{ label: "NEIRO", mint: TOKENS.NEIRO, bps: 10000 }],
  ray: [{ label: "RAY", mint: TOKENS.RAY, bps: 10000 }],
  bonk: [{ label: "BONK", mint: TOKENS.BONK, bps: 10000 }],
  pump: [{ label: "PUMP", mint: TOKENS.PUMP, bps: 10000 }],
  // Live mainnet Pump coins used as BURN TARGETS. Modes verified against
  // mainnet curve bytes, not assumed: normal / cashback / mayhem / mayhem.
  "t-normal": [
    { label: "T-NORMAL", mint: new PublicKey("7EUjqDCvkjiYNQxipgpku7oQomGCm2TvmFBzp5wtpump"), bps: 10000 },
  ],
  "t-cashback": [
    { label: "T-CASHBACK", mint: new PublicKey("6D3qWUYjsb2oKAmdeNwh1VRETxYxXUynHfcDSGWxpump"), bps: 10000 },
  ],
  "t-mayhem": [
    { label: "T-MAYHEM", mint: new PublicKey("8SHWMbnnNJujEdorYCZB7SHy6jvoG9E9NfM49rWKpump"), bps: 10000 },
  ],
  "t-mayhem2": [
    { label: "T-MAYHEM2", mint: new PublicKey("C6u88Q3J2UhARpHocXZkBFf3z9Neg9Z41nSwnoLrpump"), bps: 10000 },
  ],
  split3: [
    { label: "NEIRO", mint: TOKENS.NEIRO, bps: 5000 },
    { label: "JTO", mint: TOKENS.JTO, bps: 2500 },
    { label: "PUMP", mint: TOKENS.PUMP, bps: 2500 },
  ],
};
const TARGET_BASKET: Leg[] = BASKETS[process.env.BASKET ?? "jto"];


type ModeSpec = {
  name: string;
  mayhemMode: boolean;
  cashback: boolean;
  quoteMint?: PublicKey;
};

const MODES: ModeSpec[] = [
  { name: "normal", mayhemMode: false, cashback: false },
  { name: "mayhem", mayhemMode: true, cashback: false },
  { name: "cashback", mayhemMode: false, cashback: true },
  { name: "usdc-quote", mayhemMode: false, cashback: false, quoteMint: USDC },
];

/** Read the curve flags so the launch's mode is proven, not assumed. */
async function readCurveFlags(connection: Connection, mint: PublicKey) {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN
  );
  const info = await connection.getAccountInfo(curve, "confirmed");
  if (!info) return null;
  const quote = new PublicKey(info.data.subarray(83, 115));
  return {
    mayhem: info.data[81],
    cashback: info.data[82],
    quoteMint: quote.equals(PublicKey.default) ? "SOL" : quote.toBase58(),
    size: info.data.length,
  };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const only = process.argv.slice(2);
  const modes = only.length
    ? MODES.filter((m) => only.includes(m.name))
    : MODES;

  console.log(
    `fork slot ${await connection.getSlot()} | burning ${TARGET_BASKET.map(
      (l) => `${l.label} ${l.bps / 100}%`
    ).join(" / ")}\n`
  );

  const results: any[] = [];
  for (const spec of modes) {
    const row: any = { mode: spec.name };
    const mint = Keypair.generate();
    row.launchMint = mint.publicKey.toBase58();

    // ---- 1. real launch in this mode ------------------------------------
    try {
      const createIx: TransactionInstruction =
        await PUMP_SDK.createV2Instruction({
          mint: mint.publicKey,
          name: `lm-${spec.name}`,
          symbol: spec.name.slice(0, 6).toUpperCase(),
          uri: `https://example.com/lm-${spec.name}.json`,
          creator: payer.publicKey,
          user: payer.publicKey,
          mayhemMode: spec.mayhemMode,
          cashback: spec.cashback,
          quoteMint: spec.quoteMint,
        });
      await sendInstructions(
        connection,
        payer,
        `lm-create-${spec.name}`,
        [createIx],
        [mint]
      );
      row.created = "ok";
    } catch (error) {
      row.created = `FAILED: ${String(error).slice(0, 200)}`;
      results.push(row);
      console.log(`${spec.name.padEnd(11)} create FAILED`);
      continue;
    }

    // ---- 2. prove the mode actually took ---------------------------------
    row.curve = await readCurveFlags(connection, mint.publicKey);

    // ---- 3. the product flow: this launch's vault burns real targets -----
    const result = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `launchmode-${spec.name}`,
      mint.publicKey,
      TARGET_BASKET,
      process.env.BURN_SOL ?? "0.4",
      // Same options every working multi-leg suite uses: uncapped routes,
      // headroom above the burn amount, and the fork's usual slippage.
      {
        maxAccountsPerLeg: 0,
        fundExtra: solToLamports("0.05"),
        slippageBps: 1500,
      }
    );
    row.burn = {
      status: result.status,
      cu: result.computeUnits,
      bytes: result.txBytes,
      locks: result.accountLocks,
      signature: result.signature,
      burned: result.burned,
      errorName: result.errorName,
      detail: result.detail,
      attribution: result.rejectedBy,
      code: result.errorCode,
    };
    results.push(row);

    const c = row.curve;
    console.log(
      `${spec.name.padEnd(11)} curve[mayhem=${c?.mayhem} cashback=${
        c?.cashback
      } quote=${c?.quoteMint}] -> burn ${result.status}` +
        (result.status === "burned"
          ? ` ${result.computeUnits} CU / ${result.accountLocks} locks  ${result.signature}`
          : ` ${result.errorCode ?? result.errorName ?? ""} ${
              result.rejectedBy ?? ""
            } ${String(result.detail ?? "").slice(0, 140)}`)
    );
  }

  console.log("\n=== verdict ===");
  const burned = results.filter((r) => r.burn?.status === "burned");
  for (const r of results) {
    const ok = r.burn?.status === "burned";
    console.log(
      `  ${r.mode.padEnd(11)} ${ok ? "BURNED" : "DID NOT BURN"}${
        ok ? ` (${r.burn.burned?.join(", ")})` : ""
      }`
    );
  }
  console.log(
    `\n${burned.length}/${results.length} launch modes burned the established basket.`
  );
  require("fs").writeFileSync(
    "/tmp/launchmode-target-burn.json",
    JSON.stringify(results, null, 2)
  );
  process.exit(burned.length === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
