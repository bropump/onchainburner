/**
 * Does a GRADUATED coin still fund the burner vault in native lamports?
 *
 * Everything measured so far was pre-graduation: a fresh launch on its
 * bonding curve distributes creator fees as a lamport transfer, and the vault
 * (a bare System account) gained 44,444,445 lamports. But Pump's own docs
 * describe a different route once a coin graduates to the AMM:
 *
 *   "For graduated coins (pool exists): 1. Create WSOL ATA for sharing config
 *    authority (idempotent) 2. transferCreatorFeesToPump() -- AMM program
 *    moves WSOL from AMM vault to pump creator vault"
 *
 * If the FINAL hop to a shareholder also pays WSOL, it lands in a token
 * account rather than as lamports, the vault's `burn_pda.lamports()` budget
 * (6001) never grows, and the product silently stops funding at exactly the
 * moment a launch succeeds. That is the single worst outcome available, so it
 * is measured rather than inferred from the `COLLECT_CREATOR_FEE` doc, which
 * describes a different instruction and explicitly does not cover sharing.
 *
 * Sequence: launch -> fee-sharing config pointed at the vault -> buy the
 * curve out until `complete` -> migrate to the AMM -> trade on the pool ->
 * transfer AMM fees to Pump -> distribute -> read BOTH the vault's lamports
 * and its WSOL ATA, so whichever one moved is unambiguous.
 */
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  deriveSplitPda,
  Leg,
  readPayer,
  RPC_URL,
  sendInstructions,
  TOKENS,
} from "./surfpool-split-e2e";

const {
  OnlinePumpSdk,
  PUMP_SDK,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
} = require("@pump-fun/pump-sdk");

const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/** `complete` is byte 48 of BondingCurve: 8-byte discriminator + 5 u64s. */
async function curveState(connection: Connection, mint: PublicKey) {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN
  );
  const info = await connection.getAccountInfo(curve, "confirmed");
  if (!info) return null;
  return {
    address: curve,
    complete: info.data[48] === 1,
    realTokenReserves: info.data.readBigUInt64LE(24),
    realSolReserves: info.data.readBigUInt64LE(32),
  };
}

async function balances(connection: Connection, vault: PublicKey) {
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );
  const info = await connection.getAccountInfo(wsolAta, "confirmed");
  return {
    lamports: BigInt(await connection.getBalance(vault, "confirmed")),
    wsol: info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : null,
    wsolAta,
  };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const onlinePump = new OnlinePumpSdk(connection);
  const mint = Keypair.generate();

  // The vault burns JTO, so the launch mint is a pure funding namespace and
  // nothing about the target can be confused for the funding asset.
  const legs: Leg[] = [{ label: "JTO", mint: TOKENS.JTO, bps: 10000 }];
  const [vault] = deriveSplitPda(mint.publicKey, legs);
  console.log(`mint  ${mint.publicKey.toBase58()}`);
  console.log(`vault ${vault.toBase58()}\n`);

  // ---- 1. launch -----------------------------------------------------------
  await sendInstructions(
    connection,
    payer,
    "gr-create",
    [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: "graduated-fee",
        symbol: "GRAD",
        uri: "https://example.com/grad.json",
        creator: payer.publicKey,
        user: payer.publicKey,
      }),
    ],
    [mint]
  );
  console.log("launched");

  // ---- 2. point 100% of creator fees at the vault, before any trading ------
  await sendInstructions(connection, payer, "gr-cfg", [
    await PUMP_SDK.createFeeSharingConfig({
      creator: payer.publicKey,
      mint: mint.publicKey,
      pool: null,
    }),
  ]);
  await sendInstructions(connection, payer, "gr-share", [
    await PUMP_SDK.updateFeeSharesV2({
      authority: payer.publicKey,
      mint: mint.publicKey,
      currentShareholders: [payer.publicKey],
      newShareholders: [{ address: vault, shareBps: 10_000 }],
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]);
  console.log("fee share -> vault (100%)");

  const preGraduation = await balances(connection, vault);

  // ---- 3. buy the curve out ------------------------------------------------
  const chunk = new BN(20_000_000_000); // 20 SOL a go
  for (let i = 0; i < 12; i++) {
    const state = await curveState(connection, mint.publicKey);
    if (!state || state.complete) break;
    try {
      const global = await onlinePump.fetchGlobal();
      const feeConfig = await onlinePump.fetchFeeConfig();
      const {
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
      } = await onlinePump.fetchBuyState(
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
      await sendInstructions(
        connection,
        payer,
        `gr-buy-${i}`,
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
            amount: chunk,
            quoteMint: NATIVE_MINT,
          }),
          quoteAmount: chunk,
          slippage: 50,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
        })
      );
    } catch (error) {
      console.log(`  buy ${i} failed: ${String(error).slice(0, 160)}`);
      break;
    }
  }
  const afterBuys = await curveState(connection, mint.publicKey);
  console.log(
    `curve complete=${afterBuys?.complete}  realTokenReserves=${afterBuys?.realTokenReserves}`
  );

  // ---- 4. distribute, and see which asset moved ---------------------------
  const before = await balances(connection, vault);
  console.log(
    `\nbefore distribute: vault lamports=${before.lamports}  wsol=${
      before.wsol ?? "(no ATA)"
    }`
  );

  const sharingConfigAddress = feeSharingConfigPda(mint.publicKey);
  const sharingConfigInfo = await connection.getAccountInfo(
    sharingConfigAddress
  );
  const sharingConfig = PUMP_SDK.decodeSharingConfig(sharingConfigInfo!);

  // Graduated coins hold their creator fees in the AMM vault as WSOL; this is
  // the documented hop that moves them into the Pump creator vault first.
  if (afterBuys?.complete) {
    try {
      await sendInstructions(connection, payer, "gr-transfer-to-pump", [
        await PUMP_SDK.transferCreatorFeesToPump({
          mint: mint.publicKey,
          payer: payer.publicKey,
          quoteMint: NATIVE_MINT,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
        }),
      ]);
      console.log("transferCreatorFeesToPump ok");
    } catch (error) {
      console.log(`transferCreatorFeesToPump: ${String(error).slice(0, 200)}`);
    }
  }

  try {
    await sendInstructions(connection, payer, "gr-distribute", [
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
  } catch (error) {
    console.log(`distribute failed: ${String(error).slice(0, 300)}`);
  }

  const after = await balances(connection, vault);
  const lamportDelta = after.lamports - before.lamports;
  const wsolDelta = (after.wsol ?? 0n) - (before.wsol ?? 0n);
  console.log(
    `after  distribute: vault lamports=${after.lamports}  wsol=${
      after.wsol ?? "(no ATA)"
    }`
  );
  console.log(`\n  lamport delta : ${lamportDelta}`);
  console.log(`  WSOL delta    : ${wsolDelta}`);
  console.log(`  vault WSOL ATA: ${after.wsolAta.toBase58()}`);
  console.log(
    `\nVERDICT (graduated=${afterBuys?.complete}): ` +
      (lamportDelta > 0n && wsolDelta === 0n
        ? "NATIVE LAMPORTS -- vault funds normally, burn budget grows"
        : wsolDelta > 0n && lamportDelta <= 0n
        ? "WSOL INTO A TOKEN ACCOUNT -- vault lamports do NOT grow, burn cannot be funded"
        : lamportDelta > 0n && wsolDelta > 0n
        ? "BOTH moved -- inspect"
        : "nothing moved -- no fees accrued or distribute failed")
  );
  console.log(
    `pre-graduation baseline for reference: lamports=${preGraduation.lamports}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
