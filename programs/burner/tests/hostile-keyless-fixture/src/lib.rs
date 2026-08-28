//! Hostile Jupiter stand-in for the KEYLESS regression.
//!
//! A superset of `tests/hostile-jupiter-fixture`. Mollusk installs it at the
//! real pinned Jupiter id, so during the route CPI it receives exactly the
//! burn PDA signer privilege the keyless split path grants — the identical
//! privilege the KMS path grants, because reference binding and the output
//! floor are enforced entirely BEFORE any CPI and change nothing about what
//! the route itself is trusted with. Each mode abuses that privilege in one
//! chosen way; the burner must reject and the SVM must roll every mutation
//! back byte-identically.
//!
//! ```text
//!  0 STEAL_LAMPORT          -> 6019 BurnPdaLamportMismatch
//!  1 ASSIGN_PDA             -> 6012 InvalidBurnPda
//!  2 ALLOCATE_PDA           -> 6012 InvalidBurnPda
//!  3 APPROVE_WSOL_DELEGATE  -> 6035 TokenAccountEncumbered (WSOL delegate)
//!  4 SET_TARGET_CLOSE_AUTH  -> 6035 TokenAccountEncumbered (target close auth)
//!  5 WSOL_UNDERCONSUME      -> 6018 WsolNotFullyConsumed
//!  6 TARGET_DECREASE        -> 6020 TargetBalanceDecreased
//!  7 INTERMEDIATE_KEEP      -> 6023 IntermediateBalanceRemaining (kept a balance)
//!  8 INTERMEDIATE_REASSIGN  -> 6023 IntermediateBalanceRemaining (SetAuthority'd away)
//!  9 JUST_SWAP              -> honest route: consume the WSOL, deposit one
//!                             target unit, do nothing else. The burn SUCCEEDS
//!                             when minimum_output <= 1, and is refused 6021
//!                             SlippageExceeded when the caller (or the
//!                             program floor) demands more than a hostile
//!                             route chose to deliver. Proves the keyless
//!                             output floor is a HARD on-chain lower bound.
//! 10 DRAIN_ROUTE_SOURCE     -> drain a PDA-owned route source into a sink
//!                             (extended 6042/6043 suite; unused here).
//! 11 REENTER_NESTED_BURN    -> CPI into the burner with the PDA as `caller`
//!                             (the only signer Jupiter was granted) and an
//!                             empty-route split. The SVM refuses the nested
//!                             invoke (`ReentrancyNotAllowed`) before the
//!                             inner burner runs. The outer burn fails and
//!                             the vault rolls back. This is CPI-reentrancy,
//!                             not "Jupiter abused the PDA against
//!                             Token/System" (modes 0-8).
//! 12 REENTER_VALIDATE       -> CPI `validate_config` (read-only) then
//!                             JUST_SWAP. Same SVM refusal: a program cannot
//!                             reenter itself, even for a read-only inner
//!                             instruction. Outer fails; vault untouched.


#![cfg_attr(not(test), no_std)]

use pinocchio::{
    cpi::invoke,
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

const SPL_TOKEN_PROGRAM_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133,
    237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0; 32]);

const PDA: usize = 0;
const WSOL_SOURCE: usize = 1;
const TARGET_DESTINATION: usize = 2;
const SPL_TOKEN_PROGRAM: usize = 5;
const TARGET_SOURCE: usize = 10;
const ATTACKER: usize = 11;
const SYSTEM_PROGRAM: usize = 12;
const WSOL_RECIPIENT: usize = 13;
const HONEST_TARGET_SOURCE: usize = 14;
const BALANCE_SINK: usize = 15;
const BURNER_PROGRAM: usize = 16;
const LAUNCH_MINT: usize = 17;
const REFERENCE: usize = 18;
const VAULT_A: usize = 19;
const VAULT_B: usize = 20;

const MODE_STEAL_LAMPORT: u8 = 0;
const MODE_ASSIGN_PDA: u8 = 1;
const MODE_ALLOCATE_PDA: u8 = 2;
const MODE_APPROVE_WSOL_DELEGATE: u8 = 3;
const MODE_SET_TARGET_CLOSE_AUTHORITY: u8 = 4;
const MODE_WSOL_UNDERCONSUME: u8 = 5;
const MODE_TARGET_DECREASE: u8 = 6;
const MODE_INTERMEDIATE_KEEP: u8 = 7;
const MODE_INTERMEDIATE_REASSIGN: u8 = 8;
const MODE_JUST_SWAP: u8 = 9;
const MODE_DRAIN_ROUTE_SOURCE: u8 = 10;
const MODE_REENTER_NESTED_BURN: u8 = 11;
const MODE_REENTER_VALIDATE: u8 = 12;

