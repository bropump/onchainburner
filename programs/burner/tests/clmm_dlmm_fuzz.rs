//! PRODUCTION-SCALE fuzz campaign for the RAYDIUM CLMM and METEORA DLMM
//! branches of `keyless_leg_floor`, executed against the REAL SBPFv3 keyless
//! artifact under Mollusk. Companion to `keyless_fuzz.rs` (which covers the
//! constant-product venues at this scale) and `venue_layout_artifact.rs`
//! (which pins exact boundaries and real-fixture floors at low volume).
//!
//! WHY THIS FILE EXISTS. The ~492k-case keyless campaign (FABLE-KEYLESS-FUZZ)
//! had ZERO coverage of these two venues: its own mutation battery planted a
//! `mul_q64` shift truncation (MUT-D) and MISSED it, explicitly because no
//! DLMM/CLMM fixture ever reached that code. These are the paths that held
//! two of the five shift-truncation bugs found in 2026-08, including the
//! reciprocal that silently returned price 0 for every pool priced below
//! 1.0 SOL (i.e. every negative `active_id`). This campaign puts the same
//! breadth on exactly those readers, and its differential asserts EXACT
//! refusal codes and byte-exact floors, which is what catches a silent
//! wrong-number defect (the class named-outcome fuzzing is structurally
//! blind to — proven by the prior campaign's MUT-B honesty finding).
//!
//! # The pass bar
//!
//! Every outcome must be a NAMED `Custom(6000..=6043)`. An abort
//! (`ProgramFailedToComplete`), an access violation, an unnamed
//! `InstructionError`, or a panic is a DEFECT — the harness panics with the
//! reproducing input and the seed. No route data is ever supplied, so a burn
//! can never succeed against these fixtures; `Ok` is also a finding.
//!
//! # Campaigns
//!   * `cd_arbitrary_instruction_data` — random/near-miss discriminators and
//!     random-or-structured split payloads over valid 1..4-leg fixtures whose
//!     legs include DLMM and CLMM references (incl. the real $PUMP/JTO pool
//!     shapes and both orientations).
//!   * `cd_structured_corruption` — structured corruption (byte flips,
//!     truncation at read edges, owner swaps, u64/u128 splats, targeted field
//!     splats of `active_id`/`bin_step`/`sqrt_price_x64`/`trade_fee_rate`)
//!     over synthetic multi-leg DLMM/CLMM fixtures AND the four snapshotted
//!     REAL mainnet pools (HbjY/GZcP DLMM, 45ss/JVoP CLMM).
//!   * `cd_reference_binding` — random launch/mints/weights with DLMM/CLMM
//!     references: any divergence between the presented reference set and the
//!     derivation lands on a different unfunded vault (6012); every bound
//!     vault is admitted past the 6012 pin.
//!   * `cd_exact_outcome_differential` — the campaign that catches silent
//!     wrong numbers. For every sampled shape an independent 128-bit model
//!     (ported from `venue_layout_artifact.rs`, longhand 256-bit multiply,
//!     refusal ordering matched to the artifact) predicts the EXACT outcome:
//!     a refusal code, or a floor F. A predicted refusal must reproduce that
//!     exact code; a predicted floor must be byte-exact (minimum_output=F
//!     admitted 6005, F-1 refused 6021). Includes deliberate boundary pinning
//!     (amount == cap and cap+1; depth == 50 SOL and 50 SOL - 1; negative
//!     `active_id` in force; `mul_q64`/reciprocal overflow shapes) plus an
//!     independent binary-search floor-recovery subset.
//!
//! # Build (fresh, current source — a stale .so silently invalidates results)
//!   export CARGO_TARGET_DIR=<scratch>/target
//!   tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf \
//!     --manifest-path programs/burner/Cargo.toml --arch v3 --tools-version v1.53 \
//!     --sbf-out-dir <scratch>/deploy --features keyless
//!   cp <scratch>/deploy/pinocchio_parity.so <scratch>/deploy/pinocchio_parity_keyless.so
//!
//! # Run
//!   BURNER_KEYLESS_ELF=<scratch>/deploy/pinocchio_parity_keyless.so \
//!   CD_FUZZ_ITERS=100000 CD_DIFF_ITERS=60000 CD_RECOVER_ITERS=500 \
//!   BURNER_FUZZ_SEED=20260825 \
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml --test clmm_dlmm_fuzz -- --ignored --nocapture

#![allow(clippy::type_complexity)]

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_program_option::COption,
    solana_pubkey::Pubkey,
    spl_token_interface::state::{Account as TokenAccount, AccountState, Mint},
    std::{collections::BTreeMap, fs, path::PathBuf, str::FromStr},
};

const BURNER_PROGRAM: &str = "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];

// Byte-for-byte the program-id constants in `keyless_leg_floor`
// (swap_and_burn.rs), pinned to their canonical base58 spellings by
// venue_layout_artifact.rs::program_id_constants_decode_to_canonical_pubkeys.
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
const PUMP_FUN_PROGRAM: [u8; 32] = [
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
    245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];
const PUMP_SWAP_PROGRAM: [u8; 32] = [
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86,
    213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
];

const DLMM_LB_PAIR_DISCRIMINATOR: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
const CLMM_POOL_STATE_DISCRIMINATOR: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
const CLMM_AMM_CONFIG_DISCRIMINATOR: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];

const KEYLESS_TOL_BPS: u128 = 100;
const DLMM_FEE_DENOMINATOR: u128 = 1_000_000_000;
const CLMM_FEE_DENOMINATOR: u128 = 1_000_000;
const MIN_REFERENCE_DEPTH_LAMPORTS: u64 = 50_000_000_000;
const RENT_FLOOR_ZERO_DATA: u64 = 890_880;

// Named codes referenced by the campaigns.
const ZERO_MINIMUM_OUTPUT: u32 = 6002;
/// Post-floor "admitted" sentinel. Under the merged keyless+directcurve build
/// an EMPTY route marks a leg as the curve leg (directcurve adapter), so the
/// admitted sentinel is no longer 6005. `probe` feeds a NON-EMPTY `route_probe`
/// carrying the leg's exact `in_amount` (a 1-leg fixture, so `in_amount ==
/// amount`), keeping an admitted leg on the JUPITER path and refusing at the
/// account-layout pin (6006). A wrong `in_amount` would be 6008 instead.
const FLOOR_ADMITTED: u32 = 6006;
const INVALID_BURN_PDA: u32 = 6012;
const SLIPPAGE_EXCEEDED: u32 = 6021;
const INVALID_INSTRUCTION_DATA: u32 = 6027;
const REFERENCE_INVALID: u32 = 6039;
const REFERENCE_CAP_EXCEEDED: u32 = 6040;
const REFERENCE_TOO_SHALLOW: u32 = 6041;

const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
const ROUTE_V2_PREFIX_LEN: usize = 34;
const ROUTE_V2_IN_AMOUNT_OFFSET: usize = 8;

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
fn raw_vault_account(owner_program: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    Account { lamports: 2_039_280, data, owner: owner_program, executable: false, rent_epoch: 0 }
}

// ---------------------------------------------------------------------------
// Deterministic RNG (SplitMix64): reproducible from the printed seed.
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
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            out.extend_from_slice(&self.next().to_le_bytes());
        }
        out.truncate(len);
        out
    }
    fn extreme_u64(&mut self) -> u64 {
        match self.below(7) {
            0 => 0,
            1 => 1,
            2 => self.below(1_000),
            3 => self.range(1_000, 10_000_000_000),
            4 => u64::MAX - self.below(1_000),
            5 => 1u64 << self.below(64),
            _ => self.next(),
        }
    }
    fn extreme_u128(&mut self) -> u128 {
        match self.below(6) {
            0 => 0,
            1 => 1,
            2 => self.next() as u128,
            3 => 1u128 << self.below(128),
            4 => u128::MAX - self.below(1_000) as u128,
            _ => ((self.next() as u128) << 64) | self.next() as u128,
        }
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn seed() -> u64 {
    std::env::var("BURNER_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(20_260_825)
}

// ---------------------------------------------------------------------------
// Mollusk + artifact identity guard (verbatim keyless_fuzz.rs)
// ---------------------------------------------------------------------------
fn artifact_path() -> PathBuf {
    if let Ok(path) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(path);
    }
    let deploy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy");
    let preferred = deploy.join("pinocchio_parity_keyless.so");
    if preferred.is_file() { preferred } else { deploy.join("pinocchio_parity.so") }
}

fn load_mollusk() -> Mollusk {
    let path = artifact_path();
    assert!(path.is_file(), "missing keyless ELF: {} (set BURNER_KEYLESS_ELF)", path.display());
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &key(BURNER_PROGRAM),
        &program::loader_keys::LOADER_V3,
        &fs::read(&path).expect("read keyless ELF"),
    );
    // Build identity: a reference-BOUND keyless build refuses the single-target
    // discriminator at dispatch (6027). A KMS or pre-binding build answers
    // 6004/6028 instead, so this uniquely pins the artifact under test.
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
        "artifact at {} is NOT a reference-bound keyless build (single-target not refused 6027)",
        path.display(),
    );
    mollusk
}

