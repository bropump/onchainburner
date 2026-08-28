//! FIRST test suite for the experimental `keyless` path, executed against the
//! REAL SBPF artifact under Mollusk (the `fuzz_artifact.rs` idiom: a panic in
//! the VM is an abort, not a clean revert, so arithmetic hazards are directly
//! observable).
//!
//! Build the keyless artifact first, then keep it under a distinct name so a
//! KMS build cannot be tested by mistake:
//!
//!   cd <repo> && touch programs/burner/src/swap_and_burn.rs && \
//!     tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf \
//!       --manifest-path programs/burner/Cargo.toml \
//!       --arch v2 --tools-version v1.53 --features keyless && \
//!     cp programs/burner/target/deploy/pinocchio_parity.so \
//!        programs/burner/target/deploy/pinocchio_parity_keyless.so
//!
//! Run:
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --test keyless_artifact -- --ignored --nocapture
//!
//! Env: `BURNER_KEYLESS_ELF` overrides the artifact path;
//!      `KEYLESS_FUZZ_ITERS` scales the corruption campaign;
//!      `KEYLESS_SEED_SWEEP` scales the seed-collision sweep;
//!      `BURNER_FUZZ_SEED` fixes the RNG for reproduction.
//!
//! WHY EVERY PROPERTY IS OBSERVABLE WITHOUT REACHING A CPI
//! -------------------------------------------------------
//! Since REFERENCE BINDING landed, the single-target instruction is refused
//! at dispatch under the keyless feature (its legacy derivation carries no
//! reference seed), so every historical single-target case here drives a
//! ONE-LEG SPLIT whose vault is derived WITH the leg's reference seed. In the
//! split handler every leg's floor is computed and checked BEFORE any CPI,
//! and the whole floor stage runs before route validation, so with empty
//! route data the oracle is still strictly pre-CPI:
//!
//!   * 6040 `ReferenceCapExceeded` -> the depth cap refused `amount_in`
//!                                    (`amount_in > cap = depth*fee_n/fee_d`);
//!   * 6039 `ReferenceInvalid`     -> the reference / vaults / fee source
//!                                    failed identity or content checks;
//!   * 6002 `ZeroMinimumOutput`
//!       with `minimum_output = 0` -> the derived floor was EXACTLY ZERO;
//!   * 6021 `SlippageExceeded`     -> the floor computed and `minimum_output`
//!                                    sits below it (binary-search lever);
//!   * 6005 `InvalidJupiterInstruction` -> the floor stage ADMITTED the
//!                                    input and execution fell through to the
//!                                    empty-route-data sentinel.
//!
//! The pair (`min=0` -> 6002 never happening while `min=0` -> 6005 does)
//! would identify the zero-floor bug: a floor of zero that is nevertheless
//! accepted, i.e. a burn with NO price protection at all.
//!
//! `leg.minimum_output < floor` refused as 6021 makes the floor's exact
//! VALUE recoverable by binary search over `minimum_output` — a full
//! differential test of the constant-product maths, fee subtraction, and
//! tolerance haircut against an independent 128-bit reference.
//!
//! Deliberately NOT covered here (surface being deleted by the concurrent
//! refactor): Raydium CLMM `sqrt_price` and Meteora DLMM bin pricing. The
//! corruption campaign never fabricates accounts owned by those programs.

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_program_option::COption,
    solana_pubkey::Pubkey,
    spl_token_interface::state::{Account as TokenAccount, AccountState, Mint},
    std::{collections::HashSet, fs, path::PathBuf, str::FromStr},
};

const BURNER_PROGRAM: &str = "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];

// Program ids the keyless floor authenticates references against (byte-for-byte
// the constants in the program source; the control fixtures prove agreement).
const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];
const RAYDIUM_CP: [u8; 32] = [
    169, 42, 90, 139, 79, 41, 89, 82, 132, 37, 80, 170, 147, 253, 91, 149, 181, 172, 230, 168, 235,
    146, 12, 147, 148, 46, 67, 105, 12, 32, 236, 115,
];
const PUMP_FUN_PROGRAM: [u8; 32] = [
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245,
    210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];
const PUMP_SWAP_PROGRAM: [u8; 32] = [
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86,
    213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
];
const PUMP_FEE_PROGRAM: [u8; 32] = [
    12, 53, 255, 169, 5, 90, 142, 86, 141, 168, 247, 188, 7, 86, 21, 39, 76, 241, 201, 44, 164, 31,
    64, 0, 156, 81, 106, 164, 20, 194, 124, 112,
];
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];

/// The program's fixed tolerance haircut on the derived floor.
const KEYLESS_TOL_BPS: u128 = 100;
/// Pump's fixed one-billion supply used for non-mayhem market caps.
const PUMP_FIXED_SUPPLY: u128 = 1_000_000_000_000_000;

// Error codes under test (append-only, client-visible).
const ZERO_MINIMUM_OUTPUT: u32 = 6002;
/// Post-floor "admitted" sentinel. Under the merged keyless+directcurve build
/// an EMPTY route marks a leg as the CURVE leg (dispatched to the directcurve
/// adapter), so 6005 `InvalidJupiterInstruction` is no longer the admitted
/// sentinel. The admitted-path assertions below feed a NON-EMPTY
/// `route_probe` (a real `route_v2` payload carrying the leg's exact derived
/// `in_amount`, zero fees, zero route accounts): an admitted leg then stays on
/// the JUPITER path and refuses at the account-layout pin (6006), while a
/// WRONG `in_amount` refuses 6008 — which is what keeps the sentinel honest.
const FLOOR_ADMITTED: u32 = 6006;
/// Wrong-`in_amount` refusal: proves the route probe actually reached the
/// Jupiter route validator rather than passing vacuously.
const INPUT_AMOUNT_MISMATCH: u32 = 6008;
const INVALID_BURN_PDA: u32 = 6012;
const SLIPPAGE_EXCEEDED: u32 = 6021; // the split floor refusal
const INVALID_INSTRUCTION_DATA: u32 = 6027; // also: single-target refused at dispatch
const ZERO_INPUT: u32 = 6000; // zero probe refusal in validate_config Mode A
/// Reference identity/content refusal (was 6014 before binding landed).
const REFERENCE_INVALID: u32 = 6039;
/// Depth-cap refusal (was 6000 before binding landed); retryable by chunking.
const REFERENCE_CAP_EXCEEDED: u32 = 6040;
/// Change 2: an address-bound reference below the 50-SOL min-depth floor.
#[allow(dead_code)]
const REFERENCE_TOO_SHALLOW: u32 = 6041;

const RENT_FLOOR_ZERO_DATA: u64 = 890_880;

fn key(value: &str) -> Pubkey {
    Pubkey::from_str(value).expect("valid fixed pubkey")
}

fn system_account(lamports: u64) -> Account {
    Account::new(lamports, 0, &Pubkey::default())
}

fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token::ID.as_ref(), mint.as_ref()],
        &key(ASSOCIATED_TOKEN_PROGRAM),
    )
    .0
}

fn immutable_mint(supply: u64, decimals: u8) -> Mint {
    Mint {
        mint_authority: COption::None,
        supply,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    }
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64, native: Option<u64>) -> TokenAccount {
    TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: native.map(COption::Some).unwrap_or(COption::None),
        delegated_amount: 0,
        close_authority: COption::None,
    }
}

/// A raw 165-byte SPL token account whose only load-bearing fields for the
/// keyless reference reads are mint (0..32), owner (32..64), amount (64..72).
fn raw_vault_account(owner_program: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized, for realism only
    Account {
        lamports: 2_039_280,
        data,
        owner: owner_program,
        executable: false,
        rent_epoch: 0,
    }
}

// ---------------------------------------------------------------------------
// Deterministic RNG (SplitMix64), the same reproduction contract as
// fuzz_artifact.rs: a failing campaign prints its seed, and
// BURNER_FUZZ_SEED=<seed> replays the identical sequence.
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        assert!(bound > 0);
        self.next() % bound
    }

    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }

    fn pubkey(&mut self) -> Pubkey {
        let mut bytes = [0u8; 32];
        for chunk in bytes.chunks_mut(8) {
            chunk.copy_from_slice(&self.next().to_le_bytes()[..chunk.len()]);
        }
        Pubkey::new_from_array(bytes)
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn seed() -> u64 {
    std::env::var("BURNER_FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_260_824)
}

// ---------------------------------------------------------------------------
// Mollusk setup and artifact identity
// ---------------------------------------------------------------------------

fn artifact_path() -> PathBuf {
    if let Ok(path) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(path);
    }
    let deploy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy");
    let preferred = deploy.join("pinocchio_parity_keyless.so");
    if preferred.is_file() {
        preferred
    } else {
        deploy.join("pinocchio_parity.so")
    }
}

fn load_mollusk() -> Mollusk {
    let path = artifact_path();
    assert!(
        path.is_file(),
        "missing keyless burner ELF: {} — build with --features keyless (see file header)",
        path.display(),
    );
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &key(BURNER_PROGRAM),
        &program::loader_keys::LOADER_V3,
        &fs::read(&path).expect("read keyless burner ELF"),
    );
    // A reference-BOUND keyless build refuses the single-target
    // discriminator at dispatch (6027): the legacy derivation carries no
    // reference seed, so serving it would bypass binding. A KMS build or a
    // pre-binding keyless build answers this probe differently (6004 / 6028),
    // so the probe uniquely authenticates the bound artifact.
    let mut metas = Vec::new();
    let mut accounts = Vec::new();
    let mut rng = Rng(1);
    for i in 0..13usize {
        let pk = rng.pubkey();
        metas.push(AccountMeta::new_readonly(pk, i == 0));
        accounts.push((pk, system_account(1_000_000)));
    }
    let mut data = SWAP_AND_BURN_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    let probe = Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data };
    let result = mollusk.process_instruction(&probe, &accounts);
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(INVALID_INSTRUCTION_DATA)),
        "artifact at {} is NOT a reference-BOUND keyless build (the single-target \
         discriminator was not refused 6027 at dispatch); rebuild with --features keyless",
        path.display(),
    );
    mollusk
}

/// Every outcome must be a named `BurnerError`. An abort, an access
/// violation, or an unnamed runtime error is a finding in itself.
fn named_code(result: &Result<(), InstructionError>, context: &dyn Fn() -> String) -> u32 {
    match result {
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => *code,
        other => panic!("artifact produced a non-named outcome {other:?}\n{}", context()),
    }
}

// ---------------------------------------------------------------------------
// Reference-bound one-leg split runner. Binding closed the single-target
// instruction under the keyless feature (its legacy derivation carries no
// reference seed), so every historical single-target case drives the SPLIT
// handler through this fixture: one leg, weight 10000, vault derived WITH
// the reference's seed (the pool address, or the [0u8;32] sentinel for
// Pump-owned references), empty route data so 6005 is the admitted-input
// sentinel.
// ---------------------------------------------------------------------------

/// One complete bound one-leg account set. `reference`, `vault_a`,
/// `vault_b`, `fee_source` are (pubkey, account) pairs; `fee_source` may share
/// the reference's pubkey (Raydium v4 stores its fee in the pool account).
struct SingleFixture {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
}

/// Accounts-vec victim indices for the corruption campaign (metas mirror
/// them): reference 10, target mint 8, vaults 11/12, fee source last.
const FIX_REFERENCE: usize = 10;
const FIX_TARGET_MINT: usize = 8;
const FIX_VAULT_A: usize = 11;
const FIX_VAULT_B: usize = 12;

/// The 32-byte seed a reference binds into the vault derivation (mirrors
/// `build_split_seeds`): the zero sentinel for Pump-ecosystem owners, the
/// reference's address otherwise.
fn ref_seed_of(reference: &(Pubkey, Account)) -> [u8; 32] {
    if reference.1.owner == Pubkey::new_from_array(PUMP_FUN_PROGRAM)
        || reference.1.owner == Pubkey::new_from_array(PUMP_SWAP_PROGRAM)
    {
        [0u8; 32]
    } else {
        reference.0.to_bytes()
    }
}

