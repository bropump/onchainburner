//! Regression suite for the KEYLESS SPLIT handler's per-leg Pump bonding-curve
//! path (`swap_and_burn_split` under `--features keyless,directcurve`),
//! executed against the REAL SBPF artifact under Mollusk.
//!
//! # Why this file exists
//!
//! A brand-new, pre-graduation Pump launch is not Jupiter-routable, so the
//! flagship own-launch majority leg cannot burn through the all-Jupiter split.
//! This suite proves the split handler now selects the direct Pump curve buy
//! for a leg with EMPTY route data — the same selector the single-target
//! `directcurve` path uses — while still funding WSOL and closing the Pump
//! accumulator for the split's Jupiter legs.
//!
//! # The oracle (identical idiom to `directcurve_artifact.rs`)
//!
//! Mollusk installs the benign no-op Pump stub at Pump.fun's pinned id, so the
//! curve buy CPI resolves to a program that returns Ok WITHOUT moving any
//! funds. A fully-valid curve leg therefore runs the entire per-leg path —
//! reference binding into the vault seeds, the keyless curve floor, the WSOL
//! skip, the account validation inside `directcurve.rs`, the buy CPI — and then
//! fails the exact per-leg lamport-delta postcondition (the stub debited no
//! native SOL from the PDA):
//!
//!   * 6019 `BurnPdaLamportMismatch` -> the SENTINEL: the curve path was
//!     selected, the adapter admitted the 16-account Pump set, the buy CPI ran
//!     and returned, WSOL was left untouched (not funded), and the accumulator
//!     was treated as untouched (credit 0). The stub moved nothing, so
//!     `after != before - amount_in`.
//!   * 6018 `WsolNotFullyConsumed` -> the per-leg fund_wsol skip was BROKEN:
//!     funding WSOL on a curve leg moved `amount_in` into WSOL, which the swap
//!     postcondition (checked before the lamport delta) refuses. This is the
//!     signal the fund_wsol mutation flips.
//!   * 6006 `InvalidJupiterAccounts` -> the directcurve adapter refused a
//!     corrupted Pump account (its validation genuinely runs).
//!   * 6021 `SlippageExceeded` -> the keyless curve floor gated the leg: a
//!     minimum below the program's own curve floor is refused BEFORE any CPI.
//!
//! A keyless build WITHOUT directcurve cannot produce the sentinel: an
//! empty-route leg runs `validate_jupiter_route` on empty bytes and is refused
//! (never selecting the curve path). The positive control is therefore ALSO
//! the build-identity probe for a keyless+directcurve artifact.
//!
//! # Build
//!
//!   tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf \
//!     --arch v3 --tools-version v1.53 \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --sbf-out-dir <dir> --features keyless,directcurve -- --locked
//!   cp <dir>/pinocchio_parity.so <dir>/pinocchio_parity_keyless_directcurve.so
//!   # then: BURNER_KEYLESS_DIRECTCURVE_ELF=<dir>/pinocchio_parity_keyless_directcurve.so
//!   # benign stub (see directcurve_artifact.rs header): BENIGN_PUMP_ELF=...
//!
//! # Run
//!
//!   BURNER_KEYLESS_DIRECTCURVE_ELF=... BENIGN_PUMP_ELF=... \
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --test split_curve_artifact -- --ignored --nocapture

#![allow(clippy::type_complexity)]

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_pubkey::Pubkey,
    std::{collections::BTreeMap, fs, path::PathBuf, str::FromStr},
};

// ---- fixed identities (byte-for-byte the program's own constants) ----------
const BURNER_PROGRAM: &str = "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const PUMP_FUN_PROGRAM: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FEE_PROGRAM: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];
const PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR: [u8; 8] = [86, 255, 112, 14, 102, 53, 154, 250];

