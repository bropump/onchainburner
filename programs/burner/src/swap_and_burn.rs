//! Shared burn helpers: Jupiter route validation, the keyless price floor,
//! the WSOL/lamport postconditions, and `BurnChecked`.
//!
//! THIS MODULE NO LONGER SERVES AN INSTRUCTION. It was the Pinocchio port of
//! the Anchor `swap_and_burn` (one vault, one target); keyless deleted that
//! design, because the single-target derivation `["burner", launch, target]`
//! carries no reference seed and so could not be reference-bound. `lib.rs`
//! refuses its discriminator at dispatch, and the handler and its account
//! table were deleted with it — a single target is now served as a 1-leg
//! `swap_and_burn_split`.
//!
//! What remains is the validated-helper set that `split.rs` calls per leg and
//! `validate_config.rs` calls at admission. The live account layout is
//! documented in `split.rs`, not here; do not reintroduce a layout table for
//! an instruction that no longer exists.

use alloc::vec::Vec;
use pinocchio::{
    cpi::{invoke, invoke_signed, invoke_signed_with_slice, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

use crate::{
    constants::{
        ASSOCIATED_TOKEN_PROGRAM_ID, BURNER_SEED, JUPITER_EVENT_AUTHORITY, JUPITER_PROGRAM_ID,
        JUPITER_ROUTE_V2_DISCRIMINATOR, JUPITER_SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR,
        PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR,
        SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
        TOKEN_BURN_CHECKED_DISCRIMINATOR, TOKEN_SYNC_NATIVE_DISCRIMINATOR, WSOL_MINT,
    },
    error::{err, BurnerError},
    token::{
        read_token_amount, token_account_is_controlled_by, validate_launch_mint,
        validate_target_account, validate_target_mint, validate_wsol_account,
        verify_no_standing_claims,
    },
};

/// out = Rt * inp / (Rs + inp). Widening mul/div: the u64-only decomposition
/// underflows to zero and overflows on deep pools.
fn cp_out(rt: u64, rs: u64, inp: u64) -> Option<u64> {
    let d = (rs as u128).checked_add(inp as u128)?;
    if d == 0 { return None; }
    let q = (rt as u128).checked_mul(inp as u128)? / d;
    if q > u64::MAX as u128 { return None; }
    Some(q as u64)
}
/// Output-floor tolerance, in bps: the floor is
/// `reference_spot * (10_000 - KEYLESS_TOL_BPS) / 10_000`. This is the ONLY
/// slack between the honest bound-reference price and the minimum the program
/// will accept, so it is exactly the skim a route/reference-divergence caller
/// (custody finding F1) can pocket: it prices a self-built execution pool at
/// the floor and keeps `spot - floor = KEYLESS_TOL_BPS` of every leg notional.
///
/// TIGHTENED 500 -> 100. Justification (measured, FABLE-ECON-REVIEW F1
/// addendum + FABLE-CLMM-DLMM + FABLE-ARITH-SWEEP):
///   * Honest constant-product burns consume ~0 bps: realised/predicted =
///     1.000000 to the atom, and CP burns land 100% at 50 bps (FABLE-LEVERS).
///     100 bps is a 2x drift-headroom margin over the ~50 bps needed to cover
///     blockhash-window (~60-90 s) price drift.
///   * Position venues are unaffected in kind: the DLMM Q64 price
///     approximation error is ~2*|active_id|*2^-64 relative (worst measured
///     1.7e-16 -- 14+ orders of magnitude below 100 bps), and the CLMM
///     double-truncation understates the floor by <= sq/2^64 + 1 atoms, a
///     CONSERVATIVE direction that can never cause a wrong refusal. Verified
///     on the real $PUMP (DLMM id -1513 / CLMM sqrt~4.53) and JTO (DLMM
///     id -414 / CLMM sqrt~13.1) pools. No supported venue needs a wider band.
///   * Effect on F1: the per-burn skim falls from ~5% to ~1% of the leg
///     notional (5x cut), bounded by `KEYLESS_TOL_BPS * cap`. It does NOT
///     eliminate F1 (a ~1% skim on ~leg-notional capital remains positive);
///     closing it entirely needs execution pinned to the reference, which is
///     unavailable for multi-hop targets. 100 bps is the practical floor:
///     below ~50 bps honest burns start failing on adverse drift.
const KEYLESS_TOL_BPS: u64 = 100;

/// Minimum SOL-side depth (in lamports) an ADDRESS-BOUND reference pool must
/// carry to be admitted. Change 2 (reference depth/quality admission).
///
/// WHY A DEPTH GATE, AND WHAT IT DOES NOT DO. FABLE-ECON-REVIEW shows the
/// attacker's return-on-capital is DEPTH-INVARIANT (~fee/2 ~= 0.06%/burn), so
/// min-depth does NOT make attacking unprofitable -- do not claim that. What
/// it does is (a) exclude thin, cheaply-manipulated micro-pools, and (b)
/// force an attacker who would DOMINATE the bound reference to commit
/// pool-scale absolute capital (~2*depth to own it, FABLE-ECON §2a), which is
/// irrational against a normal few-to-tens-of-SOL creator vault. The
/// per-burn absolute extraction is already bounded by `cap = fee * depth`.
///
/// THRESHOLD DERIVATION (50 SOL). A representative creator vault is "a few to
/// a few tens of SOL" (FABLE-ECON §6). 50 SOL of reference depth forces an
/// attacker who wants to own the reference to commit >= ~100 SOL (2*depth) --
/// several times the whole vault -- at ~0.06%/burn, plainly irrational; and
/// it clears the thin-pool danger band (FABLE-ECON §4: a <= 20-SOL-deep pool
/// is ownable for <= 40 SOL, a griefer's range). It admits every supported
/// target's deepest real reference (NEIRO v4 ~1,378, $PUMP DLMM ~12,179 /
/// CLMM ~4,649, FARTCOIN/WIF/POPCAT/RAY deep v4, BONK ~90, JTO CLMM ~168) and
/// excludes the micro-pools whose entire depth an attacker owns for pocket
/// change (JTO v4 ~1.3, $PUMP PumpSwap ~12.9). FABLE-LOCKED-ADMISSION §3
/// recommended ~1,000 SOL, but that excludes JTO and BONK, which CLAUDE.md
/// lists as supported targets; 50 SOL is the largest round floor that keeps
/// the full supported set while still excluding cheaply-owned micro-pools.
///
/// SCOPE. Enforced ONLY on address-bound references (Raydium V4 / CP / CLMM,
/// Meteora DLMM), never on the Pump-venue sentinels (bonding curve, PumpSwap
/// pool): the flagship own-launch 80% leg is a Pump sentinel, intrinsically
/// thin when fresh, and gating it would kill the product. Costs ZERO extra
/// accounts and ZERO extra locks -- the SOL-side depth is already read for
/// the cap -- and only a few CU (one compare) per admitted CP/CL leg.
///
/// LIMITS (state, do not overclaim). It cannot drive the attacker's ownership
/// fraction to zero (ROI is depth-invariant), cannot prevent post-admission
/// depth decay of a bound pool (a liveness/brick concern, not extraction),
/// and does not touch the flat `KEYLESS_TOL_BPS` skim (that is Change 1).
const MIN_REFERENCE_DEPTH_LAMPORTS: u64 = 50_000_000_000;

const PUMP_FEE_PROGRAM_ID: Address = Address::new_from_array([
    12, 53, 255, 169, 5, 90, 142, 86, 141, 168, 247, 188, 7, 86, 21, 39, 76, 241, 201, 44,
    164, 31, 64, 0, 156, 81, 106, 164, 20, 194, 124, 112,
]);
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];

pub(crate) const JUPITER_AUTHORITY_INDEX: usize = 0;
pub(crate) const JUPITER_SOURCE_INDEX: usize = 1;
pub(crate) const JUPITER_USER_DESTINATION_INDEX: usize = 2;
pub(crate) const JUPITER_SOURCE_MINT_INDEX: usize = 3;
pub(crate) const JUPITER_DESTINATION_MINT_INDEX: usize = 4;
pub(crate) const JUPITER_SOURCE_TOKEN_PROGRAM_INDEX: usize = 5;
pub(crate) const JUPITER_DESTINATION_TOKEN_PROGRAM_INDEX: usize = 6;
pub(crate) const JUPITER_DESTINATION_INDEX: usize = 7;
pub(crate) const JUPITER_EVENT_AUTHORITY_INDEX: usize = 8;
pub(crate) const JUPITER_PROGRAM_INDEX: usize = 9;
const JUPITER_V2_FIXED_ACCOUNTS: usize = 10;

// `route_v2` puts its stable scalar fields before its extensible route plan:
// discriminator + in_amount + quoted_out_amount + slippage_bps +
// platform_fee_bps + positive_slippage_bps + Vec length.
const JUPITER_V2_ARGS_PREFIX_LEN: usize = 8 + 8 + 8 + 2 + 2 + 2 + 4;
const JUPITER_V2_IN_AMOUNT_OFFSET: usize = 8;
const JUPITER_V2_PLATFORM_FEE_OFFSET: usize = 26;
const JUPITER_V2_POSITIVE_SLIPPAGE_FEE_OFFSET: usize = 28;

const JUPITER_SHARED_AUTHORITY_INDEX: usize = 1;
const JUPITER_SHARED_SOURCE_INDEX: usize = 2;
const JUPITER_SHARED_USER_DESTINATION_INDEX: usize = 5;
const JUPITER_SHARED_SOURCE_MINT_INDEX: usize = 6;
const JUPITER_SHARED_DESTINATION_MINT_INDEX: usize = 7;
const JUPITER_SHARED_SOURCE_TOKEN_PROGRAM_INDEX: usize = 8;
const JUPITER_SHARED_DESTINATION_TOKEN_PROGRAM_INDEX: usize = 9;
const JUPITER_SHARED_EVENT_AUTHORITY_INDEX: usize = 10;
const JUPITER_SHARED_PROGRAM_INDEX: usize = 11;
const JUPITER_SHARED_V2_FIXED_ACCOUNTS: usize = 12;
const JUPITER_SHARED_V2_ARGS_PREFIX_LEN: usize = JUPITER_V2_ARGS_PREFIX_LEN + 1;
const JUPITER_SHARED_V2_IN_AMOUNT_OFFSET: usize = JUPITER_V2_IN_AMOUNT_OFFSET + 1;
const JUPITER_SHARED_V2_PLATFORM_FEE_OFFSET: usize = JUPITER_V2_PLATFORM_FEE_OFFSET + 1;
const JUPITER_SHARED_V2_POSITIVE_SLIPPAGE_FEE_OFFSET: usize =
    JUPITER_V2_POSITIVE_SLIPPAGE_FEE_OFFSET + 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JupiterRouteKind {
    Direct,
    Shared,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PumpLamportCredit {
    account_index: usize,
    address: Address,
    lamports: u64,
}

pub(crate) struct BurnerAccounts<'a> {
    pub(crate) burn_pda: &'a AccountView,
    pub(crate) wsol_source: &'a AccountView,
    pub(crate) launch_mint: &'a AccountView,
    pub(crate) target_mint: &'a AccountView,
    pub(crate) target_token_account: &'a AccountView,
    pub(crate) target_token_program: &'a AccountView,
    pub(crate) spl_token_program: &'a AccountView,
}

pub(crate) struct ValidatedBurner {
    pub(crate) launch_mint: Address,
    pub(crate) target_mint: Address,
    pub(crate) pda: Address,
    pub(crate) bump_seed: [u8; 1],
    pub(crate) target_program: Address,
    pub(crate) target_decimals: u8,
    pub(crate) target_before: u64,
}

/// Q64.64 multiply: (a*b) >> 64 without a 256-bit type.
///
/// RESTORED with a real overflow check. The deleted original ended in
/// `hi.checked_shl(64)?`, but `checked_shl` validates only the SHIFT COUNT
/// (64 < 128 is always fine on a u128) and never whether significant bits
/// fall off the top: any `hi` with bits at or above position 64 was silently
/// truncated, so an unrepresentable product came back as a small WRONG value
/// instead of `None`. The result `(hi << 64) + low64(mid)` is representable
/// in a u128 iff `hi < 2^64`, so exactly that is asserted before the shift;
/// an unrepresentable product now refuses (`None`), never wraps.
fn mul_q64(a: u128, b: u128) -> Option<u128> {
    let (ah, al) = (a >> 64, a & (u64::MAX as u128));
    let (bh, bl) = (b >> 64, b & (u64::MAX as u128));
    // Each partial product multiplies two values < 2^64 and cannot overflow
    // a u128; the checked ops are retained as defense in depth.
    let ll = al.checked_mul(bl)?;
    let lh = al.checked_mul(bh)?;
    let hl = ah.checked_mul(bl)?;
    let hh = ah.checked_mul(bh)?;
    let mid = (ll >> 64).checked_add(lh & (u64::MAX as u128))?.checked_add(hl & (u64::MAX as u128))?;
    let hi = hh.checked_add(lh >> 64)?.checked_add(hl >> 64)?.checked_add(mid >> 64)?;
    if hi >> 64 != 0 {
        // (a*b) >> 64 does not fit in a u128: refuse, never truncate.
        return None;
    }
    (hi << 64).checked_add(mid & (u64::MAX as u128))
}

/// Meteora DLMM bin price: (1 + bin_step/10_000)^active_id, Q64.64.
/// Verified against live quotes at 0.000% error (positive `active_id`).
///
/// RESTORED with a corrected reciprocal for `active_id < 0`. The deleted
/// original long-divided 2^128/result via `rem.checked_shl(64)`, and for
/// every `result > 2^64` — i.e. every negative `active_id`, since the base
/// exceeds 1.0 — `rem` was 2^64 and the shift silently wrapped to zero,
/// collapsing the whole reciprocal to 0 (fail-closed downstream, but wrongly
/// refusing every pool priced below 1.0). 2^128/r is now computed exactly
/// with no shift at all: 2^128 = u128::MAX + 1, so floor(2^128/r) equals
/// MAX/r, plus one exactly when r divides 2^128 (MAX % r == r - 1).
fn dlmm_price_q64(bin_step: u16, active_id: i32) -> Option<u128> {
    let one: u128 = 1u128 << 64;
    let mut base = one
        .checked_mul(10_000u128.checked_add(bin_step as u128)?)?
        .checked_div(10_000)?;
    let mut e = active_id.unsigned_abs() as u64;
    let mut result = one;
    while e > 0 {
        if e & 1 == 1 {
            result = mul_q64(result, base)?;
        }
        e >>= 1;
        if e > 0 {
            base = mul_q64(base, base)?;
        }
    }
    if active_id < 0 {
        if result == 0 {
            return None;
        }
        let q = u128::MAX / result;
        let recip = if u128::MAX % result == result - 1 {
            q.checked_add(1)?
        } else {
            q
        };
        if recip == 0 {
            return None;
        }
        return Some(recip);
    }
    Some(result)
}

/// Shared tail for EVERY reference — the price-based (DLMM / CLMM) paths and
/// the constant-product (Pump curve / PumpSwap / Raydium V4 / Raydium CP)
/// paths alike: range-check the expected output, apply the tolerance haircut,
/// and refuse — never clamp — a floor that would carry no price protection
/// (6002 for a zero expected output and for a zero final floor). The haircut
/// multiply runs in u128: the u64 form `out * (10_000 - TOL)` overflows above
/// ~1.94e15 atoms (`u64::MAX / 9_500`) and would wrongly refuse a perfectly
/// representable floor.
fn keyless_floor_from_expected(expected: u128) -> Result<u64, ProgramError> {
    if expected == 0 {
        return Err(err(BurnerError::ZeroMinimumOutput));
    }
    if expected > u64::MAX as u128 {
        return Err(err(BurnerError::InvalidInstructionData));
    }
    let floor = expected
        .checked_mul((10_000 - KEYLESS_TOL_BPS) as u128)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        / 10_000;
    if floor == 0 {
        return Err(err(BurnerError::ZeroMinimumOutput));
    }
    Ok(floor as u64)
}

#[derive(Clone, Copy)]
struct KeylessFee {
    numerator: u64,
    denominator: u64,
    /// Pump's exact-in programs divide the budget by `(denominator + fee)`
    /// and reserve one atom for their rounding correction, not `1 - fee`.
    pump_exact_in: bool,
}

fn keyless_fee(numerator: u64, denominator: u64, pump_exact_in: bool) -> Result<KeylessFee, ProgramError> {
    if numerator == 0 || denominator == 0 || numerator >= denominator {
        return Err(err(BurnerError::ReferenceInvalid));
    }
    Ok(KeylessFee { numerator, denominator, pump_exact_in })
}

fn fee_cap(reserve: u64, fee: KeylessFee) -> Result<u64, ProgramError> {
    let cap = (reserve as u128)
        .checked_mul(fee.numerator as u128)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        / fee.denominator as u128;
    if cap > u64::MAX as u128 { return Err(err(BurnerError::InvalidInstructionData)); }
    Ok(cap as u64)
}

fn input_after_fee(amount: u64, fee: KeylessFee) -> Result<u64, ProgramError> {
    let denominator = if fee.pump_exact_in {
        (fee.denominator as u128)
            .checked_add(fee.numerator as u128)
            .ok_or(err(BurnerError::InvalidInstructionData))?
    } else {
        fee.denominator as u128
    };
    let gross = amount as u128;
    let numerator = if fee.pump_exact_in {
        fee.denominator as u128
    } else {
        (fee.denominator as u128)
            .checked_sub(fee.numerator as u128)
            .ok_or(err(BurnerError::InvalidInstructionData))?
    };
    let mut net = gross
        .checked_mul(numerator)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        / denominator;
    // Pump's exact-in SDK first divides the budget by `(10_000 + fee)` and
    // then reserves one atom for its rounding correction.  Mirroring that
    // order avoids claiming a one-atom-higher floor than Pump can execute.
    if fee.pump_exact_in {
        net = net.checked_sub(1).ok_or(err(BurnerError::ZeroMinimumOutput))?;
    }
    if net == 0 || net > u64::MAX as u128 { return Err(err(BurnerError::ZeroMinimumOutput)); }
    Ok(net as u64)
}

/// Ceiling on a PLAUSIBLE total Pump fee, in bps of 10_000 (10%). Every live
/// Pump tier totals well under 3%; a successfully parsed total above this is
/// treated exactly like an unparseable config and falls back conservatively,
/// because an OVERSTATED fee is the permissive direction: it inflates the
/// input cap (`cap = reserve * fee`) and deflates the output floor (a larger
/// deduction in `input_after_fee` predicts less output).
const PUMP_FEE_PLAUSIBLE_MAX_BPS: u64 = 1_000;

/// Conservative fallback fee: 1 bps, the smallest nonzero fee representable
/// in Pump's bps schema. DIRECTION MATTERS and is the opposite of intuition:
/// the safe fallback is the LOWEST fee, not the highest.
///   * cap = reserve * fee / 10_000 -- a smaller fee yields a SMALLER input
///     cap, so the donation/manipulation margin is never overstated;
///   * floor = cp_out(input_after_fee(amount)) * tolerance -- a smaller fee
///     deducts less, predicts MORE output, and therefore demands a HIGHER
///     floor from the route.
/// Both are strictly less permissive than any successful read (every parsed
/// fee admitted above is >= 1 bps), so a fallback burn can only be smaller
/// and better-protected than a parsed one, never looser. The cost is
/// liveness-shaped, not safety-shaped: caps shrink to depth/10_000 per burn
/// and floors sit near the zero-fee spot price, with the 500 bps tolerance
/// absorbing the venue's real fee. Burns continue cautiously in smaller
/// chunks instead of stopping forever.
const PUMP_FEE_FALLBACK_BPS: u64 = 1;

fn conservative_pump_fee() -> KeylessFee {
    KeylessFee {
        numerator: PUMP_FEE_FALLBACK_BPS,
        denominator: 10_000,
        pump_exact_in: true,
    }
}

fn read_fee_config(
    fee_source: &AccountView,
    venue: &Address,
    market_cap: u128,
    include_lp_fee: bool,
    include_creator_fee: bool,
) -> Result<KeylessFee, ProgramError> {
    // IDENTITY fails CLOSED: the fee source must be the fee_config PDA
    // derived for this venue and owned by Pump's fee program. A wrong account
    // here is a wrong TRANSACTION, not a changed world, and admitting it
    // would let a caller aim the read at data of their choosing.
    let (expected, _) = Address::find_program_address(
        &[b"fee_config", venue.as_ref()],
        &PUMP_FEE_PROGRAM_ID,
    );
    if fee_source.address() != &expected || fee_source.owner() != &PUMP_FEE_PROGRAM_ID {
        return Err(err(BurnerError::ReferenceInvalid));
    }
    // CONTENT DEGRADES: this program is immutable and has no withdrawal
    // instruction, so a fee layout Pump restructures tomorrow must not brick
    // every vault forever. An unparseable or implausible config falls back to
    // the most conservative assumption (see PUMP_FEE_FALLBACK_BPS for why the
    // conservative direction is the LOWEST fee) and the burn continues
    // cautiously instead of stopping permanently.
    match parse_pump_fee_config(fee_source, market_cap, include_lp_fee, include_creator_fee) {
        Some(total)
            if total >= PUMP_FEE_FALLBACK_BPS && total <= PUMP_FEE_PLAUSIBLE_MAX_BPS =>
        {
            keyless_fee(total, 10_000, true)
        }
        _ => Ok(conservative_pump_fee()),
    }
}

/// Best-effort parse of Pump's tiered `fee_config`, returning the total fee
/// in bps or `None` on any structural surprise. `None` is not an error: the
/// caller substitutes the conservative fallback.
fn parse_pump_fee_config(
    fee_source: &AccountView,
    market_cap: u128,
    include_lp_fee: bool,
    include_creator_fee: bool,
) -> Option<u64> {
    let data = fee_source.try_borrow().ok()?;
    if data.get(0..8) != Some(PUMP_FEE_CONFIG_DISCRIMINATOR.as_ref()) || data.len() < 69 {
        return None;
    }
    let count = u32::from_le_bytes(data.get(65..69)?.try_into().ok()?) as usize;
    let tiers_end = 69usize.checked_add(count.checked_mul(40)?)?;
    // FeeConfig carries a second stable-tier vector and reserved trailing
    // bytes after the live tier vector. Only require that the authenticated
    // live vector is wholly present; equality would reject the real account.
    // NO arbitrary tier-count cliff: the only real bound is the account's own
    // length, which Pump controls and pays rent for.
    if data.len() < tiers_end {
        return None;
    }
    let flat = |at: usize| -> Option<u64> {
        Some(u64::from_le_bytes(data.get(at..at + 8)?.try_into().ok()?))
    };
    let mut lp = flat(41)?;
    let mut protocol = flat(49)?;
    let mut creator = flat(57)?;
    // Binary search the sorted tier table for the LAST tier whose threshold
    // is <= market_cap, then verify the pick locally: its own threshold
    // applies and the next tier's does not.
    let threshold_at = |i: usize| -> Option<u128> {
        let at = 69 + 40 * i;
        Some(u128::from_le_bytes(data.get(at..at + 16)?.try_into().ok()?))
    };
    if count > 0 && threshold_at(0)? <= market_cap {
        let (mut lo, mut hi) = (0usize, count - 1);
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2;
            if threshold_at(mid)? <= market_cap {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        if threshold_at(lo)? > market_cap {
            return None;
        }
        if lo + 1 < count && threshold_at(lo + 1)? <= market_cap {
            return None;
        }
        let at = 69 + 40 * lo;
        lp = flat(at + 16)?;
        protocol = flat(at + 24)?;
        creator = flat(at + 32)?;
    }
    let total = (if include_lp_fee { lp as u128 } else { 0 })
        .checked_add(protocol as u128)
        .and_then(|v| if include_creator_fee { v.checked_add(creator as u128) } else { Some(v) })?;
    u64::try_from(total).ok()
}

/// KEYLESS: derive a per-leg output floor from the leg's BOUND reference.
/// `reference` is either a Pump bonding curve (derived from `target_mint`) or a
/// whitelisted pool that itself names `vault_a`/`vault_b`. `fee_source` is a
/// venue-authenticated fee account (or the reference itself when the venue
/// stores the fee in its pool state).
///
/// This function authenticates the reference's SHAPE — a real (target_mint,
/// SOL) pool owned by an allow-listed venue program, with its own vaults and
/// fee source cross-checked against its own data (6039 on any mismatch, 6040
/// past the depth cap). Its SELECTION is bound by the vault address:
/// `build_split_seeds` feeds each leg's reference (or the Pump zero-sentinel)
/// into the PDA derivation, so the account passed here is byte-identically
/// the one the vault's creator reviewed, or the transaction landed on a
/// different, unfunded vault (6012) before this ran. For the two Pump venues
/// the sentinel carries no address, and identity is enforced HERE instead, by
/// derivation: the curve must be `PDA(["bonding-curve", mint])` and the
/// PumpSwap pool's stored `creator` must be `PDA(["pool-authority", mint])` —
/// which is what lets the flagship own-launch leg survive graduation (curve
/// -> canonical PumpSwap pool) without changing the vault address.
pub(crate) fn keyless_leg_floor(
    target_mint: &AccountView,
    reference: &AccountView,
    vault_a: &AccountView,
    vault_b: &AccountView,
    fee_source: &AccountView,
    amount_in: u64,
) -> Result<u64, ProgramError> {
    const RAYDIUM_V4: Address = Address::new_from_array([
        75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92,
        241, 33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
    ]);
    const RAYDIUM_CP: Address = Address::new_from_array([
        169, 42, 90, 139, 79, 41, 89, 82, 132, 37, 80, 170, 147, 253, 91, 149, 181, 172, 230, 168,
        235, 146, 12, 147, 148, 46, 67, 105, 12, 32, 236, 115,
    ]);
    let (rt, rs, fee) = if reference.owner() == &PUMP_FUN_PROGRAM_ID {
        let (expected, _) = Address::find_program_address(
            &[b"bonding-curve", target_mint.address().as_ref()],
            &PUMP_FUN_PROGRAM_ID,
        );
        if reference.address() != &expected {
            return Err(err(BurnerError::ReferenceInvalid));
        }
        let cd = reference.try_borrow()?;
        if cd.len() < 82 || cd[48] == 1 {
            return Err(err(BurnerError::ReferenceInvalid));
        }
        let virtual_tokens = read_u64(cd.get(8..16).ok_or(err(BurnerError::ReferenceInvalid))?)?;
        let virtual_quote = read_u64(cd.get(16..24).ok_or(err(BurnerError::ReferenceInvalid))?)?;
        if virtual_tokens == 0 { return Err(err(BurnerError::ReferenceInvalid)); }
        let target_data = target_mint.try_borrow()?;
        let mint_supply = read_u64(target_data.get(36..44).ok_or(err(BurnerError::ReferenceInvalid))?)?;
        // Normal Pump curves use the protocol's fixed one-billion supply;
        // mayhem curves instead use the actual mint supply.
        let supply_for_cap = if cd[81] == 0 { 1_000_000_000_000_000u64 } else { mint_supply };
        let market_cap = (virtual_quote as u128)
            .checked_mul(supply_for_cap as u128)
            .ok_or(err(BurnerError::InvalidInstructionData))?
            / virtual_tokens as u128;
        let creator_non_default = cd.get(49..81) != Some(&[0u8; 32]);
        let fee = read_fee_config(fee_source, &PUMP_FUN_PROGRAM_ID, market_cap, false, creator_non_default)?;
        (virtual_tokens, virtual_quote, fee)
    } else {
        // Bin (Meteora DLMM) and concentrated-liquidity (Raydium CLMM)
        // references are SUPPORTED. An earlier refactor removed them on the
        // reasoning that position-based venues can never satisfy a
        // locked-pool requirement; that requirement does not exist in this
        // code — no locked-LP check runs on any venue. Since reference
        // binding landed, the vault address COMMITS to the setup-time
        // reviewed pool (see the note on `keyless_leg_floor`), so the
        // reviewer's depth judgement is enforceable: a burn-time caller can
        // no longer substitute a different pool. What the keyless path
        // enforces on-chain is uniform across venues: the reference must be
        // the bound, shape-authenticated pool of an allow-listed program for
        // this pair, and the floor is its quote minus the tolerance.
        // Removing these venues
        // therefore bought no safety and collapsed the burn cap for any target
        // whose liquidity lives on those venues ($PUMP, a mandatory 10% leg,
        // most of all). The two arithmetic gaps the removal cited are FIXED
        // in the restored code, not reintroduced: `mul_q64` now refuses
        // (returns None) instead of silently truncating `hi`'s high bits,
        // and the inverse-CLMM path range-checks `t` before its `<< 64`.
        // A reference owned by any unsupported program still falls through
        // to the constant-product allow-list below and is refused with
        // ReferenceInvalid (6039) -- never mis-priced.
        const METEORA_DLMM: Address = Address::new_from_array([
            4, 233, 225, 47, 188, 132, 232, 38, 201, 50, 204, 233, 226, 100, 12, 206, 21, 89,
            12, 28, 98, 115, 176, 146, 87, 8, 186, 59, 133, 32, 176, 188,
        ]);
        if reference.owner() == &METEORA_DLMM {
            let pd = reference.try_borrow()?;
            let rx = pd.get(152..184).ok_or(err(BurnerError::ReferenceInvalid))?;
            let ry = pd.get(184..216).ok_or(err(BurnerError::ReferenceInvalid))?;
            let p0 = vault_a.address().as_ref();
            let p1 = vault_b.address().as_ref();
            if !((rx == p0 && ry == p1) || (rx == p1 && ry == p0)) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let x_mint = pd.get(88..120).ok_or(err(BurnerError::ReferenceInvalid))?;
            let y_mint = pd.get(120..152).ok_or(err(BurnerError::ReferenceInvalid))?;
            let sol_is_x = x_mint == WSOL_MINT.as_ref();
            if sol_is_x {
                if y_mint != target_mint.address().as_ref() {
                    return Err(err(BurnerError::ReferenceInvalid));
                }
            } else if x_mint != target_mint.address().as_ref() || y_mint != WSOL_MINT.as_ref() {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let active_id = i32::from_le_bytes(
                pd.get(76..80).ok_or(err(BurnerError::ReferenceInvalid))?
                    .try_into().map_err(|_| err(BurnerError::ReferenceInvalid))?,
            );
            let bin_step = u16::from_le_bytes(
                pd.get(80..82).ok_or(err(BurnerError::ReferenceInvalid))?
                    .try_into().map_err(|_| err(BurnerError::ReferenceInvalid))?,
            );
            let price = dlmm_price_q64(bin_step, active_id)
                .ok_or(err(BurnerError::InvalidInstructionData))?;
            let sol_vault = if (rx == p0) == sol_is_x { &*vault_a } else { &*vault_b };
            let sd = sol_vault.try_borrow()?;
            if sd.len() < 72 || sd.get(0..32) != Some(WSOL_MINT.as_ref()) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            // GROSS DEPTH ONLY. This is the SPL reserve account's raw `amount`
            // field. It includes tokens in inactive bins and direct donations;
            // it is NOT the amount executable at `active_id`. Computing active
            // DLMM depth requires bin-array state that is neither supplied nor
            // covered by the verified offset oracle, so 6040/6041 below remain
            // a gross-custody approximation. Residual risk: a bound pool can
            // pass both guards while its active bin is thin and manipulable.
            let depth = read_u64(sd.get(64..72).ok_or(err(BurnerError::ReferenceInvalid))?)?;
            if fee_source.address() != reference.address() {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            if pd.get(0..8) != Some(&[33, 11, 49, 98, 181, 101, 177, 13]) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let base_factor = u16::from_le_bytes(pd.get(8..10).ok_or(err(BurnerError::ReferenceInvalid))?.try_into().map_err(|_| err(BurnerError::ReferenceInvalid))?) as u64;
            let power = *pd.get(34).ok_or(err(BurnerError::ReferenceInvalid))?;
            let scale = 10u64.checked_pow(power as u32).ok_or(err(BurnerError::ReferenceInvalid))?;
            let fee = keyless_fee(
                base_factor.checked_mul(bin_step as u64).and_then(|v| v.checked_mul(10)).and_then(|v| v.checked_mul(scale)).ok_or(err(BurnerError::ReferenceInvalid))?,
                1_000_000_000,
                false,
            )?;
            let cap = fee_cap(depth, fee)?;
            if amount_in > cap { return Err(err(BurnerError::ReferenceCapExceeded)); }
            let inp = input_after_fee(amount_in, fee)?;
            let expected = if sol_is_x {
                mul_q64(inp as u128, price).ok_or(err(BurnerError::InvalidInstructionData))?
            } else {
                // `inp` is a u64, so `inp << 64` always fits a u128.
                ((inp as u128) << 64).checked_div(price)
                    .ok_or(err(BurnerError::InvalidInstructionData))?
            };
            // This gates the GROSS WSOL vault amount documented at the read
            // above, not active-bin liquidity. It proves only that the bound,
            // well-formed pool custodies this much WSOL in total.
            if depth < MIN_REFERENCE_DEPTH_LAMPORTS {
                return Err(err(BurnerError::ReferenceTooShallow));
            }
            return keyless_floor_from_expected(expected);
        }
        const RAYDIUM_CLMM: Address = Address::new_from_array([
            165, 213, 202, 158, 4, 207, 93, 181, 144, 183, 20, 186, 47, 227, 44, 177, 89, 19,
            63, 193, 193, 146, 183, 34, 87, 253, 7, 211, 156, 176, 64, 30,
        ]);
        // Raydium CLMM is concentrated liquidity: constant product on the vault
        // balances is meaningless there (measured error up to +2926% on bin/CL
        // venues). It stores the spot price directly as sqrt_price_x64, which
        // reproduces the live quote to 0.019%. Read that instead.
        if reference.owner() == &RAYDIUM_CLMM {
            let pd = reference.try_borrow()?;
            // PoolState discriminator, mirroring the DLMM branch's LbPair
            // check: sha256("account:PoolState")[..8], confirmed against the
            // on-chain Raydium CLMM IDL and the bytes of both real mainnet
            // pool fixtures (see FABLE-CLMM-DLMM.md). Defence in depth — the
            // owner gate plus the mint/vault pins below already refuse every
            // other CLMM account type — kept symmetric with DLMM because
            // this program is intended to be immutable.
            if pd.get(0..8) != Some(&[247, 237, 227, 245, 215, 195, 222, 70]) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let v0 = pd.get(137..169).ok_or(err(BurnerError::ReferenceInvalid))?;
            let v1 = pd.get(169..201).ok_or(err(BurnerError::ReferenceInvalid))?;
            let p0 = vault_a.address().as_ref();
            let p1 = vault_b.address().as_ref();
            if !((v0 == p0 && v1 == p1) || (v0 == p1 && v1 == p0)) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let mint0 = pd.get(73..105).ok_or(err(BurnerError::ReferenceInvalid))?;
            let mint1 = pd.get(105..137).ok_or(err(BurnerError::ReferenceInvalid))?;
            let sol_is_0 = mint0 == WSOL_MINT.as_ref();
            if sol_is_0 {
                if mint1 != target_mint.address().as_ref() {
                    return Err(err(BurnerError::ReferenceInvalid));
                }
            } else if mint0 != target_mint.address().as_ref() || mint1 != WSOL_MINT.as_ref() {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let sq = u128::from_le_bytes(
                pd.get(253..269)
                    .ok_or(err(BurnerError::ReferenceInvalid))?
                    .try_into()
                    .map_err(|_| err(BurnerError::ReferenceInvalid))?,
            );
            if sq == 0 {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            // depth = the WSOL vault, used only for the safe cap
            let (sol_vault, _tok_vault) = if sol_is_0 {
                if v0 == p0 { (&*vault_a, &*vault_b) } else { (&*vault_b, &*vault_a) }
            } else if v1 == p0 {
                (&*vault_a, &*vault_b)
            } else {
                (&*vault_b, &*vault_a)
            };
            let sd = sol_vault.try_borrow()?;
            if sd.len() < 72 || sd.get(0..32) != Some(WSOL_MINT.as_ref()) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            // GROSS DEPTH ONLY. This is the SPL vault's raw `amount`, not the
            // PoolState's currently in-range liquidity and not the amount
            // executable before the next tick. It also includes protocol/fund
            // fees and direct donations. The current-liquidity offset is
            // oracle-verified, but converting it into a conservative SOL amount
            // across tick boundaries needs tick-array state that is not supplied
            // here. Therefore 6040/6041 deliberately retain this approximation.
            // Residual risk: out-of-range liquidity can pass the guards while
            // current active liquidity is thin and the spot is manipulable.
            let depth = read_u64(sd.get(64..72).ok_or(err(BurnerError::ReferenceInvalid))?)?;
            let config = pd.get(9..41).ok_or(err(BurnerError::ReferenceInvalid))?;
            if fee_source.address().as_ref() != config || fee_source.owner() != &RAYDIUM_CLMM {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let fd = fee_source.try_borrow()?;
            if fd.get(0..8) != Some(&[218, 244, 33, 104, 203, 203, 43, 111]) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let fee = keyless_fee(
                u32::from_le_bytes(fd.get(47..51).ok_or(err(BurnerError::ReferenceInvalid))?.try_into().map_err(|_| err(BurnerError::ReferenceInvalid))?) as u64,
                1_000_000,
                false,
            )?;
            let cap = fee_cap(depth, fee)?;
            if amount_in > cap {
                return Err(err(BurnerError::ReferenceCapExceeded));
            }
            let inp = input_after_fee(amount_in, fee)?;
            // price_raw = (sq / 2^64)^2 = token1 raw per token0 raw
            let expected: u128 = if sol_is_0 {
                let t = (inp as u128)
                    .checked_mul(sq)
                    .ok_or(err(BurnerError::InvalidInstructionData))?
                    >> 64;
                t.checked_mul(sq)
                    .ok_or(err(BurnerError::InvalidInstructionData))?
                    >> 64
            } else {
                let t = ((inp as u128) << 64)
                    .checked_div(sq)
                    .ok_or(err(BurnerError::InvalidInstructionData))?;
                // FIXED: the deleted original shifted `t << 64` with NO
                // overflow check, silently discarding any bits of `t` at or
                // above position 64 and deriving a garbage (typically tiny)
                // "expected" — i.e. a floor with no price protection. `t`
                // must fit in 64 bits before the shift. Refusing here loses
                // no representable case: `t >= 2^64` requires `inp >= sq`
                // (and `inp < 2^64` then forces `sq < 2^64`), which puts the
                // true expected output at >= 2^128/sq > u64::MAX — refused
                // downstream regardless.
                if t >> 64 != 0 {
                    return Err(err(BurnerError::InvalidInstructionData));
                }
                (t << 64)
                    .checked_div(sq)
                    .ok_or(err(BurnerError::InvalidInstructionData))?
            };
            // This gates the GROSS WSOL vault amount documented at the read
            // above. It is not a certificate of currently in-range liquidity.
            if depth < MIN_REFERENCE_DEPTH_LAMPORTS {
                return Err(err(BurnerError::ReferenceTooShallow));
            }
            return keyless_floor_from_expected(expected);
        }
        let (va, vb) = if reference.owner() == &RAYDIUM_V4 {
            (336usize, 368usize)
        } else if reference.owner() == &RAYDIUM_CP {
            (72usize, 104usize)
        } else if reference.owner() == &PUMP_SWAP_PROGRAM_ID {
            (139usize, 171usize)
        } else {
            return Err(err(BurnerError::ReferenceInvalid));
        };
        {
            let pd = reference.try_borrow()?;
            let a = pd.get(va..va + 32).ok_or(err(BurnerError::ReferenceInvalid))?;
            let b = pd.get(vb..vb + 32).ok_or(err(BurnerError::ReferenceInvalid))?;
            let p0 = vault_a.address().as_ref();
            let p1 = vault_b.address().as_ref();
            if !((a == p0 && b == p1) || (a == p1 && b == p0)) {
                return Err(err(BurnerError::ReferenceInvalid));
            }
        }
        let ad = vault_a.try_borrow()?;
        let bd = vault_b.try_borrow()?;
        if ad.len() < 72 || bd.len() < 72 {
            return Err(err(BurnerError::ReferenceInvalid));
        }
        let a_mint = ad.get(0..32).ok_or(err(BurnerError::ReferenceInvalid))?;
        let b_mint = bd.get(0..32).ok_or(err(BurnerError::ReferenceInvalid))?;
        let (tok, sol) = if a_mint == target_mint.address().as_ref() && b_mint == WSOL_MINT.as_ref()
        {
            (&ad, &bd)
        } else if b_mint == target_mint.address().as_ref() && a_mint == WSOL_MINT.as_ref() {
            (&bd, &ad)
        } else {
            return Err(err(BurnerError::ReferenceInvalid));
        };
        if tok.get(32..64) != sol.get(32..64) {
            return Err(err(BurnerError::ReferenceInvalid));
        }
        // GROSS RESERVES ONLY. These are the raw SPL vault amounts. For the
        // Raydium V4/CP references they are not reduced by venue-accounted PnL,
        // protocol/fund/creator fees, open-order inventory, or donations. The
        // required venue-specific adjustment fields are not all present in the
        // verified offset oracle (and V4 also needs external orderbook state),
        // so inventing offsets here would create a larger fail-closed/bricking
        // risk. Consequently both cp_out and 6040/6041 below intentionally use
        // gross custody balances. Residual risk: gross quote-side inflation can
        // overstate depth, enlarge the cap, and understate the output floor.
        let base_amt = read_u64(tok.get(64..72).ok_or(err(BurnerError::ReferenceInvalid))?)?;
        let mut quote_amt =
            read_u64(sol.get(64..72).ok_or(err(BurnerError::ReferenceInvalid))?)?;
        let fee = if reference.owner() == &RAYDIUM_V4 {
            if fee_source.address() != reference.address() {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let pd = reference.try_borrow()?;
            keyless_fee(
                read_u64(pd.get(144..152).ok_or(err(BurnerError::ReferenceInvalid))?)?,
                read_u64(pd.get(152..160).ok_or(err(BurnerError::ReferenceInvalid))?)?,
                false,
            )?
        } else if reference.owner() == &RAYDIUM_CP {
            let pd = reference.try_borrow()?;
            let config = pd.get(8..40).ok_or(err(BurnerError::ReferenceInvalid))?;
            if fee_source.address().as_ref() != config || fee_source.owner() != &RAYDIUM_CP {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let fd = fee_source.try_borrow()?;
            keyless_fee(
                read_u64(fd.get(12..20).ok_or(err(BurnerError::ReferenceInvalid))?)?,
                1_000_000,
                false,
            )?
        } else {
            let pd = reference.try_borrow()?;
            let virtual_quote = i128::from_le_bytes(pd.get(245..261).ok_or(err(BurnerError::ReferenceInvalid))?.try_into().map_err(|_| err(BurnerError::ReferenceInvalid))?);
            if virtual_quote < 0 { return Err(err(BurnerError::ReferenceInvalid)); }
            quote_amt = quote_amt
                .checked_add(u64::try_from(virtual_quote).map_err(|_| err(BurnerError::ReferenceInvalid))?)
                .ok_or(err(BurnerError::InvalidInstructionData))?;
            let creator = pd.get(11..43).ok_or(err(BurnerError::ReferenceInvalid))?;
            let expected_creator = Address::find_program_address(
                &[b"pool-authority", target_mint.address().as_ref()],
                &PUMP_FUN_PROGRAM_ID,
            ).0;
            if creator != expected_creator.as_ref() || base_amt == 0 {
                return Err(err(BurnerError::ReferenceInvalid));
            }
            let mint_data = target_mint.try_borrow()?;
            let supply = read_u64(mint_data.get(36..44).ok_or(err(BurnerError::ReferenceInvalid))?)?;
            let market_cap = (quote_amt as u128)
                .checked_mul(supply as u128)
                .ok_or(err(BurnerError::InvalidInstructionData))?
                / base_amt as u128;
            let creator_non_default = pd.get(211..243) != Some(&[0u8; 32]);
            read_fee_config(fee_source, &PUMP_SWAP_PROGRAM_ID, market_cap, true, creator_non_default)?
        };
        (base_amt, quote_amt, fee)
    };
    let cap = fee_cap(rs, fee)?;
    if amount_in > cap {
        return Err(err(BurnerError::ReferenceCapExceeded));
    }
    // Minimum GROSS reference custody on the constant-product tail. The two
    // Pump venues are sentinel-bound and exempt; Raydium V4/CP are gated. `rs`
    // is the unadjusted raw WSOL vault amount documented above, so passing 6041
    // does not prove the same amount participates in venue swap math. Ordered
    // after the cap refusal so an over-cap input remains attributed to 6040.
    if (reference.owner() == &RAYDIUM_V4 || reference.owner() == &RAYDIUM_CP)
        && rs < MIN_REFERENCE_DEPTH_LAMPORTS
    {
        return Err(err(BurnerError::ReferenceTooShallow));
    }
    let inp = input_after_fee(amount_in, fee)?;
    let expected = cp_out(rt, rs, inp).ok_or(err(BurnerError::InvalidInstructionData))?;
    // Tolerance haircut and ZERO GUARDS, shared with the price-based (DLMM /
    // CLMM) references so the two tails cannot drift. `cp_out` returns
    // `Some(0)` (not `None`) when the widening division truncates to zero; a
    // zero floor means `minimum_output = 1` passes and there is effectively no
    // price protection, so BOTH a zero expected output and a zero FINAL floor
    // are rejected (6002) inside the shared tail. Rejected, never clamped to
    // 1: a one-unit output satisfies every other postcondition. The haircut
    // multiply runs in u128 there: the u64 multiply that used to live HERE
    // overflowed for any `expected > u64::MAX / 9_500` (~1.94e15 atoms) and
    // wrongly refused deep, high-supply pools (BONK-scale Raydium reserves)
    // whose true floor fits u64 comfortably. `expected` is a u64, so the
    // shared tail's `> u64::MAX` range refusal is vacuous on this path and
    // the final floor (<= expected) always fits u64.
    keyless_floor_from_expected(expected as u128)
}

pub(crate) fn validate_jupiter_route(
    remaining: &[AccountView],
    jupiter_instruction_data: &[u8],
    amount_in: u64,
    validated: &ValidatedBurner,
    wsol_source: &Address,
    target_token_account: &Address,
) -> ProgramResult {
    match validate_jupiter_route_data(jupiter_instruction_data, amount_in)? {
        JupiterRouteKind::Direct => {
            if remaining.len() < JUPITER_V2_FIXED_ACCOUNTS
                || remaining[JUPITER_SOURCE_TOKEN_PROGRAM_INDEX].address() != &SPL_TOKEN_PROGRAM_ID
                || !remaining[JUPITER_SOURCE_TOKEN_PROGRAM_INDEX].executable()
                || remaining[JUPITER_DESTINATION_TOKEN_PROGRAM_INDEX].address()
                    != &validated.target_program
                || !remaining[JUPITER_DESTINATION_TOKEN_PROGRAM_INDEX].executable()
                || remaining[JUPITER_AUTHORITY_INDEX].address() != &validated.pda
                || remaining[JUPITER_SOURCE_INDEX].address() != wsol_source
                || remaining[JUPITER_USER_DESTINATION_INDEX].address() != target_token_account
                || remaining[JUPITER_SOURCE_MINT_INDEX].address() != &WSOL_MINT
                || remaining[JUPITER_DESTINATION_MINT_INDEX].address() != &validated.target_mint
                || remaining[JUPITER_DESTINATION_INDEX].address() != target_token_account
                || remaining[JUPITER_EVENT_AUTHORITY_INDEX].address() != &JUPITER_EVENT_AUTHORITY
                || remaining[JUPITER_PROGRAM_INDEX].address() != &JUPITER_PROGRAM_ID
            {
                return Err(err(BurnerError::InvalidJupiterAccounts));
            }
        }
        JupiterRouteKind::Shared => {
            if remaining.len() < JUPITER_SHARED_V2_FIXED_ACCOUNTS
                || remaining[JUPITER_SHARED_SOURCE_TOKEN_PROGRAM_INDEX].address()
                    != &SPL_TOKEN_PROGRAM_ID
                || !remaining[JUPITER_SHARED_SOURCE_TOKEN_PROGRAM_INDEX].executable()
                || remaining[JUPITER_SHARED_DESTINATION_TOKEN_PROGRAM_INDEX].address()
                    != &validated.target_program
                || !remaining[JUPITER_SHARED_DESTINATION_TOKEN_PROGRAM_INDEX].executable()
                || remaining[JUPITER_SHARED_AUTHORITY_INDEX].address() != &validated.pda
                || remaining[JUPITER_SHARED_SOURCE_INDEX].address() != wsol_source
                || remaining[JUPITER_SHARED_USER_DESTINATION_INDEX].address()
                    != target_token_account
                || remaining[JUPITER_SHARED_SOURCE_MINT_INDEX].address() != &WSOL_MINT
                || remaining[JUPITER_SHARED_DESTINATION_MINT_INDEX].address()
                    != &validated.target_mint
                || remaining[JUPITER_SHARED_EVENT_AUTHORITY_INDEX].address()
                    != &JUPITER_EVENT_AUTHORITY
                || remaining[JUPITER_SHARED_PROGRAM_INDEX].address() != &JUPITER_PROGRAM_ID
            {
                return Err(err(BurnerError::InvalidJupiterAccounts));
            }
        }
    }

    // The returned route may repeat the PDA or the transaction payer in a
    // non-authority position. That is safe, but NOT for the reason this
    // comment used to give: `invoke_jupiter_route` no longer grants signer
    // privilege at index 1 alone — it grants the PDA's signature at every
    // position the PDA occupies (see the rationale there).
    //
    // What actually holds: CPI metas are rebuilt from scratch, and the only
    // signature ever granted is the burn PDA's own. Checking AccountView's
    // outer signer bit here would be wrong because Solana unions privileges
    // when a route repeats the caller (or whatever sits in the reserved
    // slot 1). Those signatures are still withheld in the rebuilt CPI; a
    // route that truly requires one fails privilege escalation. Everything the PDA's own signature could do
    // is pinned afterwards — lamports, WSOL balance and authority, target burn,
    // and the PDA's owner and data buffer.
    Ok(())
}

fn validate_jupiter_route_data(
    data: &[u8],
    amount_in: u64,
) -> Result<JupiterRouteKind, ProgramError> {
    let (kind, prefix_len, in_amount_offset, platform_fee_offset, positive_fee_offset) =
        if data.len() >= 8 && data[..8] == JUPITER_ROUTE_V2_DISCRIMINATOR {
            (
                JupiterRouteKind::Direct,
                JUPITER_V2_ARGS_PREFIX_LEN,
                JUPITER_V2_IN_AMOUNT_OFFSET,
                JUPITER_V2_PLATFORM_FEE_OFFSET,
                JUPITER_V2_POSITIVE_SLIPPAGE_FEE_OFFSET,
            )
        } else if data.len() >= 8 && data[..8] == JUPITER_SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR {
            (
                JupiterRouteKind::Shared,
                JUPITER_SHARED_V2_ARGS_PREFIX_LEN,
                JUPITER_SHARED_V2_IN_AMOUNT_OFFSET,
                JUPITER_SHARED_V2_PLATFORM_FEE_OFFSET,
                JUPITER_SHARED_V2_POSITIVE_SLIPPAGE_FEE_OFFSET,
            )
        } else {
            return Err(err(BurnerError::InvalidJupiterInstruction));
        };
    if data.len() < prefix_len {
        return Err(err(BurnerError::InvalidJupiterInstruction));
    }
    if read_u64(&data[in_amount_offset..in_amount_offset + 8])? != amount_in {
        return Err(err(BurnerError::JupiterInputAmountMismatch));
    }
    let platform_fee_bps =
        u16::from_le_bytes([data[platform_fee_offset], data[platform_fee_offset + 1]]);
    let positive_slippage_fee_bps =
        u16::from_le_bytes([data[positive_fee_offset], data[positive_fee_offset + 1]]);
    if platform_fee_bps != 0 || positive_slippage_fee_bps != 0 {
        return Err(err(BurnerError::JupiterPlatformFeeNotAllowed));
    }
    Ok(kind)
}

pub(crate) fn fund_wsol(
    accounts: &BurnerAccounts<'_>,
    signer: &Signer,
    amount_in: u64,
) -> Result<u64, ProgramError> {
    // Synchronise first so an unsolicited raw lamport cannot brick a burn. It
    // is deliberately excluded from this route and remains in WSOL afterwards.
    sync_native(accounts)?;
    let before = read_token_amount(accounts.wsol_source)?;

    let mut transfer_data = [0u8; 12];
    transfer_data[..4].copy_from_slice(&2u32.to_le_bytes());
    transfer_data[4..].copy_from_slice(&amount_in.to_le_bytes());
    let transfer_accounts = [
        InstructionAccount::writable_signer(accounts.burn_pda.address()),
        InstructionAccount::writable(accounts.wsol_source.address()),
    ];
    invoke_signed(
        &InstructionView {
            program_id: &SYSTEM_PROGRAM_ID,
            data: &transfer_data,
            accounts: &transfer_accounts,
        },
        &[accounts.burn_pda, accounts.wsol_source],
        core::slice::from_ref(signer),
    )?;

    sync_native(accounts)?;
    let after = read_token_amount(accounts.wsol_source)?;
    if after.checked_sub(before) != Some(amount_in) {
        return Err(err(BurnerError::WsolFundingMismatch));
    }
    Ok(before)
}

/// Hands the route to Jupiter with the burn PDA's signature, and nothing else.
///
/// Signer privilege is granted at every position where the account IS the burn
/// PDA, not only at `userTransferAuthority`. A Jupiter route through the
/// Pump.fun bonding curve places the user at three positions (transfer
/// authority, the curve's `user`, and the creator-fee `user`), and pinning the
/// grant to index 1 left the other two unsigned, so Jupiter's inner CPI failed
/// to escalate and every pre-graduation Pump token was unburnable.
///
/// This grants only the PDA's own signature. The caller's and the quote
/// authority's signatures are still withheld at every position, so a route can
/// never borrow an outer signature — which is the property the index pin was
/// actually protecting.
///
/// The PDA's signature at a *writable* position does let a route move the
/// PDA's lamports or reassign the account, so both are checked afterwards:
/// `verify_swap_postconditions` pins the lamport delta to exactly `amount_in`,
/// and `verify_pda_still_a_bare_system_account` rejects a changed owner or a
/// non-empty data buffer.
pub(crate) fn invoke_jupiter_route(
    remaining: &[AccountView],
    jupiter_instruction_data: &[u8],
    pda: &Address,
    signer: &Signer,
) -> ProgramResult {
    let mut metas = Vec::with_capacity(remaining.len());
    for account in remaining.iter() {
        metas.push(InstructionAccount::new(
            account.address(),
            account.is_writable(),
            account.address() == pda,
        ));
    }
    invoke_signed_with_slice(
        &InstructionView {
            program_id: &JUPITER_PROGRAM_ID,
            data: jupiter_instruction_data,
            accounts: &metas,
        },
        remaining,
        core::slice::from_ref(signer),
    )
}

pub(crate) fn verify_swap_postconditions(
    accounts: &BurnerAccounts<'_>,
    validated: &ValidatedBurner,
    amount_in: u64,
    wsol_before: u64,
    pda_lamports_before: u64,
    validated_lamport_credit: u64,
    minimum_output: u64,
) -> Result<u64, ProgramError> {
    if read_token_amount(accounts.wsol_source)? != wsol_before {
        return Err(err(BurnerError::WsolNotFullyConsumed));
    }
    // Fail closed: an underflow here must revert rather than silently degrade
    // the invariant to "PDA must be empty".
    let expected_pda_lamports = expected_pda_lamports_after_route(
        pda_lamports_before,
        amount_in,
        validated_lamport_credit,
    )?;
    if accounts.burn_pda.lamports() != expected_pda_lamports {
        return Err(err(BurnerError::BurnPdaLamportMismatch));
    }
    let target_after = read_token_amount(accounts.target_token_account)?;
    let received = target_after
        .checked_sub(validated.target_before)
        .ok_or(err(BurnerError::TargetBalanceDecreased))?;
    if received < minimum_output {
        return Err(err(BurnerError::SlippageExceeded));
    }
    Ok(target_after)
}

pub(crate) fn burn_target(
    accounts: &BurnerAccounts<'_>,
    validated: &ValidatedBurner,
    amount_to_burn: u64,
    signer: &Signer,
) -> ProgramResult {
    let mut data = [0u8; 10];
    data[0] = TOKEN_BURN_CHECKED_DISCRIMINATOR;
    data[1..9].copy_from_slice(&amount_to_burn.to_le_bytes());
    data[9] = validated.target_decimals;
    let burn_accounts = [
        InstructionAccount::writable(accounts.target_token_account.address()),
        InstructionAccount::writable(accounts.target_mint.address()),
        InstructionAccount::readonly_signer(accounts.burn_pda.address()),
    ];
    invoke_signed(
        &InstructionView {
            program_id: &validated.target_program,
            data: &data,
            accounts: &burn_accounts,
        },
        &[
            accounts.target_token_account,
            accounts.target_mint,
            accounts.burn_pda,
        ],
        core::slice::from_ref(signer),
    )?;
    if read_token_amount(accounts.target_token_account)? != 0 {
        return Err(err(BurnerError::BurnIncomplete));
    }
    // The route ran with the PDA's signature; re-assert that it left no
    // delegate or close authority behind on the target ATA.
    verify_no_standing_claims(&accounts.target_token_account.try_borrow()?)?;
    Ok(())
}

/// A bare System account: what every address is before anything has been
/// created at it, and what a lamport donation alone leaves unchanged.
#[inline(always)]
pub(crate) fn is_bare_system_account(account: &AccountView) -> bool {
    account.owner() == &SYSTEM_PROGRAM_ID && account.is_data_empty()
}

/// The burn PDA must still be the bare, System-owned, zero-data account its
/// address was derived for.
///
/// `invoke_jupiter_route` grants the PDA's signature at writable positions, so
/// a route could in principle `Assign` the account to another program or give
/// it a data buffer while leaving its lamports untouched — invisible to the
/// lamport postcondition, and fatal on the next burn. Check it directly.
pub(crate) fn verify_pda_still_a_bare_system_account(burn_pda: &AccountView) -> ProgramResult {
    if !is_bare_system_account(burn_pda) {
        return Err(err(BurnerError::InvalidBurnPda));
    }
    Ok(())
}

/// The WSOL account must still be a native account the PDA controls.
///
/// Its authority is validated once before the swap, and the end-of-call sweep
/// deliberately exempts it because it legitimately keeps a resting balance —
/// so nothing else would notice a `SetAuthority` on it. The PDA's signature is
/// granted to the route, and the PDA is that authority, so re-assert it. A
/// hijacked WSOL account would drain the resting balance and brick every
/// future burn for this vault, which has no withdrawal instruction to recover
/// from. The real Jupiter program never issues `SetAuthority`; this is
/// defence in depth behind the program-ID pin.
pub(crate) fn verify_wsol_account_still_ours(
    wsol_source: &AccountView,
    pda: &Address,
) -> ProgramResult {
    validate_wsol_account(wsol_source, &WSOL_MINT, pda)
}

/// Snapshot the only external lamport credit an honest V2 Pump route returns
/// to the burn PDA.
///
/// Pump.fun and PumpSwap V2 close their per-user volume accumulator after a
/// buy. The close returns that account's exact lamports to `user`, which is
/// the signer-pinned burn PDA. Treating the refund as unexplained income would
/// fail the otherwise exact 6019 conservation check and make both venues
/// unusable. This is not a tolerance: admission is restricted to the exact
/// derived PDA under either pinned Pump program, with the exact account
/// discriminator and stored user. The exact pre-route balance is snapshotted,
/// and the account must be fully closed after Jupiter before one lamport is
/// credited to the postcondition.
pub(crate) fn snapshot_pump_lamport_credits(
    remaining: &[AccountView],
    pda: &Address,
) -> Result<Vec<PumpLamportCredit>, ProgramError> {
    let credit_addresses = derive_pump_credit_addresses(pda);
    let mut snapshots = Vec::with_capacity(2);
    for (index, account) in remaining.iter().enumerate() {
        let Some(program) = credit_addresses
            .iter()
            .find(|(address, _)| address == account.address())
            .map(|(_, program)| *program)
        else {
            continue;
        };

        // An absent accumulator is a System account and contributes no
        // credit; Pump may create and close it within the route with net-zero
        // lamport effect. Any other owner at the exact derived address is
        // malformed and fails closed.
        if account.owner() == &SYSTEM_PROGRAM_ID && account.is_data_empty() {
            continue;
        }
        let data = account.try_borrow()?;
        let lamports = account.lamports();
        validate_pump_credit_layout(
            account.owner(),
            program,
            account.is_writable(),
            &data,
            lamports,
            pda,
        )?;
        push_unique_pump_credit(
            &mut snapshots,
            PumpLamportCredit {
                account_index: index,
                address: account.address().clone(),
                lamports,
            },
        );
    }
    Ok(snapshots)
}

/// The two admissible Pump credit addresses, derived ONCE from the burn PDA.
///
/// These are a pure function of the vault address, so they MUST be hoisted
/// out of any per-account scan: `find_program_address` costs ~1,500 CU per
/// bump probe, and the number of probes is a fixed, immutable property of the
/// vault address. Deriving per scanned account multiplied that fixed cost by
/// the route width (and, in the split handler, by a second whole-call scan),
/// which at unlucky vault addresses exhausted the 1.4M CU budget and made the
/// vault permanently unburnable. Admission is unchanged: an account is a
/// credit candidate if and only if its address equals one of these two exact
/// canonical derivations, checked in the same order as before (Pump.fun
/// first, then PumpSwap).
fn derive_pump_credit_addresses(pda: &Address) -> [(Address, &'static Address); 2] {
    [&PUMP_FUN_PROGRAM_ID, &PUMP_SWAP_PROGRAM_ID].map(|program| {
        (
            Address::find_program_address(&[b"user_volume_accumulator", pda.as_ref()], program).0,
            program,
        )
    })
}

/// Test-only wrapper preserving the original per-account lookup contract.
#[cfg(test)]
fn pump_credit_program(address: &Address, pda: &Address) -> Option<&'static Address> {
    derive_pump_credit_addresses(pda)
        .into_iter()
        .find(|(candidate, _)| candidate == address)
        .map(|(_, program)| program)
}

fn validate_pump_credit_layout(
    owner: &Address,
    expected_program: &Address,
    writable: bool,
    data: &[u8],
    lamports: u64,
    pda: &Address,
) -> ProgramResult {
    if owner != expected_program
        || !writable
        || lamports == 0
        || data.len() < 40
        || data[..8] != PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR
        || data[8..40] != pda.as_ref()[..]
    {
        return Err(err(BurnerError::BurnPdaLamportMismatch));
    }
    Ok(())
}

fn push_unique_pump_credit(snapshots: &mut Vec<PumpLamportCredit>, candidate: PumpLamportCredit) {
    if !snapshots
        .iter()
        .any(|snapshot| snapshot.address == candidate.address)
    {
        snapshots.push(candidate);
    }
}

/// Require every admitted Pump credit account to have been closed exactly,
/// then return the checked sum of its snapshotted lamports.
pub(crate) fn verify_pump_lamport_credits(
    remaining: &[AccountView],
    snapshots: &[PumpLamportCredit],
) -> Result<u64, ProgramError> {
    let mut total = 0u64;
    for snapshot in snapshots {
        let account = remaining
            .get(snapshot.account_index)
            .filter(|account| account.address() == &snapshot.address)
            .ok_or(err(BurnerError::BurnPdaLamportMismatch))?;
        validate_closed_pump_credit(account.owner(), account.is_data_empty(), account.lamports())?;
        total = total
            .checked_add(snapshot.lamports)
            .ok_or(err(BurnerError::BurnPdaLamportMismatch))?;
    }
    Ok(total)
}

/// DIRECTCURVE + KEYLESS split: partition a whole-call accumulator snapshot
/// into (curve-leg, jupiter-leg) sets by pool-relative account index. A curve
/// leg's accumulator stays open (proven untouched, credit 0); a Jupiter leg's
/// closes (credit = its snapshotted lamports). `is_curve_index` receives each
/// snapshot's pool-relative `account_index`; the field stays private to this
/// module. When there are no curve legs (every leg Jupiter) the curve set is
/// empty and the jupiter set equals the input, so the split path's behaviour
/// is byte-identical to the pre-directcurve reconciliation.
pub(crate) fn partition_pump_credits(
    snapshots: &[PumpLamportCredit],
    is_curve_index: impl Fn(usize) -> bool,
) -> (Vec<PumpLamportCredit>, Vec<PumpLamportCredit>) {
    let mut curve = Vec::new();
    let mut jupiter = Vec::new();
    for snapshot in snapshots {
        if is_curve_index(snapshot.account_index) {
            curve.push(snapshot.clone());
        } else {
            jupiter.push(snapshot.clone());
        }
    }
    (curve, jupiter)
}

/// DIRECTCURVE only: the direct Pump buy must leave every snapshotted
/// accumulator with EXACTLY its snapshotted lamports (Pump may update its
/// data, but any lamport movement through it would be unaccounted vault
/// income or outflow). Exact equality; reuses 6019.
pub(crate) fn verify_pump_credits_untouched(
    remaining: &[AccountView],
    snapshots: &[PumpLamportCredit],
) -> ProgramResult {
    for snapshot in snapshots {
        let account = remaining
            .get(snapshot.account_index)
            .filter(|account| account.address() == &snapshot.address)
            .ok_or(err(BurnerError::BurnPdaLamportMismatch))?;
        if account.lamports() != snapshot.lamports {
            return Err(err(BurnerError::BurnPdaLamportMismatch));
        }
    }
    Ok(())
}

fn validate_closed_pump_credit(owner: &Address, data_empty: bool, lamports: u64) -> ProgramResult {
    if owner != &SYSTEM_PROGRAM_ID || !data_empty || lamports != 0 {
        return Err(err(BurnerError::BurnPdaLamportMismatch));
    }
    Ok(())
}

fn expected_pda_lamports_after_route(
    before: u64,
    amount_in: u64,
    validated_credit: u64,
) -> Result<u64, ProgramError> {
    before
        .checked_sub(amount_in)
        .and_then(|balance| balance.checked_add(validated_credit))
        .ok_or(err(BurnerError::BurnPdaLamportMismatch))
}

pub(crate) fn sum_pump_lamport_credits(
    snapshots: &[PumpLamportCredit],
) -> Result<u64, ProgramError> {
    snapshots.iter().try_fold(0u64, |total, snapshot| {
        total
            .checked_add(snapshot.lamports)
            .ok_or(err(BurnerError::BurnPdaLamportMismatch))
    })
}

pub(crate) fn validate_burn_remainder(balance: u64, rent_floor: u64) -> ProgramResult {
    if balance != 0 && balance < rent_floor {
        return Err(err(BurnerError::BurnRemainderBelowRentFloor));
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct PdaTokenAccountSnapshot {
    owned_before: bool,
    amount_before: u64,
}

/// Record which route accounts are PDA-owned token accounts, and their exact
/// token amounts, BEFORE any route runs.
///
/// The post-route sweep cannot simply ask "is this account ours?" at the end:
/// the route is handed the PDA's signature, so a hostile program at the pinned
/// Jupiter id could `SetAuthority` an intermediate away from the PDA precisely
/// so the sweep skips it, and walk off with whatever it still holds. Comparing
/// against a before-snapshot closes that: an account that WAS ours must still
/// be ours. The amount protects later target ATAs before their leg starts and
/// lets the final sweep distinguish an unchanged unsolicited balance from
/// value that disappeared without being covered by a target burn.
pub(crate) fn snapshot_pda_token_accounts(
    remaining: &[AccountView],
    pda: &Address,
) -> Result<Vec<PdaTokenAccountSnapshot>, ProgramError> {
    // Instruction metas may repeat the same locked account, so their count is
    // not bounded by Solana's unique-account lock limit. Keep one compact value
    // per meta instead of incorrectly rejecting a valid route wider than 64.
    let mut snapshot = Vec::with_capacity(remaining.len());
    for account in remaining {
        let owner = account.owner();
        let ours = (owner == &SPL_TOKEN_PROGRAM_ID || owner == &SPL_TOKEN_2022_PROGRAM_ID)
            && token_account_is_controlled_by(account, pda)?;
        snapshot.push(PdaTokenAccountSnapshot {
            owned_before: ours,
            amount_before: if ours { read_token_amount(account)? } else { 0 },
        });
    }
    Ok(snapshot)
}

/// When a leg's target ATA is present in the route pool, require it to carry
/// exactly the amount it held before the whole split call began. Absence is a
/// deliberate pass because an account not handed to the router was unreachable
/// to every earlier router CPI.
pub(crate) fn verify_target_pre_call_balance(
    remaining: &[AccountView],
    snapshot: &[PdaTokenAccountSnapshot],
    target_token_account: &Address,
    current_amount: u64,
) -> ProgramResult {
    if snapshot.len() != remaining.len() {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    let mut found = false;
    for (account, before) in remaining.iter().zip(snapshot.iter()) {
        if account.address() != target_token_account {
            continue;
        }
        found = true;
        if !before.owned_before || before.amount_before != current_amount {
            return Err(err(BurnerError::TargetPreCallBalanceMismatch));
        }
    }
    // NOT found is a PASS, deliberately. Solana only lets a program touch
    // accounts it was handed, and the route pool is exactly what the swap CPI
    // is handed. An ATA absent from the pool was therefore never reachable by
    // the route and cannot have been mutated by it. Refusing here instead
    // would reject every legitimate route whose pool does not happen to
    // restate the destination ATA, and would fire 6006 BEFORE the in_amount
    // pin -- destroying the 6008-before-6006 ordering the split-division
    // oracle depends on (see CLAUDE.md).
    let _ = found;
    Ok(())
}

pub(crate) fn verify_no_intermediate_balances(
    remaining: &[AccountView],
    pda: &Address,
    wsol_source: &Address,
    burned_targets: &[(&Address, u64)],
    snapshot: Vec<PdaTokenAccountSnapshot>,
) -> ProgramResult {
    if snapshot.len() != remaining.len() {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    if burned_targets.len() > crate::constants::MAX_SPLIT_TARGETS {
        return Err(err(BurnerError::InvalidSplitTargetCount));
    }
    let mut pre_existing_by_target = [0u64; crate::constants::MAX_SPLIT_TARGETS];
    for (index, account) in remaining.iter().enumerate() {
        let key = account.address();
        if key == wsol_source {
            continue;
        }
        // Route layouts repeat accounts (the direct route repeats its target
        // ATA, and every split leg repeats the PDA and WSOL account). Account
        // value is counted once per locked address, not once per meta.
        if remaining[..index]
            .iter()
            .any(|previous| previous.address() == key)
        {
            continue;
        }
        let owner = account.owner();
        let is_token_account =
            owner == &SPL_TOKEN_PROGRAM_ID || owner == &SPL_TOKEN_2022_PROGRAM_ID;
        let ours_now = is_token_account && token_account_is_controlled_by(account, pda)?;

        if snapshot[index].owned_before {
            // It was ours going in. It must still be ours and carry no
            // standing claim that a later transaction could use.
            if !ours_now {
                return Err(err(BurnerError::IntermediateBalanceRemaining));
            }
            verify_no_standing_claims(&account.try_borrow()?)?;

            let amount_now = read_token_amount(account)?;
            let target_index = {
                let data = account.try_borrow()?;
                let mint = data
                    .get(0..32)
                    .ok_or(err(BurnerError::InvalidTokenAccountData))?;
                burned_targets
                    .iter()
                    .position(|(target_mint, _)| mint == target_mint.as_ref())
            };
            if let Some(target_index) = target_index {
                // An unsolicited target-mint balance may remain exactly
                // unchanged. If the route did touch it, preserve the existing
                // no-residual rule: it must finish empty, and the burn below
                // must cover everything that disappeared from this account.
                // This lets an ordinary route source move its entry value into
                // the target ATA and have it burned without treating a resting
                // donation as a reason to disable the vault.
                if amount_now == snapshot[index].amount_before {
                    continue;
                }
                if amount_now != 0 {
                    return Err(err(BurnerError::IntermediateBalanceRemaining));
                }
                pre_existing_by_target[target_index] = pre_existing_by_target[target_index]
                    .checked_add(snapshot[index].amount_before)
                    .ok_or(err(BurnerError::PreExistingTokenBalanceUnaccounted))?;
            } else if amount_now != snapshot[index].amount_before {
                // No leg can burn this mint. Its entry balance therefore has
                // exactly one legitimate end state: still resting here. This
                // admits unsolicited donations without letting a route erase
                // them under the old "ended empty" outcome.
                return Err(err(BurnerError::PreExistingTokenBalanceUnaccounted));
            }
        } else if ours_now && read_token_amount(account)? != 0 {
            // It became ours during the route and kept a balance.
            return Err(err(BurnerError::IntermediateBalanceRemaining));
        }
    }
    for (index, (_, burned_amount)) in burned_targets.iter().enumerate() {
        if pre_existing_by_target[index] > *burned_amount {
            return Err(err(BurnerError::PreExistingTokenBalanceUnaccounted));
        }
    }
    Ok(())
}

fn sync_native(accounts: &BurnerAccounts<'_>) -> ProgramResult {
    let sync_accounts = [InstructionAccount::writable(accounts.wsol_source.address())];
    invoke(
        &InstructionView {
            program_id: &SPL_TOKEN_PROGRAM_ID,
            data: &[TOKEN_SYNC_NATIVE_DISCRIMINATOR],
            accounts: &sync_accounts,
        },
        &[accounts.wsol_source],
    )
}

pub(crate) fn associated_token_address(
    owner: &Address,
    mint: &Address,
    token_program: &Address,
) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// `Rent::get()?.minimum_balance(0)` exactly as the Solana SDK computes it.
///
/// Deliberately NOT `pinocchio::sysvars::rent::Rent`: pinocchio 0.11.2 loads
/// only the first 8 bytes of the sysvar (`lamports_per_byte_year`) and
/// multiplies them directly, silently ignoring `exemption_threshold` — on
/// mainnet that halves the floor (445_440 instead of 890_880). This helper
/// instead uses the same `sol_get_rent_sysvar` syscall Anchor's `Rent::get()`
/// uses (`solana-sysvar`'s `impl_sysvar_get!(sol_get_rent_sysvar)`) and the
/// same `((128 + data_len) * lamports_per_byte_year) as f64 *
/// exemption_threshold` arithmetic as `solana-rent`'s `minimum_balance`, so
/// both builds derive an identical floor from identical bytes under any
/// cluster rent configuration.
pub(crate) fn rent_minimum_balance_zero_data() -> Result<u64, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        /// `solana-rent`'s `ACCOUNT_STORAGE_OVERHEAD`.
        const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

        /// The rent sysvar in the exact `#[repr(C)]` layout
        /// `sol_get_rent_sysvar` writes (`solana-rent`'s `Rent`: 8 + 8 + 1,
        /// size 24 with tail padding).
        #[repr(C)]
        struct RentSysvar {
            lamports_per_byte_year: u64,
            exemption_threshold: f64,
            _burn_percent: u8,
        }

        let mut rent = core::mem::MaybeUninit::<RentSysvar>::uninit();
        // `solana-define-syscall` 5.x deprecates this in favour of the generic
        // `sol_get_sysvar`, but it is the exact syscall the Anchor reference
        // still calls and remains a permanent part of the runtime ABI.
        #[allow(deprecated)]
        let result =
            unsafe { pinocchio::syscalls::sol_get_rent_sysvar(rent.as_mut_ptr() as *mut u8) };
        if result != pinocchio::SUCCESS {
            return Err(ProgramError::UnsupportedSysvar);
        }
        // SAFETY: on success the syscall wrote a complete `Rent` value.
        let rent = unsafe { rent.assume_init() };
        Ok(
            ((ACCOUNT_STORAGE_OVERHEAD * rent.lamports_per_byte_year) as f64
                * rent.exemption_threshold) as u64,
        )
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        // No runtime to serve the sysvar off-chain; mirrors the default
        // `pinocchio::sysvars::Sysvar::get`.
        Err(ProgramError::UnsupportedSysvar)
    }
}

pub(crate) fn read_u64(bytes: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| err(BurnerError::InvalidInstructionData))?,
    ))
}

pub(crate) fn read_u32(bytes: &[u8]) -> Result<u32, ProgramError> {
    Ok(u32::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| err(BurnerError::InvalidInstructionData))?,
    ))
}

/// Compact burn-result log without linking `format!`. Logged as
/// `Program log: 0x... 0x...`.
#[inline(always)]
pub(crate) fn log_burn(amount_in: u64, burned: u64) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    unsafe {
        pinocchio::syscalls::sol_log_64_(0, 0, 0, amount_in, burned)
    };
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (amount_in, burned);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMOUNT: u64 = 20_000_000;

    fn route_data(shared: bool) -> Vec<u8> {
        let mut data = Vec::new();
        if shared {
            data.extend_from_slice(&JUPITER_SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR);
            data.push(0); // shared-account id
        } else {
            data.extend_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
        }
        data.extend_from_slice(&AMOUNT.to_le_bytes());
        data.extend_from_slice(&1_000_000u64.to_le_bytes());
        data.extend_from_slice(&100u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data
    }

    #[test]
    fn accepts_only_v2_exact_in_layouts() {
        assert_eq!(
            validate_jupiter_route_data(&route_data(false), AMOUNT).unwrap(),
            JupiterRouteKind::Direct
        );
        assert_eq!(
            validate_jupiter_route_data(&route_data(true), AMOUNT).unwrap(),
            JupiterRouteKind::Shared
        );

        let mut legacy = route_data(false);
        legacy[..8].copy_from_slice(&[0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]);
        assert_eq!(
            validate_jupiter_route_data(&legacy, AMOUNT),
            Err(err(BurnerError::InvalidJupiterInstruction))
        );
    }

    #[test]
    fn rejects_v2_input_amount_mismatch() {
        assert_eq!(
            validate_jupiter_route_data(&route_data(false), AMOUNT + 1),
            Err(err(BurnerError::JupiterInputAmountMismatch))
        );
        assert_eq!(
            validate_jupiter_route_data(&route_data(true), AMOUNT + 1),
            Err(err(BurnerError::JupiterInputAmountMismatch))
        );
    }

    #[test]
    fn rejects_both_v2_fee_channels() {
        for shared in [false, true] {
            let fee_offset = if shared {
                JUPITER_SHARED_V2_PLATFORM_FEE_OFFSET
            } else {
                JUPITER_V2_PLATFORM_FEE_OFFSET
            };
            for offset in [fee_offset, fee_offset + 2] {
                let mut data = route_data(shared);
                data[offset..offset + 2].copy_from_slice(&1u16.to_le_bytes());
                assert_eq!(
                    validate_jupiter_route_data(&data, AMOUNT),
                    Err(err(BurnerError::JupiterPlatformFeeNotAllowed))
                );
            }
        }
    }

    #[test]
    fn rejects_truncated_v2_prefixes() {
        for shared in [false, true] {
            let mut data = route_data(shared);
            data.truncate(data.len() - 1);
            assert_eq!(
                validate_jupiter_route_data(&data, AMOUNT),
                Err(err(BurnerError::InvalidJupiterInstruction))
            );
        }
    }

    fn pump_accumulator_data(user: &Address) -> Vec<u8> {
        let mut data = vec![0u8; 137];
        data[..8].copy_from_slice(&PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR);
        data[8..40].copy_from_slice(user.as_ref());
        data
    }

    #[test]
    fn pump_credit_admission_is_exact_and_nonzero() {
        let user = Address::new_from_array([9; 32]);
        let (pumpfun_accumulator, _) = Address::find_program_address(
            &[b"user_volume_accumulator", user.as_ref()],
            &PUMP_FUN_PROGRAM_ID,
        );
        let data = pump_accumulator_data(&user);

        assert_eq!(
            pump_credit_program(&pumpfun_accumulator, &user),
            Some(&PUMP_FUN_PROGRAM_ID)
        );
        assert!(validate_pump_credit_layout(
            &PUMP_FUN_PROGRAM_ID,
            &PUMP_FUN_PROGRAM_ID,
            true,
            &data,
            1_844_400,
            &user,
        )
        .is_ok());

        let wrong_user = Address::new_from_array([8; 32]);
        let wrong_data = pump_accumulator_data(&wrong_user);
        for result in [
            validate_pump_credit_layout(
                &PUMP_SWAP_PROGRAM_ID,
                &PUMP_FUN_PROGRAM_ID,
                true,
                &data,
                1_844_400,
                &user,
            ),
            validate_pump_credit_layout(
                &PUMP_FUN_PROGRAM_ID,
                &PUMP_FUN_PROGRAM_ID,
                true,
                &wrong_data,
                1_844_400,
                &user,
            ),
            validate_pump_credit_layout(
                &PUMP_FUN_PROGRAM_ID,
                &PUMP_FUN_PROGRAM_ID,
                false,
                &data,
                1_844_400,
                &user,
            ),
            validate_pump_credit_layout(
                &PUMP_FUN_PROGRAM_ID,
                &PUMP_FUN_PROGRAM_ID,
                true,
                &data,
                0,
                &user,
            ),
        ] {
            assert_eq!(result, Err(err(BurnerError::BurnPdaLamportMismatch)));
        }

        // An accumulator derived for any other user is not admitted at all.
        assert_eq!(pump_credit_program(&pumpfun_accumulator, &wrong_user), None);
    }

    /// EXECUTABLE behaviour-identity proof for the accumulator-derivation
    /// hoist: the pre-fix per-account algorithm, reimplemented here verbatim
    /// (loop the two pinned Pump programs in order, derive, compare, first
    /// match wins), must agree with the hoisted `derive_pump_credit_addresses`
    /// path on every input -- the two exact accumulator addresses under both
    /// programs, and pseudo-random address/PDA pairs where both must return
    /// `None`. `find_program_address` is a pure function of (seeds, program),
    /// so per-account and per-call derivation cannot disagree; this asserts
    /// that by execution instead of argument.
    #[test]
    fn hoisted_credit_derivation_matches_the_old_per_account_algorithm() {
        fn old_per_account(address: &Address, pda: &Address) -> Option<&'static Address> {
            for program in [&PUMP_FUN_PROGRAM_ID, &PUMP_SWAP_PROGRAM_ID] {
                let (expected, _) = Address::find_program_address(
                    &[b"user_volume_accumulator", pda.as_ref()],
                    program,
                );
                if address == &expected {
                    return Some(program);
                }
            }
            None
        }

        // Deterministic pseudo-random 32-byte generator (xorshift64*), so the
        // case set is reproducible without a dev-dependency.
        let mut state = 0x243F_6A88_85A3_08D3u64;
        let mut next_address = move || {
            let mut bytes = [0u8; 32];
            for chunk in bytes.chunks_mut(8) {
                state ^= state >> 12;
                state ^= state << 25;
                state ^= state >> 27;
                let word = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
                chunk.copy_from_slice(&word.to_le_bytes());
            }
            Address::new_from_array(bytes)
        };

        for _ in 0..64 {
            let pda = next_address();
            let hoisted = derive_pump_credit_addresses(&pda);
            // Exact accumulator addresses: identical program identity, and the
            // hoisted table preserves the Pump.fun-then-PumpSwap probe order.
            assert_eq!(hoisted[0].1, &PUMP_FUN_PROGRAM_ID);
            assert_eq!(hoisted[1].1, &PUMP_SWAP_PROGRAM_ID);
            for (expected_address, program) in &hoisted {
                assert_eq!(old_per_account(expected_address, &pda), Some(*program));
                assert_eq!(pump_credit_program(expected_address, &pda), Some(*program));
            }
            // Arbitrary non-matching addresses, and the other vault's own
            // accumulators: both algorithms must refuse identically.
            let unrelated = next_address();
            assert_eq!(old_per_account(&unrelated, &pda), None);
            assert_eq!(pump_credit_program(&unrelated, &pda), None);
            let other_pda = next_address();
            for (expected_address, _) in &derive_pump_credit_addresses(&other_pda) {
                assert_eq!(
                    old_per_account(expected_address, &pda),
                    pump_credit_program(expected_address, &pda),
                );
            }
        }
    }

    #[test]
    fn pump_credit_duplicates_count_once() {
        let address = Address::new_from_array([7; 32]);
        let candidate = PumpLamportCredit {
            account_index: 1,
            address: address.clone(),
            lamports: 1_844_400,
        };
        let mut snapshots = Vec::new();
        push_unique_pump_credit(&mut snapshots, candidate.clone());
        push_unique_pump_credit(
            &mut snapshots,
            PumpLamportCredit {
                account_index: 8,
                address,
                lamports: 1_844_400,
            },
        );
        assert_eq!(snapshots, vec![candidate]);
    }

    #[test]
    fn pump_credit_requires_full_close_and_exact_destination() {
        assert!(validate_closed_pump_credit(&SYSTEM_PROGRAM_ID, true, 0).is_ok());
        for result in [
            validate_closed_pump_credit(&PUMP_FUN_PROGRAM_ID, true, 0),
            validate_closed_pump_credit(&SYSTEM_PROGRAM_ID, false, 0),
            validate_closed_pump_credit(&SYSTEM_PROGRAM_ID, true, 1),
        ] {
            assert_eq!(result, Err(err(BurnerError::BurnPdaLamportMismatch)));
        }

        let before = 30_000_000;
        let amount = 20_000_000;
        let credit = 1_844_400;
        let expected = expected_pda_lamports_after_route(before, amount, credit).unwrap();
        assert_eq!(expected, 11_844_400);
        // Partial or misdirected credit cannot satisfy the exact equation.
        assert_ne!(before - amount, expected);
        assert_ne!(before - amount + credit - 1, expected);
    }

    #[test]
    fn validated_pump_credit_is_included_in_the_early_rent_floor() {
        let amount = 20_000_000;
        let rent_floor = 890_880;
        let uncredited_remainder = rent_floor - 1;
        assert_eq!(
            validate_burn_remainder(uncredited_remainder, rent_floor),
            Err(err(BurnerError::BurnRemainderBelowRentFloor))
        );

        let expected =
            expected_pda_lamports_after_route(amount + uncredited_remainder, amount, 1_844_400)
                .unwrap();
        assert_eq!(expected, 2_735_279);
        assert!(validate_burn_remainder(expected, rent_floor).is_ok());
    }

    #[test]
    fn pump_credit_sum_fails_closed_on_overflow() {
        let snapshots = [
            PumpLamportCredit {
                account_index: 0,
                address: Address::new_from_array([1; 32]),
                lamports: u64::MAX,
            },
            PumpLamportCredit {
                account_index: 1,
                address: Address::new_from_array([2; 32]),
                lamports: 1,
            },
        ];
        assert_eq!(
            sum_pump_lamport_credits(&snapshots),
            Err(err(BurnerError::BurnPdaLamportMismatch))
        );
    }
}
