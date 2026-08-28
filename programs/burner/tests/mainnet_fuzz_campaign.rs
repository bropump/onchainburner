//! Shipping-artifact (production/KMS) fuzz campaign with an explicit
//! outcome-code HISTOGRAM and an exact-value 128-bit DIFFERENTIAL, plus
//! support for pointing the harness at a MUTANT artifact so detection power
//! is proven by mutation rather than asserted.
//!
//! This complements `fuzz_artifact.rs` (which asserts named-rejection but
//! prints no distribution). Here every campaign tallies the exact
//! `Custom(code)` distribution and reports it, and the differential counts
//! agreements/disagreements against an independent 128-bit reference.
//!
//! Artifact selection: `BURNER_ARTIFACT_OVERRIDE=/path/to/mutant.so` swaps the
//! loaded ELF without touching `target/deploy` (so a mutant never clobbers the
//! shared shipping artifact). Default is the pinned production artifact.
//!
//! Knobs:
//!   * `BURNER_FUZZ_ITERS`        arbitrary-instruction iterations (default 20000)
//!   * `BURNER_FUZZ_ARITH_ITERS`  differential iterations (default BURNER_FUZZ_ITERS/2)
//!   * `BURNER_FUZZ_SEED`         fix the RNG seed to reproduce
//!   * `BURNER_ALLOW_UNNAMED=1`   report (do not fail on) non-named outcomes — for mutant runs
//!   * `BURNER_ALLOW_MISMATCH=1`  report (do not fail on) differential disagreements — for mutant runs
//!
//! Ignored by the ordinary host suite; run with `-- --ignored`.

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

const BURNER_PROGRAM: &str = "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const QUOTE_AUTHORITY: &str = "Afs7CEFqSHNXFo5r6XhUmGYAzhC7qnKKA1UPUMU8quz8";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const VALIDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [28, 98, 92, 82, 243, 62, 65, 93];
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
const ROUTE_V2_PREFIX_LEN: usize = 34;
const ROUTE_V2_IN_AMOUNT_OFFSET: usize = 8;

/// Raydium V4 program id: the deep constant-product reference the keyless
/// differential binds every leg to.
const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];
const DEEP_RESERVE: u64 = u64::MAX / 2;
const DEEP_FEE_NUM: u64 = 25;
const DEEP_FEE_DEN: u64 = 10_000;

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
fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|v| v == "1" || v == "true").unwrap_or(false)
}
fn seed() -> u64 {
    std::env::var("BURNER_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos() as u64
    })
}

fn artifact_path() -> PathBuf {
    if let Ok(p) = std::env::var("BURNER_ARTIFACT_OVERRIDE") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy/pinocchio_parity.so")
}

fn load_mollusk() -> Mollusk {
    let path = artifact_path();
    assert!(path.is_file(), "missing burner ELF: {}", path.display());
    println!("artifact: {}", path.display());
    let mut mollusk = Mollusk::default();
    token::add_program(&mut mollusk);
    mollusk.add_program_with_loader_and_elf(
        &key(BURNER_PROGRAM),
        &program::loader_keys::LOADER_V3,
        &fs::read(&path).expect("read burner ELF"),
    );
    mollusk
}

struct Shape {
    name: &'static str,
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    allow_ok_for_validate_config: bool,
}

fn split_bare_shape(len: usize) -> Shape {
    let jupiter = key(JUPITER_PROGRAM);
    let mut metas = Vec::new();
    let mut accounts = Vec::new();
    for index in 0..len {
        let (pubkey, account, signer, writable) = match index {
            0 => (Pubkey::new_from_array([10; 32]), system_account(1_000_000), true, false),
            1 => (key(QUOTE_AUTHORITY), system_account(1_000_000), true, false),
            2 => (Pubkey::new_from_array([2; 32]), system_account(1_000_000), false, true),
            3 => (Pubkey::new_from_array([3; 32]), system_account(1_000_000), false, true),
            5 => (Pubkey::default(), Account::default(), false, false),
            6 => (token::ID, Account::default(), false, false),
            7 => (jupiter, program::create_program_account_loader_v3(&jupiter), false, false),
            n => (
                Pubkey::new_from_array([0x20 + n as u8; 32]),
                system_account(1),
                false,
                n % 3 == 2,
            ),
        };
        metas.push(if writable {
            AccountMeta::new(pubkey, signer)
        } else {
            AccountMeta::new_readonly(pubkey, signer)
        });
        if pubkey == Pubkey::default() {
            accounts.push(program::keyed_account_for_system_program());
        } else if pubkey == token::ID {
            accounts.push(token::keyed_account());
        } else {
            accounts.push((pubkey, account));
        }
    }
    Shape { name: "split-bare", metas, accounts, allow_ok_for_validate_config: false }
}

