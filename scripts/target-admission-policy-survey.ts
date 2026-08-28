/**
 * Target-mint ADMISSION POLICY survey (read-only, live mainnet).
 *
 * Replicates, byte-for-byte and in the same order, the production admission
 * decision of `programs/burner/src/token.rs::validate_target_mint`
 * plus the handler preconditions in `swap_and_burn.rs::validate_burner`, then
 * evaluates it against a broad sample of real mainnet mints:
 *
 *   handler: mint owner must be legacy SPL Token or Token-2022  -> 6010
 *   token.rs:26-31   len >= 82 && is_initialized@45 == 1        -> 6013
 *   token.rs:136-144 freeze_authority tag 46..50 must be zero   -> 6036
 *   token.rs:146-153 mint_authority tag 0..4 must be zero       -> 6037
 *   legacy SPL: accept here
 *   Token-2022:
 *     StateWithExtensions::unpack: len != 355 (multisig), a data
 *       length in (82,166), or account_type@165 != Mint         -> 6013
 *     get_extension_types: any TLV type UNKNOWN to
 *       spl-token-2022 6.0.0 (discriminant > 24)                -> 6013
 *     allow-list walk in TLV order:
 *       MetadataPointer(18), TokenMetadata(19)                  -> allowed
 *       TransferHook(14): allowed ONLY for the exact $PUMP mint,
 *         exact DMdBa81... authority, hook program id None      -> else 6024
 *       everything else                                         -> 6024
 *
 * The verdict printed is therefore the PREDICTED on-chain admission verdict,
 * derived from the same bytes the program reads.
 *
 * Run: npx tsx scripts/target-admission-policy-survey.ts
 * Env: RPC_URL (default https://api.mainnet-beta.solana.com)
 */
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TOKEN_LEGACY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const PUMP_HOOK_AUTHORITY = "DMdBa812dBW1CHVhmTyUyVcrBnSbZbfoFC7U14k4riH1";

// ExtensionType names. 0..24 exist in spl-token-2022 6.0.0 (the version the
// program links); entries marked * were added later, so the on-chain decoder
// errors on them (fails closed as 6013).
const EXT_NAMES: Record<number, string> = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmountConfig*",
  26: "PausableConfig*",
  27: "PausableAccount*",
};
const KNOWN_TO_6_0_0 = 24; // highest discriminant spl-token-2022 6.0.0 decodes

interface Verdict {
  accept: boolean;
  code?: number;
  name?: string;
  reason?: string;
}
interface Row {
  label: string;
  category: string;
  mint: string;
  program: string; // "legacy" | "t22" | other owner
  decimals?: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  verdict: Verdict;
}

const rej = (code: number, name: string, reason: string): Verdict => ({
  accept: false,
  code,
  name,
  reason,
});

function coptionTagKey(data: Buffer, tag: number, key: number): string | null {
  // Mirrors the program: any NON-ZERO tag counts as live (fail-closed).
  if (data.length < key + 32) return null;
  if (data.readUInt32LE(tag) === 0) return null;
  return new PublicKey(data.subarray(key, key + 32)).toBase58();
}

