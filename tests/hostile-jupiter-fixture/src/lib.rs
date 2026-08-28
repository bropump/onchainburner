//! A hostile stand-in for Jupiter, compiled only for the Mollusk regression.
//!
//! The real burner passes the PDA as a signer to Jupiter.  This fixture uses
//! that authority exactly as a malicious upgraded Jupiter program would: it
//! first makes the burn otherwise passable, then misbehaves in one specific,
//! chosen way so exactly one of the burner's post-route postconditions fires.
//! The outer burner must reject and the SVM must roll every mutation back.
//!
//! Each `MODE_*` provokes one named `BurnerError`:
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
//! ```
//!
//! There is deliberately NO mode for 6017, 6022, or 6025. A route CPI cannot
//! reach any of them: 6017 (WSOL funding) and 6025 (target-account extension
//! admission) are checked BEFORE the route runs, and 6022 (burn incomplete)
//! cannot occur because the burner always burns exactly the balance it read
//! immediately beforehand, leaving zero. See the test module and the report.

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

// The direct route_v2 account prefix is deliberately mirrored in the test
// setup.  Extra fixture-only accounts start at index 10.
const PDA: usize = 0;
const WSOL_SOURCE: usize = 1;
const TARGET_DESTINATION: usize = 2;
const SPL_TOKEN_PROGRAM: usize = 5;
const TARGET_SOURCE: usize = 10;
const ATTACKER: usize = 11;
const SYSTEM_PROGRAM: usize = 12;
const WSOL_RECIPIENT: usize = 13;

const MODE_STEAL_LAMPORT: u8 = 0;
const MODE_ASSIGN_PDA: u8 = 1;
const MODE_ALLOCATE_PDA: u8 = 2;
const MODE_APPROVE_WS0L_DELEGATE: u8 = 3;
const MODE_SET_TARGET_CLOSE_AUTHORITY: u8 = 4;
const MODE_WSOL_UNDERCONSUME: u8 = 5;
const MODE_TARGET_DECREASE: u8 = 6;
const MODE_INTERMEDIATE_KEEP: u8 = 7;
const MODE_INTERMEDIATE_REASSIGN: u8 = 8;

const ROUTE_V2_PREFIX_LEN: usize = 8 + 8 + 8 + 2 + 2 + 2 + 4;

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
// `nostd_panic_handler!`, NOT `default_panic_handler!`. The production crate
// uses the latter only because `spl-token-2022` drags in `std`, which already
// supplies the `panic_impl` lang item. This fixture has no such dependency, so
// it is genuinely `no_std` and must define the handler itself -- otherwise the
// crate fails to build and the hostile-Jupiter test it exists for is silently
// skipped, leaving the gap it was written to close still open.
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
        // The custody / authority attacks: perform an economically
        // valid-looking swap first (consume the authorized WSOL, deposit one
        // target unit) so every postcondition BEFORE the one under test
        // passes, then commit the specific abuse of the PDA's signature.
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
        MODE_APPROVE_WS0L_DELEGATE => {
            pass_swap(accounts, amount)?;
            approve_wsol_delegate(accounts)
        }
        MODE_SET_TARGET_CLOSE_AUTHORITY => {
            pass_swap(accounts, amount)?;
            set_target_close_authority(accounts)
        }
        // Leave the authorized WSOL partly unconsumed: the burner requires the
        // WSOL account to return to its exact pre-funding balance.
        MODE_WSOL_UNDERCONSUME => transfer_wsol_to_attacker(accounts, amount - 1),
        // Fully consume WSOL (so 6018 passes), then move a target unit OUT of
        // the destination ATA so its balance drops below the entry snapshot.
        MODE_TARGET_DECREASE => {
            transfer_wsol_to_attacker(accounts, amount)?;
            withdraw_target_unit(accounts)
        }
        // Fully consume WSOL and deposit one target unit (so the swap looks
        // valid and slippage passes), but leave the PDA-owned intermediate
        // route account holding a balance.
        MODE_INTERMEDIATE_KEEP => {
            transfer_wsol_to_attacker(accounts, amount)?;
            transfer_one_target_unit(accounts)
        }
        // As above, then SetAuthority the intermediate away from the PDA
        // mid-route -- the attack the BEFORE snapshot exists to catch, since a
        // naive after-only "is this ours?" sweep would skip it.
        MODE_INTERMEDIATE_REASSIGN => {
            transfer_wsol_to_attacker(accounts, amount)?;
            transfer_one_target_unit(accounts)?;
            reassign_target_source(accounts)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The economically valid-looking part of the route: consume the authorized
/// WSOL and deposit exactly one target unit into the destination ATA.
fn pass_swap(accounts: &[AccountView], amount: u64) -> ProgramResult {
    transfer_wsol_to_attacker(accounts, amount)?;
    transfer_one_target_unit(accounts)
}

fn amount_from_route(data: &[u8]) -> Result<u64, ProgramError> {
    let bytes = data
        .get(8..16)
        .ok_or(ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
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
        &InstructionView {
            program_id: &SPL_TOKEN_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
        &[
            &accounts[WSOL_SOURCE],
            &accounts[WSOL_RECIPIENT],
            &accounts[PDA],
        ],
    )
}

/// Move one target unit from the PDA-owned intermediate into the destination
/// ATA -- the deposit that makes the swap look economically real.
fn transfer_one_target_unit(accounts: &[AccountView]) -> ProgramResult {
    transfer_target_unit(accounts, TARGET_SOURCE, TARGET_DESTINATION)
}

/// Move one target unit OUT of the destination ATA, back into the PDA-owned
/// intermediate, decreasing the balance the burner snapshotted on entry.
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
        &InstructionView {
            program_id: &SPL_TOKEN_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
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
        &InstructionView {
            program_id: &SYSTEM_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
        &[&accounts[PDA], &accounts[ATTACKER]],
    )
}

fn assign_pda(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 36];
    data[..4].copy_from_slice(&1u32.to_le_bytes()); // System `Assign`
    data[4..].copy_from_slice(accounts[ATTACKER].address().as_ref());
    let metas = [InstructionAccount::writable_signer(accounts[PDA].address())];
    invoke(
        &InstructionView {
            program_id: &SYSTEM_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
        &[&accounts[PDA]],
    )
}

fn allocate_pda(accounts: &[AccountView]) -> ProgramResult {
    let mut data = [0u8; 12];
    data[..4].copy_from_slice(&8u32.to_le_bytes()); // System `Allocate`
    data[4..].copy_from_slice(&8u64.to_le_bytes());
    let metas = [InstructionAccount::writable_signer(accounts[PDA].address())];
    invoke(
        &InstructionView {
            program_id: &SYSTEM_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
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
        &InstructionView {
            program_id: &SPL_TOKEN_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
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
        &InstructionView {
            program_id: &SPL_TOKEN_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
        &[&accounts[TARGET_DESTINATION], &accounts[PDA]],
    )
}

/// Reassign the PDA-owned intermediate's owner to the attacker mid-route. The
/// account is signed away precisely so an after-only sweep would no longer
/// recognise it as the vault's; the burner's entry snapshot must still flag it.
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
        &InstructionView {
            program_id: &SPL_TOKEN_PROGRAM_ID,
            data: &data,
            accounts: &metas,
        },
        &[&accounts[TARGET_SOURCE], &accounts[PDA]],
    )
}
