import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";

const env: Record<string, string | undefined> =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env) ||
  {};

/** The deployed Pinocchio burner program. Overridable for fork testing via
 * VITE_PROGRAM_ID (a fork deploy gets a fresh program id per bootstrap). */
export const PROGRAM = new PublicKey(
  env.VITE_PROGRAM_ID ?? "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5"
);

/** `sha256("global:validate_config")[0..8]` — must match constants.rs. */
export const VALIDATE_CONFIG_DISCRIMINATOR = Buffer.from([
  28, 98, 92, 82, 243, 62, 65, 93,
]);

export const BPS_TOTAL = 10_000;
export const MAX_SPLIT_TARGETS = 4;
export const MAX_TRANSACTION_BYTES = 1232;

/** Rent-exempt floor for a zero-data System account. A burn must leave the
 * vault with 0 or >= this; keepers must never target exact zero (6026). */
export const VAULT_RENT_FLOOR_LAMPORTS = 890_880n;

export const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
export const TOKEN_2022_NATIVE_MINT = new PublicKey(
  "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP"
);
/** The single Token-2022 transfer-hook mint the program allows, by exact
 * identity (mint + hook authority + unset hook program are all pinned). */
export const PUMP_TOKEN_MINT = new PublicKey(
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
);

/** Well-known target mints, for preset chips and receipt display. */
export const KNOWN_TOKENS: {
  symbol: string;
  mint: string;
  decimals: number;
  note?: string;
}[] = [
  // Added 2026-08-28 on owner request. Each was resolved against the live
  // reference resolver before being listed -- a preset that cannot be priced
  // is a preset that always fails, so none of these is here on trust.
  //
  // ANSEM and KET are Pump coins whose reference is the CANONICAL PumpSwap
  // pool: `protocol-owned`, derived by the program from the mint rather than
  // supplied by the caller, so no account can impersonate it. That is the
  // strongest reference class this program has -- the hostile-reference
  // problem (RT4) does not reach a derived pool.
  {
    symbol: "ANSEM",
    mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
    decimals: 6,
    note: "canonical PumpSwap pool, 16,957 SOL (measured 2026-08-28)",
  },
  {
    symbol: "KET",
    mint: "9Pfync3ejPC9eHqVzq3nYQJAhyhjqpnB9UsaSfLxpump",
    decimals: 6,
    note: "canonical PumpSwap pool, 1,426 SOL (measured 2026-08-28)",
  },
  {
    symbol: "CHILLHOUSE",
    mint: "GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump",
    decimals: 6,
    note: "canonical PumpSwap pool, 2,993 SOL (measured 2026-08-29)",
  },
  // MET is NOT a launchpad coin: its reference is an ADDRESS-BOUND Meteora
  // DLMM with transient positions, so its depth can be withdrawn and its
  // safety rests on curation, not on derivation. Listed because the owner
  // asked for it and it clears the gate today; it is not in the same class
  // as the two above.
  // STNK initially had zero locked LP; that observation exposed and fixed a
  // false-positive lock verdict. Its canonical Raydium CP now has 99.98% of
  // LP in verified Burn & Earn custody (live 2026-08-29), while retaining the
  // relatively high 100 bps pool fee.
  {
    symbol: "STNK",
    mint: "43VWkd99HjqkhFTZbWBpMpRhjG469nWa7x7uEsgSH7We",
    decimals: 6,
    note: "Raydium CP, 1,447 SOL, 99.98% Burn & Earn custody, 100 bps fee (measured 2026-08-29)",
  },
  {
    symbol: "MET",
    mint: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL",
    decimals: 6,
    note: "Meteora DLMM, 769 SOL, transient positions (measured 2026-08-28)",
  },
  // Locked-liquidity targets: measured 99%+ of LP burned or locked, so the
  // depth backing the reference cannot simply walk away. These need no
  // exception.
  { symbol: "NEIRO", mint: "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump", decimals: 6 },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6 },
  { symbol: "FARTCOIN", mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", decimals: 6 },
  { symbol: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", decimals: 9 },
  // Withdrawable-liquidity targets, allowed by explicit owner decision
  // (2026-08-27) rather than by passing the lock check. Concentrated-liquidity
  // and bin venues expose no lock signal at all, so these can never pass it.
  { symbol: "$PUMP", mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", decimals: 6, note: "Token-2022" },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", decimals: 6 },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6 },
  // MET: owner wants it listed; its mint has not been supplied, and guessing a
  // mint would bake a wrong reference pool into vault addresses permanently.
  // Add it here with the real mint and it inherits the exception below.
];

/**
 * Targets allowed despite withdrawable liquidity. Owner decision 2026-08-27:
 * "withdrawable at will is not commonly supported unless it's PUMP, RAY, MET"
 * — JUP added on the same basis, since it was asked for as a preset and its
 * only qualifying market is a Meteora DLMM (5,279 SOL, position-held).
 *
 * Everything NOT on this list must show locked liquidity to be offered. That
 * is what drops JTO (145 SOL, withdrawable, 100 bps fee) and BONK (87 SOL,
 * withdrawable) — both measured 2026-08-27.
 */
