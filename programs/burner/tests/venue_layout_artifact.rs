//! LAYOUT + PRICING suite for the two restored keyless reference venues:
//! Meteora DLMM (bin liquidity) and Raydium CLMM (concentrated liquidity),
//! executed against the REAL SBPF artifact under Mollusk (the
//! `keyless_artifact.rs` idiom — a panic in the VM is an abort, not a clean
//! revert, so arithmetic hazards are directly observable).
//!
//! WHY THIS SUITE EXISTS. The ~1M-case arithmetic sweep (FABLE-ARITH-SWEEP)
//! proved the MATHS of both branches; what it cannot prove is the LAYOUT —
//! whether byte offsets 76..80 really hold `active_id`, 253..269 really hold
//! `sqrt_price_x64`, and so on. A wrong offset produces a plausible WRONG
//! NUMBER, not a failure. This suite therefore drives the artifact with REAL
//! MAINNET ACCOUNT BYTES (snapshotted 2026-08-24, slots 441462407/441462579,
//! saved under `tests/venue-fixtures/`) for the four pools that carry the
//! only deep $PUMP and JTO liquidity, and cross-checks venues against each
//! other: a mis-read offset in ONE venue cannot reproduce the OTHER venue's
//! price for the same pair.
//!
//! Build the keyless artifact first (same as keyless_artifact.rs):
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
//!     --test venue_layout_artifact -- --ignored --nocapture
//!
//! Env: `BURNER_KEYLESS_ELF` overrides the artifact path;
//!      `VENUE_FUZZ_ITERS` scales the corruption campaign (default 60_000);
//!      `BURNER_FUZZ_SEED` fixes the RNG for reproduction.
//!
//! ORACLES (identical to keyless_artifact.rs). Since REFERENCE BINDING
//! landed, the single-target instruction is refused at dispatch under the
//! keyless feature, so every case here drives a ONE-LEG SPLIT whose vault is
//! derived WITH the leg's reference seed (the pool's address; Pump-owned
//! references bind as the [0u8;32] sentinel):
//!   * 6040 = the depth cap refused `amount_in`; 6039 = the reference (or
//!     its vaults / fee source) failed identity or content authentication;
//!     any other refusal raised INSIDE the floor computation propagates as
//!     its own code; 6005 = the floor stage ADMITTED the input (execution
//!     fell through to the empty-route-data sentinel).
//!   * `minimum_output < floor` is refused 6021, so the exact floor VALUE is
//!     recovered by binary search over `minimum_output`.

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_program_option::COption,
    solana_pubkey::Pubkey,
    spl_token_interface::state::{Account as TokenAccount, AccountState, Mint},
    std::{fs, path::PathBuf, str::FromStr},
};

const BURNER_PROGRAM: &str = "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];

// Byte-for-byte the constants in `keyless_leg_floor` (swap_and_burn.rs:814
// and :879). `program_id_constants_decode_to_canonical_pubkeys` pins them to
// the canonical base58 spellings, which were independently resolved AGAINST
// CHAIN during the 2026-08-24 layout audit: the four snapshotted pools are
// owned by exactly these program ids, and both program accounts are live
// executable BPF-upgradeable programs on mainnet.
const METEORA_DLMM: [u8; 32] = [
    4, 233, 225, 47, 188, 132, 232, 38, 201, 50, 204, 233, 226, 100, 12, 206, 21, 89, 12, 28, 98,
    115, 176, 146, 87, 8, 186, 59, 133, 32, 176, 188,
];
const RAYDIUM_CLMM: [u8; 32] = [
    165, 213, 202, 158, 4, 207, 93, 181, 144, 183, 20, 186, 47, 227, 44, 177, 89, 19, 63, 193,
    193, 146, 183, 34, 87, 253, 7, 211, 156, 176, 64, 30,
];
const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];

// The two Pump-ecosystem programs: a reference owned by either binds into
// the vault address as the [0u8; 32] sentinel rather than by address
// (byte-for-byte the constants in constants.rs, mirrored from
// keyless_artifact.rs).
const PUMP_FUN_PROGRAM: [u8; 32] = [
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
    245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];
const PUMP_SWAP_PROGRAM: [u8; 32] = [
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86,
    213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
];

/// Anchor account discriminators, verified against the venues' ON-CHAIN
/// Anchor IDLs (accounts `PoolState` / `LbPair` / `AmmConfig`) and against
/// the raw bytes of the four snapshotted mainnet pools.
const DLMM_LB_PAIR_DISCRIMINATOR: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
const CLMM_AMM_CONFIG_DISCRIMINATOR: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];
/// Raydium CLMM `PoolState` discriminator, pinned by the CLMM branch of
/// `keyless_leg_floor` (swap_and_burn.rs) since the 2026-08-24 hardening;
/// synthetic pool fixtures must carry it to be byte-valid.
const CLMM_POOL_STATE_DISCRIMINATOR: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];

const KEYLESS_TOL_BPS: u128 = 100;
const DLMM_FEE_DENOMINATOR: u128 = 1_000_000_000;
const CLMM_FEE_DENOMINATOR: u128 = 1_000_000;

// Error codes under test (append-only, client-visible).
const ZERO_MINIMUM_OUTPUT: u32 = 6002;
// STALE under the merged keyless+directcurve build: an EMPTY route now marks a
// leg as the CURVE leg, so an admitted floor lands on the directcurve adapter's
// 6006, NOT 6005. `recover_floor` never asserts this value — it calibrates on
// `sentinel != SLIPPAGE_EXCEEDED` and binary-searches the 6021 boundary — so
// the suite is agnostic to whether the admitted code is 6005 or 6006. Kept
// (dead) only so nobody "restores" a 6005 empty-route assertion.
#[allow(dead_code)]
const INVALID_JUPITER_INSTRUCTION: u32 = 6005;
const SLIPPAGE_EXCEEDED: u32 = 6021; // the split floor refusal
const INVALID_INSTRUCTION_DATA: u32 = 6027;
/// Reference identity/content refusal (was 6014 before binding landed).
const REFERENCE_INVALID: u32 = 6039;
#[allow(dead_code)]
const REFERENCE_TOO_SHALLOW: u32 = 6041;
/// Depth-cap refusal (was 6000 before binding landed); retryable by chunking.
const REFERENCE_CAP_EXCEEDED: u32 = 6040;
/// Change 2 mirror: minimum SOL-side depth an address-bound reference must
/// carry (50 SOL). Byte-for-byte `MIN_REFERENCE_DEPTH_LAMPORTS` in
/// swap_and_burn.rs. References below this are refused 6041.
const MIN_REFERENCE_DEPTH_LAMPORTS: u64 = 50_000_000_000;

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

/// A raw 165-byte SPL token account; the keyless reference reads only
/// mint (0..32), owner (32..64), amount (64..72).
fn raw_vault_account(owner_program: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized, for realism only
    Account { lamports: 2_039_280, data, owner: owner_program, executable: false, rent_epoch: 0 }
}

// ---------------------------------------------------------------------------
// Deterministic RNG (SplitMix64), same reproduction contract as the sibling
// suites: a failing campaign prints its seed; BURNER_FUZZ_SEED replays it.
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
// Mollusk setup and artifact identity (verbatim keyless_artifact.rs)
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
    // Build-identity probe: a BOUND keyless build refuses the single-target
    // discriminator at dispatch (6027) regardless of accounts, because the
    // legacy derivation carries no reference seed. A KMS build or a pre-
    // binding keyless build fails this probe with a different code (6004 /
    // 6028), so the probe uniquely authenticates the bound artifact.
    let mut metas = Vec::new();
    let mut accounts = Vec::new();
    let mut rng = Rng(1);
    for i in 0..13usize {
        let mut bytes = [0u8; 32];
        for chunk in bytes.chunks_mut(8) {
            chunk.copy_from_slice(&rng.next().to_le_bytes()[..chunk.len()]);
        }
        let pk = Pubkey::new_from_array(bytes);
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
// reference seed), so every case drives the split handler: `run_single` is a
// thin wrapper that keeps the historical call sites readable. The fixture's
// vault is derived WITH the reference seed, so the floor stage is reachable;
// a mismatching reference would stop at the 6012 address pin instead.
// ---------------------------------------------------------------------------

/// The 32-byte seed a reference binds into the vault derivation: the zero
/// sentinel for Pump-ecosystem owners, the reference's address otherwise
/// (mirrors `build_split_seeds`).
fn ref_seed(reference: &(Pubkey, Account)) -> [u8; 32] {
    if reference.1.owner == Pubkey::new_from_array(PUMP_FUN_PROGRAM)
        || reference.1.owner == Pubkey::new_from_array(PUMP_SWAP_PROGRAM)
    {
        [0u8; 32]
    } else {
        reference.0.to_bytes()
    }
}

fn run_single(mollusk: &Mollusk, fixture: &SplitFixture, amount_in: u64, minimum_output: u64) -> u32 {
    run_split_min(mollusk, fixture, amount_in, minimum_output)
}

// ---------------------------------------------------------------------------
// Venue reference bundle, synthetic builders, and REAL mainnet fixtures
// ---------------------------------------------------------------------------

/// One complete keyless reference: everything `keyless_leg_floor` reads.
/// `fee_source` may share the reference's pubkey (DLMM and Raydium v4 store
/// or key their fee off the pool account itself).
#[derive(Clone)]
struct VenueRef {
    target_mint: (Pubkey, Account),
    reference: (Pubkey, Account),
    vault_a: (Pubkey, Account),
    vault_b: (Pubkey, Account),
    fee_source: (Pubkey, Account),
}

impl VenueRef {
    /// One-leg split fixture around this reference, vault derived WITH the
    /// reference's seed.
    fn single(&self) -> SplitFixture {
        split_fixture(self)
    }
}

/// Synthetic Meteora DLMM LbPair fixture, laid out at the offsets verified
/// against the on-chain Anchor IDL: parameters.base_factor 8..10,
/// parameters.base_fee_power_factor 34, active_id 76..80, bin_step 80..82,
/// token_x_mint 88..120, token_y_mint 120..152, reserve_x 152..184,
/// reserve_y 184..216.
#[allow(clippy::too_many_arguments)]
fn dlmm_ref(
    base_factor: u16,
    power: u8,
    active_id: i32,
    bin_step: u16,
    sol_is_x: bool,
    sol_amount: u64,
    tok_amount: u64,
) -> VenueRef {
    let dlmm = Pubkey::new_from_array(METEORA_DLMM);
    let target_mint_key = Pubkey::new_from_array([0x91; 32]);
    let pool_key = Pubkey::new_from_array([0x92; 32]);
    let reserve_x_key = Pubkey::new_from_array([0x93; 32]);
    let reserve_y_key = Pubkey::new_from_array([0x94; 32]);
    let wsol = key(WSOL_MINT);
    let (x_mint, y_mint) =
        if sol_is_x { (wsol, target_mint_key) } else { (target_mint_key, wsol) };
    let (x_amount, y_amount) =
        if sol_is_x { (sol_amount, tok_amount) } else { (tok_amount, sol_amount) };

    let mut pd = vec![0u8; 904];
    pd[0..8].copy_from_slice(&DLMM_LB_PAIR_DISCRIMINATOR);
    pd[8..10].copy_from_slice(&base_factor.to_le_bytes());
    pd[34] = power;
    pd[76..80].copy_from_slice(&active_id.to_le_bytes());
    pd[80..82].copy_from_slice(&bin_step.to_le_bytes());
    pd[88..120].copy_from_slice(x_mint.as_ref());
    pd[120..152].copy_from_slice(y_mint.as_ref());
    pd[152..184].copy_from_slice(reserve_x_key.as_ref());
    pd[184..216].copy_from_slice(reserve_y_key.as_ref());
    let pool =
        Account { lamports: 7_182_720, data: pd, owner: dlmm, executable: false, rent_epoch: 0 };

    VenueRef {
        target_mint: (
            target_mint_key,
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6)),
        ),
        reference: (pool_key, pool.clone()),
        vault_a: (reserve_x_key, raw_vault_account(token::ID, &x_mint, &pool_key, x_amount)),
        vault_b: (reserve_y_key, raw_vault_account(token::ID, &y_mint, &pool_key, y_amount)),
        fee_source: (pool_key, pool),
    }
}

