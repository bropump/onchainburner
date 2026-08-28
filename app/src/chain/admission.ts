import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  BPS_TOTAL,
  MAX_SPLIT_TARGETS,
  PUMP_FUN_PROGRAM,
  PUMP_TOKEN_MINT,
  T22_EXTENSION_NAMES,
  TOKEN_2022_NATIVE_MINT,
  WSOL_MINT,
} from "./constants";

/**
 * Client-side mirrors of the program's admission checks, read straight from
 * raw mint account bytes. These exist so a user sees WHY a config is
 * inadmissible before spending anything; the authoritative verdict is the
 * on-chain `validate_config` simulation, which runs the burn's own code.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "info";

export type CheckResult = {
  id: string;
  label: string;
  status: CheckStatus;
  /** Program error code this check mirrors, when it fails. */
  code?: number;
  detail: string;
};

export type MintFacts = {
  address: string;
  exists: boolean;
  tokenProgram: PublicKey | null;
  decimals: number | null;
  supply: bigint | null;
  checks: CheckResult[];
  admissible: boolean;
};

/** Weight/shape checks (6032/6033/6034) — pure, no chain reads. */
export function checkLegShape(
  legs: { mint: string; bps: number }[]
): CheckResult[] {
  const results: CheckResult[] = [];
  const countOk = legs.length >= 1 && legs.length <= MAX_SPLIT_TARGETS;
  results.push({
    id: "leg-count",
    label: "Leg count 1–4",
    status: countOk ? "pass" : "fail",
    code: countOk ? undefined : 6032,
    detail: countOk
      ? `${legs.length} leg${legs.length === 1 ? "" : "s"}`
      : `${legs.length} legs — the program caps splits at ${MAX_SPLIT_TARGETS}`,
  });

  const sum = legs.reduce((total, leg) => total + (leg.bps || 0), 0);
  const allPositive = legs.every(
    (leg) => Number.isInteger(leg.bps) && leg.bps > 0
  );
  const weightsOk = sum === BPS_TOTAL && allPositive;
  results.push({
    id: "weights",
    label: "Weights sum to 10,000 bps",
    status: weightsOk ? "pass" : "fail",
    code: weightsOk ? undefined : 6033,
    detail: weightsOk
      ? legs.map((l) => `${l.bps}`).join(" + ") + " = 10,000"
      : !allPositive
      ? "every weight must be a positive integer"
      : `weights sum to ${sum.toLocaleString()}, not 10,000`,
  });

  const distinct = new Set(legs.map((l) => l.mint)).size === legs.length;
  results.push({
    id: "distinct",
    label: "Target mints distinct",
    status: distinct ? "pass" : "fail",
    code: distinct ? undefined : 6034,
    detail: distinct
      ? "no duplicates"
      : "the same mint appears in more than one leg",
  });
  return results;
}

function isZero(data: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (data[i] !== 0) return false;
  return true;
}

/**
 * Read one target mint and mirror the program's admission rules:
 * owner program (6010), native identity (6038), freeze authority (6036),
 * mint authority (6037), Token-2022 extension allow-list (6024/6013).
 */
