//! Read-only pre-funding validation of a split vault configuration.
//!
//! # Why this exists
//!
//! The vault is a stateless PDA whose configuration IS its address: there is
//! no init instruction, no config account, and — deliberately — no withdrawal
//! instruction. Every admission rule (freezable target 6036, mintable target
//! 6037, the Token-2022 extension allow-list 6024, the split's weight /
//! duplicate / leg-count rules 6032..6034) therefore runs at BURN time, which
//! is AFTER the vault has been funded. Anyone can derive an address from a
//! doomed configuration and point SOL at it — worst of all a Pump.fun
//! creator-fee share, which cannot be re-pointed once the launch is live —
//! and that SOL is then stranded permanently.
//!
//! A client-side validator can drift from the on-chain rules. This
//! instruction cannot: it calls the burn's own admission functions —
//! `validate_launch_mint`, `build_split_seeds` (duplicate rejection),
//! `derive_and_pin_split_vault`, `validate_split_target_admission` (which is
//! `validate_target_mint` + `validate_target_account` + the ATA address pin),
//! and the split weight rules — so a configuration it accepts is, by
//! construction, one the burn's own code accepts, and it fails with the same
//! error code a real burn would first produce.
//!
//! # Why it is strictly read-only, and provably so
//!
//! The program's custody argument rests on the burn PDA signing exactly four
//! things (System `Transfer`, `SyncNative`, the Jupiter route, `BurnChecked`)
//! and on every CPI being one of those. This module adds ZERO to that
//! surface: it contains no `invoke`, no `invoke_signed`, no `Signer`, no
//! seed-signing, no lamport access, and no `try_borrow_mut` — only address
//! derivation, address/owner comparisons, and byte reads through the same
//! validated readers the burn uses. It requires no signer at all: validation
//! is permissionless because it can affect nothing.
//!
//! Every account may be passed READ-ONLY. The burn demands write locks on the
//! target mints and ATAs because it goes on to write them; validation never
//! writes, so forcing clients to take write locks on mints as contended as
//! JTO would be pure harm. `build_split_seeds` is called with
//! `require_writable = false` for exactly this reason.
//!
//! # The ATAs may not exist yet — by design
//!
//! The intended launcher flow is ONE atomic transaction:
//!
//! ```text
//! [validate_config][create ATAs (idempotent)][SystemProgram::transfer]
//! ```
//!
//! If validation fails, the ATAs are never created and the SOL never moves —
//! the launcher cannot fund a doomed vault, and pays nothing but the fee to
//! find out. That ordering is only possible if this instruction ADMITS a
//! still-uncreated ATA: instructions run in order, so at validation time the
//! create-ATA instructions have not executed. An ATA address is a pure
//! function of (vault, mint, token program), so admitting a bare System
//! account at the exactly-derived address commits the transaction to creating
//! precisely the account that was admitted; requiring existence would force
//! `[create][validate][fund]`, which creates the (unreclaimable, ~0.002 SOL
//! each) ATAs even when validation then fails. Existence is therefore
//! REPORTED, not required: the pending-creation bitmap is logged (see
//! `log_validation`), and an ATA that DOES exist is fully re-validated with
//! the burn's own checks — a frozen (6014) or encumbered (6035) existing ATA
//! is a doomed vault and fails here exactly as a burn would fail.
//!
//! # What validation cannot see
//!
//! Route existence and liquidity are Jupiter-side, off-chain facts; a valid
//! configuration can still be unburnable until Jupiter indexes the target
//! (`TOKEN_NOT_TRADABLE`), and admission facts can change AFTER validation
//! (an authority newly abused, a hook activated). Validation is a point-in-
//! time proof of the on-chain admission rules — it replaces the "derive and
//! hope" failure mode, not the mandated small test burn.
//!
//! # Scope
//!
//! This validates split-vault configurations, `("burner", launch, targets..,
//! bps_blob)`, for 1..=`MAX_SPLIT_TARGETS` legs. A launcher who wants a
//! single target with validated setup should use a 1-leg split vault (weight
//! 10000), which `swap_and_burn_split` serves with identical semantics; the
//! legacy single-target derivation `("burner", launch, target)` predates this
//! instruction and remains client-derived.
//!
//! # Account order
//!
//! ```text
//!  0 burn_pda      — the vault address the caller intends to fund
//!  1 wsol_ata      — ATA(vault, WSOL, legacy SPL token)
//!  2 launch_mint
//!  3.. per target, in leg order: target_mint,
//!                                target_token_account,
//!                                target_token_program
//! ```
//!
//! All read-only; no signers. Accounts beyond the target block are ignored:
//! they are inert here (nothing is granted, nothing beyond the block is
//! read), and refusing them would either misuse an unrelated error code or
//! spend a new one on a non-risk.
//!
//! Instruction data after the discriminator is Borsh `weights: Vec<u16>`:
//! `u32` leg count, then one little-endian `u16` bps per leg, in leg order —
//! the same weights, in the same order and endianness, that the vault's
//! `bps_blob` seed commits to.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::{
    constants::{MAX_SPLIT_TARGETS, WSOL_MINT},
    error::{err, BurnerError},
    split::{
        build_split_seeds, derive_and_pin_split_vault, pack_bps_blob,
        validate_split_leg_count, validate_split_leg_weight, validate_split_target_admission,
        validate_split_weight_sum, ACCOUNTS_PER_TARGET, MAX_SEEDS,
    },
    swap_and_burn::{is_bare_system_account, read_u32},
    token::{validate_launch_mint, validate_wsol_account},
};

