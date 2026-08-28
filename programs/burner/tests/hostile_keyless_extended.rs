//! EXTENDED hostile-Jupiter regression against the KEYLESS artifact.
//!
//! This file substantially extends `hostile_keyless_jupiter.rs` (14 cases,
//! 1-leg only). It drives the SAME real keyless artifact and the SAME hostile
//! fixture installed at the pinned Jupiter id, but generalises the harness to
//! N legs (1..=4) so it can attack the surface the prior suite explicitly did
//! NOT execute:
//!
//!   * multi-leg custody + cross-leg ATOMIC rollback (a hostile leg N must
//!     roll back the completed burns of legs 0..N-1 byte-identically);
//!   * multi-leg CROSS-ALIASING (the same account in two leg roles: a leg's
//!     reference as another leg's target ATA / vault / fee_source; the vault's
//!     own WSOL account in a pool-vault slot across legs);
//!   * the Pump / PumpSwap / DLMM / CLMM reference venues under a hostile
//!     route (the prior suite covered Raydium V4 only), the PumpSwap sentinel
//!     `creator` pin from every angle, and the reference-binding sentinel
//!     collision (two different Pump pools deriving the SAME vault);
//!   * a falsification attempt on the "target-block accounts are unreachable
//!     to a hostile route" argument (alias a reference into `route_pool`).
//!
//! BAR (unchanged): every refusal must be authored by the BURNER
//! (`InstructionError::Custom(600x)` from the real artifact), with every
//! watched account rolled back byte-identically; an honest multi-leg control
//! must BURN so a suite that refuses everything is distinguishable from a
//! working one.
//!
//! ARTIFACT AUTHENTICATION: identical 6027-at-dispatch probe as the prior
//! suite (`load_mollusk`), which uniquely pins a reference-BOUND keyless
//! build.
//!
//! RUN (same env vars as `hostile_keyless_jupiter.rs`):
//!   BURNER_KEYLESS_ELF=<dir>/pinocchio_parity_keyless.so \
//!   HOSTILE_KEYLESS_ELF=<dir>/hostile_keyless.so \
//!   rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
//!     --manifest-path programs/burner/Cargo.toml \
//!     --test hostile_keyless_extended -- --ignored --nocapture

#![allow(clippy::too_many_arguments, clippy::type_complexity)]

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

// ---- fixed identities (byte-for-byte the program's own constants) ----------
const BURNER_PROGRAM: &str = "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const JUPITER_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_EVENT_AUTHORITY: &str = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const PUMP_FUN_PROGRAM: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SWAP_AND_BURN_DISCRIMINATOR: [u8; 8] = [238, 187, 75, 164, 53, 245, 200, 172];
const SWAP_AND_BURN_SPLIT_DISCRIMINATOR: [u8; 8] = [157, 45, 186, 225, 142, 17, 2, 105];
const JUPITER_ROUTE_V2_DISCRIMINATOR: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];

const RAYDIUM_V4: [u8; 32] = [
    75, 217, 73, 196, 54, 2, 195, 63, 32, 119, 144, 237, 22, 163, 82, 76, 161, 185, 151, 92, 241,
    33, 162, 169, 12, 255, 236, 125, 248, 182, 138, 205,
];

// ---- named error codes (append-only, client-visible) -----------------------
const E_INVALID_BURN_PDA: u32 = 6012;
const E_INVALID_TOKEN_ACCOUNT_OWNER: u32 = 6011;
const E_INVALID_TOKEN_ACCOUNT_DATA: u32 = 6014;
const E_WSOL_NOT_CONSUMED: u32 = 6018;
const E_BURN_PDA_LAMPORT: u32 = 6019;
const E_TARGET_DECREASED: u32 = 6020;
const E_SLIPPAGE: u32 = 6021;
const E_INTERMEDIATE: u32 = 6023;
const E_DUPLICATE_TARGET: u32 = 6034;
const E_ENCUMBERED: u32 = 6035;
const E_INVALID_INSTRUCTION: u32 = 6027;
const E_REFERENCE_INVALID: u32 = 6039;
const E_REFERENCE_CAP: u32 = 6040;
const E_REFERENCE_SHALLOW: u32 = 6041;
const E_TARGET_PRE_CALL_MISMATCH: u32 = 6042;
const E_PRE_EXISTING_BALANCE_UNACCOUNTED: u32 = 6043;

// ---- floor tuning (constant-product, Raydium V4): floor == 1 unit ----------
const AMOUNT_IN: u64 = 1_000_000;
const FEE_NUM: u64 = 25;
const FEE_DEN: u64 = 10_000;
const REF_RT: u64 = 120_000;
const MIN_DEPTH: u64 = 50_000_000_000;
const REF_RS: u64 = MIN_DEPTH;
const KEYLESS_TOL_BPS: u64 = 100;

// hostile fixture modes (superset of the KMS fixture; 9 == honest JUST_SWAP)
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
const MODE_DRAIN_ROUTE_SOURCE: u8 = 10;

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

/// Raw SPL token account (mint 0..32, owner 32..64, amount 64..72).
fn raw_vault(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }
}

/// Raydium V4 pool: vaults at 336/368, fee num/den at 144/152, fee_source == self.
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

fn derived_floor(rt: u64, rs: u64, amount_in: u64, fee_num: u64, fee_den: u64) -> u64 {
    let inp = (amount_in as u128) * ((fee_den - fee_num) as u128) / fee_den as u128;
    let expected = (rt as u128) * inp / (rs as u128 + inp);
    (expected * (10_000 - KEYLESS_TOL_BPS) as u128 / 10_000) as u64
}

/// Program's per-leg amount split (mirrors `handler`: floor division, final
/// leg absorbs the remainder).
fn leg_amounts(total: u64, weights: &[u16]) -> Vec<u64> {
    let n = weights.len();
    let mut out = Vec::with_capacity(n);
    let mut allocated = 0u64;
    let q = total / 10_000;
    let r = total % 10_000;
    for (i, &bps) in weights.iter().enumerate() {
        let amt = if i + 1 == n {
            total - allocated
        } else {
            q * bps as u64 + (r * bps as u64) / 10_000
        };
        allocated += amt;
        out.push(amt);
    }
    out
}

/// Pack bps LE, leg order (mirrors `pack_bps_blob`, slice `..2*leg_count`).
fn bps_blob(weights: &[u16]) -> Vec<u8> {
    let mut b = Vec::with_capacity(2 * weights.len());
    for &w in weights {
        b.extend_from_slice(&w.to_le_bytes());
    }
    b
}

/// The reference seed for one leg: address for address-bound venues, the
/// `[0u8;32]` sentinel for the two Pump venues (mirrors `build_split_seeds`).
fn ref_seed(reference: &Pubkey, is_pump_venue: bool) -> [u8; 32] {
    if is_pump_venue {
        [0u8; 32]
    } else {
        reference.to_bytes()
    }
}

/// Derive the split vault, seed order exactly as `build_split_seeds`:
/// BURNER, launch, mint_0..mint_{n-1}, bps_blob, refseed_0..refseed_{n-1}.
fn derive_split_vault(launch: &Pubkey, legs: &[(Pubkey, [u8; 32])], weights: &[u16]) -> Pubkey {
    let blob = bps_blob(weights);
    let mut seeds: Vec<Vec<u8>> = Vec::new();
    seeds.push(b"burner".to_vec());
    seeds.push(launch.to_bytes().to_vec());
    for (mint, _) in legs {
        seeds.push(mint.to_bytes().to_vec());
    }
    seeds.push(blob);
    for (_, rseed) in legs {
        seeds.push(rseed.to_vec());
    }
    let refs: Vec<&[u8]> = seeds.iter().map(|v| v.as_slice()).collect();
    Pubkey::find_program_address(&refs, &key(BURNER_PROGRAM)).0
}

// ---------------------------------------------------------------------------
// Generalised N-leg builder.
// ---------------------------------------------------------------------------

/// One leg's configuration. `reference`/`vault_a`/`vault_b`/`fee_source` are
/// the 4 keyless target-block accounts after (mint, ata, token_program). A
/// Raydium V4 leg is the default; other venues override `*_account`.
#[derive(Clone)]
struct LegSpec {
    bps: u16,
    mode: u8,
    /// If None, minimum_output is set to the derived floor for this leg amount.
    minimum_output: Option<u64>,
    target_mint: Pubkey,
    reference: Pubkey,
    reference_account: Account,
    is_pump_venue: bool,
    vault_a: Pubkey,
    vault_a_account: Account,
    vault_b: Pubkey,
    vault_b_account: Account,
    fee_source: Pubkey,
    fee_source_account: Option<Account>,
    target_ata_amount: u64,
    target_source_amount: u64,
    /// Override the reference pubkey placed in the target block WITHOUT
    /// changing the address bound into the seed (a binding-substitution attack).
    present_reference_addr: Option<Pubkey>,
    /// Override the account placed at the target-block ATA slot (aliasing).
    override_target_ata: Option<(Pubkey, Account)>,
    /// Override the account placed at the target-block vault_b slot (aliasing).
    override_vault_b: Option<(Pubkey, Account)>,
    /// Replace the pubkey placed at ROUTE slot 10 (the fixture's target-source)
    /// WITHOUT adding an account. Used to alias a venue-owned target-block
    /// account into a fixture-writable route slot (reachability falsification).
    route_target_source: Option<Pubkey>,
    /// Enable fixture mode 10. The builder appends the leg's ordinary target
    /// source at slot 14 and this same-mint sink at slot 15, leaving slot 10
    /// free for `route_target_source` to nominate the balance being erased.
    route_balance_sink: Option<(Pubkey, Account)>,
    /// Append one arbitrary route account. Used both to place a newly-created
    /// balance source in the account map and to prove an untouched unsolicited
    /// vault balance does not disable an otherwise valid burn.
    extra_route_account: Option<(Pubkey, Account)>,
    /// Append a Pump `user_volume_accumulator` account to this leg's route
    /// (accumulator-credit seam). The hostile JUST_SWAP fixture never closes
    /// it, so the exact conservation equality must refuse (6019).
    accumulator: Option<AccumSpec>,
}