export function analyzeTargetMint(
  address: PublicKey,
  info: { owner: PublicKey; data: Uint8Array } | null
): MintFacts {
  const checks: CheckResult[] = [];
  const facts: MintFacts = {
    address: address.toBase58(),
    exists: info !== null,
    tokenProgram: info?.owner ?? null,
    decimals: null,
    supply: null,
    checks,
    admissible: false,
  };
  if (!info) {
    checks.push({
      id: "exists",
      label: "Mint account exists",
      status: "fail",
      code: 6010,
      detail: "no account at this address on the current network",
    });
    return facts;
  }

  const isLegacy = info.owner.equals(TOKEN_PROGRAM_ID);
  const isT22 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  checks.push({
    id: "owner",
    label: "Owned by a token program",
    status: isLegacy || isT22 ? "pass" : "fail",
    code: isLegacy || isT22 ? undefined : 6010,
    detail: isLegacy
      ? "SPL Token"
      : isT22
      ? "Token-2022"
      : `owner is ${info.owner.toBase58()}`,
  });
  if (!isLegacy && !isT22) return facts;

  const data = info.data;
  if (data.length < 82 || data[45] !== 1) {
    checks.push({
      id: "layout",
      label: "Valid mint layout",
      status: "fail",
      code: 6013,
      detail:
        data.length < 82
          ? `account data is ${data.length} bytes, expected at least 82`
          : "mint is not initialized",
    });
    return facts;
  }
  facts.decimals = data[44];
  facts.supply = new DataView(
    data.buffer,
    data.byteOffset + 36,
    8
  ).getBigUint64(0, true);

  const native =
    address.equals(WSOL_MINT) || address.equals(TOKEN_2022_NATIVE_MINT);
  checks.push({
    id: "native",
    label: "Not a native (wrapped SOL) mint",
    status: native ? "fail" : "pass",
    code: native ? 6038 : undefined,
    detail: native
      ? "a WSOL vault could be funded but never burned"
      : "not WSOL",
  });

  const mintAuthorityNone = isZero(data, 0, 4);
  checks.push({
    id: "mint-authority",
    label: "Mint authority is null",
    status: mintAuthorityNone ? "pass" : "fail",
    code: mintAuthorityNone ? undefined : 6037,
    detail: mintAuthorityNone
      ? "supply is fixed — a burn is a real reduction"
      : `live mint authority ${new PublicKey(data.slice(4, 36)).toBase58()}`,
  });

  const freezeAuthorityNone = isZero(data, 46, 50);
  checks.push({
    id: "freeze-authority",
    label: "Freeze authority is null",
    status: freezeAuthorityNone ? "pass" : "fail",
    code: freezeAuthorityNone ? undefined : 6036,
    detail: freezeAuthorityNone
      ? "the vault's token account can never be frozen"
      : `live freeze authority ${new PublicKey(
          data.slice(50, 82)
        ).toBase58()} could brick the vault forever`,
  });

  if (isT22) {
    checks.push(...analyzeT22Extensions(address, data));
  }

  facts.admissible = checks.every((c) => c.status !== "fail");
  return facts;
}

/** Walk the Token-2022 TLV area. Allow-list: MetadataPointer, TokenMetadata.
 * TransferHook passes only for the exact $PUMP mint. Anything else fails. */
function analyzeT22Extensions(
  address: PublicKey,
  data: Uint8Array
): CheckResult[] {
  if (data.length === 82) {
    return [
      {
        id: "t22-extensions",
        label: "Token-2022 extensions allowed",
        status: "pass",
        detail: "no extensions",
      },
    ];
  }
  if (data.length <= 165) {
    return [
      {
        id: "t22-extensions",
        label: "Token-2022 extensions allowed",
        status: "fail",
        code: 6013,
        detail: `malformed extended mint (${data.length} bytes)`,
      },
    ];
  }
  const results: CheckResult[] = [];
  const seen: string[] = [];
  let cursor = 166;
  let failed: CheckResult | null = null;
  while (cursor + 4 <= data.length) {
    const type = data[cursor] | (data[cursor + 1] << 8);
    const length = data[cursor + 2] | (data[cursor + 3] << 8);
    if (type === 0) break;
    const name = T22_EXTENSION_NAMES[type] ?? `Unknown(${type})`;
    seen.push(name);
    if (type === 18 || type === 19) {
      // MetadataPointer / TokenMetadata: allowed.
    } else if (type === 14) {
      if (!address.equals(PUMP_TOKEN_MINT)) {
        failed = {
          id: "t22-extensions",
          label: "Token-2022 extensions allowed",
          status: "fail",
          code: 6024,
          detail: `TransferHook is refused — even an inert one can be activated later and brick every future burn. Only the exact $PUMP identity is allowed.`,
        };
      }
    } else if (T22_EXTENSION_NAMES[type]) {
      failed = {
        id: "t22-extensions",
        label: "Token-2022 extensions allowed",
        status: "fail",
        code: 6024,
        detail: `${name} is not on the allow-list (only MetadataPointer and TokenMetadata pass)`,
      };
    } else {
      failed = {
        id: "t22-extensions",
        label: "Token-2022 extensions allowed",
        status: "fail",
        code: 6013,
        detail: `extension type ${type} is unknown to the decoder — fails closed`,
      };
    }
    cursor += 4 + length;
  }
  if (failed) {
    results.push({
      ...failed,
      detail: `${failed.detail} [${seen.join(", ")}]`,
    });
  } else {
    results.push({
      id: "t22-extensions",
      label: "Token-2022 extensions allowed",
      status: "pass",
      detail: seen.length
        ? seen.join(", ") +
          (address.equals(PUMP_TOKEN_MINT) && seen.includes("TransferHook")
            ? " — exact $PUMP identity"
            : "")
        : "no extensions",
    });
  }
  return results;
}