// ---- named error codes (append-only, client-visible) -----------------------
const BURN_PDA_LAMPORT_MISMATCH: u32 = 6019; // the curve-leg sentinel
const WSOL_NOT_FULLY_CONSUMED: u32 = 6018;
const INVALID_JUPITER_ACCOUNTS: u32 = 6006;
const SLIPPAGE_EXCEEDED: u32 = 6021;
const INVALID_INSTRUCTION_DATA: u32 = 6027; // single-target refused at dispatch

// Curve fixture reserves (a fresh normal Pump curve: ~30 SOL virtual quote).
const VIRTUAL_TOKENS: u64 = 1_000_000_000_000_000;
const VIRTUAL_SOL: u64 = 30_000_000_000;
const AMOUNT_IN: u64 = 1_000_000;

fn key(value: &str) -> Pubkey {
    Pubkey::from_str(value).expect("valid fixed pubkey")
}

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &key(ASSOCIATED_TOKEN_PROGRAM),
    )
    .0
}
fn pump_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &key(PUMP_FUN_PROGRAM)).0
}

// ---- raw account byte builders (mirrors of directcurve_artifact.rs) --------
fn system_account(lamports: u64) -> Account {
    Account::new(lamports, 0, &Pubkey::default())
}
fn program_account(id: &Pubkey) -> Account {
    program::create_program_account_loader_v3(id)
}
fn pump_owned(len: usize) -> Account {
    Account { lamports: 1_000_000, data: vec![0u8; len], owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

/// 82-byte SPL Mint with null mint & freeze authorities (a valid burn target).
fn immutable_mint(decimals: u8) -> Account {
    let mut data = vec![0u8; 82];
    data[36..44].copy_from_slice(&VIRTUAL_TOKENS.to_le_bytes());
    data[44] = decimals;
    data[45] = 1; // is_initialized
    Account { lamports: 1_461_600, data, owner: token::ID, executable: false, rent_epoch: 0 }
}

/// 165-byte SPL token account. `native` sets the is_native discriminant.
fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64, native: bool) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    if native {
        data[109..113].copy_from_slice(&[1, 0, 0, 0]);
    }
    Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }
}