#[derive(Clone, Copy)]
enum AccumKind {
    Valid,     // Pump-owned, correct disc, stored-user == pda, nonzero lamports
    WrongUser, // stored-user != pda
    WrongDisc, // wrong discriminator
    WrongOwner, // not owned by the Pump program
}

#[derive(Clone, Copy)]
struct AccumSpec {
    pump_fun: bool, // true => PUMP_FUN accumulator, false => PUMP_SWAP
    kind: AccumKind,
}

/// A default Raydium-V4 leg tuned so its floor == 1 for AMOUNT_IN-scale legs.
fn v4_leg(bps: u16, mode: u8, idx: u8) -> LegSpec {
    let target_mint = Pubkey::new_from_array([0x50 | idx; 32]);
    let reference = Pubkey::new_from_array([0x60 | idx; 32]);
    let vault_a = Pubkey::new_from_array([0x70 | idx; 32]);
    let vault_b = Pubkey::new_from_array([0x80 | idx; 32]);
    let pool_authority = Pubkey::new_from_array([0x90 | idx; 32]);
    let wsol = key(WSOL_MINT);
    LegSpec {
        bps,
        mode,
        minimum_output: None,
        target_mint,
        reference,
        reference_account: raydium_v4_pool(&vault_a, &vault_b, FEE_NUM, FEE_DEN),
        is_pump_venue: false,
        vault_a,
        vault_a_account: raw_vault(&target_mint, &pool_authority, REF_RT),
        vault_b,
        vault_b_account: raw_vault(&wsol, &pool_authority, REF_RS),
        fee_source: reference, // Raydium V4 stores the fee in its own pool state
        fee_source_account: None,
        target_ata_amount: 0,
        target_source_amount: 1,
        present_reference_addr: None,
        override_target_ata: None,
        override_vault_b: None,
        route_target_source: None,
        route_balance_sink: None,
        extra_route_account: None,
        accumulator: None,
    }
}

struct Built {
    metas: Vec<AccountMeta>,
    accounts: Vec<(Pubkey, Account)>,
    burn_pda: Pubkey,
    watch: Vec<Pubkey>,
    leg_amounts: Vec<u64>,
    target_atas: Vec<Pubkey>,
}

/// The fixed attacker sinks shared across all legs.
fn attacker_key() -> Pubkey {
    Pubkey::new_from_array([0x11; 32])
}
fn wsol_recipient_key() -> Pubkey {
    Pubkey::new_from_array([0x12; 32])
}

fn build_multi(legs: &[LegSpec], total_amount_in: u64) -> Built {
    let wsol = key(WSOL_MINT);
    let jupiter = key(JUPITER_PROGRAM);
    let event_authority = key(JUPITER_EVENT_AUTHORITY);
    let system = Pubkey::default();
    let native_reserve = Rent::default().minimum_balance(165);
    let launch_mint = Pubkey::new_from_array([13; 32]);
    let caller = Pubkey::new_from_array([10; 32]);
    let quote_slot = Pubkey::new_from_array([16; 32]);
    let attacker = attacker_key();
    let wsol_recipient = wsol_recipient_key();

    let weights: Vec<u16> = legs.iter().map(|l| l.bps).collect();
    let amounts = leg_amounts(total_amount_in, &weights);

    // vault derivation binds each leg's (target_mint, ref_seed) + bps_blob
    let seed_legs: Vec<(Pubkey, [u8; 32])> = legs
        .iter()
        .map(|l| (l.target_mint, ref_seed(&l.reference, l.is_pump_venue)))
        .collect();
    let burn_pda = derive_split_vault(&launch_mint, &seed_legs, &weights);
    let wsol_ata = associated_token_address(&burn_pda, &wsol);

    let mut accounts: Vec<(Pubkey, Account)> = Vec::new();
    let mut push_unique = |accounts: &mut Vec<(Pubkey, Account)>, pk: Pubkey, acct: Account| {
        if !accounts.iter().any(|(c, _)| *c == pk) {
            accounts.push((pk, acct));
        }
    };

    let pda_start = total_amount_in + 3_000_000;
    push_unique(&mut accounts, caller, system_account(1_000_000));
    push_unique(&mut accounts, quote_slot, system_account(1_000_000));
    push_unique(&mut accounts, burn_pda, system_account(pda_start));
    push_unique(
        &mut accounts,
        wsol_ata,
        token::create_account_for_token_account(token_account(wsol, burn_pda, 0, Some(native_reserve))),
    );
    push_unique(&mut accounts, launch_mint, token::create_account_for_mint(immutable_mint(0, 6)));
    let (sys_pk, sys_acct) = program::keyed_account_for_system_program();
    push_unique(&mut accounts, sys_pk, sys_acct);
    let (tok_pk, tok_acct) = token::keyed_account();
    push_unique(&mut accounts, tok_pk, tok_acct);
    push_unique(&mut accounts, jupiter, program::create_program_account_loader_v3(&jupiter));
    push_unique(&mut accounts, wsol, token::create_account_for_mint(immutable_mint(0, 9)));
    push_unique(&mut accounts, event_authority, system_account(1));
    push_unique(&mut accounts, attacker, system_account(9));
    push_unique(
        &mut accounts,
        wsol_recipient,
        token::create_account_for_token_account(token_account(wsol, attacker, 0, Some(native_reserve))),
    );

    // ---- fixed metas ----
    let mut metas = vec![
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(quote_slot, false),
        AccountMeta::new(burn_pda, false),
        AccountMeta::new(wsol_ata, false),
        AccountMeta::new_readonly(launch_mint, false),
        AccountMeta::new_readonly(system, false),
        AccountMeta::new_readonly(token::ID, false),
        AccountMeta::new_readonly(jupiter, false),
    ];

    // ---- per-leg target blocks (7 accounts each) ----
    let mut target_atas = Vec::new();
    let mut target_sources = Vec::new();
    for (i, leg) in legs.iter().enumerate() {
        let target_ata = associated_token_address(&burn_pda, &leg.target_mint);
        let target_source = Pubkey::new_from_array([0xA0 | (i as u8); 32]);
        target_atas.push(target_ata);
        target_sources.push(target_source);

        // mint + ATA accounts
        push_unique(
            &mut accounts,
            leg.target_mint,
            token::create_account_for_mint(immutable_mint(1_000_000, 6)),
        );
        // Always provide the DERIVED target ATA (the route metas reference it).
        push_unique(
            &mut accounts,
            target_ata,
            token::create_account_for_token_account(token_account(
                leg.target_mint,
                burn_pda,
                leg.target_ata_amount,
                None,
            )),
        );
        // The target-BLOCK ATA slot may be aliased to a different account.
        let ata_addr = if let Some((addr, acct)) = leg.override_target_ata.clone() {
            push_unique(&mut accounts, addr, acct);
            addr
        } else {
            target_ata
        };
        // reference / vault_a / vault_b / fee_source
        push_unique(&mut accounts, leg.reference, leg.reference_account.clone());
        push_unique(&mut accounts, leg.vault_a, leg.vault_a_account.clone());
        let (vb_addr, vb_acct) =
            leg.override_vault_b.clone().unwrap_or((leg.vault_b, leg.vault_b_account.clone()));
        push_unique(&mut accounts, vb_addr, vb_acct);
        if let Some(fs) = &leg.fee_source_account {
            push_unique(&mut accounts, leg.fee_source, fs.clone());
        }
        // intermediate token account the fixture pulls the deposited unit from
        push_unique(
            &mut accounts,
            target_source,
            token::create_account_for_token_account(token_account(
                leg.target_mint,
                burn_pda,
                leg.target_source_amount,
                None,
            )),
        );

        let reference_meta = leg.present_reference_addr.unwrap_or(leg.reference);
        metas.push(AccountMeta::new(leg.target_mint, false));
        metas.push(AccountMeta::new(ata_addr, false));
        metas.push(AccountMeta::new_readonly(token::ID, false));
        metas.push(AccountMeta::new_readonly(reference_meta, false));
        metas.push(AccountMeta::new_readonly(leg.vault_a, false));
        metas.push(AccountMeta::new_readonly(vb_addr, false));
        metas.push(AccountMeta::new_readonly(leg.fee_source, false));
    }

    // ---- per-leg route pools (14-account direct-V2 hostile slice each) ----
    for (i, leg) in legs.iter().enumerate() {
        let target_ata = target_atas[i];
        let target_source = leg.route_target_source.unwrap_or(target_sources[i]);
        if let Some((sink, sink_account)) = &leg.route_balance_sink {
            push_unique(&mut accounts, *sink, sink_account.clone());
        }
        if let Some((extra, extra_account)) = &leg.extra_route_account {
            push_unique(&mut accounts, *extra, extra_account.clone());
        }
        metas.push(AccountMeta::new(burn_pda, false)); // 0 authority
        metas.push(AccountMeta::new(wsol_ata, false)); // 1 source (WSOL)
        metas.push(AccountMeta::new(target_ata, false)); // 2 user destination
        metas.push(AccountMeta::new(wsol, false)); // 3 source mint
        metas.push(AccountMeta::new_readonly(leg.target_mint, false)); // 4 dest mint
        metas.push(AccountMeta::new_readonly(token::ID, false)); // 5 source token program
        metas.push(AccountMeta::new_readonly(token::ID, false)); // 6 dest token program
        metas.push(AccountMeta::new(target_ata, false)); // 7 destination
        metas.push(AccountMeta::new_readonly(event_authority, false)); // 8 event authority
        metas.push(AccountMeta::new_readonly(jupiter, false)); // 9 program
        metas.push(AccountMeta::new(target_source, false)); // 10 fixture: target source
        metas.push(AccountMeta::new(attacker, false)); // 11 fixture: attacker
        metas.push(AccountMeta::new_readonly(system, false)); // 12 fixture: system
        metas.push(AccountMeta::new(wsol_recipient, false)); // 13 fixture: wsol recipient
        // Mode 10 keeps the ordinary swap source at slot 14, then drains the
        // substituted slot-10 account into the same-mint sink at slot 15.
        if let Some((sink, _)) = &leg.route_balance_sink {
            metas.push(AccountMeta::new(target_sources[i], false)); // 14 honest output source
            metas.push(AccountMeta::new(*sink, false)); // 15 erased-balance sink
        }
        if let Some((extra, _)) = &leg.extra_route_account {
            metas.push(AccountMeta::new(*extra, false));
        }
        // Optional trailing Pump accumulator riding in the route.
        if let Some(spec) = leg.accumulator {
            let (addr, acct) = build_accumulator(&burn_pda, spec);
            push_unique(&mut accounts, addr, acct);
            metas.push(AccountMeta::new(addr, false));
        }
    }

    let mut watch = vec![burn_pda, wsol_ata, attacker, wsol_recipient];
    for i in 0..legs.len() {
        watch.push(target_atas[i]);
        watch.push(target_sources[i]);
        watch.push(legs[i].target_mint);
        // Also watch the venue-owned reference + its vaults: a hostile route
        // must never move the floor by mutating them.
        watch.push(legs[i].reference);
        watch.push(legs[i].vault_a);
        watch.push(legs[i].vault_b);
        if let Some(source) = legs[i].route_target_source {
            watch.push(source);
        }
        if let Some((sink, _)) = &legs[i].route_balance_sink {
            watch.push(*sink);
        }
        if let Some((extra, _)) = &legs[i].extra_route_account {
            watch.push(*extra);
        }
    }
    watch.sort();
    watch.dedup();

    Built { metas, accounts, burn_pda, watch, leg_amounts: amounts, target_atas }
}

