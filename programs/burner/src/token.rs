//! Token / Token-2022 state reading.
//!
//! The raw byte offsets match the SPL Token account layouts. The Token-2022
//! TLV walk is *not* hand-rolled: it uses the audited `spl-token-2022`
//! `StateWithExtensions` decoder.

use pinocchio::{error::ProgramError, AccountView, Address};
use spl_token_2022::{
    extension::{transfer_hook, BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::{Account as TokenAccount, Mint},
};

use crate::{
    constants::{
        PUMP_MINT, PUMP_TRANSFER_HOOK_AUTHORITY, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID,
        TOKEN_2022_NATIVE_MINT, WSOL_MINT,
    },
    error::{err, BurnerError},
};

pub const MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;

// ---------------------------------------------------------------------------
// Byte-level readers (identical offsets to the Anchor helpers)
// ---------------------------------------------------------------------------

fn mint_decimals(data: &[u8]) -> Result<u8, ProgramError> {
    if data.len() < MINT_LEN || data[45] != 1 {
        return Err(err(BurnerError::InvalidMintData));
    }
    Ok(data[44])
}

fn token_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < TOKEN_ACCOUNT_LEN || data[108] != 1 {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    read_u64(&data[64..72], BurnerError::InvalidTokenAccountData)
}

/// A PDA-owned token account must carry no delegate and no close authority.
///
/// Both are fields only the account's *owner* can set, and the owner is the
/// burn PDA — which signs nowhere except inside this program. But the Jupiter
/// CPI is handed the PDA's signature at every position the PDA occupies, so a
/// program executing as Jupiter could `Approve` a delegate or
/// `SetAuthority(CloseAccount)`. Neither moves a balance, so every other
/// postcondition still passes; what they leave behind is a standing claim that
/// a LATER transaction can use to sweep the account or reclaim its rent.
///
/// Checked on entry and again after the route, so a claim can neither pre-exist
/// nor be installed during the swap.
pub fn verify_no_standing_claims(data: &[u8]) -> Result<(), ProgramError> {
    // Every live caller has already length-checked, but the invariant must
    // hold locally: data too short to be an SPL Account is invalid token
    // account data, never a slice panic (an abort, not a clean revert, in
    // SBF).
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    // SPL Account: `delegate: COption<Pubkey>` occupies 72..108 and
    // `close_authority: COption<Pubkey>` occupies 129..165. A `None`
    // discriminant is four zero bytes. (Token-2022 keeps this same base
    // layout; its extensions live past byte 165.)
    if data[72..76] != [0, 0, 0, 0] || data[129..133] != [0, 0, 0, 0] {
        return Err(err(BurnerError::TokenAccountEncumbered));
    }
    Ok(())
}

fn token_amount_checked(
    data: &[u8],
    expected_mint: &Address,
    expected_authority: &Address,
) -> Result<u64, ProgramError> {
    if data.len() < TOKEN_ACCOUNT_LEN || data[108] != 1 {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    verify_no_standing_claims(data)?;
    if data[0..32] != expected_mint.as_ref()[..] {
        return Err(err(BurnerError::InvalidTokenMint));
    }
    if data[32..64] != expected_authority.as_ref()[..] {
        return Err(err(BurnerError::InvalidTokenAuthority));
    }
    read_u64(&data[64..72], BurnerError::InvalidTokenAccountData)
}

fn read_u64(bytes: &[u8], on_error: BurnerError) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| err(on_error))?,
    ))
}

// ---------------------------------------------------------------------------
// `AccountView` wrappers
// ---------------------------------------------------------------------------

pub fn read_mint_decimals(mint: &AccountView) -> Result<u8, ProgramError> {
    mint_decimals(&mint.try_borrow()?)
}

pub fn read_token_amount(account: &AccountView) -> Result<u64, ProgramError> {
    token_amount(&account.try_borrow()?)
}

/// Mirrors `token_account_is_controlled_by`: a non-token or uninitialised
/// account is simply "not ours" rather than an error.
pub fn token_account_is_controlled_by(
    account: &AccountView,
    expected_authority: &Address,
) -> Result<bool, ProgramError> {
    let data = account.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN || data[108] == 0 {
        return Ok(false);
    }
    Ok(data[32..64] == expected_authority.as_ref()[..])
}

// ---------------------------------------------------------------------------
// Validated reads
// ---------------------------------------------------------------------------

/// Decimals of the target mint, plus the Token-2022 extension allow-list.
///
/// Only `MetadataPointer` and `TokenMetadata` are accepted outright. A
/// `TransferHook` is accepted solely for the exact $PUMP mint, exact immutable
/// authority PDA, and unset hook program id.
/// A target mint must not carry a live freeze authority.
///
/// A freeze authority can freeze the vault's target ATA at any time. The burn
/// then reverts (the account's state byte is no longer `Initialized`), the
/// vault keeps receiving fees, and because this program has no withdrawal
/// instruction that SOL is stuck forever. The vault is never at risk of theft
/// -- but "permanently unburnable while still accruing" is the worst outcome
/// the design can produce, so it is refused up front rather than discovered
/// after a launch has locked its fee share to the address.
///
/// This is admission policy, and it costs nothing real: every intended target
/// already has a null freeze authority (JTO, NEIRO, $PUMP, BONK, WIF,
/// FARTCOIN, POPCAT, RAY, and Pump/Launchlab/DBC launches, all verified on
/// mainnet). The tokens it excludes are the centrally-freezable stablecoins,
/// which are not burn targets.
fn freeze_authority_is_none(data: &[u8]) -> Result<(), ProgramError> {
    // Every live caller has already length-checked (`mint_decimals` runs
    // first in `validate_target_mint`), but the invariant must hold locally:
    // data too short to be an SPL Mint is invalid mint data, never a slice
    // panic. `mint_authority_is_none` below already follows this rule.
    if data.len() < MINT_LEN {
        return Err(err(BurnerError::InvalidMintData));
    }
    // SPL Mint: `freeze_authority: COption<Pubkey>` occupies 46..82, and a
    // `None` discriminant is four zero bytes. Token-2022 keeps this base
    // layout; its extensions live past byte 82.
    if data[46..50] != [0, 0, 0, 0] {
        return Err(err(BurnerError::TargetMintFreezable));
    }
    Ok(())
}