export async function fetchTargetMintFacts(
  connection: Connection,
  mints: PublicKey[]
): Promise<MintFacts[]> {
  const infos = await connection.getMultipleAccountsInfo(mints, "confirmed");
  return mints.map((mint, i) => {
    const info = infos[i];
    return analyzeTargetMint(
      mint,
      info ? { owner: info.owner, data: info.data } : null
    );
  });
}

export type PumpCurveFacts = {
  exists: boolean;
  curveAddress: string;
  mayhem: boolean;
  cashback: boolean;
  solQuoted: boolean;
  quoteMint: string | null;
  complete: boolean | null;
  /** The launch creator recorded on the curve (bytes 49..81). */
  creator: string | null;
  checks: CheckResult[];
};

export function bondingCurveAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  )[0];
}

/**
 * The single most important pre-funding check for a creator. The shipped
 * product supports only normal, SOL-quoted Pump launches. Cashback and
 * non-SOL launches pay the vault ZERO creator fees in SOL and fail silently;
 * mayhem is excluded by product policy even though it currently pays SOL.
 * Reads the bonding curve:
 * byte 81 = mayhem flag, byte 82 = cashback flag, bytes 83..115 = quote mint
 * (all-zero for a normal SOL launch).
 */
export async function fetchPumpCurveFacts(
  connection: Connection,
  mint: PublicKey
): Promise<PumpCurveFacts> {
  const curve = bondingCurveAddress(mint);
  const info = await connection.getAccountInfo(curve, "confirmed");
  const checks: CheckResult[] = [];
  if (!info || !info.owner.equals(PUMP_FUN_PROGRAM)) {
    checks.push({
      id: "pump-curve",
      label: "Pump bonding curve",
      status: "info",
      detail:
        "no bonding curve — not a Pump launch. The vault still accepts SOL from any source (fee claims, plain transfers).",
    });
    return {
      exists: false,
      curveAddress: curve.toBase58(),
      mayhem: false,
      cashback: false,
      solQuoted: true,
      quoteMint: null,
      complete: null,
      creator: null,
      checks,
    };
  }
  const data = info.data;
  if (data.length < 115) {
    checks.push({
      id: "pump-curve",
      label: "Pump bonding curve layout",
      status: "fail",
      detail: `account is ${data.length} bytes; at least 115 are required to verify launch mode and quote mint — refusing to guess`,
    });
    return {
      exists: true,
      curveAddress: curve.toBase58(),
      mayhem: false,
      cashback: false,
      solQuoted: false,
      quoteMint: null,
      complete: null,
      creator: null,
      checks,
    };
  }
  const mayhem = data.length > 81 && data[81] !== 0;
  const cashback = data.length > 82 && data[82] !== 0;
  const quoteBytes = data.slice(83, 115);
  const solQuoted = quoteBytes.every((b) => b === 0);
  const quoteMint = !solQuoted ? new PublicKey(quoteBytes).toBase58() : null;
  const complete = data[48] !== 0;
  const creator = new PublicKey(data.slice(49, 81)).toBase58();

  const ok = !mayhem && !cashback && solQuoted;
  checks.push({
    id: "pump-curve",
    label: "Pump launch pays creator fees in SOL",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "normal SOL-quoted launch — creator fees fund the vault"
      : [
          mayhem
            ? "mayhem mode is outside the supported normal-launch policy"
            : null,
          cashback
            ? "cashback mode pays creator fees to buyers, not the vault"
            : null,
          quoteMint ? `quoted in ${quoteMint.slice(0, 8)}… not SOL` : null,
        ]
          .filter(Boolean)
          .join(", ") + " — do not point its fee share at this vault",
  });
  return {
    exists: true,
    curveAddress: curve.toBase58(),
    mayhem,
    cashback,
    solQuoted,
    quoteMint,
    complete,
    creator,
    checks,
  };
}