export const WITHDRAWABLE_ALLOWED: readonly string[] = [
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", // $PUMP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  // MET (Meteora). OWNER: "withdrawable at will is not commonly supported
  // unless it's PUMP, RAY, MET". Added 2026-08-28 once the mint was confirmed
  // from Jupiter rather than guessed -- a wrong mint here would be permanent,
  // since the target is hashed into every vault address that names it.
  "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", // MET
];

export function knownSymbol(mint: string): string | undefined {
  return KNOWN_TOKENS.find((t) => t.mint === mint)?.symbol;
}

/** Program error names, shared with the on-chain enum. */
export const ERROR_NAMES: Record<number, string> = {
  6000: "ZeroInput",
  6001: "InsufficientBurnerBalance",
  6002: "ZeroMinimumOutput",
  6003: "InvalidJupiterProgram",
  6004: "InvalidQuoteAuthority",
  6005: "InvalidJupiterInstruction",
  6006: "InvalidJupiterAccounts",
  6007: "JupiterPlatformFeeNotAllowed",
  6008: "JupiterInputAmountMismatch",
  6009: "InvalidTokenProgram",
  6010: "InvalidMintOwner",
  6011: "InvalidTokenAccountOwner",
  6012: "InvalidBurnPda",
  6013: "InvalidMintData",
  6014: "InvalidTokenAccountData",
  6015: "InvalidTokenMint",
  6016: "InvalidTokenAuthority",
  6017: "WsolFundingMismatch",
  6018: "WsolNotFullyConsumed",
  6019: "BurnPdaLamportMismatch",
  6020: "TargetBalanceDecreased",
  6021: "SlippageExceeded",
  6022: "BurnIncomplete",
  6023: "IntermediateBalanceRemaining",
  6024: "UnsupportedToken2022Extension",
  6025: "UnsupportedToken2022AccountExtension",
  6026: "BurnRemainderBelowRentFloor",
  6027: "InvalidInstructionData",
  6028: "NotEnoughAccountKeys",
  6029: "MissingRequiredSignature",
  6030: "AccountNotMutable",
  6031: "InvalidSystemProgram",
  6032: "InvalidSplitTargetCount",
  6033: "InvalidSplitWeights",
  6034: "DuplicateSplitTarget",
  6035: "TokenAccountEncumbered",
  6036: "TargetMintFreezable",
  6037: "TargetMintMintable",
  6038: "TargetMintNative",
  6039: "ReferenceInvalid",
  6040: "ReferenceCapExceeded",
  6041: "ReferenceTooShallow",
};

/** Plain-English explanations for the codes a user can actually hit. */
export const ERROR_EXPLANATIONS: Record<number, string> = {
  6000: "The burn amount is zero.",
  6001: "The vault holds fewer lamports than the requested burn amount.",
  6004: "Legacy code from the retired quote-authority design; the keyless program never raises it.",
  6005: "The Jupiter instruction is not one of the two accepted v2 route variants.",
  6006: "A route account does not match the pinned account layout.",
  6012: "The derived vault address does not match this configuration — a different mint, weight, or leg count derives a different vault.",
  6013: "The mint account's data is not a valid SPL mint (or carries an extension unknown to the decoder — fails closed).",
  6019: "Lamports moved that the program did not authorize; the whole burn reverted.",
  6021: "The swap output fell below the program's reference-bound price floor (or the requested minimum); nothing moved. Usually transient — retry with a fresh quote.",
  6024: "Token-2022 extension not allowed. Every transfer hook is refused except the exact $PUMP identity; only MetadataPointer and TokenMetadata pass.",
  6026: "The burn would leave the vault below the rent floor but above zero. Leave at least 0.00089088 SOL, or empty it exactly.",
  6032: "A split vault must have between 1 and 4 target legs.",
  6033: "Leg weights must be non-zero and sum to exactly 10,000 bps.",
  6034: "Every target mint in a split must be distinct.",
  6036: "The target mint has a live freeze authority. It could freeze the vault's token account forever while fees keep arriving — refused before any SOL is at risk.",
  6037: "The target mint has a live mint authority. A burn of a token that can be re-minted is not a supply reduction — refused.",
  6038: "The target is a native (wrapped SOL) mint. Such a vault could be funded but never burned — refused.",
  6039: "The leg's reference pool failed identity or content authentication — it is not the bound, shape-authenticated pool of an allow-listed venue for this pair.",
  6040: "The leg's input exceeds the reference pool's depth-derived cap (fee × SOL depth). Retryable by burning a smaller amount.",
  6041: "The bound reference pool's SOL-side depth has fallen below the 50 SOL admission floor. Burns on this vault pause until depth returns; the vault's SOL is untouched.",
};

/** Token-2022 extension type names (TLV type field). */
export const T22_EXTENSION_NAMES: Record<number, string> = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmount",
  26: "Pausable",
  27: "PausableAccount",
};