fn mint_authority_is_none(data: &[u8]) -> Result<(), ProgramError> {
    // SPL Mint: `mint_authority: COption<Pubkey>` occupies 0..36. A `None`
    // discriminant is four zero bytes. Token-2022 retains this base layout.
    if data.len() < MINT_LEN || data[0..4] != [0, 0, 0, 0] {
        return Err(err(BurnerError::TargetMintMintable));
    }
    Ok(())
}

/// The launch mint is a namespace seed, never swapped, held, or burned, so
/// its entire admission is "an initialised mint under either token program".
/// One copy, shared by `swap_and_burn`, `swap_and_burn_split`, and
/// `validate_config`, so the three cannot disagree about what a launch mint
/// is.
pub fn validate_launch_mint(launch_mint: &AccountView) -> Result<(), ProgramError> {
    let launch_owner = launch_mint.owner();
    if launch_owner != &SPL_TOKEN_PROGRAM_ID && launch_owner != &SPL_TOKEN_2022_PROGRAM_ID {
        return Err(err(BurnerError::InvalidMintOwner));
    }
    read_mint_decimals(launch_mint)?;
    Ok(())
}

pub fn validate_target_mint(
    mint: &AccountView,
    target_program: &Address,
) -> Result<u8, ProgramError> {
    // A native mint can never be a burn target: both token programs refuse
    // `Burn`/`BurnChecked` on native accounts (`NativeNotSupported`), and no
    // venue routes WSOL to WSOL, so a vault configured this way is fundable
    // but permanently unburnable — with no withdrawal instruction, that
    // strands every lamport sent to it. Nothing else here would refuse it:
    // both native mints carry null mint and freeze authorities and no
    // extensions. Refused by identity, in this one shared function, so the
    // burn and `validate_config` cannot disagree about it.
    if mint.address() == &WSOL_MINT || mint.address() == &TOKEN_2022_NATIVE_MINT {
        return Err(err(BurnerError::TargetMintNative));
    }
    let data = mint.try_borrow()?;
    let decimals = mint_decimals(&data)?;
    freeze_authority_is_none(&data)?;
    mint_authority_is_none(&data)?;
    if target_program != &SPL_TOKEN_2022_PROGRAM_ID {
        return Ok(decimals);
    }

    let state = StateWithExtensions::<Mint>::unpack(&data)
        .map_err(|_| err(BurnerError::InvalidMintData))?;
    if state.base.decimals != decimals {
        return Err(err(BurnerError::InvalidMintData));
    }
    validate_token_2022_mint_extensions(&state, mint.address())?;
    Ok(decimals)
}

fn validate_token_2022_mint_extensions(
    state: &StateWithExtensions<'_, Mint>,
    mint: &Address,
) -> Result<(), ProgramError> {
    for extension in state
        .get_extension_types()
        .map_err(|_| err(BurnerError::InvalidMintData))?
    {
        match extension {
            // Pump V2's MetadataPointer + TokenMetadata affect presentation,
            // not balances or transfer semantics.
            ExtensionType::MetadataPointer | ExtensionType::TokenMetadata => {}
            // Generic inert hooks remain refused: a live hook authority can
            // activate one after the immutable vault starts accruing, bricking
            // every future burn with no withdrawal path. $PUMP is the one
            // exact-mint exception: its authority is an exact PDA owned by the
            // immutable, verified-empty `333UA...` authority program, and its
            // hook program id is unset.
            ExtensionType::TransferHook => {
                let hook = state
                    .get_extension::<transfer_hook::TransferHook>()
                    .map_err(|_| err(BurnerError::InvalidMintData))?;
                if !transfer_hook_is_allowed(
                    mint,
                    hook.authority.0.to_bytes(),
                    hook.program_id == Default::default(),
                ) {
                    return Err(err(BurnerError::UnsupportedToken2022Extension));
                }
            }
            _ => return Err(err(BurnerError::UnsupportedToken2022Extension)),
        }
    }
    Ok(())
}

fn transfer_hook_is_allowed(mint: &Address, authority: [u8; 32], program_id_is_none: bool) -> bool {
    mint == &PUMP_MINT && authority == PUMP_TRANSFER_HOOK_AUTHORITY && program_id_is_none
}

