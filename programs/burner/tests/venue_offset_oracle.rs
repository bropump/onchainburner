//! INDEPENDENT offset oracle for the keyless venue readers.
//!
//! # Why this exists (the shared-blind-spot problem)
//!
//! `keyless_leg_floor` (src/swap_and_burn.rs) parses ~45 hardcoded byte
//! offsets across six third-party pool layouts. Every existing test fixture —
//! synthetic pools in `keyless_fuzz.rs` / `clmm_dlmm_fuzz.rs` /
//! `venue_layout_artifact.rs`, and the differential models beside them — was
//! written by reading OUR source's offsets, so a hand-derivation error shared
//! between the program and the harnesses is invisible to all of them: the
//! fixture would place the value at the same wrong offset the program reads.
//!
//! This file breaks that provenance chain with two independent grounds:
//!
//!   1. **The venues' own published layouts.** For the Anchor venues, the
//!      ON-CHAIN IDLs (fetched 2026-08-23, committed under
//!      `tests/venue-fixtures/idl/`) are walked by a small Borsh layout
//!      calculator written from the Borsh/Anchor sizing rules — NOT from our
//!      source. For the two non-IDL Raydium layouts, the field lists are
//!      transcribed from the venues' published Rust sources (provenance noted
//!      inline), and the same calculator derives the offsets.
//!   2. **Real mainnet account bytes.** The layout calculator itself is then
//!      validated against the snapshotted mainnet pools in
//!      `tests/venue-fixtures/` (manifest.json names the expected vault and
//!      mint pubkeys): a 32-byte pubkey equality at a computed offset is a
//!      2^-256 coincidence, so agreement pins the calculator to reality.
//!
//! The program's offset table is transcribed below with file:line provenance
//! and asserted equal to the independently derived table. If our table has a
//! shared hand-derivation error, this file disagrees with the IDL walk; if a
//! venue re-fetches an IDL that no longer matches, the committed IDL should be
//! refreshed and this file re-run — a mismatch then maps exactly to a layout
//! drift that would misprice or brick vaults.
//!
//! # Known, deliberate divergences this file documents as assertions
//!
//!   * **Raydium V4 fee field.** The program reads `trade_fee_numerator/
//!     denominator` (offsets 144/152; swap_and_burn.rs:1093-1094), but
//!     raydium-amm's swap path charges `swap_fee_numerator/denominator`
//!     (offsets 176/184; `process_swap_base_in` in raydium-amm
//!     program/src/processor.rs uses `amm.fees.swap_fee_numerator`,
//!     confirmed against the published source 2026-08-26). On live standard
//!     pools both are 25/10000, so the divergence is currently value-
//!     invisible — which is exactly why no same-hands fixture ever caught
//!     it. `v4_trade_fee_equals_swap_fee_in_real_pool` HARD-FAILS the day a
//!     snapshotted pool has them differ, forcing the question.
//!   * **PumpSwap `virtual_quote` at 245..261.** The on-chain PumpSwap IDL's
//!     `Pool` struct ends at byte 245 (`is_cashback_coin` at 244); the
//!     program's i128 read at 245..261 (swap_and_burn.rs:1111) is in the
//!     post-`extend_account` extension region, justified by mainnet
//!     observation only (FABLE-PUMPSWAP-SPOOF: all 6 canonical pools were
//!     300/301 bytes). The oracle asserts the IDL end is EXACTLY where the
//!     read begins, so an IDL refresh that grows the struct (fields now
//!     occupying 245..) fails loudly.
//!
//! Host-only: no artifact, no feature flags, runs with plain `cargo test`.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

// ===========================================================================
// Minimal JSON parser (objects/arrays/strings/numbers/bool/null) — written
// for this file so the oracle needs no serde dependency. Validated implicitly
// by every lookup below: a mis-parse cannot reproduce the manifest pubkeys.
// ===========================================================================

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(map) => map.get(key),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(v) => Some(v),
            _ => None,
        }
    }
    fn as_num(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Parser { bytes: text.as_bytes(), at: 0 }
    }
    fn skip_ws(&mut self) {
        while self.at < self.bytes.len() && matches!(self.bytes[self.at], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.at += 1;
        }
    }
    fn peek(&mut self) -> u8 {
        self.skip_ws();
        self.bytes[self.at]
    }
    fn expect(&mut self, byte: u8) {
        self.skip_ws();
        assert_eq!(self.bytes[self.at], byte, "JSON parse error at {}", self.at);
        self.at += 1;
    }
    fn value(&mut self) -> Json {
        match self.peek() {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Json::Str(self.string()),
            b't' => {
                self.at += 4;
                Json::Bool(true)
            }
            b'f' => {
                self.at += 5;
                Json::Bool(false)
            }
            b'n' => {
                self.at += 4;
                Json::Null
            }
            _ => self.number(),
        }
    }
    fn object(&mut self) -> Json {
        self.expect(b'{');
        let mut map = BTreeMap::new();
        if self.peek() == b'}' {
            self.at += 1;
            return Json::Obj(map);
        }
        loop {
            self.skip_ws();
            let key = self.string();
            self.expect(b':');
            let value = self.value();
            map.insert(key, value);
            if self.peek() == b',' {
                self.at += 1;
            } else {
                break;
            }
        }
        self.expect(b'}');
        Json::Obj(map)
    }
    fn array(&mut self) -> Json {
        self.expect(b'[');
        let mut items = Vec::new();
        if self.peek() == b']' {
            self.at += 1;
            return Json::Arr(items);
        }
        loop {
            items.push(self.value());
            if self.peek() == b',' {
                self.at += 1;
            } else {
                break;
            }
        }
        self.expect(b']');
        Json::Arr(items)
    }
    fn string(&mut self) -> String {
        self.expect(b'"');
        let mut out = String::new();
        while self.bytes[self.at] != b'"' {
            if self.bytes[self.at] == b'\\' {
                self.at += 1;
                match self.bytes[self.at] {
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'r' => out.push('\r'),
                    b'u' => {
                        let hex = std::str::from_utf8(&self.bytes[self.at + 1..self.at + 5]).unwrap();
                        let code = u32::from_str_radix(hex, 16).unwrap();
                        out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        self.at += 4;
                    }
                    other => out.push(other as char),
                }
                self.at += 1;
            } else {
                // Multi-byte UTF-8 passes through byte-wise; keys and type
                // names in these IDLs are ASCII, which is all we look up.
                out.push(self.bytes[self.at] as char);
                self.at += 1;
            }
        }
        self.at += 1;
        out
    }
    fn number(&mut self) -> Json {
        self.skip_ws();
        let start = self.at;
        while self.at < self.bytes.len()
            && matches!(self.bytes[self.at], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
        {
            self.at += 1;
        }
        Json::Num(std::str::from_utf8(&self.bytes[start..self.at]).unwrap().parse().unwrap())
    }
}

