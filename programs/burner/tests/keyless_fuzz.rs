//! PRODUCTION-SCALE fuzz campaign for the KEYLESS artifact
//! (`--features keyless`), executed against the REAL SBPF program under
//! Mollusk. Companion to `keyless_artifact.rs` / `venue_layout_artifact.rs`
//! (which pin exact boundaries) — this file scales the *breadth*: hundreds of
//! thousands of arbitrary and structured-corruption instructions across every
//! keyless venue reader and the reference-binding seed builder, plus a
//! high-volume exact-floor differential against an independent 128-bit model.
//!
//! # The pass bar (identical to the production ~1.2M fuzz campaign)
//!
//! Every outcome must be a NAMED `Custom(6000..=6043)`. An abort
//! (`ProgramFailedToComplete`), an access violation, an unnamed
//! `InstructionError`, or a panic is a DEFECT — the harness panics with the
//! reproducing input and the seed. A keyless burn can NEVER succeed against
//! these no-CPI fixtures, so `Ok` from a burn discriminator is also a finding;
//! only `validate_config` on its exact valid shape may legitimately return Ok.
//!
//! # Campaigns
//!   * `arbitrary_split_instruction_data` — random/near-miss discriminators and
//!     random-or-structured split payloads against valid 1..4-leg keyless
//!     venue fixtures and bare shapes. Mirrors `fuzz_artifact.rs` for keyless.
//!   * `venue_corruption_multi_leg` — 1..4-leg mixed-venue references with
//!     structured corruption (byte flips, truncation, owner swaps, u64 splats)
//!     across every leg's reference / mint / vaults / fee source.
//!   * `reference_binding_fuzz` — random launch/mints/weights/references, the
//!     burn nominating a possibly-mutated reference set: a matching set prices
//!     the floor, any mismatch (mint, weight, leg count, ref seed, sentinel
//!     class) lands on a different unfunded vault (6012). Exercises
//!     `build_split_seeds` at 1..4 legs including the 32-zero Pump sentinel.
//!   * `exact_floor_differential` — binary-searches the artifact's per-leg
//!     floor via the 6021 refusal and asserts it byte-exact against a 128-bit
//!     reference, across Raydium v4 / CP / Pump curve / PumpSwap at scale. This
//!     is the only campaign that catches a SILENT wrong-number defect.
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
//!   KEYLESS_FUZZ_ITERS=200000 BURNER_FUZZ_SEED=20260825 \
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml --test keyless_fuzz -- --ignored --nocapture
//!
//! Env: `BURNER_KEYLESS_ELF`, `KEYLESS_FUZZ_ITERS` (per-campaign iteration
//! count), `BURNER_FUZZ_SEED` (default 20260825; a failing run prints it).

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

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];

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

const KEYLESS_TOL_BPS: u128 = 100;
const PUMP_FIXED_SUPPLY: u128 = 1_000_000_000_000_000;
const MIN_REFERENCE_DEPTH_LAMPORTS: u64 = 50_000_000_000;
const RENT_FLOOR_ZERO_DATA: u64 = 890_880;