const ROUTE_V2_PREFIX_LEN: usize = 8 + 8 + 8 + 2 + 2 + 2 + 4;

const SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

fn process_instruction(
    _program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let mode = *data
        .get(ROUTE_V2_PREFIX_LEN)
        .ok_or(ProgramError::InvalidInstructionData)?;
    if accounts.len() <= WSOL_RECIPIENT
        || accounts[SPL_TOKEN_PROGRAM].address() != &SPL_TOKEN_PROGRAM_ID
        || accounts[SYSTEM_PROGRAM].address() != &SYSTEM_PROGRAM_ID
    {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let amount = amount_from_route(data)?;

    match mode {
        MODE_STEAL_LAMPORT => {
            pass_swap(accounts, amount)?;
            transfer_one_lamport(accounts)
        }
        MODE_ASSIGN_PDA => {
            pass_swap(accounts, amount)?;
            assign_pda(accounts)
        }
        MODE_ALLOCATE_PDA => {
            pass_swap(accounts, amount)?;
            allocate_pda(accounts)
        }
        MODE_APPROVE_WSOL_DELEGATE => {
            pass_swap(accounts, amount)?;
            approve_wsol_delegate(accounts)
        }
        MODE_SET_TARGET_CLOSE_AUTHORITY => {
            pass_swap(accounts, amount)?;
            set_target_close_authority(accounts)
        }
        MODE_WSOL_UNDERCONSUME => transfer_wsol_to_attacker(accounts, amount - 1),
        MODE_TARGET_DECREASE => {
            transfer_wsol_to_attacker(accounts, amount)?;
            withdraw_target_unit(accounts)
        }
        MODE_INTERMEDIATE_KEEP => {
            transfer_wsol_to_attacker(accounts, amount)?;
            transfer_one_target_unit(accounts)
        }
        MODE_INTERMEDIATE_REASSIGN => {
            transfer_wsol_to_attacker(accounts, amount)?;
            transfer_one_target_unit(accounts)?;
            reassign_target_source(accounts)
        }
        MODE_JUST_SWAP => pass_swap(accounts, amount),
        MODE_DRAIN_ROUTE_SOURCE => drain_route_source(accounts, amount),
        MODE_REENTER_NESTED_BURN => reenter_nested_burn(accounts, amount),
        MODE_REENTER_VALIDATE => reenter_validate_then_swap(accounts, amount),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn pass_swap(accounts: &[AccountView], amount: u64) -> ProgramResult {
    transfer_wsol_to_attacker(accounts, amount)?;
    transfer_one_target_unit(accounts)
}

fn drain_route_source(accounts: &[AccountView], amount: u64) -> ProgramResult {
    if accounts.len() <= BALANCE_SINK {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    transfer_wsol_to_attacker(accounts, amount)?;
    transfer_target_unit(accounts, HONEST_TARGET_SOURCE, TARGET_DESTINATION)?;
    transfer_target_unit(accounts, TARGET_SOURCE, BALANCE_SINK)
}

fn amount_from_route(data: &[u8]) -> Result<u64, ProgramError> {
    let bytes = data.get(8..16).ok_or(ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidInstructionData)?,
    ))
}

fn transfer_wsol_to_attacker(accounts: &[AccountView], amount: u64) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 3; // SPL Token `Transfer`
    data[1..].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::writable(accounts[WSOL_SOURCE].address()),
        InstructionAccount::writable(accounts[WSOL_RECIPIENT].address()),
        InstructionAccount::readonly_signer(accounts[PDA].address()),
    ];
    invoke(
        &InstructionView { program_id: &SPL_TOKEN_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[WSOL_SOURCE], &accounts[WSOL_RECIPIENT], &accounts[PDA]],
    )
}

fn transfer_one_target_unit(accounts: &[AccountView]) -> ProgramResult {
    transfer_target_unit(accounts, TARGET_SOURCE, TARGET_DESTINATION)
}

fn withdraw_target_unit(accounts: &[AccountView]) -> ProgramResult {
    transfer_target_unit(accounts, TARGET_DESTINATION, TARGET_SOURCE)
}