fn parse_json(text: &str) -> Json {
    let mut parser = Parser::new(text);
    let value = parser.value();
    parser.skip_ws();
    value
}

// ===========================================================================
// Borsh/Anchor layout calculator — the sizing rules, written from the Borsh
// spec, NOT from our program source.
// ===========================================================================

#[derive(Debug, Clone)]
enum FieldType {
    Fixed(usize),
    Defined(String),
    Array(Box<FieldType>, usize),
    /// Borsh-dynamic (vec/string/option): ends the static prefix.
    Dynamic,
}

fn field_type(t: &Json) -> FieldType {
    if let Some(name) = t.as_str() {
        let size = match name {
            "u8" | "i8" | "bool" => 1,
            "u16" | "i16" => 2,
            "u32" | "i32" | "f32" => 4,
            "u64" | "i64" | "f64" => 8,
            "u128" | "i128" => 16,
            "pubkey" | "publicKey" => 32,
            "string" | "bytes" => return FieldType::Dynamic,
            other => panic!("unknown primitive type {other}"),
        };
        return FieldType::Fixed(size);
    }
    if let Some(array) = t.get("array") {
        let items = array.as_arr().expect("array form");
        let inner = field_type(&items[0]);
        let count = items[1].as_num().expect("array length") as usize;
        return FieldType::Array(Box::new(inner), count);
    }
    if let Some(defined) = t.get("defined") {
        let name = defined
            .as_str()
            .map(str::to_string)
            .or_else(|| defined.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .expect("defined name");
        return FieldType::Defined(name);
    }
    if t.get("vec").is_some() || t.get("option").is_some() || t.get("coption").is_some() {
        return FieldType::Dynamic;
    }
    panic!("unhandled type {t:?}");
}

struct Idl {
    types: BTreeMap<String, Json>, // name -> struct type {kind, fields}
}

impl Idl {
    fn load(path: &str) -> Idl {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/venue-fixtures/idl");
        let text = fs::read_to_string(root.join(path)).expect("read IDL fixture");
        let json = parse_json(&text);
        let mut types = BTreeMap::new();
        for section in ["types", "accounts"] {
            if let Some(list) = json.get(section).and_then(|v| v.as_arr()) {
                for entry in list {
                    let name = entry.get("name").and_then(|n| n.as_str()).unwrap().to_string();
                    if let Some(t) = entry.get("type") {
                        types.insert(name, t.clone());
                    }
                }
            }
        }
        Idl { types }
    }

    fn size_of(&self, t: &FieldType) -> usize {
        match t {
            FieldType::Fixed(n) => *n,
            FieldType::Array(inner, count) => self.size_of(inner) * count,
            FieldType::Defined(name) => {
                let fields = self.fields_of(name);
                fields
                    .iter()
                    .map(|(_, t)| match t {
                        FieldType::Dynamic => panic!("dynamic field inside {name}"),
                        other => self.size_of(other),
                    })
                    .sum()
            }
            FieldType::Dynamic => panic!("dynamic type has no static size"),
        }
    }

    fn fields_of(&self, name: &str) -> Vec<(String, FieldType)> {
        let def = self.types.get(name).unwrap_or_else(|| panic!("type {name} not in IDL"));
        let fields = def.get("fields").and_then(|f| f.as_arr()).expect("struct fields");
        fields
            .iter()
            .map(|f| {
                (
                    f.get("name").and_then(|n| n.as_str()).unwrap().to_string(),
                    field_type(f.get("type").expect("field type")),
                )
            })
            .collect()
    }

    /// Byte range of a (possibly nested) field path in an Anchor account
    /// (base offset 8 for the discriminator).
    fn offset(&self, account: &str, path: &[&str]) -> (usize, usize) {
        self.offset_from(8, account, path)
    }

    fn offset_from(&self, base: usize, ty: &str, path: &[&str]) -> (usize, usize) {
        let mut at = base;
        for (name, t) in self.fields_of(ty) {
            if name == path[0] {
                return match (&t, path.len()) {
                    (FieldType::Defined(inner), n) if n > 1 => {
                        self.offset_from(at, inner, &path[1..])
                    }
                    (FieldType::Dynamic, _) => (at, at), // start of the dynamic tail
                    (other, _) => (at, at + self.size_of(other)),
                };
            }
            at += match t {
                FieldType::Dynamic => {
                    panic!("field {} sits after dynamic content in {ty}", path[0])
                }
                other => self.size_of(&other),
            };
        }
        panic!("field {} not found in {ty}", path[0]);
    }
}

// ===========================================================================
// base58 (for manifest pubkeys) and fixture access
// ===========================================================================

fn base58_decode(text: &str) -> [u8; 32] {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut number = vec![0u8]; // big-endian big int
    for ch in text.bytes() {
        let digit = ALPHABET.iter().position(|c| *c == ch).expect("base58 digit") as u32;
        let mut carry = digit;
        for byte in number.iter_mut().rev() {
            let value = (*byte as u32) * 58 + carry;
            *byte = (value & 0xFF) as u8;
            carry = value >> 8;
        }
        while carry > 0 {
            number.insert(0, (carry & 0xFF) as u8);
            carry >>= 8;
        }
    }
    let leading_zeros = text.bytes().take_while(|b| *b == b'1').count();
    let mut out = vec![0u8; leading_zeros];
    let first_nonzero = number.iter().position(|b| *b != 0).unwrap_or(number.len());
    out.extend_from_slice(&number[first_nonzero..]);
    assert_eq!(out.len(), 32, "pubkey {text} decoded to {} bytes", out.len());
    out.try_into().unwrap()
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/venue-fixtures").join(name);
    fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn manifest() -> Json {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/venue-fixtures/manifest.json");
    parse_json(&fs::read_to_string(path).expect("read manifest"))
}

fn manifest_pubkey(manifest: &Json, account: &str) -> [u8; 32] {
    base58_decode(
        manifest
            .get("accounts")
            .and_then(|a| a.get(account))
            .and_then(|a| a.get("pubkey"))
            .and_then(|p| p.as_str())
            .unwrap_or_else(|| panic!("{account} missing from manifest")),
    )
}

const WSOL: &str = "So11111111111111111111111111111111111111112";
const PUMP_MINT: &str = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const JTO_MINT: &str = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";

fn slice32(data: &[u8], range: (usize, usize)) -> [u8; 32] {
    assert_eq!(range.1 - range.0, 32);
    data[range.0..range.1].try_into().unwrap()
}

// ===========================================================================
// 1. Meteora DLMM LbPair — IDL walk vs the program table vs real pool bytes
// ===========================================================================

/// Program table transcribed from src/swap_and_burn.rs (keyless_leg_floor,
/// DLMM branch): base_factor :904 (8..10), power byte :905 (34), active_id
/// :883 (76..80), bin_step :887 (80..82), x_mint :872 (88..120), y_mint :873
/// (120..152), reserve_x :865 (152..184), reserve_y :866 (184..216).
#[test]
fn dlmm_lb_pair_offsets_match_onchain_idl() {
    let idl = Idl::load("idl-meteora-dlmm-onchain.json");
    assert_eq!(idl.offset("LbPair", &["parameters", "base_factor"]), (8, 10));
    assert_eq!(idl.offset("LbPair", &["parameters", "base_fee_power_factor"]), (34, 35));
    assert_eq!(idl.offset("LbPair", &["active_id"]), (76, 80));
    assert_eq!(idl.offset("LbPair", &["bin_step"]), (80, 82));
    assert_eq!(idl.offset("LbPair", &["token_x_mint"]), (88, 120));
    assert_eq!(idl.offset("LbPair", &["token_y_mint"]), (120, 152));
    assert_eq!(idl.offset("LbPair", &["reserve_x"]), (152, 184));
    assert_eq!(idl.offset("LbPair", &["reserve_y"]), (184, 216));
}

/// The layout calculator itself, pinned to reality: the IDL-derived offsets
/// must reproduce the manifest's pubkeys inside the REAL mainnet pool bytes.
#[test]
fn dlmm_idl_offsets_reproduce_real_mainnet_pools() {
    let idl = Idl::load("idl-meteora-dlmm-onchain.json");
    let m = manifest();
    for (pool, x_mint, reserve_x, reserve_y) in [
        ("dlmm_pump_pool.bin", PUMP_MINT, "dlmm_pump_reserve_x", "dlmm_pump_reserve_y"),
        ("dlmm_jto_pool.bin", JTO_MINT, "dlmm_jto_reserve_x", "dlmm_jto_reserve_y"),
    ] {
        let data = fixture_bytes(pool);
        assert_eq!(
            slice32(&data, idl.offset("LbPair", &["token_x_mint"])),
            base58_decode(x_mint),
            "{pool}: token_x_mint"
        );
        assert_eq!(
            slice32(&data, idl.offset("LbPair", &["token_y_mint"])),
            base58_decode(WSOL),
            "{pool}: token_y_mint"
        );
        assert_eq!(
            slice32(&data, idl.offset("LbPair", &["reserve_x"])),
            manifest_pubkey(&m, reserve_x),
            "{pool}: reserve_x"
        );
        assert_eq!(
            slice32(&data, idl.offset("LbPair", &["reserve_y"])),
            manifest_pubkey(&m, reserve_y),
            "{pool}: reserve_y"
        );
        // Discriminator ground truth is the REAL account's first 8 bytes:
        // they must equal the constant the program pins (swap_and_burn.rs
        // :899, [33, 11, 49, 98, 181, 101, 177, 13]).
        assert_eq!(&data[0..8], &[33, 11, 49, 98, 181, 101, 177, 13], "{pool}: discriminator");
        // Sanity on the two non-pubkey fields at the derived offsets.
        let (lo, hi) = idl.offset("LbPair", &["bin_step"]);
        let bin_step = u16::from_le_bytes(data[lo..hi].try_into().unwrap());
        assert!(bin_step > 0 && bin_step <= 10_000, "{pool}: bin_step {bin_step}");
        let (lo, hi) = idl.offset("LbPair", &["active_id"]);
        let active_id = i32::from_le_bytes(data[lo..hi].try_into().unwrap());
        assert!(active_id.unsigned_abs() < 500_000, "{pool}: active_id {active_id}");
    }
}

// ===========================================================================
// 2. Raydium CLMM PoolState + AmmConfig
// ===========================================================================

/// Program table (src/swap_and_burn.rs CLMM branch): amm_config :991 (9..41),
/// mint0/mint1 :959-:960 (73..105/105..137), vault0/vault1 :952-:953
/// (137..169/169..201), sqrt_price_x64 :970 (253..269), AmmConfig
/// trade_fee_rate :1000 (47..51). `liquidity` at 237..253 is the documented
/// decoy field adjacent to sqrt_price.
#[test]
fn clmm_pool_state_offsets_match_onchain_idl() {
    let idl = Idl::load("idl-raydium-clmm-onchain.json");
    assert_eq!(idl.offset("PoolState", &["amm_config"]), (9, 41));
    assert_eq!(idl.offset("PoolState", &["token_mint_0"]), (73, 105));
    assert_eq!(idl.offset("PoolState", &["token_mint_1"]), (105, 137));
    assert_eq!(idl.offset("PoolState", &["token_vault_0"]), (137, 169));
    assert_eq!(idl.offset("PoolState", &["token_vault_1"]), (169, 201));
    assert_eq!(idl.offset("PoolState", &["liquidity"]), (237, 253));
    assert_eq!(idl.offset("PoolState", &["sqrt_price_x64"]), (253, 269));
    assert_eq!(idl.offset("AmmConfig", &["protocol_fee_rate"]), (43, 47));
    assert_eq!(idl.offset("AmmConfig", &["trade_fee_rate"]), (47, 51));
}

#[test]
fn clmm_idl_offsets_reproduce_real_mainnet_pools() {
    let idl = Idl::load("idl-raydium-clmm-onchain.json");
    let m = manifest();
    for (pool, config, vault0, vault1, target) in [
        ("clmm_pump_pool.bin", "clmm_pump_ammconfig", "clmm_pump_vault0", "clmm_pump_vault1", PUMP_MINT),
        ("clmm_jto_pool.bin", "clmm_jto_ammconfig", "clmm_jto_vault0", "clmm_jto_vault1", JTO_MINT),
    ] {
        let data = fixture_bytes(pool);
        assert_eq!(
            slice32(&data, idl.offset("PoolState", &["amm_config"])),
            manifest_pubkey(&m, config),
            "{pool}: amm_config"
        );
        assert_eq!(
            slice32(&data, idl.offset("PoolState", &["token_vault_0"])),
            manifest_pubkey(&m, vault0),
            "{pool}: token_vault_0"
        );
        assert_eq!(
            slice32(&data, idl.offset("PoolState", &["token_vault_1"])),
            manifest_pubkey(&m, vault1),
            "{pool}: token_vault_1"
        );
        let mint0 = slice32(&data, idl.offset("PoolState", &["token_mint_0"]));
        let mint1 = slice32(&data, idl.offset("PoolState", &["token_mint_1"]));
        let expected = [base58_decode(WSOL), base58_decode(target)];
        assert!(
            (mint0 == expected[0] && mint1 == expected[1])
                || (mint0 == expected[1] && mint1 == expected[0]),
            "{pool}: mints at IDL offsets are not (WSOL, target) in either order"
        );
        // Program's pinned discriminator (swap_and_burn.rs :947) vs the real
        // account's own first 8 bytes.
        assert_eq!(&data[0..8], &[247, 237, 227, 245, 215, 195, 222, 70], "{pool}: discriminator");
        let (lo, hi) = idl.offset("PoolState", &["sqrt_price_x64"]);
        let sqrt_price = u128::from_le_bytes(data[lo..hi].try_into().unwrap());
        assert!(sqrt_price != 0, "{pool}: sqrt_price_x64 is zero at the IDL offset");

        // AmmConfig: real bytes at IDL offsets. protocol_fee_rate is the
        // live-mainnet 120_000 the fuzz decoys borrow; trade_fee_rate must be
        // a plausible ppm fee.
        let config_bytes = fixture_bytes(&format!("{}.bin", config));
        assert_eq!(&config_bytes[0..8], &[218, 244, 33, 104, 203, 203, 43, 111], "{config}");
        let (lo, hi) = idl.offset("AmmConfig", &["protocol_fee_rate"]);
        assert_eq!(
            u32::from_le_bytes(config_bytes[lo..hi].try_into().unwrap()),
            120_000,
            "{config}: protocol_fee_rate at IDL offset"
        );
        let (lo, hi) = idl.offset("AmmConfig", &["trade_fee_rate"]);
        let fee = u32::from_le_bytes(config_bytes[lo..hi].try_into().unwrap());
        assert!(fee > 0 && fee < 1_000_000, "{config}: trade_fee_rate {fee}");
    }
}

// ===========================================================================
// 3. Raydium V4 (non-Anchor) — published-source field list, walked
// ===========================================================================

/// Field list transcribed from raydium-io/raydium-amm
/// program/src/state.rs (master, fetched 2026-08-26): `#[repr(C, packed)]`
/// AmmInfo = 16 u64 header, Fees (8 u64), StateData (10 u64 + 4 u128),
/// then the vault/mint pubkeys. No Anchor discriminator: base offset 0.
fn v4_offsets() -> BTreeMap<&'static str, (usize, usize)> {
    let header: [&str; 16] = [
        "status", "nonce", "order_num", "depth", "coin_decimals", "pc_decimals", "state",
        "reset_flag", "min_size", "vol_max_cut_ratio", "amount_wave", "coin_lot_size",
        "pc_lot_size", "min_price_multiplier", "max_price_multiplier", "sys_decimal_value",
    ];
    let fees: [&str; 8] = [
        "min_separate_numerator", "min_separate_denominator", "trade_fee_numerator",
        "trade_fee_denominator", "pnl_numerator", "pnl_denominator", "swap_fee_numerator",
        "swap_fee_denominator",
    ];
    // StateData: (name, size). u128s are the swap accumulators.
    let state_data: [(&str, usize); 13] = [
        ("need_take_pnl_coin", 8),
        ("need_take_pnl_pc", 8),
        ("total_pnl_pc", 8),
        ("total_pnl_coin", 8),
        ("pool_open_time", 8),
        ("padding0", 8),
        ("padding1", 8),
        ("orderbook_to_init_time", 8),
        ("swap_coin_in_amount", 16),
        ("swap_pc_out_amount", 16),
        ("swap_acc_pc_fee", 8),
        ("swap_pc_in_amount", 16),
        ("swap_coin_out_amount", 16),
    ];
    let tail: [(&str, usize); 5] = [
        ("swap_acc_coin_fee", 8),
        ("coin_vault", 32),
        ("pc_vault", 32),
        ("coin_vault_mint", 32),
        ("pc_vault_mint", 32),
    ];
    let mut offsets = BTreeMap::new();
    let mut at = 0usize;
    for name in header {
        offsets.insert(name, (at, at + 8));
        at += 8;
    }
    for name in fees {
        offsets.insert(name, (at, at + 8));
        at += 8;
    }
    for (name, size) in state_data.iter().chain(tail.iter()) {
        offsets.insert(name, (at, at + size));
        at += size;
    }
    offsets
}

/// Program table (src/swap_and_burn.rs): fee numerator/denominator :1093-1094
/// (144..152/152..160) and vaults :1048 (336/368). The fee the program reads
/// is the TRADE fee; Raydium's swap path charges the SWAP fee (176/184) —
/// see the module header. Both assertions below encode that fact.
#[test]
fn v4_offsets_match_published_layout_and_real_pool() {
    let offsets = v4_offsets();
    // The program's reads land on these published fields:
    assert_eq!(offsets["trade_fee_numerator"], (144, 152), "program reads 144..152");
    assert_eq!(offsets["trade_fee_denominator"], (152, 160), "program reads 152..160");
    assert_eq!(offsets["swap_fee_numerator"], (176, 184));
    assert_eq!(offsets["swap_fee_denominator"], (184, 192));
    assert_eq!(offsets["coin_vault"], (336, 368), "program reads vault at 336");
    assert_eq!(offsets["pc_vault"], (368, 400), "program reads vault at 368");

    // Reality check on the snapshotted JTO pool.
    let m = manifest();
    let data = fixture_bytes("v4_jto_pool.bin");
    let vault_a = manifest_pubkey(&m, "v4_jto_vault_a");
    let vault_b = manifest_pubkey(&m, "v4_jto_vault_b");
    let coin_vault = slice32(&data, offsets["coin_vault"]);
    let pc_vault = slice32(&data, offsets["pc_vault"]);
    assert!(
        (coin_vault == vault_a && pc_vault == vault_b)
            || (coin_vault == vault_b && pc_vault == vault_a),
        "v4 vault offsets do not reproduce the manifest vaults"
    );
    let coin_mint = slice32(&data, offsets["coin_vault_mint"]);
    let pc_mint = slice32(&data, offsets["pc_vault_mint"]);
    let jto = base58_decode(JTO_MINT);
    let wsol = base58_decode(WSOL);
    assert!(
        (coin_mint == jto && pc_mint == wsol) || (coin_mint == wsol && pc_mint == jto),
        "v4 mint offsets do not reproduce (JTO, WSOL)"
    );
}

/// THE DIVERGENCE SENTINEL. The program prices V4 legs off trade_fee
/// (144..160); raydium-amm's `process_swap_base_in` charges swap_fee
/// (176..192). Today both are 25/10000 on standard pools, which is the only
/// reason every same-hands fixture agrees with the program. If a snapshotted
/// pool ever has them differ, this test fails and the program's fee choice
/// must be resolved, not the test.
#[test]
fn v4_trade_fee_equals_swap_fee_in_real_pool() {
    let offsets = v4_offsets();
    let data = fixture_bytes("v4_jto_pool.bin");
    let read = |range: (usize, usize)| u64::from_le_bytes(data[range.0..range.1].try_into().unwrap());
    let trade = (read(offsets["trade_fee_numerator"]), read(offsets["trade_fee_denominator"]));
    let swap = (read(offsets["swap_fee_numerator"]), read(offsets["swap_fee_denominator"]));
    assert_eq!(trade, (25, 10_000), "expected the standard V4 trade fee");
    assert_eq!(
        trade, swap,
        "trade_fee != swap_fee in a real pool: the program reads trade_fee at 144..160 \
         (swap_and_burn.rs:1093) but Raydium charges swap_fee at 176..192 — the keyless \
         floor and cap are now priced off the WRONG fee for this pool"
    );
}

// ===========================================================================
// 4. Raydium CP (cp-swap) — published-source field list, walked
// ===========================================================================

/// Transcribed from raydium-io/raydium-cp-swap programs/cp-swap/src/states/
/// {pool.rs,config.rs} (master, fetched 2026-08-26). Anchor accounts: base 8.
#[test]
fn cp_offsets_match_published_layout() {
    // PoolState field order: amm_config, pool_creator, token_0_vault,
    // token_1_vault, lp_mint, token_0_mint, token_1_mint, ...
    let mut at = 8usize;
    let mut offsets: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (name, size) in [
        ("amm_config", 32usize),
        ("pool_creator", 32),
        ("token_0_vault", 32),
        ("token_1_vault", 32),
        ("lp_mint", 32),
        ("token_0_mint", 32),
        ("token_1_mint", 32),
    ] {
        offsets.insert(name, (at, at + size));
        at += size;
    }
    // Program reads (src/swap_and_burn.rs): amm_config :1151 area (8..40) via
    // `pd.get(8..40)`, vaults :1050 (72/104).
    assert_eq!(offsets["amm_config"], (8, 40));
    assert_eq!(offsets["token_0_vault"], (72, 104));
    assert_eq!(offsets["token_1_vault"], (104, 136));

    // AmmConfig field order: bump, disable_create_pool, index u16,
    // trade_fee_rate u64, protocol_fee_rate u64, ...
    let mut at = 8usize;
    let mut config: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (name, size) in [
        ("bump", 1usize),
        ("disable_create_pool", 1),
        ("index", 2),
        ("trade_fee_rate", 8),
        ("protocol_fee_rate", 8),
    ] {
        config.insert(name, (at, at + size));
        at += size;
    }
    // Program reads trade_fee_rate at fd 12..20 (swap_and_burn.rs :1105).
    assert_eq!(config["trade_fee_rate"], (12, 20));
    // NOTE (documented asymmetry, not asserted otherwise): unlike CLMM/DLMM,
    // the CP branch pins no account discriminator on the pool or config; its
    // identity rests on owner + config-address + vault cross-checks. No real
    // CP pool snapshot exists under tests/venue-fixtures to bytes-check.
}

// ===========================================================================
// 5. Pump bonding curve + PumpSwap pool + fee config
// ===========================================================================

/// Program table: curve reads at :818-:833 (len>=82, complete 48, vtr 8..16,
/// vqr 16..24, creator 49..81, mayhem 81) and directcurve.rs
/// `validate_pump_curve` (same fields). CLAUDE.md's curve-check entry names
/// mayhem 81 / cashback 82 / quote_mint 83..115.
#[test]
fn pump_bonding_curve_offsets_match_onchain_idl() {
    let idl = Idl::load("idl-pump.json");
    assert_eq!(idl.offset("BondingCurve", &["virtual_token_reserves"]), (8, 16));
    assert_eq!(idl.offset("BondingCurve", &["virtual_quote_reserves"]), (16, 24));
    assert_eq!(idl.offset("BondingCurve", &["complete"]), (48, 49));
    assert_eq!(idl.offset("BondingCurve", &["creator"]), (49, 81));
    assert_eq!(idl.offset("BondingCurve", &["is_mayhem_mode"]), (81, 82));
    assert_eq!(idl.offset("BondingCurve", &["is_cashback_coin"]), (82, 83));
    assert_eq!(idl.offset("BondingCurve", &["quote_mint"]), (83, 115));
}

/// Program table: PumpSwap pool creator :1116 (11..43), vaults :1052
/// (139/171), coin_creator :1130 (211..243), virtual_quote :1111 (245..261).
/// The IDL struct ENDS at 245: the virtual_quote read lives in the
/// post-`extend_account` extension region and is justified by mainnet
/// observation only (all scanned canonical pools 300/301 bytes). If a
/// refreshed IDL grows the struct past 245, this assertion fails and the
/// extension-region read must be re-derived against the new layout.
#[test]
fn pumpswap_pool_offsets_match_onchain_idl_and_extension_region() {
    let idl = Idl::load("idl-pumpswap.json");
    assert_eq!(idl.offset("Pool", &["creator"]), (11, 43));
    assert_eq!(idl.offset("Pool", &["pool_base_token_account"]), (139, 171));
    assert_eq!(idl.offset("Pool", &["pool_quote_token_account"]), (171, 203));
    assert_eq!(idl.offset("Pool", &["lp_supply"]), (203, 211));
    assert_eq!(idl.offset("Pool", &["coin_creator"]), (211, 243));
    // Struct end == where the program's extension-region i128 read begins.
    let fields = idl.fields_of("Pool");
    let (last_name, _) = fields.last().unwrap();
    let (_, end) = idl.offset("Pool", &[last_name]);
    assert_eq!(
        end, 245,
        "PumpSwap Pool IDL no longer ends at 245: the program's virtual_quote read at \
         245..261 (swap_and_burn.rs:1111) must be re-derived"
    );
}

// ===========================================================================
// 6. LIVE layout-drift sentinel (env-gated)
// ===========================================================================

/// The one thing no frozen fixture can do: notice a VENUE UPGRADE moving
/// fields. Given `KEYLESS_DRIFT_RPC` (a mainnet or mainnet-fork RPC URL),
/// fetch the reference pools' CURRENT bytes and re-run the same semantic
/// checks at the IDL-derived offsets. A struct reordering shows up as a
/// pubkey/discriminator mismatch here BEFORE it bricks or misprices a vault
/// on chain. Without the env var the test prints a loud skip and passes —
/// run it in any release gate with a live RPC.
///
/// Uses `curl` for transport so the test needs no HTTP dependency.
#[test]
fn live_layout_drift_sentinel() {
    let Ok(rpc) = std::env::var("KEYLESS_DRIFT_RPC") else {
        println!("SKIPPED: set KEYLESS_DRIFT_RPC=<rpc url> to run the live drift sentinel");
        return;
    };
    let fetch = |pubkey: &str| -> Vec<u8> {
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["{pubkey}",{{"encoding":"base64"}}]}}"#
        );
        let output = std::process::Command::new("curl")
            .args(["-s", "-m", "10", &rpc, "-X", "POST", "-H", "Content-Type: application/json", "-d", &body])
            .output()
            .expect("curl");
        let text = String::from_utf8(output.stdout).expect("utf8 rpc response");
        // Minimal extraction: "data":["<base64>","base64"]
        let marker = "\"data\":[\"";
        let start = text.find(marker).unwrap_or_else(|| panic!("{pubkey}: no data in {text}"))
            + marker.len();
        let end = start + text[start..].find('"').expect("data end");
        base64_decode(&text[start..end])
    };

    let m = manifest();
    let dlmm = Idl::load("idl-meteora-dlmm-onchain.json");
    let clmm = Idl::load("idl-raydium-clmm-onchain.json");

    // DLMM pools: discriminator + mints + reserves at IDL offsets.
    for (pool, x_mint, rx, ry) in [
        ("HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh", PUMP_MINT, "dlmm_pump_reserve_x", "dlmm_pump_reserve_y"),
        ("GZcP3ANuTD15ZrYaF1RacomBKXVCCKvXYyWVDaEDqkKi", JTO_MINT, "dlmm_jto_reserve_x", "dlmm_jto_reserve_y"),
    ] {
        let data = fetch(pool);
        assert_eq!(&data[0..8], &[33, 11, 49, 98, 181, 101, 177, 13], "{pool}: LIVE discriminator moved");
        assert_eq!(slice32(&data, dlmm.offset("LbPair", &["token_x_mint"])), base58_decode(x_mint), "{pool}: LIVE token_x_mint moved");
        assert_eq!(slice32(&data, dlmm.offset("LbPair", &["token_y_mint"])), base58_decode(WSOL), "{pool}: LIVE token_y_mint moved");
        assert_eq!(slice32(&data, dlmm.offset("LbPair", &["reserve_x"])), manifest_pubkey(&m, rx), "{pool}: LIVE reserve_x moved");
        assert_eq!(slice32(&data, dlmm.offset("LbPair", &["reserve_y"])), manifest_pubkey(&m, ry), "{pool}: LIVE reserve_y moved");
        let (lo, hi) = dlmm.offset("LbPair", &["bin_step"]);
        let bin_step = u16::from_le_bytes(data[lo..hi].try_into().unwrap());
        assert!(bin_step > 0 && bin_step <= 10_000, "{pool}: LIVE bin_step {bin_step}");
    }

    // CLMM pools + configs.
    for (pool, config_pk, config, vault0, vault1) in [
        ("45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5", "DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY", "clmm_pump_ammconfig", "clmm_pump_vault0", "clmm_pump_vault1"),
        ("JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo", "A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x", "clmm_jto_ammconfig", "clmm_jto_vault0", "clmm_jto_vault1"),
    ] {
        let data = fetch(pool);
        assert_eq!(&data[0..8], &[247, 237, 227, 245, 215, 195, 222, 70], "{pool}: LIVE discriminator moved");
        assert_eq!(slice32(&data, clmm.offset("PoolState", &["amm_config"])), manifest_pubkey(&m, config), "{pool}: LIVE amm_config moved");
        assert_eq!(slice32(&data, clmm.offset("PoolState", &["token_vault_0"])), manifest_pubkey(&m, vault0), "{pool}: LIVE vault0 moved");
        assert_eq!(slice32(&data, clmm.offset("PoolState", &["token_vault_1"])), manifest_pubkey(&m, vault1), "{pool}: LIVE vault1 moved");
        let (lo, hi) = clmm.offset("PoolState", &["sqrt_price_x64"]);
        assert!(u128::from_le_bytes(data[lo..hi].try_into().unwrap()) != 0, "{pool}: LIVE sqrt_price zero");
        let cfg = fetch(config_pk);
        assert_eq!(&cfg[0..8], &[218, 244, 33, 104, 203, 203, 43, 111], "{config}: LIVE discriminator moved");
        let (lo, hi) = clmm.offset("AmmConfig", &["trade_fee_rate"]);
        let fee = u32::from_le_bytes(cfg[lo..hi].try_into().unwrap());
        assert!(fee > 0 && fee < 1_000_000, "{config}: LIVE trade_fee_rate {fee}");
    }

    // V4 pool: vaults, mints, and the trade==swap fee sentinel on LIVE bytes.
    let offsets = v4_offsets();
    let data = fetch("EzLBvtY6gwdz5BGJnKDZGgYrMzm1PLKcxdViqRx5fSL1");
    let vault_a = manifest_pubkey(&m, "v4_jto_vault_a");
    let vault_b = manifest_pubkey(&m, "v4_jto_vault_b");
    let coin_vault = slice32(&data, offsets["coin_vault"]);
    let pc_vault = slice32(&data, offsets["pc_vault"]);
    assert!(
        (coin_vault == vault_a && pc_vault == vault_b) || (coin_vault == vault_b && pc_vault == vault_a),
        "v4: LIVE vault offsets moved"
    );
    let read = |range: (usize, usize)| u64::from_le_bytes(data[range.0..range.1].try_into().unwrap());
    assert_eq!(
        (read(offsets["trade_fee_numerator"]), read(offsets["trade_fee_denominator"])),
        (read(offsets["swap_fee_numerator"]), read(offsets["swap_fee_denominator"])),
        "v4: LIVE trade_fee != swap_fee — the program's fee read (144..160) now diverges from what Raydium charges"
    );
    println!("live drift sentinel: all venue layouts verified against {rpc}");
}

