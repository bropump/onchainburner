//! Re-establishes, against the REAL SBPFv3 keyless artifact, the three host
//! test groups that were `#[cfg(all(test, not(feature = "keyless")))]`-gated
//! and therefore NEVER ran against the keyless build (they vanished when the
//! KMS path was deleted, but the coverage hole predates the deletion):
//!
//!   1. `pda_binding_tests::*` — the config-IS-the-address property, rewritten
//!      for the KEYLESS derivation `("burner", launch, mint_0.., bps_blob,
//!      ref_0..)` (split.rs `build_split_seeds`), including the keyless-only
//!      properties: the Pump zero-sentinel surviving graduation, junk
//!      references binding by address, and Mode A `validate_config`
//!      pinning the same address as the burn (Mode B is deleted: RT8).
//!   2. `validate_config::tests::*` — the admission matrix, driven through the
//!      real `validate_config` instruction (Mode A; Mode B refused) under Mollusk.
//!   3. `split::fuzz` division identity — observable against the artifact via
//!      the leg-0 route `in_amount` pin: a correct independent prediction is
//!      answered 6006 (account-layout refusal on an empty route), an incorrect
//!      one 6008 (`JupiterInputAmountMismatch`), exactly the trick the KMS-era
//!      `fuzz_artifact.rs` used.
//!
//! # Artifact
//!
//! Defaults to `target/deploy/pinocchio_parity.so` — the PRODUCTION build
//! (keyless-only, SBPFv3). It deliberately does NOT prefer the stale
//! `pinocchio_parity_keyless.so` the sibling suites look for first: that file
//! is a pre-deletion feature-gated build and silently invalidates results.
//! `BURNER_KEYLESS_ELF` overrides. The loader asserts ELF `e_flags == 3`
//! (SBPFv3) and the keyless build identity (single-target discriminator
//! refused 6027 at dispatch), so a stale or wrong artifact fails loudly.
//!
//! # What this file deliberately does NOT cover
//!
//!   * The last-leg remainder amount of an n>=2-leg split is not observable
//!     here: reaching leg n-1's route validation requires executing legs
//!     0..n-2's CPIs, which Mollusk fixtures cannot land. The last-leg
//!     formula (`total - allocated`) is exact by construction; its behaviour
//!     under a LANDING burn is fork-suite territory.
//!   * DLMM / CLMM references: `clmm_dlmm_fuzz.rs` and
//!     `venue_layout_artifact.rs` own those readers.
//!
//! Run: `cargo test --test keyless_binding_admission` (not ignored; the whole
//! file is a few seconds of Mollusk calls).

use {
    mollusk_svm::{program, Mollusk},
    mollusk_svm_programs_token::token,
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_pubkey::Pubkey,
    spl_token_interface::state::{Account as TokenAccount, AccountState, Mint},
    std::{fs, path::PathBuf, str::FromStr},
};
use solana_program_option::COption;

const BURNER_PROGRAM: &str = "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
/// `route_v2` args prefix (swap_and_burn.rs `JUPITER_V2_ARGS_PREFIX_LEN`):
/// 8 disc + 8 in + 8 quoted_out + 2 slippage + 2 platform + 2 positive + 4 len.
const ROUTE_V2_PREFIX_LEN: usize = 34;
const ROUTE_V2_IN_AMOUNT_OFFSET: usize = 8;

const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];
const RAYDIUM_CP: [u8; 32] = [
    169, 42, 90, 139, 79, 41, 89, 82, 132, 37, 80, 170, 147, 253, 91, 149, 181, 172, 230, 168,
    235, 146, 12, 147, 148, 46, 67, 105, 12, 32, 236, 115,
];
const PUMP_FUN_PROGRAM: [u8; 32] = [
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
    245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];
const PUMP_SWAP_PROGRAM: [u8; 32] = [
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86,
    213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
];
/// `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`.
const PUMP_FEE_PROGRAM: [u8; 32] = [
    12, 53, 255, 169, 5, 90, 142, 86, 141, 168, 247, 188, 7, 86, 21, 39, 76, 241, 201, 44, 164,
    31, 64, 0, 156, 81, 106, 164, 20, 194, 124, 112,
];
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];

const RENT_FLOOR_ZERO_DATA: u64 = 890_880;

// Named codes asserted below.
const ZERO_INPUT: u32 = 6000;
const ZERO_MINIMUM_OUTPUT: u32 = 6002;
const INVALID_JUPITER_ACCOUNTS: u32 = 6006;
const INPUT_AMOUNT_MISMATCH: u32 = 6008;
const INVALID_TOKEN_PROGRAM: u32 = 6009;
const INVALID_MINT_OWNER: u32 = 6010;
const INVALID_BURN_PDA: u32 = 6012;
const INVALID_MINT_DATA: u32 = 6013;
const INVALID_TOKEN_ACCOUNT_DATA: u32 = 6014;
const UNSUPPORTED_T22_EXTENSION: u32 = 6024;
const INVALID_INSTRUCTION_DATA: u32 = 6027;
const NOT_ENOUGH_ACCOUNT_KEYS: u32 = 6028;
const INVALID_SPLIT_TARGET_COUNT: u32 = 6032;
const INVALID_SPLIT_WEIGHTS: u32 = 6033;
const DUPLICATE_SPLIT_TARGET: u32 = 6034;
const TOKEN_ACCOUNT_ENCUMBERED: u32 = 6035;
const TARGET_MINT_FREEZABLE: u32 = 6036;
const TARGET_MINT_MINTABLE: u32 = 6037;
const TARGET_MINT_NATIVE: u32 = 6038;
const REFERENCE_INVALID: u32 = 6039;

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
fn associated_token_address_2022(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), key(TOKEN_2022_PROGRAM).as_ref(), mint.as_ref()],
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
    let mut account =
        token::create_account_for_token_account(token_account(*mint, *owner, amount, None));
    account.owner = owner_program;
    account
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
}

fn artifact_path() -> PathBuf {
    if let Ok(path) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(path);
    }
    // The PRODUCTION artifact name. Deliberately NOT the sibling suites'
    // preferred `pinocchio_parity_keyless.so`, which is a stale pre-deletion
    // feature build if present.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy/pinocchio_parity.so")
}

fn load_mollusk() -> Mollusk {
    let path = artifact_path();
    assert!(path.is_file(), "missing keyless ELF: {} (set BURNER_KEYLESS_ELF)", path.display());
    let elf = fs::read(&path).expect("read keyless ELF");
    // SBPFv3 gate: ELF64 header e_flags at 0x30 must be 3. This loudly
    // rejects an SBPFv1/v2 build; it cannot distinguish a stale flags-3
    // build, which is what the 6027 identity probe below is for.
    let e_flags = u32::from_le_bytes(elf[0x30..0x34].try_into().unwrap());
    assert_eq!(
        e_flags,
        3,
        "artifact at {} has ELF e_flags {} (want 3 = SBPFv3); stale build?",
        path.display(),
        e_flags
    );
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &key(BURNER_PROGRAM),
        &program::loader_keys::LOADER_V3,
        &elf,
    );
    // Build identity: the keyless-only build refuses the single-target
    // discriminator at dispatch (6027). A KMS build answers differently.
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
        "artifact at {} is NOT a keyless build (single-target not refused 6027)",
        path.display(),
    );
    mollusk
}

fn code_of(result: &Result<(), InstructionError>, ctx: &str) -> Option<u32> {
    match result {
        Ok(()) => None,
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => Some(*code),
        other => panic!("non-named outcome {:?} in {}", other, ctx),
    }
}

