//! End-to-end hostile-Jupiter regression against the SHIPPING split path.
//!
//! RE-POINTED (2026-08-26). This suite previously drove the single-target
//! `swap_and_burn` instruction. The keyless-only build permanently disables
//! that discriminator (it returns `InvalidInstructionData` 6027 at dispatch),
//! so the old suite exercised an UNREACHABLE path and could no longer prove
//! anything about custody. It is now re-pointed at the instruction that
//! actually ships — `swap_and_burn_split`, driven as a ONE-LEG split — so
//! CLAUDE.md's hostile-Jupiter custody claim once again covers a code path
//! that runs.
//!
//! It loads the *real SBPFv3 production burner ELF* (`target/deploy/
//! pinocchio_parity.so`, the exact deployed bytes) and a separately compiled
//! hostile fixture. Mollusk maps the fixture to the real, pinned Jupiter
//! program address, so during the route CPI it receives exactly the burn PDA
//! signer privilege the split path grants. Each attack must be rejected by the
//! BURNER (not by the fixture, an AMM, or the runtime) and the complete outer
//! instruction must roll back byte-identically.
//!
//! NON-VACUITY. An honest one-unit swap (`MODE_JUST_SWAP`) is run FIRST and
//! must BURN. That proves the harness genuinely reaches and passes the route
//! CPI, so the refusals below are real post-route postcondition refusals and
//! not a blanket setup failure masquerading as a targeted one.
//!
//! ARTIFACT AUTHENTICATION. `load_mollusk` refuses to proceed unless the ELF
//! rejects the single-target discriminator with 6027 at dispatch — which
//! uniquely identifies a keyless build (a KMS build answered 6004).
//!
//! Run through `scripts/test-mollusk-hostile-jupiter.sh`. It is ignored by the
//! ordinary host suite because it deliberately requires the pinned SBF
//! toolchain and two freshly-built ELF files.

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
    std::{fs, path::PathBuf, str::FromStr},
};

// The custody / mid-route attack modes the hostile fixture implements. Numbers
// are the fixture's own `MODE_*` byte, appended to the route data.
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

const BURNER_PROGRAM: &str = "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_EVENT_AUTHORITY: &str = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];

/// Raydium V4 program id: the constant-product reference the one-leg vault is
/// bound to. Address-bound (not a Pump sentinel), so its address binds into the
/// vault seed and its depth is gated.
const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];

// Named error codes (append-only, client-visible). Each is a POST-route
// postcondition: reaching it proves the floor/route validation passed and the
// hostile route executed up to its abuse point.
const E_INVALID_BURN_PDA: u32 = 6012; // PDA reassigned / allocated
const E_WSOL_NOT_CONSUMED: u32 = 6018;
const E_BURN_PDA_LAMPORT: u32 = 6019;
const E_TARGET_DECREASED: u32 = 6020;
const E_INTERMEDIATE: u32 = 6023;
const E_INVALID_INSTRUCTION: u32 = 6027; // single-target refused at dispatch
const E_ENCUMBERED: u32 = 6035;

// Floor tuning (constant-product, Raydium V4): amount_in = 1_000_000, fee
// 25/10000, rt/rs so the derived floor is exactly 1 unit — a single deposited
// target unit clears slippage and `minimum_output = 1` clears the pre-CPI
// floor gate, matching every custody case.
const AMOUNT_IN: u64 = 1_000_000;
const MINIMUM_OUTPUT: u64 = 1;
const FEE_NUM: u64 = 25;
const FEE_DEN: u64 = 10_000;
const REF_RT: u64 = 120_000;
const MIN_DEPTH: u64 = 50_000_000_000; // MIN_REFERENCE_DEPTH_LAMPORTS
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

/// A raw SPL token account (mint 0..32, owner 32..64, amount 64..72) — a pool
/// vault the keyless reference reads.
fn raw_vault(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }
}

/// A Raydium V4 pool account (vaults at 336/368, fee num/den at 144/152).
/// `fee_source` is the pool itself for this venue.
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

/// The program's derived per-leg floor, recomputed independently so the fixture
/// tuning is asserted rather than assumed (mirrors `keyless_leg_floor`'s
/// constant-product tail + `keyless_floor_from_expected`).
fn derived_floor(rt: u64, rs: u64, amount_in: u64, fee_num: u64, fee_den: u64) -> u64 {
    let inp = (amount_in as u128) * ((fee_den - fee_num) as u128) / fee_den as u128;
    let expected = (rt as u128) * inp / (rs as u128 + inp);
    (expected * (10_000 - KEYLESS_TOL_BPS) as u128 / 10_000) as u64
}

/// The one-leg keyless vault: seeds are `["burner", launch, target, bps_blob,
/// reference]` (the reference address binds into the derivation).
fn derive_bound_pda(launch: &Pubkey, target: &Pubkey, reference: &Pubkey) -> Pubkey {
    let blob = 10_000u16.to_le_bytes();
    Pubkey::find_program_address(
        &[b"burner", launch.as_ref(), target.as_ref(), &blob, reference.as_ref()],
        &key(BURNER_PROGRAM),
    )
    .0
}

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

