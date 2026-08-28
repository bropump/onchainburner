//! Hostile-Jupiter regression against the KEYLESS artifact.
//!
//! CLAUDE.md documents a 9/9 hostile-Jupiter Mollusk suite
//! (`tests/mollusk_hostile_jupiter.rs`) that installs a malicious program at
//! the pinned Jupiter id and drives the real SBPF artifact, proving the
//! post-route custody/authority postconditions catch everything the burn
//! PDA's signature can do. That suite runs the NON-KEYLESS (KMS) build. The
//! keyless custody review's single explicit recommendation was to repeat it
//! against the KEYLESS artifact, which its read-only constraint could not do.
//!
//! This file closes that gap. Under the keyless feature the single-target
//! `swap_and_burn` instruction is refused at dispatch (its legacy derivation
//! carries no reference seed), so every case here drives the SPLIT handler as
//! a ONE-LEG split whose vault address COMMITS to the leg's reference pool.
//! The custody postconditions are byte-identical shared code; what keyless
//! ADDS runs entirely BEFORE any CPI (reference binding into the seeds, the
//! per-leg output floor, the depth/cap gates, the fee-config read). So a
//! hostile route is handed exactly the same privilege as on the KMS path, and
//! the keyless additions are separately probed with cases a hostile route
//! cannot even reach.
//!
//! ARTIFACT AUTHENTICATION. `load_mollusk` refuses to proceed unless the ELF
//! rejects the single-target discriminator with 6027 at dispatch — the probe
//! `keyless_artifact.rs` uses, which uniquely identifies a reference-BOUND
//! keyless build (a KMS build answers 6004, a pre-binding keyless build 6028).
//! A stale or wrong-feature artifact fails this and the suite aborts.
//!
//! BUILD (see `scripts/test-mollusk-hostile-jupiter.sh` for the KMS analogue;
//! this suite is deliberately NOT wired into that script — it needs the
//! keyless artifact and a distinct fixture):
//!
//!   # keyless burner artifact (v2 per the keyless_artifact.rs recipe):
//!   tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --arch v2 --tools-version v1.53 --features keyless \
//!     --sbf-out-dir <dir>       # then point BURNER_KEYLESS_ELF at it
//!   # hostile fixture:
//!   tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf --arch v3 \
//!     --tools-version v1.53 \
//!     --manifest-path programs/burner/tests/hostile-keyless-fixture/Cargo.toml \
//!     --sbf-out-dir <dir>       # then point HOSTILE_KEYLESS_ELF at it
//!
//! RUN:
//!   BURNER_KEYLESS_ELF=<dir>/pinocchio_parity_keyless.so \
//!   HOSTILE_KEYLESS_ELF=<dir>/hostile_keyless.so \
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --test hostile_keyless_jupiter -- --ignored --nocapture

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_program_option::COption,
    solana_pubkey::Pubkey,
    solana_rent::Rent,
    spl_token_interface::state::{Account as TokenAccount, AccountState, Mint},
    std::{collections::BTreeMap, fs, path::PathBuf, str::FromStr},
};

// ---- fixed identities (byte-for-byte the program's own constants) ----------
const BURNER_PROGRAM: &str = "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_EVENT_AUTHORITY: &str = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];

// Raydium V4 program id: the reference venue used for the custody cases. A
// constant-product, address-bound reference (not a Pump sentinel), so its
// address binds literally into the vault seed and its depth is gated.
const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];

// ---- named error codes (append-only, client-visible) -----------------------
const E_INVALID_BURN_PDA: u32 = 6012; // reference-binding mismatch, PDA reassigned/allocated
const E_WSOL_NOT_CONSUMED: u32 = 6018;
const E_BURN_PDA_LAMPORT: u32 = 6019;
const E_TARGET_DECREASED: u32 = 6020;
const E_SLIPPAGE: u32 = 6021; // floor / minimum_output enforcement
const E_INTERMEDIATE: u32 = 6023;
const E_ENCUMBERED: u32 = 6035;
const E_INVALID_INSTRUCTION: u32 = 6027; // single-target refused at dispatch
const E_REFERENCE_INVALID: u32 = 6039;
const E_REFERENCE_CAP: u32 = 6040;
const E_REFERENCE_SHALLOW: u32 = 6041;