// Named codes seen as terminal outcomes.
const ZERO_INPUT: u32 = 6000;
const ZERO_MINIMUM_OUTPUT: u32 = 6002;
/// Post-floor "admitted" sentinel. In the merged keyless+directcurve build an
/// EMPTY route marks a leg as the curve leg, so the admitted sentinel is no
/// longer 6005 (`InvalidJupiterInstruction`); instead `recover_floor` feeds a
/// NON-EMPTY `route_probe` (a real `route_v2` payload with the leg's exact
/// `in_amount`, zero fees, zero route accounts) so the admitted leg stays on
/// the JUPITER path and refuses at the account-layout pin (6006). A WRONG
/// `in_amount` would be 6008 instead, which is what keeps the probe honest.
const FLOOR_ADMITTED: u32 = 6006;
const INVALID_JUPITER_ACCOUNTS: u32 = 6006;
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
const ROUTE_V2_PREFIX_LEN: usize = 34;
const ROUTE_V2_IN_AMOUNT_OFFSET: usize = 8;
const INVALID_BURN_PDA: u32 = 6012;
const SLIPPAGE_EXCEEDED: u32 = 6021;
const INVALID_INSTRUCTION_DATA: u32 = 6027;
const REFERENCE_INVALID: u32 = 6039;
const REFERENCE_CAP_EXCEEDED: u32 = 6040;
const REFERENCE_TOO_SHALLOW: u32 = 6041;

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
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn seed() -> u64 {
    std::env::var("BURNER_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(20_260_825)
}

// ---------------------------------------------------------------------------
// Mollusk + artifact identity guard
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

/// Named-outcome oracle. `allow_ok` is only ever set for validate_config's
/// valid shape. Anything else is a finding.
fn assert_named(result: &Result<(), InstructionError>, allow_ok: bool, ctx: &dyn Fn() -> String) -> Option<u32> {
    match result {
        Ok(()) if allow_ok => None,
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => Some(*code),
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
    Bare,
    RayV4 { rt: u64, rs: u64, num: u64, den: u64 },
    RayCp { rt: u64, rs: u64, fee: u64 },
    PumpCurve { vt: u64, vq: u64, protocol_bps: u64 },
    PumpSwap { base: u64, quote: u64, protocol_bps: u64 },
}

fn fee_config_account(venue_pk: &Pubkey, flat: (u64, u64, u64)) -> (Pubkey, Account) {
    let fee_program = Pubkey::new_from_array(PUMP_FEE_PROGRAM);
    let (address, _) = Pubkey::find_program_address(&[b"fee_config", venue_pk.as_ref()], &fee_program);
    let mut data = vec![0u8; 69 + 32]; // zero tiers + legal trailing bytes
    data[0..8].copy_from_slice(&PUMP_FEE_CONFIG_DISCRIMINATOR);
    data[41..49].copy_from_slice(&flat.0.to_le_bytes());
    data[49..57].copy_from_slice(&flat.1.to_le_bytes());
    data[57..65].copy_from_slice(&flat.2.to_le_bytes());
    data[65..69].copy_from_slice(&0u32.to_le_bytes());
    (address, Account { lamports: 2_500_000, data, owner: fee_program, executable: false, rent_epoch: 0 })
}

/// The 32-byte seed a venue binds into the vault derivation (mirrors
/// `build_split_seeds`): the zero sentinel for Pump-ecosystem owners, the
/// reference's address otherwise.
fn venue_ref_seed(venue: &Venue, reference_pk: &Pubkey) -> [u8; 32] {
    match venue {
        Venue::PumpCurve { .. } | Venue::PumpSwap { .. } => [0u8; 32],
        _ => reference_pk.to_bytes(),
    }
}

/// Collision-free deterministic leg-account key. Byte 0 is a fixed marker
/// (0x7A) never used by any fixed account (caller 0x30, quote 0x31, launch
/// 0x40-0x43, placeholder 0xFE, mints via this same helper), byte 1 the leg
/// salt, byte 2 the role, so no two leg accounts and no fixed account collide.
fn leg_key(salt: u8, role: u8) -> Pubkey {
    let mut b = [0xCDu8; 32];
    b[0] = 0x7A;
    b[1] = salt;
    b[2] = role;
    Pubkey::new_from_array(b)
}

/// Build the 7 (meta, account) slots for one leg. `salt` disambiguates the
/// deterministic pubkeys per leg. Returns (slots, ref_seed, mint).
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
        Venue::Bare => {
            let r = leg_key(salt, 1);
            let a = leg_key(salt, 2);
            let b = leg_key(salt, 3);
            let f = leg_key(salt, 4);
            (
                r,
                [
                    (AccountMeta::new_readonly(r, false), system_account(1)),
                    (AccountMeta::new_readonly(a, false), system_account(1)),
                    (AccountMeta::new_readonly(b, false), system_account(1)),
                    (AccountMeta::new_readonly(f, false), system_account(1)),
                ],
            )
        }
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
        Venue::RayCp { rt, rs, fee } => {
            let cp = Pubkey::new_from_array(RAYDIUM_CP);
            let pool = leg_key(salt, 9);
            let va = leg_key(salt, 10);
            let vb = leg_key(salt, 11);
            let cfg = leg_key(salt, 12);
            let auth = leg_key(salt, 13);
            let mut pd = vec![0u8; 300];
            pd[8..40].copy_from_slice(cfg.as_ref());
            pd[72..104].copy_from_slice(va.as_ref());
            pd[104..136].copy_from_slice(vb.as_ref());
            let mut cd = vec![0u8; 64];
            cd[12..20].copy_from_slice(&fee.to_le_bytes());
            (
                pool,
                [
                    (AccountMeta::new_readonly(pool, false), Account { lamports: 3_000_000, data: pd, owner: cp, executable: false, rent_epoch: 0 }),
                    (AccountMeta::new_readonly(va, false), raw_vault_account(token::ID, &mint, &auth, *rt)),
                    (AccountMeta::new_readonly(vb, false), raw_vault_account(token::ID, &wsol, &auth, *rs)),
                    (AccountMeta::new_readonly(cfg, false), Account { lamports: 1_500_000, data: cd, owner: cp, executable: false, rent_epoch: 0 }),
                ],
            )
        }
        Venue::PumpCurve { vt, vq, protocol_bps } => {
            let pump = Pubkey::new_from_array(PUMP_FUN_PROGRAM);
            let (curve, _) = Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &pump);
            let mut cd = vec![0u8; 151];
            cd[8..16].copy_from_slice(&vt.to_le_bytes());
            cd[16..24].copy_from_slice(&vq.to_le_bytes());
            let fee = fee_config_account(&pump, (0, *protocol_bps, 0));
            let ia = leg_key(salt, 14);
            let ib = leg_key(salt, 15);
            (
                curve,
                [
                    (AccountMeta::new_readonly(curve, false), Account { lamports: 2_000_000, data: cd, owner: pump, executable: false, rent_epoch: 0 }),
                    (AccountMeta::new_readonly(ia, false), system_account(1)),
                    (AccountMeta::new_readonly(ib, false), system_account(1)),
                    (AccountMeta::new_readonly(fee.0, false), fee.1),
                ],
            )
        }
        Venue::PumpSwap { base, quote, protocol_bps } => {
            let pump = Pubkey::new_from_array(PUMP_FUN_PROGRAM);
            let pump_swap = Pubkey::new_from_array(PUMP_SWAP_PROGRAM);
            let pool = leg_key(salt, 16);
            let va = leg_key(salt, 17);
            let vb = leg_key(salt, 18);
            let auth = leg_key(salt, 19);
            let (pool_authority, _) = Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &pump);
            let mut pd = vec![0u8; 300];
            pd[11..43].copy_from_slice(pool_authority.as_ref());
            pd[139..171].copy_from_slice(va.as_ref());
            pd[171..203].copy_from_slice(vb.as_ref());
            let fee = fee_config_account(&pump_swap, (0, *protocol_bps, 0));
            (
                pool,
                [
                    (AccountMeta::new_readonly(pool, false), Account { lamports: 4_000_000, data: pd, owner: pump_swap, executable: false, rent_epoch: 0 }),
                    (AccountMeta::new_readonly(va, false), raw_vault_account(token::ID, &mint, &auth, *base)),
                    (AccountMeta::new_readonly(vb, false), raw_vault_account(token::ID, &wsol, &auth, *quote)),
                    (AccountMeta::new_readonly(fee.0, false), fee.1),
                ],
            )
        }
    };
    let seed = venue_ref_seed(venue, &reference_pk);
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
    /// Victim indices in `accounts` for corruption (the per-leg reference,
    /// mint, vaults, fee-source), collected across all legs.
    victims: Vec<usize>,
}