fn single_fixture(
    target_mint: (Pubkey, Account),
    reference: (Pubkey, Account),
    vault_a: (Pubkey, Account),
    vault_b: (Pubkey, Account),
    fee_source: (Pubkey, Account),
) -> SingleFixture {
    let caller = Pubkey::new_from_array([10; 32]);
    let quote_slot = Pubkey::new_from_array([16; 32]); // unused in keyless
    let launch_mint = Pubkey::new_from_array([13; 32]);
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let weights = [10_000u16];
    let mint_key = target_mint.0;
    // Derived at BUILD time from the reference's owner; a corruption that
    // later changes the owner's sentinel class lands on 6012, a named code.
    let burn_pda = derive_split_pda(&launch_mint, &[mint_key], &weights, &[ref_seed_of(&reference)]);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);
    let target_ata = associated_token_address(&burn_pda, &mint_key);

    let metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(quote_slot, false),
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(launch_mint, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
        AccountMeta::new(mint_key, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(reference.0, false),
        AccountMeta::new_readonly(vault_a.0, false),
        AccountMeta::new_readonly(vault_b.0, false),
        AccountMeta::new_readonly(fee_source.0, false),
    ];
    let mut accounts = vec![
        (caller, system_account(1_000_000)),
        (quote_slot, system_account(1_000_000)),
        (burn_pda, system_account(RENT_FLOOR_ZERO_DATA)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                wsol,
                burn_pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (launch_mint, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
        target_mint,
        (
            target_ata,
            token::create_account_for_token_account(token_account(mint_key, burn_pda, 0, None)),
        ),
        reference,
        vault_a,
        vault_b,
    ];
    // Only push a distinct fee-source account; a duplicate meta pubkey
    // resolves to the account already listed.
    if !accounts.iter().any(|(pk, _)| *pk == fee_source.0) {
        accounts.push(fee_source);
    }
    SingleFixture { metas, accounts }
}

fn run_single(mollusk: &Mollusk, fixture: &SingleFixture, amount_in: u64, minimum_output: u64) -> u32 {
    // The split path checks the vault balance BEFORE the floor stage would
    // matter downstream, so keep the vault funded for the probed amount.
    let mut accounts = fixture.accounts.clone();
    for (pk, account) in accounts.iter_mut() {
        if *pk == fixture.metas[2].pubkey {
            account.lamports = amount_in.saturating_add(RENT_FLOOR_ZERO_DATA);
        }
    }
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes());
    data.extend_from_slice(&10_000u16.to_le_bytes());
    data.extend_from_slice(&minimum_output.to_le_bytes());
    data.push(0); // route_account_count
    data.extend_from_slice(&0u32.to_le_bytes()); // route data length
    let instruction = Instruction {
        program_id: key(BURNER_PROGRAM),
        accounts: fixture.metas.clone(),
        data,
    };
    let result = mollusk.process_instruction(&instruction, &accounts);
    named_code(&result.raw_result, &|| {
        format!("bound one-leg run: amount_in={amount_in} minimum_output={minimum_output}")
    })
}

fn raydium_v4_fixture(rt: u64, rs: u64, fee_num: u64, fee_den: u64) -> SingleFixture {
    let target_mint_key = Pubkey::new_from_array([0x51; 32]);
    let pool_key = Pubkey::new_from_array([0x52; 32]);
    let vault_a_key = Pubkey::new_from_array([0x53; 32]);
    let vault_b_key = Pubkey::new_from_array([0x54; 32]);
    let pool_owner_authority = Pubkey::new_from_array([0x55; 32]);
    let wsol = key(WSOL_MINT);

    let mut pool_data = vec![0u8; 400];
    pool_data[144..152].copy_from_slice(&fee_num.to_le_bytes());
    pool_data[152..160].copy_from_slice(&fee_den.to_le_bytes());
    pool_data[336..368].copy_from_slice(vault_a_key.as_ref());
    pool_data[368..400].copy_from_slice(vault_b_key.as_ref());
    let pool = Account {
        lamports: 6_124_800,
        data: pool_data,
        owner: Pubkey::new_from_array(RAYDIUM_V4),
        executable: false,
        rent_epoch: 0,
    };

    single_fixture(
        (target_mint_key, token::create_account_for_mint(immutable_mint(1_000_000, 6))),
        (pool_key, pool.clone()),
        (vault_a_key, raw_vault_account(token::ID, &target_mint_key, &pool_owner_authority, rt)),
        (vault_b_key, raw_vault_account(token::ID, &wsol, &pool_owner_authority, rs)),
        (pool_key, pool),
    )
}

/// Raydium CP-Swap: vault pubkeys at 72/104, the fee lives in a separate
/// amm-config account named at pool offset 8..40, trade_fee_rate at config
/// offset 12 with fixed denominator 1_000_000.
fn raydium_cp_fixture(rt: u64, rs: u64, trade_fee_rate: u64) -> SingleFixture {
    let target_mint_key = Pubkey::new_from_array([0x61; 32]);
    let pool_key = Pubkey::new_from_array([0x62; 32]);
    let vault_a_key = Pubkey::new_from_array([0x63; 32]);
    let vault_b_key = Pubkey::new_from_array([0x64; 32]);
    let config_key = Pubkey::new_from_array([0x65; 32]);
    let pool_owner_authority = Pubkey::new_from_array([0x66; 32]);
    let wsol = key(WSOL_MINT);
    let cp = Pubkey::new_from_array(RAYDIUM_CP);

    let mut pool_data = vec![0u8; 300];
    pool_data[8..40].copy_from_slice(config_key.as_ref());
    pool_data[72..104].copy_from_slice(vault_a_key.as_ref());
    pool_data[104..136].copy_from_slice(vault_b_key.as_ref());
    let pool = Account { lamports: 3_000_000, data: pool_data, owner: cp, executable: false, rent_epoch: 0 };

    let mut config_data = vec![0u8; 64];
    config_data[12..20].copy_from_slice(&trade_fee_rate.to_le_bytes());
    let config = Account { lamports: 1_500_000, data: config_data, owner: cp, executable: false, rent_epoch: 0 };

    single_fixture(
        (target_mint_key, token::create_account_for_mint(immutable_mint(1_000_000, 6))),
        (pool_key, pool),
        (vault_a_key, raw_vault_account(token::ID, &target_mint_key, &pool_owner_authority, rt)),
        (vault_b_key, raw_vault_account(token::ID, &wsol, &pool_owner_authority, rs)),
        (config_key, config),
    )
}

/// One Pump fee_config tier: (market-cap threshold, lp, protocol, creator).
#[derive(Clone, Copy, Debug)]
struct FeeTier {
    threshold: u128,
    lp: u64,
    protocol: u64,
    creator: u64,
}

fn fee_config_account(venue: &Pubkey, flat: (u64, u64, u64), tiers: &[FeeTier]) -> (Pubkey, Account) {
    let fee_program = Pubkey::new_from_array(PUMP_FEE_PROGRAM);
    let (address, _) =
        Pubkey::find_program_address(&[b"fee_config", venue.as_ref()], &fee_program);
    let mut data = vec![0u8; 69 + 40 * tiers.len() + 32]; // trailing bytes are legal
    data[0..8].copy_from_slice(&PUMP_FEE_CONFIG_DISCRIMINATOR);
    data[41..49].copy_from_slice(&flat.0.to_le_bytes());
    data[49..57].copy_from_slice(&flat.1.to_le_bytes());
    data[57..65].copy_from_slice(&flat.2.to_le_bytes());
    data[65..69].copy_from_slice(&(tiers.len() as u32).to_le_bytes());
    for (i, tier) in tiers.iter().enumerate() {
        let at = 69 + 40 * i;
        data[at..at + 16].copy_from_slice(&tier.threshold.to_le_bytes());
        data[at + 16..at + 24].copy_from_slice(&tier.lp.to_le_bytes());
        data[at + 24..at + 32].copy_from_slice(&tier.protocol.to_le_bytes());
        data[at + 32..at + 40].copy_from_slice(&tier.creator.to_le_bytes());
    }
    (
        address,
        Account { lamports: 2_500_000, data, owner: fee_program, executable: false, rent_epoch: 0 },
    )
}

/// Pump.fun bonding curve: reference is the curve PDA of the target mint;
/// virtual reserves at 8/16; the venue-tiered fee_config supplies
/// protocol (+creator when the curve's creator field is non-default), lp
/// excluded; market cap = virtual_quote * fixed-1e15-supply / virtual_tokens.
fn pump_curve_fixture(
    virtual_tokens: u64,
    virtual_quote: u64,
    creator_nonzero: bool,
    flat: (u64, u64, u64),
    tiers: &[FeeTier],
) -> SingleFixture {
    let pump = Pubkey::new_from_array(PUMP_FUN_PROGRAM);
    let target_mint_key = Pubkey::new_from_array([0x71; 32]);
    let (curve_key, _) =
        Pubkey::find_program_address(&[b"bonding-curve", target_mint_key.as_ref()], &pump);

    let mut curve_data = vec![0u8; 151];
    curve_data[8..16].copy_from_slice(&virtual_tokens.to_le_bytes());
    curve_data[16..24].copy_from_slice(&virtual_quote.to_le_bytes());
    curve_data[48] = 0; // not complete
    if creator_nonzero {
        curve_data[49..81].copy_from_slice(&[7u8; 32]);
    }
    curve_data[81] = 0; // not mayhem: fixed 1e15 supply for the market cap
    let curve = Account { lamports: 2_000_000, data: curve_data, owner: pump, executable: false, rent_epoch: 0 };

    let fee = fee_config_account(&pump, flat, tiers);
    // The curve path ignores vault_a/vault_b; inert accounts.
    single_fixture(
        (target_mint_key, token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6))),
        (curve_key, curve),
        (Pubkey::new_from_array([0x72; 32]), system_account(1)),
        (Pubkey::new_from_array([0x73; 32]), system_account(1)),
        fee,
    )
}

/// PumpSwap AMM: vault pubkeys at 139/171, pool creator at 11..43 must be the
/// canonical pool-authority PDA of the target mint, `virtual_sol_reserves`
/// (i128) at 245 adds to the quote depth, coin-creator field at 211..243
/// gates the creator fee, and lp IS included in the tier total.
fn pump_swap_fixture(
    base_amt: u64,
    quote_amt: u64,
    virtual_quote: i128,
    mint_supply: u64,
    creator_nonzero: bool,
    flat: (u64, u64, u64),
    tiers: &[FeeTier],
) -> SingleFixture {
    let pump = Pubkey::new_from_array(PUMP_FUN_PROGRAM);
    let pump_swap = Pubkey::new_from_array(PUMP_SWAP_PROGRAM);
    let target_mint_key = Pubkey::new_from_array([0x81; 32]);
    let pool_key = Pubkey::new_from_array([0x82; 32]);
    let vault_a_key = Pubkey::new_from_array([0x83; 32]);
    let vault_b_key = Pubkey::new_from_array([0x84; 32]);
    let pool_owner_authority = Pubkey::new_from_array([0x85; 32]);
    let wsol = key(WSOL_MINT);

    let (pool_authority, _) =
        Pubkey::find_program_address(&[b"pool-authority", target_mint_key.as_ref()], &pump);

    let mut pool_data = vec![0u8; 300];
    pool_data[11..43].copy_from_slice(pool_authority.as_ref());
    pool_data[139..171].copy_from_slice(vault_a_key.as_ref());
    pool_data[171..203].copy_from_slice(vault_b_key.as_ref());
    if creator_nonzero {
        pool_data[211..243].copy_from_slice(&[9u8; 32]);
    }
    pool_data[245..261].copy_from_slice(&virtual_quote.to_le_bytes());
    let pool = Account { lamports: 4_000_000, data: pool_data, owner: pump_swap, executable: false, rent_epoch: 0 };

    let fee = fee_config_account(&pump_swap, flat, tiers);
    single_fixture(
        (target_mint_key, token::create_account_for_mint(immutable_mint(mint_supply, 6))),
        (pool_key, pool),
        (vault_a_key, raw_vault_account(token::ID, &target_mint_key, &pool_owner_authority, base_amt)),
        (vault_b_key, raw_vault_account(token::ID, &wsol, &pool_owner_authority, quote_amt)),
        fee,
    )
}

// ---------------------------------------------------------------------------
// Independent 128-bit reference model
// ---------------------------------------------------------------------------

/// Naive LINEAR scan of a Pump fee tier table: the LAST tier whose threshold
/// is <= market_cap, else the flat fields. This is the specification the
/// program's binary search must agree with on every input.
fn linear_tier_scan(flat: (u64, u64, u64), tiers: &[FeeTier], market_cap: u128) -> (u64, u64, u64) {
    let mut selected = flat;
    for tier in tiers {
        if tier.threshold <= market_cap {
            selected = (tier.lp, tier.protocol, tier.creator);
        }
    }
    selected
}

/// Pump fee-config content DEGRADES rather than erroring: a selected total
/// outside [1, 1000] bps (or an unparseable table) falls back to the
/// conservative 1 bps. Only the fee-source IDENTITY (PDA + owner) fails
/// closed as 6014.
const PUMP_FEE_FALLBACK_BPS: u128 = 1;
const PUMP_FEE_PLAUSIBLE_MAX_BPS: u128 = 1_000;

fn pump_total_fee(
    flat: (u64, u64, u64),
    tiers: &[FeeTier],
    market_cap: u128,
    include_lp: bool,
    include_creator: bool,
) -> u128 {
    let (lp, protocol, creator) = linear_tier_scan(flat, tiers, market_cap);
    let mut total = protocol as u128;
    if include_lp {
        total += lp as u128;
    }
    if include_creator {
        total += creator as u128;
    }
    if total >= PUMP_FEE_FALLBACK_BPS && total <= PUMP_FEE_PLAUSIBLE_MAX_BPS {
        total
    } else {
        PUMP_FEE_FALLBACK_BPS
    }
}

/// cap = depth * fee_numerator / fee_denominator, floored.
fn reference_cap(depth: u64, fee_num: u128, fee_den: u128) -> u128 {
    (depth as u128) * fee_num / fee_den
}

/// The complete floor pipeline for a constant-product venue, mirrored in
/// independent 128-bit arithmetic (matching the program's documented floor
/// semantics; every division floors).
fn reference_floor(
    rt: u64,
    rs: u64,
    fee_num: u128,
    fee_den: u128,
    pump_exact_in: bool,
    amount_in: u64,
) -> Option<u64> {
    let cap = reference_cap(rs, fee_num, fee_den);
    if (amount_in as u128) > cap {
        return None; // refused by the cap, not a floor
    }
    let net = if pump_exact_in {
        let gross = (amount_in as u128) * fee_den / (fee_den + fee_num);
        gross.checked_sub(1)?
    } else {
        (amount_in as u128) * (fee_den - fee_num) / fee_den
    };
    if net == 0 {
        return None; // refused inside input_after_fee
    }
    let cp = (rt as u128) * net / (rs as u128 + net);
    let floor = cp * (10_000 - KEYLESS_TOL_BPS) / 10_000;
    u64::try_from(floor).ok()
}

