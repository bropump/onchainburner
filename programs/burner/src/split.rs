//! Multi-target split burn: one vault, one call, N atomic swap-and-burns.
//!
//! # The split lives in the PDA address, not in state
//!
//! The single-target vault derives from `("burner", launch_mint,
//! target_mint)`, so a funded address has exactly one launch-to-target
//! meaning. A split vault extends the same idea to a whole weighted
//! configuration:
//!
//! ```text
//! ("burner", launch_mint, target_0, target_1, .., target_{n-1}, bps_blob)
//! ```
//!
//! where `bps_blob` is the little-endian `u16` weights, in leg order, packed
//! back to back (`2n` bytes). There is no config account, no initialise
//! instruction, and therefore no update instruction and no rent: the
//! configuration *is* the address. Change any mint, any weight, or the number
//! of legs and `find_program_address` lands somewhere else, so the Pump fee
//! share that funds this vault is pointing at a different program-derived
//! account. A funded split PDA is immutable by construction.
//!
//! Cross-`n` collisions are impossible even though Solana concatenates seeds
//! without length delimiters: the pre-image length is `6 + 32 + 34n`, which is
//! injective in `n`, and within one `n` the byte string determines the mints
//! and the weights uniquely.
//!
//! KEYLESS: the derivation additionally commits to one 32-byte REFERENCE
//! seed per leg after the bps_blob (`.., bps_blob, ref_0..ref_{n-1}`), so
//! the price-floor reference the creator reviewed at setup is the only one a
//! burn can ever nominate. Pump-venue references bind as a `[0u8; 32]`
//! sentinel (their identity is derived in-program, which is what survives
//! the curve -> PumpSwap migration at graduation); every other reference
//! binds by address. Pre-image length becomes `6 + 32 + 66n`, still
//! injective in `n`. See `build_split_seeds` and `RefSource`.
//!
//! # The program divides the SOL, the caller does not
//!
//! The caller supplies one `total_amount_in`. Each leg's input is derived on
//! chain as `total * bps_i / 10_000`, with the final leg absorbing the
//! integer-division remainder so the legs sum to `total_amount_in` exactly.
//! A caller cannot route 99% into a leg the configuration weighted at 1%.
//!
//! # Account order
//!
//! ```text
//!  0 caller                (signer, fee payer)
//!  1 (unused)              -- RESERVED, NOT CHECKED. This slot held the KMS
//!                            quote authority and was a pinned signer. Keyless
//!                            deleted both checks, so ANY account may sit here
//!                            and it is neither read nor required to sign. The
//!                            slot is kept so the account layout and every
//!                            downstream index are unchanged. Do not document
//!                            it as pinned, and do not start trusting it.
//!  2 burn_pda              (mut)
//!  3 wsol_source           (mut)
//!  4 launch_mint
//!  5 system_program
//!  6 spl_token_program
//!  7 jupiter_program
//!  8.. per target, in leg order: target_mint (mut),
//!                                target_token_account (mut),
//!                                target_token_program
//!  ..  Jupiter route accounts, leg 0 first, `route_account_count` each
//! ```

use alloc::vec::Vec;
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};

use crate::{
    constants::{
        BPS_TOTAL, BURNER_SEED, JUPITER_PROGRAM_ID, MAX_SPLIT_TARGETS,
        SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, WSOL_MINT,
    },
    error::{err, BurnerError},
    swap_and_burn::{
        associated_token_address, burn_target, fund_wsol, invoke_jupiter_route,
        is_bare_system_account, log_burn, read_u32, read_u64, rent_minimum_balance_zero_data,
        snapshot_pda_token_accounts, snapshot_pump_lamport_credits, sum_pump_lamport_credits,
        validate_burn_remainder, validate_jupiter_route, verify_no_intermediate_balances,
        verify_pda_still_a_bare_system_account, verify_pump_lamport_credits,
        verify_swap_postconditions, verify_wsol_account_still_ours, BurnerAccounts,
        ValidatedBurner,
    },
    token::{
        validate_launch_mint, validate_target_account, validate_target_mint, validate_wsol_account,
    },
};
// DIRECTCURVE: the curve-leg accumulator verifier (untouched, credit 0). Only
// the mixed keyless+directcurve build reaches a curve leg inside the split.
use crate::swap_and_burn::verify_pump_credits_untouched;