fn split_valid_shape(weights: &[u16], pda_lamports: u64) -> (Shape, Pubkey) {
    let burner_program = key(BURNER_PROGRAM);
    let wsol_mint = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let launch_mint = Pubkey::new_from_array([7; 32]);
    let target_mints: Vec<Pubkey> =
        (0..weights.len()).map(|i| Pubkey::new_from_array([0x60 + i as u8; 32])).collect();
    let mut blob = Vec::new();
    for w in weights {
        blob.extend_from_slice(&w.to_le_bytes());
    }
    let mut seeds: Vec<&[u8]> = vec![b"burner", launch_mint.as_ref()];
    for mint in &target_mints {
        seeds.push(mint.as_ref());
    }
    seeds.push(&blob);
    let (pda, _) = Pubkey::find_program_address(&seeds, &burner_program);
    let wsol_ata = associated_token_address(&pda, &wsol_mint);
    let caller = Pubkey::new_from_array([10; 32]);
    let mut metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(key(QUOTE_AUTHORITY), true),
        AccountMeta::new(pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(launch_mint, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
    ];
    let mut accounts = vec![
        (caller, system_account(1_000_000)),
        (key(QUOTE_AUTHORITY), system_account(1_000_000)),
        (pda, system_account(pda_lamports)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                wsol_mint,
                pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (launch_mint, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
    ];
    for mint in &target_mints {
        let ata = associated_token_address(&pda, mint);
        metas.push(AccountMeta::new(*mint, false));
        metas.push(AccountMeta::new(ata, false));
        metas.push(AccountMeta::new_readonly(token::ID, false));
        accounts.push((*mint, token::create_account_for_mint(immutable_mint(1, 6))));
        accounts.push((ata, token::create_account_for_token_account(token_account(*mint, pda, 0, None))));
    }
    (Shape { name: "split-valid", metas, accounts, allow_ok_for_validate_config: false }, pda)
}

fn single_valid_shape() -> Shape {
    let burner_program = key(BURNER_PROGRAM);
    let wsol_mint = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let launch_mint = Pubkey::new_from_array([7; 32]);
    let target_mint = Pubkey::new_from_array([8; 32]);
    let (pda, _) = Pubkey::find_program_address(
        &[b"burner", launch_mint.as_ref(), target_mint.as_ref()],
        &burner_program,
    );
    let wsol_ata = associated_token_address(&pda, &wsol_mint);
    let target_ata = associated_token_address(&pda, &target_mint);
    let caller = Pubkey::new_from_array([10; 32]);
    let metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(key(QUOTE_AUTHORITY), true),
        AccountMeta::new(pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(launch_mint, false),
        AccountMeta::new(target_mint, false),
        AccountMeta::new(target_ata, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
        AccountMeta::new_readonly(jupiter, false),
    ];
    let accounts = vec![
        (caller, system_account(1_000_000)),
        (key(QUOTE_AUTHORITY), system_account(1_000_000)),
        (pda, system_account(10_000_000_000)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(
                wsol_mint,
                pda,
                0,
                Some(RENT_FLOOR_ZERO_DATA),
            )),
        ),
        (launch_mint, token::create_account_for_mint(immutable_mint(0, 6))),
        (target_mint, token::create_account_for_mint(immutable_mint(1, 6))),
        (target_ata, token::create_account_for_token_account(token_account(target_mint, pda, 0, None))),
        token::keyed_account(),
        program::keyed_account_for_system_program(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
    ];
    Shape { name: "single-valid", metas, accounts, allow_ok_for_validate_config: false }
}

fn validate_config_shape() -> Shape {
    let burner_program = key(BURNER_PROGRAM);
    let wsol_mint = key(WSOL_MINT);
    let launch_mint = Pubkey::new_from_array([7; 32]);
    let target_mints = [Pubkey::new_from_array([0x60; 32]), Pubkey::new_from_array([0x61; 32])];
    let blob: Vec<u8> = [3_000u16, 7_000u16].iter().flat_map(|w| w.to_le_bytes()).collect();
    let seeds: Vec<&[u8]> = vec![
        b"burner",
        launch_mint.as_ref(),
        target_mints[0].as_ref(),
        target_mints[1].as_ref(),
        &blob,
    ];
    let (pda, _) = Pubkey::find_program_address(&seeds, &burner_program);
    let wsol_ata = associated_token_address(&pda, &wsol_mint);
    let mut metas = vec![
        AccountMeta::new_readonly(pda, false),
        AccountMeta::new_readonly(wsol_ata, false),
        AccountMeta::new_readonly(launch_mint, false),
    ];
    let mut accounts = vec![
        (pda, system_account(0)),
        (wsol_ata, system_account(0)),
        (launch_mint, token::create_account_for_mint(immutable_mint(0, 6))),
        token::keyed_account(),
    ];
    for mint in &target_mints {
        let ata = associated_token_address(&pda, mint);
        metas.push(AccountMeta::new_readonly(*mint, false));
        metas.push(AccountMeta::new_readonly(ata, false));
        metas.push(AccountMeta::new_readonly(token::ID, false));
        accounts.push((*mint, token::create_account_for_mint(immutable_mint(1, 6))));
        accounts.push((ata, system_account(0)));
    }
    Shape { name: "validate-config", metas, accounts, allow_ok_for_validate_config: true }
}

fn random_discriminator(rng: &mut Rng) -> Vec<u8> {
    match rng.below(8) {
        0 | 1 | 2 => SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec(),
        3 | 4 => SWAP_AND_BURN_DISCRIMINATOR.to_vec(),
        5 => VALIDATE_CONFIG_DISCRIMINATOR.to_vec(),
        6 => {
            let mut d = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
            let i = rng.below(8) as usize;
            d[i] ^= 1 << rng.below(8);
            d
        }
        _ => rng.bytes(8),
    }
}

fn split_payload(rng: &mut Rng, weights_hint: &[u16]) -> Vec<u8> {
    let total: u64 = match rng.below(4) {
        0 => 1 + rng.below(10_000_000_000),
        1 => rng.next().max(1),
        2 => rng.below(3),
        _ => u64::MAX - rng.below(20_000),
    };
    let mut data = total.to_le_bytes().to_vec();
    let use_hint = rng.below(3) == 0;
    let leg_count: usize = if use_hint { weights_hint.len() } else { rng.below(7) as usize };
    let declared: u32 = match rng.below(8) {
        0 => 0,
        1 => 5,
        2 => u32::MAX,
        3 => rng.next() as u32,
        _ => leg_count as u32,
    };
    data.extend_from_slice(&declared.to_le_bytes());
    for leg in 0..leg_count {
        let bps: u16 = if use_hint {
            weights_hint[leg]
        } else {
            match rng.below(6) {
                0 => 0,
                1 => rng.next() as u16,
                _ => 1 + rng.below(9_999) as u16,
            }
        };
        data.extend_from_slice(&bps.to_le_bytes());
        let minimum: u64 = if rng.below(8) == 0 { 0 } else { rng.next().max(1) };
        data.extend_from_slice(&minimum.to_le_bytes());
        data.push(if rng.below(4) == 0 { rng.next() as u8 } else { 0 });
        let route_len = rng.below(48) as usize;
        let route = rng.bytes(route_len);
        let declared_len: u32 = match rng.below(8) {
            0 => u32::MAX,
            1 => rng.next() as u32,
            2 => route.len() as u32 + 1,
            _ => route.len() as u32,
        };
        data.extend_from_slice(&declared_len.to_le_bytes());
        data.extend_from_slice(&route);
    }
    if rng.below(6) == 0 {
        let extra = rng.below(6) as usize + 1;
        let bytes = rng.bytes(extra);
        data.extend_from_slice(&bytes);
    }
    if rng.below(6) == 0 {
        let keep = rng.below(data.len() as u64 + 1) as usize;
        data.truncate(keep);
    }
    data
}

fn single_payload(rng: &mut Rng) -> Vec<u8> {
    let mut data = rng.next().max(1).to_le_bytes().to_vec();
    data.extend_from_slice(&rng.next().max(1).to_le_bytes());
    let route = match rng.below(3) {
        0 => {
            let len = rng.below(64) as usize;
            rng.bytes(len)
        }
        _ => {
            let mut r = JUPITER_ROUTE_V2_DISCRIMINATOR.to_vec();
            for _ in 0..3 {
                r.extend_from_slice(&rng.next().to_le_bytes());
            }
            r.extend_from_slice(&(rng.below(3) as u16).to_le_bytes());
            r.extend_from_slice(&(rng.below(3) as u16).to_le_bytes());
            r.extend_from_slice(&0u32.to_le_bytes());
            r
        }
    };
    let declared: u32 = match rng.below(6) {
        0 => u32::MAX,
        1 => route.len() as u32 + 1,
        2 => (route.len() as u32).wrapping_sub(1),
        _ => route.len() as u32,
    };
    data.extend_from_slice(&declared.to_le_bytes());
    data.extend_from_slice(&route);
    data
}

fn validate_config_payload(rng: &mut Rng) -> Vec<u8> {
    if rng.below(3) == 0 {
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&3_000u16.to_le_bytes());
        data.extend_from_slice(&7_000u16.to_le_bytes());
        return data;
    }
    let count = rng.below(7) as usize;
    let declared: u32 = match rng.below(6) {
        0 => u32::MAX,
        1 => rng.next() as u32,
        _ => count as u32,
    };
    let mut data = declared.to_le_bytes().to_vec();
    for _ in 0..count {
        data.extend_from_slice(&(rng.next() as u16).to_le_bytes());
    }
    data
}

fn reference_amounts(total: u64, weights: &[u16]) -> Vec<u64> {
    let mut amounts = Vec::with_capacity(weights.len());
    let mut allocated = 0u64;
    for &bps in &weights[..weights.len() - 1] {
        let amount = ((total as u128 * bps as u128) / 10_000) as u64;
        allocated += amount;
        amounts.push(amount);
    }
    amounts.push(total - allocated);
    amounts
}


fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Keyless split fixture: the bound derivation + 7-account deep-Raydium-v4 legs
// the merged build requires. The KMS `split_valid_shape` above carries only 3
// accounts per leg and no reference seeds, so the keyless handler refuses it
// 6028 before any arithmetic runs — which is why the pre-fix differential
// reported 0 agree / 10000 disagree with a 9912-dead canary.
// ---------------------------------------------------------------------------

fn raw_vault(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }
}

fn deep_v4_pool(vault_a: &Pubkey, vault_b: &Pubkey) -> Account {
    let mut data = vec![0u8; 400];
    data[144..152].copy_from_slice(&DEEP_FEE_NUM.to_le_bytes());
    data[152..160].copy_from_slice(&DEEP_FEE_DEN.to_le_bytes());
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

fn leg_pk(salt: u8, role: u8) -> Pubkey {
    let mut b = [0x7Au8; 32];
    b[1] = salt;
    b[2] = role;
    Pubkey::new_from_array(b)
}

/// (metas, accounts, pda) for a keyless split whose vault is derived WITH each
/// leg's reference address, every leg carrying the full 7-account block
/// (mint, ATA, token program, deep-V4 pool, vault_a, vault_b, fee == pool).
fn keyless_split_fixture(
    launch: &Pubkey,
    weights: &[u16],
    pda_lamports: u64,
) -> (Vec<AccountMeta>, Vec<(Pubkey, Account)>, Pubkey) {
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);

    let mints: Vec<Pubkey> = (0..weights.len()).map(|i| leg_pk(i as u8, 0)).collect();
    let pools: Vec<Pubkey> = (0..weights.len()).map(|i| leg_pk(i as u8, 4)).collect();

    let blob: Vec<u8> = weights.iter().flat_map(|w| w.to_le_bytes()).collect();
    let mut seeds: Vec<&[u8]> = vec![b"burner", launch.as_ref()];
    for m in &mints {
        seeds.push(m.as_ref());
    }
    seeds.push(&blob);
    for p in &pools {
        seeds.push(p.as_ref());
    }
    let (pda, _) = Pubkey::find_program_address(&seeds, &key(BURNER_PROGRAM));
    let wsol_ata = associated_token_address(&pda, &wsol);
    let caller = Pubkey::new_from_array([10; 32]);

    let mut metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(Pubkey::new_from_array([16; 32]), false), // unused slot 1
        AccountMeta::new(pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(*launch, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
    ];
    let mut accounts = vec![
        (caller, system_account(1_000_000)),
        (Pubkey::new_from_array([16; 32]), system_account(1_000_000)),
        (pda, system_account(pda_lamports)),
        (
            wsol_ata,
            token::create_account_for_token_account(token_account(wsol, pda, 0, Some(RENT_FLOOR_ZERO_DATA))),
        ),
        (*launch, token::create_account_for_mint(immutable_mint(0, 6))),
        program::keyed_account_for_system_program(),
        token::keyed_account(),
        (jupiter, program::create_program_account_loader_v3(&jupiter)),
    ];

    for (i, mint) in mints.iter().enumerate() {
        let ata = associated_token_address(&pda, mint);
        let pool = pools[i];
        let vault_a = leg_pk(i as u8, 5);
        let vault_b = leg_pk(i as u8, 6);
        let authority = leg_pk(i as u8, 7);
        metas.push(AccountMeta::new(*mint, false));
        metas.push(AccountMeta::new(ata, false));
        metas.push(AccountMeta::new_readonly(token::ID, false));
        metas.push(AccountMeta::new_readonly(pool, false));
        metas.push(AccountMeta::new_readonly(vault_a, false));
        metas.push(AccountMeta::new_readonly(vault_b, false));
        metas.push(AccountMeta::new_readonly(pool, false)); // fee_source == pool
        accounts.push((*mint, token::create_account_for_mint(immutable_mint(1_000_000, 6))));
        accounts.push((
            ata,
            token::create_account_for_token_account(token_account(*mint, pda, 0, None)),
        ));
        accounts.push((pool, deep_v4_pool(&vault_a, &vault_b)));
        accounts.push((vault_a, raw_vault(mint, &authority, DEEP_RESERVE)));
        accounts.push((vault_b, raw_vault(&wsol, &authority, DEEP_RESERVE)));
    }
    (metas, accounts, pda)
}

/// Split data: every leg carries a `route_v2` probe with the given `in_amount`
/// and `minimum_output`, no route accounts. `minimum == u64::MAX` admits every
/// floor, so leg 0's route validation adjudicates the embedded `in_amount`:
/// correct -> 6006, wrong -> 6008.
fn keyless_probe_data(total: u64, weights: &[u16], in_amounts: &[u64], minimum: u64) -> Vec<u8> {
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for (i, &bps) in weights.iter().enumerate() {
        data.extend_from_slice(&bps.to_le_bytes());
        data.extend_from_slice(&minimum.to_le_bytes());
        data.push(0);
        let mut route = vec![0u8; ROUTE_V2_PREFIX_LEN];
        route[..8].copy_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
        route[ROUTE_V2_IN_AMOUNT_OFFSET..ROUTE_V2_IN_AMOUNT_OFFSET + 8]
            .copy_from_slice(&in_amounts[i].to_le_bytes());
        data.extend_from_slice(&(route.len() as u32).to_le_bytes());
        data.extend_from_slice(&route);
    }
    data
}

/// Random weights of length 1..=4, each >= 100 bps, summing to 10_000 — so
/// every leg amount (for total >= 10_000) prices a nonzero floor and the
/// division is observed at 6006/6008, not the 6000/6002 dust orderings.
fn division_weights(rng: &mut Rng) -> Vec<u16> {
    let legs = 1 + rng.below(4) as usize;
    if legs == 1 {
        return vec![10_000];
    }
    let mut weights = vec![0u16; legs];
    let mut remaining = 10_000u64;
    for i in 0..legs - 1 {
        let legs_after = (legs - 1 - i) as u64;
        let hi = remaining - 100 * legs_after;
        let w = 100 + rng.below((hi - 100).max(1));
        weights[i] = w as u16;
        remaining -= w;
    }
    weights[legs - 1] = remaining as u16;
    weights
}

// ---------------------------------------------------------------------------
// Campaign 1: arbitrary-instruction fuzz with an explicit outcome histogram.
// ---------------------------------------------------------------------------
#[test]
#[ignore = "requires the pinned SBPFv3 artifact; run with -- --ignored"]
fn mainnet_named_outcome_histogram() {
    let mollusk = load_mollusk();
    let burner = key(BURNER_PROGRAM);
    let iterations = env_u64("BURNER_FUZZ_ITERS", 20_000);
    let allow_unnamed = env_flag("BURNER_ALLOW_UNNAMED");
    let seed = seed();
    println!("mainnet_named_outcome_histogram: seed {seed}, {iterations} iterations");
    let mut rng = Rng(seed);

    let shapes: Vec<Shape> = vec![
        split_bare_shape(20),
        split_bare_shape(13),
        split_bare_shape(11),
        split_bare_shape(7),
        split_bare_shape(0),
        split_valid_shape(&[3_000, 7_000], 10_000_000_000).0,
        single_valid_shape(),
        validate_config_shape(),
    ];

    let mut hist: BTreeMap<u32, u64> = BTreeMap::new();
    let mut ok_count: u64 = 0;
    let mut unnamed: Vec<String> = Vec::new();

    for iteration in 0..iterations {
        let shape = &shapes[rng.below(shapes.len() as u64) as usize];
        let mut data = random_discriminator(&mut rng);
        match rng.below(8) {
            0 | 1 => {
                let tail = rng.below(600) as usize;
                let bytes = rng.bytes(tail);
                data.extend_from_slice(&bytes);
            }
            2 | 3 | 4 => {
                let payload = split_payload(&mut rng, &[3_000, 7_000]);
                data.extend_from_slice(&payload);
            }
            5 | 6 => {
                let payload = single_payload(&mut rng);
                data.extend_from_slice(&payload);
            }
            _ => {
                let payload = validate_config_payload(&mut rng);
                data.extend_from_slice(&payload);
            }
        }
        if rng.below(16) == 0 {
            let keep = rng.below(data.len() as u64 + 1) as usize;
            data.truncate(keep);
        }

        let instruction = Instruction::new_with_bytes(burner, &data, shape.metas.clone());
        let result = mollusk.process_instruction(&instruction, &shape.accounts);
        let allow_ok = shape.allow_ok_for_validate_config
            && data.len() >= 8
            && data[..8] == VALIDATE_CONFIG_DISCRIMINATOR;
        match &result.raw_result {
            Ok(()) => {
                ok_count += 1;
                if !allow_ok {
                    unnamed.push(format!(
                        "UNEXPECTED Ok: seed {seed} iter {iteration} shape {} data {}",
                        shape.name,
                        hex(&data)
                    ));
                }
            }
            Err(InstructionError::Custom(code)) if (6000..=6043).contains(code) => {
                *hist.entry(*code).or_insert(0) += 1;
            }
            other => {
                unnamed.push(format!(
                    "NON-NAMED {other:?}: seed {seed} iter {iteration} shape {} data {}",
                    shape.name,
                    hex(&data)
                ));
            }
        }
    }

    println!("=== OUTCOME HISTOGRAM ({iterations} iterations, seed {seed}) ===");
    let total_named: u64 = hist.values().sum();
    for (code, count) in &hist {
        println!("  Custom({code}) : {count}");
    }
    println!("  Ok(validate_config) : {ok_count}");
    println!("  total named custom  : {total_named}");
    println!("  non-named outcomes  : {}", unnamed.len());
    for line in unnamed.iter().take(10) {
        println!("  !! {line}");
    }
    if !allow_unnamed {
        assert!(
            unnamed.is_empty(),
            "{} non-named/unexpected outcomes (first shown above)",
            unnamed.len()
        );
    }
}

// ---------------------------------------------------------------------------
// Campaign 2: exact-value 128-bit differential with agree/disagree counts.
// ---------------------------------------------------------------------------
#[test]
#[ignore = "requires the pinned SBPFv3 artifact; run with -- --ignored"]
fn mainnet_split_differential() {
    let mollusk = load_mollusk();
    let burner = key(BURNER_PROGRAM);
    let iterations = env_u64("BURNER_FUZZ_ARITH_ITERS", (env_u64("BURNER_FUZZ_ITERS", 20_000) / 2).max(1));
    let allow_mismatch = env_flag("BURNER_ALLOW_MISMATCH");
    let seed = seed();
    println!("mainnet_split_differential: seed {seed}, {iterations} iterations");
    let mut rng = Rng(seed);
    let launch = Pubkey::new_from_array([7; 32]);

    let mut agree: u64 = 0;
    let mut disagree: u64 = 0;
    let mut canary_live: u64 = 0;
    let mut canary_dead: u64 = 0;
    let mut vault_moved: u64 = 0;
    let mut samples: Vec<String> = Vec::new();

    // Domain: total in [10_000, 4e15], every weight >= 100 bps. Each leg amount
    // is then >= 100 and prices a nonzero floor on the deep reference, and the
    // total's ceiling is well under the ~2.3e16 fee cap, so the division is
    // observed cleanly at 6006/6008 (never colliding with cap/dust codes).
    for iteration in 0..iterations {
        let weights = division_weights(&mut rng);
        let total = 10_000 + rng.next() % (4_000_000_000_000_000u64 - 10_000);
        let amounts = reference_amounts(total, &weights);
        assert_eq!(amounts.iter().sum::<u64>(), total, "reference must conserve total");

        let pda_lamports = total + RENT_FLOOR_ZERO_DATA;
        let (metas, accounts, pda) = keyless_split_fixture(&launch, &weights, pda_lamports);

        // Correct leg-0 amount -> 6006 (Jupiter account-layout pin, reachable
        // only if the artifact's derived amount equals the 128-bit reference).
        let data = keyless_probe_data(total, &weights, &amounts, u64::MAX);
        let instruction = Instruction::new_with_bytes(burner, &data, metas.clone());
        let result = mollusk.process_instruction(&instruction, &accounts);
        if result.raw_result == Err(InstructionError::Custom(6006)) {
            agree += 1;
        } else {
            disagree += 1;
            if samples.len() < 12 {
                samples.push(format!(
                    "DISAGREE iter {iteration}: total {total} weights {weights:?} ref {amounts:?} expected Custom(6006) got {:?}",
                    result.raw_result
                ));
            }
        }

        let pda_after = result
            .resulting_accounts
            .iter()
            .find(|(k, _)| *k == pda)
            .map(|(_, a)| a.lamports)
            .unwrap_or(pda_lamports);
        if pda_after != pda_lamports {
            vault_moved += 1;
        }

        // Live-6008 canary EVERY iteration (the >= 100 bps domain makes every
        // leg reach the pin): a wrong leg-0 in_amount must be 6008, proving the
        // agreement above was the pin firing, not a blanket refusal.
        let mut wrong = amounts.clone();
        wrong[0] ^= 1;
        let data = keyless_probe_data(total, &weights, &wrong, u64::MAX);
        let instruction = Instruction::new_with_bytes(burner, &data, metas.clone());
        let result = mollusk.process_instruction(&instruction, &accounts);
        if result.raw_result == Err(InstructionError::Custom(6008)) {
            canary_live += 1;
        } else {
            canary_dead += 1;
        }
    }

    println!("=== SPLIT DIFFERENTIAL ({iterations} iterations, seed {seed}) ===");
    println!("  agree (artifact == 128-bit reference) : {agree}");
    println!("  disagree                              : {disagree}");
    println!("  live-6008 canary fired                : {canary_live}");
    println!("  canary dead (pin vacuous)             : {canary_dead}");
    println!("  vault moved on a rejection            : {vault_moved}");
    for s in samples.iter() {
        println!("  !! {s}");
    }
    if !allow_mismatch {
        assert_eq!(disagree, 0, "artifact disagreed with the 128-bit reference {disagree} times");
        assert_eq!(canary_live, iterations, "the 6008 in_amount pin did not fire on every iteration");
        assert_eq!(canary_dead, 0, "the 6008 in_amount pin was vacuous {canary_dead} times");
        assert_eq!(vault_moved, 0, "the vault moved on {vault_moved} rejections");
    }
}