/// Named-outcome oracle: every result must be `Custom(6000..=6043)`.
fn assert_named(result: &Result<(), InstructionError>, ctx: &dyn Fn() -> String) -> u32 {
    match result {
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => *code,
        other => panic!("artifact produced a NON-NAMED outcome {other:?}\n{}", ctx()),
    }
}

// ---------------------------------------------------------------------------
// Venue reference leg blocks (7 accounts each): the exact keyless leg layout
//   [ target_mint(mut), target_ata(mut), token_program,
//     reference, vault_a, vault_b, fee_source ]
// ---------------------------------------------------------------------------
#[derive(Clone, Copy)]
enum Venue {
    RayV4 { rt: u64, rs: u64, num: u64, den: u64 },
    Dlmm {
        base_factor: u16,
        power: u8,
        active_id: i32,
        bin_step: u16,
        sol_is_x: bool,
        depth: u64,
        tok: u64,
    },
    Clmm { fee: u32, sq: u128, sol_is_0: bool, depth: u64, tok: u64 },
}

/// Collision-free deterministic leg-account key: byte 0 fixed marker 0x7A,
/// byte 1 the leg salt, byte 2 the role (same scheme as keyless_fuzz.rs).
fn leg_key(salt: u8, role: u8) -> Pubkey {
    let mut b = [0xCDu8; 32];
    b[0] = 0x7A;
    b[1] = salt;
    b[2] = role;
    Pubkey::new_from_array(b)
}

/// Synthetic LbPair bytes at the IDL-verified offsets (FABLE-CLMM-DLMM §2).
fn dlmm_pool_data(
    base_factor: u16,
    power: u8,
    active_id: i32,
    bin_step: u16,
    x_mint: &Pubkey,
    y_mint: &Pubkey,
    reserve_x: &Pubkey,
    reserve_y: &Pubkey,
) -> Vec<u8> {
    let mut pd = vec![0u8; 904];
    pd[0..8].copy_from_slice(&DLMM_LB_PAIR_DISCRIMINATOR);
    pd[8..10].copy_from_slice(&base_factor.to_le_bytes());
    pd[34] = power;
    pd[76..80].copy_from_slice(&active_id.to_le_bytes());
    pd[80..82].copy_from_slice(&bin_step.to_le_bytes());
    pd[88..120].copy_from_slice(x_mint.as_ref());
    pd[120..152].copy_from_slice(y_mint.as_ref());
    pd[152..184].copy_from_slice(reserve_x.as_ref());
    pd[184..216].copy_from_slice(reserve_y.as_ref());
    pd
}

/// Synthetic PoolState bytes. A nonzero LIQUIDITY DECOY is written at
/// 237..253 (the field adjacent to sqrt_price_x64) so an offset-shifted
/// sqrt_price read (253 -> 237, the MUT-S mutant and the venue_layout M2
/// class) reads a VALID-looking nonzero value and silently misprices instead
/// of trivially refusing — the harder catch, reachable only by the
/// differential.
fn clmm_pool_data(
    config: &Pubkey,
    mint0: &Pubkey,
    mint1: &Pubkey,
    vault0: &Pubkey,
    vault1: &Pubkey,
    sq: u128,
) -> Vec<u8> {
    let mut pd = vec![0u8; 1544];
    pd[0..8].copy_from_slice(&CLMM_POOL_STATE_DISCRIMINATOR);
    pd[9..41].copy_from_slice(config.as_ref());
    pd[73..105].copy_from_slice(mint0.as_ref());
    pd[105..137].copy_from_slice(mint1.as_ref());
    pd[137..169].copy_from_slice(vault0.as_ref());
    pd[169..201].copy_from_slice(vault1.as_ref());
    pd[237..253].copy_from_slice(&(sq.rotate_left(17) | 0x1234_5678).to_le_bytes()); // liquidity decoy
    pd[253..269].copy_from_slice(&sq.to_le_bytes());
    pd
}

fn clmm_config_data(trade_fee_rate: u32) -> Vec<u8> {
    let mut cd = vec![0u8; 117];
    cd[0..8].copy_from_slice(&CLMM_AMM_CONFIG_DISCRIMINATOR);
    // protocol_fee_rate decoy at the adjacent field (live mainnet value): a
    // 47 -> 43 shifted fee read lands on a VALID-looking fee.
    cd[43..47].copy_from_slice(&120_000u32.to_le_bytes());
    cd[47..51].copy_from_slice(&trade_fee_rate.to_le_bytes());
    cd
}

/// Build the 7 (meta, account) slots for one leg. Returns (slots, ref_seed,
/// mint). DLMM and CLMM bind by ADDRESS (non-Pump owners never use the
/// zero sentinel).
fn venue_leg(
    burn_pda: &Pubkey,
    venue: &Venue,
    salt: u8,
) -> (Vec<(AccountMeta, Account)>, [u8; 32], Pubkey) {
    let wsol = key(WSOL_MINT);
    let mint = leg_key(salt, 0);
    let target_ata = associated_token_address(burn_pda, &mint);
    let mint_supply: u64 = 1_000_000_000_000_000;

    let mut slots: Vec<(AccountMeta, Account)> = vec![
        (AccountMeta::new(mint, false), token::create_account_for_mint(immutable_mint(mint_supply, 6))),
        (
            AccountMeta::new(target_ata, false),
            token::create_account_for_token_account(token_account(mint, *burn_pda, 0, None)),
        ),
        (AccountMeta::new_readonly(token::ID, false), token::keyed_account().1),
    ];

    let (reference_pk, block): (Pubkey, [(AccountMeta, Account); 4]) = match venue {
        Venue::RayV4 { rt, rs, num, den } => {
            let pool = leg_key(salt, 5);
            let va = leg_key(salt, 6);
            let vb = leg_key(salt, 7);
            let auth = leg_key(salt, 8);
            let mut pd = vec![0u8; 400];
            pd[144..152].copy_from_slice(&num.to_le_bytes());
            pd[152..160].copy_from_slice(&den.to_le_bytes());
            pd[336..368].copy_from_slice(va.as_ref());
            pd[368..400].copy_from_slice(vb.as_ref());
            let pool_acct = Account { lamports: 6_124_800, data: pd, owner: Pubkey::new_from_array(RAYDIUM_V4), executable: false, rent_epoch: 0 };
            (
                pool,
                [
                    (AccountMeta::new_readonly(pool, false), pool_acct.clone()),
                    (AccountMeta::new_readonly(va, false), raw_vault_account(token::ID, &mint, &auth, *rt)),
                    (AccountMeta::new_readonly(vb, false), raw_vault_account(token::ID, &wsol, &auth, *rs)),
                    (AccountMeta::new_readonly(pool, false), pool_acct), // fee source == pool
                ],
            )
        }
        Venue::Dlmm { base_factor, power, active_id, bin_step, sol_is_x, depth, tok } => {
            let dlmm = Pubkey::new_from_array(METEORA_DLMM);
            let pool = leg_key(salt, 20);
            let rx = leg_key(salt, 21);
            let ry = leg_key(salt, 22);
            let (x_mint, y_mint) = if *sol_is_x { (wsol, mint) } else { (mint, wsol) };
            let (x_amount, y_amount) = if *sol_is_x { (*depth, *tok) } else { (*tok, *depth) };
            let pd = dlmm_pool_data(*base_factor, *power, *active_id, *bin_step, &x_mint, &y_mint, &rx, &ry);
            let pool_acct = Account { lamports: 7_182_720, data: pd, owner: dlmm, executable: false, rent_epoch: 0 };
            (
                pool,
                [
                    (AccountMeta::new_readonly(pool, false), pool_acct.clone()),
                    (AccountMeta::new_readonly(rx, false), raw_vault_account(token::ID, &x_mint, &pool, x_amount)),
                    (AccountMeta::new_readonly(ry, false), raw_vault_account(token::ID, &y_mint, &pool, y_amount)),
                    // DLMM stores its fee in the pool itself: fee_source == reference.
                    (AccountMeta::new_readonly(pool, false), pool_acct),
                ],
            )
        }
        Venue::Clmm { fee, sq, sol_is_0, depth, tok } => {
            let clmm = Pubkey::new_from_array(RAYDIUM_CLMM);
            let pool = leg_key(salt, 23);
            let v0 = leg_key(salt, 24);
            let v1 = leg_key(salt, 25);
            let cfg = leg_key(salt, 26);
            let (mint0, mint1) = if *sol_is_0 { (wsol, mint) } else { (mint, wsol) };
            let (amount0, amount1) = if *sol_is_0 { (*depth, *tok) } else { (*tok, *depth) };
            let pd = clmm_pool_data(&cfg, &mint0, &mint1, &v0, &v1, *sq);
            (
                pool,
                [
                    (
                        AccountMeta::new_readonly(pool, false),
                        Account { lamports: 11_644_800, data: pd, owner: clmm, executable: false, rent_epoch: 0 },
                    ),
                    (AccountMeta::new_readonly(v0, false), raw_vault_account(token::ID, &mint0, &pool, amount0)),
                    (AccountMeta::new_readonly(v1, false), raw_vault_account(token::ID, &mint1, &pool, amount1)),
                    (
                        AccountMeta::new_readonly(cfg, false),
                        Account { lamports: 1_704_240, data: clmm_config_data(*fee), owner: clmm, executable: false, rent_epoch: 0 },
                    ),
                ],
            )
        }
    };
    // Non-Pump owners bind by address (mirrors build_split_seeds).
    let seed = reference_pk.to_bytes();
    for s in block {
        slots.push(s);
    }
    (slots, seed, mint)
}