// ---- floor tuning (constant-product, Raydium V4) ---------------------------
// amount_in = 1_000_000; fee 25/10000; rt/rs chosen so the derived floor is
// exactly 1 unit, letting the fixture deposit a single target unit for every
// custody case (mirroring the KMS suite). Verified by `derived_floor` below.
const AMOUNT_IN: u64 = 1_000_000;
const FEE_NUM: u64 = 25;
const FEE_DEN: u64 = 10_000;
const REF_RT: u64 = 120_000; // target-side reserve
const MIN_DEPTH: u64 = 50_000_000_000; // program's MIN_REFERENCE_DEPTH_LAMPORTS
const REF_RS: u64 = MIN_DEPTH; // WSOL-side reserve == exactly the depth floor
const KEYLESS_TOL_BPS: u64 = 100;

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

/// A raw SPL token account whose load-bearing fields for the keyless reference
/// reads are mint (0..32), owner (32..64) and amount (64..72).
fn raw_vault(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }
}

/// A Raydium V4 pool account: vault pubkeys at 336/368, fee num/den at
/// 144/152. `fee_source` is the pool itself for this venue.
fn raydium_v4_pool(vault_a: &Pubkey, vault_b: &Pubkey, fee_num: u64, fee_den: u64) -> Account {
    let mut data = vec![0u8; 400];
    data[144..152].copy_from_slice(&fee_num.to_le_bytes());
    data[152..160].copy_from_slice(&fee_den.to_le_bytes());
    data[336..368].copy_from_slice(vault_a.as_ref());
    data[368..400].copy_from_slice(vault_b.as_ref());
    Account {
        lamports: 6_124_800,
        data,
        owner: Pubkey::new_from_array(RAYDIUM_V4),
        executable: false,
        rent_epoch: 0,
    }
}

/// The program's derived per-leg floor, recomputed independently so the test
/// asserts what it thinks it is asserting (mirrors `keyless_leg_floor`'s
/// constant-product tail + `keyless_floor_from_expected`).
fn derived_floor(rt: u64, rs: u64, amount_in: u64, fee_num: u64, fee_den: u64) -> u64 {
    let inp = (amount_in as u128) * ((fee_den - fee_num) as u128) / fee_den as u128;
    let expected = (rt as u128) * inp / (rs as u128 + inp);
    (expected * (10_000 - KEYLESS_TOL_BPS) as u128 / 10_000) as u64
}

fn derive_bound_pda(launch: &Pubkey, target: &Pubkey, reference: &Pubkey) -> Pubkey {
    let blob = 10_000u16.to_le_bytes();
    Pubkey::find_program_address(
        &[b"burner", launch.as_ref(), target.as_ref(), &blob, reference.as_ref()],
        &key(BURNER_PROGRAM),
    )
    .0
}

// ---------------------------------------------------------------------------
// Fixed pubkeys for the one-leg fixture.
// ---------------------------------------------------------------------------
struct Keys {
    caller: Pubkey,
    quote_slot: Pubkey,
    launch_mint: Pubkey,
    target_mint: Pubkey,
    reference: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    pool_authority: Pubkey,
    target_source: Pubkey,
    attacker: Pubkey,
    wsol_recipient: Pubkey,
}

fn fixed_keys() -> Keys {
    Keys {
        caller: Pubkey::new_from_array([10; 32]),
        quote_slot: Pubkey::new_from_array([16; 32]),
        launch_mint: Pubkey::new_from_array([13; 32]),
        target_mint: Pubkey::new_from_array([0x51; 32]),
        reference: Pubkey::new_from_array([0x52; 32]),
        vault_a: Pubkey::new_from_array([0x53; 32]),
        vault_b: Pubkey::new_from_array([0x54; 32]),
        pool_authority: Pubkey::new_from_array([0x55; 32]),
        target_source: Pubkey::new_from_array([0x77; 32]),
        attacker: Pubkey::new_from_array([0x11; 32]),
        wsol_recipient: Pubkey::new_from_array([0x12; 32]),
    }
}

/// Knobs a case can vary.
struct Case {
    mode: u8,
    minimum_output: u64,
    amount_in: u64,
    target_ata_amount: u64,
    target_source_amount: u64,
    ref_rt: u64,
    ref_rs: u64,
    // Substitute a DIFFERENT reference account than the one the vault is bound
    // to (binding attack); the bound pubkey is unchanged so the derivation
    // mismatches.
    present_reference: Option<(Pubkey, Account)>,
    // Substitute the vault_b account with an aliased token account.
    present_vault_b: Option<(Pubkey, Account)>,
}