/// Assemble a complete keyless split fixture with the given per-leg venues,
/// deriving the vault from the (possibly overridden) reference seeds.
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

    // First pass with a placeholder PDA to learn each leg's mint & ref seed.
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
            // Deduplicate by pubkey the way Mollusk resolves repeated metas.
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

fn run(mollusk: &Mollusk, fixture: &Fixture, data: Vec<u8>, ctx: &dyn Fn() -> String) -> Option<u32> {
    let ix = Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&ix, &fixture.accounts);
    assert_named(&result.raw_result, false, ctx)
}

// A weight vector summing to 10000, of length 1..=4.
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

fn random_venue(rng: &mut Rng) -> Venue {
    match rng.below(5) {
        0 => Venue::Bare,
        1 => Venue::RayV4 { rt: rng.extreme_u64(), rs: rng.extreme_u64(), num: rng.below(20_001), den: rng.below(20_001) },
        2 => Venue::RayCp { rt: rng.extreme_u64(), rs: rng.extreme_u64(), fee: rng.below(2_000_000) },
        3 => Venue::PumpCurve { vt: rng.extreme_u64(), vq: rng.extreme_u64(), protocol_bps: rng.below(2_000) },
        _ => Venue::PumpSwap { base: rng.extreme_u64(), quote: rng.extreme_u64(), protocol_bps: rng.below(2_000) },
    }
}