/// Synthetic Raydium CLMM PoolState + AmmConfig fixture, laid out at the
/// offsets verified against the on-chain Anchor IDL: amm_config 9..41,
/// token_mint_0 73..105, token_mint_1 105..137, token_vault_0 137..169,
/// token_vault_1 169..201, sqrt_price_x64 253..269; AmmConfig
/// protocol_fee_rate 43..47 (decoy for offset mutants), trade_fee_rate
/// 47..51.
fn clmm_ref(
    trade_fee_rate: u32,
    sqrt_price: u128,
    sol_is_0: bool,
    sol_amount: u64,
    tok_amount: u64,
) -> VenueRef {
    let clmm = Pubkey::new_from_array(RAYDIUM_CLMM);
    let target_mint_key = Pubkey::new_from_array([0xA1; 32]);
    let pool_key = Pubkey::new_from_array([0xA2; 32]);
    let vault0_key = Pubkey::new_from_array([0xA3; 32]);
    let vault1_key = Pubkey::new_from_array([0xA4; 32]);
    let config_key = Pubkey::new_from_array([0xA5; 32]);
    let wsol = key(WSOL_MINT);
    let (mint0, mint1) =
        if sol_is_0 { (wsol, target_mint_key) } else { (target_mint_key, wsol) };
    let (amount0, amount1) =
        if sol_is_0 { (sol_amount, tok_amount) } else { (tok_amount, sol_amount) };

    let mut pd = vec![0u8; 1544];
    pd[0..8].copy_from_slice(&CLMM_POOL_STATE_DISCRIMINATOR);
    pd[9..41].copy_from_slice(config_key.as_ref());
    pd[73..105].copy_from_slice(mint0.as_ref());
    pd[105..137].copy_from_slice(mint1.as_ref());
    pd[137..169].copy_from_slice(vault0_key.as_ref());
    pd[169..201].copy_from_slice(vault1_key.as_ref());
    pd[253..269].copy_from_slice(&sqrt_price.to_le_bytes());
    let pool =
        Account { lamports: 11_644_800, data: pd, owner: clmm, executable: false, rent_epoch: 0 };

    let mut cd = vec![0u8; 117];
    cd[0..8].copy_from_slice(&CLMM_AMM_CONFIG_DISCRIMINATOR);
    // Decoy at the adjacent field: a shifted trade_fee_rate read (47 -> 43)
    // lands on protocol_fee_rate = 120_000 (the live mainnet value), which is
    // a VALID fee < 1e6 — i.e. a silent mispricing, which is exactly the
    // defect class this suite exists to catch.
    cd[43..47].copy_from_slice(&120_000u32.to_le_bytes());
    cd[47..51].copy_from_slice(&trade_fee_rate.to_le_bytes());
    let config =
        Account { lamports: 1_704_240, data: cd, owner: clmm, executable: false, rent_epoch: 0 };

    VenueRef {
        target_mint: (
            target_mint_key,
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6)),
        ),
        reference: (pool_key, pool),
        vault_a: (vault0_key, raw_vault_account(token::ID, &mint0, &pool_key, amount0)),
        vault_b: (vault1_key, raw_vault_account(token::ID, &mint1, &pool_key, amount1)),
        fee_source: (config_key, config),
    }
}

// ---- REAL mainnet fixtures ------------------------------------------------

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/venue-fixtures").join(format!("{name}.bin"));
    fs::read(&path).unwrap_or_else(|e| panic!("missing venue fixture {}: {e}", path.display()))
}

fn fixture_account(name: &str, owner: &str) -> Account {
    Account {
        lamports: 10_000_000,
        data: fixture_bytes(name),
        owner: key(owner),
        executable: false,
        rent_epoch: 0,
    }
}

const PUMP_MINT: &str = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const JTO_MINT: &str = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const DLMM_PROGRAM_B58: &str = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const CLMM_PROGRAM_B58: &str = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_V4_B58: &str = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SPL_TOKEN_B58: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// $PUMP / WSOL Meteora DLMM pool HbjY… — the deepest $PUMP liquidity on any
/// venue (~12.2k SOL at snapshot). token_x = $PUMP, token_y = WSOL,
/// active_id = -1513 (NEGATIVE: the exact shape that once silently priced to
/// zero), bin_step 20, base_factor 10000 -> 20 bps fee.
fn real_dlmm_pump() -> VenueRef {
    let pool_key = key("HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh");
    let pool = fixture_account("dlmm_pump_pool", DLMM_PROGRAM_B58);
    VenueRef {
        target_mint: (
            key(PUMP_MINT),
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6)),
        ),
        reference: (pool_key, pool.clone()),
        vault_a: (
            key("5uXsebqNi3jDBvHvLJUuLqouUEHyQNDZcREHpLSwCZpM"),
            fixture_account("dlmm_pump_reserve_x", TOKEN_2022_PROGRAM),
        ),
        vault_b: (
            key("CD1RxU49jNwxD7LvRvrdWDNLpx5ZrJ7khMEzTNudk94s"),
            fixture_account("dlmm_pump_reserve_y", SPL_TOKEN_B58),
        ),
        fee_source: (pool_key, pool),
    }
}

/// JTO / WSOL Meteora DLMM pool GZcP… — active_id = -414, bin_step 125,
/// base_factor 2000 -> 25 bps fee.
fn real_dlmm_jto() -> VenueRef {
    let pool_key = key("GZcP3ANuTD15ZrYaF1RacomBKXVCCKvXYyWVDaEDqkKi");
    let pool = fixture_account("dlmm_jto_pool", DLMM_PROGRAM_B58);
    VenueRef {
        target_mint: (
            key(JTO_MINT),
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 9)),
        ),
        reference: (pool_key, pool.clone()),
        vault_a: (
            key("7wcgaGAD8yvtzC6rbAg4DLg33JaFaRq8v14xEF8b77yA"),
            fixture_account("dlmm_jto_reserve_x", SPL_TOKEN_B58),
        ),
        vault_b: (
            key("EEgZMC6z6jCP88dmgMem5dRB7YhLAH37A333nvFfVKwt"),
            fixture_account("dlmm_jto_reserve_y", SPL_TOKEN_B58),
        ),
        fee_source: (pool_key, pool),
    }
}

/// WSOL / $PUMP Raydium CLMM pool 45ss… — the second-deepest $PUMP venue
/// (~4.6k SOL at snapshot). token_0 = WSOL (sol_is_0), trade_fee_rate 1000
/// (10 bps), sqrt_price_x64 = 83589253752498556957.
fn real_clmm_pump() -> VenueRef {
    let pool_key = key("45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5");
    VenueRef {
        target_mint: (
            key(PUMP_MINT),
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6)),
        ),
        reference: (pool_key, fixture_account("clmm_pump_pool", CLMM_PROGRAM_B58)),
        vault_a: (
            key("A5VBGEV5ghKGSNFLpSy83ePE1BMpd2hZ8BHxFafNBNf6"),
            fixture_account("clmm_pump_vault0", SPL_TOKEN_B58),
        ),
        vault_b: (
            key("48xDcrnnENiygxTXGu9KPAuew3xRkfyrfb5iU6BNFbQK"),
            fixture_account("clmm_pump_vault1", TOKEN_2022_PROGRAM),
        ),
        fee_source: (
            key("DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY"),
            fixture_account("clmm_pump_ammconfig", CLMM_PROGRAM_B58),
        ),
    }
}