fn derive_split_pda(launch: &Pubkey, mints: &[Pubkey], weights: &[u16], refs: &[[u8; 32]]) -> Pubkey {
    let blob: Vec<u8> = weights.iter().flat_map(|w| w.to_le_bytes()).collect();
    let mut seeds: Vec<&[u8]> = vec![b"burner", launch.as_ref()];
    for m in mints {
        seeds.push(m.as_ref());
    }
    seeds.push(&blob);
    for r in refs {
        seeds.push(r.as_ref());
    }
    Pubkey::find_program_address(&seeds, &key(BURNER_PROGRAM)).0
}

struct Fixture {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    /// Victim indices in `accounts` for corruption (per-leg reference, mint,
    /// vaults, fee-source), collected across all legs.
    victims: Vec<usize>,
}

fn build_fixture(
    launch: &Pubkey,
    weights: &[u16],
    venues: &[Venue],
    total: u64,
    pda_override: Option<Pubkey>,
) -> Fixture {
    let caller = Pubkey::new_from_array([0x30; 32]);
    let quote_slot = Pubkey::new_from_array([0x31; 32]);
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);

    let placeholder = Pubkey::new_from_array([0xFE; 32]);
    let mut mints = Vec::new();
    let mut ref_seeds = Vec::new();
    for (i, v) in venues.iter().enumerate() {
        let (_slots, seed, mint) = venue_leg(&placeholder, v, i as u8);
        mints.push(mint);
        ref_seeds.push(seed);
    }
    let burn_pda = pda_override.unwrap_or_else(|| derive_split_pda(launch, &mints, weights, &ref_seeds));
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
        (burn_pda, system_account(total.saturating_add(RENT_FLOOR_ZERO_DATA))),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(wsol, burn_pda, 0, Some(RENT_FLOOR_ZERO_DATA))),
        ),
        (*launch, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
    ];

    let mut victims = Vec::new();
    for (i, v) in venues.iter().enumerate() {
        let (slots, _seed, _mint) = venue_leg(&burn_pda, v, i as u8);
        for (j, (meta, account)) in slots.into_iter().enumerate() {
            // j: 0 mint, 1 ata, 2 tokprog, 3 reference, 4 vault_a, 5 vault_b, 6 fee
            metas.push(meta);
            let pk = metas.last().unwrap().pubkey;
            if !accounts.iter().any(|(k, _)| *k == pk) {
                accounts.push((pk, account));
                if matches!(j, 0 | 3 | 4 | 5 | 6) {
                    victims.push(accounts.len() - 1);
                }
            }
        }
    }
    Fixture { metas, accounts, victims }
}

fn split_data(total: u64, weights: &[u16], minimums: &[u64]) -> Vec<u8> {
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for (i, w) in weights.iter().enumerate() {
        data.extend_from_slice(&w.to_le_bytes());
        data.extend_from_slice(&minimums[i].to_le_bytes());
        data.push(0);
        data.extend_from_slice(&0u32.to_le_bytes());
    }
    data
}

fn run(mollusk: &Mollusk, fixture: &Fixture, data: Vec<u8>, ctx: &dyn Fn() -> String) -> u32 {
    let ix = Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&ix, &fixture.accounts);
    assert_named(&result.raw_result, ctx)
}

fn random_weights(rng: &mut Rng) -> Vec<u16> {
    let legs = 1 + rng.below(4) as usize;
    if legs == 1 {
        return vec![10_000];
    }
    let mut cuts = std::collections::BTreeSet::new();
    while cuts.len() < legs - 1 {
        cuts.insert(1 + rng.below(9_999) as u16);
    }
    let mut bounds = vec![0u16];
    bounds.extend(cuts);
    bounds.push(10_000);
    bounds.windows(2).map(|w| w[1] - w[0]).collect()
}

// Deep, admissible shapes (used where a leg must survive to the floor stage).
fn deep_dlmm(rng: &mut Rng) -> Venue {
    Venue::Dlmm {
        base_factor: 10_000,
        power: 0,
        active_id: -(rng.range(1, 3_000) as i32),
        bin_step: [10u16, 20, 25, 100, 125][rng.below(5) as usize],
        sol_is_x: rng.below(2) == 0,
        depth: rng.range(MIN_REFERENCE_DEPTH_LAMPORTS, 20_000_000_000_000),
        tok: 1_000_000_000_000,
    }
}
fn deep_clmm(rng: &mut Rng) -> Venue {
    Venue::Clmm {
        fee: [100u32, 1_000, 2_500, 10_000][rng.below(4) as usize],
        sq: 83_589_253_752_498_556_957 + rng.next() as u128 % (1u128 << 40),
        sol_is_0: rng.below(2) == 0,
        depth: rng.range(MIN_REFERENCE_DEPTH_LAMPORTS, 20_000_000_000_000),
        tok: 1_000_000_000_000,
    }
}

fn random_venue(rng: &mut Rng) -> Venue {
    match rng.below(8) {
        0 => Venue::RayV4 { rt: rng.extreme_u64(), rs: rng.extreme_u64(), num: rng.below(20_001), den: rng.below(20_001) },
        1 | 2 | 3 => Venue::Dlmm {
            base_factor: rng.next() as u16,
            power: rng.next() as u8,
            active_id: rng.next() as u32 as i32,
            bin_step: rng.next() as u16,
            sol_is_x: rng.below(2) == 0,
            depth: rng.extreme_u64(),
            tok: rng.extreme_u64(),
        },
        4 | 5 | 6 => Venue::Clmm {
            fee: rng.next() as u32,
            sq: rng.extreme_u128(),
            sol_is_0: rng.below(2) == 0,
            depth: rng.extreme_u64(),
            tok: rng.extreme_u64(),
        },
        _ => {
            if rng.below(2) == 0 { deep_dlmm(rng) } else { deep_clmm(rng) }
        }
    }
}

// ---------------------------------------------------------------------------
// REAL mainnet pool fixtures (bytes snapshotted 2026-08-24 under
// tests/venue-fixtures/; same loaders as venue_layout_artifact.rs) and a
// one-leg fixture builder around them for the corruption campaign.
// ---------------------------------------------------------------------------
const PUMP_MINT: &str = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const JTO_MINT: &str = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const DLMM_PROGRAM_B58: &str = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const CLMM_PROGRAM_B58: &str = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const SPL_TOKEN_B58: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

#[derive(Clone)]
struct VenueRef {
    target_mint: (Pubkey, Account),
    reference: (Pubkey, Account),
    vault_a: (Pubkey, Account),
    vault_b: (Pubkey, Account),
    fee_source: (Pubkey, Account),
}

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