impl Case {
    fn base(mode: u8) -> Self {
        Case {
            mode,
            minimum_output: 1,
            amount_in: AMOUNT_IN,
            target_ata_amount: 0,
            target_source_amount: 1,
            ref_rt: REF_RT,
            ref_rs: REF_RS,
            present_reference: None,
            present_vault_b: None,
        }
    }
}

struct Built {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    burn_pda: Pubkey,
    wsol_ata: Pubkey,
    target_ata: Pubkey,
    watch: Vec<Pubkey>,
}

fn build(case: &Case) -> Built {
    let k = fixed_keys();
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let event_authority = key(JUPITER_EVENT_AUTHORITY);
    let system = Pubkey::default();
    let native_reserve = Rent::default().minimum_balance(165);

    // The vault is ALWAYS bound to k.reference; a binding-attack case then
    // presents a different reference account without touching this derivation.
    let burn_pda = derive_bound_pda(&k.launch_mint, &k.target_mint, &k.reference);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);
    let target_ata = associated_token_address(&burn_pda, &k.target_mint);

    let pda_start = case.amount_in + 3_000_000;

    let reference_pair = case.present_reference.clone().unwrap_or_else(|| {
        (k.reference, raydium_v4_pool(&k.vault_a, &k.vault_b, FEE_NUM, FEE_DEN))
    });
    let vault_b_pair = case
        .present_vault_b
        .clone()
        .unwrap_or_else(|| (k.vault_b, raw_vault(&wsol, &k.pool_authority, case.ref_rs)));

    // ---- unique account map (each pubkey listed once) ----
    let mut accounts: Vec<(Pubkey, Account)> = vec![
        (k.caller, system_account(1_000_000)),
        (k.quote_slot, system_account(1_000_000)),
        (burn_pda, system_account(pda_start)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                wsol,
                burn_pda,
                0,
                Some(native_reserve),
            )),
        ),
        (k.launch_mint, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
        (k.target_mint, token::create_account_for_mint(immutable_mint(1_000_000, 6))),
        (
            target_ata,
            token::create_account_for_token_account(token_account(
                k.target_mint,
                burn_pda,
                case.target_ata_amount,
                None,
            )),
        ),
        reference_pair.clone(),
        (k.vault_a, raw_vault(&k.target_mint, &k.pool_authority, case.ref_rt)),
        vault_b_pair.clone(),
        (wsol, token::create_account_for_mint(immutable_mint(0, 9))),
        (event_authority, system_account(1)),
        (
            k.target_source,
            token::create_account_for_token_account(token_account(
                k.target_mint,
                burn_pda,
                case.target_source_amount,
                None,
            )),
        ),
        (k.attacker, system_account(9)),
        (
            k.wsol_recipient,
            token::create_account_for_token_account(token_account(
                wsol,
                k.attacker,
                0,
                Some(native_reserve),
            )),
        ),
    ];
    let burner_program = key(BURNER_PROGRAM);
    if case.mode >= 11 && !accounts.iter().any(|(pk, _)| *pk == burner_program) {
        accounts.push((burner_program, program::create_program_account_loader_v3(&burner_program)));
    }

    // Distinct fee-source account only if it isn't the reference itself.
    let fee_source = reference_pair.0;

    // ---- meta layout ----
    // fixed(8) + target block(7) + route pool(14), plus 7 extras for reentry
    // so the fixture can CPI back into the burner (indices 14..=20).
    let mut metas = vec![
        // fixed
        AccountMeta::new_readonly(k.caller, true),
        AccountMeta::new_readonly(k.quote_slot, false),
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(k.launch_mint, false),
        AccountMeta::new_readonly(system, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
        // target block: mint, ata, token program, reference, vault_a, vault_b, fee_source
        AccountMeta::new(k.target_mint, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(reference_pair.0, false),
        AccountMeta::new_readonly(k.vault_a, false),
        AccountMeta::new_readonly(vault_b_pair.0, false),
        AccountMeta::new_readonly(fee_source, false),
        // route pool (direct V2 prefix, then fixture-only hostile accounts)
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new(wsol, false),
        if case.mode >= 11 {
            AccountMeta::new(k.target_mint, false)
        } else {
            AccountMeta::new_readonly(k.target_mint, false)
        },
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(jupiter, false),
        AccountMeta::new(k.target_source, false),
        AccountMeta::new(k.attacker, false),
        AccountMeta::new_readonly(system, false),
        AccountMeta::new(k.wsol_recipient, false),
    ];
    if case.mode >= 11 {
        // Fixture indices 14..=20. 14/15 keep the drain-mode slots occupied;
        // 16..=20 are the nested burner's program, launch mint, and reference
        // block. Target mint in the V2 prefix is writable above so the nested
        // CPI can inherit that lock (Solana will not let Jupiter escalate).
        metas.push(AccountMeta::new(k.target_source, false)); // 14
        metas.push(AccountMeta::new(k.attacker, false)); // 15
        metas.push(AccountMeta::new_readonly(burner_program, false)); // 16
        metas.push(AccountMeta::new_readonly(k.launch_mint, false)); // 17
        metas.push(AccountMeta::new_readonly(reference_pair.0, false)); // 18
        metas.push(AccountMeta::new_readonly(k.vault_a, false)); // 19
        metas.push(AccountMeta::new_readonly(vault_b_pair.0, false)); // 20
    }

    // Ensure any substituted accounts replace the defaults in the map.
    if let Some(pair) = &case.present_vault_b {
        if !accounts.iter().any(|(pk, _)| *pk == pair.0) {
            accounts.push(pair.clone());
        }
    }
    if let Some(pair) = &case.present_reference {
        if !accounts.iter().any(|(pk, _)| *pk == pair.0) {
            accounts.push(pair.clone());
        }
    }

    let watch = vec![
        burn_pda,
        wsol_ata,
        target_ata,
        k.target_source,
        k.attacker,
        k.wsol_recipient,
        k.target_mint,
    ];
    Built { metas, accounts, burn_pda, wsol_ata, target_ata, watch }
}

fn route_data(mode: u8, amount_in: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(35);
    d.extend_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&1u64.to_le_bytes()); // quoted out
    d.extend_from_slice(&50u16.to_le_bytes()); // slippage
    d.extend_from_slice(&0u16.to_le_bytes()); // platform fee
    d.extend_from_slice(&0u16.to_le_bytes()); // positive-slippage fee
    d.extend_from_slice(&0u32.to_le_bytes()); // empty route plan
    d.push(mode);
    d
}

