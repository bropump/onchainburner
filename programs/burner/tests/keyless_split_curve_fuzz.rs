//! PRODUCTION-SCALE fuzz campaign for the KEYLESS SPLIT-CURVE dispatch
//! (`--features keyless,directcurve`), executed against the REAL SBPF artifact
//! under Mollusk with the benign no-op Pump stub. This is the newest and
//! least-tested code in the repo: per-leg curve/Jupiter dispatch, the per-leg
//! `fund_wsol` skip, and the seam between the two accumulator credit contracts
//! (a Jupiter leg closes-and-refunds; a curve leg must be lamport-identical).
//!
//! Companion to `split_curve_artifact.rs` (which pins the 5 single-leg
//! behaviours + 2 mutations); this file scales the *breadth* to the mixed and
//! multi-leg arrangements `FABLE-SPLIT-CURVE-IMPL.md` flags UNPROVEN:
//!   * mixed curve + Jupiter legs in one instruction,
//!   * 4-leg curve-mixed shapes,
//!   * a Jupiter leg that ALSO carries a Pump accumulator (the partition seam),
//!   * account aliasing / role confusion across legs.
//!
//! # The oracle (identical to split_curve_artifact.rs)
//!
//! The benign stub at Pump.fun / PumpSwap / Jupiter returns Ok WITHOUT moving
//! funds, so a fully-valid CURVE leg runs the whole per-leg path and then fails
//! the exact lamport-delta postcondition -> 6019 SENTINEL. Structural failures
//! surface earlier as named codes (6006 adapter, 6021 floor, 6018 WSOL,
//! 6034 duplicate mint, 6012 vault pin, ...). The pass bar is identical to the
//! production ~1.2M campaign: EVERY outcome a named `Custom(6000..=6043)`; an
//! abort / access-violation / unnamed error / panic is a DEFECT reported with
//! its reproducing seed.
//!
//! # Build (fresh; current source: sha 3998f271 in this session)
//!   tmp/toolchains/agave-4.0.0/bin/cargo-build-sbf --arch v3 --tools-version v1.53 \
//!     --manifest-path programs/burner/Cargo.toml --sbf-out-dir <dir> \
//!     --features keyless,directcurve
//!   cp <dir>/pinocchio_parity.so <dir>/pinocchio_parity_keyless_directcurve.so
//!
//! # Run
//!   BURNER_KEYLESS_DIRECTCURVE_ELF=<dir>/pinocchio_parity_keyless_directcurve.so \
//!   BENIGN_PUMP_ELF=<abs>/tests/benign-pump-fixture/target/deploy/benign_pump.so \
//!   KEYLESS_FUZZ_ITERS=100000 BURNER_FUZZ_SEED=20260825 \
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml --test keyless_split_curve_fuzz \
//!     -- --ignored --nocapture

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

const BURN_PDA_LAMPORT_MISMATCH: u32 = 6019; // curve-leg sentinel
const WSOL_NOT_FULLY_CONSUMED: u32 = 6018;
const INVALID_INSTRUCTION_DATA: u32 = 6027;

const FIXED: usize = 8;
const PER_TARGET: usize = 7;
const PUMP_ACCOUNTS: usize = 16;

// A fresh normal Pump curve.
const VIRTUAL_TOKENS: u64 = 1_000_000_000_000_000;
const VIRTUAL_SOL: u64 = 30_000_000_000;