/// Current balance of the target ATA, plus its Token-2022 extension
/// allow-list.
pub fn validate_target_account(
    account: &AccountView,
    expected_mint: &Address,
    expected_authority: &Address,
    target_program: &Address,
) -> Result<u64, ProgramError> {
    let data = account.try_borrow()?;
    let amount = token_amount_checked(&data, expected_mint, expected_authority)?;
    if target_program != &SPL_TOKEN_2022_PROGRAM_ID {
        return Ok(amount);
    }

    let state = StateWithExtensions::<TokenAccount>::unpack(&data)
        .map_err(|_| err(BurnerError::InvalidTokenAccountData))?;
    for extension in state
        .get_extension_types()
        .map_err(|_| err(BurnerError::InvalidTokenAccountData))?
    {
        match extension {
            // Token-2022 ATAs commonly use ImmutableOwner. A disabled mint
            // hook can leave this bookkeeping extension on its ATA too.
            ExtensionType::ImmutableOwner | ExtensionType::TransferHookAccount => {}
            _ => return Err(err(BurnerError::UnsupportedToken2022AccountExtension)),
        }
    }
    Ok(amount)
}

/// The WSOL ATA must be a native (wrapped-SOL) account owned by the PDA.
pub fn validate_wsol_account(
    account: &AccountView,
    expected_mint: &Address,
    expected_authority: &Address,
) -> Result<(), ProgramError> {
    validate_wsol_bytes(&account.try_borrow()?, expected_mint, expected_authority)
}