// ===========================================================================
// Venue fixtures (constant-product only; shape mirrors keyless_fuzz.rs, the
// values here are chosen so every floor-stage gate passes: depth >= 50 SOL for
// address-bound venues, amounts under every cap).
// ===========================================================================

#[derive(Clone)]
enum Venue {
    /// System-owned junk reference: binds by ADDRESS, floors 6039.
    Bare,
    RayV4 { rt: u64, rs: u64, num: u64, den: u64 },
    RayCp { rt: u64, rs: u64, fee: u64 },
    PumpCurve { vt: u64, vq: u64, protocol_bps: u64 },
    PumpSwap { base: u64, quote: u64, protocol_bps: u64 },
}

fn deep_v4() -> Venue {
    // depth (rs) far above the 50 SOL admission floor; cap = rs*25/10000.
    Venue::RayV4 { rt: u64::MAX / 2, rs: u64::MAX / 2, num: 25, den: 10_000 }
}
fn deep_cp() -> Venue {
    Venue::RayCp { rt: 60_000_000_000, rs: 60_000_000_000, fee: 2_500 }
}
fn pump_curve() -> Venue {
    Venue::PumpCurve { vt: 1_000_000_000_000_000, vq: 30_000_000_000, protocol_bps: 95 }
}
fn pump_swap() -> Venue {
    Venue::PumpSwap { base: 1_000_000_000_000_000, quote: 30_000_000_000, protocol_bps: 95 }
}

fn fee_config_account(venue_pk: &Pubkey, flat: (u64, u64, u64)) -> (Pubkey, Account) {
    let fee_program = Pubkey::new_from_array(PUMP_FEE_PROGRAM);
    let (address, _) =
        Pubkey::find_program_address(&[b"fee_config", venue_pk.as_ref()], &fee_program);
    let mut data = vec![0u8; 69 + 32];
    data[0..8].copy_from_slice(&PUMP_FEE_CONFIG_DISCRIMINATOR);
    data[41..49].copy_from_slice(&flat.0.to_le_bytes());
    data[49..57].copy_from_slice(&flat.1.to_le_bytes());
    data[57..65].copy_from_slice(&flat.2.to_le_bytes());
    data[65..69].copy_from_slice(&0u32.to_le_bytes());
    (
        address,
        Account { lamports: 2_500_000, data, owner: fee_program, executable: false, rent_epoch: 0 },
    )
}

/// Seed a venue binds into the derivation, mirroring `build_split_seeds`
/// (split.rs): the zero sentinel iff the reference account's owner is a Pump
/// program, the reference's address otherwise (junk included).
fn venue_ref_seed(venue: &Venue, reference_pk: &Pubkey) -> [u8; 32] {
    match venue {
        Venue::PumpCurve { .. } | Venue::PumpSwap { .. } => [0u8; 32],
        _ => reference_pk.to_bytes(),
    }
}

fn leg_key(salt: u8, role: u8) -> Pubkey {
    let mut b = [0xCDu8; 32];
    b[0] = 0x7A;
    b[1] = salt;
    b[2] = role;
    Pubkey::new_from_array(b)
}

/// Build one leg's 7 (meta, account) slots. Returns (slots, ref_seed, mint).
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
        (
            AccountMeta::new(mint, false),
            token::create_account_for_mint(immutable_mint(mint_supply, 6)),
        ),
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
            let pool_acct = Account {
                lamports: 6_124_800,
                data: pd,
                owner: Pubkey::new_from_array(RAYDIUM_V4),
                executable: false,
                rent_epoch: 0,
            };
            (
                pool,
                [
                    (AccountMeta::new_readonly(pool, false), pool_acct.clone()),
                    (AccountMeta::new_readonly(va, false), raw_vault_account(token::ID, &mint, &auth, *rt)),
                    (AccountMeta::new_readonly(vb, false), raw_vault_account(token::ID, &wsol, &auth, *rs)),
                    (AccountMeta::new_readonly(pool, false), pool_acct),
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
                    (
                        AccountMeta::new_readonly(pool, false),
                        Account { lamports: 3_000_000, data: pd, owner: cp, executable: false, rent_epoch: 0 },
                    ),
                    (AccountMeta::new_readonly(va, false), raw_vault_account(token::ID, &mint, &auth, *rt)),
                    (AccountMeta::new_readonly(vb, false), raw_vault_account(token::ID, &wsol, &auth, *rs)),
                    (
                        AccountMeta::new_readonly(cfg, false),
                        Account { lamports: 1_500_000, data: cd, owner: cp, executable: false, rent_epoch: 0 },
                    ),
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
                    (
                        AccountMeta::new_readonly(curve, false),
                        Account { lamports: 2_000_000, data: cd, owner: pump, executable: false, rent_epoch: 0 },
                    ),
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
            let (pool_authority, _) =
                Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &pump);
            let mut pd = vec![0u8; 300];
            pd[11..43].copy_from_slice(pool_authority.as_ref());
            pd[139..171].copy_from_slice(va.as_ref());
            pd[171..203].copy_from_slice(vb.as_ref());
            let fee = fee_config_account(&pump_swap, (0, *protocol_bps, 0));
            (
                pool,
                [
                    (
                        AccountMeta::new_readonly(pool, false),
                        Account { lamports: 4_000_000, data: pd, owner: pump_swap, executable: false, rent_epoch: 0 },
                    ),
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

/// The independent derivation model this file tests the artifact against:
/// `("burner", launch, mint_0.., bps_blob, ref_0..)` per the documented spec
/// in split.rs's module header (NOT a call into the crate).
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

/// The exact seed-preimage concatenation Solana hashes (seeds joined without
/// delimiters), used by the host-side injectivity tests.
fn seed_preimage(launch: &Pubkey, mints: &[Pubkey], weights: &[u16], refs: &[[u8; 32]]) -> Vec<u8> {
    let mut bytes = b"burner".to_vec();
    bytes.extend_from_slice(launch.as_ref());
    for m in mints {
        bytes.extend_from_slice(m.as_ref());
    }
    for w in weights {
        bytes.extend_from_slice(&w.to_le_bytes());
    }
    for r in refs {
        bytes.extend_from_slice(r);
    }
    bytes
}

#[allow(dead_code)]
struct Fixture {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    mints: Vec<Pubkey>,
    ref_seeds: Vec<[u8; 32]>,
    burn_pda: Pubkey,
    launch: Pubkey,
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
    let burn_pda =
        pda_override.unwrap_or_else(|| derive_split_pda(launch, &mints, weights, &ref_seeds));
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

    for (i, v) in venues.iter().enumerate() {
        let (slots, _seed, _mint) = venue_leg(&burn_pda, v, i as u8);
        for (meta, account) in slots {
            let pk = meta.pubkey;
            metas.push(meta);
            if !accounts.iter().any(|(k, _)| *k == pk) {
                accounts.push((pk, account));
            }
        }
    }
    Fixture { metas, accounts, mints, ref_seeds, burn_pda, launch: *launch }
}

/// Split data where every leg has empty route data (route bytes only on leg 0
/// when `leg0_route` is given).
fn split_data(total: u64, weights: &[u16], minimums: &[u64], leg0_route: Option<&[u8]>) -> Vec<u8> {
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for (i, w) in weights.iter().enumerate() {
        data.extend_from_slice(&w.to_le_bytes());
        data.extend_from_slice(&minimums[i].to_le_bytes());
        data.push(0); // route_account_count
        let route: &[u8] = if i == 0 { leg0_route.unwrap_or(&[]) } else { &[] };
        data.extend_from_slice(&(route.len() as u32).to_le_bytes());
        data.extend_from_slice(route);
    }
    data
}

/// A `route_v2` payload whose embedded `in_amount` is `guess`, with zero
/// platform / positive-slippage fees and no route accounts. If `guess`
/// matches the program's derived leg amount the answer is 6006 (empty account
/// layout), otherwise 6008 — which makes the on-chain division observable.
fn route_probe(guess: u64) -> Vec<u8> {
    let mut d = vec![0u8; ROUTE_V2_PREFIX_LEN];
    d[..8].copy_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
    d[ROUTE_V2_IN_AMOUNT_OFFSET..ROUTE_V2_IN_AMOUNT_OFFSET + 8]
        .copy_from_slice(&guess.to_le_bytes());
    d
}

fn run_split(mollusk: &Mollusk, fixture: &Fixture, data: Vec<u8>, ctx: &str) -> Option<u32> {
    let ix =
        Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&ix, &fixture.accounts);
    code_of(&result.raw_result, ctx)
}

/// Independent division model (u128 true floor, NOT the program's q/r
/// decomposition): leg i < n-1 gets floor(total*bps/10000); the last leg the
/// remainder.
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

// ===========================================================================
// SECTION 1 — PDA binding on the keyless derivation
// ===========================================================================

/// Matched configs on every constant-product venue class are admitted past
/// the 6012 derivation pin all the way to the leg-0 route sentinel (6006),
/// proving both the derivation agreement AND that the sentinel is live.
#[test]
fn binding_matched_config_admitted_per_venue() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    for (name, venue, amount) in [
        ("ray_v4", deep_v4(), 100_000_000u64),
        ("ray_cp", deep_cp(), 1_000_000),
        ("pump_curve", pump_curve(), 1_000_000),
        ("pump_swap", pump_swap(), 1_000_000),
    ] {
        let fixture = build_fixture(&launch, &[10_000], &[venue], amount, None);
        let code = run_split(
            &mollusk,
            &fixture,
            split_data(amount, &[10_000], &[u64::MAX], Some(&route_probe(amount))),
            name,
        );
        assert_eq!(
            code,
            Some(INVALID_JUPITER_ACCOUNTS),
            "{name}: matched config must reach the empty-route 6006 sentinel, got {code:?}"
        );
    }
}

/// Any reweighting of the same mints and references lands on a different,
/// unfunded vault: the artifact answers 6012 when the caller presents the
/// ORIGINAL vault with mutated weights.
#[test]
fn binding_reweight_moves_address() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let venues = [deep_v4(), deep_cp()];
    let amount = 10_000_000u64;
    let fixture = build_fixture(&launch, &[6_000, 4_000], &venues, amount, None);
    // Control first: the unmutated config is admitted (non-vacuity).
    let control = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[6_000, 4_000], &[u64::MAX; 2], Some(&route_probe(6_000_000))),
        "reweight control",
    );
    assert_eq!(control, Some(INVALID_JUPITER_ACCOUNTS), "control not admitted: {control:?}");
    for weights in [[5_999u16, 4_001u16], [4_000, 6_000], [10_000 - 1, 1]] {
        let code = run_split(
            &mollusk,
            &fixture,
            split_data(amount, &weights, &[u64::MAX; 2], None),
            "reweight mutated",
        );
        assert_eq!(code, Some(INVALID_BURN_PDA), "weights {weights:?} must derive elsewhere");
    }
}