const FIXED_ACCOUNTS: usize = 8;
/// KEYLESS: each leg carries its reference pool — shape-authenticated by
/// `keyless_leg_floor` AND bound into the vault address by
/// `build_split_seeds` (a Pump-venue reference binds as the zero sentinel,
/// every other venue by its exact address) — both pool vaults, and one
/// explicit authenticated fee-source account.  The fee source is deliberately
/// outside the Jupiter route slice, so it cannot be substituted by route
/// data.
pub(crate) const ACCOUNTS_PER_TARGET: usize = 7;
/// `total_amount_in: u64` + Borsh `Vec<SplitLeg>` length prefix.
const ARGS_PREFIX_LEN: usize = 8 + 4;
/// `bps: u16` + `minimum_output: u64` + `route_account_count: u8` + Borsh
/// `Vec<u8>` length prefix, i.e. one `SplitLeg` up to its route bytes.
const LEG_HEADER_LEN: usize = 2 + 8 + 1 + 4;
/// Seeds before the per-target mints: `"burner"` and the launch mint.
pub(crate) const SEED_PREFIX: usize = 2;
/// Seeds after them: the packed weights. (The bump is appended separately, and
/// only for signing.)
pub(crate) const SEED_SUFFIX: usize = 1;
/// KEYLESS: one 32-byte reference seed per leg follows the bps_blob, so the
/// vault address commits to the reviewed reference set as well. 4 legs is 11
/// seeds + bump = 12, inside Solana's 16-seed limit.
pub(crate) const MAX_SEEDS: usize = SEED_PREFIX + 2 * MAX_SPLIT_TARGETS + SEED_SUFFIX;

/// KEYLESS: the sentinel seed for a Pump-ecosystem reference. The flagship
/// own-launch leg's reference MIGRATES at graduation (bonding curve ->
/// canonical PumpSwap pool, different addresses), so a literal Pump-venue
/// address in the seeds would brick the vault at the exact moment its token
/// succeeds. Both Pump-venue identities are already enforced by DERIVATION
/// inside `keyless_leg_floor` (the curve must be `PDA(["bonding-curve",
/// mint])`; the PumpSwap pool's stored `creator` must be
/// `PDA(["pool-authority", mint])`), so the sentinel gives up nothing: no
/// account can impersonate it, because reaching the sentinel requires
/// `owner ∈ {Pump.fun, PumpSwap}` and those branches then pin the exact
/// derived address for this leg's mint.
pub(crate) static ZERO_REF: [u8; 32] = [0u8; 32];

/// KEYLESS: where `build_split_seeds` reads each leg's reference from.
///
/// The burn and `validate_config` Mode A carry the full 7-account leg block
/// (`FromAccounts`: reference at `+3`, sentinel decided by its owner);
/// `validate_config` Mode B carries only the per-leg mint account and the
/// reference addresses as 32 bytes/leg of instruction data (`FromData`,
/// sentinel legs pass `[0u8; 32]` literally). Both paths run THIS one seed
/// builder, so the derivation cannot drift between the burn and the
/// validator.
#[derive(Clone, Copy)]
pub(crate) enum RefSource<'a> {
    /// Leg stride `ACCOUNTS_PER_TARGET` (7); reference account at `+3`.
    FromAccounts,
    /// Leg stride 1 (mint only); exactly `32 * leg_count` bytes.
    FromData(&'a [u8]),
}

#[derive(Clone, Copy)]
struct LegSpec {
    bps: u16,
    minimum_output: u64,
    route_accounts: usize,
    data_start: usize,
    data_end: usize,
    amount_in: u64,
}

const EMPTY_LEG: LegSpec = LegSpec {
    bps: 0,
    minimum_output: 0,
    route_accounts: 0,
    data_start: 0,
    data_end: 0,
    amount_in: 0,
};