/// A 151-byte Pump bonding-curve account (normal, not complete, not mayhem).
fn curve_account(creator: [u8; 32]) -> Account {
    let mut data = vec![0u8; 151];
    data[8..16].copy_from_slice(&VIRTUAL_TOKENS.to_le_bytes());
    data[16..24].copy_from_slice(&VIRTUAL_SOL.to_le_bytes());
    data[48] = 0; // complete = false
    data[49..81].copy_from_slice(&creator);
    data[81] = 0; // mayhem = false
    Account { lamports: 2_000_000, data, owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

/// Pump fee_config account: one flat tier, protocol 95 / creator 30.
fn fee_config_account() -> Account {
    let mut data = vec![0u8; 69 + 40 + 16];
    data[0..8].copy_from_slice(&PUMP_FEE_CONFIG_DISCRIMINATOR);
    data[49..57].copy_from_slice(&95u64.to_le_bytes());
    data[57..65].copy_from_slice(&30u64.to_le_bytes());
    data[65..69].copy_from_slice(&1u32.to_le_bytes());
    data[69..85].copy_from_slice(&0u128.to_le_bytes()); // threshold 0
    data[69 + 24..69 + 32].copy_from_slice(&95u64.to_le_bytes());
    data[69 + 32..69 + 40].copy_from_slice(&30u64.to_le_bytes());
    Account { lamports: 2_500_000, data, owner: key(PUMP_FEE_PROGRAM), executable: false, rent_epoch: 0 }
}

/// A live Pump.fun `user_volume_accumulator`, correctly discriminated and
/// storing `pda` at bytes 8..40, so `snapshot_pump_lamport_credits` admits it.
/// Used to exercise the curve-leg "untouched" contract (credit 0).
fn live_user_volume(pda: &Pubkey) -> Account {
    let mut data = vec![0u8; 48];
    data[0..8].copy_from_slice(&PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR);
    data[8..40].copy_from_slice(pda.as_ref());
    Account { lamports: 1_844_400, data, owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

// A floor-safe minimum that is guaranteed >= the program's keyless curve floor
// (constant product minus the fee haircut minus the 100 bps tolerance), because
// it ignores both the fee and the tolerance. This clears the pre-CPI floor gate
// so the run reaches the curve CPI and the 6019 sentinel.
fn floor_safe_minimum() -> u64 {
    ((VIRTUAL_TOKENS as u128 * AMOUNT_IN as u128) / (VIRTUAL_SOL as u128 + AMOUNT_IN as u128)) as u64
}

const FIXED: usize = 8;
const PER_TARGET: usize = 7; // keyless leg block
const PUMP_ACCOUNTS: usize = 16;

#[derive(Clone)]
struct Slot {
    key: Pubkey,
    signer: bool,
    writable: bool,
    account: Account,
}

/// A single-leg (100% bps) curve split fixture.
struct Fixture {
    slots: Vec<Slot>,
    amount_in: u64,
    minimum_output: u64,
    route_data: Vec<u8>,
    route_account_count: u8,
    pda: Pubkey,
}

impl Fixture {
    fn curve() -> Fixture {
        let token_program = token::ID;
        let caller = Pubkey::new_from_array([10; 32]);
        let quote_slot = Pubkey::new_from_array([16; 32]);
        let launch_mint = Pubkey::new_from_array([13; 32]);
        let target_mint = Pubkey::new_from_array([0x71; 32]);
        let wsol = key(WSOL_MINT);

        let creator = [0u8; 32];
        let curve = pump_pda(&[b"bonding-curve", target_mint.as_ref()]);

        // The vault commits to the Pump-venue ZERO sentinel for its reference.
        let zero_ref = [0u8; 32];
        let bps_blob = 10_000u16.to_le_bytes();
        let pda = Pubkey::find_program_address(
            &[b"burner", launch_mint.as_ref(), target_mint.as_ref(), &bps_blob, &zero_ref],
            &key(BURNER_PROGRAM),
        )
        .0;
        let wsol_source = ata(&pda, &wsol, &token_program);
        let target_ata = ata(&pda, &target_mint, &token_program);

        // Pump named accounts (mirrors directcurve_artifact.rs r0..r15).
        let global = pump_pda(&[b"global"]);
        let fee_recipient = Pubkey::new_from_array([0x40; 32]);
        let assoc_bonding_curve = ata(&curve, &target_mint, &token_program);
        let creator_vault = pump_pda(&[b"creator-vault", creator.as_ref()]);
        let event_authority = pump_pda(&[b"__event_authority"]);
        let global_volume = pump_pda(&[b"global_volume_accumulator"]);
        let user_volume = pump_pda(&[b"user_volume_accumulator", pda.as_ref()]);
        let fee_config = Pubkey::find_program_address(
            &[b"fee_config", key(PUMP_FUN_PROGRAM).as_ref()],
            &key(PUMP_FEE_PROGRAM),
        )
        .0;
        let system = program::keyed_account_for_system_program();

        let slots = vec![
            // ---- 8 fixed accounts ----
            Slot { key: caller, signer: true, writable: false, account: system_account(1_000_000) },
            Slot { key: quote_slot, signer: false, writable: false, account: system_account(1_000_000) },
            Slot { key: pda, signer: false, writable: true, account: system_account(10_000_000_000) },
            Slot { key: wsol_source, signer: false, writable: true, account: token_account(&wsol, &pda, 0, true) },
            Slot { key: launch_mint, signer: false, writable: false, account: immutable_mint(6) },
            Slot { key: system.0, signer: false, writable: false, account: system.1.clone() },
            Slot { key: token_program, signer: false, writable: false, account: token::keyed_account().1 },
            Slot { key: key(JUPITER_PROGRAM), signer: false, writable: false, account: program_account(&key(JUPITER_PROGRAM)) },
            // ---- 7-account keyless leg block ----
            Slot { key: target_mint, signer: false, writable: true, account: immutable_mint(6) },
            Slot { key: target_ata, signer: false, writable: true, account: token_account(&target_mint, &pda, 0, false) },
            Slot { key: token_program, signer: false, writable: false, account: token::keyed_account().1 },
            Slot { key: curve, signer: false, writable: false, account: curve_account(creator) }, // reference
            // vault_a / vault_b are unused by the curve floor branch; any
            // present account is fine and never read.
            Slot { key: Pubkey::new_from_array([0xA1; 32]), signer: false, writable: false, account: system_account(1) },
            Slot { key: Pubkey::new_from_array([0xA2; 32]), signer: false, writable: false, account: system_account(1) },
            Slot { key: fee_config, signer: false, writable: false, account: fee_config_account() }, // fee_source
            // ---- 16 Pump buy accounts (the leg's route pool) ----
            Slot { key: global, signer: false, writable: false, account: pump_owned(64) }, // r0
            Slot { key: fee_recipient, signer: false, writable: true, account: system_account(1_000_000) }, // r1
            Slot { key: target_mint, signer: false, writable: false, account: immutable_mint(6) }, // r2
            Slot { key: curve, signer: false, writable: true, account: curve_account(creator) }, // r3
            Slot { key: assoc_bonding_curve, signer: false, writable: true, account: token_account(&target_mint, &curve, 0, false) }, // r4
            Slot { key: target_ata, signer: false, writable: true, account: token_account(&target_mint, &pda, 0, false) }, // r5
            Slot { key: pda, signer: false, writable: true, account: system_account(10_000_000_000) }, // r6 user
            Slot { key: system.0, signer: false, writable: false, account: system.1.clone() }, // r7
            Slot { key: token_program, signer: false, writable: false, account: token::keyed_account().1 }, // r8
            Slot { key: creator_vault, signer: false, writable: true, account: system_account(1_000_000) }, // r9
            Slot { key: event_authority, signer: false, writable: false, account: system_account(1) }, // r10
            Slot { key: key(PUMP_FUN_PROGRAM), signer: false, writable: false, account: program_account(&key(PUMP_FUN_PROGRAM)) }, // r11
            Slot { key: global_volume, signer: false, writable: false, account: pump_owned(64) }, // r12
            Slot { key: user_volume, signer: false, writable: true, account: system_account(1_000_000) }, // r13 (absent accumulator)
            Slot { key: fee_config, signer: false, writable: false, account: fee_config_account() }, // r14
            Slot { key: key(PUMP_FEE_PROGRAM), signer: false, writable: false, account: program_account(&key(PUMP_FEE_PROGRAM)) }, // r15
        ];

        Fixture {
            slots,
            amount_in: AMOUNT_IN,
            minimum_output: floor_safe_minimum(),
            route_data: Vec::new(),
            route_account_count: PUMP_ACCOUNTS as u8,
            pda,
        }
    }

    /// The absolute slot index of Pump route account `idx` (0-based within 16).
    fn r(idx: usize) -> usize {
        FIXED + PER_TARGET + idx
    }

    fn instruction(&self) -> (Instruction, Vec<(Pubkey, Account)>) {
        let metas: Vec<AccountMeta> = self
            .slots
            .iter()
            .map(|s| AccountMeta { pubkey: s.key, is_signer: s.signer, is_writable: s.writable })
            .collect();
        let mut seen: BTreeMap<Pubkey, Account> = BTreeMap::new();
        let mut accounts = Vec::new();
        for s in &self.slots {
            if seen.insert(s.key, s.account.clone()).is_none() {
                accounts.push((s.key, s.account.clone()));
            }
        }
        // total_amount_in | leg_count=1 | bps=10000 | minimum_output |
        // route_account_count | route_data_len | route_data
        let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&self.amount_in.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&10_000u16.to_le_bytes());
        data.extend_from_slice(&self.minimum_output.to_le_bytes());
        data.push(self.route_account_count);
        data.extend_from_slice(&(self.route_data.len() as u32).to_le_bytes());
        data.extend_from_slice(&self.route_data);
        (Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data }, accounts)
    }

    fn run(&self, mollusk: &Mollusk) -> u32 {
        let (ix, accounts) = self.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        named_code(&result.raw_result, &|| format!("split curve run amount_in={}", self.amount_in))
    }
}

fn named_code(result: &Result<(), InstructionError>, ctx: &dyn Fn() -> String) -> u32 {
    match result {
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => *code,
        other => panic!("artifact produced a NON-NAMED outcome {other:?}\n{}", ctx()),
    }
}

fn artifact_path() -> PathBuf {
    if let Ok(p) = std::env::var("BURNER_KEYLESS_DIRECTCURVE_ELF") {
        return PathBuf::from(p);
    }
    let deploy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy");
    let preferred = deploy.join("pinocchio_parity_keyless_directcurve.so");
    if preferred.is_file() {
        preferred
    } else {
        deploy.join("pinocchio_parity.so")
    }
}
fn benign_pump_elf_path() -> PathBuf {
    if let Ok(p) = std::env::var("BENIGN_PUMP_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/benign-pump-fixture/target/deploy/benign_pump.so")
}

fn load_mollusk() -> Mollusk {
    let burner = artifact_path();
    assert!(
        burner.is_file(),
        "missing keyless+directcurve burner ELF: {} (set BURNER_KEYLESS_DIRECTCURVE_ELF)",
        burner.display()
    );
    let stub_path = benign_pump_elf_path();
    assert!(stub_path.is_file(), "missing benign pump stub ELF: {}", stub_path.display());

    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &key(BURNER_PROGRAM),
        &program::loader_keys::LOADER_V3,
        &fs::read(&burner).expect("read keyless+directcurve burner ELF"),
    );
    let stub = fs::read(&stub_path).expect("read benign pump stub ELF");
    mollusk.add_program_with_loader_and_elf(&key(PUMP_FUN_PROGRAM), &program::loader_keys::LOADER_V3, &stub);
    mollusk.add_program_with_loader_and_elf(&key(PUMP_FEE_PROGRAM), &program::loader_keys::LOADER_V3, &stub);
    // A Jupiter id must exist as an executable program account so a Jupiter-leg
    // path (unused here) would resolve; the curve path never CPIs it.
    mollusk.add_program_with_loader_and_elf(&key(JUPITER_PROGRAM), &program::loader_keys::LOADER_V3, &stub);

    // BUILD IDENTITY. Under keyless the single-target discriminator is refused
    // 6027 at dispatch (a KMS build answers 6004, a pre-binding keyless build
    // 6028); AND a valid one-leg curve split reaches the 6019 sentinel, which a
    // keyless-only build (no directcurve) cannot, because it never selects the
    // curve path for empty route data. Together these pin the exact artifact.
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
    let probe = Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data };
    assert_eq!(
        mollusk.process_instruction(&probe, &accounts).raw_result,
        Err(InstructionError::Custom(INVALID_INSTRUCTION_DATA)),
        "artifact at {} did not refuse single-target dispatch with 6027",
        burner.display(),
    );
    assert_eq!(
        Fixture::curve().run(&mollusk),
        BURN_PDA_LAMPORT_MISMATCH,
        "artifact at {} is NOT a keyless+directcurve build (a valid one-leg curve split did not \
         reach the 6019 sentinel). Rebuild with --features keyless,directcurve.",
        burner.display(),
    );
    mollusk
}

