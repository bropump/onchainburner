//! Test + fuzz suite for the Pump.fun bonding-curve adapter
//! (`src/directcurve.rs`), executed against the REAL SBPF artifact under
//! Mollusk. The curve path is the 80% own-launch leg of every flagship burn --
//! the single most important leg in the product -- and this file carries the
//! only coverage of the buy-instruction ENCODER bytes, the signer/writable
//! flag table, the privilege-escalation finding, and the quote / market-cap
//! arithmetic boundaries.
//!
//! REPOINTED 2026-08-26 at the merged keyless-only build. This suite was
//! written for the deleted `--features directcurve` single-target build and
//! passed only against a stale Aug-25 artifact. In the merged build:
//!
//!   * the single-target `swap_and_burn` discriminator is refused 6027 at
//!     dispatch -- only the split path runs;
//!   * the curve path is selected by a SPLIT LEG with EMPTY route data (the
//!     same selector the old single-target directcurve path used);
//!   * each leg carries a 7-account keyless block (mint, ATA, token program,
//!     reference, vault_a, vault_b, fee source) and the vault PDA additionally
//!     commits to one 32-byte reference seed per leg (`[0u8; 32]` sentinel for
//!     Pump-owned references);
//!   * `keyless_leg_floor` runs BEFORE any CPI: the caller's `minimum_output`
//!     must be >= the program's own curve floor (6021 below it), the input
//!     must fit the fee-derived depth cap (6040 above it), and the reference
//!     itself is authenticated (6039).
//!
//! The fixture is therefore the one-leg (100% bps) curve split proven by
//! `split_curve_artifact.rs`, and the account/arithmetic mutations of the old
//! suite are re-expressed against it. Where the merged build's earlier gates
//! now shadow an adapter check for the SHARED curve account (the floor
//! authenticates the same account the adapter later re-validates), the test
//! asserts the merged build's actual specific code (6039/6012) and says so,
//! rather than deleting the case or weakening it to "some error".
//!
//! # THE ORACLE (unchanged in spirit)
//!
//! Mollusk installs a benign no-op Pump stub at Pump.fun's pinned id, so the
//! curve buy CPI resolves to a program that returns Ok WITHOUT moving funds.
//! A fully-valid curve leg runs reference binding, the keyless floor, the
//! complete `directcurve.rs` account validation, the fee-tier read, the
//! constant-product quote, and the buy CPI -- then fails the exact per-leg
//! lamport-delta postcondition, because the stub debited nothing:
//!
//!   * 6019 `BurnPdaLamportMismatch`  -> the SENTINEL: the adapter admitted
//!                                       the config, emitted the buy, and the
//!                                       CPI returned. (`after != before -
//!                                       amount_in` because nothing moved.)
//!   * 6006 `InvalidJupiterAccounts`  -> the adapter refused an account
//!                                       identity / flag / program / fee read;
//!   * 6014 `InvalidTokenAccountData` -> the adapter's curve pin refused;
//!   * 6039 `ReferenceInvalid`        -> the pre-CPI keyless floor refused the
//!                                       bound reference;
//!   * 6040 `ReferenceCapExceeded`    -> the input exceeds the reference's
//!                                       fee-derived depth cap;
//!   * 6021 `SlippageExceeded`        -> the caller's minimum is below the
//!                                       program's own floor;
//!   * 6002 `ZeroMinimumOutput`       -> the floor (or the adapter's quote
//!                                       mirror) floored to zero;
//!   * 6027 `InvalidInstructionData`  -> a widened multiply reported overflow.
//!
//! A keyless build WITHOUT the curve path cannot produce the sentinel: an
//! empty-route leg would run `validate_jupiter_route` on empty bytes and be
//! refused before any CPI. The positive control asserting 6019 is therefore
//! ALSO the build-identity probe, together with the 6027 single-target
//! dispatch refusal that pins the keyless-only merged artifact.
//!
//! # BUILD THE ARTIFACT (no features -- the merged build IS the artifact):
//!
//!   cd programs/burner && \
//!     PINOCCHIO_CARGO_BUILD_SBF=<repo>/tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf \
//!     bash ../../scripts/build-pinocchio.sh
//!
//! # BUILD THE BENIGN PUMP STUB (see the fixture crate header):
//!
//!   cd programs/burner/tests/benign-pump-fixture && \
//!     ../../../../tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf \
//!       --arch v3 --tools-version v1.53 --manifest-path Cargo.toml \
//!       --sbf-out-dir target/deploy
//!
//! # RUN:
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --test directcurve_artifact -- --include-ignored --nocapture
//!
//! Env: `BURNER_DIRECTCURVE_ELF` (or `BURNER_KEYLESS_ELF`) overrides the
//!      burner artifact path; `BENIGN_PUMP_ELF` overrides the stub path;
//!      `DIRECTCURVE_FUZZ_ITERS` scales the structured-corruption campaign;
//!      `BURNER_FUZZ_SEED` fixes the RNG for reproduction.

#![allow(clippy::type_complexity)]
#![allow(dead_code)] // layout constants + fixture fields kept for documentation

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_pubkey::Pubkey,
    std::{collections::BTreeMap, fs, path::PathBuf, str::FromStr},
};

// ---------------------------------------------------------------------------
// Fixed identities (base58), each asserted below to decode to the exact byte
// array the artifact was compiled with, so a typo cannot silently derive the
// wrong PDA and turn a real pass into a vacuous one.
// ---------------------------------------------------------------------------

const BURNER_PROGRAM: &str = "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const PUMP_FUN_PROGRAM: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FEE_PROGRAM: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const PUMP_BUY_DISCRIMINATOR: [u8; 8] = [56, 252, 116, 8, 158, 223, 205, 95];
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];
const PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR: [u8; 8] = [86, 255, 112, 14, 102, 53, 154, 250];

// The byte arrays the program source pins these to (constants.rs /
// directcurve.rs). Asserted equal to the base58 above in `assert_constants`.
const PUMP_FUN_BYTES: [u8; 32] = [
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245,
    210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];
const PUMP_FEE_BYTES: [u8; 32] = [
    12, 53, 255, 169, 5, 90, 142, 86, 141, 168, 247, 188, 7, 86, 21, 39, 76, 241, 201, 44, 164, 31,
    64, 0, 156, 81, 106, 164, 20, 194, 124, 112,
];

const PUMP_BUY_ACCOUNT_COUNT: usize = 16;
const PUMP_BUYBACK_RECIPIENTS: usize = 8;
const PUMP_USER_INDEX: usize = 6;
const BPS_DENOMINATOR: u64 = 10_000;
/// Mirrors `KEYLESS_TOL_BPS` in swap_and_burn.rs.
const KEYLESS_TOL_BPS: u64 = 100;
/// The canonical fixture fee_config parses to protocol 95 bps / creator 30 bps
/// with a default creator, so the effective fee both the floor and the adapter
/// use is a constant 95 bps exact-in.
const FIXTURE_FEE_BPS: u64 = 95;

// Error codes under test (append-only, client-visible).
const ZERO_INPUT: u32 = 6000;
const ZERO_MINIMUM_OUTPUT: u32 = 6002;
const INVALID_JUPITER_ACCOUNTS: u32 = 6006;
const INVALID_BURN_PDA: u32 = 6012;
const INVALID_TOKEN_ACCOUNT_DATA: u32 = 6014;
const WSOL_NOT_FULLY_CONSUMED: u32 = 6018;
const BURN_PDA_LAMPORT_MISMATCH: u32 = 6019; // the curve-path sentinel
const SLIPPAGE_EXCEEDED: u32 = 6021;
const BURN_REMAINDER_BELOW_RENT_FLOOR: u32 = 6026;
const INVALID_INSTRUCTION_DATA: u32 = 6027;
const REFERENCE_INVALID: u32 = 6039;
const REFERENCE_CAP_EXCEEDED: u32 = 6040;