fn real_pools() -> [VenueRef; 4] {
    let dlmm_pump_pool = key("HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh");
    let dlmm_pump = fixture_account("dlmm_pump_pool", DLMM_PROGRAM_B58);
    let dlmm_jto_pool = key("GZcP3ANuTD15ZrYaF1RacomBKXVCCKvXYyWVDaEDqkKi");
    let dlmm_jto = fixture_account("dlmm_jto_pool", DLMM_PROGRAM_B58);
    [
        VenueRef {
            target_mint: (
                key(PUMP_MINT),
                token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6)),
            ),
            reference: (dlmm_pump_pool, dlmm_pump.clone()),
            vault_a: (
                key("5uXsebqNi3jDBvHvLJUuLqouUEHyQNDZcREHpLSwCZpM"),
                fixture_account("dlmm_pump_reserve_x", TOKEN_2022_PROGRAM),
            ),
            vault_b: (
                key("CD1RxU49jNwxD7LvRvrdWDNLpx5ZrJ7khMEzTNudk94s"),
                fixture_account("dlmm_pump_reserve_y", SPL_TOKEN_B58),
            ),
            fee_source: (dlmm_pump_pool, dlmm_pump),
        },
        VenueRef {
            target_mint: (
                key(JTO_MINT),
                token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 9)),
            ),
            reference: (dlmm_jto_pool, dlmm_jto.clone()),
            vault_a: (
                key("7wcgaGAD8yvtzC6rbAg4DLg33JaFaRq8v14xEF8b77yA"),
                fixture_account("dlmm_jto_reserve_x", SPL_TOKEN_B58),
            ),
            vault_b: (
                key("EEgZMC6z6jCP88dmgMem5dRB7YhLAH37A333nvFfVKwt"),
                fixture_account("dlmm_jto_reserve_y", SPL_TOKEN_B58),
            ),
            fee_source: (dlmm_jto_pool, dlmm_jto),
        },
        VenueRef {
            target_mint: (
                key(PUMP_MINT),
                token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 6)),
            ),
            reference: (
                key("45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5"),
                fixture_account("clmm_pump_pool", CLMM_PROGRAM_B58),
            ),
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
        },
        VenueRef {
            target_mint: (
                key(JTO_MINT),
                token::create_account_for_mint(immutable_mint(1_000_000_000_000_000, 9)),
            ),
            reference: (
                key("JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo"),
                fixture_account("clmm_jto_pool", CLMM_PROGRAM_B58),
            ),
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
        },
    ]
}

/// One-leg fixture around an arbitrary `VenueRef` (real pool bytes), vault
/// derived WITH the reference's address seed. Victim indices returned cover
/// mint / reference / vault_a / vault_b / fee_source.
fn build_real_fixture(venue: &VenueRef, total: u64) -> Fixture {
    let launch = Pubkey::new_from_array([0x40; 32]);
    let mint = venue.target_mint.0;
    let weights = [10_000u16];
    let burn_pda =
        derive_split_pda(&launch, &[mint], &weights, &[venue.reference.0.to_bytes()]);
    let caller = Pubkey::new_from_array([0x30; 32]);
    let quote_slot = Pubkey::new_from_array([0x31; 32]);
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);
    let ata = associated_token_address(&burn_pda, &mint);

    let metas = vec![
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
        (burn_pda, system_account(total.saturating_add(RENT_FLOOR_ZERO_DATA))),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(wsol, burn_pda, 0, Some(RENT_FLOOR_ZERO_DATA))),
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
    let mut victims = vec![8, 10, 11, 12];
    if !accounts.iter().any(|(pk, _)| *pk == venue.fee_source.0) {
        accounts.push(venue.fee_source.clone());
        victims.push(accounts.len() - 1);
    }
    Fixture { metas, accounts, victims }
}

// ---------------------------------------------------------------------------
// Independent 128-bit reference model (ported from venue_layout_artifact.rs:
// longhand 256-bit multiply structurally unlike the artifact's decomposition;
// refusal ordering matched to the artifact, INCLUDING the depth gate's
// placement after the expected-output computation).
// ---------------------------------------------------------------------------

/// floor((a*b) / 2^64), None when the result exceeds u128.
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
        return None;
    }
    Some(((r2 as u128) << 64) | r1 as u128)
}

/// Q64.64 bin price (1 + bin_step/10_000)^active_id with the
/// exact-reciprocal negative branch.
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
        let recip = if u128::MAX % result == result - 1 { q.checked_add(1)? } else { q };
        if recip == 0 {
            return None;
        }
        return Some(recip);
    }
    Some(result)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum RefOutcome {
    Refuse(u32),
    Floor(u64),
}