// ===========================================================================
// CAMPAIGN A — arbitrary split instruction data against valid venue fixtures
// ===========================================================================
#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn arbitrary_split_instruction_data() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 40_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xA1);
    println!("arbitrary_split_instruction_data: seed {seed_value}, {iters} iterations");

    // A stable pool of valid-account fixtures at 1..4 legs & mixed venues, so
    // arbitrary DATA is adjudicated against real deep account layouts.
    let launch = Pubkey::new_from_array([0x40; 32]);
    let shapes: Vec<(Vec<u16>, Vec<Venue>)> = vec![
        (vec![10_000], vec![Venue::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 }]),
        (vec![5_000, 5_000], vec![
            Venue::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 },
            Venue::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 100 },
        ]),
        (vec![8_000, 1_000, 1_000], vec![
            Venue::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 100 },
            Venue::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 },
            Venue::PumpSwap { base: 1_000_000_000_000_000, quote: 100_000_000_000, protocol_bps: 100 },
        ]),
        (vec![2_500, 2_500, 2_500, 2_500], vec![
            Venue::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 },
            Venue::RayCp { rt: 1_000_000_000_000, rs: 100_000_000_000, fee: 2_500 },
            Venue::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 100 },
            Venue::PumpSwap { base: 1_000_000_000_000_000, quote: 100_000_000_000, protocol_bps: 100 },
        ]),
        (vec![10_000], vec![Venue::Bare]),
    ];
    let fixtures: Vec<Fixture> = shapes
        .iter()
        .map(|(w, v)| build_fixture(&launch, w, v, 10_000_000_000, None))
        .collect();

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let fixture = &fixtures[rng.below(fixtures.len() as u64) as usize];
        // Random discriminator, biased to the split handler.
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
        // Random or structured payload.
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
        let code = run(&mollusk, fixture, data.clone(), &|| {
            format!("A: seed {seed_value} iter {iteration} data {}", hex(&data))
        });
        if let Some(c) = code {
            *histogram.entry(c).or_insert(0) += 1;
        }
    }
    println!("A ok: {iters} arbitrary-data runs, all named. distribution {histogram:?}");
}

// ===========================================================================
// CAMPAIGN B — multi-leg mixed-venue structured corruption
// ===========================================================================
#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn venue_corruption_multi_leg() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 40_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xB2);
    println!("venue_corruption_multi_leg: seed {seed_value}, {iters} iterations");

    let launch = Pubkey::new_from_array([0x41; 32]);
    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let weights = random_weights(&mut rng);
        let venues: Vec<Venue> = weights.iter().map(|_| random_venue(&mut rng)).collect();
        let total = rng.extreme_u64().max(1);
        let mut fixture = build_fixture(&launch, &weights, &venues, total, None);

        // Apply structured corruption across leg victim accounts.
        let corruptions = rng.below(9);
        for _ in 0..corruptions {
            if fixture.victims.is_empty() {
                break;
            }
            let victim = fixture.victims[rng.below(fixture.victims.len() as u64) as usize];
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
                    account.owner = match rng.below(6) {
                        0 => Pubkey::default(),
                        1 => Pubkey::new_from_array(RAYDIUM_V4),
                        2 => Pubkey::new_from_array(RAYDIUM_CP),
                        3 => Pubkey::new_from_array(PUMP_FUN_PROGRAM),
                        4 => Pubkey::new_from_array(PUMP_SWAP_PROGRAM),
                        _ => token::ID,
                    };
                }
                _ => {
                    if account.data.len() >= 8 {
                        let at = rng.below(account.data.len() as u64 - 7) as usize;
                        let v = rng.extreme_u64();
                        account.data[at..at + 8].copy_from_slice(&v.to_le_bytes());
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
            format!("B: seed {seed_value} iter {iteration} weights {weights:?} total {total}")
        });
        if let Some(c) = code {
            *histogram.entry(c).or_insert(0) += 1;
        }
    }
    println!("B ok: {iters} corruption runs, all named. distribution {histogram:?}");
}