fn transfer_target_unit(accounts: &[AccountView], from: usize, to: usize) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 3; // SPL Token `Transfer`
    data[1..].copy_from_slice(&1u64.to_le_bytes());
    let metas = [
        InstructionAccount::writable(accounts[from].address()),
        InstructionAccount::writable(accounts[to].address()),
        InstructionAccount::readonly_signer(accounts[PDA].address()),
    ];
    invoke(
        &InstructionView { program_id: &SPL_TOKEN_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[from], &accounts[to], &accounts[PDA]],
    )
}

fn transfer_one_lamport(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 12];
    data[..4].copy_from_slice(&2u32.to_le_bytes()); // System `Transfer`
    data[4..].copy_from_slice(&1u64.to_le_bytes());
    let metas = [
        InstructionAccount::writable_signer(accounts[PDA].address()),
        InstructionAccount::writable(accounts[ATTACKER].address()),
    ];
    invoke(
        &InstructionView { program_id: &SYSTEM_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[PDA], &accounts[ATTACKER]],
    )
}

fn assign_pda(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 36];
    data[..4].copy_from_slice(&1u32.to_le_bytes()); // System `Assign`
    data[4..].copy_from_slice(accounts[ATTACKER].address().as_ref());
    let metas = [InstructionAccount::writable_signer(accounts[PDA].address())];
    invoke(
        &InstructionView { program_id: &SYSTEM_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[PDA]],
    )
}

fn allocate_pda(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 12];
    data[..4].copy_from_slice(&8u32.to_le_bytes()); // System `Allocate`
    data[4..].copy_from_slice(&8u64.to_le_bytes());
    let metas = [InstructionAccount::writable_signer(accounts[PDA].address())];
    invoke(
        &InstructionView { program_id: &SYSTEM_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[PDA]],
    )
}

fn approve_wsol_delegate(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 4; // SPL Token `Approve`
    data[1..].copy_from_slice(&1u64.to_le_bytes());
    let metas = [
        InstructionAccount::writable(accounts[WSOL_SOURCE].address()),
        InstructionAccount::readonly(accounts[ATTACKER].address()),
        InstructionAccount::readonly_signer(accounts[PDA].address()),
    ];
    invoke(
        &InstructionView { program_id: &SPL_TOKEN_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[WSOL_SOURCE], &accounts[ATTACKER], &accounts[PDA]],
    )
}

fn set_target_close_authority(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 38];
    data[0] = 6; // SPL Token `SetAuthority`
    data[1] = 3; // AuthorityType::CloseAccount
    data[2..6].copy_from_slice(&1u32.to_le_bytes()); // COption::Some
    data[6..].copy_from_slice(accounts[ATTACKER].address().as_ref());
    let metas = [
        InstructionAccount::writable(accounts[TARGET_DESTINATION].address()),
        InstructionAccount::readonly_signer(accounts[PDA].address()),
    ];
    invoke(
        &InstructionView { program_id: &SPL_TOKEN_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[TARGET_DESTINATION], &accounts[PDA]],
    )
}

fn reassign_target_source(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 38];
    data[0] = 6; // SPL Token `SetAuthority`
    data[1] = 2; // AuthorityType::AccountOwner
    data[2..6].copy_from_slice(&1u32.to_le_bytes()); // COption::Some
    data[6..].copy_from_slice(accounts[ATTACKER].address().as_ref());
    let metas = [
        InstructionAccount::writable(accounts[TARGET_SOURCE].address()),
        InstructionAccount::readonly_signer(accounts[PDA].address()),
    ];
    invoke(
        &InstructionView { program_id: &SPL_TOKEN_PROGRAM_ID, data: &data, accounts: &metas },
        &[&accounts[TARGET_SOURCE], &accounts[PDA]],
    )
}

const TARGET_MINT: usize = 4;
const JUPITER: usize = 9;

