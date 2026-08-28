/**
 * Headless end-to-end proof of the frontend's CHAIN LAYER, no browser
 * involved: the exact modules the React app imports are driven against the
 * running Surfpool fork and demo burn service.
 *
 *   1. service health
 *   2. Flow A — create a real Pump token, derive the vault from the chosen
 *      config, commit the one-shot fee share atomically with validate_config
 *      and the ATA creates, all signed by a throwaway "browser" wallet;
 *   3. client-side admission mirrors: USDC 6036, WSOL 6038, bad weights 6033,
 *      and the on-chain validate_config simulation agreeing (burner 6036);
 *   4. Flow C — real Pump buys accrue creator fees, distribute pays the
 *      vault, then POST /burn and assert a "burned" receipt with non-zero
 *      amounts per leg.
 *
 * Run: pnpm e2e   (expects fork on :8899 and demo service on :8787)
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ERROR_NAMES,
  KNOWN_TOKENS,
  PROGRAM,
  VAULT_RENT_FLOOR_LAMPORTS,
  WSOL_MINT,
} from "../src/chain/constants";
import { deriveSplitPda, splitAmounts } from "../src/chain/derive";
import {
  analyzeTargetMint,
  checkLegShape,
  fetchPumpCurveFacts,
  fetchTargetMintFacts,
} from "../src/chain/admission";
import {
  buildAtaInstructions,
  buildValidateConfigModeA,
  planSetupWithFeeShare,
  resolveLegs,
  sendWithWallet,
  SetupError,
  simulateValidateConfig,
  vaultWsolAta,
} from "../src/chain/instructions";
import {
  buildCreateV2Instruction,
  buildFeeShareInstructions,
  feeSharingConfigPda,
  newMintKeypair,
} from "../src/chain/pump";
import { makeService } from "../src/chain/service";
import {
  fetchMarketSelection,
  legReferenceFrom,
} from "../src/chain/reference";
import { walletFromKeypair } from "../src/chain/wallet";

const RPC_URL = "http://127.0.0.1:8899";
const SERVICE_URL = "http://127.0.0.1:8787";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
  if (!ok) failures += 1;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const service = makeService(SERVICE_URL);

  // ---- 1. health ----------------------------------------------------------
  const health = await service.health();
  check("service healthy", health.ok === true, `slot ${health.slot}`);
  check(
    "service program matches frontend constant",
    health.program === PROGRAM.toBase58(),
    health.program
  );

  // ---- 2. "browser" wallet ------------------------------------------------
  const walletKeypair = Keypair.generate();
  const wallet = walletFromKeypair(walletKeypair);
  await service.demoAirdrop(wallet.publicKey.toBase58(), 10_000_000_000n);
  const walletBalance = await connection.getBalance(wallet.publicKey);
  check(
    "demo airdrop funded wallet",
    walletBalance >= 10_000_000_000,
    `${walletBalance} lamports`
  );

  // ---- 3. Flow A: launch token + one-shot fee share -----------------------
  const mint = newMintKeypair();
  const createIx = await buildCreateV2Instruction({
    mint: mint.publicKey,
    name: "Burn Proof",
    symbol: "BPROOF",
    uri: "https://example.com/bproof.json",
    creator: wallet.publicKey,
  });
  const createSig = await sendWithWallet(
    connection,
    wallet,
    [createIx],
    [mint]
  );
  console.log(
    `      create_v2 landed ${createSig} mint ${mint.publicKey.toBase58()}`
  );
  check("create_v2 landed", true);

  // KEYLESS: each leg binds a reference pool. Ask the service's market
  // scan for the auto-pick, exactly as the browser does.
  const selections = await Promise.all(
    [KNOWN_TOKENS[0].mint, KNOWN_TOKENS[1].mint].map(
      (target) => fetchMarketSelection(SERVICE_URL, target)
    )
  );
  for (const selection of selections) {
    check(
      `market scan picked a reference for ${selection.targetMint.slice(0, 6)}…`,
      selection.chosen !== null,
      `${selection.chosen?.venue} ${selection.chosen?.pool.slice(0, 8)} — ${
        selection.pickReason.slice(0, 80)
      }`
    );
  }
  const references = selections.map((selection) =>
    legReferenceFrom(selection, selection.chosen!)
  );
  const legsInput = [
    { mint: KNOWN_TOKENS[0].mint, bps: 6000, ref: references[0].ref?.toBase58() }, // JTO
    { mint: KNOWN_TOKENS[1].mint, bps: 4000, ref: references[1].ref?.toBase58() }, // NEIRO
  ];
  const legs = legsInput.map((l, i) => ({
    mint: new PublicKey(l.mint),
    bps: l.bps,
    ref: references[i].ref,
    referenceBlock: {
      pool: references[i].pool,
      vaultA: references[i].vaultA,
      vaultB: references[i].vaultB,
      feeSource: references[i].feeSource,
    },
  }));
  const [vault, bump] = deriveSplitPda(mint.publicKey, legs);
  console.log(`      vault ${vault.toBase58()} (bump ${bump})`);

  const parts = splitAmounts(2_000_000_000n, [6000, 4000]);
  check(
    "splitAmounts reconstructs total exactly",
    parts.reduce((a, b) => a + b, 0n) === 2_000_000_000n,
    parts.join(" + ")
  );

  const resolved = (await resolveLegs(connection, vault, legs)).map(
    (leg, i) => ({ ...leg, referenceBlock: legs[i].referenceBlock })
  );
  const validateA = buildValidateConfigModeA(
    vault,
    mint.publicKey,
    resolved,
    splitAmounts(50_000_000n, [6000, 4000])
  );
  const ataIxs = buildAtaInstructions(wallet.publicKey, vault, resolved);
  const feeShareIxs = await buildFeeShareInstructions({
    creator: wallet.publicKey,
    mint: mint.publicKey,
    vault,
  });
  const plan = planSetupWithFeeShare(
    wallet.publicKey,
    feeShareIxs,
    validateA,
    ataIxs
  );
  check(
    "setup plan fits the wire budget in every transaction",
    plan.transactions.every((t) => t.bytes <= 1232),
    `${plan.transactions.map((t) => `${t.label}: ${t.bytes}B`).join("; ")}`
  );
  for (const tx of plan.transactions) {
    const sig = await sendWithWallet(connection, wallet, tx.instructions);
    console.log(`      ${tx.label} landed ${sig}`);
  }
  const sharingConfig = await connection.getAccountInfo(
    feeSharingConfigPda(mint.publicKey)
  );
  check("fee sharing config exists after setup", sharingConfig !== null);
  const wsolAtaInfo = await connection.getAccountInfo(vaultWsolAta(vault));
  const targetAtaInfo = await connection.getAccountInfo(resolved[0].ata);
  check(
    "vault WSOL + target ATAs created",
    wsolAtaInfo !== null && targetAtaInfo !== null
  );

  // ---- 4. admission mirrors ----------------------------------------------
  const [usdcFacts] = await fetchTargetMintFacts(connection, [USDC]);
  const usdcFreeze = usdcFacts.checks.find((c) => c.id === "freeze-authority");
  check(
    "client admission: USDC fails 6036 TargetMintFreezable",
    !usdcFacts.admissible &&
      usdcFreeze?.status === "fail" &&
      usdcFreeze.code === 6036
  );
  const wsolFacts = analyzeTargetMint(WSOL_MINT, {
    owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    data: (await connection.getAccountInfo(WSOL_MINT))!.data,
  });
  const wsolNative = wsolFacts.checks.find((c) => c.id === "native");
  check(
    "client admission: WSOL fails 6038 TargetMintNative",
    wsolNative?.status === "fail" && wsolNative.code === 6038
  );
  const badWeights = checkLegShape([
    { mint: KNOWN_TOKENS[0].mint, bps: 5000 },
    { mint: KNOWN_TOKENS[1].mint, bps: 4999 },
  ]);
  const weightRow = badWeights.find((c) => c.id === "weights");
  check(
    "client admission: 9,999 bps fails 6033 InvalidSplitWeights",
    weightRow?.status === "fail" && weightRow.code === 6033
  );
  const jtoShape = checkLegShape(legsInput);
  check(
    "client admission: chosen config passes shape checks",
    jtoShape.every((c) => c.status === "pass")
  );
  const curveFacts = await fetchPumpCurveFacts(connection, mint.publicKey);
  check(
    "pump funding-source check: fresh normal launch pays SOL fees",
    curveFacts.exists && curveFacts.checks[0].status === "pass",
    curveFacts.checks[0].detail
  );

  // On-chain verdicts: good config passes, USDC leg is burner-6036.
  const goodVerdict = await simulateValidateConfig(
    connection,
    wallet.publicKey,
    mint.publicKey,
    legs
  );
  check("on-chain validate_config passes the chosen config", goodVerdict.ok);
  const usdcVerdict = await simulateValidateConfig(
    connection,
    wallet.publicKey,
    mint.publicKey,
    [{ mint: USDC, bps: 10_000 }]
  );
  check(
    "on-chain validate_config rejects USDC with burner-attributed 6036",
    !usdcVerdict.ok && usdcVerdict.isBurner && usdcVerdict.code === 6036,
    `code ${usdcVerdict.code} ${
      usdcVerdict.code ? ERROR_NAMES[usdcVerdict.code] ?? "" : ""
    } by ${usdcVerdict.isBurner ? "burner" : usdcVerdict.programId}`
  );

  // ---- 5. Flow C: fees accrue, distribute, burn ---------------------------
  await service.demoTrade(mint.publicKey.toBase58());
  const distributed = await service.demoDistribute(
    mint.publicKey.toBase58(),
    vault.toBase58()
  );
  check(
    "distribute paid creator fees into the vault",
    distributed.vaultLamportsDelta > 0,
    `+${distributed.vaultLamportsDelta} lamports (vault ${distributed.vaultLamports})`
  );
  // Top the vault up from any source — the vault is an ordinary System
  // account and provenance is irrelevant to the program.
  await service.demoAirdrop(vault.toBase58(), 2_000_000_000n);
  const vaultBalance = BigInt(await connection.getBalance(vault, "confirmed"));
  const burnAmount = vaultBalance - VAULT_RENT_FLOOR_LAMPORTS;
  check(
    "vault funded for burn",
    burnAmount > 1_000_000_000n,
    `${vaultBalance} lamports`
  );

  const receipt = await service.burn({
    launchMint: mint.publicKey.toBase58(),
    legs: legsInput,
    amountInLamports: burnAmount.toString(),
  });
  if (receipt.status === "burned") {
    const allBurned =
      receipt.legs.length === 2 &&
      receipt.legs.every((leg) => BigInt(leg.burned) > 0n);
    check("burn receipt: status burned with non-zero burns", allBurned);
    console.log(`      signature ${receipt.signature}`);
    console.log(`      computeUnits ${receipt.computeUnits}`);
    for (const leg of receipt.legs) {
      console.log(
        `      leg ${leg.mint.slice(0, 8)}… in ${
          leg.amountIn
        } lamports -> burned ${leg.burned}`
      );
    }
    console.log(`      vaultAfter ${receipt.vaultAfter} lamports`);
    check(
      "vault retains only the rent floor",
      BigInt(receipt.vaultAfter) === VAULT_RENT_FLOOR_LAMPORTS,
      receipt.vaultAfter
    );
  } else if (receipt.status === "rejected") {
    check(
      "burn receipt: status burned",
      false,
      `rejected code ${receipt.errorCode} by ${
        receipt.rejectedBy
      }: ${receipt.logsTail.join(" | ")}`
    );
  } else {
    check(
      "demo burn returned an on-chain receipt rather than relay-only submission",
      false,
      `unexpected relay submission ${receipt.submissionId}`
    );
  }

  console.log(
    failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`
  );
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}

declare const process: { exitCode?: number };

main().catch((error) => {
  if (error instanceof SetupError) {
    console.error(
      "setup failed:",
      error.message,
      error.attribution,
      error.logs
    );
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
