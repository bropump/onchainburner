"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/** One more real bonding-curve buy: volume may trigger Jupiter indexing. */
const node_fs_1 = __importDefault(require("node:fs"));
const bn_js_1 = __importDefault(require("bn.js"));
const pump_sdk_1 = require("@pump-fun/pump-sdk");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const surfpool_split_e2e_1 = require("./scripts/surfpool-split-e2e");
const RPC = process.env.SURFPOOL_RPC_URL;
const MINT = new web3_js_1.PublicKey(process.env.LAUNCH_MINT);
const AMT = process.env.BUY_SOL ?? "5";
function lamports(v) { const [w, f = ""] = v.split("."); return BigInt(w || "0") * 1000000000n + BigInt((f + "000000000").slice(0, 9)); }
(async () => {
    const connection = new web3_js_1.Connection(RPC, "confirmed");
    const payer = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(node_fs_1.default.readFileSync(process.env.SOLANA_KEYPAIR, "utf8"))));
    const onlinePump = new pump_sdk_1.OnlinePumpSdk(connection);
    const global = await onlinePump.fetchGlobal();
    const feeConfig = await onlinePump.fetchFeeConfig();
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } = await onlinePump.fetchBuyState(MINT, payer.publicKey, spl_token_1.TOKEN_2022_PROGRAM_ID);
    const mintState = await (0, spl_token_1.getMint)(connection, MINT, "confirmed", spl_token_1.TOKEN_2022_PROGRAM_ID);
    const quoteAmount = new bn_js_1.default(lamports(AMT).toString());
    const sig = await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, "provoke-buy", await pump_sdk_1.PUMP_SDK.buyV2Instructions({
        global, feeConfig, bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo,
        mint: MINT, user: payer.publicKey,
        amount: (0, pump_sdk_1.getBuyTokenAmountFromSolAmount)({ global, feeConfig, mintSupply: new bn_js_1.default(mintState.supply.toString()), bondingCurve, amount: quoteAmount, quoteMint: spl_token_1.NATIVE_MINT }),
        quoteAmount, slippage: 1, tokenProgram: spl_token_1.TOKEN_2022_PROGRAM_ID, quoteTokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
    }));
    console.log(JSON.stringify({ signature: sig }));
})().catch(e => { console.error(e); process.exitCode = 1; });