fn route_data(mode: u8, amount_in: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(35);
    d.extend_from_slice(&JUPITER_ROUTE_V2_DISCRIMINATOR);
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&1u64.to_le_bytes());
    d.extend_from_slice(&50u16.to_le_bytes());
    d.extend_from_slice(&0u16.to_le_bytes());
    d.extend_from_slice(&0u16.to_le_bytes());
    d.extend_from_slice(&0u32.to_le_bytes());
    d.push(mode);
    d
}

fn instruction_data(legs: &[LegSpec], amounts: &[u64], total: u64) -> Vec<u8> {
    let mut data = SWAP_AND_BURN_SPLIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&total.to_le_bytes());
    data.extend_from_slice(&(legs.len() as u32).to_le_bytes());
    for (i, leg) in legs.iter().enumerate() {
        let amt = amounts[i];
        let route = route_data(leg.mode, amt);
        let minimum = leg.minimum_output.unwrap_or_else(|| {
            derived_floor(REF_RT, REF_RS, amt, FEE_NUM, FEE_DEN).max(1)
        });
        data.extend_from_slice(&leg.bps.to_le_bytes());
        data.extend_from_slice(&minimum.to_le_bytes());
        let route_accounts = 14usize
            + 2 * leg.route_balance_sink.is_some() as usize
            + leg.extra_route_account.is_some() as usize
            + leg.accumulator.is_some() as usize;
        data.push(u8::try_from(route_accounts).expect("test route count fits u8"));
        data.extend_from_slice(&(route.len() as u32).to_le_bytes());
        data.extend_from_slice(&route);
    }
    data
}

fn account<'a>(accounts: &'a [(Pubkey, Account)], k: &Pubkey) -> &'a Account {
    &accounts.iter().find(|(c, _)| c == k).expect("account exists").1
}

fn artifact_path() -> PathBuf {
    if let Ok(p) = std::env::var("BURNER_KEYLESS_ELF") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/deploy/pinocchio_parity_keyless.so")
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
    assert!(burner.is_file(), "missing keyless burner ELF: {} (set BURNER_KEYLESS_ELF)", burner.display());
    assert!(fixture.is_file(), "missing hostile fixture ELF: {} (set HOSTILE_KEYLESS_ELF)", fixture.display());
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
    // AUTHENTICATE: reference-bound keyless build refuses the single-target
    // discriminator with 6027 at dispatch.
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
        "artifact at {} is NOT a reference-bound keyless build",
        burner.display(),
    );
    mollusk
}

/// Run a multi-leg case, assert the BURNER authored `expected_code`, and every
/// watched account rolled back byte-identically.
fn assert_all_metas_present(built: &Built, label: &str) {
    for m in &built.metas {
        assert!(
            built.accounts.iter().any(|(pk, _)| *pk == m.pubkey),
            "[{label}] meta account {} missing from account map",
            m.pubkey
        );
    }
}

fn expect_reject(mollusk: &Mollusk, legs: &[LegSpec], total: u64, expected_code: u32, label: &str) {
    let built = build_multi(legs, total);
    assert_all_metas_present(&built, label);
    let data = instruction_data(legs, &built.leg_amounts, total);
    let instruction = Instruction { program_id: key(BURNER_PROGRAM), accounts: built.metas.clone(), data };
    let result = mollusk.process_instruction(&instruction, &built.accounts);
    assert_eq!(
        result.raw_result,
        Err(InstructionError::Custom(expected_code)),
        "[{label}] expected BURNER reject {expected_code}, got {:?}",
        result.raw_result,
    );
    for pk in &built.watch {
        if !built.accounts.iter().any(|(c, _)| c == pk) { continue; }
        assert_eq!(
            account(&result.resulting_accounts, pk),
            account(&built.accounts, pk),
            "[{label}] account {pk} changed despite outer failure",
        );
    }
}

/// Run a multi-leg case that is refused NOT by the burner but by the SVM
/// runtime (e.g. a non-final-leg PDA owner-change tripping the next leg's
/// funding). Asserts: the transaction failed, the failure is NOT a burner
/// Custom code, and every watched account rolled back byte-identically. This
/// documents an attribution boundary while still proving the vault is safe.
fn expect_reject_runtime(mollusk: &Mollusk, legs: &[LegSpec], total: u64, label: &str) {
    let built = build_multi(legs, total);
    let data = instruction_data(legs, &built.leg_amounts, total);
    let instruction = Instruction { program_id: key(BURNER_PROGRAM), accounts: built.metas.clone(), data };
    let result = mollusk.process_instruction(&instruction, &built.accounts);
    assert!(result.raw_result.is_err(), "[{label}] expected a runtime refusal");
    if let Err(InstructionError::Custom(code)) = result.raw_result {
        // burner-attributed codes are 6000..=6043; a lower Custom code is an
        // SPL-token / CPI (runtime) refusal, which is what this asserts.
        assert!(
            !(6000..=6043).contains(&code),
            "[{label}] expected a RUNTIME (non-burner) refusal, got burner Custom({code})",
        );
    }
    for pk in &built.watch {
        if !built.accounts.iter().any(|(c, _)| c == pk) { continue; }
        assert_eq!(
            account(&result.resulting_accounts, pk),
            account(&built.accounts, pk),
            "[{label}] account {pk} changed despite outer failure",
        );
    }
}

/// Run a multi-leg case that must SUCCEED (honest control); assert each target
/// ATA burned to zero and the PDA lamport delta equals the total input.
fn expect_burn(mollusk: &Mollusk, legs: &[LegSpec], total: u64, label: &str) {
    let built = build_multi(legs, total);
    let data = instruction_data(legs, &built.leg_amounts, total);
    let instruction = Instruction { program_id: key(BURNER_PROGRAM), accounts: built.metas.clone(), data };
    let result = mollusk.process_instruction(&instruction, &built.accounts);
    assert_eq!(result.raw_result, Ok(()), "[{label}] honest multi-leg control must burn");
    let before = account(&built.accounts, &built.burn_pda).lamports;
    let after = account(&result.resulting_accounts, &built.burn_pda).lamports;
    assert_eq!(before - after, total, "[{label}] PDA lamport delta must equal total input");
    for ata in &built.target_atas {
        let a = account(&result.resulting_accounts, ata);
        let amt = u64::from_le_bytes(a.data[64..72].try_into().unwrap());
        assert_eq!(amt, 0, "[{label}] every target ATA must burn to zero");
    }
    for leg in legs {
        if let Some((extra, before)) = &leg.extra_route_account {
            assert_eq!(
                account(&result.resulting_accounts, extra),
                before,
                "[{label}] unsolicited route-account balance must remain byte-identical",
            );
        }
    }
}