fn require_reenter_accounts(accounts: &[AccountView]) -> ProgramResult {
    if accounts.len() <= VAULT_B {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    Ok(())
}

/// Nested `swap_and_burn_split` with the PDA as the only signer (the privilege
/// Jupiter was granted) and empty route data. The SVM refuses the CPI because
/// the burner is already on the stack (`ReentrancyNotAllowed`); empty route
/// is still the right payload so a future runtime that allowed reentry would
/// hit the curve adapter instead of recursing this mode.
fn reenter_nested_burn(accounts: &[AccountView], amount: u64) -> ProgramResult {
    require_reenter_accounts(accounts)?;
    let mut data = [0u8; 35];
    data[..8].copy_from_slice(&SPLIT_DISCRIMINATOR);
    data[8..16].copy_from_slice(&amount.to_le_bytes());
    data[16..20].copy_from_slice(&1u32.to_le_bytes());
    data[20..22].copy_from_slice(&10_000u16.to_le_bytes());
    data[22..30].copy_from_slice(&1u64.to_le_bytes());
    data[30] = 0; // route_account_count: empty -> curve path
    data[31..35].copy_from_slice(&0u32.to_le_bytes());
    let metas = [
        InstructionAccount::writable_signer(accounts[PDA].address()),
        InstructionAccount::readonly(accounts[BURNER_PROGRAM].address()),
        InstructionAccount::writable_signer(accounts[PDA].address()),
        InstructionAccount::writable(accounts[WSOL_SOURCE].address()),
        InstructionAccount::readonly(accounts[LAUNCH_MINT].address()),
        InstructionAccount::readonly(accounts[SYSTEM_PROGRAM].address()),
        InstructionAccount::readonly(accounts[SPL_TOKEN_PROGRAM].address()),
        InstructionAccount::readonly(accounts[JUPITER].address()),
        InstructionAccount::writable(accounts[TARGET_MINT].address()),
        InstructionAccount::writable(accounts[TARGET_DESTINATION].address()),
        InstructionAccount::readonly(accounts[SPL_TOKEN_PROGRAM].address()),
        InstructionAccount::readonly(accounts[REFERENCE].address()),
        InstructionAccount::readonly(accounts[VAULT_A].address()),
        InstructionAccount::readonly(accounts[VAULT_B].address()),
        InstructionAccount::readonly(accounts[REFERENCE].address()),
    ];
    invoke(
        &InstructionView {
            program_id: accounts[BURNER_PROGRAM].address(),
            data: &data,
            accounts: &metas,
        },
        &[
            &accounts[PDA],
            &accounts[BURNER_PROGRAM],
            &accounts[PDA],
            &accounts[WSOL_SOURCE],
            &accounts[LAUNCH_MINT],
            &accounts[SYSTEM_PROGRAM],
            &accounts[SPL_TOKEN_PROGRAM],
            &accounts[JUPITER],
            &accounts[TARGET_MINT],
            &accounts[TARGET_DESTINATION],
            &accounts[SPL_TOKEN_PROGRAM],
            &accounts[REFERENCE],
            &accounts[VAULT_A],
            &accounts[VAULT_B],
            &accounts[REFERENCE],
        ],
    )
}

/// Read-only reentry: `validate_config` has no invoke. The SVM still refuses
/// the CPI (`ReentrancyNotAllowed`) because it is the same program. JUST_SWAP
/// is never reached.
fn reenter_validate_then_swap(accounts: &[AccountView], amount: u64) -> ProgramResult {
    require_reenter_accounts(accounts)?;
    let mut data = [0u8; 23];
    data[..8].copy_from_slice(&VALIDATE_CONFIG_DISCRIMINATOR);
    data[8] = 0; // Mode A
    data[9..13].copy_from_slice(&1u32.to_le_bytes());
    data[13..15].copy_from_slice(&10_000u16.to_le_bytes());
    data[15..23].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::readonly(accounts[PDA].address()),
        InstructionAccount::readonly(accounts[WSOL_SOURCE].address()),
        InstructionAccount::readonly(accounts[LAUNCH_MINT].address()),
        InstructionAccount::readonly(accounts[TARGET_MINT].address()),
        InstructionAccount::readonly(accounts[TARGET_DESTINATION].address()),
        InstructionAccount::readonly(accounts[SPL_TOKEN_PROGRAM].address()),
        InstructionAccount::readonly(accounts[REFERENCE].address()),
        InstructionAccount::readonly(accounts[VAULT_A].address()),
        InstructionAccount::readonly(accounts[VAULT_B].address()),
        InstructionAccount::readonly(accounts[REFERENCE].address()),
    ];
    invoke(
        &InstructionView {
            program_id: accounts[BURNER_PROGRAM].address(),
            data: &data,
            accounts: &metas,
        },
        &[
            &accounts[PDA],
            &accounts[WSOL_SOURCE],
            &accounts[LAUNCH_MINT],
            &accounts[TARGET_MINT],
            &accounts[TARGET_DESTINATION],
            &accounts[SPL_TOKEN_PROGRAM],
            &accounts[REFERENCE],
            &accounts[VAULT_A],
            &accounts[VAULT_B],
            &accounts[REFERENCE],
        ],
    )?;
    pass_swap(accounts, amount)
}