/// WSOL / JTO Raydium CLMM pool JVoP… — JTO's only deep venue (~168 SOL WSOL
/// side at snapshot vs 1.3 SOL on v4). token_0 = WSOL, trade_fee_rate 10000
/// (1%), sqrt_price_x64 = 241583840018074934333.
fn real_clmm_jto() -> VenueRef {
    let pool_key = key("JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo");
    VenueRef {
        target_mint: (
            key(JTO_MINT),
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 9)),
        ),
        reference: (pool_key, fixture_account("clmm_jto_pool", CLMM_PROGRAM_B58)),
        vault_a: (
            key("5cerU1uk6iPzndEK8AZguamz52e75am4NRXWrL9C19Bw"),
            fixture_account("clmm_jto_vault0", SPL_TOKEN_B58),
        ),
        vault_b: (
            key("GtDzTPATXEuGHrAb4seoW7HR9PkJMDxkPXwLWoqEkGNf"),
            fixture_account("clmm_jto_vault1", SPL_TOKEN_B58),
        ),
        fee_source: (
            key("A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x"),
            fixture_account("clmm_jto_ammconfig", CLMM_PROGRAM_B58),
        ),
    }
}

/// JTO / WSOL Raydium v4 pool EzLB… — the cross-venue witness for the CLMM
/// price: an already-tested venue whose price must agree with the CLMM read.
fn real_v4_jto() -> VenueRef {
    let pool_key = key("EzLBvtY6gwdz5BGJnKDZGgYrMzm1PLKcxdViqRx5fSL1");
    let pool = fixture_account("v4_jto_pool", RAYDIUM_V4_B58);
    VenueRef {
        target_mint: (
            key(JTO_MINT),
            token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 9)),
        ),
        reference: (pool_key, pool.clone()),
        vault_a: (
            key("4TUdXitxHQBn9DBqmdYaQpWuGGWTykzKejqDccvzDPGc"),
            fixture_account("v4_jto_vault_a", SPL_TOKEN_B58),
        ),
        vault_b: (
            key("9j35AzAygjUUdMCxp8dyQnnw3MhPaJqRi6eJ7cRJRd5q"),
            fixture_account("v4_jto_vault_b", SPL_TOKEN_B58),
        ),
        fee_source: (pool_key, pool),
    }
}

// ---------------------------------------------------------------------------
// Split fixture (one leg) for exact floor recovery via the 6021 refusal
// ---------------------------------------------------------------------------

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

struct SplitFixture {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    weights: Vec<u16>,
}

/// One-leg keyless split around an arbitrary `VenueRef` (8 fixed accounts +
/// 7 leg accounts: mint, ata, token_program, reference, vault_a, vault_b,
/// fee_source).
fn split_fixture(venue: &VenueRef) -> SplitFixture {
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = venue.target_mint.0;
    let weights = vec![10_000u16];
    let burn_pda = derive_split_pda(&launch, &[mint], &weights, &[ref_seed(&venue.reference)]);
    let caller = Pubkey::new_from_array([0x30; 32]);
    let quote_slot = Pubkey::new_from_array([0x31; 32]); // unused in keyless
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);
    let ata = associated_token_address(&burn_pda, &mint);

    let mut metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(quote_slot, false),
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(launch, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
        AccountMeta::new(mint, false),
        AccountMeta::new(ata, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(venue.reference.0, false),
        AccountMeta::new_readonly(venue.vault_a.0, false),
        AccountMeta::new_readonly(venue.vault_b.0, false),
        AccountMeta::new_readonly(venue.fee_source.0, false),
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
        (launch, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
        (mint, venue.target_mint.1.clone()),
        (ata, token::create_account_for_token_account(token_account(mint, burn_pda, 0, None))),
        (venue.reference.0, venue.reference.1.clone()),
        (venue.vault_a.0, venue.vault_a.1.clone()),
        (venue.vault_b.0, venue.vault_b.1.clone()),
    ];
    if !accounts.iter().any(|(pk, _)| *pk == venue.fee_source.0) {
        accounts.push(venue.fee_source.clone());
    }
    // De-duplicate metas' backing accounts (fee_source == reference is legal).
    let _ = &mut metas;
    SplitFixture { metas, accounts, weights }
}

fn run_split_min(mollusk: &Mollusk, fixture: &SplitFixture, amount: u64, minimum: u64) -> u32 {
    let mut accounts = fixture.accounts.clone();
    for (pk, account) in accounts.iter_mut() {
        if *pk == fixture.metas[2].pubkey {
            account.lamports = amount.saturating_add(RENT_FLOOR_ZERO_DATA);
        }
    }
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&(fixture.weights.len() as u32).to_le_bytes());
    for w in &fixture.weights {
        data.extend_from_slice(&w.to_le_bytes());
        data.extend_from_slice(&minimum.to_le_bytes());
        data.push(0); // route_account_count
        data.extend_from_slice(&0u32.to_le_bytes()); // route data length
    }
    let instruction =
        Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&instruction, &accounts);
    named_code(&result.raw_result, &|| {
        format!("split venue run: amount={amount} minimum={minimum}")
    })
}