fn ref_floor_from_expected(expected: u128) -> RefOutcome {
    if expected == 0 {
        return RefOutcome::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    if expected > u64::MAX as u128 {
        return RefOutcome::Refuse(INVALID_INSTRUCTION_DATA);
    }
    let floor = expected * (10_000 - KEYLESS_TOL_BPS) / 10_000;
    if floor == 0 {
        return RefOutcome::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    RefOutcome::Floor(floor as u64)
}

/// The complete DLMM floor pipeline in independent arithmetic. Refusal
/// ordering mirrors the artifact exactly: price FIRST (6027 on Q64.64 range
/// exhaustion), then fee validity (6039), cap (6040), net (6002), spot
/// conversion (6027), depth gate (6041), final floor (6002/6027).
fn ref_floor_dlmm(
    base_factor: u16,
    power: u8,
    bin_step: u16,
    active_id: i32,
    sol_is_x: bool,
    depth: u64,
    amount: u64,
) -> RefOutcome {
    let Some(price) = ref_dlmm_price(bin_step, active_id) else {
        return RefOutcome::Refuse(INVALID_INSTRUCTION_DATA);
    };
    let Some(scale) = 10u64.checked_pow(power as u32) else {
        return RefOutcome::Refuse(REFERENCE_INVALID);
    };
    let num = (base_factor as u64)
        .checked_mul(bin_step as u64)
        .and_then(|v| v.checked_mul(10))
        .and_then(|v| v.checked_mul(scale));
    let Some(num) = num else { return RefOutcome::Refuse(REFERENCE_INVALID) };
    if num == 0 || num as u128 >= DLMM_FEE_DENOMINATOR {
        return RefOutcome::Refuse(REFERENCE_INVALID);
    }
    let cap = depth as u128 * num as u128 / DLMM_FEE_DENOMINATOR;
    if amount as u128 > cap {
        return RefOutcome::Refuse(REFERENCE_CAP_EXCEEDED);
    }
    let net = amount as u128 * (DLMM_FEE_DENOMINATOR - num as u128) / DLMM_FEE_DENOMINATOR;
    if net == 0 {
        return RefOutcome::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    let expected = if sol_is_x {
        match ref_mul_q64(net, price) {
            Some(e) => e,
            None => return RefOutcome::Refuse(INVALID_INSTRUCTION_DATA),
        }
    } else {
        (net << 64) / price
    };
    if depth < MIN_REFERENCE_DEPTH_LAMPORTS {
        return RefOutcome::Refuse(REFERENCE_TOO_SHALLOW);
    }
    ref_floor_from_expected(expected)
}

/// The complete CLMM floor pipeline in independent arithmetic; ordering
/// mirrors the artifact (sq==0 -> 6039, fee -> 6039, cap -> 6040, net ->
/// 6002, spot -> 6027, depth gate -> 6041, floor -> 6002/6027).
fn ref_floor_clmm(
    trade_fee_rate: u32,
    sq: u128,
    sol_is_0: bool,
    depth: u64,
    amount: u64,
) -> RefOutcome {
    if sq == 0 {
        return RefOutcome::Refuse(REFERENCE_INVALID);
    }
    let num = trade_fee_rate as u128;
    if num == 0 || num >= CLMM_FEE_DENOMINATOR {
        return RefOutcome::Refuse(REFERENCE_INVALID);
    }
    let cap = depth as u128 * num / CLMM_FEE_DENOMINATOR;
    if amount as u128 > cap {
        return RefOutcome::Refuse(REFERENCE_CAP_EXCEEDED);
    }
    let net = amount as u128 * (CLMM_FEE_DENOMINATOR - num) / CLMM_FEE_DENOMINATOR;
    if net == 0 {
        return RefOutcome::Refuse(ZERO_MINIMUM_OUTPUT);
    }
    let expected = if sol_is_0 {
        let t = match net.checked_mul(sq) {
            Some(t) => t >> 64,
            None => return RefOutcome::Refuse(INVALID_INSTRUCTION_DATA),
        };
        match t.checked_mul(sq) {
            Some(e) => e >> 64,
            None => return RefOutcome::Refuse(INVALID_INSTRUCTION_DATA),
        }
    } else {
        let t = (net << 64) / sq;
        if t >> 64 != 0 {
            return RefOutcome::Refuse(INVALID_INSTRUCTION_DATA);
        }
        (t << 64) / sq
    };
    if depth < MIN_REFERENCE_DEPTH_LAMPORTS {
        return RefOutcome::Refuse(REFERENCE_TOO_SHALLOW);
    }
    ref_floor_from_expected(expected)
}

fn model_outcome(venue: &Venue, amount: u64) -> Option<RefOutcome> {
    match venue {
        Venue::Dlmm { base_factor, power, active_id, bin_step, sol_is_x, depth, .. } => Some(
            ref_floor_dlmm(*base_factor, *power, *bin_step, *active_id, *sol_is_x, *depth, amount),
        ),
        Venue::Clmm { fee, sq, sol_is_0, depth, .. } => {
            Some(ref_floor_clmm(*fee, *sq, *sol_is_0, *depth, amount))
        }
        Venue::RayV4 { .. } => None,
    }
}

/// The model-computed input cap for a shape whose fee parses, used by the
/// boundary-pinning sampler. None when the fee itself refuses.
fn model_cap(venue: &Venue) -> Option<u64> {
    match venue {
        Venue::Dlmm { base_factor, power, bin_step, depth, .. } => {
            let scale = 10u64.checked_pow(*power as u32)?;
            let num = (*base_factor as u64)
                .checked_mul(*bin_step as u64)
                .and_then(|v| v.checked_mul(10))
                .and_then(|v| v.checked_mul(scale))?;
            if num == 0 || num as u128 >= DLMM_FEE_DENOMINATOR {
                return None;
            }
            Some((*depth as u128 * num as u128 / DLMM_FEE_DENOMINATOR).min(u64::MAX as u128) as u64)
        }
        Venue::Clmm { fee, depth, .. } => {
            let num = *fee as u128;
            if num == 0 || num >= CLMM_FEE_DENOMINATOR {
                return None;
            }
            Some((*depth as u128 * num / CLMM_FEE_DENOMINATOR).min(u64::MAX as u128) as u64)
        }
        Venue::RayV4 { .. } => None,
    }
}

// ===========================================================================
// CAMPAIGN CD-A — arbitrary split instruction data over CLMM/DLMM fixtures
// ===========================================================================
#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn cd_arbitrary_instruction_data() {
    let mollusk = load_mollusk();
    let iters = env_u64("CD_FUZZ_ITERS", 20_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xE1);
    println!("cd_arbitrary_instruction_data: seed {seed_value}, {iters} iterations");

    let launch = Pubkey::new_from_array([0x40; 32]);
    // Valid deep account fixtures at 1..4 legs, every one carrying at least
    // one DLMM or CLMM leg (the real $PUMP/JTO pool shapes among them), so
    // arbitrary DATA is adjudicated against the venue readers under test.
    let shapes: Vec<(Vec<u16>, Vec<Venue>)> = vec![
        (vec![10_000], vec![Venue::Dlmm {
            base_factor: 10_000, power: 0, active_id: -1513, bin_step: 20,
            sol_is_x: false, depth: 12_179_070_000_000, tok: 250_000_000_000_000,
        }]),
        (vec![10_000], vec![Venue::Clmm {
            fee: 1_000, sq: 83_589_253_752_498_556_957, sol_is_0: true,
            depth: 4_600_000_000_000, tok: 95_000_000_000_000,
        }]),
        (vec![5_000, 5_000], vec![
            Venue::Dlmm {
                base_factor: 2_000, power: 0, active_id: -414, bin_step: 125,
                sol_is_x: false, depth: 60_000_000_000, tok: 4_000_000_000_000,
            },
            Venue::Clmm {
                fee: 10_000, sq: 241_583_840_018_074_934_333, sol_is_0: true,
                depth: 168_000_000_000, tok: 29_000_000_000_000,
            },
        ]),
        (vec![8_000, 1_000, 1_000], vec![
            Venue::Clmm { fee: 2_500, sq: 3u128 << 63, sol_is_0: false, depth: 100_000_000_000, tok: 1_000_000_000_000 },
            Venue::Dlmm { base_factor: 5_000, power: 0, active_id: 800, bin_step: 10, sol_is_x: true, depth: 90_000_000_000, tok: 2_000_000_000_000 },
            Venue::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 },
        ]),
        (vec![2_500, 2_500, 2_500, 2_500], vec![
            Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -1513, bin_step: 20, sol_is_x: false, depth: 12_179_070_000_000, tok: 250_000_000_000_000 },
            Venue::Clmm { fee: 1_000, sq: 83_589_253_752_498_556_957, sol_is_0: true, depth: 4_600_000_000_000, tok: 95_000_000_000_000 },
            Venue::Dlmm { base_factor: 2_000, power: 0, active_id: 414, bin_step: 125, sol_is_x: true, depth: 168_000_000_000, tok: 4_000_000_000_000 },
            Venue::Clmm { fee: 10_000, sq: 241_583_840_018_074_934_333, sol_is_0: false, depth: 168_000_000_000, tok: 29_000_000_000_000 },
        ]),
    ];
    let fixtures: Vec<Fixture> = shapes
        .iter()
        .map(|(w, v)| build_fixture(&launch, w, v, 10_000_000_000, None))
        .collect();

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let fixture = &fixtures[rng.below(fixtures.len() as u64) as usize];
        let mut data = match rng.below(8) {
            0 | 1 | 2 | 3 => SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec(),
            4 => SWAP_AND_BURN_DISCRIMINATOR.to_vec(),
            5 => VALIDATE_CONFIG_DISCRIMINATOR.to_vec(),
            6 => {
                let mut d = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
                d[rng.below(8) as usize] ^= 1 << rng.below(8);
                d
            }
            _ => rng.bytes(8),
        };
        match rng.below(4) {
            0 => {
                let tail = rng.below(600) as usize;
                let bytes = rng.bytes(tail);
                data.extend_from_slice(&bytes);
            }
            _ => {
                let total = rng.extreme_u64();
                data.extend_from_slice(&total.to_le_bytes());
                let declared: u32 = match rng.below(8) {
                    0 => 0,
                    1 => 5,
                    2 => u32::MAX,
                    3 => rng.next() as u32,
                    _ => 1 + rng.below(4) as u32,
                };
                data.extend_from_slice(&declared.to_le_bytes());
                let legs = rng.below(6) as usize;
                for _ in 0..legs {
                    let bps: u16 = match rng.below(4) {
                        0 => 0,
                        1 => rng.next() as u16,
                        _ => 1 + rng.below(9_999) as u16,
                    };
                    data.extend_from_slice(&bps.to_le_bytes());
                    let minimum: u64 = if rng.below(4) == 0 { 0 } else { rng.next() };
                    data.extend_from_slice(&minimum.to_le_bytes());
                    data.push(if rng.below(4) == 0 { rng.next() as u8 } else { 0 });
                    let route_len = rng.below(40) as usize;
                    let route = rng.bytes(route_len);
                    let declared_len: u32 = match rng.below(6) {
                        0 => u32::MAX,
                        1 => rng.next() as u32,
                        2 => route.len() as u32 + 1,
                        _ => route.len() as u32,
                    };
                    data.extend_from_slice(&declared_len.to_le_bytes());
                    data.extend_from_slice(&route);
                }
                if rng.below(6) == 0 {
                    let extra_len = 1 + rng.below(6) as usize;
                    let extra = rng.bytes(extra_len);
                    data.extend_from_slice(&extra);
                }
            }
        }
        if rng.below(16) == 0 {
            let keep = rng.below(data.len() as u64 + 1) as usize;
            data.truncate(keep);
        }
        // validate_config on its exact valid shape may return Ok; everything
        // else must be named. These fixtures never present validate_config's
        // account layout, so Ok remains a finding here.
        let code = run(&mollusk, fixture, data.clone(), &|| {
            format!("CD-A: seed {seed_value} iter {iteration} data {}", hex(&data))
        });
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!("CD-A ok: {iters} arbitrary-data runs, all named. distribution {histogram:?}");
}