// ---------------------------------------------------------------------------
// 1. THE CAP: cap = fee_bps * depth / denom; amount_in > cap refused
// ---------------------------------------------------------------------------

/// Exact boundary at randomly drawn (depth, fee): `amount == cap` is admitted
/// by the cap stage, `cap + 1` is refused as 6000. Also pins the measured cap
/// to the 128-bit reference exactly: admitted(cap) proves measured >= cap and
/// refused(cap+1) proves measured < cap+1.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cap_exact_boundary_and_reference_agreement() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value);
    let mut checked = 0usize;

    // Deterministic corner grid first.
    let corner_depths: [u64; 9] =
        [1, 79, 80, 399, 400, 401, 1_000_000_000, u64::MAX / 2, u64::MAX];
    let corner_fees: [(u64, u64); 4] = [(25, 10_000), (125, 10_000), (1, 10_000), (9_999, 10_000)];
    let mut cases: Vec<(u64, u64, u64)> = Vec::new();
    for &rs in &corner_depths {
        for &(num, den) in &corner_fees {
            cases.push((rs, num, den));
        }
    }
    for _ in 0..160 {
        let rs = match rng.below(4) {
            0 => rng.range(1, 100_000),
            1 => rng.range(100_000, 10_000_000_000),
            2 => rng.range(10_000_000_000, u64::MAX / 2),
            _ => u64::MAX - rng.below(1_000_000),
        };
        let den = 10_000u64;
        let num = rng.range(1, den - 1);
        cases.push((rs, num, den));
    }

    for (rs, num, den) in cases {
        let rt = 1_000_000_000_000u64;
        let fixture = raydium_v4_fixture(rt, rs, num, den);
        let cap = reference_cap(rs, num as u128, den as u128);
        let cap64 = u64::try_from(cap).expect("cap < depth <= u64::MAX");
        if cap64 >= 1 {
            let code = run_single(&mollusk, &fixture, cap64, 1);
            assert_ne!(
                code, REFERENCE_CAP_EXCEEDED,
                "amount_in == cap must be ADMITTED by the cap: rs={rs} fee={num}/{den} cap={cap64} (seed {seed_value})"
            );
        }
        if cap64 < u64::MAX {
            let code = run_single(&mollusk, &fixture, cap64 + 1, 1);
            assert_eq!(
                code, REFERENCE_CAP_EXCEEDED,
                "amount_in == cap+1 must be REFUSED by the cap: rs={rs} fee={num}/{den} cap={cap64} (seed {seed_value})"
            );
        }
        checked += 1;
    }
    println!("cap boundary: {checked} (depth, fee) pairs, both edges exact");
}

/// Depth below fee_den/fee_num floors the cap to zero and refuses EVERYTHING —
/// the measured on-chain behaviour ("cap floors to 0 below ~400 lamports of
/// depth" at the 25 bps Raydium fee).
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cap_zero_depth_refuses_everything() {
    let mollusk = load_mollusk();
    for (rs, num, den) in [(399u64, 25u64, 10_000u64), (79, 125, 10_000), (1, 9_999, 10_000)] {
        let fixture = raydium_v4_fixture(1_000_000_000, rs, num, den);
        for amount in [1u64, 2, 1_000, u64::MAX] {
            let code = run_single(&mollusk, &fixture, amount, 1);
            assert_eq!(
                code, REFERENCE_CAP_EXCEEDED,
                "cap==0 must refuse every amount: rs={rs} fee={num}/{den} amount={amount}"
            );
        }
    }
}

/// u64::MAX depth must not overflow, underflow, or abort; the cap stays exact.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cap_u64_max_depth_no_overflow() {
    let mollusk = load_mollusk();
    for (num, den) in [(1u64, 10_000u64), (125, 10_000), (9_999, 10_000)] {
        let rs = u64::MAX;
        let fixture = raydium_v4_fixture(u64::MAX, rs, num, den);
        let cap64 = u64::try_from(reference_cap(rs, num as u128, den as u128)).unwrap();
        let admitted = run_single(&mollusk, &fixture, cap64, 1);
        assert_ne!(admitted, REFERENCE_CAP_EXCEEDED, "cap at u64::MAX depth admitted: fee={num}/{den}");
        let refused = run_single(&mollusk, &fixture, cap64 + 1, 1);
        assert_eq!(refused, REFERENCE_CAP_EXCEEDED, "cap+1 at u64::MAX depth refused: fee={num}/{den}");
    }
}