fn base64_decode(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for ch in text.bytes() {
        if ch == b'=' {
            break;
        }
        let value = ALPHABET.iter().position(|c| *c == ch).expect("base64 digit") as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// Program table (parse_pump_fee_config, swap_and_burn.rs :737-:763 and
/// directcurve.rs curve_fee_bps): flat lp/protocol/creator at 41/49/57, tier
/// vec count at 65..69, tier stride 40 with threshold u128 then
/// lp/protocol/creator at +16/+24/+32.
#[test]
fn pump_fee_config_offsets_match_onchain_idl_and_real_bytes() {
    let idl = Idl::load("idl-fee.json");
    assert_eq!(idl.offset("FeeConfig", &["flat_fees", "lp_fee_bps"]), (41, 49));
    assert_eq!(idl.offset("FeeConfig", &["flat_fees", "protocol_fee_bps"]), (49, 57));
    assert_eq!(idl.offset("FeeConfig", &["flat_fees", "creator_fee_bps"]), (57, 65));
    // The tier vec begins at 65: u32 count, then 40-byte FeeTier entries.
    let (vec_at, _) = idl.offset("FeeConfig", &["fee_tiers"]);
    assert_eq!(vec_at, 65);
    let tier = FieldType::Defined("FeeTier".to_string());
    assert_eq!(idl.size_of(&tier), 40);
    assert_eq!(idl.offset_from(0, "FeeTier", &["market_cap_lamports_threshold"]), (0, 16));
    assert_eq!(idl.offset_from(0, "FeeTier", &["fees", "lp_fee_bps"]), (16, 24));
    assert_eq!(idl.offset_from(0, "FeeTier", &["fees", "protocol_fee_bps"]), (24, 32));
    assert_eq!(idl.offset_from(0, "FeeTier", &["fees", "creator_fee_bps"]), (32, 40));

    // Real on-chain FeeConfig bytes (Pump.fun venue, snapshot 2026-08-23):
    // discriminator, sane tier table at the IDL offsets, sorted thresholds.
    let hex = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/venue-fixtures/idl/fee-config-pump-curve.hex"),
    )
    .expect("read fee config hex");
    let hex = hex.trim();
    let data: Vec<u8> = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
        .collect();
    assert_eq!(&data[0..8], &[143, 52, 146, 187, 219, 123, 76, 155], "fee config discriminator");
    let count =
        u32::from_le_bytes(data[65..69].try_into().unwrap()) as usize;
    assert!(count > 0 && count <= 64, "implausible tier count {count}");
    assert!(data.len() >= 69 + 40 * count, "tier table truncated");
    let mut previous = 0u128;
    for i in 0..count {
        let at = 69 + 40 * i;
        let threshold = u128::from_le_bytes(data[at..at + 16].try_into().unwrap());
        assert!(i == 0 || threshold >= previous, "tier thresholds not sorted at {i}");
        previous = threshold;
        for (name, lo) in [("lp", 16), ("protocol", 24), ("creator", 32)] {
            let bps = u64::from_le_bytes(data[at + lo..at + lo + 8].try_into().unwrap());
            assert!(bps <= 10_000, "tier {i} {name} fee {bps} bps implausible");
        }
    }
}
