//! Client-visible error codes are append-only. Existing numeric values must
//! never move; new variants are added only after the current final code.

use pinocchio::error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy)]
pub enum BurnerError {
    /// input amount must be non-zero
    ZeroInput = 6000,
    /// the burner PDA does not have enough SOL for this burn
    InsufficientBurnerBalance = 6001,
    /// minimum output must be non-zero
    ZeroMinimumOutput = 6002,
    /// invalid Jupiter program
    InvalidJupiterProgram = 6003,
    /// RETIRED and never raised. Held the quote-authority signature check of
    /// the deleted KMS design; keyless has no quote authority, so nothing can
    /// produce this code. The variant is KEPT so the append-only registry
    /// still reserves 6004 and a future code cannot silently reuse it, and
    /// because the artifact-identity tests probe it to tell a keyless build
    /// from a KMS one.
    InvalidQuoteAuthority = 6004,
    /// only the approved Jupiter ExactIn route instruction is supported
    InvalidJupiterInstruction = 6005,
    /// the Jupiter route has an invalid core account layout
    InvalidJupiterAccounts = 6006,
    /// Jupiter platform fees are not permitted
    JupiterPlatformFeeNotAllowed = 6007,
    /// Jupiter ExactIn input does not equal the authorized input
    JupiterInputAmountMismatch = 6008,
    /// invalid token program
    InvalidTokenProgram = 6009,
    /// invalid mint owner
    InvalidMintOwner = 6010,
    /// invalid token account owner
    InvalidTokenAccountOwner = 6011,
    /// invalid burn PDA
    InvalidBurnPda = 6012,
    /// invalid mint data
    InvalidMintData = 6013,
    /// invalid token account data
    InvalidTokenAccountData = 6014,
    /// token account has the wrong mint
    InvalidTokenMint = 6015,
    /// token account has the wrong authority
    InvalidTokenAuthority = 6016,
    /// WSOL funding delta did not equal the requested input
    WsolFundingMismatch = 6017,
    /// Jupiter did not consume the authorized WSOL input
    WsolNotFullyConsumed = 6018,
    /// the burner PDA spent a native SOL amount other than the authorized input
    BurnPdaLamportMismatch = 6019,
    /// target balance decreased during the swap
    TargetBalanceDecreased = 6020,
    /// minimum output was not received
    SlippageExceeded = 6021,
    /// the target token balance was not completely burned
    BurnIncomplete = 6022,
    /// a Jupiter intermediate token account retained a balance
    IntermediateBalanceRemaining = 6023,
    /// the target Token-2022 mint has an unsupported extension
    UnsupportedToken2022Extension = 6024,
    /// the target Token-2022 account has an unsupported extension
    UnsupportedToken2022AccountExtension = 6025,
    /// the remaining burner PDA balance would be above zero but below the
    /// rent-exempt minimum
    BurnRemainderBelowRentFloor = 6026,

    // ---- instruction and account validation -------------------------------
    /// the instruction data is not a well-formed `swap_and_burn` payload
    InvalidInstructionData = 6027,
    /// too few accounts were supplied
    NotEnoughAccountKeys = 6028,
    /// the caller did not sign (there is no quote authority to sign)
    MissingRequiredSignature = 6029,
    /// an account declared `mut` by the program was passed read-only
    AccountNotMutable = 6030,
    /// invalid system program
    InvalidSystemProgram = 6031,

    // ---- split burn (`swap_and_burn_split`) -------------------------------
    /// the split leg count is zero or above `MAX_SPLIT_TARGETS`
    InvalidSplitTargetCount = 6032,
    /// a split weight is zero, or the weights do not sum to 10000 bps
    InvalidSplitWeights = 6033,
    /// the same target mint appears in more than one split leg
    DuplicateSplitTarget = 6034,
    /// a PDA-owned token account carries a delegate or a close authority
    TokenAccountEncumbered = 6035,
    /// the target mint has a live freeze authority, which could permanently
    /// brick the vault by freezing its ATA
    TargetMintFreezable = 6036,
    /// the target mint has a live mint authority and can inflate after the
    /// burn; burn targets must be non-mintable
    TargetMintMintable = 6037,
    /// the target mint is a native (wrapped-SOL) mint, whose token accounts
    /// can never be burned; a vault configured this way would accrue SOL
    /// forever without ever being able to burn
    TargetMintNative = 6038,

    // ---- keyless reference binding ---------------------------------------
    // Was gated behind an experimental `keyless` feature; that gate is gone
    // and keyless is now the only design, so these are ordinary live codes.
    /// the keyless reference pool (or its vaults / fee source) failed
    /// identity or content authentication
    ReferenceInvalid = 6039,
    /// the input exceeds the reference pool's depth-derived cap
    /// (`amount_in > depth * fee`); retryable by chunking, unlike a true
    /// zero input
    ReferenceCapExceeded = 6040,
    /// the bound reference pool's SOL-side depth is below the minimum-depth
    /// admission floor. Distinct from 6039 (the reference is well-formed and
    /// correctly bound — it is simply too shallow to admit) and from 6040
    /// (the reference is admissible; a smaller `amount_in` would fit its cap).
    /// A valid-but-shallow pool is a decay / liveness signal, not a
    /// malformation, so it carries its own code. Only enforced on
    /// creator-reviewed, address-bound references (Raydium V4 / CP / CLMM,
    /// Meteora DLMM); the Pump-venue sentinels (bonding curve, PumpSwap pool)
    /// are exempt, because an own-launch reference is intrinsically thin when
    /// fresh and its identity is derivation-pinned, not depth-reviewed.
    ReferenceTooShallow = 6041,
    /// a split target ATA's balance changed between the whole-call snapshot
    /// and the start of that target's leg. A previous hostile route may not
    /// consume, burn, or otherwise alter a later leg's pre-existing balance.
    TargetPreCallBalanceMismatch = 6042,
    /// token value held by the burn PDA at whole-call entry was neither still
    /// held at exit nor covered by the amount burned for that token's mint
    PreExistingTokenBalanceUnaccounted = 6043,
}

#[inline(always)]
pub fn err(error: BurnerError) -> ProgramError {
    ProgramError::Custom(error as u32)
}