/// Substituting any leg's mint (here: by deriving the presented vault from a
/// different mint list) is refused 6012.
#[test]
fn binding_mint_substitution_moves_address() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let venue = deep_v4();
    let amount = 10_000_000u64;
    let honest = build_fixture(&launch, &[10_000], &[venue.clone()], amount, None);
    // Derive the vault as if the leg's mint were a DIFFERENT mint; present the
    // real leg block. The program rebuilds the seeds from the accounts, so the
    // derivation diverges.
    let foreign_mint = Pubkey::new_from_array([0x77; 32]);
    let wrong_pda =
        derive_split_pda(&launch, &[foreign_mint], &[10_000], &honest.ref_seeds);
    assert_ne!(wrong_pda, honest.burn_pda);
    let fixture = build_fixture(&launch, &[10_000], &[venue], amount, Some(wrong_pda));
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "mint substitution",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// A 1-leg presentation of a 2-leg vault (and vice versa) is refused 6012:
/// leg count is part of the pre-image.
#[test]
fn binding_leg_count_change_moves_address() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    let two_leg = build_fixture(&launch, &[6_000, 4_000], &[deep_v4(), deep_cp()], amount, None);
    // Present a 1-leg fixture claiming the 2-leg vault's address.
    let fixture =
        build_fixture(&launch, &[10_000], &[deep_v4()], amount, Some(two_leg.burn_pda));
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "leg count change",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// Reordering legs (mints, weights and references moved consistently) derives
/// a different vault, and presenting the original vault with reordered legs
/// is refused 6012.
#[test]
fn binding_leg_order_moves_address() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    let original = build_fixture(&launch, &[6_000, 4_000], &[deep_v4(), deep_cp()], amount, None);
    // Same two legs, swapped: venue_leg salts swap too, so the mints swap.
    let swapped = build_fixture(&launch, &[4_000, 6_000], &[deep_cp(), deep_v4()], amount, None);
    // Host half: the derivations differ even though the SET of (mint, weight,
    // ref) pairs is identical.
    assert_ne!(original.burn_pda, swapped.burn_pda, "leg order must be part of the address");
    // Behavioral half: swapped legs against the original vault → 6012.
    let fixture = build_fixture(
        &launch,
        &[4_000, 6_000],
        &[deep_cp(), deep_v4()],
        amount,
        Some(original.burn_pda),
    );
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[4_000, 6_000], &[u64::MAX; 2], None),
        "leg order",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// KEYLESS-specific: an address-bound reference is part of the pre-image. A
/// vault derived against reference R admits only R; presenting the same pool
/// under a vault derived from a different reference address is refused 6012.
#[test]
fn binding_reference_substitution_moves_address() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    let honest = build_fixture(&launch, &[10_000], &[deep_v4()], amount, None);
    let foreign_ref = [0xEEu8; 32];
    let wrong_pda = derive_split_pda(&launch, &honest.mints, &[10_000], &[foreign_ref]);
    assert_ne!(wrong_pda, honest.burn_pda);
    let fixture = build_fixture(&launch, &[10_000], &[deep_v4()], amount, Some(wrong_pda));
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "reference substitution",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// KEYLESS-specific: both Pump-ecosystem references bind as the zero
/// sentinel, so the SAME vault address serves the bonding curve before
/// graduation and the canonical PumpSwap pool after it. Host half: the two
/// derivations are identical. Behavioral half: one address admits both
/// fixtures to the 6006 sentinel.
#[test]
fn binding_pump_sentinel_survives_graduation() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 1_000_000u64;
    let curve = build_fixture(&launch, &[10_000], &[pump_curve()], amount, None);
    let swap = build_fixture(&launch, &[10_000], &[pump_swap()], amount, None);
    assert_eq!(
        curve.burn_pda, swap.burn_pda,
        "curve and PumpSwap references must derive the SAME vault (both sentinel)"
    );
    for (name, fixture) in [("curve", &curve), ("pumpswap", &swap)] {
        let code = run_split(
            &mollusk,
            fixture,
            split_data(amount, &[10_000], &[u64::MAX], Some(&route_probe(amount))),
            name,
        );
        assert_eq!(code, Some(INVALID_JUPITER_ACCOUNTS), "{name} must be admitted to 6006");
    }
}