/// Per-case knobs (mode plus a few reserves the mid-route modes need).
struct Case {
    mode: u8,
    minimum_output: u64,
    amount_in: u64,
    target_ata_amount: u64,
    target_source_amount: u64,
}

impl Case {
    fn base(mode: u8) -> Self {
        Case {
            mode,
            minimum_output: MINIMUM_OUTPUT,
            amount_in: AMOUNT_IN,
            target_ata_amount: 0,
            target_source_amount: 1,
        }
    }
}

struct Built {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    burn_pda: Pubkey,
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

    let burn_pda = derive_bound_pda(&k.launch_mint, &k.target_mint, &k.reference);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);
    let target_ata = associated_token_address(&burn_pda, &k.target_mint);
    let pda_start = case.amount_in + 3_000_000;

    let accounts: Vec<(Pubkey, Account)> = vec![
        (k.caller, system_account(1_000_000)),
        (k.quote_slot, system_account(1_000_000)),
        (burn_pda, system_account(pda_start)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(wsol, burn_pda, 0, Some(native_reserve))),
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
        (k.reference, raydium_v4_pool(&k.vault_a, &k.vault_b, FEE_NUM, FEE_DEN)),
        (k.vault_a, raw_vault(&k.target_mint, &k.pool_authority, REF_RT)),
        (k.vault_b, raw_vault(&wsol, &k.pool_authority, REF_RS)),
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
            token::create_account_for_token_account(token_account(wsol, k.attacker, 0, Some(native_reserve))),
        ),
    ];

    // fixed(8) + target block(7) + route pool(14). The route pool is the direct
    // V2 prefix followed by the fixture-only hostile accounts (target_source,
    // attacker, system, wsol_recipient).
    let metas = vec![
        AccountMeta::new_readonly(k.caller, true),
        AccountMeta::new_readonly(k.quote_slot, false),
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(k.launch_mint, false),
        AccountMeta::new_readonly(system, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
        // target block
        AccountMeta::new(k.target_mint, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(k.reference, false),
        AccountMeta::new_readonly(k.vault_a, false),
        AccountMeta::new_readonly(k.vault_b, false),
        AccountMeta::new_readonly(k.reference, false), // fee_source == pool
        // route pool
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new(wsol, false),
        AccountMeta::new_readonly(k.target_mint, false),
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

    let watch = vec![
        burn_pda,
        wsol_ata,
        target_ata,
        k.target_source,
        k.attacker,
        k.wsol_recipient,
        k.target_mint,
    ];
    Built { metas, accounts, burn_pda, target_ata, watch }
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
    d.push(mode); // fixture-only extension ignored by the burner validator
    d
}

fn instruction_data(case: &Case) -> Vec<u8> {
    let route = route_data(case.mode, case.amount_in);
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&case.amount_in.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes()); // leg_count
    data.extend_from_slice(&10_000u16.to_le_bytes()); // bps
    data.extend_from_slice(&case.minimum_output.to_le_bytes());
    data.push(14u8); // route_account_count
    data.extend_from_slice(&(route.len() as u32).to_le_bytes());
    data.extend_from_slice(&route);
    data
}

fn account<'a>(accounts: &'a [(Pubkey, Account)], k: &Pubkey) -> &'a Account {
    &accounts.iter().find(|(c, _)| c == k).expect("account exists").1
}

fn artifact_path() -> PathBuf {
    // The exact production bytes by default; the sweep pins BURNER_KEYLESS_ELF.
    if let Ok(p) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy/pinocchio_parity.so")
}

fn fixture_path() -> PathBuf {
    if let Ok(p) = std::env::var("HOSTILE_KEYLESS_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/hostile-keyless-fixture/target/deploy/hostile_keyless.so")
}

fn load_mollusk() -> Mollusk {
    let burner = artifact_path();
    let fixture = fixture_path();
    assert!(
        burner.is_file(),
        "missing real burner ELF: {}; run scripts/test-mollusk-hostile-jupiter.sh",
        burner.display(),
    );
    assert!(
        fixture.is_file(),
        "missing hostile fixture ELF: {}; run scripts/test-mollusk-hostile-jupiter.sh",
        fixture.display(),
    );

    let burner_program = key(BURNER_PROGRAM);
    let jupiter_program = key(JUPITER_PROGRAM);
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &burner_program,
        &program::loader_keys::LOADER_V3,
        &fs::read(&burner).expect("read real burner ELF"),
    );
    mollusk.add_program_with_loader_and_elf(
        &jupiter_program,
        &program::loader_keys::LOADER_V3,
        &fs::read(&fixture).expect("read hostile Jupiter ELF"),
    );

    // AUTHENTICATE: a keyless build refuses the single-target discriminator
    // with 6027 at dispatch. A KMS build answered 6004, so this uniquely pins
    // a keyless artifact and fails loudly on a stale or wrong-feature ELF.
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
        "artifact at {} is NOT a keyless build (single-target not refused 6027)",
        burner.display(),
    );
    mollusk
}