// ===========================================================================
// CAMPAIGN CD-B — structured corruption of LbPair / PoolState / AmmConfig
// (synthetic multi-leg AND real mainnet bytes)
// ===========================================================================
#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn cd_structured_corruption() {
    let mollusk = load_mollusk();
    let iters = env_u64("CD_FUZZ_ITERS", 20_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xE2);
    println!("cd_structured_corruption: seed {seed_value}, {iters} iterations");

    let launch = Pubkey::new_from_array([0x41; 32]);
    let real = real_pools();
    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    let mut real_runs = 0u64;
    for iteration in 0..iters {
        // 25% of iterations corrupt REAL mainnet pool bytes (one leg); the
        // rest corrupt synthetic multi-leg mixed-venue fixtures.
        let use_real = rng.below(4) == 0;
        let (mut fixture, weights, total) = if use_real {
            real_runs += 1;
            let venue = &real[rng.below(4) as usize];
            let total = rng.extreme_u64().max(1);
            (build_real_fixture(venue, total), vec![10_000u16], total)
        } else {
            let weights = random_weights(&mut rng);
            let venues: Vec<Venue> = weights.iter().map(|_| random_venue(&mut rng)).collect();
            let total = rng.extreme_u64().max(1);
            (build_fixture(&launch, &weights, &venues, total, None), weights, total)
        };

        let corruptions = rng.below(9);
        for _ in 0..corruptions {
            if fixture.victims.is_empty() {
                break;
            }
            let victim = fixture.victims[rng.below(fixture.victims.len() as u64) as usize];
            let account = &mut fixture.accounts[victim].1;
            match rng.below(6) {
                0 if !account.data.is_empty() => {
                    let at = rng.below(account.data.len() as u64) as usize;
                    account.data[at] ^= 1 << rng.below(8);
                }
                1 => {
                    let new_len = rng.below(account.data.len() as u64 + 1) as usize;
                    account.data.truncate(new_len);
                }
                2 => {
                    account.owner = match rng.below(7) {
                        0 => Pubkey::default(),
                        1 => Pubkey::new_from_array(METEORA_DLMM),
                        2 => Pubkey::new_from_array(RAYDIUM_CLMM),
                        3 => Pubkey::new_from_array(RAYDIUM_V4),
                        4 => Pubkey::new_from_array(PUMP_FUN_PROGRAM),
                        5 => Pubkey::new_from_array(PUMP_SWAP_PROGRAM),
                        _ => token::ID,
                    };
                }
                3 => {
                    if account.data.len() >= 8 {
                        let at = rng.below(account.data.len() as u64 - 7) as usize;
                        let v = rng.extreme_u64();
                        account.data[at..at + 8].copy_from_slice(&v.to_le_bytes());
                    }
                }
                4 => {
                    // Targeted field splats at the exact offsets the two
                    // branches read (only meaningful on pool-sized victims;
                    // harmless byte noise elsewhere).
                    let d = &mut account.data;
                    match rng.below(6) {
                        0 if d.len() >= 82 => {
                            let id = rng.next() as u32 as i32;
                            d[76..80].copy_from_slice(&id.to_le_bytes());
                        }
                        1 if d.len() >= 82 => {
                            let bs = rng.next() as u16;
                            d[80..82].copy_from_slice(&bs.to_le_bytes());
                        }
                        2 if d.len() >= 269 => {
                            let sq = rng.extreme_u128();
                            d[253..269].copy_from_slice(&sq.to_le_bytes());
                        }
                        3 if d.len() >= 51 => {
                            let fee = rng.next() as u32;
                            d[47..51].copy_from_slice(&fee.to_le_bytes());
                        }
                        4 if d.len() >= 10 => {
                            let bf = rng.next() as u16;
                            d[8..10].copy_from_slice(&bf.to_le_bytes());
                        }
                        _ if d.len() >= 35 => {
                            d[34] = rng.next() as u8;
                        }
                        _ => {}
                    }
                }
                _ => {
                    if !account.data.is_empty() {
                        // u128 splat across a random 16-byte window.
                        if account.data.len() >= 16 {
                            let at = rng.below(account.data.len() as u64 - 15) as usize;
                            let v = rng.extreme_u128();
                            account.data[at..at + 16].copy_from_slice(&v.to_le_bytes());
                        }
                    }
                }
            }
        }

        let minimums: Vec<u64> = weights
            .iter()
            .map(|_| match rng.below(3) {
                0 => 0,
                1 => 1,
                _ => rng.next(),
            })
            .collect();
        let data = split_data(total, &weights, &minimums);
        let code = run(&mollusk, &fixture, data, &|| {
            format!(
                "CD-B: seed {seed_value} iter {iteration} real {use_real} weights {weights:?} total {total}"
            )
        });
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!(
        "CD-B ok: {iters} corruption runs ({real_runs} over real mainnet bytes), all named. \
         distribution {histogram:?}"
    );
}

// ===========================================================================
// CAMPAIGN CD-C — reference binding with CLMM/DLMM references
// ===========================================================================
#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn cd_reference_binding() {
    let mollusk = load_mollusk();
    let iters = env_u64("CD_FUZZ_ITERS", 20_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xE3);
    println!("cd_reference_binding: seed {seed_value}, {iters} iterations");

    let launch = Pubkey::new_from_array([0x42; 32]);
    let mut mismatched_6012 = 0u64;
    let mut matched_named = 0u64;
    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let weights = random_weights(&mut rng);
        // Deep admissible DLMM/CLMM references, so a MATCHING derivation
        // reaches the floor stage rather than failing on account shape.
        let venues: Vec<Venue> = weights
            .iter()
            .map(|_| if rng.below(2) == 0 { deep_dlmm(&mut rng) } else { deep_clmm(&mut rng) })
            .collect();

        let placeholder = Pubkey::new_from_array([0xFE; 32]);
        let mut mints = Vec::new();
        let mut ref_seeds = Vec::new();
        for (i, v) in venues.iter().enumerate() {
            let (_s, seed_, mint) = venue_leg(&placeholder, v, i as u8);
            mints.push(mint);
            ref_seeds.push(seed_);
        }
        let bound = derive_split_pda(&launch, &mints, &weights, &ref_seeds);

        let perturb = rng.below(4) != 0; // 75% mismatched
        let pda = if !perturb {
            bound
        } else {
            let mut m_mints = mints.clone();
            let mut m_weights = weights.clone();
            let mut m_refs = ref_seeds.clone();
            let mut m_launch = launch;
            match rng.below(6) {
                0 => { let i = rng.below(m_mints.len() as u64) as usize; m_mints[i] = Pubkey::new_from_array([rng.next() as u8; 32]); }
                1 if m_weights.len() >= 2 => { m_weights[0] += 1; m_weights[1] -= 1; }
                1 => { m_weights[0] = m_weights[0].wrapping_add(1); }
                2 => { let i = rng.below(m_refs.len() as u64) as usize; m_refs[i][0] ^= 1; }
                3 => { m_launch = Pubkey::new_from_array([rng.next() as u8; 32]); }
                4 => {
                    // Substitute a DIFFERENT reference address wholesale for
                    // one leg: address-bound venues must land elsewhere.
                    let i = rng.below(m_refs.len() as u64) as usize;
                    m_refs[i] = Pubkey::new_from_array([rng.next() as u8; 32]).to_bytes();
                }
                _ => { if m_mints.len() > 1 { m_mints.pop(); m_weights = vec![10_000]; m_refs.truncate(1); } else { m_mints[0] = Pubkey::new_from_array([rng.next() as u8; 32]); } }
            }
            let p = derive_split_pda(&m_launch, &m_mints, &m_weights, &m_refs);
            if p == bound { bound } else { p }
        };

        let total = rng.range(1_000_000, 1_000_000_000);
        let fixture = build_fixture(&launch, &weights, &venues, total, Some(pda));
        let minimums: Vec<u64> = weights.iter().map(|_| 1u64).collect();
        let data = split_data(total, &weights, &minimums);
        let code = run(&mollusk, &fixture, data, &|| {
            format!("CD-C: seed {seed_value} iter {iteration} weights {weights:?} perturb {perturb}")
        });
        *histogram.entry(code).or_insert(0) += 1;
        if pda != bound {
            assert_eq!(
                code, INVALID_BURN_PDA,
                "CD-C: a divergent reference set must land on a different unfunded vault (6012); \
                 got {code} (seed {seed_value} iter {iteration} weights {weights:?})"
            );
            mismatched_6012 += 1;
        } else {
            assert_ne!(
                code, INVALID_BURN_PDA,
                "CD-C: the correctly-bound vault must be admitted, not 6012 \
                 (seed {seed_value} iter {iteration} weights {weights:?})"
            );
            matched_named += 1;
        }
    }
    println!(
        "CD-C ok: {iters} binding runs. {mismatched_6012} divergent->6012, {matched_named} bound->admitted. \
         distribution {histogram:?}"
    );
}

// ===========================================================================
// CAMPAIGN CD-D — exact-outcome differential vs the independent 128-bit model
// ===========================================================================

/// A `route_v2` payload whose embedded `in_amount` is `guess`, zero fees, no
/// route accounts. On an admitted 1-leg fixture, `guess == amount` reaches the
/// account-layout pin (6006); any other value is 6008.
fn route_probe(guess: u64) -> Vec<u8> {
    let mut d = vec![0u8; ROUTE_V2_PREFIX_LEN];
    d[..8].copy_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
    d[ROUTE_V2_IN_AMOUNT_OFFSET..ROUTE_V2_IN_AMOUNT_OFFSET + 8].copy_from_slice(&guess.to_le_bytes());
    d
}

/// One-leg split data carrying a non-empty `route_probe(in_amount)` on the
/// sole leg (route_account_count stays 0). Keeps an admitted leg on the
/// Jupiter path so the sentinel is 6006, not the curve-adapter path.
fn split_data_probed(amount: u64, minimum: u64, in_amount: u64) -> Vec<u8> {
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes());
    data.extend_from_slice(&10_000u16.to_le_bytes());
    data.extend_from_slice(&minimum.to_le_bytes());
    data.push(0); // route_account_count
    let route = route_probe(in_amount);
    data.extend_from_slice(&(route.len() as u32).to_le_bytes());
    data.extend_from_slice(&route);
    data
}

/// Run one one-leg probe at (amount, minimum) and return the named code. The
/// leg carries a route probe whose `in_amount == amount`, so an admitted floor
/// lands on 6006 (Jupiter account-layout pin) rather than the curve adapter.
fn probe(mollusk: &Mollusk, fixture: &Fixture, amount: u64, minimum: u64, ctx: &dyn Fn() -> String) -> u32 {
    let data = split_data_probed(amount, minimum, amount);
    run(mollusk, fixture, data, ctx)
}