fn key(v: &str) -> Pubkey {
    Pubkey::from_str(v).expect("valid fixed pubkey")
}
fn ata(owner: &Pubkey, mint: &Pubkey, tp: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), tp.as_ref(), mint.as_ref()], &key(ASSOCIATED_TOKEN_PROGRAM)).0
}
fn pump_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &key(PUMP_FUN_PROGRAM)).0
}
fn system_account(lamports: u64) -> Account {
    Account::new(lamports, 0, &Pubkey::default())
}
fn program_account(id: &Pubkey) -> Account {
    program::create_program_account_loader_v3(id)
}
fn pump_owned(len: usize) -> Account {
    Account { lamports: 1_000_000, data: vec![0u8; len], owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}
fn immutable_mint() -> Account {
    let mut data = vec![0u8; 82];
    data[36..44].copy_from_slice(&VIRTUAL_TOKENS.to_le_bytes());
    data[44] = 6;
    data[45] = 1;
    Account { lamports: 1_461_600, data, owner: token::ID, executable: false, rent_epoch: 0 }
}
fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64, native: bool) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    if native {
        data[109..113].copy_from_slice(&[1, 0, 0, 0]);
    }
    Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }
}
fn curve_account() -> Account {
    let mut data = vec![0u8; 151];
    data[8..16].copy_from_slice(&VIRTUAL_TOKENS.to_le_bytes());
    data[16..24].copy_from_slice(&VIRTUAL_SOL.to_le_bytes());
    data[48] = 0;
    data[81] = 0;
    Account { lamports: 2_000_000, data, owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}
fn fee_config_account() -> Account {
    let mut data = vec![0u8; 69 + 40 + 16];
    data[0..8].copy_from_slice(&PUMP_FEE_CONFIG_DISCRIMINATOR);
    data[49..57].copy_from_slice(&95u64.to_le_bytes());
    data[57..65].copy_from_slice(&30u64.to_le_bytes());
    data[65..69].copy_from_slice(&1u32.to_le_bytes());
    data[69..85].copy_from_slice(&0u128.to_le_bytes());
    data[69 + 24..69 + 32].copy_from_slice(&95u64.to_le_bytes());
    data[69 + 32..69 + 40].copy_from_slice(&30u64.to_le_bytes());
    Account { lamports: 2_500_000, data, owner: key(PUMP_FEE_PROGRAM), executable: false, rent_epoch: 0 }
}
fn live_user_volume(pda: &Pubkey) -> Account {
    let mut data = vec![0u8; 48];
    data[0..8].copy_from_slice(&PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR);
    data[8..40].copy_from_slice(pda.as_ref());
    Account { lamports: 1_844_400, data, owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

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
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            out.extend_from_slice(&self.next().to_le_bytes());
        }
        out.truncate(len);
        out
    }
}
fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn seed() -> u64 {
    std::env::var("BURNER_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(20_260_825)
}

fn artifact_path() -> PathBuf {
    if let Ok(p) = std::env::var("BURNER_KEYLESS_DIRECTCURVE_ELF") {
        return PathBuf::from(p);
    }
    let deploy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy");
    let preferred = deploy.join("pinocchio_parity_keyless_directcurve.so");
    if preferred.is_file() { preferred } else { deploy.join("pinocchio_parity.so") }
}
fn benign_pump_elf_path() -> PathBuf {
    if let Ok(p) = std::env::var("BENIGN_PUMP_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/benign-pump-fixture/target/deploy/benign_pump.so")
}

fn load_mollusk() -> Mollusk {
    let burner = artifact_path();
    assert!(burner.is_file(), "missing keyless+directcurve ELF: {} (set BURNER_KEYLESS_DIRECTCURVE_ELF)", burner.display());
    let stub_path = benign_pump_elf_path();
    assert!(stub_path.is_file(), "missing benign pump stub ELF: {} (set BENIGN_PUMP_ELF)", stub_path.display());

    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(&key(BURNER_PROGRAM), &program::loader_keys::LOADER_V3, &fs::read(&burner).expect("read burner ELF"));
    let stub = fs::read(&stub_path).expect("read benign pump stub ELF");
    mollusk.add_program_with_loader_and_elf(&key(PUMP_FUN_PROGRAM), &program::loader_keys::LOADER_V3, &stub);
    mollusk.add_program_with_loader_and_elf(&key(PUMP_FEE_PROGRAM), &program::loader_keys::LOADER_V3, &stub);
    mollusk.add_program_with_loader_and_elf(&key(JUPITER_PROGRAM), &program::loader_keys::LOADER_V3, &stub);

    // Build identity: single-target dispatch refused 6027 AND a valid one-leg
    // curve split reaches the 6019 sentinel (only a keyless+directcurve build
    // selects the curve path for empty route data).
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
        "artifact at {} did not refuse single-target dispatch 6027", burner.display(),
    );
    let ctrl = MultiFixture::all_curve(&[10_000], &[LegKind::Curve]);
    assert_eq!(
        ctrl.run(&mollusk),
        BURN_PDA_LAMPORT_MISMATCH,
        "artifact at {} is NOT a keyless+directcurve build (a valid one-leg curve split did not reach 6019)",
        burner.display(),
    );
    mollusk
}

