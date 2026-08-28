/**
 * Pump.fun instruction builders, via @pump-fun/pump-sdk's offline PUMP_SDK.
 * Everything here is BUILT in the browser and SIGNED by the user's wallet —
 * the burn service never signs setup transactions.
 */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PUMP_SDK, feeSharingConfigPda } from "#pump-sdk";

export { feeSharingConfigPda };

export function newMintKeypair(): Keypair {
  return Keypair.generate();
}

/** `create_v2`: a normal, SOL-quoted Pump launch (no mayhem, no cashback —
 * those modes pay a burner vault ZERO creator fees). Mint must co-sign. */
export async function buildCreateV2Instruction(args: {
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
}): Promise<TransactionInstruction> {
  return PUMP_SDK.createV2Instruction({
    mint: args.mint,
    name: args.name,
    symbol: args.symbol,
    uri: args.uri || `https://example.com/${args.symbol.toLowerCase()}.json`,
    creator: args.creator,
    user: args.creator,
    mayhemMode: false,
    cashback: false,
  });
}

/**
 * The one-shot fee share: create the sharing config, then point 100% of
 * creator fees at the vault. Pump refuses every re-point (0x1779), so the
 * caller must bundle these with `validate_config` in one transaction.
 */
export async function buildFeeShareInstructions(args: {
  creator: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
}): Promise<TransactionInstruction[]> {
  const createConfig = await PUMP_SDK.createFeeSharingConfig({
    creator: args.creator,
    mint: args.mint,
    pool: null,
  });
  const update = await PUMP_SDK.updateFeeSharesV2({
    authority: args.creator,
    mint: args.mint,
    currentShareholders: [args.creator],
    newShareholders: [{ address: args.vault, shareBps: 10_000 }],
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  return [createConfig, update];
}