/// KEYLESS-specific: a junk (System-owned) reference binds by its ADDRESS,
/// never the sentinel. Bound by address → past 6012, refused 6039 at the
/// floor; bound as sentinel → 6012 before any floor runs.
#[test]
fn binding_junk_reference_binds_by_address_not_sentinel() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    // build_fixture derives Bare venues by reference address already.
    let by_address = build_fixture(&launch, &[10_000], &[Venue::Bare], amount, None);
    let code = run_split(
        &mollusk,
        &by_address,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "junk by address",
    );
    assert_eq!(code, Some(REFERENCE_INVALID), "junk ref bound by address floors 6039");
    // Derive with the sentinel instead: the program binds the junk reference
    // by address, so the sentinel-derived vault is a different address → 6012.
    let sentinel_pda = derive_split_pda(&launch, &by_address.mints, &[10_000], &[[0u8; 32]]);
    assert_ne!(sentinel_pda, by_address.burn_pda);
    let fixture = build_fixture(&launch, &[10_000], &[Venue::Bare], amount, Some(sentinel_pda));
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "junk as sentinel",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// A non-canonical bump address for the same seeds is refused 6012: the
/// program derives with `find_program_address` internally.
#[test]
fn binding_non_canonical_bump_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    let honest = build_fixture(&launch, &[10_000], &[deep_v4()], amount, None);
    let blob: Vec<u8> = [10_000u16].iter().flat_map(|w| w.to_le_bytes()).collect();
    let (canonical, canonical_bump) = Pubkey::find_program_address(
        &[
            b"burner",
            launch.as_ref(),
            honest.mints[0].as_ref(),
            &blob,
            honest.ref_seeds[0].as_ref(),
        ],
        &key(BURNER_PROGRAM),
    );
    assert_eq!(canonical, honest.burn_pda, "harness derivation must agree with itself");
    // Find a valid lower bump (one virtually always exists).
    let mut non_canonical = None;
    for bump in (0..canonical_bump).rev() {
        if let Ok(address) = Pubkey::create_program_address(
            &[
                b"burner",
                launch.as_ref(),
                honest.mints[0].as_ref(),
                &blob,
                honest.ref_seeds[0].as_ref(),
                &[bump],
            ],
            &key(BURNER_PROGRAM),
        ) {
            non_canonical = Some(address);
            break;
        }
    }
    let non_canonical = non_canonical.expect("no valid non-canonical bump below the canonical");
    let fixture = build_fixture(&launch, &[10_000], &[deep_v4()], amount, Some(non_canonical));
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "non-canonical bump",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// The launch mint is part of the pre-image: the same config under a
/// different launch namespace is a different vault.
#[test]
fn binding_launch_mint_moves_address() {
    let mollusk = load_mollusk();
    let launch_a = Pubkey::new_from_array([0x41; 32]);
    let launch_b = Pubkey::new_from_array([0x42; 32]);
    let amount = 10_000_000u64;
    let honest = build_fixture(&launch_a, &[10_000], &[deep_v4()], amount, None);
    let other = derive_split_pda(&launch_b, &honest.mints, &[10_000], &honest.ref_seeds);
    assert_ne!(other, honest.burn_pda);
    let fixture = build_fixture(&launch_a, &[10_000], &[deep_v4()], amount, Some(other));
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "launch mint swap",
    );
    assert_eq!(code, Some(INVALID_BURN_PDA));
}

/// The wrong WSOL ATA for the derived vault is refused (6014), pinning the
/// second half of `derive_and_pin_split_vault`.
#[test]
fn binding_wrong_wsol_ata_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    let mut fixture = build_fixture(&launch, &[10_000], &[deep_v4()], amount, None);
    // Replace the WSOL ATA (meta index 3) with an ATA of a different owner.
    let stranger = Pubkey::new_from_array([0x55; 32]);
    let wrong = associated_token_address(&stranger, &key(WSOL_MINT));
    let old = fixture.metas[3].pubkey;
    fixture.metas[3] = AccountMeta::new(wrong, false);
    for (pk, account) in fixture.accounts.iter_mut() {
        if *pk == old {
            *pk = wrong;
            *account = token::create_account_for_token_account(token_account(
                key(WSOL_MINT),
                stranger,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            ));
        }
    }
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(amount, &[10_000], &[u64::MAX], None),
        "wrong wsol ata",
    );
    assert_eq!(code, Some(INVALID_TOKEN_ACCOUNT_DATA));
}

/// Host-side pre-image injectivity of the keyless derivation. The pre-image
/// is `6 + 32 + 66n` bytes (n mints, 2n blob bytes, n refs): injective in n,
/// disjoint from the deleted legacy single-target pre-image (70 bytes), and
/// within one n a distinct config is a distinct byte string. 20k randomized
/// pairs plus the exact length arithmetic.
#[test]
fn binding_preimage_injective_across_and_within_n() {
    let mut rng = Rng(0x5EED_2026_08_26);
    // Length arithmetic: 38 + 66n, all distinct, none equal to the legacy 70.
    let lengths: Vec<usize> = (1..=4)
        .map(|n| {
            let launch = Pubkey::new_unique();
            let mints: Vec<Pubkey> = (0..n).map(|_| Pubkey::new_unique()).collect();
            let weights: Vec<u16> = vec![10_000 / n as u16; n];
            let refs: Vec<[u8; 32]> = (0..n).map(|_| [0x11; 32]).collect();
            seed_preimage(&launch, &mints, &weights, &refs).len()
        })
        .collect();
    assert_eq!(lengths, vec![38 + 66, 38 + 132, 38 + 198, 38 + 264]);
    assert!(!lengths.contains(&70), "legacy single-target pre-image length must stay disjoint");

    // Randomized within/cross-n distinctness on the exact byte concatenation.
    for iteration in 0..20_000 {
        let n_a = 1 + (rng.below(4) as usize);
        let n_b = 1 + (rng.below(4) as usize);
        let make = |rng: &mut Rng, n: usize| {
            let mut launch = [0u8; 32];
            launch[0] = rng.next() as u8;
            let mints: Vec<Pubkey> = (0..n)
                .map(|i| {
                    let mut b = [0u8; 32];
                    b[0] = rng.next() as u8;
                    b[1] = i as u8;
                    Pubkey::new_from_array(b)
                })
                .collect();
            // Pre-image injectivity does not depend on weight validity, so
            // draw arbitrary nonzero u16 weights.
            let weights: Vec<u16> = (0..n).map(|_| 1 + (rng.below(10_000) as u16)).collect();
            let refs: Vec<[u8; 32]> = (0..n)
                .map(|_| {
                    let mut b = [0u8; 32];
                    b[0] = rng.next() as u8;
                    b
                })
                .collect();
            (Pubkey::new_from_array(launch), mints, weights, refs)
        };
        let a = make(&mut rng, n_a);
        let b = make(&mut rng, n_b);
        let pre_a = seed_preimage(&a.0, &a.1, &a.2, &a.3);
        let pre_b = seed_preimage(&b.0, &b.1, &b.2, &b.3);
        let same_config = a == b;
        assert_eq!(
            pre_a == pre_b,
            same_config,
            "pre-image collision without config equality at iteration {iteration}"
        );
    }
}

// ===========================================================================
// SECTION 2 — validate_config admission (Mode A / Mode B)
// ===========================================================================

/// Mode A instruction data: mode byte, leg count, weights, one u64 probe per
/// leg.
fn mode_a_data(weights: &[u16], probes: &[u64]) -> Vec<u8> {
    let mut data = VALIDATE_CONFIG_DISCRIMINATOR.to_vec();
    data.push(0x00);
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for w in weights {
        data.extend_from_slice(&w.to_le_bytes());
    }
    for p in probes {
        data.extend_from_slice(&p.to_le_bytes());
    }
    data
}