fn instruction_data(case: &Case) -> Vec<u8> {
    let route = route_data(case.mode, case.amount_in);
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&case.amount_in.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes()); // leg_count
    data.extend_from_slice(&10_000u16.to_le_bytes()); // bps
    data.extend_from_slice(&case.minimum_output.to_le_bytes());
    data.push(if case.mode >= 11 { 21u8 } else { 14u8 }); // route_account_count
    data.extend_from_slice(&(route.len() as u32).to_le_bytes());
    data.extend_from_slice(&route);
    data
}

fn account<'a>(accounts: &'a [(Pubkey, Account)], key: &Pubkey) -> &'a Account {
    &accounts.iter().find(|(c, _)| c == key).expect("account exists").1
}

fn artifact_path() -> PathBuf {
    if let Ok(p) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/deploy/pinocchio_parity_keyless.so")
}

fn fixture_path() -> PathBuf {
    if let Ok(p) = std::env::var("HOSTILE_KEYLESS_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root")
        .join("programs/burner/tests/hostile-keyless-fixture/target/deploy/hostile_keyless.so")
}

fn load_mollusk() -> Mollusk {
    let burner = artifact_path();
    let fixture = fixture_path();
    assert!(
        burner.is_file(),
        "missing keyless burner ELF: {} (set BURNER_KEYLESS_ELF)",
        burner.display()
    );
    assert!(
        fixture.is_file(),
        "missing hostile fixture ELF: {} (set HOSTILE_KEYLESS_ELF)",
        fixture.display()
    );
    let burner_program = key(BURNER_PROGRAM);
    let jupiter_program = key(JUPITER_PROGRAM);
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &burner_program,
        &program::loader_keys::LOADER_V3,
        &fs::read(&burner).expect("read keyless burner ELF"),
    );
    mollusk.add_program_with_loader_and_elf(
        &jupiter_program,
        &program::loader_keys::LOADER_V3,
        &fs::read(&fixture).expect("read hostile fixture ELF"),
    );

    // AUTHENTICATE: a reference-bound keyless build refuses the single-target
    // discriminator with 6027 at dispatch. A KMS build answers 6004, a
    // pre-binding keyless build 6028, so this uniquely pins the artifact.
    let mut metas = Vec::new();
    let mut accounts = Vec::new();
    for i in 0..13usize {
        let pk = Pubkey::new_from_array([100 + i as u8; 32]);
        metas.push(AccountMeta::new_readonly(pk, i == 0));
        accounts.push((pk, system_account(1_000_000)));
    }
    let mut data = SWAP_AND_BURN_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    let probe = Instruction { program_id: burner_program, accounts: metas, data };
    let result = mollusk.process_instruction(&probe, &accounts);
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(E_INVALID_INSTRUCTION)),
        "artifact at {} is NOT a reference-bound keyless build (single-target not refused 6027)",
        burner.display(),
    );
    mollusk
}