/// Run one hostile case, assert the BURNER authored `expected_code`, and assert
/// every watched account rolled back byte-identically.
fn expect_reject(mollusk: &Mollusk, case: &Case, expected_code: u32) {
    let built = build(case);
    let instruction = Instruction {
        program_id: key(BURNER_PROGRAM),
        accounts: built.metas.clone(),
        data: instruction_data(case),
    };
    let result = mollusk.process_instruction(&instruction, &built.accounts);
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(expected_code)),
        "mode={} expected the BURNER to reject with {expected_code}, got {:?}",
        case.mode,
        result.raw_result,
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

#[test]
#[ignore = "requires the pinned SBPFv3 build; run scripts/test-mollusk-hostile-jupiter.sh"]
fn hostile_jupiter_cannot_leave_any_custody_or_authority_change() {
    // The tuned reference must yield exactly a 1-unit floor, or every case
    // below is mis-tuned.
    assert_eq!(
        derived_floor(REF_RT, REF_RS, AMOUNT_IN, FEE_NUM, FEE_DEN),
        1,
        "reference tuning no longer yields a 1-unit floor",
    );

    let mollusk = load_mollusk();

    // ---- ADMITTED CONTROL (run first) ---------------------------------------
    // An honest one-unit swap must BURN: this proves the harness reaches and
    // passes the route CPI, so the refusals below are genuine post-route
    // postcondition refusals — not a blanket setup failure passing as targeted.
    {
        let case = Case::base(MODE_JUST_SWAP);
        let built = build(&case);
        let instruction = Instruction {
            program_id: key(BURNER_PROGRAM),
            accounts: built.metas.clone(),
            data: instruction_data(&case),
        };
        let result = mollusk.process_instruction(&instruction, &built.accounts);
        assert_eq!(result.raw_result, Ok(()), "an honest one-unit swap must burn");
        let before = account(&built.accounts, &built.burn_pda).lamports;
        let after = account(&result.resulting_accounts, &built.burn_pda).lamports;
        assert_eq!(before - after, AMOUNT_IN, "PDA lamport delta must equal the burned input");
        let ata = account(&result.resulting_accounts, &built.target_ata);
        let amt = u64::from_le_bytes(ata.data[64..72].try_into().unwrap());
        assert_eq!(amt, 0, "target ATA must be burned to zero");
    }

    // ---- custody / authority attacks ----------------------------------------
    // Direct System transfer of vault SOL to the attacker.
    expect_reject(&mollusk, &Case::base(MODE_STEAL_LAMPORT), E_BURN_PDA_LAMPORT); // 6019
    // Reassign / allocate the System PDA (would brick it permanently).
    expect_reject(&mollusk, &Case::base(MODE_ASSIGN_PDA), E_INVALID_BURN_PDA); // 6012
    expect_reject(&mollusk, &Case::base(MODE_ALLOCATE_PDA), E_INVALID_BURN_PDA); // 6012
    // Leave a standing delegate / close-authority claim on a PDA-owned ATA.
    expect_reject(&mollusk, &Case::base(MODE_APPROVE_WSOL_DELEGATE), E_ENCUMBERED); // 6035
    expect_reject(&mollusk, &Case::base(MODE_SET_TARGET_CLOSE_AUTHORITY), E_ENCUMBERED); // 6035

    // ---- mid-route swap postconditions --------------------------------------
    // Authorized WSOL left partly unconsumed.
    expect_reject(&mollusk, &Case::base(MODE_WSOL_UNDERCONSUME), E_WSOL_NOT_CONSUMED); // 6018
    // Target ATA drained below its entry snapshot during the route.
    {
        let mut c = Case::base(MODE_TARGET_DECREASE);
        c.target_ata_amount = 5;
        expect_reject(&mollusk, &c, E_TARGET_DECREASED); // 6020
    }
    // A PDA-owned intermediate left holding a balance, and one SetAuthority'd
    // away mid-route (the case the BEFORE snapshot exists to catch) — both
    // caught by the entry snapshot.
    {
        let mut c = Case::base(MODE_INTERMEDIATE_KEEP);
        c.target_source_amount = 2;
        expect_reject(&mollusk, &c, E_INTERMEDIATE); // 6023
        let mut c = Case::base(MODE_INTERMEDIATE_REASSIGN);
        c.target_source_amount = 2;
        expect_reject(&mollusk, &c, E_INTERMEDIATE); // 6023
    }

    // Not covered here, and why — a hostile route CPI cannot reach any of them:
    //   6017 WsolFundingMismatch  `fund_wsol` runs and checks its delta BEFORE
    //        `invoke_jupiter_route`; the route never executes while it is
    //        evaluated.
    //   6022 BurnIncomplete       `burn_target` burns exactly the balance
    //        `verify_swap_postconditions` just read, with nothing running
    //        between, so the post-burn balance is always zero.
    //   6025 UnsupportedToken2022AccountExtension  a pre-route admission check
    //        in `validate_target_account`, never re-parsed after the route;
    //        covered as a host unit test on the byte layout in `token.rs`.
}
