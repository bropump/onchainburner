/**
 * The product flow, end to end: a real Pump launch whose creator fees fund one
 * split vault, and whose own token is the majority burn.
 *
 * Two parts, because they prove different things:
 *
 *  A. A genuinely fresh Pump launch -- created in this run -- with 100% of its
 *     creator fees locked to a 3-leg split vault, real buys generating real
 *     fees, and a real `distributeCreatorFeesV2` delivering SOL. This proves
 *     Pump can fund a split vault and that the fee share is immutable.
 *
 *  B. The same configuration shape, with a real recently-launched Pump token
 *     as both the launch namespace and the majority leg, burned on chain.
 *     This proves the program burns a launch token as the majority target.
 *
 * They are separate because Jupiter cannot route a mint that exists only on
 * this fork: its quote API indexes live mainnet, so a token created seconds
 * ago has no route -- on a fork or on mainnet. That is a Jupiter indexing
 * property, not a burner limitation, and part B is the on-chain proof.
 */

import BN from "bn.js";
const {
  OnlinePumpSdk,
  PUMP_SDK,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
} = require("@pump-fun/pump-sdk");
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getMint,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  deriveSplitPda,
  fetchJson,
  Leg,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  sendInstructions,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const BUY_LAMPORTS = (process.env.PUMP_BUY_SOL ?? "5,10,25")
  .split(",")
  .map(solToLamports);

/** A real Pump token new enough to be a "fresh pair" but old enough to route. */
async function pickFreshRoutablePumpToken(): Promise<{
  mint: PublicKey;
  symbol: string;
  liquidity: number;
}> {
  const results = await fetchJson<any[]>(
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100"
  );
  const candidate = results
    .filter(
      (token) =>
        typeof token.id === "string" &&
        token.id.endsWith("pump") &&
        Number(token.liquidity ?? 0) > 150_000 &&
        !Object.values(TOKENS).some((known) => known.toBase58() === token.id)
    )
    .sort((a, b) => Number(b.liquidity) - Number(a.liquidity))[0];
  if (!candidate) throw new Error("no routable fresh Pump token found");
  return {
    mint: new PublicKey(candidate.id),
    symbol: candidate.symbol ?? candidate.id.slice(0, 6),
    liquidity: Number(candidate.liquidity),
  };
}

/**
 * Part A: create a Pump launch, lock 100% of its creator fees to the split
 * vault, trade it, and distribute.
 */
