//! A benign stand-in for the Pump.fun bonding-curve program, compiled only for
//! the directcurve Mollusk regression.
//!
//! The real burner hands this program the burn PDA's signature and CPIs a 25-
//! byte `buy_exact_sol_in`. An honest Pump would debit `max_sol_cost` native
//! lamports from the PDA and credit tokens to the vault ATA. This stub does
//! NEITHER: it returns Ok immediately. Because it moved nothing, the burner's
//! exact lamport-delta postcondition (`expected = before - amount_in`) fails
//! with 6019 `BurnPdaLamportMismatch`. That is the deliberate, deterministic
//! "the burner validated everything and returned from the buy CPI" sentinel.
//!
//! It is intentionally inert: it never reads or writes any account, so it can
//! never mask a burner defect by coincidentally satisfying a postcondition.
//! The one thing the harness cares about -- the exact bytes the burner
//! emitted -- is read from Mollusk's inner-instruction trace, not from
//! anything this program does.

#![cfg_attr(not(test), no_std)]

use pinocchio::{AccountView, Address, ProgramResult};

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

fn process_instruction(
    _program_id: &Address,
    _accounts: &mut [AccountView],
    _data: &[u8],
) -> ProgramResult {
    Ok(())
}