// ===========================================================================
// CAMPAIGN C — reference-binding seed construction across 1..4 legs
// ===========================================================================
#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn reference_binding_fuzz() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 40_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xC3);
    println!("reference_binding_fuzz: seed {seed_value}, {iters} iterations");

    // Deep, admissible venues so a MATCHING derivation prices the floor rather
    // than failing on account shape; then perturb the derivation inputs and
    // require 6012 whenever the presented reference set diverges from the bound.
    let launch = Pubkey::new_from_array([0x42; 32]);
    let mut mismatched_6012 = 0u64;
    let mut matched_named = 0u64;
    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let weights = random_weights(&mut rng);
        // Admissible references (deep enough to clear the 50-SOL depth gate and
        // price a floor): Raydium v4 and Pump curve/pool.
        let venues: Vec<Venue> = weights
            .iter()
            .map(|_| match rng.below(3) {
                0 => Venue::RayV4 { rt: 1_000_000_000_000, rs: 100_000_000_000, num: 25, den: 10_000 },
                1 => Venue::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 100 },
                _ => Venue::PumpSwap { base: 1_000_000_000_000_000, quote: 100_000_000_000, protocol_bps: 100 },
            })
            .collect();

        // The correctly-bound vault for this exact (launch, mints, weights, refs).
        let placeholder = Pubkey::new_from_array([0xFE; 32]);
        let mut mints = Vec::new();
        let mut ref_seeds = Vec::new();
        for (i, v) in venues.iter().enumerate() {
            let (_s, seed_, mint) = venue_leg(&placeholder, v, i as u8);
            mints.push(mint);
            ref_seeds.push(seed_);
        }
        let bound = derive_split_pda(&launch, &mints, &weights, &ref_seeds);

        // Decide whether to present the matching vault or a perturbed one.
        let perturb = rng.below(4) != 0; // 75% mismatched
        let pda = if !perturb {
            bound
        } else {
            // Mutate one derivation input: a mint, a weight, a ref seed, the
            // launch, or the leg count — every one lands on a different vault.
            let mut m_mints = mints.clone();
            let mut m_weights = weights.clone();
            let mut m_refs = ref_seeds.clone();
            let mut m_launch = launch;
            match rng.below(5) {
                0 => { let i = rng.below(m_mints.len() as u64) as usize; m_mints[i] = Pubkey::new_from_array([rng.next() as u8; 32]); }
                1 if m_weights.len() >= 2 => { m_weights[0] += 1; m_weights[1] -= 1; }
                1 => { m_weights[0] = m_weights[0].wrapping_add(1); }
                2 => { let i = rng.below(m_refs.len() as u64) as usize; m_refs[i][0] ^= 1; }
                3 => { m_launch = Pubkey::new_from_array([rng.next() as u8; 32]); }
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
            format!("C: seed {seed_value} iter {iteration} weights {weights:?} perturb {perturb}")
        });
        let code = code.expect("burn never returns Ok");
        *histogram.entry(code).or_insert(0) += 1;
        if pda != bound {
            assert_eq!(
                code, INVALID_BURN_PDA,
                "C: a divergent reference set must land on a different unfunded vault (6012); \
                 got {code} (seed {seed_value} iter {iteration} weights {weights:?})"
            );
            mismatched_6012 += 1;
        } else {
            // A matching vault must NOT be 6012 — the binding admitted it and
            // the floor stage (or a well-formed refusal) took over.
            assert_ne!(
                code, INVALID_BURN_PDA,
                "C: the correctly-bound vault must be admitted, not 6012 (seed {seed_value} iter {iteration} weights {weights:?})"
            );
            matched_named += 1;
        }
    }
    println!(
        "C ok: {iters} binding runs. {mismatched_6012} divergent->6012, {matched_named} bound->admitted. \
         distribution {histogram:?}"
    );
}

// ===========================================================================
// CAMPAIGN D — exact per-leg floor differential vs a 128-bit reference
// ===========================================================================