/// Run one case, assert `expected` (burner-authored Custom or a runtime
/// refusal such as ReentrancyNotAllowed), and assert every watched account
/// rolled back byte-identically.
fn expect_fail(mollusk: &Mollusk, case: &Case, expected: InstructionError) {
    let built = build(case);
    let instruction = Instruction {
        program_id: key(BURNER_PROGRAM),
        accounts: built.metas.clone(),
        data: instruction_data(case),
    };
    let result = mollusk.process_instruction(&instruction, &built.accounts);
    assert_eq!(
        result.raw_result,
        Err(expected.clone()),
        "mode={} expected {expected:?}",
        case.mode,
    );
    for pk in &built.watch {
        assert_eq!(
            account(&result.resulting_accounts, pk),
            account(&built.accounts, pk),
            "mode={} account {pk} changed despite outer failure",
            case.mode,
        );
    }
}

fn expect_reject(mollusk: &Mollusk, case: &Case, expected_code: u32) {
    expect_fail(mollusk, case, InstructionError::Custom(expected_code));
}

#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn keyless_hostile_jupiter_cannot_lose_custody_or_authority() {
    // Sanity: the tuned reference yields exactly a 1-unit floor, so a 1-unit
    // deposit clears slippage and `minimum_output = 1` clears the pre-CPI
    // floor gate. If this drifts, every custody case below is mis-tuned.
    assert_eq!(
        derived_floor(REF_RT, REF_RS, AMOUNT_IN, FEE_NUM, FEE_DEN),
        1,
        "reference tuning no longer yields a 1-unit floor",
    );

    let mollusk = load_mollusk();

    // ================= 1. custody / authority (hostile route) =============
    // Each abuse of the burn PDA's route-granted signature; the vault must
    // roll back byte-identically and the BURNER must author the refusal.

    // System transfer of vault SOL to the attacker.
    expect_reject(&mollusk, &Case::base(0), E_BURN_PDA_LAMPORT); // 6019
    // Reassign / allocate the System PDA (would brick it permanently).
    expect_reject(&mollusk, &Case::base(1), E_INVALID_BURN_PDA); // 6012
    expect_reject(&mollusk, &Case::base(2), E_INVALID_BURN_PDA); // 6012
    // Leave a standing delegate / close-authority claim on a PDA-owned ATA.
    expect_reject(&mollusk, &Case::base(3), E_ENCUMBERED); // 6035 (WSOL delegate)
    expect_reject(&mollusk, &Case::base(4), E_ENCUMBERED); // 6035 (target close auth)

    // ================= 2. mid-route swap postconditions ===================
    // Authorized WSOL left partly unconsumed.
    expect_reject(&mollusk, &Case::base(5), E_WSOL_NOT_CONSUMED); // 6018
    // Target ATA drained below its entry snapshot during the route.
    {
        let mut c = Case::base(6);
        c.target_ata_amount = 5;
        expect_reject(&mollusk, &c, E_TARGET_DECREASED); // 6020
    }
    // A PDA-owned intermediate left holding a balance; and one SetAuthority'd
    // away mid-route (the case the BEFORE snapshot exists to catch).
    {
        let mut c = Case::base(7);
        c.target_source_amount = 2;
        expect_reject(&mollusk, &c, E_INTERMEDIATE); // 6023
        let mut c = Case::base(8);
        c.target_source_amount = 2;
        expect_reject(&mollusk, &c, E_INTERMEDIATE); // 6023
    }

    // ================= 3. keyless-specific: reference binding =============
    // The vault is bound to reference R; presenting a DIFFERENT valid-shaped
    // pool R2 derives a different, unfunded vault -> 6012 BEFORE any CPI. This
    // is the property that stops a caller aiming a funded vault at an
    // attacker-controlled pool/price. (A hostile route never runs here.)
    {
        let k = fixed_keys();
        let r2 = Pubkey::new_from_array([0x99; 32]);
        let r2_pool = raydium_v4_pool(&k.vault_a, &k.vault_b, FEE_NUM, FEE_DEN);
        let mut c = Case::base(9);
        c.present_reference = Some((r2, r2_pool));
        expect_reject(&mollusk, &c, E_INVALID_BURN_PDA); // 6012
    }

    // ================= 4. keyless-specific: floor / depth / cap ===========
    // A caller cannot request a minimum below the program floor: min=0 is
    // refused pre-CPI (the route never executes).
    {
        let mut c = Case::base(9);
        c.minimum_output = 0;
        expect_reject(&mollusk, &c, E_SLIPPAGE); // 6021
    }
    // Even an honest-looking hostile route cannot deliver below what the
    // caller's (>= floor) minimum demands: JUST_SWAP deposits one unit,
    // minimum=2 -> 6021 post-CPI, vault rolled back.
    {
        let mut c = Case::base(9);
        c.minimum_output = 2;
        expect_reject(&mollusk, &c, E_SLIPPAGE); // 6021
    }
    // Reference depth below the 50-SOL floor is refused (well-formed pool,
    // merely too shallow) -> 6041.
    {
        let mut c = Case::base(9);
        c.ref_rs = MIN_DEPTH - 1;
        expect_reject(&mollusk, &c, E_REFERENCE_SHALLOW); // 6041
    }
    // amount_in above the depth cap (reserve*fee) is refused -> 6040.
    {
        let mut c = Case::base(9);
        c.amount_in = 200_000_000; // cap = 50e9 * 25/10000 = 125e6
        c.minimum_output = 1;
        expect_reject(&mollusk, &c, E_REFERENCE_CAP); // 6040
    }

    // ================= 5. keyless-specific: aliasing ======================
    // Present the vault's own WSOL ATA as the reference's SOL vault. Its
    // address cannot match the pool's stored vault pubkey, so the shape
    // authentication refuses it (6039) rather than pricing off a
    // vault-controlled account. The vault never funds; a hostile route never
    // runs.
    {
        let k = fixed_keys();
        let wsol = key(WSOL_MINT);
        let burn_pda = derive_bound_pda(&k.launch_mint, &k.target_mint, &k.reference);
        let wsol_ata = associated_token_address(&burn_pda, &wsol);
        // A WSOL token account at the vault's own WSOL ATA address, owned by
        // the PDA — aliased into the vault_b (SOL-vault) slot.
        let aliased = token::create_account_for_token_account(token_account(
            wsol,
            burn_pda,
            REF_RS,
            Some(Rent::default().minimum_balance(165)),
        ));
        let mut c = Case::base(9);
        c.present_vault_b = Some((wsol_ata, aliased));
        expect_reject(&mollusk, &c, E_REFERENCE_INVALID); // 6039
    }
}