fn validate_wsol_bytes(
    data: &[u8],
    expected_mint: &Address,
    expected_authority: &Address,
) -> Result<(), ProgramError> {
    token_amount_checked(data, expected_mint, expected_authority)?;
    // `is_native: COption<u64>` begins at byte 109 in an SPL Account.
    if data[109..113] != [1, 0, 0, 0] {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Host-side tests for the byte-level guards.
//
// These cover the layout assumptions the whole program rests on, and the one
// guard no client-side test can reach: `verify_no_standing_claims` (6035)
// rejects a delegate or close authority, but only the PDA itself can install
// either, so it is reachable on chain only by a program executing as Jupiter.
// The byte layout is testable directly, so it is tested directly.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::SPL_TOKEN_PROGRAM_ID;
    use core::{mem::size_of, ptr::copy_nonoverlapping};
    use pinocchio::account::{RuntimeAccount, NOT_BORROWED};

    const MINT: [u8; 32] = [7u8; 32];
    const OWNER: [u8; 32] = [9u8; 32];
    const OTHER: [u8; 32] = [3u8; 32];

    /// An initialised, unencumbered SPL token account holding `amount`.
    fn token_account(amount: u64) -> [u8; TOKEN_ACCOUNT_LEN] {
        let mut data = [0u8; TOKEN_ACCOUNT_LEN];
        data[0..32].copy_from_slice(&MINT);
        data[32..64].copy_from_slice(&OWNER);
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        // delegate: COption::None -> 72..76 stay zero
        data[108] = 1; // state: Initialized
                       // is_native: COption::None -> 109..113 stay zero
                       // close_authority: COption::None -> 129..133 stay zero
        data
    }

    fn mint(decimals: u8) -> [u8; MINT_LEN] {
        let mut data = [0u8; MINT_LEN];
        data[44] = decimals;
        data[45] = 1; // is_initialized
        data
    }

    fn code(error: ProgramError) -> u32 {
        match error {
            ProgramError::Custom(n) => n,
            other => panic!("expected a custom error, got {other:?}"),
        }
    }

    /// Construct the exact contiguous runtime layout consumed by AccountView,
    /// then keep its backing allocation alive for the duration of `test`.
    fn with_mint_account<R>(
        data: &[u8],
        address: &Address,
        owner: &Address,
        test: impl FnOnce(&AccountView) -> R,
    ) -> R {
        let byte_len = size_of::<RuntimeAccount>() + data.len();
        let word_len = byte_len.div_ceil(size_of::<u64>());
        let mut backing = vec![0u64; word_len];
        let raw = backing.as_mut_ptr().cast::<RuntimeAccount>();
        unsafe {
            raw.write(RuntimeAccount {
                borrow_state: NOT_BORROWED,
                is_signer: 0,
                is_writable: 1,
                executable: 0,
                padding: [0; 4],
                address: address.clone(),
                owner: owner.clone(),
                lamports: 1,
                data_len: data.len() as u64,
            });
            copy_nonoverlapping(
                data.as_ptr(),
                raw.cast::<u8>().add(size_of::<RuntimeAccount>()),
                data.len(),
            );
            let account = AccountView::new_unchecked(raw);
            test(&account)
        }
    }

    fn decode_hex(input: &str) -> Vec<u8> {
        assert_eq!(input.len() % 2, 0);
        (0..input.len())
            .step_by(2)
            .map(|offset| u8::from_str_radix(&input[offset..offset + 2], 16).unwrap())
            .collect()
    }

    // ---- the layout the rest of the program depends on --------------------

    #[test]
    fn reads_amount_from_bytes_64_to_72() {
        let data = token_account(1_234_567_890);
        assert_eq!(token_amount(&data).unwrap(), 1_234_567_890);
    }

    #[test]
    fn reads_decimals_from_byte_44() {
        assert_eq!(mint_decimals(&mint(9)).unwrap(), 9);
    }

    #[test]
    fn uninitialised_mint_is_rejected() {
        let mut data = mint(6);
        data[45] = 0;
        assert_eq!(code(mint_decimals(&data).unwrap_err()), 6013);
    }

    /// The deliberate asymmetry: a FROZEN account must revert rather than be
    /// silently treated as "not ours" and skipped by the intermediate sweep.
    #[test]
    fn frozen_account_reverts_rather_than_being_skipped() {
        let mut data = token_account(500);
        data[108] = 2; // Frozen
        assert_eq!(code(token_amount(&data).unwrap_err()), 6014);
    }

    #[test]
    fn wrong_mint_and_wrong_authority_are_distinguished() {
        let data = token_account(1);
        let expected_mint = Address::new_from_array(MINT);
        let expected_owner = Address::new_from_array(OWNER);
        let wrong = Address::new_from_array(OTHER);
        assert_eq!(
            code(token_amount_checked(&data, &wrong, &expected_owner).unwrap_err()),
            6015
        );
        assert_eq!(
            code(token_amount_checked(&data, &expected_mint, &wrong).unwrap_err()),
            6016
        );
        assert_eq!(
            token_amount_checked(&data, &expected_mint, &expected_owner).unwrap(),
            1
        );
    }

    // ---- 6036: freezable target mints -------------------------------------

    #[test]
    fn mint_without_freeze_authority_is_accepted() {
        assert!(freeze_authority_is_none(&mint(6)).is_ok());
    }

    /// The reader owns its length invariant: short data is 6013, not a slice
    /// panic — even though every live caller length-checks first.
    #[test]
    fn short_mint_data_is_invalid_mint_data_not_a_panic() {
        assert_eq!(code(freeze_authority_is_none(&[]).unwrap_err()), 6013);
        let one_short = [0u8; MINT_LEN - 1];
        assert_eq!(code(freeze_authority_is_none(&one_short).unwrap_err()), 6013);
        // Exactly MINT_LEN with a null freeze authority still passes.
        assert!(freeze_authority_is_none(&[0u8; MINT_LEN]).is_ok());
    }

    #[test]
    fn mint_with_freeze_authority_is_rejected() {
        let mut data = mint(6);
        // Also leave the mint authority live: the older freeze-liveness guard
        // remains the primary classification when both authorities exist.
        data[0..4].copy_from_slice(&[1, 0, 0, 0]);
        data[4..36].copy_from_slice(&MINT);
        data[46..50].copy_from_slice(&[1, 0, 0, 0]); // COption::Some
        data[50..82].copy_from_slice(&OTHER);
        let address = Address::new_from_array(MINT);
        with_mint_account(&data, &address, &SPL_TOKEN_PROGRAM_ID, |account| {
            assert_eq!(
                code(validate_target_mint(account, &SPL_TOKEN_PROGRAM_ID).unwrap_err()),
                6036
            )
        });
    }

    // ---- 6037: non-mintable burn targets ---------------------------------

    #[test]
    fn validate_target_mint_admits_immutable_legacy_mint() {
        let address = Address::new_from_array(MINT);
        with_mint_account(&mint(6), &address, &SPL_TOKEN_PROGRAM_ID, |account| {
            assert_eq!(validate_target_mint(account, &SPL_TOKEN_PROGRAM_ID), Ok(6))
        });
    }

    #[test]
    fn validate_target_mint_rejects_mintable_legacy_mint() {
        let address = Address::new_from_array(MINT);
        let mut data = mint(6);
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..36].copy_from_slice(&OTHER);
        with_mint_account(&data, &address, &SPL_TOKEN_PROGRAM_ID, |account| {
            assert_eq!(
                code(validate_target_mint(account, &SPL_TOKEN_PROGRAM_ID).unwrap_err()),
                6037
            )
        });
    }

    #[test]
    fn validate_target_mint_admits_safe_token_2022_metadata_pointer() {
        use spl_token_2022::extension::metadata_pointer::MetadataPointer;

        let length =
            ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::MetadataPointer])
                .unwrap();
        let mut data = vec![0u8; length];
        data[..MINT_LEN].copy_from_slice(&mint(6));
        data[165] = 1; // AccountType::Mint
        data[166..168].copy_from_slice(&(ExtensionType::MetadataPointer as u16).to_le_bytes());
        data[168..170].copy_from_slice(&(size_of::<MetadataPointer>() as u16).to_le_bytes());

        let address = Address::new_from_array(MINT);
        with_mint_account(&data, &address, &SPL_TOKEN_2022_PROGRAM_ID, |account| {
            assert_eq!(
                validate_target_mint(account, &SPL_TOKEN_2022_PROGRAM_ID),
                Ok(6)
            )
        });
    }

    /// 6025: a target Token-2022 *account* (the ATA, not the mint) carrying an
    /// extension outside the ImmutableOwner/TransferHookAccount allow-list is
    /// refused. `MemoTransfer` stands in for any disallowed account extension.
    ///
    /// This lives in `validate_target_account`, which `validate_burner` runs
    /// BEFORE the Jupiter route, and which is never re-parsed afterwards -- so
    /// unlike 6018/6020/6023 this is a pre-funding admission check, not a
    /// post-route postcondition a hostile Jupiter program can provoke. The
    /// byte layout is testable directly, so it is tested directly, exactly as
    /// 6035 is.
    #[test]
    fn validate_target_account_rejects_unsupported_token_2022_account_extension() {
        use spl_token_2022::extension::memo_transfer::MemoTransfer;

        let length = ExtensionType::try_calculate_account_len::<TokenAccount>(&[
            ExtensionType::MemoTransfer,
        ])
        .unwrap();
        let mut data = vec![0u8; length];
        data[..TOKEN_ACCOUNT_LEN].copy_from_slice(&token_account(0));
        data[TOKEN_ACCOUNT_LEN] = 2; // AccountType::Account
        data[166..168].copy_from_slice(&(ExtensionType::MemoTransfer as u16).to_le_bytes());
        data[168..170].copy_from_slice(&(size_of::<MemoTransfer>() as u16).to_le_bytes());

        let address = Address::new_from_array(OWNER);
        let expected_mint = Address::new_from_array(MINT);
        let expected_owner = Address::new_from_array(OWNER);
        with_mint_account(&data, &address, &SPL_TOKEN_2022_PROGRAM_ID, |account| {
            assert_eq!(
                code(validate_target_account(
                    account,
                    &expected_mint,
                    &expected_owner,
                    &SPL_TOKEN_2022_PROGRAM_ID,
                )
                .unwrap_err()),
                6025
            )
        });
    }

    #[test]
    fn token_2022_mint_authority_rejects_before_extension_parsing() {
        // Deliberately malformed extended data would classify as 6013 if the
        // TLV decoder ran first. The base mint authority is an admission guard
        // and must win as 6037 before extension parsing.
        let mut malformed_extended = vec![0u8; MINT_LEN + 1];
        malformed_extended[..MINT_LEN].copy_from_slice(&mint(6));
        malformed_extended[0..4].copy_from_slice(&1u32.to_le_bytes());
        malformed_extended[4..36].copy_from_slice(&OTHER);

        let address = Address::new_from_array(MINT);
        with_mint_account(
            &malformed_extended,
            &address,
            &SPL_TOKEN_2022_PROGRAM_ID,
            |account| {
                assert_eq!(
                    code(validate_target_mint(account, &SPL_TOKEN_2022_PROGRAM_ID).unwrap_err()),
                    6037
                )
            },
        );
    }

    // ---- 6038: native mints can never be burn targets ---------------------

    /// Both native mints pass every other admission check (null authorities,
    /// no extensions), so the refusal must be by IDENTITY — and identical
    /// mint bytes at any other address must keep passing.
    #[test]
    fn native_mints_are_refused_as_targets_by_identity() {
        with_mint_account(&mint(9), &WSOL_MINT, &SPL_TOKEN_PROGRAM_ID, |account| {
            assert_eq!(
                code(validate_target_mint(account, &SPL_TOKEN_PROGRAM_ID).unwrap_err()),
                6038
            )
        });
        with_mint_account(
            &mint(9),
            &TOKEN_2022_NATIVE_MINT,
            &SPL_TOKEN_2022_PROGRAM_ID,
            |account| {
                assert_eq!(
                    code(validate_target_mint(account, &SPL_TOKEN_2022_PROGRAM_ID).unwrap_err()),
                    6038
                )
            },
        );
        // The same bytes under a different address remain admissible.
        let other = Address::new_from_array(MINT);
        with_mint_account(&mint(9), &other, &SPL_TOKEN_PROGRAM_ID, |account| {
            assert_eq!(validate_target_mint(account, &SPL_TOKEN_PROGRAM_ID), Ok(9))
        });
    }

    // ---- 6024: exact $PUMP hook exception --------------------------------

    #[test]
    fn only_exact_immutable_pump_hook_is_allowed() {
        assert!(transfer_hook_is_allowed(
            &PUMP_MINT,
            PUMP_TRANSFER_HOOK_AUTHORITY,
            true
        ));
        assert!(!transfer_hook_is_allowed(
            &Address::new_from_array(MINT),
            PUMP_TRANSFER_HOOK_AUTHORITY,
            true
        ));
        assert!(!transfer_hook_is_allowed(&PUMP_MINT, OTHER, true));
        assert!(!transfer_hook_is_allowed(
            &PUMP_MINT,
            PUMP_TRANSFER_HOOK_AUTHORITY,
            false
        ));
    }

    #[test]
    fn actual_pump_hook_tlv_shape_is_admitted() {
        // Token-2022 extended-mint layout: pad the 82-byte base to 165,
        // account_type Mint at 165, then TransferHook TLV type 14 / len 64.
        // These are the exact live $PUMP authority and program-id fields.
        let length =
            ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook])
                .unwrap();
        let mut data = vec![0u8; length];
        data[..MINT_LEN].copy_from_slice(&mint(6));
        data[165] = 1;
        data[166..168].copy_from_slice(&14u16.to_le_bytes());
        data[168..170].copy_from_slice(&64u16.to_le_bytes());
        data[170..202].copy_from_slice(&PUMP_TRANSFER_HOOK_AUTHORITY);
        let state = StateWithExtensions::<Mint>::unpack(&data).unwrap();
        assert!(validate_token_2022_mint_extensions(&state, &PUMP_MINT).is_ok());

        // The same inert hook on any other mint remains fail-closed.
        assert_eq!(
            code(
                validate_token_2022_mint_extensions(&state, &Address::new_from_array(MINT))
                    .unwrap_err()
            ),
            6024
        );
    }

    #[test]
    fn exact_live_pump_mint_passes_full_target_admission() {
        // Exact finalized mainnet account data at slot 440,470,164. This
        // includes the base mint plus TransferHook, MetadataPointer and
        // TokenMetadata extensions, so the assertion exercises the complete
        // public admission path rather than only the hook helper.
        let data = decode_hex(concat!(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "00000000f79f895e1186a40b060100000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "00000000010e004000b794c54d2d7560673deb5c93df3bf24995ba14293407c963",
            "efa5d97ebc4faedc00000000000000000000000000000000000000000000000000",
            "000000000000001200400000000000000000000000000000000000000000000000",
            "000000000000000000000c45f7df8d9e72956284933f6d98b757032e83df84604f",
            "b5e117fff61d5b12f91300a8000000000000000000000000000000000000000000",
            "0000000000000000000000000c45f7df8d9e72956284933f6d98b757032e83df84",
            "604fb5e117fff61d5b12f90400000050756d700400000050554d5050000000687474",
            "70733a2f2f697066732e696f2f697066732f6261666b7265696263676c6c646b66",
            "64656b646b7867756d6c76656f6536717633706269636579706b77746c69333363",
            "6c627a756c376c656f346d00000000"
        ));
        assert_eq!(data.len(), 474);
        with_mint_account(&data, &PUMP_MINT, &SPL_TOKEN_2022_PROGRAM_ID, |account| {
            assert_eq!(account.address(), &PUMP_MINT);
            assert_eq!(
                validate_target_mint(account, &SPL_TOKEN_2022_PROGRAM_ID),
                Ok(6)
            );
        });
    }

    // ---- 6035: standing claims --------------------------------------------

    #[test]
    fn clean_account_carries_no_standing_claim() {
        assert!(verify_no_standing_claims(&token_account(0)).is_ok());
    }

    #[test]
    fn delegate_is_rejected() {
        let mut data = token_account(0);
        data[72..76].copy_from_slice(&[1, 0, 0, 0]); // COption::Some
        data[76..108].copy_from_slice(&OTHER);
        assert_eq!(code(verify_no_standing_claims(&data).unwrap_err()), 6035);
    }

    #[test]
    fn close_authority_is_rejected() {
        let mut data = token_account(0);
        data[129..133].copy_from_slice(&[1, 0, 0, 0]); // COption::Some
        data[133..165].copy_from_slice(&OTHER);
        assert_eq!(code(verify_no_standing_claims(&data).unwrap_err()), 6035);
    }

    /// The reader owns its length invariant: short data is 6014, not a slice
    /// panic — even though every live caller length-checks first.
    #[test]
    fn short_token_account_data_is_invalid_account_data_not_a_panic() {
        assert_eq!(code(verify_no_standing_claims(&[]).unwrap_err()), 6014);
        let one_short = [0u8; TOKEN_ACCOUNT_LEN - 1];
        assert_eq!(
            code(verify_no_standing_claims(&one_short).unwrap_err()),
            6014
        );
        // Exactly TOKEN_ACCOUNT_LEN, unencumbered, still passes.
        assert!(verify_no_standing_claims(&[0u8; TOKEN_ACCOUNT_LEN]).is_ok());
    }

    /// A standing claim must be caught on the ordinary validated-read path,
    /// not only when checked directly.
    #[test]
    fn standing_claim_blocks_the_validated_read() {
        let mut data = token_account(42);
        data[72..76].copy_from_slice(&[1, 0, 0, 0]);
        let expected_mint = Address::new_from_array(MINT);
        let expected_owner = Address::new_from_array(OWNER);
        assert_eq!(
            code(token_amount_checked(&data, &expected_mint, &expected_owner).unwrap_err()),
            6035
        );
    }

    #[test]
    fn exact_live_bilal_metadata_mint_passes_full_target_admission() {
        // Exact finalized Token-2022 mint account for BILAL
        // (`BPiCcYXUzp6qs1WucMUv4hU1bcKfdn5Db62tVbRuwApt`). Its base mint
        // and freeze authorities are both None, and its only extensions are
        // MetadataPointer and TokenMetadata.
        let bilal = Address::new_from_array([
            154, 102, 59, 120, 30, 70, 95, 73, 179, 254, 132, 16, 20, 252, 57, 141, 205, 75, 104,
            86, 90, 29, 5, 71, 32, 206, 8, 217, 102, 121, 191, 77,
        ]);
        let data = decode_hex(concat!(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "00000000362b1c8ca6b5dc0d060100000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "00000000011200400030c5a9ce7945edc9f05ede2d823476acddbda8f3de984746",
            "ce78cf9ceda9c7919a663b781e465f49b3fe841014fc398dcd4b68565a1d054720c",
            "e08d96679bf4d1300a40030c5a9ce7945edc9f05ede2d823476acddbda8f3de984",
            "746ce78cf9ceda9c7919a663b781e465f49b3fe841014fc398dcd4b68565a1d054",
            "720ce08d96679bf4d0a000000496e73696465204a6f620500000042494c414c4500",
            "000068747470733a2f2f676174657761792e697279732e78797a2f376b5267315a62",
            "3970793239353145595437323361736343694e43463834367679466b63575a336a4e",
            "54653500000000"
        ));
        assert_eq!(data.len(), 402);
        with_mint_account(&data, &bilal, &SPL_TOKEN_2022_PROGRAM_ID, |account| {
            assert_eq!(account.address(), &bilal);
            assert_eq!(
                validate_target_mint(account, &SPL_TOKEN_2022_PROGRAM_ID),
                Ok(6)
            );
        });
    }

    /// The WSOL account must additionally be native; the `is_native` tag lives
    /// at 109..113, immediately after the state byte.
    #[test]
    fn wsol_must_be_native() {
        let expected_mint = Address::new_from_array(MINT);
        let expected_owner = Address::new_from_array(OWNER);
        let data = token_account(0);
        // is_native = None -> rejected
        assert_eq!(
            code(validate_wsol_bytes(&data, &expected_mint, &expected_owner).unwrap_err()),
            6014
        );
        let mut native = token_account(0);
        native[109..113].copy_from_slice(&[1, 0, 0, 0]);
        assert!(validate_wsol_bytes(&native, &expected_mint, &expected_owner).is_ok());
    }
}