/// Independent 128-bit floor model for a constant-product venue. Mirrors
/// `keyless_leg_floor`'s tail: fee cap, input-after-fee, cp_out, TOL haircut.
fn reference_floor_cp(rt: u128, rs: u128, amount: u128, fee_num: u128, fee_den: u128, pump_exact_in: bool) -> Result<u64, u32> {
    // cap = rs * num / den
    let cap = rs * fee_num / fee_den;
    if amount > cap {
        return Err(REFERENCE_CAP_EXCEEDED);
    }
    let inp: u128 = if pump_exact_in {
        let denom = fee_den + fee_num;
        let net = amount * fee_den / denom;
        if net == 0 {
            return Err(ZERO_MINIMUM_OUTPUT);
        }
        net - 1
    } else {
        amount * (fee_den - fee_num) / fee_den
    };
    if inp == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    let expected = rt * inp / (rs + inp);
    if expected == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    let floor = expected * (10_000 - KEYLESS_TOL_BPS) / 10_000;
    if floor == 0 {
        return Err(ZERO_MINIMUM_OUTPUT);
    }
    if floor > u64::MAX as u128 {
        return Err(INVALID_INSTRUCTION_DATA);
    }
    Ok(floor as u64)
}

/// A `route_v2` payload whose embedded `in_amount` is `guess`, with zero
/// platform / positive-slippage fees and NO route accounts. On a leg whose
/// floor the caller admitted, `in_amount == derived leg amount` reaches the
/// account-layout pin (6006); any other `in_amount` is 6008. This is what
/// makes the admitted sentinel unambiguous under the merged build, where an
/// EMPTY route would instead be dispatched to the curve adapter.
fn route_probe(guess: u64) -> Vec<u8> {
    let mut d = vec![0u8; ROUTE_V2_PREFIX_LEN];
    d[..8].copy_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
    d[ROUTE_V2_IN_AMOUNT_OFFSET..ROUTE_V2_IN_AMOUNT_OFFSET + 8].copy_from_slice(&guess.to_le_bytes());
    d
}

/// One-leg split data carrying a single non-empty `route_probe(in_amount)` on
/// the sole leg (route_account_count stays 0, so no route accounts are
/// consumed). Mirrors `split_data` otherwise.
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