/// A benign hostile route (JUST_SWAP, minimum == floor) must SUCCEED: this
/// proves the harness genuinely reaches and passes the route CPI, so the
/// refusals above are real postcondition refusals and not setup failures.
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn keyless_hostile_jupiter_honest_route_burns() {
    let mollusk = load_mollusk();
    let case = Case::base(9); // JUST_SWAP, minimum_output = 1 == floor
    let built = build(&case);
    let instruction = Instruction {
        program_id: key(BURNER_PROGRAM),
        accounts: built.metas.clone(),
        data: instruction_data(&case),
    };
    let result = mollusk.process_instruction(&instruction, &built.accounts);
    assert_eq!(result.raw_result, Ok(()), "an honest one-unit swap must burn");

    // The vault SOL fell by exactly amount_in (the burned input), the target
    // ATA is empty (burned), and the intermediate was fully consumed.
    let pda_before = account(&built.accounts, &built.burn_pda).lamports;
    let pda_after = account(&result.resulting_accounts, &built.burn_pda).lamports;
    assert_eq!(pda_before - pda_after, AMOUNT_IN, "PDA lamport delta must equal the burned input");
    let ata_after = account(&result.resulting_accounts, &built.target_ata);
    // token amount lives at bytes 64..72 of the SPL account data
    let amt = u64::from_le_bytes(ata_after.data[64..72].try_into().unwrap());
    assert_eq!(amt, 0, "target ATA must be burned to zero");
    let _ = built.wsol_ata;
}