fn mode_b_data(weights: &[u16], refs: &[[u8; 32]]) -> Vec<u8> {
    let mut data = VALIDATE_CONFIG_DISCRIMINATOR.to_vec();
    data.push(0x01);
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for w in weights {
        data.extend_from_slice(&w.to_le_bytes());
    }
    for r in refs {
        data.extend_from_slice(r);
    }
    data
}

struct ValidateFixture {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    burn_pda: Pubkey,
    mints: Vec<Pubkey>,
    ref_seeds: Vec<[u8; 32]>,
}

/// Mode A account layout: [burn_pda, wsol_ata, launch_mint, 7-per-leg]. All
/// read-only and signerless — every Ok below therefore doubles as proof the
/// handler demands no write lock and no signer (the old suite's write-lock
/// asymmetry test, inherited by construction).
fn build_validate_fixture(
    launch: &Pubkey,
    weights: &[u16],
    venues: &[Venue],
    pda_override: Option<Pubkey>,
    pending_atas: bool,
) -> ValidateFixture {
    let wsol = key(WSOL_MINT);
    let placeholder = Pubkey::new_from_array([0xFE; 32]);
    let mut mints = Vec::new();
    let mut ref_seeds = Vec::new();
    for (i, v) in venues.iter().enumerate() {
        let (_s, seed, mint) = venue_leg(&placeholder, v, i as u8);
        mints.push(mint);
        ref_seeds.push(seed);
    }
    let burn_pda =
        pda_override.unwrap_or_else(|| derive_split_pda(launch, &mints, weights, &ref_seeds));
    let wsol_ata = associated_token_address(&burn_pda, &wsol);

    let mut metas = vec![
        AccountMeta::new_readonly(burn_pda, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(*launch, false),
    ];
    let wsol_account = if pending_atas {
        system_account(0)
    } else {
        token::create_account_for_token_account(token_account(
            wsol,
            burn_pda,
            0,
            Some(RENT_FLOOR_ZERO_DATA),
        ))
    };
    let mut accounts = vec![
        (burn_pda, system_account(RENT_FLOOR_ZERO_DATA)),
        (wsol_ata, wsol_account),
        (*launch, token::create_account_for_mint(immutable_mint(0, 6))),
    ];
    for (i, v) in venues.iter().enumerate() {
        let (slots, _seed, _mint) = venue_leg(&burn_pda, v, i as u8);
        for (j, (meta, account)) in slots.into_iter().enumerate() {
            let pk = meta.pubkey;
            metas.push(AccountMeta::new_readonly(pk, false));
            if !accounts.iter().any(|(k, _)| *k == pk) {
                let account = if j == 1 && pending_atas {
                    system_account(0) // target ATA still awaiting creation
                } else {
                    account
                };
                accounts.push((pk, account));
            }
        }
    }
    ValidateFixture { metas, accounts, burn_pda, mints, ref_seeds }
}

fn run_validate(
    mollusk: &Mollusk,
    fixture: &ValidateFixture,
    data: Vec<u8>,
    ctx: &str,
) -> Option<u32> {
    let ix =
        Instruction { program_id: key(BURNER_PROGRAM), accounts: fixture.metas.clone(), data };
    let result = mollusk.process_instruction(&ix, &fixture.accounts);
    code_of(&result.raw_result, ctx)
}

/// Every account read-only, no signer, existing ATAs: Ok. This is the
/// baseline every negative case below mutates from, so it also guards
/// against vacuous negatives.
#[test]
fn admission_valid_config_ok_and_readonly() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let fixture =
        build_validate_fixture(&launch, &[6_000, 4_000], &[deep_v4(), pump_curve()], None, false);
    let code = run_validate(
        &mollusk,
        &fixture,
        mode_a_data(&[6_000, 4_000], &[10_000_000, 1_000_000]),
        "valid config",
    );
    assert_eq!(code, None, "valid config must be admitted (all accounts read-only, no signer)");
}

/// Pending (bare System) ATAs at the derived addresses are admitted: the
/// atomic [validate][create ATAs][fund] flow depends on it.
#[test]
fn admission_pending_atas_ok() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let fixture = build_validate_fixture(&launch, &[10_000], &[deep_v4()], None, true);
    let code =
        run_validate(&mollusk, &fixture, mode_a_data(&[10_000], &[10_000_000]), "pending atas");
    assert_eq!(code, None);
}

/// Extra trailing accounts are inert.
#[test]
fn admission_extra_trailing_accounts_inert() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let mut fixture = build_validate_fixture(&launch, &[10_000], &[deep_v4()], None, false);
    let extra = Pubkey::new_from_array([0x66; 32]);
    fixture.metas.push(AccountMeta::new_readonly(extra, false));
    fixture.accounts.push((extra, system_account(1)));
    let code =
        run_validate(&mollusk, &fixture, mode_a_data(&[10_000], &[10_000_000]), "extra accounts");
    assert_eq!(code, None);
}

/// One admission matrix: mutate one fact at a time off the valid baseline and
/// pin the exact code. Each row is (label, expected code, mutator).
#[test]
fn admission_negative_matrix() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);

    type Mutator = Box<dyn Fn(&mut ValidateFixture)>;
    let freeze_mint = |authority: Option<Pubkey>, mint_auth: Option<Pubkey>| {
        let mut mint = immutable_mint(1_000, 6);
        mint.freeze_authority = authority.map(COption::Some).unwrap_or(COption::None);
        mint.mint_authority = mint_auth.map(COption::Some).unwrap_or(COption::None);
        token::create_account_for_mint(mint)
    };

    let cases: Vec<(&str, u32, Mutator)> = vec![
        (
            "freezable target -> 6036",
            TARGET_MINT_FREEZABLE,
            Box::new(move |f: &mut ValidateFixture| {
                let mint_pk = f.mints[0];
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == mint_pk {
                        *account = freeze_mint(Some(Pubkey::new_unique()), None);
                    }
                }
            }),
        ),
        (
            "mintable target -> 6037",
            TARGET_MINT_MINTABLE,
            Box::new(move |f: &mut ValidateFixture| {
                let mint_pk = f.mints[0];
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == mint_pk {
                        *account = freeze_mint(None, Some(Pubkey::new_unique()));
                    }
                }
            }),
        ),
        (
            "frozen existing ATA -> 6014",
            INVALID_TOKEN_ACCOUNT_DATA,
            Box::new(move |f: &mut ValidateFixture| {
                let ata = associated_token_address(&f.burn_pda, &f.mints[0]);
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == ata {
                        let mut t = token_account(f.mints[0], f.burn_pda, 0, None);
                        t.state = AccountState::Frozen;
                        *account = token::create_account_for_token_account(t);
                    }
                }
            }),
        ),
        (
            "encumbered ATA (delegate) -> 6035",
            TOKEN_ACCOUNT_ENCUMBERED,
            Box::new(move |f: &mut ValidateFixture| {
                let ata = associated_token_address(&f.burn_pda, &f.mints[0]);
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == ata {
                        let mut t = token_account(f.mints[0], f.burn_pda, 0, None);
                        t.delegate = COption::Some(Pubkey::new_unique());
                        t.delegated_amount = 1;
                        *account = token::create_account_for_token_account(t);
                    }
                }
            }),
        ),
        (
            "fake (non-executable) token program -> 6009",
            INVALID_TOKEN_PROGRAM,
            Box::new(move |f: &mut ValidateFixture| {
                // Leg token-program slot is meta index 3 + 2 (mint, ata, prog).
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == token::ID {
                        *account = system_account(1); // not executable
                    }
                }
            }),
        ),
        (
            "launch not a mint -> 6010",
            INVALID_MINT_OWNER,
            Box::new(move |f: &mut ValidateFixture| {
                let launch_pk = f.metas[2].pubkey;
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == launch_pk {
                        *account = system_account(1);
                    }
                }
            }),
        ),
        (
            "target mint garbage bytes -> 6013",
            INVALID_MINT_DATA,
            Box::new(move |f: &mut ValidateFixture| {
                let mint_pk = f.mints[0];
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == mint_pk {
                        *account = Account {
                            lamports: 1_000_000,
                            data: vec![7u8; 5],
                            owner: token::ID,
                            executable: false,
                            rent_epoch: 0,
                        };
                    }
                }
            }),
        ),
        (
            "wrong vault address -> 6012",
            INVALID_BURN_PDA,
            Box::new(move |f: &mut ValidateFixture| {
                let wrong = Pubkey::new_from_array([0x99; 32]);
                let old = f.metas[0].pubkey;
                f.metas[0] = AccountMeta::new_readonly(wrong, false);
                for (pk, _) in f.accounts.iter_mut() {
                    if *pk == old {
                        *pk = wrong;
                    }
                }
            }),
        ),
        (
            "wrong wsol ata -> 6014",
            INVALID_TOKEN_ACCOUNT_DATA,
            Box::new(move |f: &mut ValidateFixture| {
                let stranger = Pubkey::new_from_array([0x55; 32]);
                let wrong = associated_token_address(&stranger, &key(WSOL_MINT));
                let old = f.metas[1].pubkey;
                f.metas[1] = AccountMeta::new_readonly(wrong, false);
                for (pk, account) in f.accounts.iter_mut() {
                    if *pk == old {
                        *pk = wrong;
                        *account = token::create_account_for_token_account(token_account(
                            key(WSOL_MINT),
                            stranger,
                            0,
                            Some(RENT_FLOOR_ZERO_DATA),
                        ));
                    }
                }
            }),
        ),
    ];

    for (label, expected, mutate) in cases {
        // Fresh baseline per case; prove the baseline admits first.
        let mut fixture = build_validate_fixture(&launch, &[10_000], &[deep_v4()], None, false);
        let baseline = run_validate(
            &mollusk,
            &fixture,
            mode_a_data(&[10_000], &[10_000_000]),
            "matrix baseline",
        );
        assert_eq!(baseline, None, "baseline must admit before mutation ({label})");
        mutate(&mut fixture);
        let code = run_validate(&mollusk, &fixture, mode_a_data(&[10_000], &[10_000_000]), label);
        assert_eq!(code, Some(expected), "{label}");
    }
}