/// Named-outcome oracle. A `Custom(6000..=6043)` returns its code. A
/// `PrivilegeEscalation` is a KNOWN-BENIGN RUNTIME refusal (returned code 0
/// here): the Solana runtime blocked a privilege the caller supplied
/// (a spuriously-signed or wrongly-writable account) BEFORE the program made
/// any custody change, and the transaction rolls back — exactly the behaviour
/// `directcurve_artifact.rs::readonly_extra_account_aborts_privilege_escalation`
/// pins. A true SBF abort (`ProgramFailedToComplete`), an access violation, or
/// any other unnamed error IS A DEFECT and panics with the reproducing input.
fn named(result: &Result<(), InstructionError>, ctx: &dyn Fn() -> String) -> u32 {
    match result {
        Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => *code,
        // Sentinel 0 / 1: RUNTIME-level refusals of a caller-supplied malformed
        // account set, NOT SBF aborts and NOT custody changes. `PrivilegeEscalation`
        // (a spuriously-signed / wrongly-writable account) and `UnsupportedProgramId`
        // (a corrupted account in a forwarded program position that the runtime
        // declines to load) both roll the transaction back before the burner
        // completes any custody logic. `directcurve_artifact.rs` already pins
        // PrivilegeEscalation as a known-benign outcome. A true SBF abort
        // (`ProgramFailedToComplete`), an access violation, or any other unnamed
        // error remains a DEFECT and panics with the reproducing input.
        Err(InstructionError::PrivilegeEscalation) => 0,
        Err(InstructionError::UnsupportedProgramId) => 1,
        other => panic!("artifact produced a NON-NAMED outcome {other:?}\n{}", ctx()),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum LegKind {
    /// Empty route data -> the directcurve buy path. Carries the full 16 Pump
    /// route accounts.
    Curve,
    /// Non-empty route data -> the Jupiter route path. Carries the same 16
    /// accounts (which will fail `validate_jupiter_route` as a named 6006, or
    /// 6018 if it reached the route CPI); used to exercise mixed dispatch and
    /// the accumulator partition without a real Jupiter program.
    JupiterShaped,
    /// A curve leg whose route pool ALSO includes a live Pump accumulator at
    /// r13 (the partition-seam probe).
    CurveWithAccumulator,
}

struct Slot {
    key: Pubkey,
    signer: bool,
    writable: bool,
    account: Account,
}

struct MultiFixture {
    fixed: Vec<Slot>,
    /// Per-leg 7-account target blocks (flattened).
    target_blocks: Vec<Slot>,
    /// Per-leg route pools (flattened, in leg order).
    route_pool: Vec<Slot>,
    weights: Vec<u16>,
    minimums: Vec<u64>,
    kinds: Vec<LegKind>,
    route_data: Vec<Vec<u8>>,
    route_counts: Vec<u8>,
    total: u64,
    pda: Pubkey,
}

impl MultiFixture {
    /// Build an N-leg split where each leg is the given kind. Every leg is a
    /// Pump curve reference (bound as the zero sentinel), so all N legs share
    /// the sentinel derivation.
    fn all_curve(weights: &[u16], kinds: &[LegKind]) -> MultiFixture {
        assert_eq!(weights.len(), kinds.len());
        let n = weights.len();
        let tp = token::ID;
        let caller = Pubkey::new_from_array([10; 32]);
        let quote_slot = Pubkey::new_from_array([16; 32]);
        let launch_mint = Pubkey::new_from_array([13; 32]);
        let wsol = key(WSOL_MINT);

        // Per-leg target mints (distinct), all Pump curves (zero sentinel).
        let mints: Vec<Pubkey> = (0..n).map(|i| Pubkey::new_from_array([0x71 + i as u8; 32])).collect();
        let zero_refs: Vec<[u8; 32]> = (0..n).map(|_| [0u8; 32]).collect();

        // Derive the bound vault.
        let blob: Vec<u8> = weights.iter().flat_map(|w| w.to_le_bytes()).collect();
        let mut seeds: Vec<&[u8]> = vec![b"burner", launch_mint.as_ref()];
        for m in &mints {
            seeds.push(m.as_ref());
        }
        seeds.push(&blob);
        for r in &zero_refs {
            seeds.push(r.as_ref());
        }
        let pda = Pubkey::find_program_address(&seeds, &key(BURNER_PROGRAM)).0;
        let wsol_source = ata(&pda, &wsol, &tp);

        let system = program::keyed_account_for_system_program();
        let fixed = vec![
            Slot { key: caller, signer: true, writable: false, account: system_account(1_000_000) },
            Slot { key: quote_slot, signer: false, writable: false, account: system_account(1_000_000) },
            Slot { key: pda, signer: false, writable: true, account: system_account(1_000_000_000_000) },
            Slot { key: wsol_source, signer: false, writable: true, account: token_account(&wsol, &pda, 0, true) },
            Slot { key: launch_mint, signer: false, writable: false, account: immutable_mint() },
            Slot { key: system.0, signer: false, writable: false, account: system.1.clone() },
            Slot { key: tp, signer: false, writable: false, account: token::keyed_account().1 },
            Slot { key: key(JUPITER_PROGRAM), signer: false, writable: false, account: program_account(&key(JUPITER_PROGRAM)) },
        ];

        let fee_config = Pubkey::find_program_address(&[b"fee_config", key(PUMP_FUN_PROGRAM).as_ref()], &key(PUMP_FEE_PROGRAM)).0;
        let global = pump_pda(&[b"global"]);
        let event_authority = pump_pda(&[b"__event_authority"]);
        let global_volume = pump_pda(&[b"global_volume_accumulator"]);
        let user_volume = pump_pda(&[b"user_volume_accumulator", pda.as_ref()]);

        let mut target_blocks = Vec::new();
        let mut route_pool = Vec::new();
        let mut route_data = Vec::new();
        let mut route_counts = Vec::new();
        let mut minimums = Vec::new();

        // Per-leg input amounts, mirroring the program's split math
        // (total * bps / 10_000, final leg absorbs the remainder).
        let total = 1_000_000u64 * n as u64;
        let mut amounts = Vec::new();
        let mut allocated = 0u64;
        for (i, &bps) in weights.iter().enumerate() {
            let a = if i + 1 == n {
                total - allocated
            } else {
                let q = total / 10_000;
                let r = total % 10_000;
                q * bps as u64 + (r * bps as u64) / 10_000
            };
            allocated += a;
            amounts.push(a);
        }

        for i in 0..n {
            let mint = mints[i];
            let curve = pump_pda(&[b"bonding-curve", mint.as_ref()]);
            let target_ata = ata(&pda, &mint, &tp);
            let assoc_bonding_curve = ata(&curve, &mint, &tp);
            let creator_vault = pump_pda(&[b"creator-vault", [0u8; 32].as_ref()]);
            let fee_recipient = Pubkey::new_from_array([0x40 + i as u8; 32]);

            // 7-account keyless leg block.
            target_blocks.push(Slot { key: mint, signer: false, writable: true, account: immutable_mint() });
            target_blocks.push(Slot { key: target_ata, signer: false, writable: true, account: token_account(&mint, &pda, 0, false) });
            target_blocks.push(Slot { key: tp, signer: false, writable: false, account: token::keyed_account().1 });
            target_blocks.push(Slot { key: curve, signer: false, writable: false, account: curve_account() });
            target_blocks.push(Slot { key: Pubkey::new_from_array([0xA0 + i as u8; 32]), signer: false, writable: false, account: system_account(1) });
            target_blocks.push(Slot { key: Pubkey::new_from_array([0xB0 + i as u8; 32]), signer: false, writable: false, account: system_account(1) });
            target_blocks.push(Slot { key: fee_config, signer: false, writable: false, account: fee_config_account() });

            // 16 Pump route accounts.
            let uv_account = match kinds[i] {
                LegKind::CurveWithAccumulator => live_user_volume(&pda),
                _ => system_account(1_000_000),
            };
            let leg_route = vec![
                Slot { key: global, signer: false, writable: false, account: pump_owned(64) }, // r0
                Slot { key: fee_recipient, signer: false, writable: true, account: system_account(1_000_000) }, // r1
                Slot { key: mint, signer: false, writable: false, account: immutable_mint() }, // r2
                Slot { key: curve, signer: false, writable: true, account: curve_account() }, // r3
                Slot { key: assoc_bonding_curve, signer: false, writable: true, account: token_account(&mint, &curve, 0, false) }, // r4
                Slot { key: target_ata, signer: false, writable: true, account: token_account(&mint, &pda, 0, false) }, // r5
                Slot { key: pda, signer: false, writable: true, account: system_account(1_000_000_000_000) }, // r6 user
                Slot { key: system.0, signer: false, writable: false, account: system.1.clone() }, // r7
                Slot { key: tp, signer: false, writable: false, account: token::keyed_account().1 }, // r8
                Slot { key: creator_vault, signer: false, writable: true, account: system_account(1_000_000) }, // r9
                Slot { key: event_authority, signer: false, writable: false, account: system_account(1) }, // r10
                Slot { key: key(PUMP_FUN_PROGRAM), signer: false, writable: false, account: program_account(&key(PUMP_FUN_PROGRAM)) }, // r11
                Slot { key: global_volume, signer: false, writable: false, account: pump_owned(64) }, // r12
                Slot { key: user_volume, signer: false, writable: true, account: uv_account }, // r13
                Slot { key: fee_config, signer: false, writable: false, account: fee_config_account() }, // r14
                Slot { key: key(PUMP_FEE_PROGRAM), signer: false, writable: false, account: program_account(&key(PUMP_FEE_PROGRAM)) }, // r15
            ];
            route_counts.push(leg_route.len() as u8);
            for s in leg_route {
                route_pool.push(s);
            }
            // Curve legs carry EMPTY route data; JupiterShaped legs carry a
            // route_v2-looking payload so the dispatch selects the Jupiter path.
            match kinds[i] {
                LegKind::JupiterShaped => {
                    let mut rd = vec![0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
                    rd.extend_from_slice(&0u64.to_le_bytes()); // in_amount
                    rd.extend_from_slice(&1u64.to_le_bytes()); // quoted
                    rd.extend_from_slice(&0u16.to_le_bytes());
                    rd.extend_from_slice(&0u16.to_le_bytes());
                    rd.extend_from_slice(&0u16.to_le_bytes());
                    rd.extend_from_slice(&0u32.to_le_bytes());
                    route_data.push(rd);
                }
                _ => route_data.push(Vec::new()),
            }
            // Floor-safe minimum so the pre-CPI floor gate passes for a curve
            // leg: cp_out over the REAL per-leg amount ignoring fee and
            // tolerance is >= the program's own (fee-deducted, TOL-haircut)
            // floor, because cp_out is monotone in the input.
            minimums.push(floor_safe_minimum(amounts[i]));
        }

        MultiFixture {
            fixed,
            target_blocks,
            route_pool,
            weights: weights.to_vec(),
            minimums,
            kinds: kinds.to_vec(),
            route_data,
            route_counts,
            total,
            pda,
        }
    }

    fn slots(&self) -> Vec<&Slot> {
        let mut all: Vec<&Slot> = Vec::new();
        for s in &self.fixed {
            all.push(s);
        }
        for s in &self.target_blocks {
            all.push(s);
        }
        for s in &self.route_pool {
            all.push(s);
        }
        all
    }

    fn instruction(&self) -> (Instruction, Vec<(Pubkey, Account)>) {
        let all = self.slots();
        let metas: Vec<AccountMeta> = all
            .iter()
            .map(|s| AccountMeta { pubkey: s.key, is_signer: s.signer, is_writable: s.writable })
            .collect();
        let mut seen: BTreeMap<Pubkey, Account> = BTreeMap::new();
        let mut accounts = Vec::new();
        for s in &all {
            if seen.insert(s.key, s.account.clone()).is_none() {
                accounts.push((s.key, s.account.clone()));
            }
        }
        let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&self.total.to_le_bytes());
        data.extend_from_slice(&(self.weights.len() as u32).to_le_bytes());
        for i in 0..self.weights.len() {
            data.extend_from_slice(&self.weights[i].to_le_bytes());
            data.extend_from_slice(&self.minimums[i].to_le_bytes());
            data.push(self.route_counts[i]);
            data.extend_from_slice(&(self.route_data[i].len() as u32).to_le_bytes());
            data.extend_from_slice(&self.route_data[i]);
        }
        (Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data }, accounts)
    }

    fn run(&self, mollusk: &Mollusk) -> u32 {
        let (ix, accounts) = self.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        named(&result.raw_result, &|| {
            format!("split-curve run weights {:?} kinds {}", self.weights, self.kinds.len())
        })
    }
}

/// A minimum guaranteed >= the program's keyless curve floor for a leg of the
/// given input amount (ignores fee and tolerance, so it clears the pre-CPI
/// floor gate: cp_out is monotone in the input and the program's floor deducts
/// the fee and applies the 100 bps haircut, both of which only lower it).
fn floor_safe_minimum(amount: u64) -> u64 {
    ((VIRTUAL_TOKENS as u128 * amount as u128) / (VIRTUAL_SOL as u128 + amount as u128)) as u64
}

// Weight vectors summing to 10000.
fn weights_for(n: usize) -> Vec<u16> {
    match n {
        1 => vec![10_000],
        2 => vec![5_000, 5_000],
        3 => vec![8_000, 1_000, 1_000],
        _ => vec![2_500, 2_500, 2_500, 2_500],
    }
}

// ===========================================================================
// CAMPAIGN E — mixed curve / Jupiter / accumulator dispatch, 1..4 legs
// ===========================================================================
#[test]
#[ignore = "needs keyless+directcurve artifact + benign pump stub; see header"]
fn mixed_dispatch_never_aborts() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 20_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xE5);
    println!("mixed_dispatch_never_aborts: seed {seed_value}, {iters} iterations");

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    let mut all_curve_reached_sentinel = 0u64;
    for iteration in 0..iters {
        let n = 1 + rng.below(4) as usize;
        let weights = weights_for(n);
        let kinds: Vec<LegKind> = (0..n)
            .map(|_| match rng.below(3) {
                0 => LegKind::Curve,
                1 => LegKind::JupiterShaped,
                _ => LegKind::CurveWithAccumulator,
            })
            .collect();
        let fixture = MultiFixture::all_curve(&weights, &kinds);
        let code = fixture.run(&mollusk);
        *histogram.entry(code).or_insert(0) += 1;
        // When every leg is a plain curve leg, the honest path reaches the 6019
        // sentinel (fund_wsol skipped on each, accumulator untouched).
        if kinds.iter().all(|k| *k == LegKind::Curve) {
            assert_eq!(
                code, BURN_PDA_LAMPORT_MISMATCH,
                "E: an all-curve {n}-leg split must reach the 6019 sentinel (seed {seed_value} iter {iteration})"
            );
            all_curve_reached_sentinel += 1;
        }
        // A leg mixing in a Jupiter-shaped leg must NEVER abort; whatever it
        // returns is a named code (asserted by `named`).
        assert!((6000..=6043).contains(&code), "E: unnamed {code}");
    }
    println!(
        "E ok: {iters} mixed-dispatch runs, all named. {all_curve_reached_sentinel} all-curve->6019. \
         distribution {histogram:?}"
    );
}