fn key(value: &str) -> Pubkey {
    Pubkey::from_str(value).expect("valid fixed pubkey")
}

fn assert_constants() {
    assert_eq!(key(PUMP_FUN_PROGRAM).to_bytes(), PUMP_FUN_BYTES, "pump.fun base58 vs source bytes");
    assert_eq!(key(PUMP_FEE_PROGRAM).to_bytes(), PUMP_FEE_BYTES, "pump fee base58 vs source bytes");
}

// ---------------------------------------------------------------------------
// Deterministic RNG (SplitMix64) -- same reproduction contract as the keyless
// suite: a failing campaign prints its seed and BURNER_FUZZ_SEED replays it.
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
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn seed() -> u64 {
    std::env::var("BURNER_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(20_260_824)
}

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

fn burner_elf_path() -> PathBuf {
    if let Ok(p) = std::env::var("BURNER_DIRECTCURVE_ELF") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy/pinocchio_parity.so")
}

fn benign_pump_elf_path() -> PathBuf {
    if let Ok(p) = std::env::var("BENIGN_PUMP_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/benign-pump-fixture/target/deploy/benign_pump.so")
}

fn load_mollusk() -> Mollusk {
    assert_constants();
    let burner_path = burner_elf_path();
    assert!(
        burner_path.is_file(),
        "missing burner ELF: {} -- build with scripts/build-pinocchio.sh (see header)",
        burner_path.display()
    );
    let stub_path = benign_pump_elf_path();
    assert!(
        stub_path.is_file(),
        "missing benign pump stub ELF: {} -- build the benign-pump-fixture crate (see header)",
        stub_path.display()
    );

    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &key(BURNER_PROGRAM),
        &program::loader_keys::LOADER_V3,
        &fs::read(&burner_path).expect("read burner ELF"),
    );
    // The benign stub stands in for the Pump.fun program (CPI'd), the Pump fee
    // program (referenced, needs to be executable), and the Jupiter id (only
    // the fixed-account executability check ever sees it on a curve leg).
    let stub = fs::read(&stub_path).expect("read benign pump stub ELF");
    mollusk.add_program_with_loader_and_elf(&key(PUMP_FUN_PROGRAM), &program::loader_keys::LOADER_V3, &stub);
    mollusk.add_program_with_loader_and_elf(&key(PUMP_FEE_PROGRAM), &program::loader_keys::LOADER_V3, &stub);
    mollusk.add_program_with_loader_and_elf(&key(JUPITER_PROGRAM), &program::loader_keys::LOADER_V3, &stub);

    // BUILD-IDENTITY PROBE, twofold, pinning the merged keyless-only artifact:
    //  1. the single-target discriminator must be refused 6027 at dispatch (a
    //     KMS-era build answers 6004; the old directcurve feature build ran
    //     the instruction);
    //  2. a valid one-leg curve split must reach the 6019 sentinel, which a
    //     keyless build WITHOUT the curve path cannot (empty route data would
    //     be refused by the Jupiter route validator before any CPI).
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
        "artifact at {} did not refuse single-target dispatch with 6027 -- not the keyless-only \
         merged build",
        burner_path.display(),
    );
    let fixture = Fixture::valid();
    let code = fixture.run(&mollusk);
    assert_eq!(
        code, BURN_PDA_LAMPORT_MISMATCH,
        "artifact at {} did not run the curve path for an empty-route split leg (a valid one-leg \
         curve split did not reach the 6019 sentinel; got {code}). Rebuild the merged artifact \
         with scripts/build-pinocchio.sh.",
        burner_path.display()
    );
    mollusk
}

fn named_code(result: &Result<(), InstructionError>, ctx: &dyn Fn() -> String) -> u32 {
    match result {
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => *code,
        other => panic!("artifact produced a NON-NAMED outcome {other:?}\n{}", ctx()),
    }
}

// ---------------------------------------------------------------------------
// ATA / PDA derivations (host-side mirrors of the program's derivations)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Raw account byte builders
// ---------------------------------------------------------------------------

fn system_account(lamports: u64) -> Account {
    Account::new(lamports, 0, &Pubkey::default())
}

/// A loader-v3 program account (the proven Mollusk pattern): satisfies the
/// account-level executable/owner checks; the executable CODE comes from
/// `add_program`'s cache.
fn program_account(id: &Pubkey) -> Account {
    program::create_program_account_loader_v3(id)
}

