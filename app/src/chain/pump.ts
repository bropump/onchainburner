/**
 * Pump.fun instruction builders, via @pump-fun/pump-sdk's offline PUMP_SDK.
 * Everything here is BUILT in the browser and SIGNED by the user's wallet —
 * the burn service never signs setup transactions.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { SharingConfig } from "@pump-fun/pump-sdk";
import { Buffer } from "buffer";
import {
  PUMP_SDK,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  canonicalPumpPoolPda,
  creatorVaultPda,
  feeSharingConfigPda,
} from "#pump-sdk";

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

/** A funded mainnet account used only as the unsigned simulation fee payer. */
const SIMULATION_PAYER = new PublicKey(
  "UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw"
);

export type CreatorFeeClaimStatus = Readonly<{
  sharingConfig: string;
  creatorVault: string;
  graduated: boolean;
  includesAmmSweep: boolean;
  distributableLamports: bigint;
  minimumRequiredLamports: bigint;
  canDistribute: boolean;
}>;

type VerifiedSharingConfig = Readonly<{
  address: PublicKey;
  config: SharingConfig;
}>;

/**
 * A claim is permissionless, but this client will only build it for the exact
 * immutable burner vault encoded by the page URL. This is the important
 * client-side destination pin: a stale or unrelated Pump sharing config must
 * never be turned into a wallet payout by this UI.
 */
async function verifiedSharingConfig(
  connection: Connection,
  mint: PublicKey,
  vault: PublicKey
): Promise<VerifiedSharingConfig> {
  const address = feeSharingConfigPda(mint);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error("Pump fee sharing is not configured for this launch");
  if (!info.owner.equals(PUMP_FEE_PROGRAM_ID)) {
    throw new Error("Pump fee sharing config has the wrong owner");
  }
  const config = PUMP_SDK.decodeSharingConfig(info);
  if (!config.mint.equals(mint)) {
    throw new Error("Pump fee sharing config names a different mint");
  }
  if (
    config.shareholders.length !== 1 ||
    !config.shareholders[0].address.equals(vault) ||
    config.shareholders[0].shareBps !== 10_000
  ) {
    const destination =
      config.shareholders.length === 1
        ? config.shareholders[0].address.toBase58()
        : `${config.shareholders.length} shareholders`;
    throw new Error(
      `Claim blocked: Pump creator fees point to ${destination}, not this vault ${vault.toBase58()}`
    );
  }
  return { address, config };
}

/** PumpSwap PDA which owns the graduated pool's creator-fee WSOL account. */
function ammCreatorVaultAuthority(sharingConfig: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), sharingConfig.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  )[0];
}

async function claimContext(args: {
  connection: Connection;
  mint: PublicKey;
  vault: PublicKey;
  payer: PublicKey;
}): Promise<{
  verified: VerifiedSharingConfig;
  graduated: boolean;
  transferFromAmm?: TransactionInstruction;
}> {
  const verified = await verifiedSharingConfig(
    args.connection,
    args.mint,
    args.vault
  );
  const pool = canonicalPumpPoolPda(args.mint);
  const authority = ammCreatorVaultAuthority(verified.address);
  const ammWsol = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    authority,
    true,
    TOKEN_PROGRAM_ID
  );
  const [poolInfo, ammWsolInfo] = await args.connection.getMultipleAccountsInfo(
    [pool, ammWsol],
    "confirmed"
  );
  const graduated = poolInfo !== null;
  // Pump's own OnlinePumpSdk only inserts this hop when the canonical pool
  // and creator-fee ATA both exist. Omitting it when the ATA is absent keeps
  // a normal post-graduation distribution from failing on a nonexistent
  // optional source account.
  const transferFromAmm =
    graduated && ammWsolInfo
      ? await PUMP_SDK.transferCreatorFeesToPumpV2({
          payer: args.payer,
          mint: args.mint,
          quoteMint: NATIVE_MINT,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
        })
      : undefined;
  return { verified, graduated, transferFromAmm };
}

/**
 * Reads Pump's own minimum-fee return value in simulation. For a graduated
 * launch the simulation first sweeps the AMM creator-fee WSOL, so the number
 * shown is the amount the same one-signature claim transaction can deliver.
 */
export async function getCreatorFeeClaimStatus(args: {
  connection: Connection;
  mint: PublicKey;
  vault: PublicKey;
  payer?: PublicKey;
}): Promise<CreatorFeeClaimStatus> {
  const payer = args.payer ?? SIMULATION_PAYER;
  const context = await claimContext({ ...args, payer });
  const minimumIx = await PUMP_SDK.getMinimumDistributableFee({
    mint: args.mint,
    sharingConfig: context.verified.config,
    sharingConfigAddress: context.verified.address,
  });
  const { blockhash } = await args.connection.getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [
        ...(context.transferFromAmm ? [context.transferFromAmm] : []),
        minimumIx,
      ],
    }).compileToV0Message()
  );
  const simulated = await args.connection.simulateTransaction(transaction, {
    sigVerify: false,
  });
  if (simulated.value.err) {
    throw new Error("Pump could not calculate the creator fees right now");
  }
  const [data, encoding] = simulated.value.returnData?.data ?? [];
  if (!data) throw new Error("Pump returned no creator-fee amount");
  const decoded = PUMP_SDK.decodeMinimumDistributableFee(
    Buffer.from(data, encoding as BufferEncoding)
  );
  return {
    sharingConfig: context.verified.address.toBase58(),
    creatorVault: creatorVaultPda(context.verified.address).toBase58(),
    graduated: context.graduated,
    includesAmmSweep: context.transferFromAmm !== undefined,
    distributableLamports: BigInt(decoded.distributableFees.toString()),
    minimumRequiredLamports: BigInt(decoded.minimumRequired.toString()),
    canDistribute: decoded.canDistribute,
  };
}

/**
 * Re-reads and re-pins the sharing config immediately before building. The
 * returned transaction is permissionless and pays only the configured burner
 * vault; the connected wallet is merely the fee payer/signature.
 */
export async function buildCreatorFeeClaimInstructions(args: {
  connection: Connection;
  payer: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
}): Promise<TransactionInstruction[]> {
  const context = await claimContext(args);
  const distribute = await PUMP_SDK.distributeCreatorFeesV2({
    mint: args.mint,
    sharingConfig: context.verified.config,
    sharingConfigAddress: context.verified.address,
    quoteMint: NATIVE_MINT,
    payer: args.payer,
    shouldInitializeAta: true,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  return [
    ...(context.transferFromAmm ? [context.transferFromAmm] : []),
    distribute,
  ];
}