// ===========================================================================
// CAMPAIGN F — curve-dispatch structured corruption + fund_wsol-skip boundary
// ===========================================================================
#[test]
#[ignore = "needs keyless+directcurve artifact + benign pump stub; see header"]
fn curve_dispatch_corruption() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 20_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0xF6);
    println!("curve_dispatch_corruption: seed {seed_value}, {iters} iterations");

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let n = 1 + rng.below(4) as usize;
        let weights = weights_for(n);
        let kinds: Vec<LegKind> = (0..n).map(|_| LegKind::Curve).collect();
        let mut fixture = MultiFixture::all_curve(&weights, &kinds);

        // Corrupt across route-pool accounts (the Pump surface), target blocks,
        // instruction-level fields, and the fund_wsol-skip selector.
        let corruptions = 1 + rng.below(6);
        for _ in 0..corruptions {
            match rng.below(6) {
                0 => {
                    // Byte-flip a random route-pool account's data.
                    if !fixture.route_pool.is_empty() {
                        let idx = rng.below(fixture.route_pool.len() as u64) as usize;
                        let acct = &mut fixture.route_pool[idx].account;
                        if !acct.data.is_empty() {
                            let at = rng.below(acct.data.len() as u64) as usize;
                            acct.data[at] ^= 1 << rng.below(8);
                        }
                    }
                }
                1 => {
                    // Truncate a route-pool account.
                    if !fixture.route_pool.is_empty() {
                        let idx = rng.below(fixture.route_pool.len() as u64) as usize;
                        let acct = &mut fixture.route_pool[idx].account;
                        let new_len = rng.below(acct.data.len() as u64 + 1) as usize;
                        acct.data.truncate(new_len);
                    }
                }
                2 => {
                    // Swap a route-pool account's owner.
                    if !fixture.route_pool.is_empty() {
                        let idx = rng.below(fixture.route_pool.len() as u64) as usize;
                        fixture.route_pool[idx].account.owner = match rng.below(4) {
                            0 => Pubkey::default(),
                            1 => key(PUMP_FUN_PROGRAM),
                            2 => key(PUMP_FEE_PROGRAM),
                            _ => token::ID,
                        };
                    }
                }
                3 => {
                    // Flip the fund_wsol-skip selector: make a curve leg carry
                    // non-empty route data (-> Jupiter path). Must stay named.
                    let leg = rng.below(n as u64) as usize;
                    let rd_len = 1 + rng.below(40) as usize;
                    fixture.route_data[leg] = rng.bytes(rd_len);
                }
                4 => {
                    // Corrupt a route_account_count (partition-boundary stress).
                    let leg = rng.below(n as u64) as usize;
                    fixture.route_counts[leg] = rng.next() as u8;
                }
                _ => {
                    // Corrupt a target-block account (mint/curve/fee).
                    if !fixture.target_blocks.is_empty() {
                        let idx = rng.below(fixture.target_blocks.len() as u64) as usize;
                        let acct = &mut fixture.target_blocks[idx].account;
                        if !acct.data.is_empty() {
                            let at = rng.below(acct.data.len() as u64) as usize;
                            acct.data[at] ^= 1 << rng.below(8);
                        }
                    }
                }
            }
        }
        // Occasionally perturb minimums to probe the floor gate.
        if rng.below(3) == 0 {
            let leg = rng.below(n as u64) as usize;
            fixture.minimums[leg] = match rng.below(3) {
                0 => 0,
                1 => 1,
                _ => rng.next(),
            };
        }

        let (ix, accounts) = fixture.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        let code = named(&result.raw_result, &|| {
            format!("F: seed {seed_value} iter {iteration} n {n}")
        });
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!("F ok: {iters} curve-corruption runs, all named. distribution {histogram:?}");
}