/// Monotonic in depth: any amount the cap admits at depth d1 it also admits
/// at every depth d2 >= d1 (same fee).
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cap_monotonic_in_depth() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xD3);
    for _ in 0..120 {
        let den = 10_000u64;
        let num = rng.range(1, den - 1);
        let d1 = rng.range(1, u64::MAX / 2);
        let d2 = d1 + rng.below(u64::MAX - d1) .max(1);
        let cap1 = reference_cap(d1, num as u128, den as u128);
        // Probe right at d1's boundary, where a monotonicity break would show.
        let amount = u64::try_from(cap1).unwrap().max(1);
        let f1 = raydium_v4_fixture(1_000_000_000_000, d1, num, den);
        let f2 = raydium_v4_fixture(1_000_000_000_000, d2, num, den);
        let a1 = run_single(&mollusk, &f1, amount, 1) != REFERENCE_CAP_EXCEEDED;
        let a2 = run_single(&mollusk, &f2, amount, 1) != REFERENCE_CAP_EXCEEDED;
        if a1 {
            assert!(
                a2,
                "cap not monotonic in depth: fee={num}/{den} amount={amount} admitted at depth {d1} but refused at deeper {d2} (seed {seed_value})"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 2. CONSTANT-PRODUCT FLOOR — the zero-floor bug, and exact value agreement
// ---------------------------------------------------------------------------

/// THE KNOWN-BUG TEST. `cp_out` returns Some(0) on truncation and the
/// tolerance multiply truncates again, so a reference pool holding very few
/// token atoms yields a FLOOR OF ZERO which the handler then accepts for any
/// caller `minimum_output >= 1` — a burn with no price protection at all.
///
/// Probe pair per (rt, rs): with the documented shape fee=125 bps, tol=500 bps
/// and `amount_in = cap`:
///   * minimum_output = 0 -> 6002 proves the derived floor was exactly zero;
///   * minimum_output = 1 -> 6003 (the sentinel) proves the input was ACCEPTED.
/// Their conjunction is the bug. Fixed code must never produce it: a floor of
/// zero must be refused inside the floor computation, for both probes alike.
///
/// EXPECTED TO FAIL against the pre-fix artifact (rt <= ~163 at any deep rs),
/// and to pass once the concurrent refactor lands its cp_out fix.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn zero_floor_must_never_be_accepted() {
    let mollusk = load_mollusk();
    let mut violations: Vec<(u64, u64, u64)> = Vec::new();
    let mut zero_floor_seen = 0usize;

    let depths: [u64; 4] = [100_000, 1_000_000_000, 1_000_000_000_000, u64::MAX / 1_000];
    for &rs in &depths {
        for rt in 1..=200u64 {
            let fixture = raydium_v4_fixture(rt, rs, 125, 10_000);
            let cap = u64::try_from(reference_cap(rs, 125, 10_000)).unwrap();
            if cap == 0 {
                continue;
            }
            let with_zero_min = run_single(&mollusk, &fixture, cap, 0);
            let with_one_min = run_single(&mollusk, &fixture, cap, 1);
            let floor_was_zero = with_zero_min == ZERO_MINIMUM_OUTPUT;
            let accepted = with_one_min == FLOOR_ADMITTED;
            if floor_was_zero {
                zero_floor_seen += 1;
            }
            if floor_was_zero && accepted {
                violations.push((rt, rs, cap));
            }
        }
    }
    // A few sub-cap amounts as well: the hazard is not limited to amount==cap.
    let mut rng = Rng(seed() ^ 0x2F);
    for _ in 0..200 {
        let rs = rng.range(10_000, u64::MAX / 1_000);
        let rt = rng.range(1, 400);
        let cap = u64::try_from(reference_cap(rs, 125, 10_000)).unwrap();
        if cap == 0 {
            continue;
        }
        let amount = rng.range(1, cap);
        let fixture = raydium_v4_fixture(rt, rs, 125, 10_000);
        let floor_was_zero = run_single(&mollusk, &fixture, amount, 0) == ZERO_MINIMUM_OUTPUT;
        let accepted = run_single(&mollusk, &fixture, amount, 1) == FLOOR_ADMITTED;
        if floor_was_zero && accepted {
            violations.push((rt, rs, amount));
        }
    }

    assert!(
        violations.is_empty(),
        "ZERO FLOOR ACCEPTED: {} (rt, rs, amount_in) shapes derived a floor of 0 \
         and still admitted the burn with minimum_output=1 — no price protection. \
         First violations: {:?}. (Distinct zero-floor observations incl. refused-either-way: {})",
        violations.len(),
        &violations[..violations.len().min(8)],
        zero_floor_seen,
    );
}

/// The exact FLOOR VALUE, recovered from the artifact through the split
/// handler's `minimum_output < floor -> 6021` refusal by binary search, must
/// agree with the independent 128-bit reference on every fixture. This is the
/// quantitative check on cp_out's widening mul/div, the fee subtraction, and
/// the tolerance haircut — all three truncations, byte-for-byte.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn floor_value_matches_reference_exactly() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x77);
    let mut cases = 0usize;

    for _ in 0..28 {
        let rs = rng.range(50_000_000_000, u64::MAX / 4); // >= 50 SOL min-depth (Change 2)
        // rt stays below the region where cp * 9500 exceeds u64::MAX; that
        // region is exercised separately by
        // `floor_survives_u64_overflow_in_tolerance_multiply` (a live
        // finding: the artifact refuses it 6027 today).
        let rt = match rng.below(3) {
            0 => rng.range(1_000, 1_000_000_000),
            1 => rng.range(1_000_000_000, 1_000_000_000_000),
            _ => rng.range(1_000_000_000_000, 1_500_000_000_000_000),
        };
        let den = 10_000u64;
        let num = rng.range(1, 2_000);
        let cap = u64::try_from(reference_cap(rs, num as u128, den as u128)).unwrap();
        if cap < 2 {
            continue;
        }
        let amount = rng.range(1, cap);
        let Some(expected_floor) = reference_floor(rt, rs, num as u128, den as u128, false, amount)
        else {
            continue;
        };
        if expected_floor < 2 {
            continue; // measured-floor probe cannot distinguish 0 from 1
        }
        // Outside this bound the artifact's u64 tolerance multiply overflows
        // (the separate finding); keep this test to the agreement region.
        let net = (amount as u128) * ((den - num) as u128) / (den as u128);
        let cp = (rt as u128) * net / (rs as u128 + net);
        if cp > (u64::MAX / 9_500) as u128 {
            continue;
        }

        let split = split_rayv4_floor_fixture(rt, rs, num, den);
        // Sentinel calibration: a minimum at u64::MAX can never be below the
        // floor, so the observed code there is the post-floor sentinel.
        let sentinel = run_split_min(&mollusk, &split, amount, u64::MAX);
        assert_ne!(sentinel, SLIPPAGE_EXCEEDED, "sentinel calibration failed");
        assert_eq!(
            run_split_min(&mollusk, &split, amount, 1),
            SLIPPAGE_EXCEEDED,
            "a minimum of 1 must sit below a floor of {expected_floor} (rt={rt} rs={rs} fee={num}/{den} amount={amount}, seed {seed_value})"
        );

        // Smallest admitted minimum == the artifact's derived floor.
        let (mut lo, mut hi) = (1u64, u64::MAX);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if run_split_min(&mollusk, &split, amount, mid) == SLIPPAGE_EXCEEDED {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        assert_eq!(
            lo, expected_floor,
            "artifact floor {lo} != 128-bit reference floor {expected_floor} \
             (rt={rt} rs={rs} fee={num}/{den} amount={amount}, seed {seed_value})"
        );
        cases += 1;
    }
    assert!(cases >= 12, "too few measurable floor fixtures generated: {cases}");

    // -- pump_exact_in branch: divide by (den+num), then reserve one atom --
    let mut pump_cases = 0usize;
    for _ in 0..16 {
        let vq = rng.range(1_000_000, 1_000_000_000_000_000);
        let vt = rng.range(1_000, 1_000_000_000_000_000);
        let protocol_bps = rng.range(1, 1_000); // plausible band: honored as-is
        let cap = u64::try_from(reference_cap(vq, protocol_bps as u128, 10_000)).unwrap();
        if cap < 2 {
            continue;
        }
        let amount = rng.range(2, cap);
        let Some(expected_floor) =
            reference_floor(vt, vq, protocol_bps as u128, 10_000, true, amount)
        else {
            continue;
        };
        if expected_floor < 2 {
            continue;
        }
        let net = (amount as u128) * 10_000 / (10_000 + protocol_bps as u128) - 1;
        let cp = (vt as u128) * net / (vq as u128 + net);
        if cp > (u64::MAX / 9_500) as u128 {
            continue;
        }

        let split = split_pump_floor_fixture(vt, vq, protocol_bps);
        let sentinel = run_split_min(&mollusk, &split, amount, u64::MAX);
        assert_ne!(sentinel, SLIPPAGE_EXCEEDED, "pump sentinel calibration failed");
        let (mut lo, mut hi) = (1u64, u64::MAX);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if run_split_min(&mollusk, &split, amount, mid) == SLIPPAGE_EXCEEDED {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        assert_eq!(
            lo, expected_floor,
            "pump_exact_in artifact floor {lo} != reference {expected_floor} \
             (vt={vt} vq={vq} fee={protocol_bps}/10000 amount={amount}, seed {seed_value})"
        );
        pump_cases += 1;
    }
    assert!(pump_cases >= 6, "too few measurable pump floor fixtures: {pump_cases}");
    println!(
        "floor value: {cases} raydium + {pump_cases} pump_exact_in fixtures measured by ~64-step \
         binary search, all exact"
    );
}

// ---------------------------------------------------------------------------
// 3. FEE-TIER SELECTION: artifact binary search vs naive linear scan
// ---------------------------------------------------------------------------

/// Random sorted tier tables (duplicates, single-tier, empty, below-first,
/// above-last, exact-threshold hits): the fee the artifact selects is
/// recovered from the measured cap and must equal the naive linear scan's
/// pick on every input. Includes the real shapes: Pump.fun's single tier
/// (protocol 95 / creator 30) and a PumpSwap-style 25-tier slide 125 -> 30.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn fee_tier_binary_search_matches_linear_scan() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xFEE);
    let mut agreed = 0usize;

    // -- anchor: Pump.fun's live single-tier config ------------------------
    for creator_nonzero in [false, true] {
        let tiers = [FeeTier { threshold: 0, lp: 20, protocol: 95, creator: 30 }];
        let vq = 30_000_000_000u64; // 30 SOL virtual quote
        let fixture =
            pump_curve_fixture(1_000_000_000_000_000, vq, creator_nonzero, (11, 13, 17), &tiers);
        let total = if creator_nonzero { 95 + 30 } else { 95 }; // lp excluded on the curve
        assert_cap_is(&mollusk, &fixture, reference_cap(vq, total, 10_000), "pump.fun 1-tier");
        agreed += 1;
    }

    // -- anchor: a PumpSwap-style 25-tier slide 125 -> 30 bps --------------
    {
        let mut tiers = Vec::new();
        for i in 0..25u64 {
            tiers.push(FeeTier {
                threshold: (i as u128) * 5_000_000_000_000, // every 5k SOL of market cap
                lp: 5,
                protocol: 120 - (90 * i.min(24)) / 24, // 120 -> 30
                creator: 0,
            });
        }
        for probe_mc_index in [0u64, 1, 12, 24, 30] {
            let base_amt = 1_000_000_000_000u64;
            let supply = 1_000_000_000_000u64; // mc == quote_amt (supply/base == 1)
            let quote_amt =
                u64::try_from(probe_mc_index as u128 * 5_000_000_000_000 + 17).unwrap();
            let fixture =
                pump_swap_fixture(base_amt, quote_amt, 0, supply, false, (1, 2, 3), &tiers);
            let mc = (quote_amt as u128) * (supply as u128) / (base_amt as u128);
            let total = pump_total_fee((1, 2, 3), &tiers, mc, true, false);
            assert_cap_is(
                &mollusk,
                &fixture,
                reference_cap(quote_amt, total, 10_000),
                "pumpswap 25-tier slide",
            );
            agreed += 1;
        }
    }

    // -- randomized differential campaign ----------------------------------
    for case in 0..120 {
        // Draw the pool so mc is exactly computable: mc = vq * 1e15 / vt.
        let vq = rng.range(1_000_000_000, 1_000_000_000_000_000);
        let vt = rng.range(1_000_000_000_000, u64::MAX / 2);
        let mc = (vq as u128) * PUMP_FIXED_SUPPLY / (vt as u128);

        // Sorted table around mc: sizes 0..=30, duplicates allowed, an exact
        // ==mc threshold sometimes, thresholds below/at/above mc.
        let count = match rng.below(6) {
            0 => 0usize,
            1 => 1,
            2 => 2,
            3 => rng.below(5) as usize + 3,
            4 => 25,
            _ => 30,
        };
        let mut thresholds: Vec<u128> = (0..count)
            .map(|_| match rng.below(6) {
                0 => 0,
                1 => mc, // exact boundary hit
                2 => mc.saturating_sub(rng.below(1_000) as u128 + 1),
                3 => mc + rng.below(1_000) as u128 + 1,
                4 => (rng.next() as u128) << 64 | rng.next() as u128, // far above any u64 mc
                _ => rng.next() as u128,
            })
            .collect();
        thresholds.sort_unstable();
        if count >= 2 && rng.below(2) == 0 {
            // Force a duplicate threshold with DIFFERENT fees: last one wins.
            let i = rng.below(count as u64 - 1) as usize;
            thresholds[i + 1] = thresholds[i];
        }
        // Fee draws keep most selected totals inside the plausible [1, 1000]
        // band so tier selection is observable through the cap; occasional
        // implausible tiers exercise the conservative 1 bps fallback.
        let draw_fees = |rng: &mut Rng| -> (u64, u64, u64) {
            if rng.below(8) == 0 {
                (rng.next(), rng.next(), rng.next()) // implausible -> fallback
            } else {
                (rng.below(200), rng.range(1, 700), rng.below(250))
            }
        };
        let tiers: Vec<FeeTier> = thresholds
            .iter()
            .map(|&threshold| {
                let (lp, protocol, creator) = draw_fees(&mut rng);
                FeeTier { threshold, lp, protocol, creator }
            })
            .collect();
        let flat = draw_fees(&mut rng);
        let creator_nonzero = rng.below(2) == 0;

        let fixture = pump_curve_fixture(vt, vq, creator_nonzero, flat, &tiers);
        let total = pump_total_fee(flat, &tiers, mc, false, creator_nonzero);
        assert!(total >= 1 && total <= 1_000, "reference model keeps fees in band");
        assert_cap_is(
            &mollusk,
            &fixture,
            reference_cap(vq, total, 10_000),
            &format!("random table case {case} (seed {seed_value})"),
        );
        agreed += 1;
    }

    // -- degenerate CONTENT degrades to the conservative 1 bps fallback ----
    // (the fee-source identity, by contrast, fails closed: tested below)
    for (flat, tiers, label) in [
        ((0u64, 0u64, 0u64), Vec::<FeeTier>::new(), "empty table, zero flat -> zero total"),
        ((0, 10_000, 0), vec![], "total above the plausible band"),
        (
            (0, 1, 0),
            vec![FeeTier { threshold: 0, lp: 0, protocol: u64::MAX, creator: 1 }],
            "tier total overflows u64",
        ),
        ((0, 1_001, 0), vec![], "just above the plausible band"),
    ] {
        let vq = 1_000_000_000_000u64;
        let fixture = pump_curve_fixture(1_000_000_000_000_000, vq, true, flat, &tiers);
        assert_cap_is(
            &mollusk,
            &fixture,
            reference_cap(vq, PUMP_FEE_FALLBACK_BPS, 10_000),
            &format!("degenerate content falls back to 1 bps ({label})"),
        );
        agreed += 1;
    }
    // Exact plausibility boundary: 1000 is honored, 1001 falls back.
    {
        let vq = 1_000_000_000_000u64;
        let fixture =
            pump_curve_fixture(1_000_000_000_000_000, vq, false, (0, 1_000, 0), &[]);
        assert_cap_is(&mollusk, &fixture, reference_cap(vq, 1_000, 10_000), "total == 1000 honored");
        agreed += 1;
    }

    // -- fee-source IDENTITY fails closed as 6014 --------------------------
    {
        let pump_swap = Pubkey::new_from_array(PUMP_SWAP_PROGRAM);
        let wrong_venue_fee =
            fee_config_account(&pump_swap, (0, 95, 30), &[]); // wrong PDA for pump.fun
        let mut fixture = pump_curve_fixture(
            1_000_000_000_000_000,
            1_000_000_000_000,
            false,
            (0, 95, 30),
            &[],
        );
        let last = fixture.metas.len() - 1;
        fixture.metas[last] = AccountMeta::new_readonly(wrong_venue_fee.0, false);
        fixture.accounts.push(wrong_venue_fee);
        for amount in [1u64, 1_000_000] {
            let code = run_single(&mollusk, &fixture, amount, 1);
            assert_eq!(
                code, REFERENCE_INVALID,
                "a fee account derived for the WRONG venue must be refused 6014"
            );
        }
        agreed += 1;
    }

    println!("fee tiers: {agreed} table/market-cap cases, binary search == linear scan on all");
}

/// Pins the artifact's cap for a fixture to an exact expected value using the
/// admitted(cap)/refused(cap+1) pair — which uniquely determines the cap and
/// therefore the selected fee.
fn assert_cap_is(mollusk: &Mollusk, fixture: &SingleFixture, expected_cap: u128, label: &str) {
    let cap64 = u64::try_from(expected_cap).expect("cap fits u64");
    if cap64 >= 1 {
        let code = run_single(mollusk, fixture, cap64, 1);
        assert_ne!(
            code, REFERENCE_CAP_EXCEEDED,
            "{label}: expected cap {cap64} but the artifact refused amount == cap"
        );
    }
    if cap64 < u64::MAX {
        let code = run_single(mollusk, fixture, cap64 + 1, 1);
        assert_eq!(
            code, REFERENCE_CAP_EXCEEDED,
            "{label}: expected cap {cap64} but the artifact admitted cap+1"
        );
    }
}

// ---------------------------------------------------------------------------
// 4. SEED DERIVATION: the configuration IS the address
// ---------------------------------------------------------------------------

/// Split-path mutation tests against the artifact: the control configuration
/// passes the vault pin (fails deeper, at leg 0's bare reference: 6014), and
/// EVERY mutation of weights, ordering, targets, leg count, or launch mint is
/// refused 6012 against the control vault.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn split_vault_pin_binds_every_config_element() {
    let mollusk = load_mollusk();

    let launch = Pubkey::new_from_array([0x41; 32]);
    let other_launch = Pubkey::new_from_array([0x42; 32]);
    let mints = [
        Pubkey::new_from_array([0x43; 32]),
        Pubkey::new_from_array([0x44; 32]),
        Pubkey::new_from_array([0x45; 32]),
        Pubkey::new_from_array([0x46; 32]),
    ];
    let control_weights = [5_000u16, 3_000, 2_000];
    let control_mints = [mints[0], mints[1], mints[2]];
    // `run_split_config` builds Bare references, whose bound seeds are the
    // deterministic [0x90+i; 32] addresses `split_fixture` assigns.
    let bare_refs = [LegRef::Bare, LegRef::Bare, LegRef::Bare];
    let control_pda = derive_split_pda_bound(&launch, &control_mints, &control_weights, &bare_refs);

    // Control: the host-derived vault passes the artifact's pin and execution
    // proceeds to leg 0's floor, where the bare reference account is 6014.
    let control = run_split_config(
        &mollusk,
        &launch,
        &control_mints,
        &control_weights,
        control_pda,
    );
    assert_eq!(
        control, REFERENCE_INVALID,
        "control config must pass the 6012 vault pin (host and artifact agree on the derivation) \
         and fail deeper at the bare reference"
    );

    // Mutations, all executed against the CONTROL vault address.
    let mutations: Vec<(&str, Pubkey, Vec<Pubkey>, Vec<u16>)> = vec![
        ("weight shifted by 1 bps", launch, control_mints.to_vec(), vec![4_999, 3_001, 2_000]),
        ("legs reordered", launch, vec![mints[1], mints[0], mints[2]], vec![3_000, 5_000, 2_000]),
        ("target replaced", launch, vec![mints[0], mints[1], mints[3]], control_weights.to_vec()),
        ("leg dropped", launch, vec![mints[0], mints[1]], vec![5_000, 5_000]),
        ("launch mint changed", other_launch, control_mints.to_vec(), control_weights.to_vec()),
    ];
    for (label, launch_mint, mutated_mints, mutated_weights) in mutations {
        let code = run_split_config(
            &mollusk,
            &launch_mint,
            &mutated_mints,
            &mutated_weights,
            control_pda,
        );
        assert_eq!(
            code, INVALID_BURN_PDA,
            "mutation '{label}' must derive a DIFFERENT vault and be refused 6012"
        );
    }
    println!("vault pin: control passed the pin; 5/5 config mutations refused 6012");
}

/// Host-side collision sweep over the seed layout
/// ("burner", launch, target_0.., le-u16 bps blob): distinct configurations
/// must derive distinct addresses. Encodes the offline 2,081,954-config
/// zero-collision result as a regression property (scaled by env).
#[test]
#[ignore = "long-running host sweep; run explicitly"]
fn seed_derivation_collision_sweep() {
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x5EED);
    let sweep = env_u64("KEYLESS_SEED_SWEEP", 20_000) as usize;

    let mut seen: HashSet<Pubkey> = HashSet::with_capacity(sweep);
    let mut configs: Vec<(Pubkey, Vec<Pubkey>, Vec<u16>, Vec<[u8; 32]>)> = Vec::new();
    for _ in 0..sweep {
        let launch = rng.pubkey();
        let legs = rng.range(1, 4) as usize;
        let mints: Vec<Pubkey> = (0..legs).map(|_| rng.pubkey()).collect();
        // Reference seeds: random addresses, with an occasional Pump
        // zero-sentinel leg, exactly the two shapes `build_split_seeds` emits.
        let refs: Vec<[u8; 32]> = (0..legs)
            .map(|_| if rng.below(5) == 0 { [0u8; 32] } else { rng.pubkey().to_bytes() })
            .collect();
        let mut weights: Vec<u16> = Vec::new();
        let mut remaining = 10_000u16;
        for i in 0..legs {
            let w = if i + 1 == legs {
                remaining
            } else {
                let w = 1 + (rng.below(remaining as u64 - (legs - i - 1) as u64) as u16);
                remaining -= w;
                w
            };
            weights.push(w);
        }
        let pda = derive_split_pda(&launch, &mints, &weights, &refs);
        assert!(
            seen.insert(pda),
            "PDA collision between distinct configurations (seed {seed_value})"
        );
        if configs.len() < 2_000 {
            configs.push((launch, mints, weights, refs));
        }
    }

    // Targeted single-element mutations on sampled configs: every change to
    // any weight, target, ordering, leg count, or launch mint moves the
    // address.
    let mut mutation_checks = 0usize;
    for (launch, mints, weights, refs) in &configs {
        let base = derive_split_pda(launch, mints, weights, refs);
        // Weight redistribution (keeps the 10000 sum).
        if weights.len() >= 2 && weights[0] >= 2 {
            let mut w = weights.clone();
            w[0] -= 1;
            w[1] += 1;
            assert_ne!(base, derive_split_pda(launch, mints, &w, refs), "weight change must move the PDA");
            mutation_checks += 1;
        }
        // Reorder two legs (weights and references follow their mints: same
        // portfolio, different committed ordering).
        if mints.len() >= 2 {
            let mut m = mints.clone();
            m.swap(0, 1);
            let mut w = weights.clone();
            w.swap(0, 1);
            let mut r = refs.clone();
            r.swap(0, 1);
            assert_ne!(base, derive_split_pda(launch, &m, &w, &r), "reordering must move the PDA");
            mutation_checks += 1;
        }
        // Replace a target.
        {
            let mut m = mints.clone();
            m[0] = rng.pubkey();
            assert_ne!(base, derive_split_pda(launch, &m, weights, refs), "target change must move the PDA");
            mutation_checks += 1;
        }
        // Change the launch mint.
        {
            let other = rng.pubkey();
            assert_ne!(base, derive_split_pda(&other, mints, weights, refs), "launch change must move the PDA");
            mutation_checks += 1;
        }
        // Replace a reference (THE BINDING PROPERTY): any change to any
        // leg's bound reference — including sentinel <-> address flips —
        // must move the address.
        {
            let mut r = refs.clone();
            r[0] = if r[0] == [0u8; 32] { rng.pubkey().to_bytes() } else { [0u8; 32] };
            assert_ne!(base, derive_split_pda(launch, mints, weights, &r), "reference change must move the PDA");
            let mut r2 = refs.clone();
            r2[0] = rng.pubkey().to_bytes();
            assert_ne!(base, derive_split_pda(launch, mints, weights, &r2), "reference change must move the PDA");
            mutation_checks += 2;
        }
        // Drop a leg.
        if mints.len() >= 2 {
            let m = &mints[..mints.len() - 1];
            let mut w = weights[..weights.len() - 1].to_vec();
            let dropped = weights[weights.len() - 1];
            w[0] += dropped; // keep the sum
            let r = &refs[..refs.len() - 1];
            assert_ne!(base, derive_split_pda(launch, m, &w, r), "leg-count change must move the PDA");
            mutation_checks += 1;
        }
    }
    println!(
        "seed sweep: {sweep} random configs collision-free, {mutation_checks} targeted mutations all moved the address"
    );
}