fn pump_owned(len: usize) -> Account {
    Account { lamports: 1_000_000, data: vec![0u8; len], owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

/// 82-byte SPL Mint with null mint & freeze authorities (a valid burn target).
/// Supply (bytes 36..44) is set explicitly because the mayhem market-cap path
/// reads it.
fn immutable_mint(decimals: u8) -> Account {
    let mut data = vec![0u8; 82];
    data[36..44].copy_from_slice(&1_000_000_000_000_000u64.to_le_bytes());
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

/// Pump bonding-curve account (151 bytes, the current on-chain size).
/// `complete` sets byte 48 (a graduated curve is refused); `mayhem` sets byte
/// 81 (the market cap then uses the mint supply rather than the fixed 1e15).
fn curve_account(virtual_tokens: u64, virtual_sol: u64, creator: [u8; 32], complete: bool, mayhem: bool) -> Account {
    let mut data = vec![0u8; 151];
    data[8..16].copy_from_slice(&virtual_tokens.to_le_bytes());
    data[16..24].copy_from_slice(&virtual_sol.to_le_bytes());
    data[48] = complete as u8;
    data[49..81].copy_from_slice(&creator);
    data[81] = mayhem as u8;
    Account { lamports: 2_000_000, data, owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

/// Pump fee_config account: flat protocol 95 / creator 30, one tier
/// (threshold 0, lp 0, protocol 95, creator 30). Parsed by BOTH the keyless
/// floor's best-effort reader and the adapter's strict `curve_fee_bps` to an
/// effective 95 bps (the fixture creator is default, so the creator share is
/// excluded by both).
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

// ---------------------------------------------------------------------------
// The fixture: a one-leg (100% bps) curve split.
// 8 fixed accounts + the 7-account keyless leg block + 16 Pump buy accounts.
// ---------------------------------------------------------------------------

const FIXED: usize = 8;
const PER_TARGET: usize = 7;
/// Absolute slot indices of the leg-block accounts. Slots whose PUBKEY also
/// appears later in the route pool (curve, fee_config, mint, ATA, pda) are the
/// FIRST occurrence, which is the account `instruction()`'s dedup keeps -- so
/// account MUTATIONS for those keys must go through these indices.
const MINT_SLOT: usize = FIXED; // 8
const ATA_SLOT: usize = FIXED + 1; // 9
const REF_SLOT: usize = FIXED + 3; // 11: the bound reference (the curve)
const FEE_SOURCE_SLOT: usize = FIXED + 6; // 14: the fee_config

/// A meta plus its account, so a test can mutate either before running.
#[derive(Clone)]
struct Slot {
    key: Pubkey,
    signer: bool,
    writable: bool,
    account: Account,
}

struct Fixture {
    slots: Vec<Slot>,
    amount_in: u64,
    minimum_output: u64,
    jupiter_data: Vec<u8>, // route data; EMPTY selects the curve path
    // reference values, so the harness can predict floors and buy bytes
    virtual_tokens: u64,
    virtual_sol: u64,
    pda: Pubkey,
    target_mint: Pubkey,
}

impl Fixture {
    fn valid() -> Fixture {
        Self::with_curve(
            /* virtual_tokens */ 1_000_000_000_000_000,
            /* virtual_sol */ 30_000_000_000,
            /* amount_in */ 1_000_000,
            /* complete */ false,
            /* mayhem */ false,
        )
    }

    fn with_curve(virtual_tokens: u64, virtual_sol: u64, amount_in: u64, complete: bool, mayhem: bool) -> Fixture {
        let token_program = token::ID;
        let caller = Pubkey::new_from_array([10; 32]);
        let reserved_slot1 = Pubkey::new_from_array([16; 32]); // unchecked under keyless
        let launch_mint_key = Pubkey::new_from_array([13; 32]);
        let target_mint_key = Pubkey::new_from_array([0x71; 32]);
        let wsol = key(WSOL_MINT);

        let creator = [0u8; 32]; // default creator -> creator fee excluded
        let curve = pump_pda(&[b"bonding-curve", target_mint_key.as_ref()]);

        // The vault commits to the Pump-venue ZERO sentinel for its reference
        // (the curve is Pump-owned, so `build_split_seeds` binds `[0u8; 32]`).
        let zero_ref = [0u8; 32];
        let bps_blob = 10_000u16.to_le_bytes();
        let pda = Pubkey::find_program_address(
            &[b"burner", launch_mint_key.as_ref(), target_mint_key.as_ref(), &bps_blob, &zero_ref],
            &key(BURNER_PROGRAM),
        )
        .0;
        let wsol_source = ata(&pda, &wsol, &token_program);
        let target_ata = ata(&pda, &target_mint_key, &token_program);

        // Pump named accounts
        let global = pump_pda(&[b"global"]);
        let fee_recipient = Pubkey::new_from_array([0x40; 32]);
        let assoc_bonding_curve = ata(&curve, &target_mint_key, &token_program);
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

        let curve_acct = curve_account(virtual_tokens, virtual_sol, creator, complete, mayhem);
        // assoc_bonding_curve: token-program-owned but NOT pda-owned, so the
        // pre-route sweep treats it as "not ours".
        let abc_account = token_account(&target_mint_key, &curve, 0, false);

        let slots = vec![
            // ---- 8 fixed accounts ----
            // 0 caller (signer)
            Slot { key: caller, signer: true, writable: false, account: system_account(1_000_000) },
            // 1 reserved (held the KMS quote authority; unchecked under keyless)
            Slot { key: reserved_slot1, signer: false, writable: false, account: system_account(1_000_000) },
            // 2 burn_pda (mut), funded well above amount_in
            Slot { key: pda, signer: false, writable: true, account: system_account(10_000_000_000) },
            // 3 wsol_source (mut)
            Slot { key: wsol_source, signer: false, writable: true, account: token_account(&wsol, &pda, 0, true) },
            // 4 launch_mint
            Slot { key: launch_mint_key, signer: false, writable: false, account: immutable_mint(6) },
            // 5 system_program
            Slot { key: system.0, signer: false, writable: false, account: system.1.clone() },
            // 6 spl_token_program
            Slot { key: token_program, signer: false, writable: false, account: token::keyed_account().1 },
            // 7 jupiter_program (must be executable even on the curve path)
            Slot { key: key(JUPITER_PROGRAM), signer: false, writable: false, account: program_account(&key(JUPITER_PROGRAM)) },
            // ---- 7-account keyless leg block ----
            // +0 target_mint (mut)
            Slot { key: target_mint_key, signer: false, writable: true, account: immutable_mint(6) },
            // +1 target_token_account (mut)
            Slot { key: target_ata, signer: false, writable: true, account: token_account(&target_mint_key, &pda, 0, false) },
            // +2 target_token_program
            Slot { key: token_program, signer: false, writable: false, account: token::keyed_account().1 },
            // +3 reference: the bonding curve (Pump-owned -> zero-sentinel seed)
            Slot { key: curve, signer: false, writable: false, account: curve_acct.clone() },
            // +4 / +5 vault_a / vault_b: unused by the curve floor branch
            Slot { key: Pubkey::new_from_array([0xA1; 32]), signer: false, writable: false, account: system_account(1) },
            Slot { key: Pubkey::new_from_array([0xA2; 32]), signer: false, writable: false, account: system_account(1) },
            // +6 fee_source: the fee_config
            Slot { key: fee_config, signer: false, writable: false, account: fee_config_account() },
            // ---- 16 Pump buy accounts (the leg's route pool) ----
            // r0 global
            Slot { key: global, signer: false, writable: false, account: pump_owned(64) },
            // r1 fee_recipient (w) -- bare system
            Slot { key: fee_recipient, signer: false, writable: true, account: system_account(1_000_000) },
            // r2 mint (target_mint, readonly here)
            Slot { key: target_mint_key, signer: false, writable: false, account: immutable_mint(6) },
            // r3 bonding_curve (w)
            Slot { key: curve, signer: false, writable: true, account: curve_acct },
            // r4 assoc_bonding_curve (w)
            Slot { key: assoc_bonding_curve, signer: false, writable: true, account: abc_account },
            // r5 assoc_user (target_ata, w)
            Slot { key: target_ata, signer: false, writable: true, account: token_account(&target_mint_key, &pda, 0, false) },
            // r6 user (burn_pda, s/w on-chain; PDA cannot sign externally)
            Slot { key: pda, signer: false, writable: true, account: system_account(10_000_000_000) },
            // r7 system
            Slot { key: system.0, signer: false, writable: false, account: system.1.clone() },
            // r8 token_program
            Slot { key: token_program, signer: false, writable: false, account: token::keyed_account().1 },
            // r9 creator_vault (w) -- bare system
            Slot { key: creator_vault, signer: false, writable: true, account: system_account(1_000_000) },
            // r10 event_authority
            Slot { key: event_authority, signer: false, writable: false, account: system_account(1) },
            // r11 program (pump)
            Slot { key: key(PUMP_FUN_PROGRAM), signer: false, writable: false, account: program_account(&key(PUMP_FUN_PROGRAM)) },
            // r12 global_volume_accumulator
            Slot { key: global_volume, signer: false, writable: false, account: pump_owned(64) },
            // r13 user_volume_accumulator (w) -- system+empty so snapshot skips it
            Slot { key: user_volume, signer: false, writable: true, account: system_account(1_000_000) },
            // r14 fee_config
            Slot { key: fee_config, signer: false, writable: false, account: fee_config_account() },
            // r15 fee_program
            Slot { key: key(PUMP_FEE_PROGRAM), signer: false, writable: false, account: program_account(&key(PUMP_FEE_PROGRAM)) },
        ];

        Fixture {
            slots,
            amount_in,
            minimum_output: floor_safe_minimum(virtual_tokens, virtual_sol, amount_in),
            jupiter_data: Vec::new(),
            virtual_tokens,
            virtual_sol,
            pda,
            target_mint: target_mint_key,
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
        // Unique accounts (repeated pubkeys resolve to the FIRST occurrence's
        // account; privileges merge across metas at message compile time).
        let mut seen: BTreeMap<Pubkey, Account> = BTreeMap::new();
        let mut accounts = Vec::new();
        for s in &self.slots {
            if seen.insert(s.key, s.account.clone()).is_none() {
                accounts.push((s.key, s.account.clone()));
            }
        }
        // The leg's route_account_count is derived from the slots, so a test
        // that adds or removes Pump accounts exercises the ADAPTER's own count
        // bound rather than the handler's earlier whole-pool length check.
        let route_count = (self.slots.len() - FIXED - PER_TARGET) as u8;
        // total_amount_in | leg_count=1 | bps=10000 | minimum_output |
        // route_account_count | route_data_len | route_data
        let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&self.amount_in.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&10_000u16.to_le_bytes());
        data.extend_from_slice(&self.minimum_output.to_le_bytes());
        data.push(route_count);
        data.extend_from_slice(&(self.jupiter_data.len() as u32).to_le_bytes());
        data.extend_from_slice(&self.jupiter_data);
        (Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data }, accounts)
    }

    fn run(&self, mollusk: &Mollusk) -> u32 {
        let (ix, accounts) = self.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        named_code(&result.raw_result, &|| format!("curve split run amount_in={}", self.amount_in))
    }
}

/// A minimum guaranteed >= the program's keyless curve floor for this leg:
/// the raw constant-product output IGNORING the fee deduction and the
/// tolerance haircut. `cp_out` is monotone in the input and the program's
/// floor deducts both, so this bound can only sit at or above the floor.
fn floor_safe_minimum(virtual_tokens: u64, virtual_sol: u64, amount: u64) -> u64 {
    ((virtual_tokens as u128 * amount as u128) / (virtual_sol as u128 + amount as u128)) as u64
}

// ---------------------------------------------------------------------------
// Independent 128-bit reference models.
// ---------------------------------------------------------------------------

/// Mirrors the ADAPTER's `expected_output` in directcurve.rs byte-for-byte:
/// 1. net_sol = floor(max * 10000 / (10000 + protocol + creator))
/// 2. fees = ceil(net*protocol/10000) + ceil(net*creator/10000)
/// 3. net_sol -= (net_sol + fees).saturating_sub(max)  [checked_sub -> 6002]
/// 4. out = floor(vtr * (net_sol-1) / (vsr + net_sol - 1))
/// The `Err(code)` arm reproduces exactly which named code the program raises,
/// so a refusal can never be silently reclassified as the sentinel.
fn reference_expected_output(rt: u64, rs: u64, max_sol_cost: u64, protocol: u64, creator: u64) -> Result<u64, u32> {
    let total_fee = (protocol as u128).checked_add(creator as u128).ok_or(INVALID_INSTRUCTION_DATA)?;
    if total_fee >= BPS_DENOMINATOR as u128 {
        return Err(INVALID_TOKEN_ACCOUNT_DATA);
    }
    let mut net_sol = (max_sol_cost as u128)
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(INVALID_INSTRUCTION_DATA)?
        / (BPS_DENOMINATOR as u128 + total_fee);
    let ceil_bps = |amount: u128, bps: u128| -> Result<u128, u32> {
        Ok(amount
            .checked_mul(bps)
            .ok_or(INVALID_INSTRUCTION_DATA)?
            .checked_add(BPS_DENOMINATOR as u128 - 1)
            .ok_or(INVALID_INSTRUCTION_DATA)?
            / BPS_DENOMINATOR as u128)
    };
    let fees = ceil_bps(net_sol, protocol as u128)?
        .checked_add(ceil_bps(net_sol, creator as u128)?)
        .ok_or(INVALID_INSTRUCTION_DATA)?;
    let overshoot = net_sol.checked_add(fees).ok_or(INVALID_INSTRUCTION_DATA)?.saturating_sub(max_sol_cost as u128);
    net_sol = net_sol.checked_sub(overshoot).ok_or(ZERO_MINIMUM_OUTPUT)?;
    let net_input = net_sol.checked_sub(1).ok_or(ZERO_MINIMUM_OUTPUT)?;
    let denominator = (rs as u128).checked_add(net_input).ok_or(INVALID_INSTRUCTION_DATA)?;
    if net_input == 0 || rt == 0 || denominator == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    let output = (rt as u128).checked_mul(net_input).ok_or(INVALID_INSTRUCTION_DATA)? / denominator;
    if output == 0 || output > u64::MAX as u128 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    Ok(output as u64)
}

/// Mirrors the PRE-CPI keyless floor for the fixture's canonical curve leg
/// (`keyless_leg_floor`'s Pump branch + `keyless_floor_from_expected`), with
/// the fixture's constant 95 bps exact-in fee:
/// 1. rt == 0                              -> 6039 (ReferenceInvalid)
/// 2. cap = floor(rs * fee / 10000); amount > cap -> 6040 (ReferenceCapExceeded)
/// 3. net = floor(amount * 10000 / (10000 + fee)) - 1; underflow/zero -> 6002
/// 4. expected = floor(rt * net / (rs + net)); zero -> 6002
/// 5. floor = floor(expected * (10000 - 100) / 10000); zero -> 6002
/// The market-cap multiply (rs * supply, u128) cannot overflow for u64 inputs
/// and the fixture's tier-0 threshold always applies, so the fee is constant.
fn reference_keyless_curve_floor(rt: u64, rs: u64, amount: u64) -> Result<u64, u32> {
    if amount == 0 {
        return Err(ZERO_INPUT);
    }
    if rt == 0 {
        return Err(REFERENCE_INVALID);
    }
    let cap = (rs as u128) * (FIXTURE_FEE_BPS as u128) / (BPS_DENOMINATOR as u128);
    if (amount as u128) > cap {
        return Err(REFERENCE_CAP_EXCEEDED);
    }
    let net = (amount as u128) * (BPS_DENOMINATOR as u128)
        / (BPS_DENOMINATOR as u128 + FIXTURE_FEE_BPS as u128);
    let net = net.checked_sub(1).ok_or(ZERO_MINIMUM_OUTPUT)?;
    if net == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    let expected = (rt as u128) * net / ((rs as u128) + net);
    if expected == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    let floor = expected * ((BPS_DENOMINATOR - KEYLESS_TOL_BPS) as u128) / (BPS_DENOMINATOR as u128);
    if floor == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    Ok(floor as u64)
}

// ===========================================================================
// 0. POSITIVE CONTROL + BUILD IDENTITY
// ===========================================================================

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn valid_config_reaches_sentinel() {
    let mollusk = load_mollusk();
    // load_mollusk already asserts the sentinel as its identity probe; assert
    // again explicitly so this named test documents the positive control. The
    // pass is not vacuous: 6019 can only be produced AFTER the empty-route leg
    // selected the curve path, the floor admitted the caller's minimum, the
    // adapter validated all 16 Pump accounts, and the buy CPI returned -- the
    // benign stub then left the PDA's lamports untouched, which is exactly
    // what the exact conservation check refuses.
    assert_eq!(Fixture::valid().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);
    println!("positive control: valid one-leg curve split reaches 6019 sentinel");
}

// ===========================================================================
// 3. ENCODER: the emitted buy bytes match discriminator + fields + widths.
// ===========================================================================

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn encoder_emits_intended_buy_bytes() {
    let mollusk = load_mollusk();
    // The buy payload is `buy_exact_sol_in(spendable_sol_in, min_tokens_out,
    // track_volume)`. Per the source, spendable_sol_in == the leg's amount_in
    // and min_tokens_out == the caller's ALREADY-ENFORCED minimum_output. Vary
    // both fields independently so each field's position, width, and
    // endianness is pinned.
    //
    // MERGED-BUILD CONSTRAINT: the keyless floor refuses a minimum below the
    // program's own curve floor (6021) BEFORE the CPI, so unlike the old
    // single-target suite the minimums here must sit at or above the floor
    // (~3.3e10 for the 1e6-lamport default leg). They still exercise every
    // byte position of the field: low-byte-only, ascending pattern, high-bit
    // + low-bit, all-ones, and two mixed 8-byte patterns.
    let cases: &[(u64, u64)] = &[
        (1_000_000, 33_333_333_333),
        (5_000_000, 0x0102_0304_0506_0708),
        (250_000, 0xDEAD_BEEF_CAFE_F00D),
        (42_000_000, 0x1122_3344_5566_7788),
        (3, u64::MAX),
        (16_909_060, 0x8000_0000_0000_0001),
    ];
    let mut checked = 0usize;
    for &(amount_in, minimum_output) in cases {
        // Harness sanity, NOT a skip: every case must be admissible, so a bad
        // fixture value is a loud error rather than a silently skipped case.
        let floor = reference_keyless_curve_floor(1_000_000_000_000_000, 30_000_000_000, amount_in)
            .unwrap_or_else(|c| panic!("encoder case amount_in={amount_in}: floor refused {c}"));
        assert!(
            minimum_output >= floor,
            "encoder case amount_in={amount_in}: minimum {minimum_output} below floor {floor}"
        );
        let mut fixture = Fixture::with_curve(1_000_000_000_000_000, 30_000_000_000, amount_in, false, false);
        fixture.minimum_output = minimum_output;
        let (ix, accounts) = fixture.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        assert_eq!(
            named_code(&result.raw_result, &|| "encoder run".into()),
            BURN_PDA_LAMPORT_MISMATCH,
            "amount_in={amount_in} min={minimum_output} did not reach the buy CPI"
        );
        // Find the emitted Pump buy in the inner-instruction trace, by its
        // discriminator (the compiled tx account order is not the caller's).
        let mut found = None;
        for inner in result.inner_instructions.iter() {
            let d = &inner.instruction.data;
            if d.len() >= 8 && d[..8] == PUMP_BUY_DISCRIMINATOR {
                found = Some(d.clone());
            }
        }
        let data = found.unwrap_or_else(|| {
            panic!(
                "no inner Pump buy CPI recorded (total inner: {}, datas: {:?})",
                result.inner_instructions.len(),
                result.inner_instructions.iter().map(|i| i.instruction.data.len()).collect::<Vec<_>>()
            )
        });

        let mut expected = Vec::new();
        expected.extend_from_slice(&PUMP_BUY_DISCRIMINATOR);
        expected.extend_from_slice(&amount_in.to_le_bytes()); // spendable_sol_in
        expected.extend_from_slice(&minimum_output.to_le_bytes()); // min_tokens_out
        expected.push(0u8); // track_volume = None
        assert_eq!(data.len(), 25, "buy payload must be exactly 25 bytes");
        assert_eq!(
            data, expected,
            "emitted buy bytes != intended (amount_in={amount_in}, min_tokens_out={minimum_output})"
        );
        checked += 1;
    }
    assert_eq!(checked, cases.len(), "every encoder fixture must reach the CPI");
    println!("encoder: {checked} buy payloads matched discriminator + spendable_sol_in + min_tokens_out + track_volume, byte-for-byte");
}

// ===========================================================================
// 1. validate_pump_buy_accounts: counts, flags, identities, programs.
// ===========================================================================

/// Run a fixture after applying `mutate`, returning the named code.
fn run_mut(mollusk: &Mollusk, mut mutate: impl FnMut(&mut Fixture)) -> u32 {
    let mut f = Fixture::valid();
    mutate(&mut f);
    f.run(mollusk)
}

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn account_count_bounds() {
    let mollusk = load_mollusk();
    // Admitted control first: the unmutated fixture reaches the sentinel, so
    // the refusals below are targeted, not a blanket 6006.
    assert_eq!(Fixture::valid().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);

    // Too few: drop the last named account -> 15 remaining -> 6006. The leg's
    // route_account_count is derived from the slots, so this reaches the
    // ADAPTER's `len < 16` bound rather than the handler's earlier whole-pool
    // length check.
    let code = run_mut(&mollusk, |f| {
        f.slots.pop();
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "15 remaining accounts must be refused 6006");

    // 16 + 1 (bonding_curve_v2) is ACCEPTED: append one inert non-signer,
    // non-pda account -> sentinel.
    let code = run_mut(&mollusk, |f| {
        f.slots.push(Slot {
            key: Pubkey::new_from_array([0xAA; 32]),
            signer: false,
            writable: true, // the CPI marks index>=16 writable
            account: system_account(1),
        });
    });
    assert_eq!(code, BURN_PDA_LAMPORT_MISMATCH, "16+1 accounts must be accepted (bonding_curve_v2)");

    // 16 + 1 + 8 buyback recipients: the maximum, ACCEPTED.
    let code = run_mut(&mollusk, |f| {
        for i in 0..(1 + PUMP_BUYBACK_RECIPIENTS) {
            f.slots.push(Slot {
                key: Pubkey::new_from_array([0xB0 + i as u8; 32]),
                signer: false,
                writable: true,
                account: system_account(1),
            });
        }
    });
    assert_eq!(code, BURN_PDA_LAMPORT_MISMATCH, "16+1+8 accounts must be accepted (max)");

    // One past the maximum -> 6006 (the count bound fires before the CPI, so
    // the read-only extras never reach privilege escalation).
    let code = run_mut(&mollusk, |f| {
        for i in 0..(1 + PUMP_BUYBACK_RECIPIENTS + 1) {
            f.slots.push(Slot {
                key: Pubkey::new_from_array([0xC0 + i as u8; 32]),
                signer: false,
                writable: false,
                account: system_account(1),
            });
        }
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "16+1+9 accounts must be refused 6006");

    println!("account counts: 15->6006, 17->ok, 25->ok, 26->6006");
}

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn signer_and_writable_flag_checks() {
    let mollusk = load_mollusk();
    // Admitted control first.
    assert_eq!(Fixture::valid().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);

    // Any non-user index marked signer -> 6006. (r3 is the curve, whose pubkey
    // also appears as the read-only leg reference; message-level privileges
    // merge across duplicate metas, so the signer bit lands on the account the
    // adapter checks.)
    for r_idx in [0usize, 1, 3, 9, 13] {
        let code = run_mut(&mollusk, |f| {
            f.slots[Fixture::r(r_idx)].signer = true;
        });
        assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "remaining[{r_idx}] as signer must be refused 6006");
    }

    // A required-writable named index passed read-only -> 6006. (Indices whose
    // PUMP_BUY_WRITABLE entry is true: 1,3,4,5,6,9,13. r5/r6 share pubkeys
    // with leg-block/fixed writable metas and cannot be made read-only by
    // mutating one meta, exactly as in the original suite.)
    for r_idx in [1usize, 3, 4, 9, 13] {
        let code = run_mut(&mollusk, |f| {
            f.slots[Fixture::r(r_idx)].writable = false;
        });
        assert_eq!(
            code, INVALID_JUPITER_ACCOUNTS,
            "required-writable remaining[{r_idx}] passed read-only must be refused 6006"
        );
    }

    // The writable check in the adapter's per-account loop only applies to
    // index < 16. A buyback recipient (index 16) passed WRITABLE is accepted
    // (the CPI marks it writable too, so privileges are consistent).
    let code = run_mut(&mollusk, |f| {
        f.slots.push(Slot {
            key: Pubkey::new_from_array([0xAA; 32]),
            signer: false,
            writable: true, // index >= 16 -> validate does not require it, CPI marks it
            account: system_account(1),
        });
    });
    assert_eq!(code, BURN_PDA_LAMPORT_MISMATCH, "writable buyback recipient (index 16) must be accepted");

    println!("flags: non-user signer->6006, required-writable read-only->6006, index>=16 writable-extra accepted");
}

/// FINDING (robustness, not custody): `validate_pump_buy_accounts` does NOT
/// require a buyback/extra account (index >= 16) to be writable, but the CPI
/// meta builder in `invoke_pump_curve_buy` marks EVERY index >= 16 writable
/// unconditionally. So a caller that passes an extra account READ-ONLY is
/// admitted by validation and then aborts INSIDE the CPI dispatch with
/// `PrivilegeEscalation` -- a non-named runtime error rather than a clean
/// burner-authored revert. The transaction still rolls back (no custody or
/// authority change), so this is a liveness/hygiene gap, not a theft path, and
/// it is only reachable by a malformed caller. Documented here so the
/// non-named outcome is a KNOWN, asserted behaviour rather than a surprise.
/// Unchanged by the merge: the adapter code is identical inside the split leg.
#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn readonly_extra_account_aborts_privilege_escalation() {
    let mollusk = load_mollusk();
    let mut f = Fixture::valid();
    f.slots.push(Slot {
        key: Pubkey::new_from_array([0xAB; 32]),
        signer: false,
        writable: false, // read-only extra: validate admits it, CPI escalates it
        account: system_account(1),
    });
    let (ix, accounts) = f.instruction();
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_eq!(
        result.raw_result,
        Err(InstructionError::PrivilegeEscalation),
        "a read-only index-16 extra account is expected to abort at CPI dispatch (FINDING). \
         Got {:?}. If this becomes a named burner code, the gap was closed -- update this test.",
        result.raw_result
    );
    println!("FINDING confirmed: read-only extra account -> PrivilegeEscalation (non-named abort, vault untouched)");
}

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn account_identity_pins() {
    let mollusk = load_mollusk();
    // Admitted control first.
    assert_eq!(Fixture::valid().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);
    let wrong = Pubkey::new_from_array([0xEE; 32]);

    // Named-identity slots pinned to 6006 by the adapter's identity block. We
    // swap the pubkey (and provide a plausible account) and expect 6006.
    // (r2 mint, r6 user handled separately; r3 curve/r14 fee_config give
    // their own codes and are tested elsewhere.)
    let six006_slots: &[usize] = &[0 /*global*/, 4 /*assoc_bonding_curve*/, 5 /*assoc_user*/, 9 /*creator_vault*/, 10 /*event_authority*/, 12 /*global_volume*/, 13 /*user_volume*/];
    for &r_idx in six006_slots {
        let code = run_mut(&mollusk, |f| {
            f.slots[Fixture::r(r_idx)].key = wrong;
            // keep it a benign account so we isolate the identity check
            f.slots[Fixture::r(r_idx)].account = pump_owned(64);
        });
        assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "wrong identity at remaining[{r_idx}] must be 6006");
    }

    // r2 mint substituted (a different, valid mint) -> 6006.
    let code = run_mut(&mollusk, |f| {
        let k = Pubkey::new_from_array([0x77; 32]);
        f.slots[Fixture::r(2)].key = k;
        f.slots[Fixture::r(2)].account = immutable_mint(6);
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "wrong mint at remaining[2] must be 6006");

    // r6 user substituted away from the burn PDA -> 6006 (accounts[6] != pda).
    let code = run_mut(&mollusk, |f| {
        let k = Pubkey::new_from_array([0x66; 32]);
        f.slots[Fixture::r(6)].key = k;
        f.slots[Fixture::r(6)].account = system_account(1_000_000);
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "user slot not the burn PDA must be 6006");

    println!("identity pins: 9 slot substitutions each refused 6006");
}

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn system_account_and_program_pins() {
    let mollusk = load_mollusk();
    // Admitted control first.
    assert_eq!(Fixture::valid().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);

    // require_system_account slots (r1 fee_recipient, r9 creator_vault): a
    // non-system owner is refused 6006. (r6 is the pda, already covered.)
    for r_idx in [1usize, 9] {
        let code = run_mut(&mollusk, |f| {
            f.slots[Fixture::r(r_idx)].account.owner = key(PUMP_FUN_PROGRAM);
            f.slots[Fixture::r(r_idx)].account.data = vec![0u8; 8]; // non-empty
        });
        assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "non-system account at remaining[{r_idx}] must be 6006");
    }

    // require_program slots: r7 system, r8 token program, r11 pump, r15 fee.
    // A non-executable account at r11 (pump program) -> 6006.
    let code = run_mut(&mollusk, |f| {
        f.slots[Fixture::r(11)].account = Account { lamports: 1, data: vec![], owner: Pubkey::default(), executable: false, rent_epoch: 0 };
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "non-executable pump program must be 6006");

    // r8 token program swapped to a wrong (but executable) id -> 6006.
    let code = run_mut(&mollusk, |f| {
        f.slots[Fixture::r(8)].key = key(JUPITER_PROGRAM);
        f.slots[Fixture::r(8)].account = program_account(&key(JUPITER_PROGRAM));
    });
    assert_eq!(code, INVALID_JUPITER_ACCOUNTS, "wrong token program at remaining[8] must be 6006");

    println!("system/program pins: fee_recipient, creator_vault, pump program, token program all 6006");
}

// ===========================================================================
// 2. The curve pin: derive_pump_curve / validate_pump_curve, and the merged
//    build's EARLIER reference authentication that now fronts it.
//
// In the merged build the curve account appears TWICE: as the leg block's
// bound REFERENCE (read by `keyless_leg_floor` before any CPI, and fed into
// the vault's seed derivation) and as Pump route account r3 (read by the
// adapter's `validate_pump_curve`). Mutations that swap r3's ADDRESS while
// keeping the reference honest still reach the adapter's own pin (6014);
// mutations of the shared ACCOUNT are caught first by the floor (6039) or by
// the seed binding itself (6012), and the test asserts those SPECIFIC codes
// -- the adapter's identical checks remain in the source as defense in depth
// behind them, and are NOT weakened by this: every mutation below is still
// refused before any CPI, with the exact code stated.
// ===========================================================================

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn curve_pin_and_derivation() {
    let mollusk = load_mollusk();
    // Admitted control first: the same fixture minus each mutation sentinels.
    assert_eq!(Fixture::valid().run(&mollusk), BURN_PDA_LAMPORT_MISMATCH);

    // Wrong curve ADDRESS at route r3 (a random key holding a well-formed
    // Pump-owned curve; the leg REFERENCE keeps the honest curve, so the
    // pre-CPI floor passes) -> the ADAPTER's validate_pump_curve pin -> 6014.
    let code = run_mut(&mollusk, |f| {
        let k = Pubkey::new_from_array([0x33; 32]);
        f.slots[Fixture::r(3)].key = k;
        f.slots[Fixture::r(3)].account = curve_account(1_000_000_000_000_000, 30_000_000_000, [0u8; 32], false, false);
    });
    assert_eq!(code, INVALID_TOKEN_ACCOUNT_DATA, "wrong curve address at r3 must be 6014 (adapter pin)");

    // Route r3 replaced by a curve derived for a DIFFERENT mint (still a real
    // Pump PDA shape) -> its address no longer matches derive(target) -> 6014.
    let code = run_mut(&mollusk, |f| {
        let other = Pubkey::new_from_array([0x99; 32]);
        let wrong_curve = pump_pda(&[b"bonding-curve", other.as_ref()]);
        f.slots[Fixture::r(3)].key = wrong_curve;
        f.slots[Fixture::r(3)].account = curve_account(1_000_000_000_000_000, 30_000_000_000, [0u8; 32], false, false);
    });
    assert_eq!(code, INVALID_TOKEN_ACCOUNT_DATA, "curve derived for a different mint at r3 must be 6014 (adapter pin)");

    // The LEG REFERENCE mis-derived: a Pump-owned account at a non-curve
    // address. Pump ownership binds the zero sentinel, so the vault derivation
    // still matches -- and the floor's own derivation pin refuses it -> 6039.
    let code = run_mut(&mollusk, |f| {
        let k = Pubkey::new_from_array([0x35; 32]);
        f.slots[REF_SLOT].key = k;
        f.slots[REF_SLOT].account = curve_account(1_000_000_000_000_000, 30_000_000_000, [0u8; 32], false, false);
    });
    assert_eq!(code, REFERENCE_INVALID, "mis-derived Pump-owned reference must be 6039 (floor pin)");

    // Graduated curve (byte 48 != 0): the shared account is refused by the
    // floor's `cd[48] == 1` check -> 6039 (the adapter's identical graduated
    // check stands behind it as defense in depth).
    let code = run_mut(&mollusk, |f| {
        f.slots[REF_SLOT].account.data[48] = 1;
    });
    assert_eq!(code, REFERENCE_INVALID, "graduated curve must be 6039 (floor fronts the adapter)");

    // Short curve data (80 bytes, below the floor's 82-byte minimum and the
    // adapter's 81) -> 6039, never a slice-index abort.
    let code = run_mut(&mollusk, |f| {
        f.slots[REF_SLOT].account.data.truncate(80);
    });
    assert_eq!(code, REFERENCE_INVALID, "short curve data must be 6039 (floor fronts the adapter)");

    // Wrong curve OWNER: a non-Pump owner changes the SEED BINDING itself --
    // the reference binds by address instead of the Pump zero sentinel, so the
    // derived vault is a different, unfunded PDA -> 6012. This is the merged
    // design's answer to a mis-owned reference: it cannot even name this vault.
    let code = run_mut(&mollusk, |f| {
        f.slots[REF_SLOT].account.owner = key(PUMP_FEE_PROGRAM);
    });
    assert_eq!(code, INVALID_BURN_PDA, "non-Pump curve owner must re-derive to a different vault (6012)");

    println!("curve pin: r3 wrong-address/mis-derived -> 6014 (adapter); reference mis-derived/graduated/short -> 6039 (floor); wrong owner -> 6012 (seed binding)");
}

// ===========================================================================
// 4. Structured-corruption fuzzing of the two externally-read accounts (the
//    bonding curve and the fee_config). Every outcome must be NAMED.
// ===========================================================================

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn corruption_never_aborts() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value);
    let iters = env_u64("DIRECTCURVE_FUZZ_ITERS", 20_000);

    let mut sentinels = 0usize;
    let mut codes: BTreeMap<u32, usize> = BTreeMap::new();

    for _ in 0..iters {
        let mut f = Fixture::valid();
        // Fund the PDA to the max so the balance gate does not mask curve /
        // fee_config corruption behind a blanket 6001.
        f.slots[2].account.lamports = u64::MAX;
        // Randomize the amount within wide bands so the floor's cap and quote
        // arithmetic are exercised alongside the byte corruption.
        f.amount_in = match rng.below(4) {
            0 => rng.range(1, 1_000),
            1 => rng.range(1_000, 1_000_000_000),
            2 => rng.range(1_000_000_000, u64::MAX / 2),
            _ => u64::MAX - rng.below(4),
        };
        // Randomize the minimum so both sides of the floor gate are visited:
        // u64::MAX passes whenever the floor computes, the fixture default is
        // floor-safe only for the default amount, and a random u64 lands on
        // either side.
        f.minimum_output = match rng.below(3) {
            0 => u64::MAX,
            1 => f.minimum_output,
            _ => rng.next(),
        };

        // Corrupt N bytes across the curve and/or fee_config. The mutations go
        // through the LEG-BLOCK slots (the first occurrence of each pubkey,
        // which is the account the dedup keeps), so both the pre-CPI floor and
        // the adapter read the corrupted bytes.
        let bursts = 1 + rng.below(6);
        for _ in 0..bursts {
            let slot_idx = if rng.below(2) == 0 { REF_SLOT } else { FEE_SOURCE_SLOT };
            let slot = &mut f.slots[slot_idx];
            if slot.account.data.is_empty() {
                continue;
            }
            match rng.below(8) {
                // truncate to a random shorter length (bounds hazards)
                0 => {
                    let n = rng.below(slot.account.data.len() as u64 + 1) as usize;
                    slot.account.data.truncate(n);
                }
                // extend with random tail
                1 => {
                    let extra = rng.below(64) as usize;
                    for _ in 0..extra {
                        slot.account.data.push(rng.next() as u8);
                    }
                }
                // flip one random byte
                _ => {
                    let off = rng.below(slot.account.data.len() as u64) as usize;
                    slot.account.data[off] = rng.next() as u8;
                }
            }
        }
        // Occasionally corrupt the fee-tier count to a hostile value.
        if rng.below(3) == 0 {
            let slot = &mut f.slots[FEE_SOURCE_SLOT];
            if slot.account.data.len() >= 69 {
                let v = (rng.next() as u32).to_le_bytes();
                slot.account.data[65..69].copy_from_slice(&v);
            }
        }

        let (ix, accounts) = f.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        let code = named_code(&result.raw_result, &|| {
            format!(
                "CORRUPTION FUZZ FINDING (seed {seed_value}): amount_in={} minimum={} produced a non-named outcome",
                f.amount_in, f.minimum_output
            )
        });
        *codes.entry(code).or_default() += 1;
        if code == BURN_PDA_LAMPORT_MISMATCH {
            sentinels += 1;
        }
    }
    // Anti-vacuity canary: benign corruption (padding bytes, tolerated fee
    // damage) with a small in-cap amount and a permissive minimum must still
    // reach the sentinel sometimes; a campaign with zero sentinels means the
    // fixture stopped being admitted at all and the "named" property is being
    // proven against a single blanket refusal.
    assert!(sentinels > 0, "no corrupted case reached the sentinel (seed {seed_value}); fixture no longer admitted");
    println!("corruption fuzz: {iters} cases, all NAMED. codes={codes:?} (sentinels={sentinels}, seed {seed_value})");
}

// ===========================================================================
// 5. Arithmetic hazards: the pre-CPI floor (cap, fee deduction, cp_out,
//    tolerance haircut) and the adapter's quote mirror. Every outcome must be
//    NAMED and must agree exactly with the independent 128-bit model.
// ===========================================================================

/// What the artifact must return for `run_funded(rt, rs, amount)`:
/// `Exact(code)`, or `RentBand` when the post-burn remainder lands inside
/// (0, ~1e6) where the exact rent floor decides between 6026 and the sentinel
/// (the test deliberately does not pin the program's hand-rolled rent value).
enum Expect {
    Exact(u32),
    RentBand,
}

const REMAINDER_PAD: u64 = 1_000_000_000;

fn predict(rt: u64, rs: u64, amount: u64) -> Expect {
    match reference_keyless_curve_floor(rt, rs, amount) {
        Err(code) => Expect::Exact(code),
        Ok(_floor) => {
            // The sweep runs with minimum_output = u64::MAX >= any floor. A
            // floor-admitted leg must also pass the adapter's quote mirror:
            // both use net = amount*10000/10095 - 1 through the identical
            // constant-product formula, so admission implies a nonzero quote.
            // Assert it so any divergence is a loud harness finding.
            let quote = reference_expected_output(rt, rs, amount, 95, 0);
            assert!(
                quote.is_ok(),
                "model divergence: floor admitted rt={rt} rs={rs} amount={amount} but adapter mirror refused {quote:?}"
            );
            let before = amount.saturating_add(REMAINDER_PAD);
            let after = before - amount; // before >= amount always
            if after == 0 || after >= 1_000_000 {
                Expect::Exact(BURN_PDA_LAMPORT_MISMATCH)
            } else {
                Expect::RentBand
            }
        }
    }
}

fn check_expectation(code: u32, rt: u64, rs: u64, amount: u64, ctx: &str) {
    assert!((6000..=6043).contains(&code), "{ctx}: rt={rt} rs={rs} amount={amount} produced un-named {code}");
    match predict(rt, rs, amount) {
        Expect::Exact(expected) => assert_eq!(
            code, expected,
            "{ctx}: rt={rt} rs={rs} amount={amount} expected {expected}, got {code}"
        ),
        Expect::RentBand => assert!(
            code == BURN_PDA_LAMPORT_MISMATCH || code == BURN_REMAINDER_BELOW_RENT_FLOOR,
            "{ctx}: rent-band rt={rt} rs={rs} amount={amount} gave unexpected {code}"
        ),
    }
}

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn quote_arithmetic_boundaries_never_abort() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xC0FFEE);

    let run_funded = |mollusk: &Mollusk, rt: u64, rs: u64, amount: u64| -> u32 {
        let mut f = Fixture::with_curve(rt, rs, amount, false, false);
        // u64::MAX passes the floor gate whenever the floor computes, so the
        // refusal under test is always the arithmetic's own, never 6021.
        f.minimum_output = u64::MAX;
        f.slots[2].account.lamports = amount.saturating_add(REMAINDER_PAD);
        f.run(mollusk)
    };

    // Deterministic corners: extreme reserves and amounts, the exact cap
    // boundary, and deep-zero quotes. The model derives each expected code;
    // the two cap-boundary cases are ALSO pinned literally so the fee-cap
    // equality (amount <= floor(rs*95/10000)) is asserted in this file's own
    // text, not only through the model.
    let corners: &[(u64, u64, u64)] = &[
        (u64::MAX, u64::MAX, u64::MAX),
        (u64::MAX, u64::MAX, 1),
        (1, 1, u64::MAX),
        (1, u64::MAX, u64::MAX),
        (u64::MAX, 1, u64::MAX),
        (1_000_000_000_000_000, 30_000_000_000, u64::MAX),
        (1, 1, 1),
        (2, 1, 1),
        // admitted, deep arithmetic: within the cap of a u64::MAX-deep curve
        (u64::MAX, u64::MAX, 100_000_000_000_000_000),
        // the exact cap boundary of the canonical curve (30e9 * 95 / 10000)
        (1_000_000_000_000_000, 30_000_000_000, 285_000_000),
        (1_000_000_000_000_000, 30_000_000_000, 285_000_001),
        // deep-zero quote (cap admits, output floors to zero)
        (1, 1_000_000_000, 9_000_000),
        // zero FINAL floor (expected == 1, haircut floors it to zero)
        (200, 1_000_000_000, 9_000_000),
        // small admitted case
        (1_000_000, 1_000_000_000, 9_000_000),
    ];
    for &(rt, rs, amount) in corners {
        let code = run_funded(&mollusk, rt, rs, amount);
        check_expectation(code, rt, rs, amount, "corner");
    }
    // The literal cap-boundary pin (see the corner comment above).
    assert_eq!(
        run_funded(&mollusk, 1_000_000_000_000_000, 30_000_000_000, 285_000_000),
        BURN_PDA_LAMPORT_MISMATCH,
        "amount == cap must be admitted and reach the sentinel"
    );
    assert_eq!(
        run_funded(&mollusk, 1_000_000_000_000_000, 30_000_000_000, 285_000_001),
        REFERENCE_CAP_EXCEEDED,
        "amount == cap + 1 must be refused 6040"
    );

    // Randomized sweep, cross-checked against the 128-bit model.
    let mut checked = 0usize;
    for _ in 0..1_500 {
        let rt = match rng.below(3) {
            0 => rng.range(1, 1_000_000),
            1 => rng.range(1_000_000, u64::MAX / 2),
            _ => u64::MAX - rng.below(8),
        };
        let rs = match rng.below(3) {
            0 => rng.range(1, 1_000_000),
            1 => rng.range(1_000_000, u64::MAX / 2),
            _ => u64::MAX - rng.below(8),
        };
        let amount = match rng.below(3) {
            0 => rng.range(1, 1_000_000),
            1 => rng.range(1_000_000, u64::MAX / 2),
            _ => u64::MAX - rng.below(8),
        };
        let code = run_funded(&mollusk, rt, rs, amount);
        check_expectation(code, rt, rs, amount, &format!("random (seed {seed_value})"));
        checked += 1;
    }
    println!("quote arithmetic: {} corners + {checked} random, all named and model-agreeing", corners.len());
}

#[test]
#[ignore = "needs the merged keyless artifact + benign pump stub; see header"]
fn market_cap_multiply_never_overflows() {
    let mollusk = load_mollusk();
    // The market-cap multiply is virtual_sol * supply / virtual_tokens in
    // u128, and it runs TWICE per admitted leg in the merged build: once in
    // `keyless_leg_floor` and once in the adapter's `curve_fee_bps`. On the
    // mayhem path (curve byte 81 != 0) the supply is read from the mint
    // (bytes 36..44). Drive all three operands toward u64::MAX so the product
    // approaches 2^128, and require the exact model-predicted code -- never an
    // abort, never an unnamed error. The first case is deliberately one that
    // ADMITS and reaches the sentinel, so at least one extreme-supply mayhem
    // read provably flows through both multiplies and the buy CPI.
    let amount = 1_000_000u64;
    let cases: &[(u64, u64, u64)] = &[
        // (rs, supply, rt)
        (u64::MAX, u64::MAX, u64::MAX), // admits -> sentinel
        (u64::MAX, u64::MAX, 1),
        (u64::MAX, u64::MAX, 1_000_000_000_000),
        (u64::MAX / 2, u64::MAX, 3),
    ];
    for (i, &(rs, supply, rt)) in cases.iter().enumerate() {
        let mut f = Fixture::with_curve(rt, rs, amount, false, /* mayhem */ true);
        f.minimum_output = u64::MAX;
        // set the mint supply that the mayhem market cap reads (bytes 36..44)
        // on both copies of the target mint (dedup keeps the leg-block one).
        for si in [MINT_SLOT, Fixture::r(2)] {
            f.slots[si].account.data[36..44].copy_from_slice(&supply.to_le_bytes());
        }
        let code = f.run(&mollusk);
        // The supply does not enter the fixture's fee (tier-0 threshold always
        // applies), so the canonical model predicts the exact outcome.
        let expected = match reference_keyless_curve_floor(rt, rs, amount) {
            Err(c) => c,
            Ok(_) => BURN_PDA_LAMPORT_MISMATCH,
        };
        assert_eq!(
            code, expected,
            "mayhem market-cap rs={rs} supply={supply} rt={rt} expected {expected}, got {code}"
        );
        if i == 0 {
            assert_eq!(code, BURN_PDA_LAMPORT_MISMATCH, "the extreme-supply admit case must reach the sentinel");
        }
    }
    println!("market-cap multiply: extreme mayhem reserves/supply all named and model-agreeing, no overflow abort");
}