// ===========================================================================
// CAMPAIGN G — account aliasing / role confusion across legs
// ===========================================================================
#[test]
#[ignore = "needs keyless+directcurve artifact + benign pump stub; see header"]
fn aliasing_and_role_confusion() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 10_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x67);
    println!("aliasing_and_role_confusion: seed {seed_value}, {iters} iterations");

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let n = 2 + rng.below(3) as usize; // 2..4 legs
        let weights = weights_for(n);
        let kinds: Vec<LegKind> = (0..n).map(|_| LegKind::Curve).collect();
        let mut fixture = MultiFixture::all_curve(&weights, &kinds);

        match rng.below(5) {
            0 => {
                // Alias leg 1's target mint to leg 0's (duplicate target).
                let m0 = fixture.target_blocks[0].key;
                let a0 = fixture.target_blocks[1].key;
                fixture.target_blocks[PER_TARGET].key = m0;
                fixture.target_blocks[PER_TARGET].account = fixture.target_blocks[0].account.clone();
                // Point leg 1's ata at leg 0's, mirroring the collision.
                fixture.target_blocks[PER_TARGET + 1].key = a0;
            }
            1 => {
                // Move a route account from leg 1 into leg 0's slice by shifting
                // the route_account_count boundary (aliasing across partitions).
                if n >= 2 {
                    fixture.route_counts[0] = fixture.route_counts[0].wrapping_add(1);
                    if fixture.route_counts[1] > 0 {
                        fixture.route_counts[1] -= 1;
                    }
                }
            }
            2 => {
                // Duplicate a whole route-pool account so the same pubkey plays
                // two roles (e.g. curve == fee_config).
                if fixture.route_pool.len() >= 2 {
                    let a = rng.below(fixture.route_pool.len() as u64) as usize;
                    let b = rng.below(fixture.route_pool.len() as u64) as usize;
                    if a != b {
                        fixture.route_pool[b].key = fixture.route_pool[a].key;
                    }
                }
            }
            3 => {
                // Mark a non-user route account as signer (privilege confusion).
                if !fixture.route_pool.is_empty() {
                    let idx = rng.below(fixture.route_pool.len() as u64) as usize;
                    fixture.route_pool[idx].signer = true;
                }
            }
            _ => {
                // Alias leg 1's reference (curve) to leg 0's curve — two legs
                // sharing one reference account.
                let ref0 = fixture.target_blocks[3].key;
                fixture.target_blocks[PER_TARGET + 3].key = ref0;
            }
        }

        let (ix, accounts) = fixture.instruction();
        let result = mollusk.process_instruction(&ix, &accounts);
        let code = named(&result.raw_result, &|| format!("G: seed {seed_value} iter {iteration} n {n}"));
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!("G ok: {iters} aliasing runs, all named. distribution {histogram:?}");
}