// ===========================================================================
// GROUP A — multi-leg custody + cross-leg ATOMIC rollback
// ===========================================================================
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_a_multileg_custody_and_atomic_rollback() {
    assert_eq!(derived_floor(REF_RT, REF_RS, AMOUNT_IN, FEE_NUM, FEE_DEN), 1, "floor tuning drifted");
    let mollusk = load_mollusk();

    // Honest 2/3/4-leg controls MUST burn (proves the harness reaches+passes
    // every leg's route CPI; a suite that refuses everything is caught here).
    expect_burn(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_JUST_SWAP, 2)], 2_000_000, "A0 honest 2-leg");
    expect_burn(
        &mollusk,
        &[v4_leg(3334, MODE_JUST_SWAP, 1), v4_leg(3333, MODE_JUST_SWAP, 2), v4_leg(3333, MODE_JUST_SWAP, 3)],
        3_000_000,
        "A0 honest 3-leg",
    );
    expect_burn(
        &mollusk,
        &[
            v4_leg(2500, MODE_JUST_SWAP, 1),
            v4_leg(2500, MODE_JUST_SWAP, 2),
            v4_leg(2500, MODE_JUST_SWAP, 3),
            v4_leg(2500, MODE_JUST_SWAP, 4),
        ],
        4_000_000,
        "A0 honest 4-leg",
    );

    // Cross-leg ATOMIC rollback: leg 0 completes an honest burn, then a LATER
    // leg abuses its route-granted signature. Every completed leg must roll
    // back byte-identically and the BURNER must author the refusal.
    // 2-leg, hostile leg 1:
    expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_STEAL_LAMPORT, 2)], 2_000_000, E_BURN_PDA_LAMPORT, "A1 leg1 steal SOL");
    expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_ASSIGN_PDA, 2)], 2_000_000, E_INVALID_BURN_PDA, "A2 leg1 assign PDA");
    expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_ALLOCATE_PDA, 2)], 2_000_000, E_INVALID_BURN_PDA, "A3 leg1 allocate PDA");
    expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_APPROVE_WSOL_DELEGATE, 2)], 2_000_000, E_ENCUMBERED, "A4 leg1 wsol delegate");
    expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_SET_TARGET_CLOSE_AUTHORITY, 2)], 2_000_000, E_ENCUMBERED, "A5 leg1 target close auth");
    expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_WSOL_UNDERCONSUME, 2)], 2_000_000, E_WSOL_NOT_CONSUMED, "A6 leg1 wsol underconsume");
    {
        // target decrease needs the ATA to hold a balance the route drains
        let mut leg1 = v4_leg(5000, MODE_TARGET_DECREASE, 2);
        leg1.target_ata_amount = 5;
        expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), leg1], 2_000_000, E_TARGET_DECREASED, "A7 leg1 target decrease");
    }
    {
        let mut leg1 = v4_leg(5000, MODE_INTERMEDIATE_KEEP, 2);
        leg1.target_source_amount = 2;
        expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), leg1], 2_000_000, E_INTERMEDIATE, "A8 leg1 intermediate keep");
        let mut leg1r = v4_leg(5000, MODE_INTERMEDIATE_REASSIGN, 2);
        leg1r.target_source_amount = 2;
        expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), leg1r], 2_000_000, E_INTERMEDIATE, "A9 leg1 intermediate reassign");
    }

    // 3-leg, hostile leg 2 (two honest legs already burned): steal SOL.
    expect_reject(
        &mollusk,
        &[v4_leg(3334, MODE_JUST_SWAP, 1), v4_leg(3333, MODE_JUST_SWAP, 2), v4_leg(3333, MODE_STEAL_LAMPORT, 3)],
        3_000_000,
        E_BURN_PDA_LAMPORT,
        "A10 3-leg hostile leg2 steal",
    );
    // 4-leg, hostile leg 3: reassign an intermediate away mid-route.
    {
        let mut leg3 = v4_leg(2500, MODE_INTERMEDIATE_REASSIGN, 4);
        leg3.target_source_amount = 2;
        expect_reject(
            &mollusk,
            &[
                v4_leg(2500, MODE_JUST_SWAP, 1),
                v4_leg(2500, MODE_JUST_SWAP, 2),
                v4_leg(2500, MODE_JUST_SWAP, 3),
                leg3,
            ],
            4_000_000,
            E_INTERMEDIATE,
            "A11 4-leg hostile leg3 reassign",
        );
    }
    // 4-leg, hostile FINAL leg 3 assigns the PDA: the whole-call
    // verify_pda_still_a_bare_system_account fires -> 6012, burner-attributed.
    expect_reject(
        &mollusk,
        &[
            v4_leg(2500, MODE_JUST_SWAP, 1),
            v4_leg(2500, MODE_JUST_SWAP, 2),
            v4_leg(2500, MODE_JUST_SWAP, 3),
            v4_leg(2500, MODE_ASSIGN_PDA, 4),
        ],
        4_000_000,
        E_INVALID_BURN_PDA,
        "A12 4-leg hostile FINAL leg assign",
    );

    // FINDING (attribution boundary, NOT a value loss): a PDA owner-change
    // (Assign/Allocate) in a NON-final leg corrupts the account the NEXT leg's
    // fund_wsol debits, so the SVM runtime refuses with ExternalAccountLamport-
    // Spend BEFORE the burner's whole-call owner re-check runs. The vault is
    // still rolled back byte-identically and loses nothing; only the
    // attribution is runtime rather than burner. Documented explicitly so the
    // suite does not overclaim "burner-attributed" for this shape.
    expect_reject_runtime(
        &mollusk,
        &[
            v4_leg(2500, MODE_ASSIGN_PDA, 1),
            v4_leg(2500, MODE_JUST_SWAP, 2),
            v4_leg(2500, MODE_JUST_SWAP, 3),
            v4_leg(2500, MODE_JUST_SWAP, 4),
        ],
        4_000_000,
        "A13 non-final-leg assign (runtime-caught, vault safe)",
    );
}

// ===========================================================================
// GROUP B — cross-aliasing (an account reused in two leg roles)
// ===========================================================================
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_b_cross_aliasing() {
    let mollusk = load_mollusk();
    let wsol = key(WSOL_MINT);
    let native_reserve = Rent::default().minimum_balance(165);

    // B1: the SAME target mint in two legs -> DuplicateSplitTarget (6034),
    // refused in build_split_seeds before any CPI.
    {
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        leg1.target_mint = v4_leg(5000, MODE_JUST_SWAP, 1).target_mint; // collide leg0's mint
        expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), leg1], 2_000_000, E_DUPLICATE_TARGET, "B1 duplicate target mint");
    }

    // B2a: leg B's TARGET ATA slot holds leg A's REFERENCE account (a Raydium
    // pool, owned by Raydium not the token program) -> 6011 (wrong owner).
    {
        let leg0 = v4_leg(5000, MODE_JUST_SWAP, 1);
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        leg1.override_target_ata = Some((leg0.reference, leg0.reference_account.clone()));
        expect_reject(&mollusk, &[leg0, leg1], 2_000_000, E_INVALID_TOKEN_ACCOUNT_OWNER, "B2a leg-ref as another leg's ATA (wrong owner)");
    }

    // B2b: leg B's TARGET ATA slot holds a VALID token account but at a
    // non-derived address -> 6014 (address is not the derived ATA).
    {
        let leg0 = v4_leg(5000, MODE_JUST_SWAP, 1);
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        let wrong_addr = Pubkey::new_from_array([0xC1; 32]);
        let acct = token::create_account_for_token_account(token_account(leg1.target_mint, build_multi(&[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_JUST_SWAP, 2)], 2_000_000).burn_pda, 0, None));
        leg1.override_target_ata = Some((wrong_addr, acct));
        expect_reject(&mollusk, &[leg0, leg1], 2_000_000, E_INVALID_TOKEN_ACCOUNT_DATA, "B2b token account at non-derived ATA address");
    }

    // B3: leg A's REFERENCE reused as leg B's reference (same pool address for
    // two different-mint legs). The bound pool holds leg A's target/vaults, so
    // leg B's floor read sees a mint mismatch -> 6039, before any CPI.
    {
        let leg0 = v4_leg(5000, MODE_JUST_SWAP, 1);
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        leg1.reference = leg0.reference; // share the pool address across legs
        leg1.fee_source = leg0.reference; // Raydium V4 requires fee_source == reference
        // vault_a/vault_b passed for leg1 stay leg1's own (won't match the
        // shared pool's stored vaults) -> reference-shape auth fails.
        expect_reject(&mollusk, &[leg0, leg1], 2_000_000, E_REFERENCE_INVALID, "B3 shared reference across legs");
    }

    // B4: the vault's own WSOL account presented as a leg's SOL vault (vault_b)
    // in a MULTI-leg burn. Its address cannot match the pool's stored vault_b
    // pubkey -> 6039 (shape auth), never priced off a vault-controlled account.
    {
        let leg0 = v4_leg(5000, MODE_JUST_SWAP, 1);
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        let built = build_multi(&[v4_leg(5000, MODE_JUST_SWAP, 1), v4_leg(5000, MODE_JUST_SWAP, 2)], 2_000_000);
        let wsol_ata = associated_token_address(&built.burn_pda, &wsol);
        let aliased = token::create_account_for_token_account(token_account(wsol, built.burn_pda, REF_RS, Some(native_reserve)));
        leg1.override_vault_b = Some((wsol_ata, aliased));
        expect_reject(&mollusk, &[leg0, leg1], 2_000_000, E_REFERENCE_INVALID, "B4 vault WSOL account as pool SOL-vault");
    }

    // B5: leg A's fee_source (== its Raydium pool) reused as leg B's fee_source
    // while leg B keeps its own reference. For Raydium V4 the fee_source MUST
    // equal the leg's own reference; a foreign fee_source -> 6039.
    {
        let leg0 = v4_leg(5000, MODE_JUST_SWAP, 1);
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        leg1.fee_source = leg0.reference; // leg B fee source points at leg A's pool
        expect_reject(&mollusk, &[leg0, leg1], 2_000_000, E_REFERENCE_INVALID, "B5 leg fee_source is another leg's pool");
    }
}

// ===========================================================================
// Pump-venue builders (PumpSwap pool, bonding curve, fee_config).
// ===========================================================================
const PUMP_FEE_PROGRAM: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const PUMP_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [143, 52, 146, 187, 219, 123, 76, 155];

fn pump_program(id: &str) -> Pubkey {
    key(id)
}

fn pool_authority(target_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool-authority", target_mint.as_ref()], &key(PUMP_FUN_PROGRAM)).0
}

fn bonding_curve_addr(target_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", target_mint.as_ref()], &key(PUMP_FUN_PROGRAM)).0
}

fn fee_config_addr(venue: &str) -> Pubkey {
    Pubkey::find_program_address(&[b"fee_config", key(venue).as_ref()], &key(PUMP_FEE_PROGRAM)).0
}

/// A parseable Pump fee_config with a flat (count==0) fee: lp/protocol/creator
/// at 41/49/57. Owned by the Pump fee program at the authenticated PDA.
fn fee_config_parsed(_venue: &str, lp: u64, protocol: u64, creator: u64) -> Account {
    let mut data = vec![0u8; 128];
    data[0..8].copy_from_slice(&PUMP_FEE_CONFIG_DISCRIMINATOR);
    data[41..49].copy_from_slice(&lp.to_le_bytes());
    data[49..57].copy_from_slice(&protocol.to_le_bytes());
    data[57..65].copy_from_slice(&creator.to_le_bytes());
    // count (65..69) left zero -> flat fee, no tier search
    Account { lamports: 1_000_000, data, owner: key(PUMP_FEE_PROGRAM), executable: false, rent_epoch: 0 }
}

/// A fee_config at the authenticated PDA/owner but with UNPARSEABLE content
/// (wrong discriminator) -> read_fee_config falls back to the conservative
/// 1 bps fee. Proves the fallback is reachable without a wrong account.
fn fee_config_garbage(_venue: &str) -> Account {
    let mut data = vec![0u8; 128];
    data[0..8].copy_from_slice(&[9, 9, 9, 9, 9, 9, 9, 9]); // not the real disc
    Account { lamports: 1_000_000, data, owner: key(PUMP_FEE_PROGRAM), executable: false, rent_epoch: 0 }
}