/// Recover the artifact's exact floor for `amount`: the smallest
/// `minimum_output` NOT refused as 6021. Calibrates the sentinel at
/// `u64::MAX` first (which can never be below the floor).
fn recover_floor(mollusk: &Mollusk, venue: &VenueRef, amount: u64, label: &str) -> u64 {
    let fixture = split_fixture(venue);
    let sentinel = run_split_min(mollusk, &fixture, amount, u64::MAX);
    assert_ne!(sentinel, SLIPPAGE_EXCEEDED, "{label}: sentinel calibration failed");
    assert_eq!(
        run_split_min(mollusk, &fixture, amount, 1),
        SLIPPAGE_EXCEEDED,
        "{label}: minimum_output=1 must sit below the floor (floor >= 2 expected)"
    );
    let (mut lo, mut hi) = (1u64, u64::MAX);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if run_split_min(mollusk, &fixture, amount, mid) == SLIPPAGE_EXCEEDED {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

// ---------------------------------------------------------------------------
// Independent 128-bit reference (mirrors the DOCUMENTED semantics; the
// multiplication is an independently written 256-bit longhand, and the
// price algorithm is certified against an exact big-integer rational below)
// ---------------------------------------------------------------------------

/// floor((a*b) / 2^64), refusing (None) when the result exceeds u128 —
/// written as four-limb longhand, structurally unlike the artifact's
/// (hi,mid,lo) decomposition.
fn ref_mul_q64(a: u128, b: u128) -> Option<u128> {
    let (a0, a1) = (a as u64, (a >> 64) as u64);
    let (b0, b1) = (b as u64, (b >> 64) as u64);
    let p00 = (a0 as u128) * (b0 as u128);
    let p01 = (a0 as u128) * (b1 as u128);
    let p10 = (a1 as u128) * (b0 as u128);
    let p11 = (a1 as u128) * (b1 as u128);
    let mut c: u128 = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
    let r1 = c as u64;
    c = (c >> 64) + (p01 >> 64) + (p10 >> 64) + (p11 as u64 as u128);
    let r2 = c as u64;
    c = (c >> 64) + (p11 >> 64);
    if c != 0 {
        return None; // bits at or above position 192: (a*b)>>64 exceeds u128
    }
    Some(((r2 as u128) << 64) | r1 as u128)
}

/// Q64.64 bin price (1 + bin_step/10_000)^active_id — the same
/// square-and-multiply recurrence the program documents, over the
/// independent `ref_mul_q64`, with the exact-reciprocal negative branch.
fn ref_dlmm_price(bin_step: u16, active_id: i32) -> Option<u128> {
    let one: u128 = 1u128 << 64;
    let mut base = one.checked_mul(10_000u128 + bin_step as u128)? / 10_000;
    let mut e = active_id.unsigned_abs() as u64;
    let mut result = one;
    while e > 0 {
        if e & 1 == 1 {
            result = ref_mul_q64(result, base)?;
        }
        e >>= 1;
        if e > 0 {
            base = ref_mul_q64(base, base)?;
        }
    }
    if active_id < 0 {
        if result == 0 {
            return None;
        }
        let q = u128::MAX / result;
        let recip =
            if u128::MAX % result == result - 1 { q.checked_add(1)? } else { q };
        if recip == 0 {
            return None;
        }
        return Some(recip);
    }
    Some(result)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum RefResult {
    Refuse(u32),
    Floor(u64),
}

fn ref_floor_from_expected(expected: u128) -> RefResult {
    if expected == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    if expected > u64::MAX as u128 {
        return RefResult::Refuse(INVALID_INSTRUCTION_DATA);
    }
    let floor = expected * (10_000 - KEYLESS_TOL_BPS) / 10_000;
    if floor == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    RefResult::Floor(floor as u64)
}

/// The complete DLMM floor pipeline in independent arithmetic, refusal
/// ordering matched to the artifact: price FIRST, then fee, cap, net, spot.
#[allow(clippy::too_many_arguments)]
fn ref_floor_dlmm(
    base_factor: u16,
    power: u8,
    bin_step: u16,
    active_id: i32,
    sol_is_x: bool,
    depth: u64,
    amount: u64,
) -> RefResult {
    let Some(price) = ref_dlmm_price(bin_step, active_id) else {
        return RefResult::Refuse(INVALID_INSTRUCTION_DATA);
    };
    let Some(scale) = 10u64.checked_pow(power as u32) else {
        return RefResult::Refuse(REFERENCE_INVALID);
    };
    let num = (base_factor as u64)
        .checked_mul(bin_step as u64)
        .and_then(|v| v.checked_mul(10))
        .and_then(|v| v.checked_mul(scale));
    let Some(num) = num else { return RefResult::Refuse(REFERENCE_INVALID) };
    if num == 0 || num as u128 >= DLMM_FEE_DENOMINATOR {
        return RefResult::Refuse(REFERENCE_INVALID);
    }
    let cap = depth as u128 * num as u128 / DLMM_FEE_DENOMINATOR;
    if amount as u128 > cap {
        return RefResult::Refuse(REFERENCE_CAP_EXCEEDED);
    }
    let net = amount as u128 * (DLMM_FEE_DENOMINATOR - num as u128) / DLMM_FEE_DENOMINATOR;
    if net == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    let expected = if sol_is_x {
        match ref_mul_q64(net, price) {
            Some(e) => e,
            None => return RefResult::Refuse(INVALID_INSTRUCTION_DATA),
        }
    } else {
        (net << 64) / price
    };
    ref_floor_from_expected(expected)
}

/// The complete CLMM floor pipeline in independent arithmetic.
fn ref_floor_clmm(
    trade_fee_rate: u32,
    sq: u128,
    sol_is_0: bool,
    depth: u64,
    amount: u64,
) -> RefResult {
    if sq == 0 {
        return RefResult::Refuse(REFERENCE_INVALID);
    }
    let num = trade_fee_rate as u128;
    if num == 0 || num >= CLMM_FEE_DENOMINATOR {
        return RefResult::Refuse(REFERENCE_INVALID);
    }
    let cap = depth as u128 * num / CLMM_FEE_DENOMINATOR;
    if amount as u128 > cap {
        return RefResult::Refuse(REFERENCE_CAP_EXCEEDED);
    }
    let net = amount as u128 * (CLMM_FEE_DENOMINATOR - num) / CLMM_FEE_DENOMINATOR;
    if net == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    let expected = if sol_is_0 {
        let t = match net.checked_mul(sq) {
            Some(t) => t >> 64,
            None => return RefResult::Refuse(INVALID_INSTRUCTION_DATA),
        };
        match t.checked_mul(sq) {
            Some(e) => e >> 64,
            None => return RefResult::Refuse(INVALID_INSTRUCTION_DATA),
        }
    } else {
        let t = (net << 64) / sq;
        if t >> 64 != 0 {
            return RefResult::Refuse(INVALID_INSTRUCTION_DATA);
        }
        (t << 64) / sq
    };
    ref_floor_from_expected(expected)
}

/// Raydium v4 constant-product floor (already covered by keyless_artifact.rs;
/// used here only as the cross-venue price witness for the CLMM read).
#[allow(dead_code)] // Raydium v4 floor covered by keyless_artifact.rs; kept as a reference witness
fn ref_floor_v4(rt: u64, rs: u64, fee_num: u64, fee_den: u64, amount: u64) -> RefResult {
    let cap = rs as u128 * fee_num as u128 / fee_den as u128;
    if amount as u128 > cap {
        return RefResult::Refuse(REFERENCE_CAP_EXCEEDED);
    }
    let net = amount as u128 * (fee_den - fee_num) as u128 / fee_den as u128;
    if net == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    let cp = rt as u128 * net / (rs as u128 + net);
    if cp == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    let floor = cp * (10_000 - KEYLESS_TOL_BPS) / 10_000;
    if floor == 0 {
        return RefResult::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    match u64::try_from(floor) {
        Ok(f) => RefResult::Floor(f),
        Err(_) => RefResult::Refuse(INVALID_INSTRUCTION_DATA),
    }
}

// ---- real-fixture byte parsing (the offsets under test, applied by the
// TEST to the same bytes the artifact sees) --------------------------------

struct DlmmFields {
    base_factor: u16,
    power: u8,
    active_id: i32,
    bin_step: u16,
    sol_is_x: bool,
    depth: u64,
}

fn parse_dlmm(venue: &VenueRef) -> DlmmFields {
    let pd = &venue.reference.1.data;
    assert_eq!(&pd[0..8], &DLMM_LB_PAIR_DISCRIMINATOR, "LbPair discriminator");
    let wsol = key(WSOL_MINT);
    let sol_is_x = &pd[88..120] == wsol.as_ref();
    let sol_vault = if sol_is_x { &venue.vault_a.1 } else { &venue.vault_b.1 };
    assert_eq!(&sol_vault.data[0..32], wsol.as_ref(), "SOL-side reserve mint");
    DlmmFields {
        base_factor: u16::from_le_bytes(pd[8..10].try_into().unwrap()),
        power: pd[34],
        active_id: i32::from_le_bytes(pd[76..80].try_into().unwrap()),
        bin_step: u16::from_le_bytes(pd[80..82].try_into().unwrap()),
        sol_is_x,
        depth: u64::from_le_bytes(sol_vault.data[64..72].try_into().unwrap()),
    }
}

struct ClmmFields {
    trade_fee_rate: u32,
    sq: u128,
    sol_is_0: bool,
    depth: u64,
}

fn parse_clmm(venue: &VenueRef) -> ClmmFields {
    let pd = &venue.reference.1.data;
    let cd = &venue.fee_source.1.data;
    assert_eq!(&cd[0..8], &CLMM_AMM_CONFIG_DISCRIMINATOR, "AmmConfig discriminator");
    assert_eq!(&pd[9..41], venue.fee_source.0.as_ref(), "pool names its AmmConfig");
    let wsol = key(WSOL_MINT);
    let sol_is_0 = &pd[73..105] == wsol.as_ref();
    let sol_vault = if sol_is_0 { &venue.vault_a.1 } else { &venue.vault_b.1 };
    assert_eq!(&sol_vault.data[0..32], wsol.as_ref(), "SOL-side vault mint");
    ClmmFields {
        trade_fee_rate: u32::from_le_bytes(cd[47..51].try_into().unwrap()),
        sq: u128::from_le_bytes(pd[253..269].try_into().unwrap()),
        sol_is_0,
        depth: u64::from_le_bytes(sol_vault.data[64..72].try_into().unwrap()),
    }
}

fn expect_floor(result: RefResult, label: &str) -> u64 {
    match result {
        RefResult::Floor(f) => f,
        RefResult::Refuse(code) => panic!("{label}: reference refused with {code}"),
    }
}

// ---------------------------------------------------------------------------
// Minimal big-uint (little-endian u64 limbs, MULTIPLICATION ONLY) for the
// exact-rational price certificate. No division: the floor property
// p = floor(N/D) is certified multiplicatively via p*D <= N < (p+1)*D.
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq)]
struct Big(Vec<u64>);

impl Big {
    fn from_u128(v: u128) -> Big {
        Big(vec![v as u64, (v >> 64) as u64]).trimmed()
    }

    fn trimmed(mut self) -> Big {
        while self.0.len() > 1 && *self.0.last().unwrap() == 0 {
            self.0.pop();
        }
        self
    }

    fn mul_small(&self, m: u64) -> Big {
        let mut out = Vec::with_capacity(self.0.len() + 1);
        let mut carry: u128 = 0;
        for &limb in &self.0 {
            let v = limb as u128 * m as u128 + carry;
            out.push(v as u64);
            carry = v >> 64;
        }
        if carry > 0 {
            out.push(carry as u64);
        }
        Big(out).trimmed()
    }

    fn mul(&self, other: &Big) -> Big {
        let mut out = vec![0u64; self.0.len() + other.0.len()];
        for (i, &a) in self.0.iter().enumerate() {
            let mut carry: u128 = 0;
            for (j, &b) in other.0.iter().enumerate() {
                let v = a as u128 * b as u128 + out[i + j] as u128 + carry;
                out[i + j] = v as u64;
                carry = v >> 64;
            }
            let mut k = i + other.0.len();
            while carry > 0 {
                let v = out[k] as u128 + carry;
                out[k] = v as u64;
                carry = v >> 64;
                k += 1;
            }
        }
        Big(out).trimmed()
    }

    /// self << (64 * words)
    fn shl_words(&self, words: usize) -> Big {
        let mut out = vec![0u64; words];
        out.extend_from_slice(&self.0);
        Big(out).trimmed()
    }

    fn pow_small(base: u64, exp: u32) -> Big {
        let mut out = Big(vec![1]);
        for _ in 0..exp {
            out = out.mul_small(base);
        }
        out
    }

    fn cmp_big(&self, other: &Big) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        if self.0.len() != other.0.len() {
            return self.0.len().cmp(&other.0.len());
        }
        for i in (0..self.0.len()).rev() {
            match self.0[i].cmp(&other.0[i]) {
                Ordering::Equal => continue,
                o => return o,
            }
        }
        Ordering::Equal
    }
}

/// Certify a Q64.64 price `p` for (1 + s/10^4)^id against the EXACT rational
/// price, allowing `band` ULP each way. The repeated-squaring truncation
/// drift is RELATIVE (~|id| * 2^-64), so in fixed-point ULP terms it scales
/// with the price's magnitude: <= ~|id| * value ULP for value >= 1 (measured
/// ~7.9e3 ULP at bin_step=10, id=1600, value~4.95) and <= ~2|id| ULP below
/// 1.0 (the arithmetic sweep's negative-id bound; measured ~73 ULP at the
/// real $PUMP shape id=-1513). The band (2|id|+4)*(int_part+2)+8 covers both
/// with margin while staying ~1e-16 RELATIVE — vastly tighter than any
/// offset misread, which perturbs the price by orders of magnitude. For
/// id > 0 the exact value is (10^4+s)^id * 2^64 / 10^4^id; for id < 0 it is
/// 10^4^|id| * 2^64 / (10^4+s)^|id|.
fn certify_price(bin_step: u16, active_id: i32, p: u128) {
    let n = active_id.unsigned_abs();
    let band = (2u128 * n as u128 + 4) * ((p >> 64) + 2) + 8;
    let (num_base, den_base) =
        if active_id >= 0 { (10_000 + bin_step as u64, 10_000u64) } else { (10_000, 10_000 + bin_step as u64) };
    let n_big = Big::pow_small(num_base, n).shl_words(1); // * 2^64
    let d_big = Big::pow_small(den_base, n);
    // lower bound: (p + band + 1) * D > N  (i.e. p >= floor(N/D) - band)
    let hi = Big::from_u128(p + band + 1).mul(&d_big);
    assert!(
        hi.cmp_big(&n_big) == std::cmp::Ordering::Greater,
        "price for bin_step={bin_step} id={active_id} is MORE than {band} ULP below exact"
    );
    // upper bound: (p - band) * D <= N  (i.e. p <= floor(N/D) + band)
    if p > band {
        let lo = Big::from_u128(p - band).mul(&d_big);
        assert!(
            lo.cmp_big(&n_big) != std::cmp::Ordering::Greater,
            "price for bin_step={bin_step} id={active_id} is MORE than {band} ULP above exact"
        );
    }
}

// ===========================================================================
// 0. Constants and reference identity (host-only, no artifact)
// ===========================================================================

/// The venue program-id byte arrays restated above (byte-for-byte the
/// constants in swap_and_burn.rs) must decode to the canonical base58 ids the
/// 2026-08-24 audit resolved against chain. The ARTIFACT-level counterpart is
/// every real-fixture test below: if the compiled constants differed, the
/// snapshotted mainnet pools (whose owner is the CHAIN's value) would be
/// refused 6014 and every floor recovery would fail.
#[test]
fn program_id_constants_decode_to_canonical_pubkeys() {
    assert_eq!(Pubkey::new_from_array(METEORA_DLMM), key(DLMM_PROGRAM_B58));
    assert_eq!(Pubkey::new_from_array(RAYDIUM_CLMM), key(CLMM_PROGRAM_B58));
    assert_eq!(Pubkey::new_from_array(RAYDIUM_V4), key(RAYDIUM_V4_B58));
}

/// The independent reference price is certified against an EXACT big-integer
/// rational across bin_steps and ids, INCLUDING the negative-id band the
/// deleted implementation silently zeroed, and including the two real pools'
/// exact (bin_step, active_id) shapes. Host-only, fast, not ignored.
#[test]
fn dlmm_reference_price_certified_against_exact_rational() {
    // The two real pools' shapes first.
    for (bin_step, id) in [(20u16, -1513i32), (125, -414)] {
        let p = ref_dlmm_price(bin_step, id).expect("real-pool price must exist");
        certify_price(bin_step, id, p);
    }
    let mut certified = 2usize;
    for &bin_step in &[1u16, 5, 10, 20, 80, 125, 400] {
        for &n in &[1i32, 2, 3, 7, 16, 63, 100, 255, 500, 1000, 1600] {
            for &id in &[n, -n] {
                match ref_dlmm_price(bin_step, id) {
                    Some(p) => {
                        assert!(p > 0, "price must never be zero (bin_step={bin_step} id={id})");
                        certify_price(bin_step, id, p);
                        certified += 1;
                    }
                    None => {
                        // Refusal is legal only when the exact price truly
                        // does not fit Q64.64 (integer part >= 2^64) — i.e.
                        // (1+s/1e4)^|id| >= 2^64 — never a spurious refusal
                        // in the representable range.
                        let overflow = (n as f64) * (1.0 + bin_step as f64 / 10_000.0).ln()
                            >= 64.0 * std::f64::consts::LN_2 - 1e-9;
                        assert!(
                            overflow,
                            "reference refused a representable price (bin_step={bin_step} id={id})"
                        );
                    }
                }
            }
        }
    }
    println!("dlmm price certificate: {certified} (bin_step, id) shapes exact within band");
}

// ===========================================================================
// 1. REAL POOLS: floor and cap from genuine mainnet bytes
// ===========================================================================

fn assert_real_pool_dlmm(mollusk: &Mollusk, venue: &VenueRef, amounts: &[u64], label: &str) -> Vec<(u64, u64)> {
    let f = parse_dlmm(venue);
    assert!(f.active_id < 0, "{label}: expected a negative active_id (below-1.0 pool)");
    // Certify the reference's own price against the exact rational before
    // using it as the floor oracle.
    let price = ref_dlmm_price(f.bin_step, f.active_id).expect("price");
    certify_price(f.bin_step, f.active_id, price);

    // Cap boundary, exact both edges.
    let num = f.base_factor as u128
        * f.bin_step as u128
        * 10
        * 10u128.pow(f.power as u32);
    let cap = u64::try_from(f.depth as u128 * num / DLMM_FEE_DENOMINATOR).unwrap();
    let fixture = venue.single();
    assert_ne!(
        run_single(mollusk, &fixture, cap, 1),
        REFERENCE_CAP_EXCEEDED,
        "{label}: amount_in == cap ({cap}) must be admitted by the cap stage"
    );
    assert_eq!(
        run_single(mollusk, &fixture, cap + 1, 1),
        REFERENCE_CAP_EXCEEDED,
        "{label}: amount_in == cap+1 must be refused 6000"
    );

    // Exact floor differential at each probe amount.
    let mut floors = Vec::new();
    for &amount in amounts {
        assert!(amount <= cap, "{label}: probe amount {amount} exceeds cap {cap}");
        let expected = expect_floor(
            ref_floor_dlmm(f.base_factor, f.power, f.bin_step, f.active_id, f.sol_is_x, f.depth, amount),
            label,
        );
        assert!(expected >= 2, "{label}: probe amount too small to measure");
        let measured = recover_floor(mollusk, venue, amount, label);
        assert_eq!(
            measured, expected,
            "{label}: artifact floor {measured} != independent reference {expected} at amount {amount}"
        );
        floors.push((amount, measured));
    }
    println!("{label}: cap={cap} exact both edges; floors {floors:?} exact");
    floors
}

fn assert_real_pool_clmm(mollusk: &Mollusk, venue: &VenueRef, amounts: &[u64], label: &str) -> Vec<(u64, u64)> {
    let f = parse_clmm(venue);
    let cap = u64::try_from(f.depth as u128 * f.trade_fee_rate as u128 / CLMM_FEE_DENOMINATOR)
        .unwrap();
    let fixture = venue.single();
    assert_ne!(
        run_single(mollusk, &fixture, cap, 1),
        REFERENCE_CAP_EXCEEDED,
        "{label}: amount_in == cap ({cap}) must be admitted by the cap stage"
    );
    assert_eq!(
        run_single(mollusk, &fixture, cap + 1, 1),
        REFERENCE_CAP_EXCEEDED,
        "{label}: amount_in == cap+1 must be refused 6000"
    );
    let mut floors = Vec::new();
    for &amount in amounts {
        assert!(amount <= cap, "{label}: probe amount {amount} exceeds cap {cap}");
        let expected = expect_floor(
            ref_floor_clmm(f.trade_fee_rate, f.sq, f.sol_is_0, f.depth, amount),
            label,
        );
        assert!(expected >= 2, "{label}: probe amount too small to measure");
        let measured = recover_floor(mollusk, venue, amount, label);
        assert_eq!(
            measured, expected,
            "{label}: artifact floor {measured} != independent reference {expected} at amount {amount}"
        );
        floors.push((amount, measured));
    }
    println!("{label}: cap={cap} exact both edges; floors {floors:?} exact");
    floors
}

/// $PUMP's deepest venue: the Meteora DLMM pool with active_id = -1513. The
/// leg that was silently unpriceable in the deleted implementation.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn real_pump_dlmm_pool_floor_and_cap_exact() {
    let mollusk = load_mollusk();
    let venue = real_dlmm_pump();
    // 0.1 SOL, 1 SOL, 10 SOL — all inside the ~24.3 SOL cap.
    assert_real_pool_dlmm(&mollusk, &venue, &[100_000_000, 1_000_000_000, 10_000_000_000], "dlmm-pump(HbjY)");
}