// ---------------------------------------------------------------------------
// Property fuzzing of the byte-level readers.
//
// Every function here parses bytes the program does not control, in a program
// that cannot refund a stranded vault, so the properties are absolute: no
// input of ANY length may panic (an abort, not a clean revert, in SBF), and
// every rejection must be the exact named `BurnerError`. The tests are
// DIFFERENTIAL: an independent restatement of the SPL layout (offsets written
// from the spec, not read back out of the code under test) predicts the exact
// result, and the reader must agree on every generated input — random bytes,
// structured accounts with adversarial field mutations, and an exhaustive
// sweep of every length through every guard boundary.
//
// Runs with the ordinary suite (`npm run test:unit`); a longer campaign is
// `PROPTEST_CASES=100000 npm run fuzz:host` (see package.json / fuzz-burner.sh).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod fuzz {
    use super::*;
    use proptest::prelude::*;

    const MINT_A: [u8; 32] = [0xAA; 32];
    const OWNER_A: [u8; 32] = [0xBB; 32];

    fn cases(default: u32) -> u32 {
        std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    }

    /// Collapse a reader result to (value, code) form for comparison.
    fn as_code<T>(result: Result<T, ProgramError>) -> Result<T, u32>
    where
        T: core::fmt::Debug,
    {
        result.map_err(|e| match e {
            ProgramError::Custom(code) => code,
            other => panic!("reader returned a non-custom error: {other:?}"),
        })
    }

    // ---- independent models of the SPL layouts -----------------------------
    // SPL Token Account (165 bytes): mint 0..32, owner 32..64, amount 64..72,
    // delegate COption tag 72..76 + key 76..108, state 108, is_native tag
    // 109..113 + value 113..121, delegated_amount 121..129, close_authority
    // tag 129..133 + key 133..165.
    // SPL Mint (82 bytes): mint_authority tag 0..4 + key 4..36, supply 36..44,
    // decimals 44, is_initialized 45, freeze_authority tag 46..50 + key 50..82.

    fn model_mint_decimals(d: &[u8]) -> Result<u8, u32> {
        if d.len() < 82 || d[45] != 1 {
            return Err(6013);
        }
        Ok(d[44])
    }

    fn model_token_amount(d: &[u8]) -> Result<u64, u32> {
        if d.len() < 165 || d[108] != 1 {
            return Err(6014);
        }
        Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
    }

    fn model_no_standing_claims(d: &[u8]) -> Result<(), u32> {
        if d.len() < 165 {
            return Err(6014);
        }
        // Any nonzero byte in either COption tag counts as a claim: the
        // reader must be at least as strict as "tag != None".
        if d[72..76] != [0u8; 4] || d[129..133] != [0u8; 4] {
            return Err(6035);
        }
        Ok(())
    }

    fn model_token_amount_checked(
        d: &[u8],
        mint: &[u8; 32],
        authority: &[u8; 32],
    ) -> Result<u64, u32> {
        if d.len() < 165 || d[108] != 1 {
            return Err(6014);
        }
        model_no_standing_claims(d)?;
        if &d[0..32] != mint {
            return Err(6015);
        }
        if &d[32..64] != authority {
            return Err(6016);
        }
        Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
    }

    fn model_freeze_authority_is_none(d: &[u8]) -> Result<(), u32> {
        if d.len() < 82 {
            return Err(6013);
        }
        if d[46..50] != [0u8; 4] {
            return Err(6036);
        }
        Ok(())
    }

    /// Deliberate asymmetry in the code under test: short mint data is 6037
    /// here, not 6013. Unreachable live (`mint_decimals` length-checks first
    /// inside `validate_target_mint`), and fail-closed either way.
    fn model_mint_authority_is_none(d: &[u8]) -> Result<(), u32> {
        if d.len() < 82 || d[0..4] != [0u8; 4] {
            return Err(6037);
        }
        Ok(())
    }

    fn model_wsol(d: &[u8], mint: &[u8; 32], authority: &[u8; 32]) -> Result<(), u32> {
        model_token_amount_checked(d, mint, authority)?;
        if d[109..113] != [1, 0, 0, 0] {
            return Err(6014);
        }
        Ok(())
    }

    /// Every reader against one buffer; the readers must match their models
    /// exactly — same Ok value or same named code — and must not panic.
    fn assert_all_readers_match(data: &[u8]) {
        let mint_a = Address::new_from_array(MINT_A);
        let owner_a = Address::new_from_array(OWNER_A);
        assert_eq!(as_code(mint_decimals(data)), model_mint_decimals(data));
        assert_eq!(as_code(token_amount(data)), model_token_amount(data));
        assert_eq!(
            as_code(verify_no_standing_claims(data)),
            model_no_standing_claims(data)
        );
        assert_eq!(
            as_code(token_amount_checked(data, &mint_a, &owner_a)),
            model_token_amount_checked(data, &MINT_A, &OWNER_A)
        );
        assert_eq!(
            as_code(freeze_authority_is_none(data)),
            model_freeze_authority_is_none(data)
        );
        assert_eq!(
            as_code(mint_authority_is_none(data)),
            model_mint_authority_is_none(data)
        );
        assert_eq!(
            as_code(validate_wsol_bytes(data, &mint_a, &owner_a)),
            model_wsol(data, &MINT_A, &OWNER_A)
        );
    }

    /// A structured token account whose security-relevant fields are all
    /// adversarial: pass/fail identities, arbitrary state byte, arbitrary
    /// COption tags (not just 0/1), then truncated or extended arbitrarily.
    fn structured_token_account() -> impl Strategy<Value = Vec<u8>> {
        (
            prop_oneof![Just(MINT_A), any::<[u8; 32]>()],
            prop_oneof![Just(OWNER_A), any::<[u8; 32]>()],
            any::<u64>(),
            prop_oneof![
                4 => Just(1u8),
                2 => Just(0u8),
                2 => Just(2u8),
                1 => any::<u8>()
            ],
            // delegate / is_native / close_authority COption tags
            prop_oneof![3 => Just([0u8; 4]), 2 => Just([1, 0, 0, 0]), 1 => any::<[u8; 4]>()],
            prop_oneof![3 => Just([0u8; 4]), 2 => Just([1, 0, 0, 0]), 1 => any::<[u8; 4]>()],
            prop_oneof![3 => Just([0u8; 4]), 2 => Just([1, 0, 0, 0]), 1 => any::<[u8; 4]>()],
            // final length: truncations, the exact boundary, and extension
            // tails (Token-2022 extension territory past 165)
            prop_oneof![
                3 => Just(TOKEN_ACCOUNT_LEN),
                3 => 0usize..=TOKEN_ACCOUNT_LEN + 1,
                1 => TOKEN_ACCOUNT_LEN..=400usize
            ],
        )
            .prop_map(
                |(mint, owner, amount, state, delegate, native, close, len)| {
                    let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
                    d[0..32].copy_from_slice(&mint);
                    d[32..64].copy_from_slice(&owner);
                    d[64..72].copy_from_slice(&amount.to_le_bytes());
                    d[72..76].copy_from_slice(&delegate);
                    d[108] = state;
                    d[109..113].copy_from_slice(&native);
                    d[129..133].copy_from_slice(&close);
                    d.resize(len, 0);
                    d
                },
            )
    }

    /// A structured mint with adversarial authority tags and lengths.
    fn structured_mint() -> impl Strategy<Value = Vec<u8>> {
        (
            prop_oneof![3 => Just([0u8; 4]), 2 => Just([1, 0, 0, 0]), 1 => any::<[u8; 4]>()],
            any::<u8>(),
            prop_oneof![4 => Just(1u8), 3 => Just(0u8), 1 => any::<u8>()],
            prop_oneof![3 => Just([0u8; 4]), 2 => Just([1, 0, 0, 0]), 1 => any::<[u8; 4]>()],
            prop_oneof![
                3 => Just(MINT_LEN),
                3 => 0usize..=MINT_LEN + 1,
                1 => MINT_LEN..=400usize
            ],
        )
            .prop_map(|(mint_auth, decimals, initialized, freeze_auth, len)| {
                let mut d = vec![0u8; MINT_LEN];
                d[0..4].copy_from_slice(&mint_auth);
                d[44] = decimals;
                d[45] = initialized;
                d[46..50].copy_from_slice(&freeze_auth);
                d.resize(len, 0);
                d
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(cases(4096)))]

        /// Purely arbitrary bytes of any length: nothing panics, everything
        /// matches the model.
        #[test]
        fn readers_survive_arbitrary_bytes(data in proptest::collection::vec(any::<u8>(), 0..=700)) {
            assert_all_readers_match(&data);
        }

        /// Structured token accounts with adversarial fields at the exact
        /// offsets the program depends on.
        #[test]
        fn readers_match_model_on_structured_token_accounts(data in structured_token_account()) {
            assert_all_readers_match(&data);
        }

        /// Structured mints with adversarial authority tags.
        #[test]
        fn readers_match_model_on_structured_mints(data in structured_mint()) {
            assert_all_readers_match(&data);
        }

        /// One random byte flipped in an otherwise-valid account must never
        /// change an error into a panic or an unnamed failure.
        #[test]
        fn single_byte_mutations_stay_named(
            offset in 0usize..TOKEN_ACCOUNT_LEN,
            value in any::<u8>(),
            amount in any::<u64>(),
        ) {
            let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
            d[0..32].copy_from_slice(&MINT_A);
            d[32..64].copy_from_slice(&OWNER_A);
            d[64..72].copy_from_slice(&amount.to_le_bytes());
            d[108] = 1;
            d[offset] = value;
            assert_all_readers_match(&d);
        }
    }

    /// Exhaustive, not sampled: every length 0..=400 through every reader,
    /// on all-zero and all-0xFF fills, pins both length-guard boundaries
    /// (82 for mints, 165 for token accounts) with no possibility of a
    /// missed off-by-one.
    #[test]
    fn every_length_is_survivable_and_named() {
        for len in 0..=400usize {
            assert_all_readers_match(&vec![0u8; len]);
            assert_all_readers_match(&vec![0xFFu8; len]);
        }
    }
}