/// Config-shape refusals carried entirely by the instruction data.
#[test]
fn admission_config_shape_refusals() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let fixture = build_validate_fixture(&launch, &[10_000], &[deep_v4()], None, false);

    // leg_count 0 / 5.
    for n in [0u32, 5] {
        let mut data = VALIDATE_CONFIG_DISCRIMINATOR.to_vec();
        data.push(0x00);
        data.extend_from_slice(&n.to_le_bytes());
        let code = run_validate(&mollusk, &fixture, data, "leg count");
        assert_eq!(code, Some(INVALID_SPLIT_TARGET_COUNT), "leg_count {n}");
    }
    // zero weight; wrong sum.
    let code = run_validate(&mollusk, &fixture, mode_a_data(&[0], &[10_000_000]), "zero weight");
    assert_eq!(code, Some(INVALID_SPLIT_WEIGHTS));
    let code = run_validate(&mollusk, &fixture, mode_a_data(&[9_999], &[10_000_000]), "sum 9999");
    assert_eq!(code, Some(INVALID_SPLIT_WEIGHTS));
    // zero probe.
    let code = run_validate(&mollusk, &fixture, mode_a_data(&[10_000], &[0]), "zero probe");
    assert_eq!(code, Some(ZERO_INPUT));
    // trailing byte / truncated probes / bad mode / empty data.
    let mut trailing = mode_a_data(&[10_000], &[10_000_000]);
    trailing.push(0);
    assert_eq!(
        run_validate(&mollusk, &fixture, trailing, "trailing"),
        Some(INVALID_INSTRUCTION_DATA)
    );
    let mut truncated = mode_a_data(&[10_000], &[10_000_000]);
    truncated.truncate(truncated.len() - 1);
    assert_eq!(
        run_validate(&mollusk, &fixture, truncated, "truncated"),
        Some(INVALID_INSTRUCTION_DATA)
    );
    let mut bad_mode = mode_a_data(&[10_000], &[10_000_000]);
    bad_mode[8] = 0x02;
    assert_eq!(
        run_validate(&mollusk, &fixture, bad_mode, "bad mode"),
        Some(INVALID_INSTRUCTION_DATA)
    );
    assert_eq!(
        run_validate(&mollusk, &fixture, VALIDATE_CONFIG_DISCRIMINATOR.to_vec(), "no mode"),
        Some(INVALID_INSTRUCTION_DATA)
    );
    // too few accounts: 2-leg data over a 1-leg account block.
    assert_eq!(
        run_validate(
            &mollusk,
            &fixture,
            mode_a_data(&[6_000, 4_000], &[10_000_000, 10_000_000]),
            "too few accounts"
        ),
        Some(NOT_ENOUGH_ACCOUNT_KEYS)
    );
}