/// A PumpSwap pool account: vaults at 139/171, creator at 11..43,
/// creator_non_default region 211..243, virtual_quote (i128) at 245..261.
fn pumpswap_pool(vault_a: &Pubkey, vault_b: &Pubkey, creator: &Pubkey, virtual_quote: i128) -> Account {
    let mut data = vec![0u8; 300];
    data[11..43].copy_from_slice(creator.as_ref());
    data[139..171].copy_from_slice(vault_a.as_ref());
    data[171..203].copy_from_slice(vault_b.as_ref());
    data[245..261].copy_from_slice(&virtual_quote.to_le_bytes());
    Account { lamports: 6_124_800, data, owner: key(PUMP_SWAP_PROGRAM), executable: false, rent_epoch: 0 }
}

/// A Pump bonding-curve account: virtual_tokens 8..16, virtual_quote 16..24,
/// complete flag at 48 (0 == not complete), creator 49..81, mayhem at 81.
fn bonding_curve(virtual_tokens: u64, virtual_quote: u64) -> Account {
    let mut data = vec![0u8; 150];
    data[8..16].copy_from_slice(&virtual_tokens.to_le_bytes());
    data[16..24].copy_from_slice(&virtual_quote.to_le_bytes());
    data[48] = 0; // not complete
    data[81] = 0; // normal (not mayhem)
    Account { lamports: 6_124_800, data, owner: key(PUMP_FUN_PROGRAM), executable: false, rent_epoch: 0 }
}

/// A PumpSwap leg: reference address == a fabricated PumpSwap pool (sentinel
/// binds it, so the pool ADDRESS is arbitrary). `creator` defaults to the
/// canonical pool-authority PDA (honest); attacks override it. fee_source is
/// the authenticated fee_config PDA (parseable by default).
fn pumpswap_leg(bps: u16, mode: u8, idx: u8) -> LegSpec {
    let target_mint = Pubkey::new_from_array([0x50 | idx; 32]);
    let reference = Pubkey::new_from_array([0x60 | idx; 32]);
    let vault_a = Pubkey::new_from_array([0x70 | idx; 32]);
    let vault_b = Pubkey::new_from_array([0x80 | idx; 32]);
    let pool_auth = Pubkey::new_from_array([0x90 | idx; 32]);
    let wsol = key(WSOL_MINT);
    let creator = pool_authority(&target_mint);
    let fee_source = fee_config_addr(PUMP_SWAP_PROGRAM);
    LegSpec {
        bps,
        mode,
        minimum_output: None,
        target_mint,
        reference,
        reference_account: pumpswap_pool(&vault_a, &vault_b, &creator, 0),
        is_pump_venue: true,
        vault_a,
        vault_a_account: raw_vault(&target_mint, &pool_auth, REF_RT),
        vault_b,
        vault_b_account: raw_vault(&wsol, &pool_auth, REF_RS),
        fee_source,
        fee_source_account: Some(fee_config_parsed(PUMP_SWAP_PROGRAM, 20, 5, 0)),
        target_ata_amount: 0,
        target_source_amount: 1,
        present_reference_addr: None,
        override_target_ata: None,
        override_vault_b: None,
        route_target_source: None,
        route_balance_sink: None,
        extra_route_account: None,
        accumulator: None,
    }
}

/// A Pump bonding-curve leg: reference == PDA(["bonding-curve", mint]) (its
/// PDA pin fully binds identity despite the sentinel). vaults unused by the
/// curve branch but still passed. fee_source is the PUMP_FUN fee_config PDA.
fn curve_leg(bps: u16, mode: u8, idx: u8) -> LegSpec {
    let target_mint = Pubkey::new_from_array([0x50 | idx; 32]);
    let reference = bonding_curve_addr(&target_mint);
    let vault_a = Pubkey::new_from_array([0x70 | idx; 32]);
    let vault_b = Pubkey::new_from_array([0x80 | idx; 32]);
    let pool_auth = Pubkey::new_from_array([0x90 | idx; 32]);
    let wsol = key(WSOL_MINT);
    let fee_source = fee_config_addr(PUMP_FUN_PROGRAM);
    LegSpec {
        bps,
        mode,
        minimum_output: None,
        target_mint,
        reference,
        reference_account: bonding_curve(120_000, REF_RS),
        is_pump_venue: true,
        vault_a,
        vault_a_account: raw_vault(&target_mint, &pool_auth, REF_RT),
        vault_b,
        vault_b_account: raw_vault(&wsol, &pool_auth, REF_RS),
        fee_source,
        fee_source_account: Some(fee_config_garbage(PUMP_FUN_PROGRAM)), // fallback 1 bps
        target_ata_amount: 0,
        target_source_amount: 1,
        present_reference_addr: None,
        override_target_ata: None,
        override_vault_b: None,
        route_target_source: None,
        route_balance_sink: None,
        extra_route_account: None,
        accumulator: None,
    }
}

// ===========================================================================
// GROUP C — Pump bonding-curve + fee_config fallback under a hostile route
// ===========================================================================
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_c_pump_curve_and_fee_fallback() {
    let mollusk = load_mollusk();

    // C1: honest Pump bonding-curve reference -> BURNS (control). The curve is
    // PDA-pinned to the target mint, so its identity is fixed despite the
    // sentinel; fee_config falls back to 1 bps (garbage content), floor == 1.
    expect_burn(&mollusk, &[curve_leg(10_000, MODE_JUST_SWAP, 1)], AMOUNT_IN, "C1 honest Pump curve burns");

    // C1b: honest curve beside a Raydium leg (mixed venues), each leg ~1e6 so
    // both floors are 1 and the 1-unit deposit clears them.
    expect_burn(
        &mollusk,
        &[v4_leg(5000, MODE_JUST_SWAP, 1), curve_leg(5000, MODE_JUST_SWAP, 2)],
        AMOUNT_IN * 2,
        "C1b mixed v4 + curve",
    );

    // C2: a curve account at a NON-PDA reference address -> 6039. The curve
    // branch requires reference.address() == PDA(["bonding-curve", mint]).
    {
        let mut leg = curve_leg(10_000, MODE_JUST_SWAP, 1);
        leg.reference = Pubkey::new_from_array([0xEE; 32]); // not the curve PDA
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "C2 curve at wrong address");
    }

    // C3: curve with the COMPLETE flag set (graduated) -> 6039 (cd[48] == 1).
    {
        let mut leg = curve_leg(10_000, MODE_JUST_SWAP, 1);
        let mut acct = bonding_curve(120_000, REF_RS);
        acct.data[48] = 1; // complete
        leg.reference_account = acct;
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "C3 curve complete flag");
    }

    // C4: fee_config DEGRADING fallback gains an attacker NOTHING. Same
    // PumpSwap reference, amount above the fallback cap (5e6 = depth*1/10000)
    // but below the parsed-25bps cap (125e6):
    //   * parsed 25bps fee_config -> passes the cap, refused at the price floor
    //     (6021), NOT a cap breach;
    //   * garbage fee_config -> conservative 1 bps -> cap shrinks to 5e6, so
    //     6e6 breaches it (6040) pre-CPI.
    // Forcing the fallback is STRICTLY more restrictive (smaller cap, higher
    // floor), never a gain.
    {
        let amount = 6_000_000u64;
        let mut parsed = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        parsed.minimum_output = Some(1); // below the parsed floor -> 6021, not 6040
        expect_reject(&mollusk, &[parsed], amount, E_SLIPPAGE, "C4a parsed fee: admitted past cap, floor-gated");

        let mut fallback = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        fallback.fee_source_account = Some(fee_config_garbage(PUMP_SWAP_PROGRAM));
        fallback.minimum_output = Some(1);
        expect_reject(&mollusk, &[fallback], amount, E_REFERENCE_CAP, "C4b fallback fee: cap shrinks -> 6040");
    }
}

// ===========================================================================
// GROUP D — PumpSwap sentinel + creator pin, from every angle
// ===========================================================================
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_d_pumpswap_creator_pin_and_sentinel() {
    let mollusk = load_mollusk();

    // D1: honest PumpSwap reference (creator == pool-authority PDA, matching
    // vaults, parsed fee) -> BURNS. Proves the PumpSwap constant-product path
    // reaches and passes the route CPI.
    {
        let mut leg = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        leg.minimum_output = Some(1);
        expect_burn(&mollusk, &[leg], AMOUNT_IN, "D1 honest PumpSwap burns");
    }

    // D2: WRONG creator (not PDA(["pool-authority", mint])) -> 6039. This is
    // the load-bearing pin that separates two sentinel-colliding pools.
    {
        let mut leg = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        let bad_creator = Pubkey::new_from_array([0xDD; 32]);
        leg.reference_account = pumpswap_pool(&leg.vault_a, &leg.vault_b, &bad_creator, 0);
        leg.minimum_output = Some(1);
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "D2 PumpSwap wrong creator");
    }

    // D3: correct creator but the pool's STORED vault_a does not match the
    // passed vault_a account -> 6039 (vault-shape pin).
    {
        let mut leg = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        let creator = pool_authority(&leg.target_mint);
        let wrong_vault = Pubkey::new_from_array([0xAB; 32]);
        leg.reference_account = pumpswap_pool(&wrong_vault, &leg.vault_b, &creator, 0);
        leg.minimum_output = Some(1);
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "D3 PumpSwap vault mismatch");
    }

    // D4: NEGATIVE virtual_quote -> 6039 (the i128 sign check).
    {
        let mut leg = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        let creator = pool_authority(&leg.target_mint);
        leg.reference_account = pumpswap_pool(&leg.vault_a, &leg.vault_b, &creator, -1);
        leg.minimum_output = Some(1);
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "D4 PumpSwap negative virtual_quote");
    }

    // D5: the SENTINEL COLLISION, stated precisely. Two DIFFERENT PumpSwap pool
    // addresses (R1, R2) for the same (launch, target, bps) derive the SAME
    // vault, because a Pump-venue reference binds as the [0u8;32] sentinel, not
    // its address. So the vault address does NOT commit to a specific pool; the
    // only thing separating a "reviewed" pool from a substitute is the
    // in-program creator pin (D2), which is satisfied by ANY PumpSwap pool
    // carrying creator == PDA(["pool-authority", mint]).
    {
        let launch = Pubkey::new_from_array([13; 32]);
        let target = Pubkey::new_from_array([0x51; 32]);
        let r1 = Pubkey::new_from_array([0x61; 32]);
        let r2 = Pubkey::new_from_array([0x6F; 32]);
        let v1 = derive_split_vault(&launch, &[(target, ref_seed(&r1, true))], &[10_000]);
        let v2 = derive_split_vault(&launch, &[(target, ref_seed(&r2, true))], &[10_000]);
        assert_eq!(v1, v2, "D5: two different Pump pool addresses must derive the SAME vault (sentinel)");
    }

    // D5b: FUNCTIONAL consequence — a burn presenting a pool at a DIFFERENT
    // address than any "reviewed" one still BURNS, as long as its creator pin
    // holds. This is not a custody loss (conservation holds, target burns to
    // zero, no SOL/token leaves the vault), but it demonstrates that Pump-venue
    // price integrity rests on PumpSwap's canonical-pool uniqueness (only ONE
    // pool per mint carries creator == pool-authority(mint)), NOT on address
    // binding. Reported as a trust-boundary finding.
    {
        let mut leg = pumpswap_leg(10_000, MODE_JUST_SWAP, 1);
        // move the pool to an arbitrary address; creator pin still correct
        let creator = pool_authority(&leg.target_mint);
        leg.reference = Pubkey::new_from_array([0x6F; 32]);
        leg.reference_account = pumpswap_pool(&leg.vault_a, &leg.vault_b, &creator, 0);
        leg.minimum_output = Some(1);
        expect_burn(&mollusk, &[leg], AMOUNT_IN, "D5b substitute-address PumpSwap pool still burns");
    }
}