/// Binary-search the artifact's exact floor for a one-leg fixture via the 6021
/// refusal: `minimum_output < floor` is 6021, `>= floor` is admitted. The leg
/// carries a `route_probe` whose `in_amount == amount` (a one-leg split's leg
/// amount is the whole total), so an admitted floor lands on 6006 rather than
/// the curve-adapter path an empty route would take.
fn recover_floor(mollusk: &Mollusk, launch: &Pubkey, venue: &Venue, amount: u64) -> Result<u64, u32> {
    let weights = [10_000u16];
    let placeholder = Pubkey::new_from_array([0xFE; 32]);
    let (_s, seed_, mint) = venue_leg(&placeholder, venue, 0);
    let bound = derive_split_pda(launch, &[mint], &weights, &[seed_]);
    let fixture = build_fixture(launch, &weights, std::slice::from_ref(venue), amount, Some(bound));

    let run_min = |min: u64| -> u32 {
        let data = split_data_probed(amount, min, amount);
        let ix = Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
        match mollusk.process_instruction(&ix, &fixture.accounts).raw_result {
            Err(InstructionError::Custom(c)) => c,
            other => panic!("recover_floor non-named {other:?}"),
        }
    };
    // Probe minimum 0 and u64::MAX to classify.
    let at_zero = run_min(0);
    if at_zero != SLIPPAGE_EXCEEDED && at_zero != FLOOR_ADMITTED {
        // A refusal before the floor gate (cap, depth, shape) — return it.
        return Err(at_zero);
    }
    if run_min(u64::MAX) != FLOOR_ADMITTED {
        // u64::MAX admitted means floor <= u64::MAX; if not admitted, the floor
        // path refused for another reason — surface it.
        let c = run_min(u64::MAX);
        if c != FLOOR_ADMITTED {
            return Err(c);
        }
    }
    // floor is the smallest min that is ADMITTED (6005). Search [1, u64::MAX].
    let (mut lo, mut hi) = (1u64, u64::MAX);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if run_min(mid) == FLOOR_ADMITTED {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

#[test]
#[ignore = "needs the keyless artifact; see file header"]
fn exact_floor_differential() {
    let mollusk = load_mollusk();
    // Each recovered floor costs ~64 executions; default kept modest, scale via
    // KEYLESS_DIFF_ITERS.
    let iters = env_u64("KEYLESS_DIFF_ITERS", 400);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xD4);
    println!("exact_floor_differential: seed {seed_value}, {iters} recovered floors");

    let launch = Pubkey::new_from_array([0x43; 32]);
    let mut checked = 0u64;
    for iteration in 0..iters {
        // Deep pools so the 50-SOL depth gate is cleared and a floor exists.
        let rs = rng.range(50_000_000_000, 5_000_000_000_000); // 50..5000 SOL
        let rt = rng.range(1_000_000_000_000, 100_000_000_000_000_000);
        let (venue, model): (Venue, Box<dyn Fn(u128) -> Result<u64, u32>>) = match rng.below(3) {
            0 => {
                let num = rng.range(1, 500);
                let den = 10_000u64;
                (
                    Venue::RayV4 { rt, rs, num, den },
                    Box::new(move |a| reference_floor_cp(rt as u128, rs as u128, a, num as u128, den as u128, false)),
                )
            }
            1 => {
                let fee = rng.range(1, 50_000); // /1e6
                (
                    Venue::RayCp { rt, rs, fee },
                    Box::new(move |a| reference_floor_cp(rt as u128, rs as u128, a, fee as u128, 1_000_000, false)),
                )
            }
            _ => {
                // Pump curve: flat protocol bps only (creator default => excluded).
                let protocol_bps = rng.range(1, 300);
                (
                    Venue::PumpCurve { vt: rt, vq: rs, protocol_bps },
                    Box::new(move |a| reference_floor_cp(rt as u128, rs as u128, a, protocol_bps as u128, 10_000, true)),
                )
            }
        };
        // Exact cap = rs * fee_num / fee_den. Pick a meaningful amount inside
        // it (cap/8 .. cap) so `inp` is nonzero and a real floor is recovered.
        let cap_u128 = match venue {
            Venue::RayV4 { num, den, .. } => rs as u128 * num as u128 / den as u128,
            Venue::RayCp { fee, .. } => rs as u128 * fee as u128 / 1_000_000,
            Venue::PumpCurve { protocol_bps, .. } => rs as u128 * protocol_bps as u128 / 10_000,
            _ => 1,
        };
        let cap = cap_u128.max(1).min(u64::MAX as u128) as u64;
        let amount = if cap < 4 { cap.max(1) } else { rng.range(cap / 8 + 1, cap) };

        match (recover_floor(&mollusk, &launch, &venue, amount), model(amount as u128)) {
            (Ok(artifact_floor), Ok(model_floor)) => {
                assert_eq!(
                    artifact_floor, model_floor,
                    "D: floor mismatch iter {iteration} venue kind, amount {amount}, rt {rt} rs {rs} \
                     (artifact {artifact_floor} vs model {model_floor}) seed {seed_value}"
                );
                checked += 1;
            }
            (Err(a), Err(_m)) => {
                // Both refuse — acceptable (cap/zero paths differ in exact code
                // near boundaries); just require the artifact code is named.
                assert!((6000..=6043).contains(&a), "D: unnamed refusal {a}");
            }
            (Ok(artifact_floor), Err(m)) => {
                // The model refused but the artifact priced: only tolerate when
                // the model's refusal is a boundary zero/cap rounding; a priced
                // floor that the model says is zero is a finding.
                panic!(
                    "D: artifact priced floor {artifact_floor} but model refused {m} \
                     (iter {iteration} amount {amount} rt {rt} rs {rs} seed {seed_value})"
                );
            }
            (Err(a), Ok(m)) => {
                // Artifact refused where the model priced: tolerable only if the
                // artifact's refusal is a cap/depth boundary code, else finding.
                assert!(
                    a == REFERENCE_CAP_EXCEEDED || a == REFERENCE_TOO_SHALLOW || a == ZERO_MINIMUM_OUTPUT || a == ZERO_INPUT,
                    "D: artifact refused {a} where model priced {m} \
                     (iter {iteration} amount {amount} rt {rt} rs {rs} seed {seed_value})"
                );
            }
        }
    }
    println!("D ok: {checked}/{iters} floors byte-exact vs the 128-bit reference");
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