fn derive_split_pda(launch: &Pubkey, mints: &[Pubkey], weights: &[u16], refs: &[[u8; 32]]) -> Pubkey {
    assert_eq!(mints.len(), weights.len());
    assert_eq!(mints.len(), refs.len(), "one bound reference seed per leg");
    let blob: Vec<u8> = weights.iter().flat_map(|w| w.to_le_bytes()).collect();
    let mut seeds: Vec<&[u8]> = vec![b"burner", launch.as_ref()];
    for mint in mints {
        seeds.push(mint.as_ref());
    }
    seeds.push(&blob);
    for r in refs {
        seeds.push(r.as_ref());
    }
    Pubkey::find_program_address(&seeds, &key(BURNER_PROGRAM)).0
}

/// The UNBOUND (pre-binding) derivation, kept only to prove the artifact no
/// longer accepts it.
fn derive_split_pda_unbound(launch: &Pubkey, mints: &[Pubkey], weights: &[u16]) -> Pubkey {
    let blob: Vec<u8> = weights.iter().flat_map(|w| w.to_le_bytes()).collect();
    let mut seeds: Vec<&[u8]> = vec![b"burner", launch.as_ref()];
    for mint in mints {
        seeds.push(mint.as_ref());
    }
    seeds.push(&blob);
    Pubkey::find_program_address(&seeds, &key(BURNER_PROGRAM)).0
}

/// The seed each `LegRef` variant binds, matching the deterministic keys
/// `split_fixture` assigns: Bare and RayV4 bind their reference's address;
/// the Pump venues bind the zero sentinel.
fn leg_ref_seed(leg: &LegRef, i: usize) -> [u8; 32] {
    match leg {
        LegRef::Bare => [0x90 + i as u8; 32],
        LegRef::RayV4 { .. } => [0xD0 + i as u8; 32],
        LegRef::PumpCurve { .. } | LegRef::PumpSwap { .. } => [0u8; 32],
    }
}

fn derive_split_pda_bound(
    launch: &Pubkey,
    mints: &[Pubkey],
    weights: &[u16],
    leg_refs: &[LegRef],
) -> Pubkey {
    let seeds: Vec<[u8; 32]> =
        leg_refs.iter().enumerate().map(|(i, leg)| leg_ref_seed(leg, i)).collect();
    derive_split_pda(launch, mints, weights, &seeds)
}

// ---------------------------------------------------------------------------
// Split fixture builders (keyless: 8 fixed accounts + 7 per leg)
// ---------------------------------------------------------------------------

struct SplitFixture {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    launch: Pubkey,
    weights: Vec<u16>,
    total: u64,
}

/// Per-leg reference block: either inert bare accounts (floor fails 6014
/// after the vault pin — the config-binding sentinel), or a valid Raydium v4
/// reference (floor computes; `minimum_output` becomes the probe).
#[derive(Clone, Copy)]
enum LegRef {
    Bare,
    RayV4 { rt: u64, rs: u64, num: u64, den: u64 },
    /// Pump bonding curve with a flat-only fee config (protocol bps, creator
    /// default): exercises the pump_exact_in fee branch (divide by den+num,
    /// then reserve one atom) in the floor-value differential.
    PumpCurve { vt: u64, vq: u64, protocol_bps: u64 },
    /// Canonical PumpSwap migration pool (stored `creator` is the
    /// pool-authority PDA of the leg's mint), flat-only fee config: the
    /// post-graduation half of the zero-sentinel story.
    PumpSwap { base_amt: u64, quote_amt: u64, protocol_bps: u64 },
}

fn split_fixture(
    launch: &Pubkey,
    mints: &[Pubkey],
    weights: &[u16],
    burn_pda: Pubkey,
    leg_refs: &[LegRef],
    total: u64,
) -> SplitFixture {
    let caller = Pubkey::new_from_array([0x30; 32]);
    let quote_slot = Pubkey::new_from_array([0x31; 32]); // unused in keyless
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);

    let mut metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(quote_slot, false),
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(*launch, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
    ];
    let mut accounts = vec![
        (caller, system_account(1_000_000)),
        (quote_slot, system_account(1_000_000)),
        (burn_pda, system_account(total + RENT_FLOOR_ZERO_DATA)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                wsol,
                burn_pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (*launch, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
    ];

    for (i, mint) in mints.iter().enumerate() {
        let ata = associated_token_address(&burn_pda, mint);
        metas.push(AccountMeta::new(*mint, false));
        metas.push(AccountMeta::new(ata, false));
        metas.push(AccountMeta::new_readonly(token::ID, false));
        accounts.push((*mint, token::create_account_for_mint(immutable_mint(1_000_000, 6))));
        accounts.push((
            ata,
            token::create_account_for_token_account(token_account(*mint, burn_pda, 0, None)),
        ));

        match &leg_refs[i] {
            LegRef::Bare => {
                let reference = Pubkey::new_from_array([0x90 + i as u8; 32]);
                let vault_a = Pubkey::new_from_array([0xA0 + i as u8; 32]);
                let vault_b = Pubkey::new_from_array([0xB0 + i as u8; 32]);
                let fee = Pubkey::new_from_array([0xC0 + i as u8; 32]);
                for pk in [reference, vault_a, vault_b, fee] {
                    metas.push(AccountMeta::new_readonly(pk, false));
                    accounts.push((pk, system_account(1)));
                }
            }
            LegRef::RayV4 { rt, rs, num, den } => {
                let pool_key = Pubkey::new_from_array([0xD0 + i as u8; 32]);
                let vault_a_key = Pubkey::new_from_array([0xD8 + i as u8; 32]);
                let vault_b_key = Pubkey::new_from_array([0xE0 + i as u8; 32]);
                let authority = Pubkey::new_from_array([0xE8 + i as u8; 32]);
                let mut pool_data = vec![0u8; 400];
                pool_data[144..152].copy_from_slice(&num.to_le_bytes());
                pool_data[152..160].copy_from_slice(&den.to_le_bytes());
                pool_data[336..368].copy_from_slice(vault_a_key.as_ref());
                pool_data[368..400].copy_from_slice(vault_b_key.as_ref());
                let pool = Account {
                    lamports: 6_124_800,
                    data: pool_data,
                    owner: Pubkey::new_from_array(RAYDIUM_V4),
                    executable: false,
                    rent_epoch: 0,
                };
                metas.push(AccountMeta::new_readonly(pool_key, false));
                metas.push(AccountMeta::new_readonly(vault_a_key, false));
                metas.push(AccountMeta::new_readonly(vault_b_key, false));
                metas.push(AccountMeta::new_readonly(pool_key, false)); // fee source == pool
                accounts.push((pool_key, pool));
                accounts.push((vault_a_key, raw_vault_account(token::ID, mint, &authority, *rt)));
                accounts.push((vault_b_key, raw_vault_account(token::ID, &wsol, &authority, *rs)));
            }
            LegRef::PumpSwap { base_amt, quote_amt, protocol_bps } => {
                let pump = Pubkey::new_from_array(PUMP_FUN_PROGRAM);
                let pump_swap = Pubkey::new_from_array(PUMP_SWAP_PROGRAM);
                let pool_key = Pubkey::new_from_array([0x18 + i as u8; 32]);
                let vault_a_key = Pubkey::new_from_array([0x1C + i as u8; 32]);
                let vault_b_key = Pubkey::new_from_array([0x20 + i as u8; 32]);
                let authority = Pubkey::new_from_array([0x24 + i as u8; 32]);
                let (pool_authority, _) =
                    Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &pump);
                let mut pool_data = vec![0u8; 300];
                pool_data[11..43].copy_from_slice(pool_authority.as_ref());
                pool_data[139..171].copy_from_slice(vault_a_key.as_ref());
                pool_data[171..203].copy_from_slice(vault_b_key.as_ref());
                // virtual quote 0, coin creator default
                let pool = Account {
                    lamports: 4_000_000,
                    data: pool_data,
                    owner: pump_swap,
                    executable: false,
                    rent_epoch: 0,
                };
                let fee = fee_config_account(&pump_swap, (0, *protocol_bps, 0), &[]);
                metas.push(AccountMeta::new_readonly(pool_key, false));
                metas.push(AccountMeta::new_readonly(vault_a_key, false));
                metas.push(AccountMeta::new_readonly(vault_b_key, false));
                metas.push(AccountMeta::new_readonly(fee.0, false));
                accounts.push((pool_key, pool));
                accounts.push((vault_a_key, raw_vault_account(token::ID, mint, &authority, *base_amt)));
                accounts.push((vault_b_key, raw_vault_account(token::ID, &wsol, &authority, *quote_amt)));
                accounts.push(fee);
            }
            LegRef::PumpCurve { vt, vq, protocol_bps } => {
                let pump = Pubkey::new_from_array(PUMP_FUN_PROGRAM);
                let (curve_key, _) =
                    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &pump);
                let mut curve_data = vec![0u8; 151];
                curve_data[8..16].copy_from_slice(&vt.to_le_bytes());
                curve_data[16..24].copy_from_slice(&vq.to_le_bytes());
                let curve = Account {
                    lamports: 2_000_000,
                    data: curve_data,
                    owner: pump,
                    executable: false,
                    rent_epoch: 0,
                };
                let fee = fee_config_account(&pump, (0, *protocol_bps, 0), &[]);
                let inert_a = Pubkey::new_from_array([0xF0 + i as u8; 32]);
                let inert_b = Pubkey::new_from_array([0xF8 + i as u8; 32]);
                metas.push(AccountMeta::new_readonly(curve_key, false));
                metas.push(AccountMeta::new_readonly(inert_a, false));
                metas.push(AccountMeta::new_readonly(inert_b, false));
                metas.push(AccountMeta::new_readonly(fee.0, false));
                accounts.push((curve_key, curve));
                accounts.push((inert_a, system_account(1)));
                accounts.push((inert_b, system_account(1)));
                accounts.push(fee);
            }
        }
    }

    SplitFixture { metas, accounts, launch: *launch, weights: weights.to_vec(), total }
}