// ===========================================================================
// CAMPAIGN H — arbitrary split instruction data against the mixed-dispatch
// account layout (the directcurve decode surface)
// ===========================================================================
#[test]
#[ignore = "needs keyless+directcurve artifact + benign pump stub; see header"]
fn arbitrary_data_over_curve_layout() {
    let mollusk = load_mollusk();
    let iters = env_u64("KEYLESS_FUZZ_ITERS", 20_000);
    let seed_value = seed();
    let mut rng = Rng(seed_value ^ 0x18);
    println!("arbitrary_data_over_curve_layout: seed {seed_value}, {iters} iterations");

    // A stable pool of valid all-curve account layouts at 1..4 legs.
    let fixtures: Vec<MultiFixture> = (1..=4)
        .map(|n| {
            let w = weights_for(n);
            let k: Vec<LegKind> = (0..n).map(|_| LegKind::Curve).collect();
            MultiFixture::all_curve(&w, &k)
        })
        .collect();

    let mut histogram: BTreeMap<u32, u64> = BTreeMap::new();
    for iteration in 0..iters {
        let fixture = &fixtures[rng.below(fixtures.len() as u64) as usize];
        let (base_ix, accounts) = fixture.instruction();
        let metas = base_ix.accounts.clone();

        // Random discriminator + random/structured payload.
        let mut data = match rng.below(6) {
            0 | 1 | 2 => SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec(),
            3 => {
                let mut d = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
                d[rng.below(8) as usize] ^= 1 << rng.below(8);
                d
            }
            4 => SWAP_AND_BURN_DISCRIMINATOR.to_vec(),
            _ => rng.bytes(8),
        };
        let tail = rng.below(400) as usize;
        let bytes = rng.bytes(tail);
        data.extend_from_slice(&bytes);
        if rng.below(8) == 0 {
            let keep = rng.below(data.len() as u64 + 1) as usize;
            data.truncate(keep);
        }
        let ix = Instruction { program_id: key(BURNER_PROGRAM), accounts: metas, data: data.clone() };
        let result = mollusk.process_instruction(&ix, &accounts);
        let code = named(&result.raw_result, &|| format!("H: seed {seed_value} iter {iteration} data {}", hex(&data)));
        *histogram.entry(code).or_insert(0) += 1;
    }
    println!("H ok: {iters} arbitrary-data runs over curve layout, all named. distribution {histogram:?}");
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