/// JTO on Meteora DLMM (active_id = -414) is a REAL mainnet pool that Change 2
/// now REFUSES as too shallow: its WSOL side is ~23.95 SOL, below the 50-SOL
/// minimum-depth admission floor. A real-fixture under-depth refusal: the
/// artifact parses the FULL DLMM layout (a wrong offset trips 6039), reads the
/// depth, and refuses 6041 — never a wrong floor. Because the min-depth gate
/// is ordered after the cap refusal, an over-cap input still reports 6040, so
/// "too big" (6040) and "too shallow" (6041) are distinguished on ONE pool.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn real_jto_dlmm_pool_refused_too_shallow() {
    let mollusk = load_mollusk();
    let venue = real_dlmm_jto();
    let f = parse_dlmm(&venue);
    assert!(
        f.depth < MIN_REFERENCE_DEPTH_LAMPORTS,
        "fixture expected shallow (<50 SOL WSOL side), measured {} lamports",
        f.depth
    );
    // Layout witness: the pool's own price certifies against the exact rational.
    let price = ref_dlmm_price(f.bin_step, f.active_id).expect("price");
    certify_price(f.bin_step, f.active_id, price);
    let num = f.base_factor as u128 * f.bin_step as u128 * 10 * 10u128.pow(f.power as u32);
    let cap = u64::try_from(f.depth as u128 * num / DLMM_FEE_DENOMINATOR).unwrap();
    let fixture = venue.single();
    // Over the cap: 6040 (the cap fires before the depth gate).
    assert_eq!(
        run_single(&mollusk, &fixture, cap + 1, 1),
        REFERENCE_CAP_EXCEEDED,
        "dlmm-jto(GZcP): cap+1 must be refused 6040"
    );
    // In-cap but on a 23.95-SOL pool: refused 6041 (parsed to depth, too shallow).
    let in_cap = (cap / 2).max(1);
    assert_eq!(
        run_single(&mollusk, &fixture, in_cap, 1),
        REFERENCE_TOO_SHALLOW,
        "dlmm-jto(GZcP): an in-cap input on a 23.95-SOL pool must be refused 6041"
    );
    println!("dlmm-jto(GZcP): depth {} lamports < 50 SOL -> 6041 (cap+1 -> 6040)", f.depth);
}