// ===========================================================================
// DLMM / CLMM builders + Group CE (price-based venues under a hostile route).
// ===========================================================================
const METEORA_DLMM: [u8; 32] = [
    4, 233, 225, 47, 188, 132, 232, 38, 201, 50, 204, 233, 226, 100, 12, 206, 21, 89, 12, 28, 98,
    115, 176, 146, 87, 8, 186, 59, 133, 32, 176, 188,
];
const RAYDIUM_CLMM: [u8; 32] = [
    165, 213, 202, 158, 4, 207, 93, 181, 144, 183, 20, 186, 47, 227, 44, 177, 89, 19, 63, 193, 193,
    146, 183, 34, 87, 253, 7, 211, 156, 176, 64, 30,
];
const DLMM_DISC: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
const CLMM_POOL_DISC: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
const CLMM_CONFIG_DISC: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];

/// Valid Meteora DLMM LbPair at active_id 0 (price 1.0), bin_step 1,
/// base_factor 10000, power 0 -> fee 1 bps. x = WSOL, y = target.
fn dlmm_pair(sol_vault: &Pubkey, tok_vault: &Pubkey, target: &Pubkey) -> Account {
    let wsol = key(WSOL_MINT);
    let mut data = vec![0u8; 300];
    data[0..8].copy_from_slice(&DLMM_DISC);
    data[8..10].copy_from_slice(&10_000u16.to_le_bytes()); // base_factor
    data[34] = 0; // power -> scale 1
    data[76..80].copy_from_slice(&0i32.to_le_bytes()); // active_id
    data[80..82].copy_from_slice(&1u16.to_le_bytes()); // bin_step
    data[88..120].copy_from_slice(wsol.as_ref()); // x_mint
    data[120..152].copy_from_slice(target.as_ref()); // y_mint
    data[152..184].copy_from_slice(sol_vault.as_ref()); // reserve_x (WSOL side)
    data[184..216].copy_from_slice(tok_vault.as_ref()); // reserve_y
    Account { lamports: 6_124_800, data, owner: Pubkey::new_from_array(METEORA_DLMM), executable: false, rent_epoch: 0 }
}

/// Valid Raydium CLMM PoolState at sqrt_price 2^64 (price 1.0). mint0 = WSOL,
/// mint1 = target. config at 9..41 authenticates the fee_source.
fn clmm_pool(sol_vault: &Pubkey, tok_vault: &Pubkey, target: &Pubkey, config: &Pubkey) -> Account {
    let wsol = key(WSOL_MINT);
    let mut data = vec![0u8; 320];
    data[0..8].copy_from_slice(&CLMM_POOL_DISC);
    data[9..41].copy_from_slice(config.as_ref());
    data[73..105].copy_from_slice(wsol.as_ref()); // mint0
    data[105..137].copy_from_slice(target.as_ref()); // mint1
    data[137..169].copy_from_slice(sol_vault.as_ref()); // vault0 (WSOL)
    data[169..201].copy_from_slice(tok_vault.as_ref()); // vault1
    data[253..269].copy_from_slice(&(1u128 << 64).to_le_bytes()); // sqrt_price
    Account { lamports: 6_124_800, data, owner: Pubkey::new_from_array(RAYDIUM_CLMM), executable: false, rent_epoch: 0 }
}

fn clmm_config(fee: u32) -> Account {
    let mut data = vec![0u8; 64];
    data[0..8].copy_from_slice(&CLMM_CONFIG_DISC);
    data[47..51].copy_from_slice(&fee.to_le_bytes());
    Account { lamports: 1_000_000, data, owner: Pubkey::new_from_array(RAYDIUM_CLMM), executable: false, rent_epoch: 0 }
}

/// A DLMM leg. sol depth defaults to MIN_DEPTH (passes 6041).
fn dlmm_leg(bps: u16, mode: u8, idx: u8, depth: u64) -> LegSpec {
    let target_mint = Pubkey::new_from_array([0x50 | idx; 32]);
    let reference = Pubkey::new_from_array([0x60 | idx; 32]);
    let vault_a = Pubkey::new_from_array([0x70 | idx; 32]); // WSOL reserve
    let vault_b = Pubkey::new_from_array([0x80 | idx; 32]); // target reserve
    let pool_auth = Pubkey::new_from_array([0x90 | idx; 32]);
    let wsol = key(WSOL_MINT);
    LegSpec {
        bps,
        mode,
        minimum_output: Some(0), // proves the floor computed (>0) -> 6021
        target_mint,
        reference,
        reference_account: dlmm_pair(&vault_a, &vault_b, &target_mint),
        is_pump_venue: false,
        vault_a,
        vault_a_account: raw_vault(&wsol, &pool_auth, depth),
        vault_b,
        vault_b_account: raw_vault(&target_mint, &pool_auth, REF_RT),
        fee_source: reference, // DLMM stores fee in the pair state
        fee_source_account: None,
        target_ata_amount: 0,
        target_source_amount: 1,
        present_reference_addr: None,
        override_target_ata: None,
        override_vault_b: None,
        route_target_source: None,
        route_balance_sink: None,
        extra_route_account: None,
        accumulator: None,
    }
}

/// A CLMM leg. sol depth defaults to MIN_DEPTH.
fn clmm_leg(bps: u16, mode: u8, idx: u8, depth: u64) -> LegSpec {
    let target_mint = Pubkey::new_from_array([0x50 | idx; 32]);
    let reference = Pubkey::new_from_array([0x60 | idx; 32]);
    let vault_a = Pubkey::new_from_array([0x70 | idx; 32]); // WSOL vault
    let vault_b = Pubkey::new_from_array([0x80 | idx; 32]); // target vault
    let pool_auth = Pubkey::new_from_array([0x90 | idx; 32]);
    let config = Pubkey::new_from_array([0xB0 | idx; 32]);
    let wsol = key(WSOL_MINT);
    LegSpec {
        bps,
        mode,
        minimum_output: Some(0),
        target_mint,
        reference,
        reference_account: clmm_pool(&vault_a, &vault_b, &target_mint, &config),
        is_pump_venue: false,
        vault_a,
        vault_a_account: raw_vault(&wsol, &pool_auth, depth),
        vault_b,
        vault_b_account: raw_vault(&target_mint, &pool_auth, REF_RT),
        fee_source: config,
        fee_source_account: Some(clmm_config(100)), // 1 bps of 1e6
        target_ata_amount: 0,
        target_source_amount: 1,
        present_reference_addr: None,
        override_target_ata: None,
        override_vault_b: None,
        route_target_source: None,
        route_balance_sink: None,
        extra_route_account: None,
        accumulator: None,
    }
}

#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_ce_dlmm_clmm_under_hostile_route() {
    let mollusk = load_mollusk();

    // --- DLMM ---
    // Valid shape, min=0 -> 6021: the DLMM floor computed to a positive value,
    // so the price-based path was fully reached and parsed (not a setup fail).
    expect_reject(&mollusk, &[dlmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH)], AMOUNT_IN, E_SLIPPAGE, "CE-DLMM valid floor gate");
    // Wrong y_mint (not the bound target) -> 6039.
    {
        let mut leg = dlmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH);
        let mut acct = leg.reference_account.clone();
        acct.data[120..152].copy_from_slice(Pubkey::new_from_array([0x33; 32]).as_ref());
        leg.reference_account = acct;
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "CE-DLMM wrong target mint");
    }
    // Depth one lamport below the 50-SOL floor -> 6041.
    expect_reject(&mollusk, &[dlmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH - 1)], AMOUNT_IN, E_REFERENCE_SHALLOW, "CE-DLMM shallow depth");
    // amount above the depth cap (cap = depth*1/10000 = 5e6) -> 6040.
    expect_reject(&mollusk, &[dlmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH)], 6_000_000, E_REFERENCE_CAP, "CE-DLMM cap breach");

    // --- CLMM ---
    expect_reject(&mollusk, &[clmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH)], AMOUNT_IN, E_SLIPPAGE, "CE-CLMM valid floor gate");
    // Wrong PoolState discriminator -> 6039.
    {
        let mut leg = clmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH);
        let mut acct = leg.reference_account.clone();
        acct.data[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        leg.reference_account = acct;
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "CE-CLMM wrong pool disc");
    }
    // fee_source config with the WRONG discriminator -> 6039.
    {
        let mut leg = clmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH);
        let mut cfg = clmm_config(100);
        cfg.data[0..8].copy_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        leg.fee_source_account = Some(cfg);
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_REFERENCE_INVALID, "CE-CLMM wrong config disc");
    }
    // Shallow depth -> 6041.
    expect_reject(&mollusk, &[clmm_leg(10_000, MODE_JUST_SWAP, 1, MIN_DEPTH - 1)], AMOUNT_IN, E_REFERENCE_SHALLOW, "CE-CLMM shallow depth");
}