fn split_data(total: u64, weights: &[u16], minimum_outputs: &[u64]) -> Vec<u8> {
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for (i, w) in weights.iter().enumerate() {
        data.extend_from_slice(&w.to_le_bytes());
        data.extend_from_slice(&minimum_outputs[i].to_le_bytes());
        data.push(0); // route_account_count
        data.extend_from_slice(&0u32.to_le_bytes()); // route data length
    }
    data
}

fn run_split(mollusk: &Mollusk, fixture: &SplitFixture, minimum_outputs: &[u64]) -> u32 {
    let data = split_data(fixture.total, &fixture.weights, minimum_outputs);
    let instruction =
        Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&instruction, &fixture.accounts);
    named_code(&result.raw_result, &|| {
        format!(
            "split keyless run: launch={} weights={:?} minimums={minimum_outputs:?}",
            fixture.launch, fixture.weights
        )
    })
}

/// Runs a fully-encoded split config against a (possibly mismatching) vault.
fn run_split_config(
    mollusk: &Mollusk,
    launch: &Pubkey,
    mints: &[Pubkey],
    weights: &[u16],
    burn_pda: Pubkey,
) -> u32 {
    let refs: Vec<LegRef> = mints.iter().map(|_| LegRef::Bare).collect();
    let fixture = split_fixture(launch, mints, weights, burn_pda, &refs, 10_000_000);
    let minimums: Vec<u64> = mints.iter().map(|_| 1).collect();
    run_split(mollusk, &fixture, &minimums)
}

/// One-leg split with a valid Raydium v4 reference and a correctly derived
/// vault, used to binary-search the exact floor via the 6021 refusal.
fn split_rayv4_floor_fixture(rt: u64, rs: u64, num: u64, den: u64) -> SplitFixture {
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = Pubkey::new_from_array([0x4A; 32]);
    let weights = [10_000u16];
    let leg = LegRef::RayV4 { rt, rs, num, den };
    let pda = derive_split_pda_bound(&launch, &[mint], &weights, std::slice::from_ref(&leg));
    split_fixture(&launch, &[mint], &weights, pda, &[leg], 0)
}

/// One-leg split against a Pump bonding-curve reference with a flat-only fee
/// config, for the pump_exact_in floor-value differential.
fn split_pump_floor_fixture(vt: u64, vq: u64, protocol_bps: u64) -> SplitFixture {
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = Pubkey::new_from_array([0x4B; 32]);
    let weights = [10_000u16];
    let leg = LegRef::PumpCurve { vt, vq, protocol_bps };
    let pda = derive_split_pda_bound(&launch, &[mint], &weights, std::slice::from_ref(&leg));
    split_fixture(&launch, &[mint], &weights, pda, &[leg], 0)
}

fn run_split_min(mollusk: &Mollusk, fixture: &SplitFixture, amount: u64, minimum: u64) -> u32 {
    let mut fixture_with_total = SplitFixture {
        metas: fixture.metas.clone(),
        accounts: fixture.accounts.clone(),
        launch: fixture.launch,
        weights: fixture.weights.clone(),
        total: amount,
    };
    // Keep the vault funded for the requested amount.
    for (pk, account) in fixture_with_total.accounts.iter_mut() {
        if *pk == fixture.metas[2].pubkey {
            account.lamports = amount.saturating_add(RENT_FLOOR_ZERO_DATA);
        }
    }
    run_split(mollusk, &fixture_with_total, &[minimum])
}

// ---------------------------------------------------------------------------
// Route-probe runners: the admitted sentinel under the merged build.
// ---------------------------------------------------------------------------

const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
const ROUTE_V2_PREFIX_LEN: usize = 34;
const ROUTE_V2_IN_AMOUNT_OFFSET: usize = 8;

/// A `route_v2` payload whose embedded `in_amount` is `guess`, zero platform /
/// positive-slippage fees, no route accounts. On a leg whose floor was
/// admitted, `guess == derived leg amount` reaches the account-layout pin
/// (6006); any other value is 6008. Mirrors `keyless_binding_admission`'s
/// idiom so the two suites cannot drift.
fn route_probe(guess: u64) -> Vec<u8> {
    let mut d = vec![0u8; ROUTE_V2_PREFIX_LEN];
    d[..8].copy_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
    d[ROUTE_V2_IN_AMOUNT_OFFSET..ROUTE_V2_IN_AMOUNT_OFFSET + 8].copy_from_slice(&guess.to_le_bytes());
    d
}

/// Independent u128 leg-amount model (leg i<n-1 gets floor(total*bps/10000);
/// the last leg the remainder), which the program's q/r decomposition equals
/// exactly. Used to embed each leg's route probe with its correct `in_amount`.
fn model_leg_amounts(total: u64, weights: &[u16]) -> Vec<u64> {
    let n = weights.len();
    let mut out = Vec::with_capacity(n);
    let mut allocated: u128 = 0;
    for (i, w) in weights.iter().enumerate() {
        let amount = if i + 1 == n {
            total as u128 - allocated
        } else {
            (total as u128 * *w as u128) / 10_000
        };
        allocated += amount;
        out.push(u64::try_from(amount).expect("leg amount fits u64"));
    }
    out
}

/// Split data where every leg carries a non-empty `route_probe` with its
/// derived per-leg `in_amount` (route_account_count stays 0). An admitted
/// configuration therefore refuses at the first leg's account-layout pin
/// (6006), never on the curve-adapter path an empty route would take.
fn split_data_probed(total: u64, weights: &[u16], minimum_outputs: &[u64]) -> Vec<u8> {
    let amounts = model_leg_amounts(total, weights);
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for (i, w) in weights.iter().enumerate() {
        data.extend_from_slice(&w.to_le_bytes());
        data.extend_from_slice(&minimum_outputs[i].to_le_bytes());
        data.push(0); // route_account_count
        let route = route_probe(amounts[i]);
        data.extend_from_slice(&(route.len() as u32).to_le_bytes());
        data.extend_from_slice(&route);
    }
    data
}

fn run_split_probed(mollusk: &Mollusk, fixture: &SplitFixture, minimum_outputs: &[u64]) -> u32 {
    let data = split_data_probed(fixture.total, &fixture.weights, minimum_outputs);
    let instruction =
        Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&instruction, &fixture.accounts);
    named_code(&result.raw_result, &|| {
        format!(
            "split keyless probed run: launch={} weights={:?} minimums={minimum_outputs:?}",
            fixture.launch, fixture.weights
        )
    })
}

/// 1-leg probed run: the sole leg's amount is the whole total, so the probe's
/// `in_amount` is `amount`.
fn run_split_min_probed(mollusk: &Mollusk, fixture: &SplitFixture, amount: u64, minimum: u64) -> u32 {
    let mut fixture_with_total = SplitFixture {
        metas: fixture.metas.clone(),
        accounts: fixture.accounts.clone(),
        launch: fixture.launch,
        weights: fixture.weights.clone(),
        total: amount,
    };
    for (pk, account) in fixture_with_total.accounts.iter_mut() {
        if *pk == fixture.metas[2].pubkey {
            account.lamports = amount.saturating_add(RENT_FLOOR_ZERO_DATA);
        }
    }
    run_split_probed(mollusk, &fixture_with_total, &[minimum])
}

// ---------------------------------------------------------------------------
// 5. ARITHMETIC HAZARDS GENERALLY: corruption campaign against the artifact
// ---------------------------------------------------------------------------

/// Structured corruption of every surviving-venue fixture (Raydium v4,
/// Raydium CP, Pump curve, PumpSwap): random byte flips, truncations, owner
/// swaps, extreme reserves/fees/amounts. EVERY outcome must be a named
/// `BurnerError` — in the SBF VM a panic is an abort and an out-of-bounds
/// read is an access violation, so this is the no-panic/no-truncation-abort
/// property for every multiply, shift, and divide in the keyless path.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn corruption_campaign_never_aborts() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xC0);
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 4_000);

    let mut histogram: std::collections::BTreeMap<u32, u64> = std::collections::BTreeMap::new();
    for iteration in 0..iters {
        let mut fixture = match rng.below(4) {
            0 => raydium_v4_fixture(
                extreme_u64(&mut rng),
                extreme_u64(&mut rng),
                rng.below(20_001),
                rng.below(20_001),
            ),
            1 => raydium_cp_fixture(
                extreme_u64(&mut rng),
                extreme_u64(&mut rng),
                rng.below(2_000_000),
            ),
            2 => {
                let tiers: Vec<FeeTier> = (0..rng.below(6))
                    .map(|_| FeeTier {
                        threshold: rng.next() as u128,
                        lp: rng.next(),
                        protocol: rng.next(),
                        creator: rng.next(),
                    })
                    .collect();
                pump_curve_fixture(
                    extreme_u64(&mut rng),
                    extreme_u64(&mut rng),
                    rng.below(2) == 0,
                    (rng.next(), rng.next(), rng.next()),
                    &tiers,
                )
            }
            _ => pump_swap_fixture(
                extreme_u64(&mut rng),
                extreme_u64(&mut rng),
                rng.next() as i128,
                extreme_u64(&mut rng),
                rng.below(2) == 0,
                (rng.below(5_000), rng.below(5_000), rng.below(5_000)),
                &[FeeTier {
                    threshold: rng.next() as u128,
                    lp: rng.below(5_000),
                    protocol: rng.below(5_000),
                    creator: rng.below(5_000),
                }],
            ),
        };

        // Corrupt: byte flips, truncation, owner swaps across the reference,
        // the target mint, both vaults, and the fee source (see the FIX_*
        // indices on the fixture builder). The vault was derived from the
        // PRE-corruption reference owner, so an owner swap that changes the
        // sentinel class must land on 6012 — still a named code.
        let corruptions = rng.below(9);
        for _ in 0..corruptions {
            let victim = [FIX_REFERENCE, FIX_TARGET_MINT, FIX_VAULT_A, FIX_VAULT_B, fixture.accounts.len() - 1]
                [rng.below(5) as usize]
                .min(fixture.accounts.len() - 1);
            let account = &mut fixture.accounts[victim].1;
            match rng.below(4) {
                0 if !account.data.is_empty() => {
                    let at = rng.below(account.data.len() as u64) as usize;
                    account.data[at] ^= 1 << rng.below(8);
                }
                1 => {
                    let new_len = rng.below(account.data.len() as u64 + 1) as usize;
                    account.data.truncate(new_len);
                }
                2 => {
                    account.owner = match rng.below(5) {
                        0 => Pubkey::default(),
                        1 => Pubkey::new_from_array(RAYDIUM_V4),
                        2 => Pubkey::new_from_array(RAYDIUM_CP),
                        3 => Pubkey::new_from_array(PUMP_FUN_PROGRAM),
                        _ => Pubkey::new_from_array(PUMP_SWAP_PROGRAM),
                    };
                }
                _ => {
                    if account.data.len() >= 8 {
                        let at = rng.below(account.data.len() as u64 - 7) as usize;
                        let v = extreme_u64(&mut rng);
                        account.data[at..at + 8].copy_from_slice(&v.to_le_bytes());
                    }
                }
            }
        }

        let amount = extreme_u64(&mut rng).max(1);
        let minimum = match rng.below(3) {
            0 => 0,
            1 => 1,
            _ => rng.next(),
        };
        // named_code panics with context on any abort / unnamed outcome.
        let code = run_single(&mollusk, &fixture, amount, minimum);
        assert!(
            (6000..=6043).contains(&code),
            "iteration {iteration}: unnamed code {code} (seed {seed_value})"
        );
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!(
        "corruption campaign: {iters} iterations, every outcome a named BurnerError; \
         code distribution: {histogram:?}"
    );
}

fn extreme_u64(rng: &mut Rng) -> u64 {
    match rng.below(6) {
        0 => 0,
        1 => 1,
        2 => rng.below(1_000),
        3 => rng.range(1_000, 10_000_000_000),
        4 => u64::MAX - rng.below(1_000),
        _ => rng.next(),
    }
}

/// The one overflow shape reachable inside cp_out with u128 widening —
/// rt * inp — cannot actually overflow for cap-admitted inputs
/// (inp <= depth/4 by the cap and fee algebra), so extreme reserves must
/// produce a floor or a NAMED refusal, never an abort. Probed at the corners.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn extreme_reserves_never_abort() {
    let mollusk = load_mollusk();
    for (rt, rs, num, den) in [
        (u64::MAX, u64::MAX, 5_000u64, 10_000u64),
        (u64::MAX, u64::MAX, 1, 10_000),
        (u64::MAX, u64::MAX, 9_999, 10_000),
        (u64::MAX, 1, 9_999, 10_000),
        (1, u64::MAX, 5_000, 10_000),
    ] {
        let fixture = raydium_v4_fixture(rt, rs, num, den);
        let cap = u64::try_from(reference_cap(rs, num as u128, den as u128)).unwrap();
        for amount in [1u64, cap.max(1), cap.saturating_add(1).max(1), u64::MAX] {
            // named_code inside run_single already rejects aborts.
            let _ = run_single(&mollusk, &fixture, amount, 1);
            let _ = run_single(&mollusk, &fixture, amount, 0);
        }
    }
}