/// $PUMP on Raydium CLMM (sqrt_price read, sol_is_0 orientation).
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn real_pump_clmm_pool_floor_and_cap_exact() {
    let mollusk = load_mollusk();
    let venue = real_clmm_pump();
    // Cap is ~4.65 SOL at the 10 bps config fee.
    assert_real_pool_clmm(&mollusk, &venue, &[100_000_000, 1_000_000_000, 4_000_000_000], "clmm-pump(45ss)");
}

/// JTO's only deep venue: Raydium CLMM.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn real_jto_clmm_pool_floor_and_cap_exact() {
    let mollusk = load_mollusk();
    let venue = real_clmm_jto();
    // Cap is ~1.68 SOL at the 1% config fee.
    assert_real_pool_clmm(&mollusk, &venue, &[50_000_000, 1_000_000_000], "clmm-jto(JVoP)");
}

// ===========================================================================
// 2. CROSS-VENUE PRICE WITNESSES: a wrong offset in one venue cannot
//    reproduce another venue's price for the same pair
// ===========================================================================

/// The two $PUMP venues (DLMM bins vs CLMM sqrt_price — entirely disjoint
/// layouts and maths) must imply the same price. Fees differ (20 vs 10 bps),
/// so floors are compared after normalizing out each venue's own fee.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cross_venue_pump_dlmm_vs_clmm_price_agreement() {
    let mollusk = load_mollusk();
    let amount = 1_000_000_000u64; // 1 SOL, inside both caps
    let dlmm = real_dlmm_pump();
    let clmm = real_clmm_pump();
    let dlmm_floor = recover_floor(&mollusk, &dlmm, amount, "x-venue dlmm-pump") as f64;
    let clmm_floor = recover_floor(&mollusk, &clmm, amount, "x-venue clmm-pump") as f64;
    let df = parse_dlmm(&dlmm);
    let cf = parse_clmm(&clmm);
    let dlmm_fee = (df.base_factor as f64 * df.bin_step as f64 * 10.0) / 1e9;
    let clmm_fee = cf.trade_fee_rate as f64 / 1e6;
    let ratio = (dlmm_floor / (1.0 - dlmm_fee)) / (clmm_floor / (1.0 - clmm_fee));
    assert!(
        (0.98..=1.02).contains(&ratio),
        "PUMP price disagreement between DLMM and CLMM reads: fee-normalized floor ratio {ratio} \
         (dlmm {dlmm_floor}, clmm {clmm_floor}) — a layout misread in one venue"
    );
    println!("cross-venue $PUMP: dlmm {dlmm_floor} vs clmm {clmm_floor}, fee-normalized ratio {ratio:.5}");
}

/// JTO three ways: CLMM sqrt_price vs DLMM bins vs the ALREADY-TESTED Raydium
/// v4 constant-product read. v4's layout has real coverage elsewhere, so its
/// agreement anchors the two new venues to a known-good baseline.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cross_venue_jto_clmm_vs_dlmm_vs_v4_price_agreement() {
    let mollusk = load_mollusk();
    let clmm = real_clmm_jto();
    let dlmm = real_dlmm_jto();
    let v4 = real_v4_jto();
    // Only JTO's CLMM pool (~167.8 SOL) clears the 50-SOL min-depth floor; its
    // DLMM (~23.95) and v4 (~1.30) references are below it and are now REFUSED
    // 6041 rather than priced. The artifact still parses them (a layout misread
    // would be 6039), so their refusal witnesses the layout up to the depth
    // read; their PRICE offsets are cross-checked host-side below.
    let amount = 3_000_000u64;
    assert_eq!(
        run_single(&mollusk, &dlmm.single(), amount, 1),
        REFERENCE_TOO_SHALLOW,
        "JTO DLMM (~23.95 SOL) must be refused 6041, not priced"
    );
    assert_eq!(
        run_single(&mollusk, &v4.single(), amount, 1),
        REFERENCE_TOO_SHALLOW,
        "JTO v4 (~1.30 SOL) must be refused 6041, not priced"
    );

    // The CLMM floor recovered FROM THE ARTIFACT must agree, fee-normalized,
    // with the DLMM price computed from the DLMM pool's OWN bytes: a wrong
    // sqrt_price/active_id/bin_step offset in either venue cannot reproduce the
    // other's price for the same JTO/SOL pair.
    let clmm_floor = recover_floor(&mollusk, &clmm, amount, "x-venue clmm-jto") as f64;
    let cf = parse_clmm(&clmm);
    let df = parse_dlmm(&dlmm);
    let dlmm_floor = match ref_floor_dlmm(
        df.base_factor, df.power, df.bin_step, df.active_id, df.sol_is_x, df.depth, amount,
    ) {
        RefResult::Floor(f) => f as f64,
        other => panic!("dlmm-jto reference floor unexpectedly refused: {other:?}"),
    };
    let clmm_fee = cf.trade_fee_rate as f64 / 1e6;
    let dlmm_fee = (df.base_factor as f64 * df.bin_step as f64 * 10.0) / 1e9;
    let ratio = (clmm_floor / (1.0 - clmm_fee)) / (dlmm_floor / (1.0 - dlmm_fee));
    assert!(
        (0.97..=1.03).contains(&ratio),
        "JTO price disagreement (clmm-onchain / dlmm-reference): fee-normalized ratio {ratio} \
         (clmm {clmm_floor}, dlmm {dlmm_floor}) — a layout misread in one venue"
    );
    println!(
        "cross-venue JTO: clmm(on-chain) {clmm_floor} vs dlmm(reference) {dlmm_floor}, \
         ratio {ratio:.4}; DLMM+v4 refused 6041 (too shallow)"
    );
}

// ===========================================================================
// 3. CAP BOUNDARIES, synthetic, both venues: cap admitted / cap+1 refused
// ===========================================================================

#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn cap_exact_boundary_synthetic_both_venues() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x51);
    let mut checked = 0usize;

    // DLMM: fee = base_factor * bin_step * 10 * 10^power over 1e9.
    let mut dlmm_cases: Vec<(u16, u8, u16, u64)> = vec![
        (10_000, 0, 20, 12_179_071_482_490), // the real $PUMP pool's shape
        (2_000, 0, 125, 23_948_677_196),     // the real JTO pool's shape
        (1, 0, 1, 1_000_000_000),
        (10_000, 1, 400, u64::MAX / 2),
    ];
    for _ in 0..40 {
        dlmm_cases.push((
            rng.range(1, 60_000) as u16,
            0,
            rng.range(1, 400) as u16,
            rng.range(1_000_000, u64::MAX / 2),
        ));
    }
    for (base_factor, power, bin_step, depth) in dlmm_cases {
        let num = base_factor as u128 * bin_step as u128 * 10 * 10u128.pow(power as u32);
        if num == 0 || num >= DLMM_FEE_DENOMINATOR {
            continue;
        }
        let cap = u64::try_from(depth as u128 * num / DLMM_FEE_DENOMINATOR).unwrap();
        if cap < 1 {
            continue;
        }
        // active_id = 0 gives price exactly 1.0 Q64: the cap boundary is then
        // observable regardless of price magnitude.
        let venue = dlmm_ref(base_factor, power, 0, bin_step, false, depth, 1_000_000);
        let fixture = venue.single();
        assert_ne!(
            run_single(&mollusk, &fixture, cap, 1),
            REFERENCE_CAP_EXCEEDED,
            "dlmm cap must admit amount==cap: bf={base_factor} bs={bin_step} depth={depth} (seed {seed_value})"
        );
        if cap < u64::MAX {
            assert_eq!(
                run_single(&mollusk, &fixture, cap + 1, 1),
                REFERENCE_CAP_EXCEEDED,
                "dlmm cap must refuse cap+1: bf={base_factor} bs={bin_step} depth={depth} (seed {seed_value})"
            );
        }
        checked += 1;
    }

    // CLMM: fee = trade_fee_rate over 1e6.
    let mut clmm_cases: Vec<(u32, u64)> = vec![
        (1_000, 4_649_669_540_012),  // real $PUMP pool shape
        (10_000, 167_838_275_396),   // real JTO pool shape
        (1, 1_000_000_000),
        (999_999, u64::MAX / 2),
    ];
    for _ in 0..40 {
        clmm_cases.push((rng.range(1, 999_999) as u32, rng.range(1_000_000, u64::MAX / 2)));
    }
    for (fee, depth) in clmm_cases {
        let cap = u64::try_from(depth as u128 * fee as u128 / CLMM_FEE_DENOMINATOR).unwrap();
        if cap < 1 {
            continue;
        }
        let venue = clmm_ref(fee, 1u128 << 64, true, depth, 1_000_000);
        let fixture = venue.single();
        assert_ne!(
            run_single(&mollusk, &fixture, cap, 1),
            REFERENCE_CAP_EXCEEDED,
            "clmm cap must admit amount==cap: fee={fee} depth={depth} (seed {seed_value})"
        );
        if cap < u64::MAX {
            assert_eq!(
                run_single(&mollusk, &fixture, cap + 1, 1),
                REFERENCE_CAP_EXCEEDED,
                "clmm cap must refuse cap+1: fee={fee} depth={depth} (seed {seed_value})"
            );
        }
        checked += 1;
    }
    println!("synthetic cap boundary: {checked} (venue, fee, depth) shapes, both edges exact");
}