async function launchAndFundSplitVault(
  connection: Connection,
  payer: Keypair,
  legsFor: (launchMint: PublicKey) => Leg[]
) {
  const mint = Keypair.generate();
  const onlinePump = new OnlinePumpSdk(connection);

  await sendInstructions(
    connection,
    payer,
    "pump-create-v2",
    [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: "Surfpool Split Burn Test",
        symbol: "SPLIT",
        uri: "https://example.com/surfpool-split.json",
        creator: payer.publicKey,
        user: payer.publicKey,
        mayhemMode: false,
        cashback: false,
      }),
    ],
    [mint]
  );

  const legs = legsFor(mint.publicKey);
  const [vault] = deriveSplitPda(mint.publicKey, legs);

  await sendInstructions(connection, payer, "pump-create-fee-sharing", [
    await PUMP_SDK.createFeeSharingConfig({
      creator: payer.publicKey,
      mint: mint.publicKey,
      pool: null,
    }),
  ]);
  await sendInstructions(connection, payer, "pump-lock-100pct-to-split-vault", [
    await PUMP_SDK.updateFeeSharesV2({
      authority: payer.publicKey,
      mint: mint.publicKey,
      currentShareholders: [payer.publicKey],
      newShareholders: [{ address: vault, shareBps: 10_000 }],
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);

  const sharingConfigAddress = feeSharingConfigPda(mint.publicKey);
  const sharingConfigInfo = await connection.getAccountInfo(
    sharingConfigAddress
  );
  if (!sharingConfigInfo) throw new Error("sharing config missing");
  const sharingConfig = PUMP_SDK.decodeSharingConfig(sharingConfigInfo);
  if (
    !sharingConfig.adminRevoked ||
    sharingConfig.shareholders.length !== 1 ||
    !sharingConfig.shareholders[0].address.equals(vault) ||
    sharingConfig.shareholders[0].shareBps !== 10_000
  ) {
    throw new Error(
      `fee share is not an immutable 100% to the split vault: ${JSON.stringify(
        sharingConfig
      )}`
    );
  }

  // Real trading, so the fees are real Pump creator fees rather than a
  // transfer standing in for them.
  const global = await onlinePump.fetchGlobal();
  const feeConfig = await onlinePump.fetchFeeConfig();
  let distributable = await onlinePump.getMinimumDistributableFee(
    mint.publicKey,
    payer.publicKey
  );
  const buys: string[] = [];
  for (const requestedLamports of BUY_LAMPORTS) {
    if (distributable.canDistribute) break;
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
      await onlinePump.fetchBuyState(
        mint.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      );
    const mintState = await getMint(
      connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const quoteAmount = new BN(requestedLamports.toString());
    await sendInstructions(
      connection,
      payer,
      "pump-buy-v2",
      await PUMP_SDK.buyV2Instructions({
        global,
        feeConfig,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint: mint.publicKey,
        user: payer.publicKey,
        amount: getBuyTokenAmountFromSolAmount({
          global,
          feeConfig,
          mintSupply: new BN(mintState.supply.toString()),
          bondingCurve,
          amount: quoteAmount,
          quoteMint: NATIVE_MINT,
        }),
        quoteAmount,
        slippage: 1,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      })
    );
    buys.push(`${requestedLamports} lamports`);
    distributable = await onlinePump.getMinimumDistributableFee(
      mint.publicKey,
      payer.publicKey
    );
  }
  if (!distributable.canDistribute) {
    throw new Error(
      `fees below Pump's distribution threshold: have ${distributable.distributableFees}, need ${distributable.minimumRequired}`
    );
  }

  const before = await connection.getBalance(vault, "confirmed");
  await sendInstructions(connection, payer, "pump-distribute-creator-fees", [
    await PUMP_SDK.distributeCreatorFeesV2({
      mint: mint.publicKey,
      sharingConfig,
      sharingConfigAddress,
      quoteMint: NATIVE_MINT,
      payer: payer.publicKey,
      shouldInitializeAta: true,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  const after = await connection.getBalance(vault, "confirmed");
  const delivered = BigInt(after - before);
  if (delivered <= 0n)
    throw new Error("Pump delivered no SOL to the split vault");

  return { launchMint: mint.publicKey, vault, legs, delivered, buys };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();
  const report: any = {};

  // ---- Part A: real Pump launch, real fees, into one split vault ---------
  const legsFor = (launchMint: PublicKey): Leg[] => [
    { label: "OWN-LAUNCH", mint: launchMint, bps: 7000 },
    { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
    { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
  ];
  const launch = await launchAndFundSplitVault(connection, payer, legsFor);
  report.partA = {
    launchMint: launch.launchMint.toBase58(),
    splitVault: launch.vault.toBase58(),
    config: "own launch 70% / NEIRO 15% / PUMP 15%",
    feeShare: "100% of Pump creator fees, admin revoked",
    buys: launch.buys,
    creatorFeesDeliveredLamports: launch.delivered.toString(),
  };
  console.error(
    `part A: ${
      launch.delivered
    } lamports of real Pump creator fees in split vault ${launch.vault.toBase58()}`
  );

  // Does Jupiter know a mint that has existed for thirty seconds?
  try {
    const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    url.searchParams.set("outputMint", launch.launchMint.toBase58());
    url.searchParams.set("amount", "10000000");
    url.searchParams.set("slippageBps", "1500");
    const quote = await fetchJson<any>(url.toString());
    report.partA.jupiterRoutesBrandNewMint = !quote.error;
  } catch (error) {
    report.partA.jupiterRoutesBrandNewMint = false;
    report.partA.jupiterError =
      error instanceof Error ? error.message.slice(0, 160) : String(error);
  }

  // ---- Part B: launch token as the majority burn, on chain ---------------
  const fresh = await pickFreshRoutablePumpToken();
  report.partB = {
    launchAndMajorityMint: fresh.mint.toBase58(),
    symbol: fresh.symbol,
    liquidityUsd: Math.round(fresh.liquidity),
    config: "own launch 70% / NEIRO 15% / PUMP 15%",
  };
  console.error(
    `part B: majority burn is ${
      fresh.symbol
    } (${fresh.mint.toBase58()}), liquidity $${Math.round(fresh.liquidity)}`
  );

  const burn = await runSplitCase(
    connection,
    payer,
    quoteAuthority,
    "pump-launch-majority-70-15-15",
    fresh.mint,
    [
      { label: `OWN:${fresh.symbol}`, mint: fresh.mint, bps: 7000 },
      { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
      { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
    ],
    process.env.SPLIT_TOTAL_SOL ?? "1"
  );
  report.partB.burn = burn;

  // A second shape the user asked about: 50/25/25 with the launch majority.
  const burn5050 = await runSplitCase(
    connection,
    payer,
    quoteAuthority,
    "pump-launch-majority-50-25-25",
    fresh.mint,
    [
      { label: `OWN:${fresh.symbol}`, mint: fresh.mint, bps: 5000 },
      { label: "NEIRO", mint: TOKENS.NEIRO, bps: 2500 },
      { label: "PUMP", mint: TOKENS.PUMP, bps: 2500 },
    ],
    process.env.SPLIT_TOTAL_SOL ?? "1"
  );
  report.partB.burn502525 = burn5050;

  console.log(JSON.stringify(report, null, 2));
  const ok = burn.status === "burned" && burn5050.status === "burned";
  console.error(ok ? "\nlaunch-token-majority split burn OK" : "\nFAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
