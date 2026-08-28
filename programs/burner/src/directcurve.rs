//! Feature-gated Pump.fun bonding-curve swap adapter.
//!
//! This is an alternative to the Jupiter route CPI, not an additional CPI.
//! The adapter derives the only admitted venue from the target mint, builds
//! Pump's exact 25-byte `buy` payload, and grants the burn PDA's signature at
//! Pump account index 6 only.

use alloc::vec::Vec;
use pinocchio::{
    cpi::{invoke_signed_with_slice, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

use crate::{
    constants::{
        PUMP_FUN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
    },
    error::{err, BurnerError},
    swap_and_burn::associated_token_address,
};

pub const PUMP_BUY_ACCOUNT_COUNT: usize = 16;

// `buy_exact_sol_in`: spends EXACTLY `spendable_sol_in`, so no rounding drift
// against the exact 6019 conservation check. The token-amount `buy` variant
// rounds DOWN and underspends, which 6019 correctly refuses.
const PUMP_BUY_DISCRIMINATOR: [u8; 8] = [56, 252, 116, 8, 158, 223, 205, 95];
const PUMP_BUY_DATA_LEN: usize = 25;
const BPS_DENOMINATOR: u64 = 10_000;
const PUMP_USER_INDEX: usize = 6;
/// Upper bound on forwarded remaining accounts. The DEPLOYED program's
/// accepted buy shape is 16 named + `bonding_curve_v2` + exactly ONE
/// fee-program `BuybackVault` (18 total; 16- and 17-account shapes are refused
/// Pump 6062/6074). The bound stays liberal so a Pump-side change cannot brick
/// the path; the per-account loop still strips signer privilege and refuses
/// the burn PDA at every extra index. FABLE-PUMP-CONFORMANCE.md M2/M3.
const PUMP_BUYBACK_RECIPIENTS: usize = 8;

/// Pump fee program, `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`.
const PUMP_FEE_PROGRAM_ID: Address = Address::new_from_array([
    12, 53, 255, 169, 5, 90, 142, 86, 141, 168, 247, 188, 7, 86, 21, 39, 76, 241, 201, 44, 164, 31,
    64, 0, 156, 81, 106, 164, 20, 194, 124, 112,
]);
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];

// Writable flags from Pump's official `getBuyInstructionRaw` account layout.
// CPI privileges are rebuilt from this table rather than copied from the
// caller's outer instruction.
// buy_exact_sol_in account order:
//  0 global | 1 fee_recipient(w) | 2 mint | 3 bonding_curve(w)
//  4 assoc_bonding_curve(w) | 5 assoc_user(w) | 6 user(s,w) | 7 system
//  8 token_program | 9 creator_vault(w) | 10 event_authority | 11 program
// 12 global_volume_accumulator | 13 user_volume_accumulator(w)
// 14 fee_config | 15 fee_program
const PUMP_BUY_WRITABLE: [bool; PUMP_BUY_ACCOUNT_COUNT] = [
    false, true, false, true, true, true, true, false, false, true, false, false, false, true,
    false, false,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PumpCurveQuote {
    pub expected_out: u64,
    pub max_sol_cost: u64,
}

#[derive(Clone)]
struct PumpCurveState {
    virtual_token_reserves: u64,
    virtual_sol_reserves: u64,
    creator: Address,
}

/// Derive Pump's legacy bonding curve from the target mint.
pub fn derive_pump_curve(mint: &Address) -> Address {
    Address::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_FUN_PROGRAM_ID).0
}

fn derive_pump_account(seed: &[u8]) -> Address {
    Address::find_program_address(&[seed], &PUMP_FUN_PROGRAM_ID).0
}

fn derive_pump_account_for_address(seed: &[u8], address: &Address) -> Address {
    Address::find_program_address(&[seed, address.as_ref()], &PUMP_FUN_PROGRAM_ID).0
}

fn read_u64(data: &[u8]) -> Result<u64, ProgramError> {
    let bytes: [u8; 8] = data
        .try_into()
        .map_err(|_| err(BurnerError::InvalidTokenAccountData))?;
    Ok(u64::from_le_bytes(bytes))
}

/// Pin the supplied reference to the target's Pump curve and read the only
/// fields used by the adapter. A graduated curve is not an admissible venue.
fn validate_pump_curve(
    reference: &AccountView,
    mint: &Address,
) -> Result<PumpCurveState, ProgramError> {
    if reference.address() != &derive_pump_curve(mint) || reference.owner() != &PUMP_FUN_PROGRAM_ID
    {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }

    let data = reference.try_borrow()?;
    if data.len() < 81 || data[48] != 0 {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    let creator_bytes: [u8; 32] = data[49..81]
        .try_into()
        .map_err(|_| err(BurnerError::InvalidTokenAccountData))?;
    Ok(PumpCurveState {
        virtual_token_reserves: read_u64(&data[8..16])?,
        virtual_sol_reserves: read_u64(&data[16..24])?,
        creator: Address::new_from_array(creator_bytes),
    })
}

/// Pump's exact `buy_exact_sol_in` quote, per the on-chain IDL docs:
/// 1. `net_sol = floor(spendable * 10_000 / (10_000 + total_fee_bps))`
/// 2. `fees = ceil(net*protocol/10_000) + ceil(net*creator/10_000)`
/// 3. if `net + fees > spendable`: reduce `net` by the overshoot (1-2 lamports
///    whenever the two ceils round up -- skipping this step overquotes and was
///    refused by Pump 6042 deterministically; FABLE-PUMP-CONFORMANCE.md M1)
/// 4. `tokens_out = floor((net-1) * vtr / (vsr + net-1))`
/// All arithmetic is widened so caller-controlled values cannot wrap.
fn expected_output(
    virtual_token_reserves: u64,
    virtual_sol_reserves: u64,
    max_sol_cost: u64,
    protocol_fee_bps: u64,
    creator_fee_bps: u64,
) -> Result<u64, ProgramError> {
    let total_fee = (protocol_fee_bps as u128)
        .checked_add(creator_fee_bps as u128)
        .ok_or(err(BurnerError::InvalidInstructionData))?;
    if total_fee >= BPS_DENOMINATOR as u128 {
        return Err(err(BurnerError::InvalidTokenAccountData));
    }
    // step 1
    let mut net_sol = (max_sol_cost as u128)
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        / (BPS_DENOMINATOR as u128 + total_fee);
    // step 2: each fee component ceil-rounds separately
    let ceil_bps = |amount: u128, bps: u128| -> Result<u128, ProgramError> {
        Ok(amount
            .checked_mul(bps)
            .ok_or(err(BurnerError::InvalidInstructionData))?
            .checked_add(BPS_DENOMINATOR as u128 - 1)
            .ok_or(err(BurnerError::InvalidInstructionData))?
            / BPS_DENOMINATOR as u128)
    };
    let fees = ceil_bps(net_sol, protocol_fee_bps as u128)?
        .checked_add(ceil_bps(net_sol, creator_fee_bps as u128)?)
        .ok_or(err(BurnerError::InvalidInstructionData))?;
    // step 3
    let overshoot = net_sol
        .checked_add(fees)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        .saturating_sub(max_sol_cost as u128);
    net_sol = net_sol
        .checked_sub(overshoot)
        .ok_or(err(BurnerError::ZeroMinimumOutput))?;
    // step 4
    let net_input = net_sol.checked_sub(1).ok_or(err(BurnerError::ZeroMinimumOutput))?;
    let denominator = (virtual_sol_reserves as u128)
        .checked_add(net_input)
        .ok_or(err(BurnerError::InvalidInstructionData))?;
    if net_input == 0 || virtual_token_reserves == 0 || denominator == 0 {
        return Err(err(BurnerError::ZeroMinimumOutput));
    }
    let output = (virtual_token_reserves as u128)
        .checked_mul(net_input)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        / denominator;
    if output == 0 || output > u64::MAX as u128 {
        return Err(err(BurnerError::ZeroMinimumOutput));
    }
    Ok(output as u64)
}

fn curve_fee_bps(
    fee_config: &AccountView,
    curve: &PumpCurveState,
    curve_data: &[u8],
    mint_data: &[u8],
) -> Result<(u64, u64), ProgramError> {
    let expected = Address::find_program_address(
        &[b"fee_config", PUMP_FUN_PROGRAM_ID.as_ref()],
        &PUMP_FEE_PROGRAM_ID,
    ).0;
    if fee_config.address() != &expected || fee_config.owner() != &PUMP_FEE_PROGRAM_ID {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    let data = fee_config.try_borrow()?;
    if data.get(0..8) != Some(PUMP_FEE_CONFIG_DISCRIMINATOR.as_ref()) || data.len() < 69 {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    let count = u32::from_le_bytes(data[65..69].try_into().map_err(|_| err(BurnerError::InvalidJupiterAccounts))?) as usize;
    let tiers_end = 69usize.checked_add(count.checked_mul(40).ok_or(err(BurnerError::InvalidJupiterAccounts))?).ok_or(err(BurnerError::InvalidJupiterAccounts))?;
    if count > 32 || data.len() < tiers_end { return Err(err(BurnerError::InvalidJupiterAccounts)); }
    let supply = if curve_data.get(81) == Some(&0) {
        1_000_000_000_000_000u64
    } else {
        read_u64(mint_data.get(36..44).ok_or(err(BurnerError::InvalidMintData))?)?
    };
    if curve.virtual_token_reserves == 0 { return Err(err(BurnerError::InvalidTokenAccountData)); }
    let market_cap = (curve.virtual_sol_reserves as u128)
        .checked_mul(supply as u128)
        .ok_or(err(BurnerError::InvalidInstructionData))?
        / curve.virtual_token_reserves as u128;
    let creator_non_default = curve.creator.as_ref() != [0u8; 32];
    let mut protocol = read_u64(&data[49..57])?;
    let mut creator = read_u64(&data[57..65])?;
    let mut previous = 0u128;
    for i in 0..count {
        let at = 69 + i * 40;
        let threshold = u128::from_le_bytes(data[at..at + 16].try_into().map_err(|_| err(BurnerError::InvalidJupiterAccounts))?);
        if i != 0 && threshold < previous { return Err(err(BurnerError::InvalidJupiterAccounts)); }
        previous = threshold;
        if threshold > market_cap { break; }
        protocol = read_u64(&data[at + 24..at + 32])?;
        creator = read_u64(&data[at + 32..at + 40])?;
    }
    // Pump rounds the protocol and creator components SEPARATELY (each with
    // its own ceil), so the split must survive to the quote; a combined total
    // drifts by atoms and is refused by Pump 6042.
    let creator_effective = if creator_non_default { creator } else { 0 };
    let fee = (protocol as u128)
        .checked_add(creator_effective as u128)
        .ok_or(err(BurnerError::InvalidInstructionData))?;
    if fee >= BPS_DENOMINATOR as u128 {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    Ok((protocol, creator_effective))
}

fn require_program(account: &AccountView, expected: &Address) -> ProgramResult {
    if account.address() != expected || !account.executable() {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    Ok(())
}

fn require_system_account(account: &AccountView) -> ProgramResult {
    if account.owner() != &SYSTEM_PROGRAM_ID || !account.is_data_empty() || account.executable() {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    Ok(())
}

/// Validate Pump's complete 18-account buy surface wherever identity can be
/// derived or pinned. Fee-recipient choices remain Pump-enforced, but both
/// recipient accounts are constrained to bare System accounts and receive no
/// signer privilege from this adapter.
fn validate_pump_buy_accounts(
    accounts: &[AccountView],
    burn_pda: &Address,
    target_mint: &Address,
    target_token_account: &Address,
    target_token_program: &Address,
) -> Result<PumpCurveState, ProgramError> {
    // 16 named accounts, then remaining accounts that Pump itself validates:
    // `bonding_curve_v2` and (today) exactly one buyback vault. We bound the
    // total and rely on the per-account loop below to guarantee none of them
    // is a signer and none is the burn PDA -- which is what protects custody
    // regardless of what Pump does with them.
    if accounts.len() < PUMP_BUY_ACCOUNT_COUNT
        || accounts.len() > PUMP_BUY_ACCOUNT_COUNT + 1 + PUMP_BUYBACK_RECIPIENTS
    {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }
    if target_token_program != &SPL_TOKEN_PROGRAM_ID
        && target_token_program != &SPL_TOKEN_2022_PROGRAM_ID
    {
        return Err(err(BurnerError::InvalidTokenProgram));
    }

    for (index, account) in accounts.iter().enumerate() {
        if (index != PUMP_USER_INDEX && account.is_signer())
            || (index != PUMP_USER_INDEX && account.address() == burn_pda)
            || (index < PUMP_BUY_ACCOUNT_COUNT
                && PUMP_BUY_WRITABLE[index]
                && !account.is_writable())
        {
            return Err(err(BurnerError::InvalidJupiterAccounts));
        }
    }

    let curve = validate_pump_curve(&accounts[3], target_mint)?;
    let expected_global = derive_pump_account(b"global");
    let expected_curve_ata =
        associated_token_address(accounts[3].address(), target_mint, target_token_program);
    let expected_creator_vault = derive_pump_account_for_address(b"creator-vault", &curve.creator);
    let expected_event_authority = derive_pump_account(b"__event_authority");
    let expected_global_volume = derive_pump_account(b"global_volume_accumulator");
    let expected_user_volume =
        derive_pump_account_for_address(b"user_volume_accumulator", burn_pda);
    let expected_fee_config = Address::find_program_address(
        &[b"fee_config", PUMP_FUN_PROGRAM_ID.as_ref()],
        &PUMP_FEE_PROGRAM_ID,
    )
    .0;

    if accounts[0].address() != &expected_global
        || accounts[0].owner() != &PUMP_FUN_PROGRAM_ID
        || accounts[2].address() != target_mint
        || accounts[2].owner() != target_token_program
        || accounts[4].address() != &expected_curve_ata
        || accounts[4].owner() != target_token_program
        || accounts[5].address() != target_token_account
        || accounts[5].owner() != target_token_program
        || accounts[6].address() != burn_pda
        || accounts[9].address() != &expected_creator_vault
        || accounts[10].address() != &expected_event_authority
        || accounts[12].address() != &expected_global_volume
        || accounts[12].owner() != &PUMP_FUN_PROGRAM_ID
        || accounts[13].address() != &expected_user_volume
        || (accounts[13].owner() != &PUMP_FUN_PROGRAM_ID
            && accounts[13].owner() != &SYSTEM_PROGRAM_ID)
        || accounts[14].address() != &expected_fee_config
        || accounts[14].owner() != &PUMP_FEE_PROGRAM_ID

    {
        return Err(err(BurnerError::InvalidJupiterAccounts));
    }

    require_system_account(&accounts[1])?;
    require_system_account(&accounts[6])?;
    require_system_account(&accounts[9])?;
    // The trailing remaining accounts (index >= 16: `bonding_curve_v2`, then
    // the fee-program buyback vault(s) — today Pump's 208-byte fee-program
    // PDA, owner pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ) are DELIBERATELY
    // not identity-pinned here: Pump validates them itself, and pinning them
    // would brick this path the next time Pump reshapes its fee plumbing.
    // What this adapter enforces about them is the count bound above and the
    // per-account loop's guarantees — no signer privilege and never the burn
    // PDA — which is what protects custody regardless of their identity.

    require_program(&accounts[7], &SYSTEM_PROGRAM_ID)?;
    require_program(&accounts[8], target_token_program)?;
    require_program(&accounts[11], &PUMP_FUN_PROGRAM_ID)?;
    require_program(&accounts[15], &PUMP_FEE_PROGRAM_ID)?;
    Ok(curve)
}

/// CPI directly into the Pump curve. The returned quote is the exact token
/// amount encoded in the buy and the maximum native SOL Pump is authorized to
/// debit. The transaction remains atomic: a worse fill exceeds `maxSolCost`
/// and Pump rejects instead of partially filling below `expected_out`.
pub fn invoke_pump_curve_buy(
    accounts: &[AccountView],
    burn_pda: &Address,
    target_mint: &Address,
    target_token_account: &Address,
    target_token_program: &Address,
    max_sol_cost: u64,
    min_tokens_out: u64,
    signer: &Signer,
) -> Result<PumpCurveQuote, ProgramError> {
    if max_sol_cost == 0 {
        return Err(err(BurnerError::ZeroInput));
    }
    let curve = validate_pump_buy_accounts(
        accounts,
        burn_pda,
        target_mint,
        target_token_account,
        target_token_program,
    )?;
    // Scope the data borrows: the CPI below re-borrows these same accounts,
    // and a live borrow here aborts the whole call with AccountBorrowFailed.
    let expected_out = {
        let curve_data = accounts[3].try_borrow()?;
        let mint_data = accounts[2].try_borrow()?;
        let (protocol_bps, creator_bps) =
            curve_fee_bps(&accounts[14], &curve, &curve_data, &mint_data)?;
        expected_output(
            curve.virtual_token_reserves,
            curve.virtual_sol_reserves,
            max_sol_cost,
            protocol_bps,
            creator_bps,
        )?
    };

    let mut instruction_data = [0u8; PUMP_BUY_DATA_LEN];
    instruction_data[..8].copy_from_slice(&PUMP_BUY_DISCRIMINATOR);
    // buy_exact_sol_in(spendable_sol_in, min_tokens_out, track_volume)
    instruction_data[8..16].copy_from_slice(&max_sol_cost.to_le_bytes());
    // The CPI's slippage floor is the caller's ALREADY-ENFORCED minimum_output
    // (raised to the on-chain curve floor upstream), not the local mirror of
    // Pump's quote math: Pump rounds its 95 bps protocol and 30 bps creator
    // fees separately, so an atom-exact mirror is fragile (measured 35,651
    // atoms high on a 20,000,000-lamport buy, Pump 6042). The mirror keeps
    // running as an admission sanity check on the fee config and reserves; the
    // burner's own post-CPI `received >= minimum_output` check is unchanged.
    instruction_data[16..24].copy_from_slice(&min_tokens_out.to_le_bytes());
    instruction_data[24] = 0; // track_volume = None

    let mut metas = Vec::with_capacity(accounts.len());
    for (index, account) in accounts.iter().enumerate() {
        metas.push(InstructionAccount::new(
            account.address(),
            if index < PUMP_BUY_ACCOUNT_COUNT { PUMP_BUY_WRITABLE[index] } else { true },
            index == PUMP_USER_INDEX,
        ));
    }
    invoke_signed_with_slice(
        &InstructionView {
            program_id: &PUMP_FUN_PROGRAM_ID,
            data: &instruction_data,
            accounts: &metas,
        },
        accounts,
        core::slice::from_ref(signer),
    )?;

    Ok(PumpCurveQuote {
        expected_out,
        max_sol_cost,
    })
}

#[cfg(test)]
mod tests {
    use super::expected_output;

    #[test]
    fn pump_doc_quote_small() {
        // net = floor(10_000*10_000/10_125) = 9_876; fees = 94 + 30 = 124;
        // net+fees = 10_000 (no step-3 adjustment); out = floor(1e6*9_875/1_009_875)
        assert_eq!(
            expected_output(1_000_000, 1_000_000, 10_000, 95, 30).unwrap(),
            9_778
        );
    }

    #[test]
    fn pump_doc_quote_step3_overshoot_reduces_net() {
        // net = 9_876_543; fees = 93_828 + 29_630 = 123_458;
        // net+fees = 10_000_001 > 10_000_000 so step 3 subtracts 1.
        assert_eq!(
            expected_output(1_071_964_741_916_896, 30_028_972_729, 10_000_000, 95, 30).unwrap(),
            352_453_705_164
        );
    }

    #[test]
    fn constant_product_quote_rejects_dust() {
        assert!(expected_output(1, 1_000_000, 1, 95, 30).is_err());
    }
}