// ===========================================================================
// 4. FLOOR DIFFERENTIAL, synthetic, both venues and both orientations,
//    negative AND positive active_id
// ===========================================================================

#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn floor_value_matches_reference_synthetic_dlmm() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x52);
    let mut cases = 0usize;
    // Deterministic id grid spanning both signs (the negative band is the
    // historically broken one), then random fill.
    let mut shapes: Vec<(u16, u16, i32, bool)> = vec![
        (10_000, 20, -1513, false),
        (2_000, 125, -414, false),
        (10_000, 20, -1513, true),
        (5_000, 10, -1, false),
        (5_000, 10, 1, false),
        (5_000, 10, -100, true),
        (5_000, 10, 100, true),
        (100, 1, -3000, false),
        (100, 1, 3000, false),
        (20_000, 80, -700, true),
        (20_000, 80, 700, false),
    ];
    for _ in 0..24 {
        let bin_step = rng.range(1, 400) as u16;
        let id_mag = rng.range(1, 2_000) as i32;
        let id = if rng.below(2) == 0 { -id_mag } else { id_mag };
        shapes.push((rng.range(100, 40_000) as u16, bin_step, id, rng.below(2) == 0));
    }
    for (base_factor, bin_step, active_id, sol_is_x) in shapes {
        let depth = rng.range(MIN_REFERENCE_DEPTH_LAMPORTS, 1_000_000_000_000_000);
        let venue = dlmm_ref(base_factor, 0, active_id, bin_step, sol_is_x, depth, 1_000_000);
        let num = base_factor as u128 * bin_step as u128 * 10;
        if num == 0 || num >= DLMM_FEE_DENOMINATOR {
            continue;
        }
        let cap = u64::try_from(depth as u128 * num / DLMM_FEE_DENOMINATOR).unwrap();
        if cap < 2 {
            continue;
        }
        let amount = rng.range(2, cap);
        let expected = ref_floor_dlmm(base_factor, 0, bin_step, active_id, sol_is_x, depth, amount);
        let RefResult::Floor(expected_floor) = expected else {
            continue; // refusal shapes are covered by the corruption campaign
        };
        if expected_floor < 2 {
            continue;
        }
        let measured = recover_floor(&mollusk, &venue, amount, "synthetic dlmm");
        assert_eq!(
            measured, expected_floor,
            "dlmm floor mismatch: bf={base_factor} bs={bin_step} id={active_id} sol_is_x={sol_is_x} \
             depth={depth} amount={amount} (seed {seed_value})"
        );
        cases += 1;
    }
    assert!(cases >= 15, "too few measurable dlmm floor fixtures: {cases}");
    println!("synthetic dlmm floor: {cases} shapes, artifact == reference exactly");
}

#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn floor_value_matches_reference_synthetic_clmm() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x53);
    let mut cases = 0usize;
    let mut shapes: Vec<(u32, u128, bool)> = vec![
        (1_000, 83_589_253_752_498_556_957, true),   // real $PUMP pool
        (10_000, 241_583_840_018_074_934_333, true), // real JTO pool
        (2_500, 1u128 << 64, true),                  // price exactly 1.0
        (2_500, 1u128 << 64, false),
        (100, (1u128 << 64) / 1_000, true),          // deep below-1.0 price
        (100, (1u128 << 64) / 1_000, false),
        (500, (1u128 << 64) * 1_000, true),
        (500, (1u128 << 64) * 1_000, false),
    ];
    for _ in 0..24 {
        // sqrt prices spanning ~2^-32 .. 2^96 in value.
        let shift = rng.range(32, 96) as u32;
        let sq = (1u128 << shift) | rng.next() as u128;
        shapes.push((rng.range(1, 999_999) as u32, sq, rng.below(2) == 0));
    }
    for (fee, sq, sol_is_0) in shapes {
        let depth = rng.range(MIN_REFERENCE_DEPTH_LAMPORTS, 1_000_000_000_000_000);
        let venue = clmm_ref(fee, sq, sol_is_0, depth, 1_000_000);
        let cap = u64::try_from(depth as u128 * fee as u128 / CLMM_FEE_DENOMINATOR).unwrap();
        if cap < 2 {
            continue;
        }
        let amount = rng.range(2, cap);
        let expected = ref_floor_clmm(fee, sq, sol_is_0, depth, amount);
        let RefResult::Floor(expected_floor) = expected else {
            continue;
        };
        if expected_floor < 2 {
            continue;
        }
        let measured = recover_floor(&mollusk, &venue, amount, "synthetic clmm");
        assert_eq!(
            measured, expected_floor,
            "clmm floor mismatch: fee={fee} sq={sq} sol_is_0={sol_is_0} depth={depth} \
             amount={amount} (seed {seed_value})"
        );
        cases += 1;
    }
    assert!(cases >= 15, "too few measurable clmm floor fixtures: {cases}");
    println!("synthetic clmm floor: {cases} shapes, artifact == reference exactly");
}

// ===========================================================================
// 5. NEGATIVE active_id, PROVABLY correct against the artifact
// ===========================================================================

/// The exact regression shape: every below-1.0 pool (i.e. every meme token
/// priced in SOL raw units) has a negative active_id, and the deleted
/// implementation silently collapsed its reciprocal to zero. Here the
/// ARTIFACT's floor is (a) nonzero, (b) byte-exact against the independent
/// reference, and (c) the reference price itself is certified against the
/// exact big-integer rational (dlmm_reference_price_certified_...), so the
/// chain artifact == reference == exact-rational is complete.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn negative_active_id_floors_are_exact_and_nonzero() {
    let mollusk = load_mollusk();
    let mut cases = 0usize;
    for (base_factor, bin_step, id) in [
        (10_000u16, 20u16, -1513i32), // real $PUMP shape
        (2_000, 125, -414),           // real JTO shape
        (5_000, 10, -1),
        (5_000, 10, -7),
        (5_000, 10, -100),
        (100, 1, -800),
        (100, 1, -1600),
        (20_000, 80, -350),
    ] {
        let price = ref_dlmm_price(bin_step, id).expect("representable negative-id price");
        certify_price(bin_step, id, price);
        for sol_is_x in [false, true] {
            let depth = 1_000_000_000_000u64; // 1000 SOL
            let venue = dlmm_ref(base_factor, 0, id, bin_step, sol_is_x, depth, 1_000_000);
            let num = base_factor as u128 * bin_step as u128 * 10;
            let cap = u64::try_from(depth as u128 * num / DLMM_FEE_DENOMINATOR).unwrap();
            let amount = (cap / 2).max(2);
            let expected =
                ref_floor_dlmm(base_factor, 0, bin_step, id, sol_is_x, depth, amount);
            let RefResult::Floor(expected_floor) = expected else {
                // A below-1.0 price with sol_is_x can floor to zero only for
                // dust amounts; cap/2 of 1000 SOL is never dust here.
                panic!("negative-id reference refused a healthy shape: bf={base_factor} bs={bin_step} id={id} sol_is_x={sol_is_x} -> {expected:?}");
            };
            assert!(expected_floor > 0);
            let measured = recover_floor(&mollusk, &venue, amount, "negative-id");
            assert_eq!(
                measured, expected_floor,
                "negative-id floor mismatch: bf={base_factor} bs={bin_step} id={id} sol_is_x={sol_is_x} amount={amount}"
            );
            cases += 1;
        }
    }
    println!("negative active_id: {cases} (shape, orientation) floors nonzero and exact");
}

// ===========================================================================
// 6. TARGETED LAYOUT-AUTHENTICATION refusals
// ===========================================================================