/// NEW FINDING (discovered by this suite's floor differential, 2026-08-24):
/// the tolerance haircut `expected.checked_mul(10_000 - KEYLESS_TOL_BPS)` is
/// a u64 multiply, so any constant-product output above
/// u64::MAX / 9_500 ≈ 1.94e15 atoms overflows and is refused 6027
/// `InvalidInstructionData` — a clean fail-closed revert, never an abort or a
/// wrong floor, but it makes legitimately deep reference pools (large-supply
/// / low-price targets measured in raw atoms) permanently unburnable at
/// realistic sizes even though the true floor fits u64 comfortably.
///
/// This test asserts the WIDENED behaviour (the floor computes and matches
/// the 128-bit reference) and therefore FAILS against the current artifact.
/// If the refusal is instead declared by-design, invert this test to pin the
/// 6027 and document the liveness bound.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn floor_survives_u64_overflow_in_tolerance_multiply() {
    let mollusk = load_mollusk();
    // Deep-but-realistic reference: 5e18 token atoms (a huge-supply meme
    // token at 5-6 decimals) against a 10,000-SOL pool, fee 25 bps, burning
    // 20 SOL — well under the 25-SOL cap. True cp is ~9.96e15 atoms.
    let rt = 5_000_000_000_000_000_000u64;
    let rs = 10_000_000_000_000u64;
    let (num, den) = (25u64, 10_000u64);
    let amount = 20_000_000_000u64;
    assert!(amount as u128 <= reference_cap(rs, num as u128, den as u128));
    let expected_floor =
        reference_floor(rt, rs, num as u128, den as u128, false, amount).expect("floor exists");
    assert!(expected_floor >= 2);

    let split = split_rayv4_floor_fixture(rt, rs, num, den);
    let at_one = run_split_min(&mollusk, &split, amount, 1);
    assert_eq!(
        at_one, SLIPPAGE_EXCEEDED,
        "cp above u64::MAX/9500: the artifact refused the whole burn ({at_one}) instead of \
         deriving the (perfectly u64-representable) floor {expected_floor} — the tolerance \
         multiply overflows in u64"
    );
    let (mut lo, mut hi) = (1u64, u64::MAX);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if run_split_min(&mollusk, &split, amount, mid) == SLIPPAGE_EXCEEDED {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    assert_eq!(lo, expected_floor, "widened floor must match the 128-bit reference");
}

// ===========================================================================
// CHANGE 1 (tolerance 500 -> 100) and CHANGE 2 (reference depth admission)
// ===========================================================================

/// CHANGE 1 PROOF. The output floor is `expected * (10_000 - TOL) / 10_000`.
/// With TOL tightened 500 -> 100 the floor rises, so a burn priced at the OLD
/// 500-bps floor now sits BELOW the tightened floor and is refused 6021 — the
/// direct, on-chain demonstration that the tolerance moved. The reference is a
/// deep (>= 50 SOL) Raydium v4 pool so Change 2's min-depth admits it and only
/// the tolerance governs the floor.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn tolerance_tightened_old_500bps_floor_now_refused() {
    let mollusk = load_mollusk();
    let rt = 5_000_000_000_000u64;
    let rs = 200_000_000_000u64; // 200 SOL, comfortably above the 50-SOL floor
    let (num, den) = (25u64, 10_000u64);
    let cap = (rs as u128 * num as u128 / den as u128) as u64;
    let amount = cap / 4; // in-cap
    // Independent expected constant-product output (pre-tolerance).
    let net = amount as u128 * (den - num) as u128 / den as u128;
    let expected = (rt as u128) * net / (rs as u128 + net);
    let old_floor = (expected * (10_000 - 500) / 10_000) as u64; // the retired TOL=500 floor
    let new_floor = (expected * (10_000 - 100) / 10_000) as u64; // the shipped TOL=100 floor
    assert!(
        new_floor > old_floor,
        "the tightened floor must exceed the old one (less haircut): new {new_floor} old {old_floor}"
    );

    let split = split_rayv4_floor_fixture(rt, rs, num, den);
    // A minimum at the OLD 500-bps floor is now below the tightened floor: 6021.
    assert_eq!(
        run_split_min(&mollusk, &split, amount, old_floor),
        SLIPPAGE_EXCEEDED,
        "a burn priced at the OLD 500-bps floor ({old_floor}) must now be REFUSED; new floor is {new_floor}"
    );
    // A minimum at the NEW 100-bps floor is admitted.
    assert_ne!(
        run_split_min(&mollusk, &split, amount, new_floor),
        SLIPPAGE_EXCEEDED,
        "a burn priced at the new 100-bps floor ({new_floor}) must be admitted"
    );
    // The artifact's derived floor equals the tightened floor exactly.
    let (mut lo, mut hi) = (1u64, u64::MAX);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if run_split_min(&mollusk, &split, amount, mid) == SLIPPAGE_EXCEEDED {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    assert_eq!(lo, new_floor, "recovered floor must equal the TOL=100 floor, not the TOL=500 floor");
}

/// CHANGE 2 PROOF (flagship admission). The shipped flagship split — own-launch
/// 80% / NEIRO 10% / $PUMP 10% — must still be admitted under min-depth. The
/// own-launch leg is a Pump bonding-curve reference (sentinel, EXEMPT from
/// min-depth, so a fresh ~30-SOL curve is fine); the NEIRO leg is a deep
/// Raydium v4 pool (~1,378 SOL); the $PUMP leg's depth is stood in here by a
/// deep Raydium v4 at the measured $PUMP CLMM depth (~4,649 SOL) — the $PUMP
/// leg's REAL DLMM/CLMM admission is proven directly in
/// `venue_layout_artifact.rs::real_pump_dlmm/clmm_pool_floor_and_cap_exact`.
/// The negative contrast proves min-depth is actually gating: drop the NEIRO
/// leg to 40 SOL and the whole flagship is refused 6041.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn flagship_three_leg_config_admitted_under_min_depth() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let own = Pubkey::new_from_array([0x70; 32]); // own-launch target
    let neiro = Pubkey::new_from_array([0x71; 32]);
    let pump = Pubkey::new_from_array([0x72; 32]);
    let mints = [own, neiro, pump];
    let weights = [8_000u16, 1_000, 1_000]; // 80 / 10 / 10
    let own_leg = LegRef::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 30 };
    let neiro_leg = LegRef::RayV4 { rt: 5_000_000_000_000, rs: 1_378_000_000_000, num: 25, den: 10_000 };
    let pump_leg = LegRef::RayV4 { rt: 5_000_000_000_000, rs: 4_649_000_000_000, num: 25, den: 10_000 };
    let legs = [own_leg, neiro_leg, pump_leg];

    let total = 2_000_000u64; // every leg amount sits inside its cap
    let pda = derive_split_pda_bound(&launch, &mints, &weights, &legs);
    let fixture = split_fixture(&launch, &mints, &weights, pda, &legs, total);
    // With a minimum of 1 per leg, leg 0's minimum sits below its floor and the
    // pre-CPI floor pass short-circuits at 6021 — proving leg 0 priced.
    assert_eq!(
        run_split(&mollusk, &fixture, &[1, 1, 1]),
        SLIPPAGE_EXCEEDED,
        "the flagship floor pass must price leg 0 and refuse the deliberately low minimum"
    );
    // With u64::MAX minimums NO leg is refused on slippage, so the ENTIRE
    // floor pass runs to completion (all three legs priced and admitted under
    // min-depth). Each leg carries a route probe with its exact derived
    // in_amount, so execution reaches leg 0's Jupiter account-layout pin (6006)
    // rather than the curve-adapter path an empty route would take. This is the
    // real admission proof: every leg cleared min-depth.
    assert_eq!(
        run_split_probed(&mollusk, &fixture, &[u64::MAX, u64::MAX, u64::MAX]),
        FLOOR_ADMITTED,
        "the flagship 80/10/10 (Pump-sentinel own-launch + deep NEIRO v4 + deep $PUMP-scale) must be fully ADMITTED"
    );
    // Live-sentinel canary: a WRONG leg-0 in_amount must refuse 6008, proving
    // the probe actually reached the Jupiter route validator (not a vacuous
    // pass). leg 0 amount = 2_000_000 * 8_000 / 10_000 = 1_600_000.
    {
        let mut data = split_data_probed(total, &weights, &[u64::MAX, u64::MAX, u64::MAX]);
        // Corrupt leg 0's route probe in_amount (first leg header: 8 disc + 8
        // total + 4 count + [2 bps + 8 min + 1 count + 4 len] = 35, then the
        // route bytes; in_amount sits at +8 into the route).
        let leg0_route_in_amount = 8 + 8 + 4 + (2 + 8 + 1 + 4) + ROUTE_V2_IN_AMOUNT_OFFSET;
        data[leg0_route_in_amount] ^= 1;
        let ix = Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
        let code = named_code(&mollusk.process_instruction(&ix, &fixture.accounts).raw_result, &|| {
            "flagship live-sentinel canary".into()
        });
        assert_eq!(code, INPUT_AMOUNT_MISMATCH, "a wrong leg-0 in_amount must refuse 6008");
    }

    // Negative contrast: drop the NEIRO leg to 40 SOL (below the 50-SOL floor).
    // With u64::MAX minimums the floor pass reaches leg 1 and refuses 6041,
    // proving the gate bites on a real flagship shape.
    let shallow = [own_leg, LegRef::RayV4 { rt: 5_000_000_000_000, rs: 40_000_000_000, num: 25, den: 10_000 }, pump_leg];
    let pda2 = derive_split_pda_bound(&launch, &mints, &weights, &shallow);
    let fixture2 = split_fixture(&launch, &mints, &weights, pda2, &shallow, total);
    assert_eq!(
        run_split(&mollusk, &fixture2, &[u64::MAX, u64::MAX, u64::MAX]),
        REFERENCE_TOO_SHALLOW,
        "a flagship whose NEIRO leg is only 40 SOL must be refused 6041"
    );
}

/// CHANGE 2 PROOF (constant-product depth admission). A deep NEIRO-scale
/// Raydium v4 pool (~1,378 SOL) is admitted; the ~12.9-SOL pool that is
/// $PUMP's ONLY constant-product venue is refused 6041. This is the shippable
/// substitute for a hard "LP-burnt" gate on CP venues: it distinguishes a deep
/// incumbent from a cheaply-owned micro-pool WITHOUT an LP-mint read, so it
/// does not wrongly refuse a deep-but-unburnt pool (RAY) nor kill $PUMP, whose
/// real liquidity lives on the position venues (see FABLE-LOCKED-ADMISSION).
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn min_depth_admits_deep_cp_refuses_shallow_cp() {
    let mollusk = load_mollusk();
    let deep = split_rayv4_floor_fixture(5_000_000_000_000, 1_378_000_000_000, 25, 10_000);
    assert_eq!(
        run_split_min(&mollusk, &deep, 1_000_000, 1),
        SLIPPAGE_EXCEEDED,
        "a NEIRO-scale 1,378-SOL constant-product pool must be admitted and price a floor"
    );
    let shallow = split_rayv4_floor_fixture(5_000_000_000_000, 12_900_000_000, 25, 10_000);
    assert_eq!(
        run_split_min(&mollusk, &shallow, 1_000_000, 1),
        REFERENCE_TOO_SHALLOW,
        "the 12.9-SOL constant-product pool ($PUMP's only CP venue) must be refused 6041"
    );
}


// ===========================================================================
// REFERENCE BINDING: the configuration INCLUDING ITS REFERENCES is the
// address. `PDA(["burner", launch, target_0.., bps_blob, ref_0..])`, with a
// [0u8;32] sentinel for Pump-ecosystem references whose identity the program
// derives instead (curve PDA / canonical PumpSwap creator pin).
// ===========================================================================

const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];

/// The single-target instruction is REFUSED AT DISPATCH under the keyless
/// feature: its legacy derivation `["burner", launch, target]` carries no
/// reference seed, so serving it would bypass binding entirely.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn single_target_dispatch_is_closed() {
    let mollusk = load_mollusk();
    let mut metas = Vec::new();
    let mut accounts = Vec::new();
    let mut rng = Rng(7);
    for i in 0..14usize {
        let pk = rng.pubkey();
        metas.push(AccountMeta::new_readonly(pk, i == 0));
        accounts.push((pk, system_account(1_000_000)));
    }
    let mut data = SWAP_AND_BURN_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&1_000_000u64.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    let instruction = Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data };
    let result = mollusk.process_instruction(&instruction, &accounts);
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(INVALID_INSTRUCTION_DATA)),
        "single-target must be refused at dispatch under keyless (6027)"
    );
}

/// THE CORE BINDING PROPERTY: a vault derived with reference R refuses a burn
/// nominating any other reference R' — the transaction lands on a different,
/// unfunded address (6012) before any pricing or CPI. This is the exact
/// substitution attack the unbound design permitted.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn reference_substitution_is_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = Pubkey::new_from_array([0x4C; 32]);
    let weights = [10_000u16];
    let leg = LegRef::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 };

    // Positive control: the vault bound to THIS pool admits the leg — the
    // pin passes and the floor computes (minimum 1 sits below it).
    let bound = derive_split_pda_bound(&launch, &[mint], &weights, &[leg]);
    let fixture = split_fixture(&launch, &[mint], &weights, bound, &[leg], 0);
    assert_eq!(
        run_split_min(&mollusk, &fixture, 1_000_000, 1),
        SLIPPAGE_EXCEEDED,
        "control: the bound reference must pass the pin and price the floor"
    );

    // Substitution: the creator reviewed and bound pool R ([0xEE..]); the
    // caller nominates the fixture's pool R' instead. Different seed ->
    // different vault -> 6012, vault untouched.
    let reviewed = derive_split_pda(&launch, &[mint], &weights, &[[0xEE; 32]]);
    assert_ne!(reviewed, bound);
    let fixture = split_fixture(&launch, &[mint], &weights, reviewed, &[leg], 0);
    assert_eq!(
        run_split_min(&mollusk, &fixture, 1_000_000, 1),
        INVALID_BURN_PDA,
        "a burn nominating a reference other than the bound one must be 6012"
    );
}