fn run_mut(mollusk: &Mollusk, mut mutate: impl FnMut(&mut Fixture)) -> u32 {
    let mut f = Fixture::curve();
    mutate(&mut f);
    f.run(mollusk)
}

// ===========================================================================
// POSITIVE CONTROL + selection
// ===========================================================================

#[test]
#[ignore = "needs the keyless+directcurve artifact + benign pump stub; see header"]
fn curve_leg_reaches_sentinel() {
    let mollusk = load_mollusk();
    // A one-leg split with EMPTY route data selects the curve path, runs the
    // adapter and the buy CPI, and reaches the exact per-leg lamport-delta
    // check. The stub moved nothing -> 6019. This alone proves: curve-path
    // selection inside the split, the WSOL skip (otherwise 6018 would fire
    // first), and that the accumulator was treated as untouched (credit 0).
    assert_eq!(Fixture::curve().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);
    println!("positive control: one-leg curve split reaches 6019 sentinel");
}

// ===========================================================================
// The curve-leg accumulator "untouched" contract (credit 0)
// ===========================================================================

#[test]
#[ignore = "needs the keyless+directcurve artifact + benign pump stub; see header"]
fn live_accumulator_untouched_reaches_sentinel() {
    let mollusk = load_mollusk();
    // Present a LIVE (Pump-owned, correctly discriminated, pda-stored)
    // user_volume_accumulator at r13. It is snapshotted, classified as a curve
    // accumulator, and required UNTOUCHED after the benign buy (which does not
    // move it) -> passes, credits 0. The run still reaches 6019 on the lamport
    // delta. A closure requirement (the Jupiter contract) would ALSO land on
    // 6019 here, so this proves the untouched path executes without spuriously
    // failing; the closure-vs-untouched distinction is proven on the fork,
    // where the honest curve burn SUCCEEDS.
    let pda = Fixture::curve().pda;
    let code = run_mut(&mollusk, |f| {
        f.slots[Fixture::r(13)].account = live_user_volume(&pda);
    });
    assert_eq!(code, BURN_PDA_LAMPORT_MISMATCH);
    println!("live pump accumulator: curve-leg untouched contract passes, reaches 6019");
}