/// Duplicate targets are refused 6034 (two legs, same venue salt → same mint).
#[test]
fn admission_duplicate_targets_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    // Build a 2-leg fixture by hand where both legs are the SAME leg block.
    let placeholder = Pubkey::new_from_array([0xFE; 32]);
    let (_s, seed, mint) = venue_leg(&placeholder, &deep_v4(), 0);
    let weights = [5_000u16, 5_000];
    let burn_pda = derive_split_pda(&launch, &[mint, mint], &weights, &[seed, seed]);
    let wsol_ata = associated_token_address(&burn_pda, &key(WSOL_MINT));
    let mut metas = vec![
        AccountMeta::new_readonly(burn_pda, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(launch, false),
    ];
    let mut accounts = vec![
        (burn_pda, system_account(RENT_FLOOR_ZERO_DATA)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                key(WSOL_MINT),
                burn_pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (launch, token::create_account_for_mint(immutable_mint(0, 6))),
    ];
    for _ in 0..2 {
        let (slots, _seed, _mint) = venue_leg(&burn_pda, &deep_v4(), 0);
        for (meta, account) in slots {
            let pk = meta.pubkey;
            metas.push(AccountMeta::new_readonly(pk, false));
            if !accounts.iter().any(|(k, _)| *k == pk) {
                accounts.push((pk, account));
            }
        }
    }
    let fixture = ValidateFixture {
        metas,
        accounts,
        burn_pda,
        mints: vec![mint, mint],
        ref_seeds: vec![seed, seed],
    };
    let code = run_validate(
        &mollusk,
        &fixture,
        mode_a_data(&weights, &[10_000_000, 10_000_000]),
        "duplicate targets",
    );
    assert_eq!(code, Some(DUPLICATE_SPLIT_TARGET));
}

/// A native (WSOL) target mint is refused 6038 even though it passes every
/// authority check.
#[test]
fn admission_native_target_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let wsol = key(WSOL_MINT);
    // 1-leg config whose target mint IS WSOL; its ATA address equals the
    // fixture's wsol_ata slot, which is legal (same account, two metas).
    let seed = [0x11u8; 32]; // junk address-bound reference; 6038 fires first
    let reference = Pubkey::new_from_array(seed);
    let weights = [10_000u16];
    let burn_pda = derive_split_pda(&launch, &[wsol], &weights, &[seed]);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);
    let vault_a = Pubkey::new_from_array([0x21; 32]);
    let vault_b = Pubkey::new_from_array([0x22; 32]);
    let fee = Pubkey::new_from_array([0x23; 32]);
    let metas = vec![
        AccountMeta::new_readonly(burn_pda, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(launch, false),
        AccountMeta::new_readonly(wsol, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(reference, false),
        AccountMeta::new_readonly(vault_a, false),
        AccountMeta::new_readonly(vault_b, false),
        AccountMeta::new_readonly(fee, false),
    ];
    let accounts = vec![
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
        (wsol, token::create_account_for_mint(immutable_mint(0, 9))),
        token::keyed_account(),
        (reference, system_account(1)),
        (vault_a, system_account(1)),
        (vault_b, system_account(1)),
        (fee, system_account(1)),
    ];
    let fixture = ValidateFixture {
        metas,
        accounts,
        burn_pda,
        mints: vec![wsol],
        ref_seeds: vec![seed],
    };
    let code =
        run_validate(&mollusk, &fixture, mode_a_data(&weights, &[10_000_000]), "native target");
    assert_eq!(code, Some(TARGET_MINT_NATIVE));
}

/// A Token-2022 target mint carrying a disallowed extension is refused 6024.
/// The mint bytes are hand-built: base Mint, account-type byte, one TLV entry
/// of `MintCloseAuthority` (extension type 3) — not on the allow-list.
#[test]
fn admission_t22_disallowed_extension_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let t22 = key(TOKEN_2022_PROGRAM);
    let mint_pk = Pubkey::new_from_array([0x7B; 32]);

    // Base mint (82 bytes): authorities None, initialized, decimals 6.
    let mut data = vec![0u8; 165 + 1 + 4 + 32];
    data[44] = 6; // decimals
    data[45] = 1; // is_initialized
    data[165] = 1; // AccountType::Mint
    data[166..168].copy_from_slice(&3u16.to_le_bytes()); // MintCloseAuthority
    data[168..170].copy_from_slice(&32u16.to_le_bytes());
    let mint_account =
        Account { lamports: 2_000_000, data, owner: t22, executable: false, rent_epoch: 0 };

    let seed = [0x12u8; 32];
    let reference = Pubkey::new_from_array(seed);
    let weights = [10_000u16];
    let burn_pda = derive_split_pda(&launch, &[mint_pk], &weights, &[seed]);
    let wsol_ata = associated_token_address(&burn_pda, &key(WSOL_MINT));
    let target_ata = associated_token_address_2022(&burn_pda, &mint_pk);
    let vault_a = Pubkey::new_from_array([0x24; 32]);
    let vault_b = Pubkey::new_from_array([0x25; 32]);
    let fee = Pubkey::new_from_array([0x26; 32]);
    let t22_program_account = {
        let mut account = program::create_program_account_loader_v3(&t22);
        account.executable = true;
        account
    };
    let metas = vec![
        AccountMeta::new_readonly(burn_pda, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(launch, false),
        AccountMeta::new_readonly(mint_pk, false),
        AccountMeta::new_readonly(target_ata, false),
        AccountMeta::new_readonly(t22, false),
        AccountMeta::new_readonly(reference, false),
        AccountMeta::new_readonly(vault_a, false),
        AccountMeta::new_readonly(vault_b, false),
        AccountMeta::new_readonly(fee, false),
    ];
    let accounts = vec![
        (burn_pda, system_account(RENT_FLOOR_ZERO_DATA)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                key(WSOL_MINT),
                burn_pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (launch, token::create_account_for_mint(immutable_mint(0, 6))),
        (mint_pk, mint_account),
        (target_ata, system_account(0)), // pending ATA: mint check fires first
        (t22, t22_program_account),
        (reference, system_account(1)),
        (vault_a, system_account(1)),
        (vault_b, system_account(1)),
        (fee, system_account(1)),
    ];
    let fixture = ValidateFixture {
        metas,
        accounts,
        burn_pda,
        mints: vec![mint_pk],
        ref_seeds: vec![seed],
    };
    let code = run_validate(&mollusk, &fixture, mode_a_data(&weights, &[10_000_000]), "t22 ext");
    assert_eq!(code, Some(UNSUPPORTED_T22_EXTENSION));
}

/// Mode A content-checks references: a junk reference fails 6039 at the
/// probe, BEFORE anything is funded — the exact stranding `validate_config`
/// exists to prevent.
#[test]
fn admission_mode_a_junk_reference_refused() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let fixture = build_validate_fixture(&launch, &[10_000], &[Venue::Bare], None, false);
    let code =
        run_validate(&mollusk, &fixture, mode_a_data(&[10_000], &[10_000_000]), "junk ref");
    assert_eq!(code, Some(REFERENCE_INVALID));
}

/// Mode B is deleted (RT8). Every Mode B payload — matched seeds, mutated
/// reference, short tail — is 6027 at dispatch. The previously-honest
/// `[v4, pump_curve]` bind-only shape is refused too: that is the point.
#[test]
fn admission_mode_b_refused_at_dispatch() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let full = build_validate_fixture(&launch, &[6_000, 4_000], &[deep_v4(), pump_curve()], None, false);

    let wsol_ata = associated_token_address(&full.burn_pda, &key(WSOL_MINT));
    let metas = vec![
        AccountMeta::new_readonly(full.burn_pda, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(launch, false),
        AccountMeta::new_readonly(full.mints[0], false),
        AccountMeta::new_readonly(full.mints[1], false),
    ];
    let accounts = vec![
        (full.burn_pda, system_account(RENT_FLOOR_ZERO_DATA)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                key(WSOL_MINT),
                full.burn_pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (launch, token::create_account_for_mint(immutable_mint(0, 6))),
        (full.mints[0], token::create_account_for_mint(immutable_mint(1, 6))),
        (full.mints[1], token::create_account_for_mint(immutable_mint(1, 6))),
    ];
    let fixture = ValidateFixture {
        metas,
        accounts,
        burn_pda: full.burn_pda,
        mints: full.mints.clone(),
        ref_seeds: full.ref_seeds.clone(),
    };
    let refs: Vec<[u8; 32]> = full.ref_seeds.clone();
    let code = run_validate(
        &mollusk,
        &fixture,
        mode_b_data(&[6_000, 4_000], &refs),
        "mode b matched",
    );
    assert_eq!(code, Some(INVALID_INSTRUCTION_DATA), "Mode B must be refused at dispatch");

    let mut wrong = refs.clone();
    wrong[0][0] ^= 1;
    let code = run_validate(
        &mollusk,
        &fixture,
        mode_b_data(&[6_000, 4_000], &wrong),
        "mode b wrong ref",
    );
    assert_eq!(code, Some(INVALID_INSTRUCTION_DATA));

    let code = run_validate(
        &mollusk,
        &fixture,
        mode_b_data(&[6_000, 4_000], &refs[..1]),
        "mode b short refs",
    );
    assert_eq!(code, Some(INVALID_INSTRUCTION_DATA));
}

// ===========================================================================
// SECTION 3 — division identity, observed through the artifact
// ===========================================================================

/// The on-chain division (`q*bps + r*bps/B`, last leg the remainder) must
/// equal the independent u128 floor model. Observable at leg 0: a route whose
/// embedded `in_amount` equals the derived amount reaches the account-layout
/// refusal (6006); any other value is 6008. Both branches are asserted every
/// iteration, so the probe cannot pass vacuously.
#[test]
fn division_leg0_matches_independent_model() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let mut rng = Rng(0xD1B1_5EED ^ 0x2026_0826);
    let iterations: u64 = std::env::var("BURNER_DIVISION_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);

    // Boundary totals first, then random. Weights >= 100 bps and totals >=
    // 10_000 keep every leg amount >= 2 so the floor stage cannot refuse
    // 6002/6000 before the route probe (those orderings are pinned by
    // `division_dust_and_subfee_ordering` below).
    let mut cases: Vec<(u64, Vec<u16>)> = vec![
        (10_000, vec![10_000]),
        (10_001, vec![5_000, 5_000]),
        (19_999, vec![100, 9_900]),
        (1_000_000_007, vec![3_333, 3_333, 3_334]),
        (4_000_000_000_000_000, vec![100, 4_900, 5_000]),
    ];
    for _ in 0..iterations {
        let total = rng.range(10_000, 4_000_000_000_000_000);
        let legs = 1 + rng.below(4) as usize;
        let mut weights = vec![0u16; legs];
        let mut remaining = 10_000u64;
        for i in 0..legs - 1 {
            // Leave at least 100 bps for every leg still to be assigned.
            let legs_after = (legs - 1 - i) as u64;
            let hi = remaining - 100 * legs_after;
            let w = rng.range(100, hi.max(100));
            weights[i] = w as u16;
            remaining -= w;
        }
        weights[legs - 1] = remaining as u16;
        assert!(weights.iter().all(|w| *w >= 100), "generator invariant broken: {weights:?}");
        cases.push((total, weights));
    }

    let mut matched = 0u64;
    for (total, weights) in cases {
        let venues: Vec<Venue> = weights.iter().map(|_| deep_v4()).collect();
        let fixture = build_fixture(&launch, &weights, &venues, total, None);
        let model = model_leg_amounts(total, &weights);
        let minimums = vec![u64::MAX; weights.len()];
        let ctx = format!("total={total} weights={weights:?}");

        let agree = run_split(
            &mollusk,
            &fixture,
            split_data(total, &weights, &minimums, Some(&route_probe(model[0]))),
            &ctx,
        );
        assert_eq!(
            agree,
            Some(INVALID_JUPITER_ACCOUNTS),
            "{ctx}: model leg0={} disagreed with the artifact (got {agree:?})",
            model[0]
        );
        // Off-by-one both ways must be 6008 — proves the sentinel is live.
        for wrong in [model[0].wrapping_sub(1), model[0] + 1] {
            let miss = run_split(
                &mollusk,
                &fixture,
                split_data(total, &weights, &minimums, Some(&route_probe(wrong))),
                &ctx,
            );
            assert_eq!(
                miss,
                Some(INPUT_AMOUNT_MISMATCH),
                "{ctx}: wrong guess {wrong} not refused 6008"
            );
        }
        matched += 1;
    }
    assert!(matched >= 30, "too few division cases actually sampled: {matched}");
    println!("division probe: {matched} (total, weights) cases byte-exact at leg 0");
}

/// Refusal ordering at the dust boundary: a leg amount of ZERO is 6000 in the
/// division loop (before any floor runs); a leg amount too small to survive
/// the venue fee is 6002 from the floor stage.
#[test]
fn division_dust_and_subfee_ordering() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    // total=9_999, weights [1, 9_999]: leg0 = floor(9999/10000) = 0 → 6000.
    let weights = [1u16, 9_999];
    let fixture = build_fixture(&launch, &weights, &[deep_v4(), deep_v4()], 9_999, None);
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(9_999, &weights, &[u64::MAX; 2], None),
        "dust leg",
    );
    assert_eq!(code, Some(ZERO_INPUT), "a zero-deriving leg must refuse 6000");

    // total=10_000, same weights: leg0 = 1 → survives division, dies 6002 in
    // the floor stage (fee floors the net input to zero).
    let fixture = build_fixture(&launch, &weights, &[deep_v4(), deep_v4()], 10_000, None);
    let code = run_split(
        &mollusk,
        &fixture,
        split_data(10_000, &weights, &[u64::MAX; 2], None),
        "sub-fee leg",
    );
    assert_eq!(code, Some(ZERO_MINIMUM_OUTPUT), "a sub-fee leg must refuse 6002 at the floor");
}