pub fn handler(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    // ---- argument decode ---------------------------------------------------
    if data.len() < ARGS_PREFIX_LEN {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    let total_amount_in = read_u64(&data[0..8])?;
    let leg_count = read_u32(&data[8..12])? as usize;
    validate_split_leg_count(leg_count)?;
    let target_block_len = ACCOUNTS_PER_TARGET
        .checked_mul(leg_count)
        .ok_or(err(BurnerError::InvalidSplitTargetCount))?;
    if accounts.len() < FIXED_ACCOUNTS + target_block_len {
        return Err(err(BurnerError::NotEnoughAccountKeys));
    }

    let mut legs = [EMPTY_LEG; MAX_SPLIT_TARGETS];
    let mut cursor = ARGS_PREFIX_LEN;
    let mut bps_sum: u32 = 0;
    for leg in legs[..leg_count].iter_mut() {
        let header_end = cursor
            .checked_add(LEG_HEADER_LEN)
            .filter(|end| *end <= data.len())
            .ok_or(err(BurnerError::InvalidInstructionData))?;
        leg.bps = u16::from_le_bytes([data[cursor], data[cursor + 1]]);
        leg.minimum_output = read_u64(&data[cursor + 2..cursor + 10])?;
        leg.route_accounts = data[cursor + 10] as usize;
        let route_data_len = read_u32(&data[cursor + 11..header_end])? as usize;
        leg.data_start = header_end;
        leg.data_end = header_end
            .checked_add(route_data_len)
            .filter(|end| *end <= data.len())
            .ok_or(err(BurnerError::InvalidInstructionData))?;
        cursor = leg.data_end;

        validate_split_leg_weight(leg.bps)?;
        // In the KMS build the caller's minimum IS the bound, so zero is
        // meaningless and refused at parse. KEYLESS: no parse-time zero
        // refusal — identical to the single-target path, a zero minimum is
        // simply a minimum below the program's own floor and is refused there
        // (6021, `SlippageExceeded`); the floor itself is guaranteed nonzero
        // because a zero floor is refused (6002) inside `keyless_leg_floor`.
        bps_sum += leg.bps as u32;
    }
    // No trailing bytes: every byte of the instruction data is accounted for.
    if cursor != data.len() {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    validate_split_weight_sum(bps_sum)?;

    // ---- fixed accounts ----------------------------------------------------
    let caller = &accounts[0];
    let _quote_authority = &accounts[1];
    let burn_pda = &accounts[2];
    let wsol_source = &accounts[3];
    let launch_mint = &accounts[4];
    let system_program = &accounts[5];
    let spl_token_program = &accounts[6];
    let jupiter_program = &accounts[7];
    let targets = &accounts[FIXED_ACCOUNTS..FIXED_ACCOUNTS + target_block_len];
    let route_pool = &accounts[FIXED_ACCOUNTS + target_block_len..];

    if !caller.is_signer() {
        return Err(err(BurnerError::MissingRequiredSignature));
    }
    if !burn_pda.is_writable() || !wsol_source.is_writable() {
        return Err(err(BurnerError::AccountNotMutable));
    }
    if system_program.address() != &SYSTEM_PROGRAM_ID || !system_program.executable() {
        return Err(err(BurnerError::InvalidSystemProgram));
    }
    if total_amount_in == 0 {
        return Err(err(BurnerError::ZeroInput));
    }
    if jupiter_program.address() != &JUPITER_PROGRAM_ID || !jupiter_program.executable() {
        return Err(err(BurnerError::InvalidJupiterProgram));
    }
    if spl_token_program.address() != &SPL_TOKEN_PROGRAM_ID || !spl_token_program.executable() {
        return Err(err(BurnerError::InvalidTokenProgram));
    }

    validate_launch_mint(launch_mint)?;

    // ---- rebuild the committed configuration and derive its vault ----------
    let mut weights = [0u16; MAX_SPLIT_TARGETS];
    for (i, leg) in legs[..leg_count].iter().enumerate() {
        weights[i] = leg.bps;
    }
    let mut bps_blob = [0u8; 2 * MAX_SPLIT_TARGETS];
    pack_bps_blob(&weights[..leg_count], &mut bps_blob);

    let mut seed_refs: [&[u8]; MAX_SEEDS] = [&[]; MAX_SEEDS];
    // Execution writes every leg's mint (the burn) and ATA (the swap), so the
    // burn path demands those write locks up front.
    // KEYLESS: the reference accounts already in each leg's block become seed
    // material, so the vault address commits to the reviewed reference set.
    // Zero extra bytes and zero extra locks on the burn transaction.
    let seed_count = build_split_seeds(
        launch_mint,
        targets,
        leg_count,
        &bps_blob,
        true,
        RefSource::FromAccounts,
        &mut seed_refs,
    )?;
    let (pda, bump) =
        derive_and_pin_split_vault(program_id, &seed_refs[..seed_count], burn_pda, wsol_source)?;
    validate_wsol_account(wsol_source, &WSOL_MINT, &pda)?;

    // ---- divide the input --------------------------------------------------
    let mut allocated: u64 = 0;
    for (i, leg) in legs[..leg_count].iter_mut().enumerate() {
        leg.amount_in = if i + 1 == leg_count {
            // The final leg absorbs the rounding remainder: the legs must sum
            // to `total_amount_in` exactly or the lamport postcondition below
            // cannot hold.
            total_amount_in
                .checked_sub(allocated)
                .ok_or(err(BurnerError::InvalidSplitWeights))?
        } else {
            // `total * bps / 10_000` without 128-bit arithmetic, which would
            // link libcompiler-rt's `__udivti3` into the deployed binary for
            // one division. Writing `total = q*B + r` gives the identical
            // floor, `q*bps + floor(r*bps/B)`, and neither term can overflow:
            // the first is bounded by `total` because `bps <= B`, and the
            // second by `(B-1) * B`.
            let quotient = total_amount_in / BPS_TOTAL as u64;
            let remainder = total_amount_in % BPS_TOTAL as u64;
            quotient * leg.bps as u64 + (remainder * leg.bps as u64) / BPS_TOTAL as u64
        };
        // Dust: a weight this small against this total rounds to nothing.
        if leg.amount_in == 0 {
            return Err(err(BurnerError::ZeroInput));
        }
        allocated = allocated
            .checked_add(leg.amount_in)
            .ok_or(err(BurnerError::InvalidSplitWeights))?;
    }

    // KEYLESS: every leg's floor is computed and checked BEFORE any CPI runs,
    // so a doomed later leg cannot cost an earlier leg's executed-and-reverted
    // route, and no floor is ever priced off a reference a previous leg's CPI
    // already moved. The reference at `targets[base + 3]` is the one the vault
    // address COMMITS to: `build_split_seeds` above fed it (or the Pump
    // sentinel) into the derivation, so a caller nominating any other pool
    // lands on a different, unfunded vault (6012) before reaching this loop.
    // Single-target burns are served as 1-leg splits under this feature (the
    // legacy unbound derivation is refused at dispatch), so this is the only
    // floor path and it cannot drift.
    //
    // The program's floor is authoritative: a caller may request a STRICTER
    // bound, never a looser one; a minimum below the floor (zero included) is
    // REFUSED (6021), not raised. A zero floor is refused (6002) inside
    // `keyless_leg_floor` itself, so an admitted minimum is always nonzero.
    for (i, leg) in legs[..leg_count].iter().enumerate() {
        let base = ACCOUNTS_PER_TARGET * i;
        let floor = crate::swap_and_burn::keyless_leg_floor(
            &targets[base],
            &targets[base + 3],
            &targets[base + 4],
            &targets[base + 5],
            &targets[base + 6],
            leg.amount_in,
        )?;
        if leg.minimum_output < floor {
            return Err(err(BurnerError::SlippageExceeded));
        }
    }

    let pda_lamports_start = burn_pda.lamports();
    if pda_lamports_start < total_amount_in {
        return Err(err(BurnerError::InsufficientBurnerBalance));
    }
    // Reject an unaccounted route-pool suffix before using any route account
    // as a potential Pump rent credit. This is the same invariant checked by
    // the cursor below, made early so only accounts committed to one of the
    // leg slices can affect the deterministic rent-floor calculation.
    let expected_route_accounts = legs[..leg_count].iter().try_fold(0usize, |total, leg| {
        total
            .checked_add(leg.route_accounts)
            .ok_or(err(BurnerError::InvalidJupiterAccounts))
    })?;
    if expected_route_accounts != route_pool.len() {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    // Count each exact Pump/PumpSwap accumulator only once across all route
    // slices. Every admitted account has already passed the exact PDA, owner,
    // discriminator, stored-user, writable and nonzero-lamport checks; after
    // all legs it must also be fully closed.
    let initial_pump_credits = snapshot_pump_lamport_credits(route_pool, &pda)?;
    // DIRECTCURVE: the two Pump venues have OPPOSITE accumulator contracts, and
    // a mixed transaction runs both in one instruction. A Jupiter leg appends
    // `close_user_volume_accumulator` (the accumulator is CLOSED and its rent
    // refunded to the vault); a curve leg's direct `buy_exact_sol_in` CPI does
    // NOT close it (it must stay lamport-IDENTICAL, crediting zero). So the
    // whole-call reconciliation is split by leg mode: only Jupiter-leg
    // accumulators are expected to close and contribute credit, and each
    // curve-leg accumulator is separately proven untouched. Still an exact
    // equality, per-leg and whole-call — the curve contribution is a hard zero.
    let (curve_pump_credits, jupiter_pump_credits) = {
        // A whole-pool accumulator snapshot's pool-relative index falls inside
        // exactly one leg's route range; that leg's empty-route flag decides
        // the accumulator's contract. (A curve leg is selected by empty route
        // data, the same selector the single-target directcurve path uses.)
        let is_curve_index = |idx: usize| -> bool {
            let mut start = 0usize;
            for leg in legs[..leg_count].iter() {
                let end = start + leg.route_accounts;
                if idx >= start && idx < end {
                    return leg.data_end == leg.data_start;
                }
                start = end;
            }
            false
        };
        crate::swap_and_burn::partition_pump_credits(&initial_pump_credits, is_curve_index)
    };
    let known_pump_credit = sum_pump_lamport_credits(&jupiter_pump_credits)?;
    // Same early rent-floor guard as the single-target path, applied to the
    // whole call: a 0-data System account may not be left below the
    // rent-exempt minimum, and the runtime would otherwise only say so after
    // every swap and burn had already executed and logged.
    let pda_lamports_end = pda_lamports_start
        .checked_sub(total_amount_in)
        .ok_or(err(BurnerError::InsufficientBurnerBalance))?
        .checked_add(known_pump_credit)
        .ok_or(err(BurnerError::BurnPdaLamportMismatch))?;
    validate_burn_remainder(pda_lamports_end, rent_minimum_balance_zero_data()?)?;

    let bump_seed = [bump];
    let mut seeds: Vec<Seed> = Vec::with_capacity(seed_count + 1);
    for seed in &seed_refs[..seed_count] {
        seeds.push(Seed::from(*seed));
    }
    seeds.push(Seed::from(&bump_seed[..]));
    let signer = Signer::from(&seeds[..]);

    // Snapshot before ANY leg runs, so an intermediate cannot be signed away
    // mid-route and skipped by the end-of-call sweep. Amounts matter too: a
    // hostile earlier route must not be able to empty a later target ATA and
    // make that later leg mistake zero for its legitimate starting balance.
    let token_accounts_before = snapshot_pda_token_accounts(route_pool, &pda)?;

    // ---- one swap-and-burn per leg, in configuration order -----------------
    let mut route_cursor = 0usize;
    let mut total_validated_credit = 0u64;
    let mut burned_amounts = [0u64; MAX_SPLIT_TARGETS];
    for (i, leg) in legs[..leg_count].iter().enumerate() {
        let route_end = route_cursor
            .checked_add(leg.route_accounts)
            .filter(|end| *end <= route_pool.len())
            .ok_or(err(BurnerError::InvalidJupiterAccounts))?;
        let route = &route_pool[route_cursor..route_end];
        route_cursor = route_end;
        let route_data = &data[leg.data_start..leg.data_end];

        let base = ACCOUNTS_PER_TARGET * i;
        // KEYLESS: this leg's floor was already computed and its minimum
        // checked in the pre-CPI pass above, against the address-committed
        // reference in `targets[base + 3]`.
        let burner = BurnerAccounts {
            burn_pda,
            wsol_source,
            launch_mint,
            target_mint: &targets[base],
            target_token_account: &targets[base + 1],
            target_token_program: &targets[base + 2],
            spl_token_program,
        };
        let validated = validate_split_target(&burner, &pda, launch_mint.address(), bump)?;
        // DIRECTCURVE: a curve leg carries EMPTY route data — the same selector
        // the single-target directcurve path uses. It substitutes the Pump
        // bonding-curve buy for the Jupiter route: the buy is the ONE swap CPI,
        // never an additional signed CPI. A Jupiter leg signs System funding,
        // its swap, and BurnChecked; a curve leg skips funding and signs only
        // its swap and BurnChecked. SyncNative remains unsigned. The directcurve
        // adapter validates all 18 Pump accounts itself, so the Jupiter route
        // validation is skipped for it —
        // exactly as `swap_and_burn` does for the single-target case.
        let is_curve_leg = route_data.is_empty();
        if !is_curve_leg {
            validate_jupiter_route(
                route,
                route_data,
                leg.amount_in,
                &validated,
                wsol_source.address(),
                burner.target_token_account.address(),
            )?;
        }

        // Compare the balance validated NOW against the amount snapshotted
        // before ANY leg ran, so an earlier leg's route cannot empty a later
        // leg's ATA and have that leg mistake zero for its true starting
        // balance. A pre-existing donation is accepted unchanged and burned
        // with this leg's output; only a mutation by an earlier leg is refused
        // (6042). Placed AFTER `validate_jupiter_route` so the in_amount pin
        // (6008) still fires before any route-account refusal (6006) -- that
        // ordering is what makes the split-division oracle observable, and it
        // is load-bearing per CLAUDE.md. Still before every CPI, so nothing
        // has executed yet.
        crate::swap_and_burn::verify_target_pre_call_balance(
            route_pool,
            &token_accounts_before,
            burner.target_token_account.address(),
            validated.target_before,
        )?;

        // Per leg, not just per call: every postcondition the single-target
        // path enforces once is enforced on each leg here, so a failure in
        // leg 2 reverts legs 0 and 1 with a leg-accurate error.
        let leg_lamports_before = burn_pda.lamports();
        let pump_credits = snapshot_pump_lamport_credits(route, &pda)?;
        // DIRECTCURVE: the Pump curve consumes NATIVE SOL straight from the PDA
        // (the buy debits exactly `amount_in`), so funding WSOL on a curve leg
        // would double-debit `amount_in` and the exact conservation check would
        // correctly revert. The decision is PER LEG: the Jupiter legs of a
        // mixed burn still fund WSOL, and the shared WSOL account rests near
        // zero, so a curve leg leaving it untouched keeps its per-leg WSOL
        // conservation trivially (`after == before`).
        let wsol_before = if is_curve_leg {
            crate::token::read_token_amount(wsol_source)?
        } else {
            fund_wsol(&burner, &signer, leg.amount_in)?
        };
        if is_curve_leg {
            crate::directcurve::invoke_pump_curve_buy(
                route,
                &pda,
                &validated.target_mint,
                burner.target_token_account.address(),
                &validated.target_program,
                leg.amount_in,
                leg.minimum_output,
                &signer,
            )?;
        } else {
            invoke_jupiter_route(route, route_data, &pda, &signer)?;
        }
        // DIRECTCURVE: a curve leg's accumulator is NOT closed by the direct
        // buy, so it must be lamport-identical afterwards and credits zero; a
        // Jupiter leg's accumulator is closed and credits its snapshotted
        // lamports. Exact equality either way — no tolerance.
        let validated_credit = if is_curve_leg {
            verify_pump_credits_untouched(route, &pump_credits)?;
            0
        } else {
            verify_pump_lamport_credits(route, &pump_credits)?
        };
        total_validated_credit = total_validated_credit
            .checked_add(validated_credit)
            .ok_or(err(BurnerError::BurnPdaLamportMismatch))?;
        let target_after = verify_swap_postconditions(
            &burner,
            &validated,
            leg.amount_in,
            wsol_before,
            leg_lamports_before,
            validated_credit,
            leg.minimum_output,
        )?;
        burn_target(&burner, &validated, target_after, &signer)?;
        burned_amounts[i] = target_after;
        log_burn(leg.amount_in, target_after);
    }
    // Every account passed must belong to a leg's route; nothing rides along
    // unvalidated and unswept.
    if route_cursor != route_pool.len() {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }

    // ---- whole-call postconditions ----------------------------------------
    // DIRECTCURVE: re-assert the two accumulator contracts at the very end, so
    // a later leg cannot re-open an accumulator a Jupiter leg closed, nor move
    // a curve leg's accumulator after that leg proved it untouched. Only
    // Jupiter-leg accumulators are expected closed and contribute credit; each
    // curve-leg accumulator must be lamport-identical to its pre-call snapshot.
    {
        let final_whole_call_credit =
            verify_pump_lamport_credits(route_pool, &jupiter_pump_credits)?;
        verify_pump_credits_untouched(route_pool, &curve_pump_credits)?;
        if final_whole_call_credit != known_pump_credit
            || total_validated_credit != known_pump_credit
            || burn_pda.lamports() != pda_lamports_end
        {
            return Err(err(BurnerError::BurnPdaLamportMismatch));
        }
    }
    // One sweep across every leg's route accounts, after every burn. Reconcile
    // pre-call value by mint: target-mint value may have moved through an
    // intermediate only when the recorded burn covers it; any unrelated mint
    // must retain its exact pre-call balance. Only WSOL is exempt because its
    // native backing legitimately rests in the shared funding account.
    let mut burned_targets = Vec::with_capacity(leg_count);
    for (i, burned_amount) in burned_amounts[..leg_count].iter().enumerate() {
        burned_targets.push((targets[ACCOUNTS_PER_TARGET * i].address(), *burned_amount));
    }
    verify_no_intermediate_balances(
        route_pool,
        &pda,
        wsol_source.address(),
        &burned_targets,
        token_accounts_before,
    )?;
    verify_pda_still_a_bare_system_account(burn_pda)?;
    verify_wsol_account_still_ours(wsol_source, &pda)
}

/// The per-leg half of `swap_and_burn::validate_burner`. The vault itself is
/// derived and checked once, from the whole configuration, before any leg runs.
fn validate_split_target(
    accounts: &BurnerAccounts<'_>,
    pda: &Address,
    launch_mint: &Address,
    bump: u8,
) -> Result<ValidatedBurner, ProgramError> {
    // `false`: a burn's ATA must already exist, which makes the
    // pending-creation branch of the shared admission unreachable and leaves
    // the burn path's checks exactly as they were before `validate_config`
    // began sharing them.
    let (validated, _ata_pending) = validate_split_target_admission(
        accounts.target_mint,
        accounts.target_token_account,
        accounts.target_token_program,
        pda,
        launch_mint,
        bump,
        false,
    )?;
    Ok(validated)
}

/// Everything that admits one split leg, shared verbatim between the burn
/// and the read-only `validate_config` so the two cannot drift: a config the
/// validator accepts is a config this exact code accepts at burn time.
///
/// `allow_pending_ata` exists because `validate_config` is designed to run in
/// the same transaction that CREATES the vault's ATAs, before it does. A
/// target ATA that is still a bare System account at the exactly-derived
/// address is admissible there and only there — the address is a pure
/// function of (vault, mint, token program), so the account the transaction
/// goes on to create can only be the one admitted here. The burn passes
/// `false`, which makes `ata_pending` unconditionally false.
pub(crate) fn validate_split_target_admission(
    target_mint: &AccountView,
    target_token_account: &AccountView,
    target_token_program: &AccountView,
    pda: &Address,
    launch_mint: &Address,
    bump: u8,
    allow_pending_ata: bool,
) -> Result<(ValidatedBurner, bool), ProgramError> {
    let target_program = target_token_program.address().clone();
    if (target_program != SPL_TOKEN_PROGRAM_ID && target_program != SPL_TOKEN_2022_PROGRAM_ID)
        || !target_token_program.executable()
    {
        return Err(err(BurnerError::InvalidTokenProgram));
    }
    if target_mint.owner() != &target_program {
        return Err(err(BurnerError::InvalidMintOwner));
    }
    let ata_pending = allow_pending_ata && is_bare_system_account(target_token_account);
    if !ata_pending && target_token_account.owner() != &target_program {
        return Err(err(BurnerError::InvalidTokenAccountOwner));
    }

    let target_mint_address = target_mint.address().clone();
    if target_token_account.address()
        != &associated_token_address(pda, &target_mint_address, &target_program)
    {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }

    let target_decimals = validate_target_mint(target_mint, &target_program)?;
    let target_before = if ata_pending {
        // Nothing to read: the account does not exist yet, and the setup
        // transaction only creates it after this instruction has succeeded.
        0
    } else {
        validate_target_account(target_token_account, &target_mint_address, pda, &target_program)?
    };

    Ok((
        ValidatedBurner {
            launch_mint: launch_mint.clone(),
            target_mint: target_mint_address,
            pda: pda.clone(),
            bump_seed: [bump],
            target_program,
            target_decimals,
            target_before,
        },
        ata_pending,
    ))
}

// ---------------------------------------------------------------------------
// The split configuration rules, factored so `validate_config` runs the SAME
// code the burn runs. These are deliberately the only copies: a rule that
// exists twice can drift, and the entire value of on-chain pre-funding
// validation is that it cannot.
// ---------------------------------------------------------------------------

#[inline(always)]
pub(crate) fn validate_split_leg_count(leg_count: usize) -> ProgramResult {
    if leg_count == 0 || leg_count > MAX_SPLIT_TARGETS {
        return Err(err(BurnerError::InvalidSplitTargetCount));
    }
    Ok(())
}

#[inline(always)]
pub(crate) fn validate_split_leg_weight(bps: u16) -> ProgramResult {
    if bps == 0 {
        return Err(err(BurnerError::InvalidSplitWeights));
    }
    Ok(())
}

#[inline(always)]
pub(crate) fn validate_split_weight_sum(bps_sum: u32) -> ProgramResult {
    if bps_sum != BPS_TOTAL as u32 {
        return Err(err(BurnerError::InvalidSplitWeights));
    }
    Ok(())
}

/// The `bps_blob` seed: little-endian `u16` weights packed in leg order.
#[inline(always)]
pub(crate) fn pack_bps_blob(weights: &[u16], blob: &mut [u8; 2 * MAX_SPLIT_TARGETS]) {
    for (i, bps) in weights.iter().enumerate() {
        blob[2 * i..2 * i + 2].copy_from_slice(&bps.to_le_bytes());
    }
}

/// Rebuild the committed configuration's PDA seeds from the target account
/// block and the packed weights, rejecting duplicate targets, and return the
/// seed count.
///
/// Two legs naming one mint would share a single ATA. Each leg reads its own
/// `target_before` inside the burn loop, after every earlier leg has already
/// burned, so it would in fact execute correctly -- but "50% NEIRO + 50%
/// NEIRO" is a configuration nobody can read, and the address it derives is
/// not the address `["burner", launch, NEIRO, 10000]` derives. Reject it, so
/// the weights in a vault's address always name distinct targets.
///
/// Like every other misconfiguration in a program with no withdrawal
/// instruction, a duplicate-target config bricks the vault rather than
/// degrading it; the failure is immediate and named on the first burn attempt
/// (and now at `validate_config` time, before anything is funded).
///
/// `require_writable` is true on the burn path, which goes on to write every
/// leg's mint and ATA and therefore demands the write locks up front; the
/// read-only `validate_config` passes false, because it never writes and must
/// not force clients to take write locks on mints as popular as JTO.

/// KEYLESS: identical to the production builder, plus one reference seed per
/// leg appended after the bps_blob:
///
/// ```text
/// ("burner", launch_mint, target_0.., bps_blob, ref_0..)
/// ref_i = [0u8; 32]              if reference_i.owner ∈ {Pump.fun, PumpSwap}
///       = reference_i's address  otherwise (v4 / CP / CLMM / DLMM / junk)
/// ```
///
/// A junk reference (System-owned, or any unlisted owner) deliberately still
/// derives — as its own address, never the sentinel — so it lands on a
/// different, unfunded vault (6012) rather than needing a special case here;
/// if the caller derives WITH the junk address, `keyless_leg_floor` then
/// refuses the account itself (6039). Cross-`n` collisions stay impossible:
/// the seed pre-image length becomes `6 + 32 + 66n`, still injective in `n`,
/// and within one `n` the mints, blob, and references parse uniquely.
pub(crate) fn build_split_seeds<'a>(
    launch_mint: &'a AccountView,
    targets: &'a [AccountView],
    leg_count: usize,
    bps_blob: &'a [u8; 2 * MAX_SPLIT_TARGETS],
    require_writable: bool,
    refs: RefSource<'a>,
    seed_refs: &mut [&'a [u8]; MAX_SEEDS],
) -> Result<usize, ProgramError> {
    use crate::constants::{PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID};

    let stride = match refs {
        RefSource::FromAccounts => ACCOUNTS_PER_TARGET,
        RefSource::FromData(data) => {
            if data.len() != 32 * leg_count {
                return Err(err(BurnerError::InvalidInstructionData));
            }
            1
        }
    };
    seed_refs[0] = BURNER_SEED;
    seed_refs[1] = launch_mint.address().as_ref();
    for i in 0..leg_count {
        let mint = &targets[stride * i];
        if require_writable {
            // Only the burn demands write locks, and the burn always passes
            // the full account blocks (`FromAccounts`); Mode B's mint-only
            // block has no ATA slot to check.
            if !mint.is_writable() {
                return Err(err(BurnerError::AccountNotMutable));
            }
            if let RefSource::FromAccounts = refs {
                let token_account = &targets[ACCOUNTS_PER_TARGET * i + 1];
                if !token_account.is_writable() {
                    return Err(err(BurnerError::AccountNotMutable));
                }
            }
        }
        for previous in targets[..stride * i].iter().step_by(stride) {
            if previous.address() == mint.address() {
                return Err(err(BurnerError::DuplicateSplitTarget));
            }
        }
        seed_refs[SEED_PREFIX + i] = mint.address().as_ref();
        seed_refs[SEED_PREFIX + leg_count + SEED_SUFFIX + i] = match refs {
            RefSource::FromAccounts => {
                let reference = &targets[ACCOUNTS_PER_TARGET * i + 3];
                if reference.owner() == &PUMP_FUN_PROGRAM_ID
                    || reference.owner() == &PUMP_SWAP_PROGRAM_ID
                {
                    &ZERO_REF
                } else {
                    reference.address().as_ref()
                }
            }
            RefSource::FromData(data) => &data[32 * i..32 * (i + 1)],
        };
    }
    seed_refs[SEED_PREFIX + leg_count] = &bps_blob[..2 * leg_count];
    Ok(SEED_PREFIX + 2 * leg_count + SEED_SUFFIX)
}

/// Derive the vault from the rebuilt configuration, then pin the passed vault
/// account and WSOL ATA to the derivation. The vault must also still be a
/// bare System account: anything else is unusable by the burn (6012) and
/// therefore equally a validation failure.
pub(crate) fn derive_and_pin_split_vault(
    program_id: &Address,
    seeds: &[&[u8]],
    burn_pda: &AccountView,
    wsol_source: &AccountView,
) -> Result<(Address, u8), ProgramError> {
    let (pda, bump) = Address::find_program_address(seeds, program_id);
    if burn_pda.address() != &pda || !is_bare_system_account(burn_pda) {
        return Err(err(BurnerError::InvalidBurnPda));
    }
    if wsol_source.address() != &associated_token_address(&pda, &WSOL_MINT, &SPL_TOKEN_PROGRAM_ID) {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    Ok((pda, bump))
}

// ---------------------------------------------------------------------------
// Property fuzzing of `handler`'s instruction-data decode and of the split
// arithmetic. `split.rs` decodes entirely caller-controlled bytes with
// hand-rolled cursor arithmetic, in a program with no withdrawal instruction,
// so the properties are absolute:
//
//   * no input of ANY shape may panic (an SBF abort, not a clean revert);
//   * every rejection must be a named `BurnerError`, and must be EXACTLY the
//     code an independent model of the wire grammar predicts;
//   * for any weight vector summing to 10000 bps, the derived per-leg amounts
//     must sum to the total exactly, a leg deriving zero must be rejected as
//     `ZeroInput` rather than silently burning nothing, and nothing may
//     overflow for totals up to `u64::MAX`.
//
// The decode fuzz drives the real `handler` against account fixtures built in
// the exact runtime layout; the arithmetic fuzz additionally drives it against
// a fixture that is valid all the way to the division, so the division's
// zero/nonzero boundary for EVERY leg (final-remainder leg included) is
// observed through the program's own behaviour, not through a re-computation.
// `tests/fuzz_artifact.rs` then repeats both campaigns against the real
// SBPFv3 ELF under Mollusk, where the embedded-in_amount pin (6008) makes the
// derived leg amount itself observable.
//
// Runs with the ordinary suite (`npm run test:unit`); longer campaigns via
// `PROPTEST_CASES=100000 npm run fuzz:host` (see scripts/fuzz-burner.sh).
// ---------------------------------------------------------------------------