/// DLMM shape generator: full domain with deliberate mass on negative
/// `active_id` (the historically-zeroed shape), Q64.64 range-exhaustion
/// shapes (the `mul_q64` guard territory MUT-D lives in), and realistic pool
/// shapes.
fn gen_dlmm(rng: &mut Rng) -> Venue {
    let bin_step: u16 = match rng.below(8) {
        0 => [10u16, 20, 25, 80, 100, 125][rng.below(6) as usize],
        1 => rng.range(1, 400) as u16,
        2 => rng.range(1, 65_535) as u16,
        3 => 10_000,
        4 => 65_535,
        5 => 1,
        6 => 0, // fee num == 0 -> 6039 (price still computes: base == 1.0)
        _ => rng.range(400, 10_000) as u16,
    };
    let active_id: i32 = match rng.below(10) {
        0 => -(rng.range(1, 100) as i32),
        1 => -(rng.range(100, 3_000) as i32), // the real-pool regime
        2 => -1513,
        3 => -414,
        4 => rng.range(1, 100) as i32,
        5 => rng.range(100, 3_000) as i32,
        6 => 0,
        7 => -(rng.range(3_000, 2_000_000) as i32), // deep range-exhaustion
        8 => rng.range(3_000, 2_000_000) as i32,
        _ => rng.next() as u32 as i32, // arbitrary, incl. i32::MIN territory
    };
    let base_factor: u16 = match rng.below(6) {
        0 => 10_000,
        1 => 2_000,
        2 => 5_000,
        3 => rng.range(1, 65_535) as u16,
        4 => 0, // fee num == 0 -> 6039
        _ => rng.range(1, 100) as u16,
    };
    let power: u8 = match rng.below(8) {
        0 | 1 | 2 | 3 => 0,
        4 => 1,
        5 => rng.below(4) as u8,
        6 => 19,
        _ => 20, // 10^20 overflows u64 -> 6039
    };
    let depth: u64 = match rng.below(8) {
        0 => MIN_REFERENCE_DEPTH_LAMPORTS,     // boundary: admitted
        1 => MIN_REFERENCE_DEPTH_LAMPORTS - 1, // boundary: 6041
        2 => MIN_REFERENCE_DEPTH_LAMPORTS + 1,
        3 => rng.range(MIN_REFERENCE_DEPTH_LAMPORTS, 50_000_000_000_000),
        4 => rng.range(1, MIN_REFERENCE_DEPTH_LAMPORTS),
        5 => u64::MAX - rng.below(1_000),
        6 => rng.range(50_000_000_000_000, 10_000_000_000_000_000),
        _ => rng.extreme_u64(),
    };
    Venue::Dlmm {
        base_factor,
        power,
        active_id,
        bin_step,
        sol_is_x: rng.below(2) == 0,
        depth,
        tok: rng.range(1, 1_000_000_000_000_000),
    }
}

/// CLMM shape generator: sqrt_price across the representable spectrum
/// (realistic mainnet magnitudes, tiny inverse-branch boundary shapes, huge
/// direct-branch overflow shapes), fee tiers realistic and out-of-band.
fn gen_clmm(rng: &mut Rng) -> Venue {
    let fee: u32 = match rng.below(8) {
        0 => [100u32, 500, 1_000, 2_500, 10_000][rng.below(5) as usize],
        1 => rng.range(1, 999_999) as u32,
        2 => 1_000_000,     // num >= den -> 6039
        3 => rng.next() as u32, // arbitrary, incl. > 1e6
        4 => 0,             // -> 6039
        5 => 1,
        6 => 999_999,
        _ => rng.range(1, 50_000) as u32,
    };
    let sq: u128 = match rng.below(9) {
        0 => 83_589_253_752_498_556_957,  // real $PUMP pool
        1 => 241_583_840_018_074_934_333, // real JTO pool
        2 => 1u128 << rng.range(1, 126),
        3 => rng.range(1, 1_000_000_000) as u128, // tiny: inverse t-guard territory
        4 => ((rng.next() as u128) << 64) | rng.next() as u128,
        5 => 0, // -> 6039
        6 => 3u128 << 63,
        7 => u128::MAX - rng.below(1_000) as u128,
        _ => (1u128 << 64) + rng.next() as u128,
    };
    let depth: u64 = match rng.below(8) {
        0 => MIN_REFERENCE_DEPTH_LAMPORTS,
        1 => MIN_REFERENCE_DEPTH_LAMPORTS - 1,
        2 => MIN_REFERENCE_DEPTH_LAMPORTS + 1,
        3 => rng.range(MIN_REFERENCE_DEPTH_LAMPORTS, 50_000_000_000_000),
        4 => rng.range(1, MIN_REFERENCE_DEPTH_LAMPORTS),
        5 => u64::MAX - rng.below(1_000),
        6 => rng.range(50_000_000_000_000, 10_000_000_000_000_000),
        _ => rng.extreme_u64(),
    };
    Venue::Clmm {
        fee,
        sq,
        sol_is_0: rng.below(2) == 0,
        depth,
        tok: rng.range(1, 1_000_000_000_000_000),
    }
}

/// Pick the probe amount: mostly inside the model cap, with deliberate mass
/// pinned EXACTLY at the cap and one past it (the 6040 comparator boundary).
fn gen_amount(rng: &mut Rng, cap: Option<u64>) -> u64 {
    match cap {
        Some(cap) if cap >= 1 => match rng.below(8) {
            0 => cap,                                  // boundary: admitted by the cap comparator
            1 => cap.saturating_add(1),                // boundary: 6040 (unless cap == u64::MAX)
            2 => 1,
            3 => rng.range(1, cap),
            4 => (cap / 2).max(1),
            5 => rng.range(1, cap.min(1_000_000)).max(1),
            6 => rng.extreme_u64().max(1),
            _ => rng.range(cap / 8 + 1, cap),
        },
        _ => rng.extreme_u64().max(1),
    }
}