/// Always-on decode survival (the old `split::fuzz` decode properties ran on
/// every `cargo test`; the 100k-case version lives in the `#[ignore]`-gated
/// `keyless_fuzz.rs`). Random tails and structured corruptions of a valid
/// split payload, plus random discriminators, against a real fixture: every
/// outcome must be a named 6000..=6043 (a panic in `code_of` is the failure).
/// Scaled by `BURNER_DECODE_ITERS` (default 3000).
#[test]
fn decode_survives_arbitrary_and_corrupted_data() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let amount = 10_000_000u64;
    let fixture = build_fixture(&launch, &[6_000, 4_000], &[deep_v4(), pump_curve()], amount, None);
    let valid = split_data(amount, &[6_000, 4_000], &[u64::MAX; 2], Some(&route_probe(6_000_000)));
    let mut rng = Rng(0xDEC0DE ^ 0x2026_0826);
    let iterations: u64 = std::env::var("BURNER_DECODE_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3_000);
    let mut histogram: std::collections::BTreeMap<u32, u64> = std::collections::BTreeMap::new();
    for i in 0..iterations {
        let data = match rng.below(4) {
            // Random bytes after a valid discriminator.
            0 => {
                let len = rng.below(96) as usize;
                let mut d = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
                for _ in 0..len {
                    d.push(rng.next() as u8);
                }
                d
            }
            // Random discriminator over a valid tail.
            1 => {
                let mut d = valid.clone();
                for b in d[..8].iter_mut() {
                    *b = rng.next() as u8;
                }
                d
            }
            // Single byte flip anywhere in the valid payload.
            2 => {
                let mut d = valid.clone();
                let at = rng.below(d.len() as u64) as usize;
                d[at] ^= 1 << rng.below(8);
                d
            }
            // Truncation at a random boundary.
            _ => {
                let mut d = valid.clone();
                d.truncate(rng.below(d.len() as u64 + 1) as usize);
                d
            }
        };
        let ctx = format!("decode iteration {i}");
        // `code_of` panics on any non-named outcome; Ok is impossible with an
        // empty route but would also be surfaced (None) and counted.
        let code = run_split(&mollusk, &fixture, data, &ctx);
        *histogram.entry(code.unwrap_or(0)).or_insert(0) += 1;
    }
    println!("decode campaign outcome histogram: {histogram:?}");
    assert!(
        histogram.keys().all(|c| (6000..=6043).contains(c)),
        "unexpected outcome class in {histogram:?}"
    );
}

/// One-leg identity: the single leg IS the remainder leg, so its amount is
/// the full total — pinned exactly by the 6006/6008 sentinel.
#[test]
fn division_one_leg_gets_exact_total() {
    let mollusk = load_mollusk();
    let launch = Pubkey::new_from_array([0x41; 32]);
    let total = 123_456_789u64;
    let fixture = build_fixture(&launch, &[10_000], &[deep_v4()], total, None);
    let agree = run_split(
        &mollusk,
        &fixture,
        split_data(total, &[10_000], &[u64::MAX], Some(&route_probe(total))),
        "one leg exact",
    );
    assert_eq!(agree, Some(INVALID_JUPITER_ACCOUNTS));
    for wrong in [total - 1, total + 1] {
        let miss = run_split(
            &mollusk,
            &fixture,
            split_data(total, &[10_000], &[u64::MAX], Some(&route_probe(wrong))),
            "one leg wrong",
        );
        assert_eq!(miss, Some(INPUT_AMOUNT_MISMATCH));
    }
}