// ===========================================================================
// GROUP E — falsify "target-block accounts are unreachable to a hostile route"
// ===========================================================================
// The prior report argues the reference/vault/fee_source accounts sit in the
// target block (a different slice from route_pool), so a hostile route never
// receives a handle to them and cannot move the floor. This group tries to
// break that by ALIASING the venue-owned reference into a fixture-writable
// route slot (slot 10, the fixture's target-source). The falsification fails:
// the reference is owned by Raydium, so the fixture's SPL-token CPI against it
// is refused by the runtime, and the reference is byte-identical afterwards.
// The floor was already computed pre-CPI off the pristine reference regardless.
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_e_reference_unreachable_falsification() {
    let mollusk = load_mollusk();

    // E1: alias the leg's Raydium reference into the fixture's target-source
    // route slot. The honest JUST_SWAP tries to transfer a unit FROM it; SPL
    // Token refuses (source not owned by the token program). Runtime-attributed
    // refusal, and the reference (watched) is byte-identical.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        leg.route_target_source = Some(leg.reference);
        expect_reject_runtime(&mollusk, &[leg], AMOUNT_IN, "E1 reference aliased into route-writable slot");
    }

    // E2: same, but alias the WSOL SOL-vault (vault_b, owned by the token
    // program but NOT owned by the PDA) into the fixture's target-source slot.
    // The fixture's transfer needs the PDA as authority; the vault is owned by
    // the pool authority, so SPL Token refuses the owner/authority check.
    // Confirms a pool vault cannot be drained by a hostile route either.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        leg.route_target_source = Some(leg.vault_b);
        expect_reject_runtime(&mollusk, &[leg], AMOUNT_IN, "E2 pool SOL-vault aliased into route-writable slot");
    }
}

// ===========================================================================
// GROUP G — pre-call / end-of-call token-value accounting differential
// ===========================================================================
// For each target donation, hold every input constant and toggle exactly one
// earlier-leg mutation. The unchanged shape must burn; the mutated shape must
// reach 6042. This is an artifact-level differential, not merely a range check
// accepting 6042 as a known code. The unrelated-mint pair similarly toggles
// one drain and distinguishes an unchanged, admitted donation from 6043.
#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_g_pre_call_and_final_balance_accounting_differential() {
    let mollusk = load_mollusk();

    for donated in [1u64, 2, 5, 65_535, 999_999] {
        // CONTROL: an unsolicited balance already in the target ATA is part of
        // this leg's burn. It must not disable the vault.
        let mut control = v4_leg(10_000, MODE_JUST_SWAP, 1);
        control.target_ata_amount = donated;
        expect_burn(
            &mollusk,
            &[control],
            AMOUNT_IN,
            &format!("G-control target donation {donated} burns"),
        );

        // MUTATION: leg 0 completes its own honest swap/burn, but also moves
        // one unit out of leg 1's pre-funded target ATA into an attacker-owned
        // same-mint sink. The token CPI succeeds because the source is owned by
        // the burn PDA. Leg 1 must then compare against the whole-call snapshot
        // and refuse with the burner-authored 6042; expect_reject also proves
        // every watched vault/target/sink account rolled back byte-identically.
        let total = 2 * AMOUNT_IN;
        let mut legs = [
            v4_leg(5000, MODE_DRAIN_ROUTE_SOURCE, 1),
            v4_leg(5000, MODE_JUST_SWAP, 2),
        ];
        legs[1].target_ata_amount = donated;
        let victim = build_multi(&legs, total).target_atas[1];
        let sink = Pubkey::new_from_array([0xD1; 32]);
        legs[0].route_target_source = Some(victim);
        legs[0].route_balance_sink = Some((
            sink,
            token::create_account_for_token_account(token_account(
                legs[1].target_mint,
                attacker_key(),
                0,
                None,
            )),
        ));
        expect_reject(
            &mollusk,
            &legs,
            total,
            E_TARGET_PRE_CALL_MISMATCH,
            &format!("G-6042 earlier leg drains later target donation {donated}"),
        );
    }

    // CONTROL: a second account for the target mint can also carry an
    // unsolicited balance. If the route never touches it, it stays exactly in
    // place while the actual swap output burns normally.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        let pda = build_multi(std::slice::from_ref(&leg), AMOUNT_IN).burn_pda;
        let resting_target_account = Pubkey::new_from_array([0xD0; 32]);
        leg.extra_route_account = Some((
            resting_target_account,
            token::create_account_for_token_account(token_account(
                leg.target_mint,
                pda,
                7,
                None,
            )),
        ));
        expect_burn(
            &mollusk,
            &[leg],
            AMOUNT_IN,
            "G-control untouched target-mint donation remains",
        );
    }

    let unrelated_mint = Pubkey::new_from_array([0xD2; 32]);
    let unrelated_source = Pubkey::new_from_array([0xD3; 32]);

    // CONTROL: a vault-owned route account for an unrelated mint starts with
    // an unsolicited token and the router leaves it untouched. The burn must
    // succeed and expect_burn requires this account to remain byte-identical.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        let pda = build_multi(std::slice::from_ref(&leg), AMOUNT_IN).burn_pda;
        leg.extra_route_account = Some((
            unrelated_source,
            token::create_account_for_token_account(token_account(
                unrelated_mint,
                pda,
                1,
                None,
            )),
        ));
        expect_burn(
            &mollusk,
            &[leg],
            AMOUNT_IN,
            "G-control unrelated donation remains",
        );
    }

    // MUTATION: the same starting account is substituted into writable slot
    // 10 and drained to a same-mint sink. It ends empty, which was the old
    // false-success outcome. The completed guard must now author 6043 and the
    // outer failure must restore both source and sink byte-identically.
    {
        let mut leg = v4_leg(10_000, MODE_DRAIN_ROUTE_SOURCE, 1);
        let pda = build_multi(std::slice::from_ref(&leg), AMOUNT_IN).burn_pda;
        let unrelated_before = token::create_account_for_token_account(token_account(
            unrelated_mint,
            pda,
            1,
            None,
        ));
        let sink = Pubkey::new_from_array([0xD4; 32]);
        leg.route_target_source = Some(unrelated_source);
        leg.route_balance_sink = Some((
            sink,
            token::create_account_for_token_account(token_account(
                unrelated_mint,
                attacker_key(),
                0,
                None,
            )),
        ));
        // The duplicate trailing meta is intentional: it inserts the newly
        // fabricated source into Mollusk's account map while slot 10 remains
        // the fixture's actual writable source. Production accounting counts
        // a locked address once, regardless of repeated metas.
        leg.extra_route_account = Some((unrelated_source, unrelated_before));
        expect_reject(
            &mollusk,
            &[leg],
            AMOUNT_IN,
            E_PRE_EXISTING_BALANCE_UNACCOUNTED,
            "G-6043 unrelated donation drained to empty",
        );
    }
}

// ===========================================================================
// TASK 2 — MEASURE the F1 skim through the REAL keyless artifact at 100 bps.
// ===========================================================================
// F1: the floor is priced off the honest, address-bound REFERENCE; execution
// happens on a caller-supplied (opaque) route. The attacker seeds a mispriced
// execution pool that delivers exactly the floor and keeps the rest, so the
// per-burn skim (in SOL) == amount_in * (1 - floor/expected) == amount_in *
// TOL/10_000. We MEASURE the artifact's actual floor (not model it) via a
// min-boundary search: with a WSOL_UNDERCONSUME route, min < floor -> pre-CPI
// 6021 (route never runs); min >= floor -> route runs -> 6018 (checked before
// slippage). The smallest min giving 6018 IS the floor. We then confirm it
// equals expected * 9900/10000 (100 bps) and NOT expected * 9500/10000 (the
// old 500 bps), proving the 5x tightening on the real artifact.

fn v4_leg_tuned(idx: u8, rt: u64, rs: u64) -> LegSpec {
    let mut leg = v4_leg(10_000, MODE_WSOL_UNDERCONSUME, idx);
    let pool_auth = Pubkey::new_from_array([0x90 | idx; 32]);
    let target = leg.target_mint;
    let wsol = key(WSOL_MINT);
    leg.vault_a_account = raw_vault(&target, &pool_auth, rt);
    leg.vault_b_account = raw_vault(&wsol, &pool_auth, rs);
    leg
}

fn clmm_leg_tuned(idx: u8, depth: u64, fee: u32, sqrt_price: u128) -> LegSpec {
    let mut leg = clmm_leg(10_000, MODE_WSOL_UNDERCONSUME, idx, depth);
    let mut acct = leg.reference_account.clone();
    acct.data[253..269].copy_from_slice(&sqrt_price.to_le_bytes());
    leg.reference_account = acct;
    leg.fee_source_account = Some(clmm_config(fee));
    leg
}