// ===========================================================================
// The keyless curve floor gates the leg (pre-CPI)
// ===========================================================================

#[test]
#[ignore = "needs the keyless+directcurve artifact + benign pump stub; see header"]
fn below_floor_minimum_refused_before_cpi() {
    let mollusk = load_mollusk();
    // A minimum of 1 is far below the program's own curve floor, so the leg is
    // refused BEFORE any CPI. Proves the keyless floor governs a curve leg.
    let code = run_mut(&mollusk, |f| f.minimum_output = 1);
    assert_eq!(code, SLIPPAGE_EXCEEDED);
    println!("below-floor minimum on a curve leg: refused 6021 pre-CPI");
}

// ===========================================================================
// The directcurve adapter's account validation genuinely runs
// ===========================================================================

#[test]
#[ignore = "needs the keyless+directcurve artifact + benign pump stub; see header"]
fn corrupted_pump_account_refused() {
    let mollusk = load_mollusk();
    // Corrupt the global account (r0) to a bare System account: the adapter's
    // identity pins refuse it. Proves `directcurve::validate_pump_buy_accounts`
    // executes for a split curve leg.
    let code = run_mut(&mollusk, |f| {
        f.slots[Fixture::r(0)].account = system_account(1_000_000);
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS);
    println!("corrupted pump global on a curve leg: refused 6006");
}

// ===========================================================================
// MUTATION TARGET DOC: the per-leg fund_wsol skip.
// Breaking it (funding WSOL on a curve leg) makes this test's expected code
// flip from 6019 to 6018, because the funded WSOL is left unconsumed by the
// benign stub and the swap postcondition (checked before the lamport delta)
// refuses it. See FABLE-SPLIT-CURVE-IMPL.md for the executed mutation result.
// ===========================================================================

#[test]
#[ignore = "needs the keyless+directcurve artifact + benign pump stub; see header"]
fn fund_wsol_skip_is_load_bearing() {
    let mollusk = load_mollusk();
    // On the honest build the curve leg does NOT fund WSOL, so the WSOL balance
    // is untouched and the run reaches the 6019 lamport sentinel rather than
    // the 6018 WSOL-not-consumed check. If the per-leg skip is removed, WSOL is
    // funded with amount_in, the stub consumes none of it, and 6018 fires
    // first. Asserting 6019 here is exactly what the fund_wsol mutation flips.
    assert_eq!(Fixture::curve().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);
    assert_ne!(BURN_PDA_LAMPORT_MISMATCH, WSOL_NOT_FULLY_CONSUMED);
}