/// Every mutation of the account-identity surface must refuse with 6014 (bad
/// account data), never mis-price: wrong reference owner, wrong vault pins,
/// wrong fee source, wrong discriminators, truncation at every read edge,
/// sqrt_price zero.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn layout_authentication_refusals() {
    let mollusk = load_mollusk();
    let amount = 1_000_000u64;

    // -- DLMM ---------------------------------------------------------------
    let base = dlmm_ref(10_000, 0, -1513, 20, false, 1_000_000_000_000, 1_000_000);

    // Wrong reference owner (an unlisted program) falls through the venue
    // allow-list.
    let mut v = base.clone();
    v.reference.1.owner = Pubkey::new_from_array([0xEE; 32]);
    v.fee_source.1.owner = Pubkey::new_from_array([0xEE; 32]);
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "dlmm wrong owner");

    // Reserve pubkey mismatch (vault_a not named at 152..184).
    let mut v = base.clone();
    v.reference.1.data[152..184].copy_from_slice(&[0xED; 32]);
    v.fee_source = v.reference.clone();
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "dlmm reserve pin");

    // token_x/token_y neither orientation matches (target mint not named).
    let mut v = base.clone();
    v.reference.1.data[88..120].copy_from_slice(&[0xEC; 32]);
    v.fee_source = v.reference.clone();
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "dlmm mint pin");

    // fee_source must BE the pool.
    let mut v = base.clone();
    let decoy = (Pubkey::new_from_array([0xEB; 32]), v.reference.1.clone());
    v.fee_source = decoy;
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "dlmm fee source identity");

    // LbPair discriminator.
    let mut v = base.clone();
    v.reference.1.data[0] ^= 0xFF;
    v.fee_source = v.reference.clone();
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "dlmm discriminator");

    // Truncation at every read edge: 8 (disc), 76/80/82 (id/bin_step), 120/
    // 152/184/216 (mints/reserves), 35 (power byte), 10 (base_factor).
    for len in [0usize, 7, 9, 33, 75, 79, 81, 119, 151, 183, 215] {
        let mut v = base.clone();
        v.reference.1.data.truncate(len);
        v.fee_source = v.reference.clone();
        assert_eq!(
            run_single(&mollusk, &v.single(), amount, 1),
            REFERENCE_INVALID,
            "dlmm truncated to {len}"
        );
    }

    // SOL-side vault too short / wrong mint.
    let mut v = base.clone();
    v.vault_b.1.data.truncate(71);
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "dlmm short vault");

    // -- CLMM ---------------------------------------------------------------
    let base = clmm_ref(2_500, 83_589_253_752_498_556_957, true, 1_000_000_000_000, 1_000_000);

    let mut v = base.clone();
    v.reference.1.owner = Pubkey::new_from_array([0xEA; 32]);
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm wrong owner");

    // Vault pin mismatch.
    let mut v = base.clone();
    v.reference.1.data[137..169].copy_from_slice(&[0xE9; 32]);
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm vault pin");

    // Mint pin mismatch.
    let mut v = base.clone();
    v.reference.1.data[73..105].copy_from_slice(&[0xE8; 32]);
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm mint pin");

    // sqrt_price == 0.
    let mut v = base.clone();
    v.reference.1.data[253..269].fill(0);
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm sqrt zero");

    // fee_source not the pool's amm_config.
    let mut v = base.clone();
    let decoy_key = Pubkey::new_from_array([0xE7; 32]);
    v.fee_source.0 = decoy_key;
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm config identity");

    // fee_source with the right pubkey but not CLMM-owned.
    let mut v = base.clone();
    v.fee_source.1.owner = token::ID;
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm config owner");

    // AmmConfig discriminator.
    let mut v = base.clone();
    v.fee_source.1.data[0] ^= 0xFF;
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm config discriminator");

    // PoolState discriminator (the 2026-08-24 hardening, mirroring DLMM's
    // LbPair pin): a byte-flipped pool discriminator must refuse, never
    // mis-price.
    let mut v = base.clone();
    v.reference.1.data[0] ^= 0xFF;
    assert_eq!(run_single(&mollusk, &v.single(), amount, 1), REFERENCE_INVALID, "clmm pool discriminator");

    // Truncation at every read edge of the pool: 41 (config), 105/137
    // (mints), 169/201 (vaults), 269 (sqrt_price).
    for len in [0usize, 40, 104, 136, 168, 200, 252, 268] {
        let mut v = base.clone();
        v.reference.1.data.truncate(len);
        assert_eq!(
            run_single(&mollusk, &v.single(), amount, 1),
            REFERENCE_INVALID,
            "clmm truncated to {len}"
        );
    }
    // Truncated AmmConfig (below the 51-byte fee read).
    for len in [0usize, 7, 46, 50] {
        let mut v = base.clone();
        v.fee_source.1.data.truncate(len);
        assert_eq!(
            run_single(&mollusk, &v.single(), amount, 1),
            REFERENCE_INVALID,
            "clmm config truncated to {len}"
        );
    }
    println!("layout authentication: every identity mutation refused 6014");
}

// ===========================================================================
// 7. STRUCTURED CORRUPTION CAMPAIGN (both layouts, synthetic AND real bytes)
// ===========================================================================

/// Random byte flips, u64 splats, truncations, and owner swaps across the
/// reference, vaults, fee source, and target mint of DLMM and CLMM fixtures
/// (synthetic and genuine mainnet bytes alike). EVERY outcome must be a named
/// `BurnerError` — in the SBF VM a panic is an abort and an out-of-bounds
/// read is an access violation, so this is the no-abort property for every
/// read, multiply, shift, and divide in the two restored branches.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn corruption_campaign_dlmm_clmm_never_aborts() {
    let mollusk = load_mollusk();
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xC1);
    let iters = env_u64("VENUE_FUZZ_ITERS", 60_000);

    let real: [VenueRef; 4] =
        [real_dlmm_pump(), real_dlmm_jto(), real_clmm_pump(), real_clmm_jto()];

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

    let mut histogram: std::collections::BTreeMap<u32, u64> = std::collections::BTreeMap::new();
    for iteration in 0..iters {
        let mut venue = match rng.below(6) {
            0 => dlmm_ref(
                rng.next() as u16,
                rng.next() as u8,
                rng.next() as i32,
                rng.next() as u16,
                rng.below(2) == 0,
                extreme_u64(&mut rng),
                extreme_u64(&mut rng),
            ),
            1 => clmm_ref(
                rng.next() as u32,
                (rng.next() as u128) << rng.below(65) | rng.next() as u128,
                rng.below(2) == 0,
                extreme_u64(&mut rng),
                extreme_u64(&mut rng),
            ),
            n => real[(n - 2) as usize].clone(),
        };

        // Corrupt 0..8 fields across the five keyless-read accounts.
        let corruptions = rng.below(9);
        for _ in 0..corruptions {
            let victim = rng.below(5);
            let account = match victim {
                0 => &mut venue.reference.1,
                1 => &mut venue.vault_a.1,
                2 => &mut venue.vault_b.1,
                3 => &mut venue.fee_source.1,
                _ => &mut venue.target_mint.1,
            };
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
                    account.owner = match rng.below(6) {
                        0 => Pubkey::default(),
                        1 => Pubkey::new_from_array(METEORA_DLMM),
                        2 => Pubkey::new_from_array(RAYDIUM_CLMM),
                        3 => Pubkey::new_from_array(RAYDIUM_V4),
                        4 => token::ID,
                        _ => key(TOKEN_2022_PROGRAM),
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
        // Fee source of DLMM fixtures must track a corrupted reference when
        // they share a pubkey (they are the same account on chain).
        if venue.fee_source.0 == venue.reference.0 {
            venue.fee_source.1 = venue.reference.1.clone();
        }

        let amount = extreme_u64(&mut rng).max(1);
        let minimum = match rng.below(3) {
            0 => 0,
            1 => 1,
            _ => rng.next(),
        };
        let fixture = venue.single();
        // named_code inside run_single panics on any abort/unnamed outcome.
        let code = run_single(&mollusk, &fixture, amount, minimum);
        assert!(
            (6000..=6043).contains(&code),
            "iteration {iteration}: unnamed code {code} (seed {seed_value})"
        );
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!(
        "venue corruption campaign: {iters} iterations, every outcome a named BurnerError; \
         code distribution: {histogram:?}"
    );
}

// ===========================================================================
// 8. Inverse-branch range check (the `t << 64` guard the restore added)
// ===========================================================================

/// For the CLMM inverse orientation (target is token_0), a tiny sqrt_price
/// forces `t = (inp << 64) / sq` to 2^64 or above; the restored code must
/// REFUSE (6027) rather than silently truncate the shift (the deleted code's
/// bug, which derived a garbage near-zero floor). Note the refusal loses no
/// representable case, and this test PROVES that claim's boundary shape:
/// whenever `net >= sq` (the range-check trip), the true expected output is
/// `net * 2^128 / sq^2 > 2^64`, so even amounts just BELOW the trip refuse
/// 6027 — via the `expected > u64::MAX` guard rather than the shift guard.
/// Both sides of the boundary must agree with the independent reference, and
/// a genuinely representable inverse-orientation shape must floor exactly.
#[test]
#[ignore = "needs the keyless artifact; see the file header"]
fn clmm_inverse_branch_range_check_refuses_never_truncates() {
    let mollusk = load_mollusk();
    // sq chosen so that net == sq exactly at the boundary: t = net<<64/sq.
    let sq = 1_000_000u128; // price (sq/2^64)^2 ~ 2.9e-27: absurd but layout-legal
    let depth = u64::MAX / 2;
    let fee = 500_000u32; // cap = depth/2 so multi-million inputs are admitted
    let venue = clmm_ref(fee, sq, false, depth, 1_000_000);
    let fixture = venue.single();
    // net = amount/2; t >= 2^64 iff net >= sq, i.e. amount >= 2_000_000.
    for amount in [2_000_000u64, 2_000_001, 4_000_000_000_000_000_000, 1_999_999, 1_999_998] {
        let code = run_single(&mollusk, &fixture, amount, 1);
        assert_eq!(
            code, INVALID_INSTRUCTION_DATA,
            "unrepresentable inverse output must refuse 6027 at amount {amount}, never truncate"
        );
        assert_eq!(
            ref_floor_clmm(fee, sq, false, depth, amount),
            RefResult::Refuse(INVALID_INSTRUCTION_DATA),
            "reference must agree on the refusal at amount {amount}"
        );
    }
    // A representable inverse-orientation shape (sq ~ 1.5 * 2^64, price 2.25
    // token1 per token0, SOL = token1) must floor exactly.
    let sq = 3u128 << 63;
    let venue = clmm_ref(fee, sq, false, depth, 1_000_000);
    let amount = 2_000_000_000u64; // net = 1 SOL
    let expected = expect_floor(ref_floor_clmm(fee, sq, false, depth, amount), "clmm inverse");
    let measured = recover_floor(&mollusk, &venue, amount, "clmm inverse representable");
    assert_eq!(measured, expected, "representable inverse floor must be exact");
    println!("clmm inverse range check: both boundary sides refuse 6027, representable shape exact");
}