const FIXED_ACCOUNTS: usize = 3;
/// Borsh `Vec<u16>` length prefix.
const ARGS_PREFIX_LEN: usize = 4;

// KEYLESS: the vault address additionally commits to one reference per
// leg, so validation must bind and content-check the reference set —
// otherwise a creator could commit their ONE-SHOT Pump fee share to a
// vault whose references can never price a burn. A leading mode byte is
// REQUIRED:
//
//   * Mode A (0x00) — the only remaining path. Full pre-funding probe.
//     Accounts `3 + 7*legs` (the burn's own keyless leg blocks); data
//     `mode + u32 leg_count + [u16 bps]*n + [u64 probe_amount_in]*n`.
//     Runs the unbound admission checks PLUS the bound derivation PLUS
//     the burn's own `keyless_leg_floor` per leg at the caller's intended
//     chunk size, so a reference that cannot price a burn fails here,
//     before anything is funded, with the exact code a burn would produce
//     (6039 / 6040 / 6002). A zero probe proves nothing and is refused
//     (6000).
//   * Mode B (0x01) — DELETED. Refused at dispatch as
//     `InvalidInstructionData`. It took references as raw DATA, could not
//     see the pools, and green-lit a sentinel over a non-Pump target
//     (RT8). A check that can approve the wrong vault next to an
//     irreversible Pump fee share is worse than no check. Do not
//     reintroduce a slim variant.
//
// Mode A remains strictly read-only and signerless: `keyless_leg_floor`
// and everything it calls only `try_borrow`-reads, derives addresses, and
// does arithmetic — no `invoke`, no `invoke_signed`, no `Seed`/`Signer`,
// no lamport or data mutation.
pub fn handler(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if data.is_empty() {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    match data[0] {
        0x00 => bound_mode_a(program_id, accounts, &data[1..]),
        // RT8 / OWNER DECISION 2026-08-28: Mode B (0x01) is DELETED and its
        // selector permanently refused. It took references as raw DATA rather
        // than accounts, so it could not see the pools at all -- it re-derived
        // an address and trusted that Mode A had already content-checked the
        // same one. That trust was never enforced: Mode B green-lit a sentinel
        // reference over a non-Pump target, and the resulting vault can never
        // burn (6012). Because the Pump fee share is ONE-SHOT and irreversible,
        // a check that can approve the wrong vault is worse than no check.
        //
        // The wire pressure Mode B existed to relieve is solved on the CLIENT,
        // not with a second encoding: the ATAs were the wire cost, not Mode A.
        // Tx 1 = Mode A + create ATAs; Tx 2 = fee share + Mode A again (no
        // ATAs). Same instruction, one that actually reads the pools.
        //
        // Do NOT reintroduce a slim variant, and in particular do NOT retry
        // "sentinel only if the target is a Pump venue" -- that was attempted,
        // broke the honest `[v4, pump_curve]` shape, and still missed RT8.
        _ => Err(err(BurnerError::InvalidInstructionData)),
    }
}

/// Shared decode of `u32 leg_count + [u16 bps]*n` with an exact-length rule
/// covering a fixed per-leg tail (`8` for Mode A's probes), mirroring the
/// split's no-trailing-bytes rule.
fn decode_bound_weights(
    data: &[u8],
    per_leg_tail: usize,
) -> Result<(usize, [u16; MAX_SPLIT_TARGETS]), pinocchio::error::ProgramError> {
    if data.len() < ARGS_PREFIX_LEN {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    let leg_count = read_u32(&data[0..ARGS_PREFIX_LEN])? as usize;
    validate_split_leg_count(leg_count)?;
    if data.len() != ARGS_PREFIX_LEN + (2 + per_leg_tail) * leg_count {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    let mut weights = [0u16; MAX_SPLIT_TARGETS];
    let mut bps_sum: u32 = 0;
    for (i, weight) in weights[..leg_count].iter_mut().enumerate() {
        let offset = ARGS_PREFIX_LEN + 2 * i;
        *weight = u16::from_le_bytes([data[offset], data[offset + 1]]);
        validate_split_leg_weight(*weight)?;
        bps_sum += *weight as u32;
    }
    validate_split_weight_sum(bps_sum)?;
    Ok((leg_count, weights))
}

/// Mode A: everything the unbound validator proved, plus the bound
/// derivation, plus one `keyless_leg_floor` probe per leg.
fn bound_mode_a(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    use crate::split::RefSource;
    use crate::swap_and_burn::{keyless_leg_floor, read_u64};

    let (leg_count, weights) = decode_bound_weights(data, 8)?;
    let probes_at = ARGS_PREFIX_LEN + 2 * leg_count;
    let target_block_len = ACCOUNTS_PER_TARGET * leg_count;
    if accounts.len() < FIXED_ACCOUNTS + target_block_len {
        return Err(err(BurnerError::NotEnoughAccountKeys));
    }
    let burn_pda = &accounts[0];
    let wsol_ata = &accounts[1];
    let launch_mint = &accounts[2];
    let targets = &accounts[FIXED_ACCOUNTS..FIXED_ACCOUNTS + target_block_len];

    validate_launch_mint(launch_mint)?;

    let mut bps_blob = [0u8; 2 * MAX_SPLIT_TARGETS];
    pack_bps_blob(&weights[..leg_count], &mut bps_blob);
    let mut seed_refs: [&[u8]; MAX_SEEDS] = [&[]; MAX_SEEDS];
    let seed_count = build_split_seeds(
        launch_mint,
        targets,
        leg_count,
        &bps_blob,
        false,
        RefSource::FromAccounts,
        &mut seed_refs,
    )?;
    let (pda, bump) =
        derive_and_pin_split_vault(program_id, &seed_refs[..seed_count], burn_pda, wsol_ata)?;

    let wsol_pending = is_bare_system_account(wsol_ata);
    if !wsol_pending {
        validate_wsol_account(wsol_ata, &WSOL_MINT, &pda)?;
    }

    let mut pending_atas: u64 = wsol_pending as u64;
    for i in 0..leg_count {
        let base = ACCOUNTS_PER_TARGET * i;
        let (_validated, ata_pending) = validate_split_target_admission(
            &targets[base],
            &targets[base + 1],
            &targets[base + 2],
            &pda,
            launch_mint.address(),
            bump,
            true,
        )?;
        if ata_pending {
            pending_atas |= 1 << (i + 1);
        }
        // The burn's OWN floor, at the creator's intended per-burn chunk
        // size. A zero probe would floor `input_after_fee` to 0 and trip the
        // zero-floor guard spuriously — it proves nothing, so it is refused
        // outright. A nonzero floor is guaranteed by `keyless_leg_floor`
        // itself (zero floors are 6002 inside it).
        let probe = read_u64(&data[probes_at + 8 * i..probes_at + 8 * i + 8])?;
        if probe == 0 {
            return Err(err(BurnerError::ZeroInput));
        }
        let _floor = keyless_leg_floor(
            &targets[base],
            &targets[base + 3],
            &targets[base + 4],
            &targets[base + 5],
            &targets[base + 6],
            probe,
        )?;
    }

    log_validation(leg_count as u64, pending_atas);
    Ok(())
}

/// The "report, don't require" half of the ATA-existence decision: bit 0 is
/// the WSOL ATA, bit `i + 1` is leg `i`'s target ATA, set when the account
/// still awaits creation. Logged as `Program log: 0x1c625c52, 0x0, 0x0,
/// <legs>, <pending bitmap>` — the tag is the first four discriminator bytes,
/// so the line cannot be confused with `log_burn`'s `0x0`-tagged output.
#[inline(always)]
fn log_validation(leg_count: u64, pending_atas: u64) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    unsafe {
        pinocchio::syscalls::sol_log_64_(0x1c625c52, 0, 0, leg_count, pending_atas)
    };
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (leg_count, pending_atas);
    }
}

// ---------------------------------------------------------------------------
// Host-side tests.
//
// Every fixture account is deliberately built READ-ONLY (`is_writable: 0`), so
// each passing test doubles as proof that the handler demands no write lock
// anywhere — the property the burn path cannot share, and the reason
// `build_split_seeds` takes `require_writable`.
// ---------------------------------------------------------------------------