#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn cd_exact_outcome_differential() {
    let mollusk = load_mollusk();
    let iters = env_u64("CD_DIFF_ITERS", 10_000);
    let recover_iters = env_u64("CD_RECOVER_ITERS", 100);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xE4);
    println!(
        "cd_exact_outcome_differential: seed {seed_value}, {iters} shapes + {recover_iters} recovered floors"
    );

    let launch = Pubkey::new_from_array([0x43; 32]);

    // Curated always-run shapes: the historical-bug and guard-boundary cases
    // that must be exercised regardless of the random stream.
    let curated: Vec<(Venue, u64)> = vec![
        // Real $PUMP DLMM shape: negative id, floor must be nonzero and exact.
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -1513, bin_step: 20, sol_is_x: false, depth: 12_179_070_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -1513, bin_step: 20, sol_is_x: false, depth: 12_179_070_000_000, tok: 1 }, 100_000_000),
        // Real JTO DLMM shape.
        (Venue::Dlmm { base_factor: 2_000, power: 0, active_id: -414, bin_step: 125, sol_is_x: false, depth: 60_000_000_000, tok: 1 }, 500_000_000),
        // Single-bin negative ids.
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -1, bin_step: 20, sol_is_x: false, depth: 60_000_000_000, tok: 1 }, 100_000_000),
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -2, bin_step: 20, sol_is_x: true, depth: 60_000_000_000, tok: 1 }, 100_000_000),
        // mul_q64 range-exhaustion territory: model must refuse 6027 and the
        // artifact must agree EXACTLY (the MUT-D divergence surface).
        (Venue::Dlmm { base_factor: 100, power: 0, active_id: 40, bin_step: 10_000, sol_is_x: true, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 100, power: 0, active_id: -40, bin_step: 10_000, sol_is_x: false, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 100, power: 0, active_id: 33, bin_step: 65_535, sol_is_x: false, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 100, power: 0, active_id: -33, bin_step: 65_535, sol_is_x: true, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 1, power: 0, active_id: 2_000_000, bin_step: 20, sol_is_x: true, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 1, power: 0, active_id: -2_000_000, bin_step: 20, sol_is_x: false, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: i32::MIN, bin_step: 1, sol_is_x: false, depth: 60_000_000_000, tok: 1 }, 1_000_000_000),
        // CLMM inverse-branch t-guard boundary (venue_layout's pinned shape).
        (Venue::Clmm { fee: 500_000, sq: 1_000_000, sol_is_0: false, depth: u64::MAX / 2, tok: 1 }, 2_000_000),
        (Venue::Clmm { fee: 500_000, sq: 1_000_000, sol_is_0: false, depth: u64::MAX / 2, tok: 1 }, 1_999_998),
        (Venue::Clmm { fee: 500_000, sq: 3u128 << 63, sol_is_0: false, depth: u64::MAX / 2, tok: 1 }, 2_000_000_000),
        // CLMM direct-branch overflow: net * sq exceeds u128.
        (Venue::Clmm { fee: 1_000, sq: u128::MAX - 5, sol_is_0: true, depth: u64::MAX / 2, tok: 1 }, 1_000_000_000),
        // Real CLMM shapes.
        (Venue::Clmm { fee: 1_000, sq: 83_589_253_752_498_556_957, sol_is_0: true, depth: 4_600_000_000_000, tok: 1 }, 1_000_000_000),
        (Venue::Clmm { fee: 10_000, sq: 241_583_840_018_074_934_333, sol_is_0: true, depth: 168_000_000_000, tok: 1 }, 1_000_000_000),
        // Depth-gate boundary, both venues.
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -100, bin_step: 20, sol_is_x: false, depth: MIN_REFERENCE_DEPTH_LAMPORTS, tok: 1 }, 100_000_000),
        (Venue::Dlmm { base_factor: 10_000, power: 0, active_id: -100, bin_step: 20, sol_is_x: false, depth: MIN_REFERENCE_DEPTH_LAMPORTS - 1, tok: 1 }, 10_000_000),
        (Venue::Clmm { fee: 1_000, sq: 1u128 << 64, sol_is_0: true, depth: MIN_REFERENCE_DEPTH_LAMPORTS, tok: 1 }, 10_000_000),
        (Venue::Clmm { fee: 1_000, sq: 1u128 << 64, sol_is_0: true, depth: MIN_REFERENCE_DEPTH_LAMPORTS - 1, tok: 1 }, 10_000_000),
    ];

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    let mut floors_checked = 0u64;
    let mut refusals_checked = 0u64;
    let mut neg_id_floors = 0u64;
    let mut cap_boundary_admits = 0u64;
    let mut cap_boundary_refusals = 0u64;
    let mut depth_boundary_admits = 0u64;
    let mut depth_boundary_6041 = 0u64;
    let mut price_range_refusals = 0u64;

    let total_cases = curated.len() as u64 + iters;
    for iteration in 0..total_cases {
        let (venue, amount) = if (iteration as usize) < curated.len() {
            curated[iteration as usize]
        } else {
            let venue = if rng.below(2) == 0 { gen_dlmm(&mut rng) } else { gen_clmm(&mut rng) };
            let amount = gen_amount(&mut rng, model_cap(&venue));
            (venue, amount)
        };
        let expected = model_outcome(&venue, amount).expect("differential venues only");
        let fixture = build_fixture(&launch, &[10_000], &[venue], amount, None);
        let ctx = |min: u64| {
            let v = describe(&venue);
            move || {
                format!(
                    "CD-D: seed {seed_value} iter {iteration} venue {v} amount {amount} min {min} \
                     model {expected:?}"
                )
            }
        };
        match expected {
            RefOutcome::Refuse(code) => {
                let got = probe(&mollusk, &fixture, amount, 1, &ctx(1));
                assert_eq!(
                    got, code,
                    "CD-D: model predicts refusal {code}, artifact returned {got} \
                     (seed {seed_value} iter {iteration} venue {} amount {amount})",
                    describe(&venue)
                );
                refusals_checked += 1;
                *histogram.entry(code).or_insert(0) += 1;
                if code == INVALID_INSTRUCTION_DATA {
                    price_range_refusals += 1;
                }
                if code == REFERENCE_TOO_SHALLOW {
                    depth_boundary_6041 += 1;
                }
                if code == REFERENCE_CAP_EXCEEDED {
                    if let Some(cap) = model_cap(&venue) {
                        if amount == cap.saturating_add(1) {
                            cap_boundary_refusals += 1;
                        }
                    }
                }
            }
            RefOutcome::Floor(floor) => {
                // Byte-exactness in two probes: minimum_output == floor must
                // be ADMITTED (6005 empty-route sentinel), floor-1 (or 0 when
                // floor == 1) must refuse 6021.
                let admit = probe(&mollusk, &fixture, amount, floor, &ctx(floor));
                assert_eq!(
                    admit, FLOOR_ADMITTED,
                    "CD-D: model floor {floor} must be admitted (6005), artifact returned {admit} \
                     (seed {seed_value} iter {iteration} venue {} amount {amount})",
                    describe(&venue)
                );
                let below = floor - 1; // floor >= 1 always; min 0 sits below any floor
                let refuse = probe(&mollusk, &fixture, amount, below, &ctx(below));
                assert_eq!(
                    refuse, SLIPPAGE_EXCEEDED,
                    "CD-D: minimum {below} (one below model floor {floor}) must refuse 6021, \
                     artifact returned {refuse} (seed {seed_value} iter {iteration} venue {} amount {amount})",
                    describe(&venue)
                );
                floors_checked += 1;
                *histogram.entry(FLOOR_ADMITTED).or_insert(0) += 1;
                if let Venue::Dlmm { active_id, .. } = venue {
                    if active_id < 0 {
                        neg_id_floors += 1;
                    }
                }
                if let Some(cap) = model_cap(&venue) {
                    if amount == cap {
                        cap_boundary_admits += 1;
                    }
                }
                match venue {
                    Venue::Dlmm { depth, .. } | Venue::Clmm { depth, .. }
                        if depth == MIN_REFERENCE_DEPTH_LAMPORTS =>
                    {
                        depth_boundary_admits += 1;
                    }
                    _ => {}
                }
            }
        }
    }

    // The boundary and historical-bug shapes must actually have been
    // sampled — a campaign that never exercises them cannot claim to cover
    // them (curated cases guarantee nonzero; the thresholds require the
    // random stream to contribute too at production scale).
    assert!(neg_id_floors >= 2, "negative-active_id floors not exercised");
    assert!(cap_boundary_admits >= 1 && cap_boundary_refusals >= 1, "cap boundary not exercised");
    assert!(depth_boundary_admits >= 1 && depth_boundary_6041 >= 2, "depth gate boundary not exercised");
    assert!(price_range_refusals >= 4, "Q64.64 range-exhaustion shapes not exercised");

    // Independent floor-recovery subset: binary-search the artifact's floor
    // with NO model input, then compare byte-exactly (cross-checks the
    // two-probe logic itself).
    let mut recovered = 0u64;
    let mut attempts = 0u64;
    while recovered < recover_iters && attempts < recover_iters * 20 {
        attempts += 1;
        let venue = if rng.below(2) == 0 { deep_dlmm(&mut rng) } else { deep_clmm(&mut rng) };
        let cap = match model_cap(&venue) {
            Some(c) if c >= 8 => c,
            _ => continue,
        };
        let amount = rng.range(cap / 8 + 1, cap);
        let model = model_outcome(&venue, amount).expect("deep venue");
        let RefOutcome::Floor(model_floor) = model else { continue };
        let fixture = build_fixture(&launch, &[10_000], &[venue], amount, None);
        let at_max = probe(&mollusk, &fixture, amount, u64::MAX, &|| "recover max".into());
        assert_eq!(at_max, FLOOR_ADMITTED, "recovery sentinel (venue {})", describe(&venue));
        let (mut lo, mut hi) = (1u64, u64::MAX);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if probe(&mollusk, &fixture, amount, mid, &|| "recover".into()) == FLOOR_ADMITTED {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        assert_eq!(
            lo, model_floor,
            "CD-D recovery: artifact floor {lo} != model floor {model_floor} \
             (seed {seed_value} venue {} amount {amount})",
            describe(&venue)
        );
        recovered += 1;
    }
    assert!(recovered >= recover_iters.min(1), "no floor recovered");

    println!(
        "CD-D ok: {total_cases} shapes ({floors_checked} floors byte-exact, {refusals_checked} \
         refusals code-exact), {recovered} independently recovered floors byte-exact. \
         neg-id floors {neg_id_floors}, cap boundary {cap_boundary_admits}/{cap_boundary_refusals}, \
         depth boundary {depth_boundary_admits}/{depth_boundary_6041}, \
         price-range 6027s {price_range_refusals}. outcome distribution {histogram:?}"
    );
}

fn describe(venue: &Venue) -> String {
    match venue {
        Venue::RayV4 { rt, rs, num, den } => format!("RayV4(rt={rt},rs={rs},fee={num}/{den})"),
        Venue::Dlmm { base_factor, power, active_id, bin_step, sol_is_x, depth, .. } => format!(
            "Dlmm(bf={base_factor},pow={power},id={active_id},step={bin_step},sol_is_x={sol_is_x},depth={depth})"
        ),
        Venue::Clmm { fee, sq, sol_is_0, depth, .. } => {
            format!("Clmm(fee={fee},sq={sq},sol_is_0={sol_is_0},depth={depth})")
        }
    }
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