/// Binary-search the artifact's floor for a single leg at `amount`.
fn measure_floor(mollusk: &Mollusk, leg_template: &LegSpec, amount: u64, hi: u64) -> u64 {
    let run = |min: u64| -> u32 {
        let mut leg = leg_template.clone();
        leg.mode = MODE_WSOL_UNDERCONSUME;
        leg.minimum_output = Some(min);
        let built = build_multi(std::slice::from_ref(&leg), amount);
        let data = instruction_data(std::slice::from_ref(&leg), &built.leg_amounts, amount);
        let ix = Instruction { program_id: key(BURNER_PROGRAM), accounts: built.metas.clone(), data };
        match mollusk.process_instruction(&ix, &built.accounts).raw_result {
            Err(InstructionError::Custom(c)) => c,
            Ok(()) => 0,
            _ => u32::MAX,
        }
    };
    // Sanity: min=0 must be below the floor (6021); min=hi must clear it (6018).
    assert_eq!(run(0), E_SLIPPAGE, "measure: min=0 should be below the floor (pre-CPI 6021)");
    assert_eq!(run(hi), E_WSOL_NOT_CONSUMED, "measure: min=hi should clear the floor (route runs -> 6018)");
    let (mut lo, mut hi) = (0u64, hi); // lo: below floor (6021); hi: at/above floor (6018)
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if run(mid) == E_WSOL_NOT_CONSUMED {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi // smallest min that clears the floor == the floor
}

// Exact mirrors of the artifact's arithmetic (validated: measured == expected).
fn v4_expected(rt: u64, rs: u64, amount: u64) -> u64 {
    let inp = amount as u128 * (10_000 - 25) / 10_000;
    (rt as u128 * inp / (rs as u128 + inp)) as u64
}
fn clmm_expected(amount: u64, fee: u32) -> u64 {
    // sqrt_price == 2^64 (price 1.0): expected == input_after_fee.
    (amount as u128 * (1_000_000 - fee as u128) / 1_000_000) as u64
}
fn floor_at_tol(expected: u64, tol_bps: u64) -> u64 {
    (expected as u128 * (10_000 - tol_bps as u128) / 10_000) as u64
}

#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn measure_f1_skim_at_100bps() {
    let mollusk = load_mollusk();
    println!("\n================ F1 SKIM, MEASURED THROUGH THE REAL 100 bps ARTIFACT ================");
    println!("venue      depth(SOL)   amount(SOL)   expected      floor(meas)   floor/exp   skim(SOL)     ROI/burn   vs500bps");

    // Reference depths spanning the product's range (lamports).
    // NEIRO-scale ~1394 SOL; FARTCOIN-scale ~41094 SOL; a thin ~60 SOL pool.
    let v4_refs: &[(&str, u64, u64)] = &[
        // (label, rt token reserve, rs SOL reserve in lamports)
        ("v4-thin",   400_000_000_000,      60_000_000_000),   // 60 SOL
        ("v4-NEIRO",  400_000_000_000,   1_393_900_000_000),   // 1393.9 SOL
        ("v4-FART",   400_000_000_000,  41_094_000_000_000),   // 41094 SOL
    ];
    for (label, rt, rs) in v4_refs.iter().copied() {
        let cap = (rs as u128 * 25 / 10_000) as u64; // fee * depth
        let leg = v4_leg_tuned(1, rt, rs);
        for frac in [8u64, 4, 2, 1] {
            let amount = (cap / frac).max(1);
            let expected = v4_expected(rt, rs, amount);
            if expected < 100 { continue; }
            let floor = measure_floor(&mollusk, &leg, amount, expected + 4);
            let floor100 = floor_at_tol(expected, 100);
            let floor500 = floor_at_tol(expected, 500);
            assert_eq!(floor, floor100, "[{label}] artifact floor must equal the 100 bps floor");
            assert_ne!(floor, floor500, "[{label}] artifact floor must NOT equal the old 500 bps floor");
            // Skim in SOL = amount * (1 - floor/expected). Compute in lamports.
            let skim_lamports = amount as u128 - (floor as u128 * amount as u128 / expected as u128);
            let skim_sol = skim_lamports as f64 / 1e9;
            let roi = skim_lamports as f64 / amount as f64; // capital ~= amount
            println!(
                "{:<10} {:>10.1} {:>13.4} {:>13} {:>13} {:>10.4} {:>13.6} {:>9.3}%  5x<-{:.6}",
                label, rs as f64 / 1e9, amount as f64 / 1e9, expected, floor,
                floor as f64 / expected as f64, skim_sol, roi * 100.0,
                (amount as u128 - (floor500 as u128 * amount as u128 / expected as u128)) as f64 / 1e9,
            );
        }
    }

    // CLMM (price-based) reference at price 1.0, 25 bps, deep depth.
    let clmm_depth = 1_393_900_000_000u64; // NEIRO-scale
    let clmm_fee = 2500u32; // 25 bps of 1e6
    let clmm = clmm_leg_tuned(1, clmm_depth, clmm_fee, 1u128 << 64);
    let cap = (clmm_depth as u128 * clmm_fee as u128 / 1_000_000) as u64;
    for frac in [8u64, 4, 2, 1] {
        let amount = (cap / frac).max(1);
        let expected = clmm_expected(amount, clmm_fee);
        if expected < 100 { continue; }
        let floor = measure_floor(&mollusk, &clmm, amount, expected + 4);
        let floor100 = floor_at_tol(expected, 100);
        let floor500 = floor_at_tol(expected, 500);
        assert_eq!(floor, floor100, "[clmm] artifact floor must equal the 100 bps floor");
        assert_ne!(floor, floor500, "[clmm] artifact floor must NOT equal the old 500 bps floor");
        let skim_lamports = amount as u128 - (floor as u128 * amount as u128 / expected as u128);
        let roi = skim_lamports as f64 / amount as f64;
        println!(
            "{:<10} {:>10.1} {:>13.4} {:>13} {:>13} {:>10.4} {:>13.6} {:>9.3}%  5x<-{:.6}",
            "clmm-NEIRO", clmm_depth as f64 / 1e9, amount as f64 / 1e9, expected, floor,
            floor as f64 / expected as f64, skim_lamports as f64 / 1e9, roi * 100.0,
            (amount as u128 - (floor500 as u128 * amount as u128 / expected as u128)) as f64 / 1e9,
        );
    }
    println!("=====================================================================================\n");
}

// ===========================================================================
// GROUP F — accumulator-credit seam: a Jupiter leg carrying a Pump accumulator
// ===========================================================================
// The Pump-venue burn credits the vault the rent of a `user_volume_accumulator`
// that Jupiter closes after its buy. The conservation equality is exact:
//   after = before - amount_in + sum(closed accumulator lamports).
// This group rides a Pump accumulator in a Jupiter leg's route where the
// hostile JUST_SWAP fixture does NOT close it, and confirms the exact equality
// refuses (6019). This is the shared credit machinery the directcurve MIXED
// partition (partition_pump_credits) also relies on: an accumulator the vault
// was credited for but that is not actually closed-and-refunded fails 6019.
const PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR: [u8; 8] = [86, 255, 112, 14, 102, 53, 154, 250];

fn accumulator_address(pda: &Pubkey, pump_fun: bool) -> Pubkey {
    let program = if pump_fun { key(PUMP_FUN_PROGRAM) } else { key(PUMP_SWAP_PROGRAM) };
    Pubkey::find_program_address(&[b"user_volume_accumulator", pda.as_ref()], &program).0
}

fn build_accumulator(pda: &Pubkey, spec: AccumSpec) -> (Pubkey, Account) {
    let addr = accumulator_address(pda, spec.pump_fun);
    let owner = match spec.kind {
        AccumKind::WrongOwner => key(WSOL_MINT), // any non-Pump owner
        _ => if spec.pump_fun { key(PUMP_FUN_PROGRAM) } else { key(PUMP_SWAP_PROGRAM) },
    };
    let mut data = vec![0u8; 64];
    match spec.kind {
        AccumKind::WrongDisc => data[0..8].copy_from_slice(&[1, 1, 1, 1, 1, 1, 1, 1]),
        _ => data[0..8].copy_from_slice(&PUMP_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR),
    }
    let stored_user = match spec.kind {
        AccumKind::WrongUser => Pubkey::new_from_array([0x7E; 32]),
        _ => *pda,
    };
    data[8..40].copy_from_slice(stored_user.as_ref());
    (addr, Account { lamports: 1_844_400, data, owner, executable: false, rent_epoch: 0 })
}

#[test]
#[ignore = "requires the keyless SBPF artifact + hostile fixture; see file header"]
fn group_f_accumulator_credit_seam() {
    let mollusk = load_mollusk();

    // F1: a VALID PUMP_FUN accumulator rides in a Jupiter leg's route; the
    // hostile JUST_SWAP does not close it. The vault is credited its lamports
    // (snapshot), but after the route it is NOT System-owned/empty/zero, so the
    // exact equality refuses -> 6019. Vault byte-identical.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        leg.accumulator = Some(AccumSpec { pump_fun: true, kind: AccumKind::Valid });
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_BURN_PDA_LAMPORT, "F1 unclosed PUMP_FUN accumulator");
    }

    // F1b: same with the PumpSwap accumulator.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        leg.accumulator = Some(AccumSpec { pump_fun: false, kind: AccumKind::Valid });
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_BURN_PDA_LAMPORT, "F1b unclosed PumpSwap accumulator");
    }

    // F2: a MALFORMED accumulator at the exact derived address (wrong stored
    // user) -> 6019 (validate_pump_credit_layout fails closed).
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        leg.accumulator = Some(AccumSpec { pump_fun: true, kind: AccumKind::WrongUser });
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_BURN_PDA_LAMPORT, "F2 accumulator wrong stored-user");
    }

    // F3: wrong discriminator at the derived address -> 6019.
    {
        let mut leg = v4_leg(10_000, MODE_JUST_SWAP, 1);
        leg.accumulator = Some(AccumSpec { pump_fun: true, kind: AccumKind::WrongDisc });
        expect_reject(&mollusk, &[leg], AMOUNT_IN, E_BURN_PDA_LAMPORT, "F3 accumulator wrong disc");
    }

    // F4: multi-leg — a Jupiter leg carries an unclosed accumulator while the
    // OTHER leg burns honestly. The whole-call conservation still refuses 6019
    // and rolls back the completed leg.
    {
        let mut leg1 = v4_leg(5000, MODE_JUST_SWAP, 2);
        leg1.accumulator = Some(AccumSpec { pump_fun: true, kind: AccumKind::Valid });
        expect_reject(&mollusk, &[v4_leg(5000, MODE_JUST_SWAP, 1), leg1], 2_000_000, E_BURN_PDA_LAMPORT, "F4 mixed leg carries unclosed accumulator");
    }

    // F5: the hostile route DONATES lamports to the vault (STEAL fixture runs
    // in reverse is not available; instead ride an accumulator AND steal a
    // lamport) — the exact equality refuses any unaccounted vault income too.
    // Covered by F1 (credit expected but not delivered) and by the STEAL cases
    // in Group A (lamport leaves); both are the same 6019 equality.
}
