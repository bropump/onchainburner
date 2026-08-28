//! THE PRODUCTION SOLANA PROGRAM.
//!
//! Per `CLAUDE.md`, Pinocchio is the production framework and this crate is
//! what gets deployed. Program id `5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV`.
//!
//! Error codes 6000..=6043 are defined in `error.rs` and are client-visible and
//! append-only. There is no canonical IDL: clients encode instructions from the
//! layouts documented in `split.rs` and `swap_and_burn.rs`.
//!
//! Two SERVED instructions, sharing one set of validated helpers:
//!   * `swap_and_burn_split` — one vault, up to `MAX_SPLIT_TARGETS` weighted
//!                             targets, all swapped and burned atomically. A
//!                             single target is a 1-leg split.
//!   * `validate_config`     — read-only pre-funding admission check of a
//!                             split configuration, running the burn's own
//!                             validation code so a launcher cannot strand
//!                             SOL on a vault that can never burn.
//!
//! Instruction discriminators and account order are stable client interfaces.

// `no_std` for the SBF build; the host test harness needs `std`.
#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod constants;
pub mod directcurve;
pub mod error;
pub mod split;
pub mod swap_and_burn;
pub mod token;
pub mod validate_config;

use pinocchio::{
    default_allocator, default_panic_handler, program_entrypoint, AccountView, Address,
    ProgramResult,
};

use crate::{
    constants::{
        SWAP_AND_BURN_DISCRIMINATOR, SWAP_AND_BURN_SPLIT_DISCRIMINATOR,
        VALIDATE_CONFIG_DISCRIMINATOR,
    },
    error::{err, BurnerError},
};

program_entrypoint!(process_instruction);
default_allocator!();
// `default_panic_handler!` rather than `nostd_panic_handler!`: `spl-token-2022`
// pulls in `std`, which already defines the `panic_impl` lang item.
default_panic_handler!();

fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    let (discriminator, args) = instruction_data.split_at(8);
    match discriminator {
        // KEYLESS: the legacy single-target derivation `["burner", launch,
        // target]` carries no reference seed, so serving this instruction
        // would bypass reference binding entirely. It is refused at dispatch;
        // single targets are served as 1-leg split vaults, whose derivation
        // commits to the reference. The handler it once dispatched to has been
        // deleted; the discriminator stays refused so an old client that still
        // encodes it gets a named error rather than a fallthrough.
        d if d == SWAP_AND_BURN_DISCRIMINATOR => Err(err(BurnerError::InvalidInstructionData)),
        d if d == SWAP_AND_BURN_SPLIT_DISCRIMINATOR => split::handler(program_id, accounts, args),
        d if d == VALIDATE_CONFIG_DISCRIMINATOR => {
            validate_config::handler(program_id, accounts, args)
        }
        _ => Err(err(BurnerError::InvalidInstructionData)),
    }
}
