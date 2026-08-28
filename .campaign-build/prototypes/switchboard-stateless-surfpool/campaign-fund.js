"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Campaign fixture: create a fresh NORMAL Pump launch per shape on a
 * disposable fork and irrevocably pin 100% of creator fees to the shape's
 * immutable SPLIT vault PDA ("burner", launch, ...targets, bps_blob), then
 * accrue real fees with buys and distribute native SOL into the vault.
 *
 * Shapes put the own-launch mint in the target list itself (the flagship
 * configuration), so the vault address binds launch namespace and burn
 * targets in one immutable derivation.
 *
 * Production/KMS untouched. No real funds.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const bn_js_1 = __importDefault(require("bn.js"));
const pump_sdk_1 = require("@pump-fun/pump-sdk");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const surfpool_split_e2e_1 = require("../../scripts/surfpool-split-e2e");
const RPC = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM = new web3_js_1.PublicKey(process.env.STATELESS_PROGRAM);
const RESULT_OUT = process.env.RESULT_OUT;
const BUY_SOL = (process.env.PUMP_BUY_SOL ?? "2,5,5").split(",").filter(Boolean);
const MET = new web3_js_1.PublicKey("METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL");
function resolveShape(name, ownBps) {
    switch (name) {
        case "A": {
            // own-launch / NEIRO at OWN_BPS / (10000 - OWN_BPS): covers 50/50 and 20/80.
            return {
                name,
                legs: [{ label: "NEIRO", mint: surfpool_split_e2e_1.TOKENS.NEIRO, bps: 10000 - ownBps }],
            };
        }
        case "B":
            return {
                name,
                legs: [
                    { label: "NEIRO", mint: surfpool_split_e2e_1.TOKENS.NEIRO, bps: 1500 },
                    { label: "JTO", mint: surfpool_split_e2e_1.TOKENS.JTO, bps: 1500 },
                ],
            };
        case "C":
            return {
                name,
                legs: [
                    { label: "FARTCOIN", mint: surfpool_split_e2e_1.TOKENS.FARTCOIN, bps: 1000 },
                    { label: "MET", mint: MET, bps: 1000 },
                ],
            };
        default:
            throw new Error(`unknown SHAPE ${name}`);
    }
}
/** Split PDA: ("burner", launch, ...target mints, bps blob LE u16s). */
function deriveSplitVault(launchMint, legs) {
    const bpsBlob = Buffer.alloc(2 * legs.length);
    legs.forEach((leg, index) => bpsBlob.writeUInt16LE(leg.bps, 2 * index));
    return web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("burner"),
        launchMint.toBuffer(),
        ...legs.map((leg) => leg.mint.toBuffer()),
        bpsBlob,
    ], PROGRAM)[0];
}
function readPayer() {
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(node_fs_1.default.readFileSync(process.env.SOLANA_KEYPAIR, "utf8"))));
}
function lamports(value) {
    const [whole, fraction = ""] = value.split(".");
    return (BigInt(whole || "0") * 1000000000n +
        BigInt((fraction + "000000000").slice(0, 9)));
}
async function main() {
    const shapeName = process.env.SHAPE;
    const ownBps = Number(process.env.OWN_BPS ?? "5000");
    if (!Number.isInteger(ownBps) || ownBps <= 0 || ownBps >= 10000) {
        throw new Error(`OWN_BPS invalid: ${process.env.OWN_BPS}`);
    }
    const partial = resolveShape(shapeName, ownBps);
    const connection = new web3_js_1.Connection(RPC, "confirmed");
    const payer = readPayer();
    const onlinePump = new pump_sdk_1.OnlinePumpSdk(connection);
    const mint = web3_js_1.Keypair.generate();
    // Own-launch first leg; remaining legs come from the shape table.
    const legs = [
        { label: "OWN", mint: mint.publicKey, bps: ownBps },
        ...partial.legs,
    ];
    const totalBps = legs.reduce((sum, leg) => sum + leg.bps, 0);
    if (totalBps !== 10000)
        throw new Error(`shape ${shapeName} sums ${totalBps} bps`);
    const vault = deriveSplitVault(mint.publicKey, legs);
    await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, `${shapeName}-create-normal`, [
        await pump_sdk_1.PUMP_SDK.createV2Instruction({
            mint: mint.publicKey,
            name: `Campaign ${shapeName} burn launch`,
            symbol: `CMP${shapeName}`,
            uri: "https://example.com/campaign-launch.json",
            creator: payer.publicKey,
            user: payer.publicKey,
            mayhemMode: false,
            cashback: false,
        }),
    ], [mint]);
    await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, `${shapeName}-create-sharing`, [
        await pump_sdk_1.PUMP_SDK.createFeeSharingConfig({
            creator: payer.publicKey,
            mint: mint.publicKey,
            pool: null,
        }),
    ]);
    await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, `${shapeName}-pin-fees-to-split-vault`, [
        await pump_sdk_1.PUMP_SDK.updateFeeSharesV2({
            authority: payer.publicKey,
            mint: mint.publicKey,
            currentShareholders: [payer.publicKey],
            newShareholders: [{ address: vault, shareBps: 10000 }],
            quoteMint: spl_token_1.NATIVE_MINT,
            quoteTokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        }),
    ]);
    const sharingAddress = (0, pump_sdk_1.feeSharingConfigPda)(mint.publicKey);
    const sharingInfo = await connection.getAccountInfo(sharingAddress, "confirmed");
    if (!sharingInfo)
        throw new Error("sharing config missing");
    const sharing = pump_sdk_1.PUMP_SDK.decodeSharingConfig(sharingInfo);
    if (!sharing.adminRevoked ||
        sharing.shareholders.length !== 1 ||
        !sharing.shareholders[0].address.equals(vault) ||
        sharing.shareholders[0].shareBps !== 10000) {
        throw new Error(`fee share not irrevocably pinned to split vault ${vault.toBase58()}`);
    }
    const global = await onlinePump.fetchGlobal();
    const feeConfig = await onlinePump.fetchFeeConfig();
    const buys = [];
    let distributable = await onlinePump.getMinimumDistributableFee(mint.publicKey, payer.publicKey);
    for (const amountSol of BUY_SOL) {
        if (distributable.canDistribute)
            break;
        const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await onlinePump.fetchBuyState(mint.publicKey, payer.publicKey, spl_token_1.TOKEN_2022_PROGRAM_ID);
        const mintState = await (0, spl_token_1.getMint)(connection, mint.publicKey, "confirmed", spl_token_1.TOKEN_2022_PROGRAM_ID);
        const quoteAmount = new bn_js_1.default(lamports(amountSol).toString());
        const signature = await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, `${shapeName}-buy-${amountSol}`, await pump_sdk_1.PUMP_SDK.buyV2Instructions({
            global,
            bondingCurveAccountInfo,
            bondingCurve,
            associatedUserAccountInfo,
            mint: mint.publicKey,
            user: payer.publicKey,
            amount: (0, pump_sdk_1.getBuyTokenAmountFromSolAmount)({
                global,
                feeConfig,
                mintSupply: new bn_js_1.default(mintState.supply.toString()),
                bondingCurve,
                amount: quoteAmount,
                quoteMint: spl_token_1.NATIVE_MINT,
            }),
            quoteAmount,
            slippage: 1,
            tokenProgram: spl_token_1.TOKEN_2022_PROGRAM_ID,
            quoteTokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        }));
        buys.push({ requestedLamports: quoteAmount.toString(), signature });
        distributable = await onlinePump.getMinimumDistributableFee(mint.publicKey, payer.publicKey);
    }
    if (!distributable.canDistribute) {
        throw new Error(`fees below distribution threshold after ${buys.length} buys`);
    }
    const before = await connection.getBalance(vault, "confirmed");
    const distributeSignature = await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, `${shapeName}-distribute-fees`, [
        await pump_sdk_1.PUMP_SDK.distributeCreatorFeesV2({
            mint: mint.publicKey,
            sharingConfig: sharing,
            sharingConfigAddress: sharingAddress,
            quoteMint: spl_token_1.NATIVE_MINT,
            payer: payer.publicKey,
            shouldInitializeAta: true,
            quoteTokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        }),
    ]);
    const after = await connection.getBalance(vault, "confirmed");
    if (after <= before)
        throw new Error("normal launch delivered no native SOL");
    const curve = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.publicKey.toBuffer()], new web3_js_1.PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))[0];
    const curveInfo = await connection.getAccountInfo(curve, "confirmed");
    if (!curveInfo || curveInfo.data.length < 115)
        throw new Error("bonding curve missing/short");
    const report = {
        scope: "isolated disposable fork; production/KMS untouched",
        shape: shapeName,
        program: PROGRAM.toBase58(),
        launcher: payer.publicKey.toBase58(),
        launchMint: mint.publicKey.toBase58(),
        legs: legs.map((leg) => ({ label: leg.label, mint: leg.mint.toBase58(), bps: leg.bps })),
        vault: vault.toBase58(),
        mode: {
            mayhem: curveInfo.data[81] !== 0,
            cashback: curveInfo.data[82] !== 0,
            quoteMintHex: Buffer.from(curveInfo.data.subarray(83, 115)).toString("hex"),
            normalSolLaunch: curveInfo.data[81] === 0 &&
                curveInfo.data[82] === 0 &&
                curveInfo.data.subarray(83, 115).equals(Buffer.alloc(32)),
        },
        feeShare: { adminRevoked: sharing.adminRevoked, vaultBps: 10000 },
        buys,
        distributeSignature,
        vaultBeforeLamports: before,
        vaultAfterLamports: after,
        creatorFeesDeliveredLamports: String(after - before),
    };
    node_fs_1.default.writeFileSync(RESULT_OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
