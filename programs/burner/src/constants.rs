//! Production program constants and wire-format discriminators.
//!
//! Pinocchio has no `pubkey!` macro without the `decode` feature, so the
//! base58 values are expanded to their raw 32-byte arrays:
//!
//! * `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`   Jupiter v6
//! * `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`    legacy SPL Token
//! * `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`    Token-2022
//! * `So11111111111111111111111111111111111111112`    WSOL
//! * `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`    associated token program

use pinocchio::Address;

/// `sha256("global:swap_and_burn")[0..8]`.
pub const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];

/// `sha256("global:swap_and_burn_split")[0..8]`.
pub const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];

/// `sha256("global:validate_config")[0..8]`.
pub const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];

pub const BURNER_SEED: &[u8] = b"burner";

/// Upper bound on the legs of a split vault.
///
/// The binding constraint is the transaction, not the program: a 3-leg burn
/// with real Jupiter routes already sits near Solana's 64 account-lock limit,
/// so 4 exists only as headroom for unusually compact routes. A configuration
/// the runtime cannot fit simply fails to land; it is never mis-executed.
pub const MAX_SPLIT_TARGETS: usize = 4;

/// Split weights are basis points and must sum to exactly this.
pub const BPS_TOTAL: u16 = 10_000;

/// Anchor discriminator for Jupiter v6 `route_v2`, the ExactIn instruction
/// used by the burner. V1, ledger, and ExactOut variants are intentionally
/// unsupported; the V2 shared-account ExactIn variant is pinned separately.
pub const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] =
    [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];

/// Anchor discriminator for Jupiter v6 `shared_accounts_route_v2` ExactIn.
/// It is validated separately because its scalar and account offsets differ
/// from `route_v2`; the other shared, ledger, and ExactOut variants remain
/// unsupported.
pub const JUPITER_SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR: [u8; 8] =
    [0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9];

/// Jupiter's fixed event authority for `route_v2`:
/// `D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf`.
pub const JUPITER_EVENT_AUTHORITY: Address = Address::new_from_array([
    180, 63, 250, 39, 245, 215, 246, 74, 116, 192, 155, 31, 41, 88, 121, 222, 75, 9, 171, 54, 223,
    201, 221, 81, 75, 50, 26, 167, 179, 140, 229, 232,
]);

/// SPL Token / Token-2022 `BurnChecked` instruction discriminator.
pub const TOKEN_BURN_CHECKED_DISCRIMINATOR: u8 = 15;

/// SPL Token `SyncNative` instruction discriminator.
pub const TOKEN_SYNC_NATIVE_DISCRIMINATOR: u8 = 17;

pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0u8; 32]);

pub const JUPITER_PROGRAM_ID: Address = Address::new_from_array([
    4, 121, 213, 91, 242, 49, 192, 110, 238, 116, 197, 110, 206, 104, 21, 7, 253, 177, 178, 222,
    163, 244, 142, 81, 2, 177, 205, 162, 86, 188, 19, 143,
]);

pub const SPL_TOKEN_PROGRAM_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

pub const SPL_TOKEN_2022_PROGRAM_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

pub const WSOL_MINT: Address = Address::new_from_array([
    6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26,
    235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1,
]);

/// Token-2022's native mint, `9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP`.
/// Only referenced to refuse it as a burn target (6038): like WSOL it carries
/// no authorities and no extensions, so nothing else in target admission
/// would stop it, yet a native account can never be burned.
pub const TOKEN_2022_NATIVE_MINT: Address = Address::new_from_array([
    131, 13, 252, 159, 222, 95, 230, 184, 170, 124, 4, 164, 118, 233, 30, 138, 198, 187, 38, 74,
    173, 144, 250, 25, 201, 223, 73, 216, 92, 62, 91, 94,
]);

/// The one Token-2022 transfer-hook mint admitted by exact identity:
/// `$PUMP` (`pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`). Its hook program
/// is unset and its authority is pinned below to the immutable, empty Pump
/// authority program. Every other hook-capable mint remains refused.
pub const PUMP_MINT: Address = Address::new_from_array([
    12, 69, 247, 223, 141, 158, 114, 149, 98, 132, 147, 63, 109, 152, 183, 87, 3, 46, 131, 223,
    132, 96, 79, 181, 225, 23, 255, 246, 29, 91, 18, 249,
]);

/// `$PUMP`'s exact TransferHook authority:
/// `DMdBa812dBW1CHVhmTyUyVcrBnSbZbfoFC7U14k4riH1`.
///
/// The account is owned by the verified `pump-fun/transfer-hook-authority`
/// program (`333UA...`), whose complete instruction module is empty. That
/// program is immutable on mainnet (upgrade authority `None`), so this PDA
/// cannot authorize Token-2022 to install a hook program later.
pub const PUMP_TRANSFER_HOOK_AUTHORITY: [u8; 32] = [
    183, 148, 197, 77, 45, 117, 96, 103, 61, 235, 92, 147, 223, 59, 242, 73, 149, 186, 20, 41, 52,
    7, 201, 99, 239, 165, 217, 126, 188, 79, 174, 220,
];

/// Pump.fun bonding-curve program.
pub const PUMP_FUN_PROGRAM_ID: Address = Address::new_from_array([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245,
    210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

/// PumpSwap AMM program.
pub const PUMP_SWAP_PROGRAM_ID: Address = Address::new_from_array([
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86,
    213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

/// Anchor account discriminator for Pump's `UserVolumeAccumulator`, shared
/// by Pump.fun and PumpSwap.
pub const PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR: [u8; 8] =
    [86, 255, 112, 14, 102, 53, 154, 250];

pub const ASSOCIATED_TOKEN_PROGRAM_ID: Address = Address::new_from_array([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
]);