/// THE GRADUATION WRINKLE, solved by the zero sentinel: the flagship
/// own-launch leg's reference MIGRATES at graduation (bonding curve ->
/// canonical PumpSwap pool, different addresses). Both are Pump-owned, so
/// both bind as [0u8;32]: the SAME vault address admits the curve reference
/// before graduation and the canonical pool after it, with the identity
/// enforced inside `keyless_leg_floor` by derivation (curve PDA /
/// creator == pool-authority PDA). A literal bound address would have
/// bricked the vault at the exact moment the token succeeded.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn pump_zero_sentinel_spans_graduation() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = Pubkey::new_from_array([0x4D; 32]);
    let weights = [10_000u16];
    let curve = LegRef::PumpCurve {
        vt: 1_000_000_000_000_000,
        vq: 30_000_000_000,
        protocol_bps: 100,
    };
    let pool = LegRef::PumpSwap {
        base_amt: 1_000_000_000_000_000,
        quote_amt: 30_000_000_000,
        protocol_bps: 100,
    };

    // One address across the migration.
    let vault_curve = derive_split_pda_bound(&launch, &[mint], &weights, &[curve]);
    let vault_pool = derive_split_pda_bound(&launch, &[mint], &weights, &[pool]);
    assert_eq!(
        vault_curve, vault_pool,
        "the sentinel must make the pre- and post-graduation references derive ONE vault"
    );

    // Inside both caps (vq * 100bps = 0.3 SOL).
    let amount = 100_000_000u64;

    // Pre-graduation: the bonding curve prices the floor at that vault. The
    // admitted probe carries the leg's exact in_amount (= amount, a 1-leg
    // split), so it lands on the Jupiter account-layout pin (6006) rather than
    // the curve-adapter path an empty route would take.
    let f = split_fixture(&launch, &[mint], &weights, vault_curve, &[curve], 0);
    assert_eq!(run_split_min(&mollusk, &f, amount, 1), SLIPPAGE_EXCEEDED, "curve floor priced");
    assert_eq!(run_split_min_probed(&mollusk, &f, amount, u64::MAX), FLOOR_ADMITTED, "curve admitted");

    // Post-graduation: the canonical PumpSwap pool prices the floor at the
    // SAME vault — no address change, nothing bricked.
    let g = split_fixture(&launch, &[mint], &weights, vault_pool, &[pool], 0);
    assert_eq!(run_split_min(&mollusk, &g, amount, 1), SLIPPAGE_EXCEEDED, "pool floor priced");
    assert_eq!(run_split_min_probed(&mollusk, &g, amount, u64::MAX), FLOOR_ADMITTED, "pool admitted");

    // No sentinel impersonation: a NON-Pump-owned reference binds by its
    // ADDRESS, never the sentinel, so it lands on a different vault (6012)
    // when aimed at the sentinel-derived one.
    let h = split_fixture(&launch, &[mint], &weights, vault_curve, &[LegRef::Bare], 0);
    assert_eq!(
        run_split_min(&mollusk, &h, amount, 1),
        INVALID_BURN_PDA,
        "a System-owned reference must not reach the sentinel-derived vault"
    );
}

/// Seed-count boundaries: the bound derivation (3 + 2n seeds + bump; 11 + 1
/// at four legs, inside Solana's 16-seed limit) derives and executes at every
/// leg count, and the UNBOUND (pre-binding) derivation is refused 6012 at
/// every leg count.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn binding_holds_at_every_leg_count() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let all_weights: [&[u16]; 4] = [
        &[10_000],
        &[5_000, 5_000],
        &[4_000, 3_000, 3_000],
        &[2_500, 2_500, 2_500, 2_500],
    ];
    for (i, weights) in all_weights.iter().enumerate() {
        let n = i + 1;
        let mints: Vec<Pubkey> =
            (0..n).map(|j| Pubkey::new_from_array([0x60 + j as u8; 32])).collect();
        let legs: Vec<LegRef> = (0..n)
            .map(|_| LegRef::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 })
            .collect();
        let minimums = vec![1u64; n];

        // Bound derivation lands; every leg's floor is priced pre-CPI, and
        // leg 0's minimum of 1 sits below it.
        let pda = derive_split_pda_bound(&launch, &mints, weights, &legs);
        // 2 SOL-millionths total: every leg amount (2_000_000 * bps / 10_000)
        // sits inside the 2_500_000 per-leg cap (rs * 25bps).
        let fixture = split_fixture(&launch, &mints, weights, pda, &legs, 2_000_000);
        assert_eq!(
            run_split(&mollusk, &fixture, &minimums),
            SLIPPAGE_EXCEEDED,
            "bound derivation must land at {n} leg(s)"
        );

        // The unbound derivation is no longer an address this program serves.
        let unbound = derive_split_pda_unbound(&launch, &mints, weights);
        let fixture = split_fixture(&launch, &mints, weights, unbound, &legs, 2_000_000);
        assert_eq!(
            run_split(&mollusk, &fixture, &minimums),
            INVALID_BURN_PDA,
            "unbound derivation must be refused at {n} leg(s)"
        );
    }
}

/// The pre-CPI floor pass: EVERY leg's floor is computed before ANY leg's
/// route validation, so a doomed later leg surfaces before leg 0's route is
/// even parsed. (Before this change, leg 0's empty route data would have
/// produced 6005 first.)
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn all_leg_floors_are_checked_before_any_route() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mints = [Pubkey::new_from_array([0x66; 32]), Pubkey::new_from_array([0x67; 32])];
    let weights = [5_000u16, 5_000];
    // Leg 0 fully valid and ADMITTED (minimum 0 is below no floor only if
    // floor were 0; u64::MAX admits); leg 1's reference is junk.
    let legs = [
        LegRef::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 },
        LegRef::Bare,
    ];
    let pda = derive_split_pda_bound(&launch, &mints, &weights, &legs);
    let fixture = split_fixture(&launch, &mints, &weights, pda, &legs, 2_000_000);
    // Leg 0's minimum admits it; leg 1's floor must still refuse the call
    // BEFORE leg 0 reaches route validation (which would be 6005).
    assert_eq!(
        run_split(&mollusk, &fixture, &[u64::MAX, 1]),
        REFERENCE_INVALID,
        "leg 1's junk reference must refuse before leg 0's route is parsed"
    );
}

// ---------------------------------------------------------------------------
// validate_config Modes A and B: the pre-funding gate now binds and (Mode A)
// content-checks the reference set, so a creator cannot commit the one-shot
// Pump fee share to a vault whose references are inadmissible.
// ---------------------------------------------------------------------------

fn mode_a_data(weights: &[u16], probes: &[u64]) -> Vec<u8> {
    assert_eq!(weights.len(), probes.len());
    let mut d = vec![0x00u8];
    d.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for w in weights {
        d.extend_from_slice(&w.to_le_bytes());
    }
    for p in probes {
        d.extend_from_slice(&p.to_le_bytes());
    }
    d
}

fn mode_b_data(weights: &[u16], refs: &[[u8; 32]]) -> Vec<u8> {
    assert_eq!(weights.len(), refs.len());
    let mut d = vec![0x01u8];
    d.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for w in weights {
        d.extend_from_slice(&w.to_le_bytes());
    }
    for r in refs {
        d.extend_from_slice(r);
    }
    d
}

/// Drives the real `validate_config` instruction against a split fixture's
/// accounts, EVERY meta read-only (which doubles as on-artifact proof that
/// the instruction demands no write lock and no signer).
fn run_validate_config(
    mollusk: &Mollusk,
    fixture: &SplitFixture,
    data_after_disc: &[u8],
    mint_only: bool,
) -> Result<(), u32> {
    let mut metas = vec![
        AccountMeta::new_readonly(fixture.metas[2].pubkey, false), // burn_pda
        AccountMeta::new_readonly(fixture.metas[3].pubkey, false), // wsol ata
        AccountMeta::new_readonly(fixture.metas[4].pubkey, false), // launch
    ];
    if mint_only {
        for i in 0..fixture.weights.len() {
            metas.push(AccountMeta::new_readonly(fixture.metas[8 + 7 * i].pubkey, false));
        }
    } else {
        for m in &fixture.metas[8..] {
            metas.push(AccountMeta::new_readonly(m.pubkey, false));
        }
    }
    let mut data = VALIDATE_CONFIG_DISCRIMINATOR.to_vec();
    data.extend_from_slice(data_after_disc);
    let instruction = Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data };
    let result = mollusk.process_instruction(&instruction, &fixture.accounts);
    match &result.raw_result {
        Ok(()) => Ok(()),
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => Err(*code),
        other => panic!("validate_config produced a non-named outcome {other:?}"),
    }
}

#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn validate_config_mode_a_binds_and_probes() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = Pubkey::new_from_array([0x4E; 32]);
    let weights = [10_000u16];
    let leg = LegRef::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 };
    let cap = 100_000_000_000u64 * 25 / 10_000; // 250_000_000 (rs bumped >= 50 SOL min-depth)

    // Good reference set at the bound address, probed at the intended chunk
    // size: admitted.
    let bound = derive_split_pda_bound(&launch, &[mint], &weights, &[leg]);
    let fixture = split_fixture(&launch, &[mint], &weights, bound, &[leg], 0);
    assert_eq!(run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[1_000_000]), false), Ok(()));

    // Probe at the exact cap: admitted. One past it: 6040 — the creator
    // hears "chunk smaller" BEFORE funding, not after.
    assert_eq!(run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[cap]), false), Ok(()));
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[cap + 1]), false),
        Err(REFERENCE_CAP_EXCEEDED)
    );

    // A zero probe proves nothing and is refused.
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[0]), false),
        Err(ZERO_INPUT)
    );

    // The UNBOUND address is refused: validation now gates the fee share on
    // the reference set as well.
    let unbound = derive_split_pda_unbound(&launch, &[mint], &weights);
    let fixture = split_fixture(&launch, &[mint], &weights, unbound, &[leg], 0);
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[1_000_000]), false),
        Err(INVALID_BURN_PDA)
    );

    // A junk reference bound at its own address derives fine but cannot
    // price a burn: 6039, before anything is funded.
    let junk = LegRef::Bare;
    let pda = derive_split_pda_bound(&launch, &[mint], &weights, &[junk]);
    let fixture = split_fixture(&launch, &[mint], &weights, pda, &[junk], 0);
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[1_000_000]), false),
        Err(REFERENCE_INVALID)
    );

    // A sentinel (Pump curve) leg validates too — the graduation-proof
    // config is checkable before launch.
    let curve = LegRef::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 100 };
    let pda = derive_split_pda_bound(&launch, &[mint], &weights, &[curve]);
    let fixture = split_fixture(&launch, &[mint], &weights, pda, &[curve], 0);
    assert_eq!(run_validate_config(&mollusk, &fixture, &mode_a_data(&weights, &[1_000_000]), false), Ok(()));

    // An unknown mode byte is refused.
    let mut bad_mode = mode_a_data(&weights, &[1_000_000]);
    bad_mode[0] = 0x02;
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &bad_mode, false),
        Err(INVALID_INSTRUCTION_DATA)
    );
}

#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn validate_config_mode_b_refused_at_dispatch() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = Pubkey::new_from_array([0x4F; 32]);
    let weights = [10_000u16];
    let leg = LegRef::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 };
    let ref_bytes = leg_ref_seed(&leg, 0);

    // RT8: Mode B is deleted. The previously-valid bind-only shape, a
    // mutated reference, and a Pump sentinel are all 6027 at dispatch.
    let bound = derive_split_pda_bound(&launch, &[mint], &weights, &[leg]);
    let fixture = split_fixture(&launch, &[mint], &weights, bound, &[leg], 0);
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_b_data(&weights, &[ref_bytes]), true),
        Err(INVALID_INSTRUCTION_DATA)
    );

    let mut mutated = ref_bytes;
    mutated[0] ^= 0x01;
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_b_data(&weights, &[mutated]), true),
        Err(INVALID_INSTRUCTION_DATA)
    );

    let curve = LegRef::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 100 };
    let pda = derive_split_pda_bound(&launch, &[mint], &weights, &[curve]);
    let fixture = split_fixture(&launch, &[mint], &weights, pda, &[curve], 0);
    assert_eq!(
        run_validate_config(&mollusk, &fixture, &mode_b_data(&weights, &[[0u8; 32]]), true),
        Err(INVALID_INSTRUCTION_DATA)
    );

    // Truncated / oversized data is a decode error, mirroring the split's
    // no-trailing-bytes rule.
    let mut short = mode_b_data(&weights, &[[0u8; 32]]);
    short.truncate(short.len() - 1);
    assert_eq!(run_validate_config(&mollusk, &fixture, &short, true), Err(INVALID_INSTRUCTION_DATA));
    let mut long = mode_b_data(&weights, &[[0u8; 32]]);
    long.push(0);
    assert_eq!(run_validate_config(&mollusk, &fixture, &long, true), Err(INVALID_INSTRUCTION_DATA));
}