/** The exact admission decision, in the program's order. */
function admissionVerdict(mintB58: string, owner: string, data: Buffer): Verdict {
  // swap_and_burn.rs:268-274 / split.rs:424-430: the declared target token
  // program must be one of the two real token programs and must own the mint.
  if (owner !== TOKEN_LEGACY && owner !== TOKEN_2022)
    return rej(6010, "InvalidMintOwner", `owner=${owner}`);
  // token.rs:26-31 (mint_decimals)
  if (data.length < 82 || data[45] !== 1)
    return rej(6013, "InvalidMintData", `len=${data.length} init=${data[45]}`);
  // token.rs:136-144 (freeze_authority_is_none) -- tag bytes 46..50
  if (data.readUInt32LE(46) !== 0)
    return rej(6036, "TargetMintFreezable", "live freeze authority");
  // token.rs:146-153 (mint_authority_is_none) -- tag bytes 0..4
  if (data.readUInt32LE(0) !== 0)
    return rej(6037, "TargetMintMintable", "live mint authority");
  if (owner === TOKEN_LEGACY) return { accept: true };

  // ---- Token-2022: StateWithExtensions::<Mint>::unpack (token.rs:167-168) --
  if (data.length === 355) return rej(6013, "InvalidMintData", "multisig-length account");
  if (data.length === 82) return { accept: true }; // no TLV area at all
  if (data.length <= 165)
    return rej(6013, "InvalidMintData", "truncated extension area");
  if (data[165] !== 1)
    return rej(6013, "InvalidMintData", `account_type=${data[165]}`);

  // ---- get_extension_types (token.rs:180-182): TLV walk, 6.0.0 knowledge --
  const found: { type: number; value: Buffer }[] = [];
  let cursor = 166;
  while (cursor < data.length) {
    if (data.length - cursor < 2) break; // trailing realloc byte: fine
    const type = data.readUInt16LE(cursor);
    if (type > KNOWN_TO_6_0_0)
      return rej(
        6013,
        "InvalidMintData",
        `extension ${EXT_NAMES[type] ?? `Unknown(${type})`} unknown to spl-token-2022 6.0.0`
      );
    if (type === 0) break; // Uninitialized: padding sentinel, walk ends
    if (data.length - cursor < 4)
      return rej(6013, "InvalidMintData", "truncated TLV length");
    const len = data.readUInt16LE(cursor + 2);
    if (cursor + 4 + len > data.length)
      return rej(6013, "InvalidMintData", "TLV value overruns account");
    found.push({ type, value: data.subarray(cursor + 4, cursor + 4 + len) });
    cursor += 4 + len;
  }

  // ---- allow-list walk (token.rs:184-209), first offender wins ------------
  for (const e of found) {
    if (e.type === 18 || e.type === 19) continue; // MetadataPointer, TokenMetadata
    if (e.type === 14) {
      if (e.value.length !== 64)
        return rej(6013, "InvalidMintData", "malformed TransferHook TLV");
      const authority = e.value.subarray(0, 32);
      const programId = e.value.subarray(32, 64);
      const authorityB58 = new PublicKey(authority).toBase58();
      const inert = programId.every((b) => b === 0);
      if (mintB58 === PUMP_MINT && authorityB58 === PUMP_HOOK_AUTHORITY && inert) continue;
      return rej(
        6024,
        "UnsupportedToken2022Extension",
        `TransferHook authority=${authority.every((b) => b === 0) ? "None" : authorityB58} program=${
          inert ? "None" : new PublicKey(programId).toBase58()
        }`
      );
    }
    return rej(6024, "UnsupportedToken2022Extension", EXT_NAMES[e.type]);
  }
  return { accept: true };
}

function extensionNames(owner: string, data: Buffer): string[] {
  if (owner !== TOKEN_2022 || data.length <= 165 || data[165] !== 1) return [];
  const names: string[] = [];
  let cursor = 166;
  while (cursor + 4 <= data.length) {
    const type = data.readUInt16LE(cursor);
    if (type === 0) break;
    const len = data.readUInt16LE(cursor + 2);
    names.push(EXT_NAMES[type] ?? `Unknown(${type})`);
    if (cursor + 4 + len > data.length) break;
    cursor += 4 + len;
  }
  return names;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(url: string, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return (await res.json()) as T;
    if (i >= tries - 1) throw new Error(`${url} -> HTTP ${res.status}`);
    await sleep(1200 * (i + 1));
  }
}