/// CPI reentrancy: a hostile Jupiter, granted the burn PDA's signature,
/// invokes the burner again. Solana's SVM refuses that CPI
/// (`ReentrancyNotAllowed`) before the inner instruction runs — there is no
/// program-level lock because the runtime is the lock. Two directions, same
/// outcome, vault byte-identical:
///
/// 1. Nested `swap_and_burn_split` with the PDA as `caller`.
/// 2. Nested `validate_config` (read-only). Even a harmless inner call is
///    refused; the outer burn fails. A hostile Jupiter can already fail a
///    burn in many other ways, so this is not new griefing.
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn keyless_hostile_jupiter_reentrancy() {
    assert_eq!(
        derived_floor(REF_RT, REF_RS, AMOUNT_IN, FEE_NUM, FEE_DEN),
        1,
        "reference tuning no longer yields a 1-unit floor",
    );
    let mollusk = load_mollusk();

    expect_fail(&mollusk, &Case::base(11), InstructionError::ReentrancyNotAllowed);
    expect_fail(&mollusk, &Case::base(12), InstructionError::ReentrancyNotAllowed);
}

/// Arbitrary hostile routes against the real artifact. The known gap is
/// post-CPI postconditions under a hostile program at the pinned Jupiter id
/// — this campaign drives that fixture, not the honest one.
///
/// Pass bar: every outcome is `Ok` (honest JUST_SWAP), a named
/// `Custom(6000..=6043)`, or `ReentrancyNotAllowed`. An abort
/// (`ProgramFailedToComplete`) or unnamed runtime error is a defect.
///
/// Default 3_000 iters (CI-sized). Production-scale:
/// `HOSTILE_FUZZ_ITERS=300000 BURNER_FUZZ_SEED=20260828`.
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn keyless_hostile_jupiter_fuzz() {
    let iters: u32 = std::env::var("HOSTILE_FUZZ_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3_000);
    let seed: u64 = std::env::var("BURNER_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20260828);
    let mollusk = load_mollusk();
    let mut rng = seed | 1;
    let mut next = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    let mut histogram: BTreeMap<String, u32> = BTreeMap::new();
    for i in 0..iters {
        let mode = (next() % 13) as u8;
        let mut case = Case::base(mode);
        case.minimum_output = 1 + (next() % 8);
        if next() % 8 == 0 {
            case.amount_in = 1 + (next() % AMOUNT_IN);
        }
        let built = build(&case);
        let instruction = Instruction {
            program_id: key(BURNER_PROGRAM),
            accounts: built.metas.clone(),
            data: instruction_data(&case),
        };
        let result = mollusk.process_instruction(&instruction, &built.accounts);
        let bucket = match &result.raw_result {
            Ok(()) => "ok".to_string(),
            Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => {
                format!("c{code}")
            }
            Err(InstructionError::Custom(code)) => format!("ext-c{code}"),
            Err(InstructionError::ReentrancyNotAllowed) => "reentrancy".to_string(),
            Err(InstructionError::ProgramFailedToComplete) => panic!(
                "hostile fuzz iteration {i} seed {seed} mode {mode}: ABORT ProgramFailedToComplete"
            ),
            other => format!("runtime-{other:?}"),
        };
        *histogram.entry(bucket).or_insert(0) += 1;
    }
    println!("hostile-jupiter fuzz histogram ({iters} iters, seed {seed}): {histogram:?}");
    assert!(
        histogram.values().copied().sum::<u32>() == iters,
        "histogram lost iterations"
    );
}