async function resolveSymbol(symbol: string): Promise<string | null> {
  try {
    const hits = await fetchJson<any[]>(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(symbol)}`
    );
    const exact = hits
      .filter((t) => (t.symbol ?? "").toUpperCase() === symbol.toUpperCase())
      .sort((a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0))[0];
    return exact ? (exact.id as string) : null;
  } catch {
    return null;
  }
}

async function main() {
  // ---- sample construction ------------------------------------------------
  // Addresses pinned from repo-verified sources (CLAUDE.md, constants.rs,
  // token.rs tests) plus universally-known mints.
  const pinned: [string, string, string][] = [
    ["JTO", "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", "bluechip"],
    ["BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "bluechip"],
    ["WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "bluechip"],
    ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "stablecoin"],
    ["USDT", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "stablecoin"],
    ["$PUMP", "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "token2022"],
    ["PYUSD", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "t22-stable"],
    ["USDG", "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", "t22-stable"],
    ["TSLAx", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", "equity"],
    ["BILAL", "BPiCcYXUzp6qs1WucMUv4hU1bcKfdn5Db62tVbRuwApt", "token2022"],
    // WSOL: deliberately included -- the program ACCEPTS it as a target mint
    // (legacy, both authorities None) yet a WSOL-target vault can never burn
    // (BurnChecked on a native account is NativeNotSupported).
    ["WSOL", "So11111111111111111111111111111111111111112", "special"],
  ];
  const toResolve: [string, string][] = [
    ["RAY", "bluechip"],
    ["ORCA", "bluechip"],
    ["JUP", "bluechip"],
    ["PYTH", "bluechip"],
    ["POPCAT", "bluechip"],
    ["FARTCOIN", "bluechip"],
    ["MEW", "bluechip"],
    ["BOME", "bluechip"],
    ["PNUT", "bluechip"],
    ["GOAT", "bluechip"],
    ["MOODENG", "bluechip"],
    ["TRUMP", "bluechip"],
    ["W", "bluechip"],
    ["NEIRO", "bluechip"],
    ["MET", "governance"],
    ["META", "governance"],
    ["JitoSOL", "lst"],
    ["mSOL", "lst"],
    ["bSOL", "lst"],
    ["INF", "lst"],
    ["jupSOL", "lst"],
    ["ai16z", "token2022"],
    ["AAPLx", "equity"],
    ["NVDAx", "equity"],
  ];

  const sample: { label: string; mint: string; category: string }[] = pinned.map(
    ([label, mint, category]) => ({ label, mint, category })
  );

  console.error("resolving symbols via lite-api.jup.ag ...");
  for (const [symbol, category] of toResolve) {
    const mint = await resolveSymbol(symbol);
    if (mint) sample.push({ label: symbol, mint, category });
    else console.error(`  UNRESOLVED: ${symbol}`);
    await sleep(650);
  }

  console.error("fetching recent pump.fun launches ...");
  const recent = await fetchJson<any[]>("https://lite-api.jup.ag/tokens/v2/recent?limit=100");
  const seen = new Set(sample.map((s) => s.mint));
  let pumpCount = 0;
  for (const t of recent) {
    const pad = String(t.launchpad ?? "").toLowerCase();
    const isPump = pad.includes("pump") || String(t.id).endsWith("pump");
    if (!isPump || seen.has(t.id) || pumpCount >= 30) continue;
    seen.add(t.id);
    sample.push({ label: `pump:${t.symbol ?? "?"}`, mint: t.id, category: "pump-recent" });
    pumpCount++;
  }
  console.error(`sample size: ${sample.length} (${pumpCount} recent pump launches)\n`);

  // ---- on-chain read ------------------------------------------------------
  const connection = new Connection(RPC, "confirmed");
  const slot = await connection.getSlot("confirmed");
  const infos: (Awaited<ReturnType<Connection["getAccountInfo"]>> | null)[] = [];
  for (let i = 0; i < sample.length; i += 75) {
    const chunk = sample.slice(i, i + 75).map((s) => new PublicKey(s.mint));
    infos.push(...(await connection.getMultipleAccountsInfo(chunk, "confirmed")));
    await sleep(400);
  }

  const rows: Row[] = sample.map((s, i) => {
    const info = infos[i];
    if (!info)
      return {
        ...s,
        program: "-",
        mintAuthority: null,
        freezeAuthority: null,
        extensions: [],
        verdict: rej(0, "NoSuchAccount", "mint account not found"),
      };
    const owner = info.owner.toBase58();
    const data = Buffer.from(info.data);
    return {
      ...s,
      program: owner === TOKEN_LEGACY ? "legacy" : owner === TOKEN_2022 ? "t22" : owner,
      decimals: data.length >= 82 ? data[44] : undefined,
      mintAuthority: coptionTagKey(data, 0, 4),
      freezeAuthority: coptionTagKey(data, 46, 50),
      extensions: extensionNames(owner, data),
      verdict: admissionVerdict(s.mint, owner, data),
    };
  });

  // ---- report -------------------------------------------------------------
  console.log(`# target-mint admission survey  slot=${slot}  rpc=${RPC}`);
  console.log(`# spl-token-2022 6.0.0 decoder semantics; verdicts in program order\n`);
  const short = (k: string | null) => (k ? k.slice(0, 8) + ".." : "None");
  const catOrder = [
    "bluechip",
    "token2022",
    "t22-stable",
    "stablecoin",
    "lst",
    "equity",
    "governance",
    "special",
    "pump-recent",
  ];
  rows.sort(
    (a, b) =>
      catOrder.indexOf(a.category) - catOrder.indexOf(b.category) ||
      a.label.localeCompare(b.label)
  );
  console.log(
    "label".padEnd(16) +
      "category".padEnd(12) +
      "prog".padEnd(8) +
      "mintAuth".padEnd(11) +
      "freeze".padEnd(11) +
      "verdict".padEnd(30) +
      "extensions"
  );
  for (const r of rows) {
    const v = r.verdict.accept
      ? "ACCEPT"
      : `REJECT ${r.verdict.code} ${r.verdict.name}`;
    console.log(
      r.label.slice(0, 15).padEnd(16) +
        r.category.padEnd(12) +
        r.program.slice(0, 7).padEnd(8) +
        short(r.mintAuthority).padEnd(11) +
        short(r.freezeAuthority).padEnd(11) +
        v.padEnd(30) +
        (r.extensions.join(",") || "-")
    );
    if (!r.verdict.accept && r.verdict.reason)
      console.log("".padEnd(16) + `  reason: ${r.verdict.reason}   mint: ${r.mint}`);
  }

  // ---- summary ------------------------------------------------------------
  console.log("\n# summary by category");
  const cats = new Map<string, { accept: number; byCode: Map<string, number> }>();
  for (const r of rows) {
    const c = cats.get(r.category) ?? { accept: 0, byCode: new Map() };
    if (r.verdict.accept) c.accept++;
    else {
      const k = `${r.verdict.code} ${r.verdict.name}`;
      c.byCode.set(k, (c.byCode.get(k) ?? 0) + 1);
    }
    cats.set(r.category, c);
  }
  for (const [cat, c] of cats) {
    const rejects = [...c.byCode].map(([k, n]) => `${n}x ${k}`).join(", ");
    const total = rows.filter((r) => r.category === cat).length;
    console.log(`  ${cat.padEnd(12)} ${c.accept}/${total} accepted${rejects ? `; ${rejects}` : ""}`);
  }

  const burnPlausible = new Set(["bluechip", "token2022", "pump-recent"]);
  const wantedButRefused = rows.filter(
    (r) => burnPlausible.has(r.category) && !r.verdict.accept
  );
  console.log(
    `\n# burn-plausible tokens refused: ${
      wantedButRefused.length === 0
        ? "none"
        : wantedButRefused.map((r) => `${r.label}(${r.verdict.code})`).join(", ")
    }`
  );
  const acceptedTotal = rows.filter((r) => r.verdict.accept).length;
  console.log(`# total: ${acceptedTotal}/${rows.length} accepted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
