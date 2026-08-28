/**
 * Surfpool mainnet-fork coverage for `swap_and_burn_split`: one vault, one
 * call, N atomic swap-and-burns.
 *
 * The split lives in the PDA seeds, so every configuration under test is a
 * distinct vault. Each case funds its own vault, requests one Jupiter quote
 * per leg at the exact lamports the program will allocate to that leg, and
 * asserts that all legs burned, that the vault spent exactly the authorized
 * total, and that every target's on-chain supply fell.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const JUPITER_API = process.env.JUPITER_API_URL ?? "https://api.jup.ag/swap/v2";

const PROGRAM = new PublicKey("5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV");
const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
const JUPITER_EVENT_AUTHORITY = new PublicKey(
  "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
);
const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";
/** `sha256("global:swap_and_burn_split")[0..8]` */
const SPLIT_DISCRIMINATOR = Buffer.from([157, 45, 186, 225, 142, 17, 2, 105]);
const BPS_TOTAL = 10_000;
const MAX_TRANSACTION_BYTES = 1232;

// Error codes are shared with the Anchor reference for 6000..=6026; 6027..
// are the Pinocchio-only framework and split codes.
const ERROR_NAMES: Record<number, string> = {
  6000: "ZeroInput",
  6001: "InsufficientBurnerBalance",
  6002: "ZeroMinimumOutput",
  6003: "InvalidJupiterProgram",
  6004: "InvalidQuoteAuthority",
  6005: "InvalidJupiterInstruction",
  6006: "InvalidJupiterAccounts",
  6007: "JupiterPlatformFeeNotAllowed",
  // V2's stable scalar prefix lets the burner bind Jupiter's input to the
  // exact per-leg amount it authorized without parsing the extensible route.
  6008: "JupiterInputAmountMismatch",
  6009: "InvalidTokenProgram",
  6010: "InvalidMintOwner",
  6011: "InvalidTokenAccountOwner",
  6012: "InvalidBurnPda",
  6013: "InvalidMintData",
  6014: "InvalidTokenAccountData",
  6015: "InvalidTokenMint",
  6016: "InvalidTokenAuthority",
  6017: "WsolFundingMismatch",
  6018: "WsolNotFullyConsumed",
  6019: "BurnPdaLamportMismatch",
  6020: "TargetBalanceDecreased",
  6021: "SlippageExceeded",
  6022: "BurnIncomplete",
  6023: "IntermediateBalanceRemaining",
  6024: "UnsupportedToken2022Extension",
  6025: "UnsupportedToken2022AccountExtension",
  6026: "BurnRemainderBelowRentFloor",
  6027: "InvalidInstructionData",
  6028: "NotEnoughAccountKeys",
  6029: "MissingRequiredSignature",
  6030: "AccountNotMutable",
  6031: "InvalidSystemProgram",
  6032: "InvalidSplitTargetCount",
  6033: "InvalidSplitWeights",
  6034: "DuplicateSplitTarget",
  6035: "TokenAccountEncumbered",
  6036: "TargetMintFreezable",
  6037: "TargetMintMintable",
  6038: "TargetMintNative",
};

const TOKENS = {
  NEIRO: new PublicKey("CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump"),
  PUMP: new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"),
  JTO: new PublicKey("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"),
  BONK: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
  WIF: new PublicKey("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"),
  FARTCOIN: new PublicKey("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"),
  POPCAT: new PublicKey("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"),
  USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  RAY: new PublicKey("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"),
} as const;

/**
 * Venues a Surfpool fork can serve when `FORK_DEX_PROFILE=pool` is selected.
 *
 * Production is unrestricted by default. This opt-in whitelist exists because
 * Chasing fork-only exclusions does not converge: every market-maker / RFQ
 * venue removed
 * (SolFi, HumidiFi, GoonFi V2, Aquifer, AlphaQ, Scorch, Omnipair, TesseraV,
 * SolFi V2 ...) just makes Jupiter pick the next one, and those venues quote
 * off private state a fork has no copy of. Pool-based AMMs keep their state in
 * accounts, which a fork does have.
 *
 * Pump's venues ARE included. `ensurePumpVolumeAccumulators`, the missing-route
 * ATA loop, and `ensureBondingCurvesMigrated` pre-pay every deterministic rent
 * charge from the caller. V2 then closes the venue's accumulator back to the
 * vault; the burner admits only that exact validated refund in its otherwise
 * exact lamport postcondition.
 *
 * This is a FORK EXECUTION profile only. The program validates account pins
 * and postconditions, never venues, so nothing here narrows what production
 * accepts -- on mainnet Jupiter routes unrestricted, as CLAUDE.md requires.
 */
const POOL_ONLY_FORK_DEXES = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
  "Pump.fun Amm",
  "Pump.fun",
];
const FORK_ROUTABLE_DEXES = process.env.FORK_DEXES
  ? process.env.FORK_DEXES.split(",").filter(Boolean)
  : process.env.FORK_DEX_PROFILE === "pool"
  ? POOL_ONLY_FORK_DEXES
  : [];

/**
 * Jupiter `maxAccounts` per leg, by leg count. Solana caps a transaction at
 * 64 account locks and 1232 wire bytes; the fixed burner accounts plus 3 per
 * target leave roughly this much room per route.
 */
const DEFAULT_MAX_ACCOUNTS_PER_LEG: Record<number, number | undefined> = {
  1: undefined,
  2: 26,
  3: 16,
  4: 12,
};

type Leg = {
  label: string;
  mint: PublicKey;
  bps: number;
  dexes?: string[];
};

type PreparedLeg = Leg & {
  tokenProgram: PublicKey;
  ata: PublicKey;
  amountIn: bigint;
  minimumOutput: bigint;
  routeAccounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  jupiterData: Buffer;
  lookupTables: string[];
  resolvedLookupTables: AddressLookupTableAccount[];
  slippageBps: number;
  slippageSource: string;
  routeLabel: string;
  /** Jupiter's reported price impact for the exact built route, when present. */
  routePriceImpactPct?: string;
  /**
   * Byte offset of the `track_volume` flag inside `jupiterData`, present only
   * for a fully-verified single-hop Pump.fun raw-curve `route_v2` leg.
   */
  pumpRawCurveFlagOffset?: number;
};

// ---------------------------------------------------------------------------
// Key / RPC plumbing
// ---------------------------------------------------------------------------

function readPayer(): Keypair {
  const filename =
    process.env.SOLANA_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(filename, "utf8")) as number[])
  );
}

/** @deprecated Keyless: there is no quote authority. Returns the payer so old call sites compile. */
function readQuoteAuthority(): Keypair {
  return readPayer();
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  returnBadRequestJson = false
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (process.env.JUPITER_API_KEY && new URL(url).hostname.endsWith("jup.ag")) {
    headers.set("x-api-key", process.env.JUPITER_API_KEY);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, headers });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`${response.status} ${await response.text()}`);
      }
      if (response.status === 400 && returnBadRequestJson) {
        return (await response.json()) as T;
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`${response.status} ${await response.text()}`),
          {
            fatal: true,
          }
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) throw error;
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt))
      );
    }
  }
  throw lastError;
}

function solToLamports(value: string): bigint {
  const [whole, fraction = ""] = value.trim().split(".");
  return (
    BigInt(whole || "0") * 1_000_000_000n +
    BigInt((fraction + "000000000").slice(0, 9))
  );
}

function customErrorCode(error: unknown): number | undefined {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? "");
  const match =
    text.match(/"Custom":\s*(\d+)/) ??
    text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (!match) return undefined;
  return match[0].includes("0x") ? parseInt(match[1], 16) : Number(match[1]);
}

/**
 * Attribute a failure to the program it actually came from.
 *
 * Jupiter and every AMM it routes through are Anchor programs, so their error
 * codes are 6000-based too: a raw `Custom(6024)` off the transaction result is
 * as likely to be Raydium's `InvalidFirstTickArrayAccount` as the burner's
 * `UnsupportedToken2022Extension`. The innermost `Program <id> failed:` line
 * is where the revert originated.
 */
function attributeFailure(
  logs: string[] | null | undefined,
  fallback: unknown
): { code?: number; programId?: string; isBurner: boolean } {
  for (const line of logs ?? []) {
    const failed = line.match(
      /^Program (\S+) failed: custom program error: 0x([0-9a-f]+)/i
    );
    if (failed) {
      return {
        code: parseInt(failed[2], 16),
        programId: failed[1],
        isBurner: failed[1] === PROGRAM.toBase58(),
      };
    }
  }
  // No `Program ... failed` frame means authorship is UNKNOWN, not ours.
  // Returning `isBurner: true` here would credit the burner for any custom
  // code that reached us without logs -- and Jupiter and every AMM it routes
  // through are Anchor programs whose codes are also 6000-based.
  const code = customErrorCode(fallback);
  return { code, programId: undefined, isBurner: false };
}

// ---------------------------------------------------------------------------
// Split encoding — must agree byte-for-byte with `split.rs`
// ---------------------------------------------------------------------------

/**
 * `("burner", launch_mint, target_0 .. target_{n-1}, bps_blob)`.
 * The weights are packed little-endian `u16` in leg order.
 */
function deriveSplitPda(
  launchMint: PublicKey,
  legs: { mint: PublicKey; bps: number }[]
): [PublicKey, number] {
  const bpsBlob = Buffer.alloc(2 * legs.length);
  legs.forEach((leg, index) => bpsBlob.writeUInt16LE(leg.bps, 2 * index));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("burner"),
      launchMint.toBuffer(),
      ...legs.map((leg) => leg.mint.toBuffer()),
      bpsBlob,
    ],
    PROGRAM
  );
}

/**
 * The exact division `split.rs` performs: `total * bps / 10_000` computed as
 * `q*bps + floor(r*bps/10_000)`, with the last leg absorbing the remainder so
 * the legs sum to `total`.
 */
function splitAmounts(total: bigint, bpsList: number[]): bigint[] {
  const quotient = total / BigInt(BPS_TOTAL);
  const remainder = total % BigInt(BPS_TOTAL);
  const amounts: bigint[] = [];
  let allocated = 0n;
  bpsList.forEach((bps, index) => {
    const amount =
      index + 1 === bpsList.length
        ? total - allocated
        : quotient * BigInt(bps) +
          (remainder * BigInt(bps)) / BigInt(BPS_TOTAL);
    amounts.push(amount);
    allocated += amount;
  });
  return amounts;
}

function splitInstructionData(
  totalAmountIn: bigint,
  legs: {
    bps: number;
    minimumOutput: bigint;
    routeAccountCount: number;
    jupiterData: Buffer;
  }[]
): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(totalAmountIn, 0);
  header.writeUInt32LE(legs.length, 8);
  const parts: Buffer[] = [SPLIT_DISCRIMINATOR, header];
  for (const leg of legs) {
    const legHeader = Buffer.alloc(15);
    legHeader.writeUInt16LE(leg.bps, 0);
    legHeader.writeBigUInt64LE(leg.minimumOutput, 2);
    legHeader.writeUInt8(leg.routeAccountCount, 10);
    legHeader.writeUInt32LE(leg.jupiterData.length, 11);
    parts.push(legHeader, leg.jupiterData);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

async function sendInstructions(
  connection: Connection,
  payer: Keypair,
  label: string,
  instructions: TransactionInstruction[],
  extraSigners: Signer[] = []
) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, ...extraSigners]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { skipPreflight: false, maxRetries: 3 }
  );
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `${label} failed: ${JSON.stringify(confirmation.value.err)}`
    );
  }
  return signature;
}

async function getLookupTables(
  connection: Connection,
  addresses: string[]
): Promise<AddressLookupTableAccount[]> {
  return (
    await Promise.all(
      addresses.map(
        async (address) =>
          (
            await connection.getAddressLookupTable(new PublicKey(address))
          ).value
      )
    )
  ).filter((table): table is AddressLookupTableAccount => table !== null);
}

let sharedLookupTable: PublicKey | undefined;

async function extendAndFreezeLookupTable(
  connection: Connection,
  payer: Keypair,
  label: string,
  addresses: PublicKey[]
): Promise<PublicKey> {
  const recentSlot = await connection.getSlot("confirmed");
  const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot,
  });
  await sendInstructions(connection, payer, `create-${label}`, [createIx]);
  // Deliberately NOT frozen. A frozen lookup table can never be deactivated,
  // so it can never be closed and its rent (2.4-3.7M lamports per vault, 5.3M
  // for the shared table) is locked forever -- and freezing buys nothing:
  // entries are already immutable once written, the quote authority's
  // signature pins the table AND the indexes the transaction resolves through,
  // appending cannot change an existing index, and anyone can permissionlessly
  // build a substitute table over the same addresses, so withholding the
  // authority is not even a denial of service. Keeping the authority leaves
  // the rent fully reclaimable.
  await sendInstructions(connection, payer, `extend-${label}`, [
    AddressLookupTableProgram.extendLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      lookupTable,
      addresses,
    }),
  ]);
  // A lookup table is only usable from a later slot than the one it was
  // created in.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return lookupTable;
}

/** Programs and mints every split burn references, created once per run. */
async function ensureSharedLookupTable(
  connection: Connection,
  payer: Keypair
): Promise<PublicKey> {
  if (sharedLookupTable) return sharedLookupTable;
  sharedLookupTable = await extendAndFreezeLookupTable(
    connection,
    payer,
    "shared-alt",
    [
      PROGRAM,
      JUPITER_PROGRAM,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      SystemProgram.programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      NATIVE_MINT,
      ComputeBudgetProgram.programId,
      ...Object.values(TOKENS),
    ]
  );
  return sharedLookupTable;
}

/**
 * The vault's own addresses -- PDA, WSOL ATA, launch mint, and one mint+ATA
 * per leg. In production the launcher builds this once, alongside the ATAs it
 * already has to create; here it is the difference between a 3-leg burn
 * fitting the 1232-byte wire limit and not.
 */
async function createVaultLookupTable(
  connection: Connection,
  payer: Keypair,
  label: string,
  pda: PublicKey,
  wsolAta: PublicKey,
  launchMint: PublicKey,
  legs: { mint: PublicKey; ata: PublicKey }[]
): Promise<PublicKey> {
  return extendAndFreezeLookupTable(connection, payer, `vault-alt-${label}`, [
    pda,
    wsolAta,
    launchMint,
    ...legs.flatMap((leg) => [leg.mint, leg.ata]),
  ]);
}

// ---------------------------------------------------------------------------
// Pump venues: pre-create the vault's volume accumulator
// ---------------------------------------------------------------------------

const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const PUMP_SWAP_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
const PUMP_BONDING_CURVE_DISCRIMINATOR = Buffer.from([
  23, 183, 248, 55, 96, 216, 172, 96,
]);
/** `sha256("global:init_user_volume_accumulator")[0..8]`, same on both. */
const INIT_USER_VOLUME_ACCUMULATOR = Buffer.from([
  94, 6, 202, 115, 255, 96, 232, 183,
]);
const USER_VOLUME_ACCUMULATOR_DISCRIMINATOR = Buffer.from([
  86, 255, 112, 14, 102, 53, 154, 250,
]);

/**
 * Why this exists.
 *
 * Pump's venues keep a per-buyer `user_volume_accumulator` PDA and create it
 * during the first buy, charging the BUYER its rent. The burner pins the
 * vault's lamport delta to exactly the authorized input, so that extra charge
 * reverts every Pump route with 6019 -- which is why "the token is on
 * PumpSwap" meant "cannot be burned".
 *
 * `init_user_volume_accumulator` takes `payer` as the signer and `user` as a
 * plain (non-signing) pubkey, so ANYONE can create the accumulator for the
 * vault and pay for it themselves. V2 closes the accumulator during the route
 * and refunds its exact rent to `user` (the vault), so the on-chain program
 * snapshots the exact derived account and requires full closure before adding
 * that exact credit to the lamport equation. The next Pump burn recreates the
 * missing accumulator from the caller again. No generic lamport tolerance is
 * introduced.
 */
function initUserVolumeAccumulatorIx(
  program: PublicKey,
  payer: PublicKey,
  user: PublicKey
): TransactionInstruction {
  const [accumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    program
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    program
  );
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: accumulator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: INIT_USER_VOLUME_ACCUMULATOR,
  });
}

/** `sha256("global:extend_account")[0..8]` */
const EXTEND_ACCOUNT = Buffer.from([234, 102, 194, 203, 150, 72, 62, 229]);

/**
 * Pre-pay Pump's lazy bonding-curve migration for one target mint.
 *
 * Pump's `BondingCurve` struct grew from 115 to 151 bytes in a program
 * upgrade, and curves created before it are migrated LAZILY: the first buy
 * after the upgrade reallocs the account +36 bytes and charges the BUYER the
 * additional rent, 250_560 lamports (36 x 3480 x 2). When the buyer is the
 * vault, that is 250_560 lamports more than the authorized input and the
 * lamport postcondition correctly reverts the burn with 6019.
 *
 * This is per TOKEN, not per vault, which is exactly why the failure looked
 * intermittent: tokens whose curve is already 151 bytes burn fine, older ones
 * did not.
 *
 * `extend_account` carries NO authority constraint tying `user` to `account` —
 * `user` is only the signer that pays — so any third party can migrate any
 * token's curve. Sending it unconditionally is safe and preferred: on an
 * already-current curve it is a no-op costing only the transaction fee, and
 * hard-coding the current size would rot the moment Pump grows the struct
 * again (the on-chain size is already ahead of the published IDL).
 */
function extendBondingCurveIx(
  payer: PublicKey,
  bondingCurve: PublicKey
): TransactionInstruction {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_FUN_PROGRAM
  );
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM,
    keys: [
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: EXTEND_ACCOUNT,
  });
}

/** Create the vault's accumulator on any Pump program where it is missing. */
/**
 * Migrate the bonding curve of every target that still has one, paid by the
 * caller. A token with no Pump curve (already graduated, or never a Pump
 * token) is skipped.
 */
async function ensureBondingCurvesMigrated(
  connection: Connection,
  payer: Keypair,
  mints: PublicKey[]
): Promise<string[]> {
  const migrated: string[] = [];
  const instructions: TransactionInstruction[] = [];
  for (const mint of mints) {
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      PUMP_FUN_PROGRAM
    );
    const info = await connection.getAccountInfo(curve, "confirmed");
    if (!info || !info.owner.equals(PUMP_FUN_PROGRAM)) continue;
    // `complete` (byte 48) is set once the curve has graduated. A graduated
    // token routes through PumpSwap and never touches its old curve, so
    // extending it is pure waste -- and every Pump token keeps its curve
    // account forever, so this would otherwise fire for FARTCOIN, NEIRO and
    // every other established Pump target on every single burn.
    if (info.data[48] !== 0) continue;
    instructions.push(extendBondingCurveIx(payer.publicKey, curve));
    migrated.push(`${mint.toBase58().slice(0, 6)}:${info.data.length}B`);
  }
  if (instructions.length) {
    await sendInstructions(
      connection,
      payer,
      "extend-bonding-curves",
      instructions
    );
  }
  return migrated;
}

async function ensurePumpVolumeAccumulators(
  connection: Connection,
  payer: Keypair,
  vault: PublicKey
): Promise<string[]> {
  const created: string[] = [];
  const instructions: TransactionInstruction[] = [];
  for (const [name, program] of [
    ["pump.fun", PUMP_FUN_PROGRAM],
    ["pumpswap", PUMP_SWAP_PROGRAM],
  ] as const) {
    const [accumulator] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), vault.toBuffer()],
      program
    );
    if (await connection.getAccountInfo(accumulator, "confirmed")) continue;
    instructions.push(
      initUserVolumeAccumulatorIx(program, payer.publicKey, vault)
    );
    created.push(name);
  }
  if (instructions.length) {
    await sendInstructions(
      connection,
      payer,
      "init-pump-volume-accumulators",
      instructions
    );
  }
  return created;
}

type PumpCreditSnapshot = { address: PublicKey; lamports: bigint };

/** Mirror the program's exact Pump-credit admission for result accounting. */
async function snapshotPumpLamportCredits(
  connection: Connection,
  vault: PublicKey,
  legs: PreparedLeg[]
): Promise<PumpCreditSnapshot[]> {
  const writableRouteAccounts = new Set(
    legs
      .flatMap((leg) => leg.routeAccounts)
      .filter((account) => account.isWritable)
      .map((account) => account.pubkey.toBase58())
  );
  const snapshots: PumpCreditSnapshot[] = [];
  for (const program of [PUMP_FUN_PROGRAM, PUMP_SWAP_PROGRAM]) {
    const [address] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_volume_accumulator"), vault.toBuffer()],
      program
    );
    if (!writableRouteAccounts.has(address.toBase58())) continue;
    const info = await connection.getAccountInfo(address, "confirmed");
    if (!info) continue;
    // Mirror the program exactly: a bare System account at the derived
    // address is not a credit, whatever its lamports -- Pump may initialize
    // it in-route from that pre-funded balance without charging the vault.
    if (info.owner.equals(SystemProgram.programId) && info.data.length === 0) {
      continue;
    }
    if (
      !info.owner.equals(program) ||
      info.lamports <= 0 ||
      info.data.length < 40 ||
      !info.data.subarray(0, 8).equals(USER_VOLUME_ACCUMULATOR_DISCRIMINATOR) ||
      !info.data.subarray(8, 40).equals(vault.toBuffer())
    ) {
      throw new Error(`malformed Pump credit account ${address.toBase58()}`);
    }
    snapshots.push({ address, lamports: BigInt(info.lamports) });
  }
  return snapshots;
}

/**
 * Pump V2 establishes the raw curve's exact `creator_vault` System PDA at the
 * zero-data rent floor, charging `user` when it is absent. Pre-fund only the
 * PDA derived from the target's validated BondingCurve creator, and only when
 * Jupiter's final writable route actually names it.
 */
async function ensurePumpCreatorVaultsFunded(
  connection: Connection,
  payer: Keypair,
  legs: PreparedLeg[]
): Promise<string[]> {
  const floor = await connection.getMinimumBalanceForRentExemption(0);
  const topUps = new Map<string, TransactionInstruction>();
  const funded: string[] = [];
  for (const leg of legs) {
    if (!leg.routeLabel.split(">").some((hop) => hop.endsWith("Pump.fun"))) {
      continue;
    }
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), leg.mint.toBuffer()],
      PUMP_FUN_PROGRAM
    );
    const curveInfo = await connection.getAccountInfo(curve, "confirmed");
    if (
      !curveInfo ||
      !curveInfo.owner.equals(PUMP_FUN_PROGRAM) ||
      curveInfo.data.length < 81 ||
      !curveInfo.data.subarray(0, 8).equals(PUMP_BONDING_CURVE_DISCRIMINATOR) ||
      curveInfo.data[48] !== 0
    ) {
      throw new Error(`invalid raw Pump bonding curve ${curve.toBase58()}`);
    }
    const creator = new PublicKey(curveInfo.data.subarray(49, 81));
    const [creatorVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      PUMP_FUN_PROGRAM
    );
    if (
      !leg.routeAccounts.some(
        (account) => account.isWritable && account.pubkey.equals(creatorVault)
      )
    ) {
      throw new Error(
        `Pump route omitted derived creator vault ${creatorVault.toBase58()}`
      );
    }
    const info = await connection.getAccountInfo(creatorVault, "confirmed");
    if (
      info &&
      (!info.owner.equals(SystemProgram.programId) || info.data.length !== 0)
    ) {
      throw new Error(`invalid Pump creator vault ${creatorVault.toBase58()}`);
    }
    const current = info?.lamports ?? 0;
    if (current >= floor || topUps.has(creatorVault.toBase58())) continue;
    topUps.set(
      creatorVault.toBase58(),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: creatorVault,
        lamports: floor - current,
      })
    );
    funded.push(`${leg.label}:${floor - current}`);
  }
  if (topUps.size) {
    await sendInstructions(connection, payer, "fund-pump-creator-vaults", [
      ...topUps.values(),
    ]);
  }
  return funded;
}

/** Size of Pump's `UserVolumeAccumulator` account, both programs. */
const PUMP_USER_VOLUME_ACCUMULATOR_SPACE = 137;
/** `SwapV2` enum index of the raw Pump.fun bonding-curve buy in `route_v2`. */
const PUMP_RAW_CURVE_ROUTE_V2_VARIANT = 0x98;

/**
 * Why v2 raw-curve routes need client-side normalization at all.
 *
 * Pump's `buy_exact_quote_in_v2` carves a market-cap-tiered reward (the
 * "creator fee" slot, 30bps on current tiers, CEILed so it is >= 1 lamport on
 * any buy) out of the quote and deposits it into the BUYER's own
 * `user_volume_accumulator`. Jupiter's route plan then carries a
 * `track_volume` flag; when it is set, Jupiter closes that accumulator after
 * the buy, handing rent + reward back to the buyer. For the burn vault that
 * refund exceeds the program's admitted credit (the accumulator's PRE-route
 * balance) by exactly the in-route deposit, so the exact 6019 conservation
 * check correctly rejects it.
 *
 * The deposit itself cannot be disabled (Jupiter hardcodes the buy args and
 * Pump rounds the reward up), but the CLOSE is keyed off the route-plan flag.
 * Clearing the flag makes the leg conserve exactly, provided the accumulator
 * is a BARE SYSTEM ACCOUNT pre-funded to its rent at entry: Pump then
 * initializes it in-route from that balance (charging the vault nothing), the
 * reward parks in the accumulator -- forfeited, exactly as v1 forfeited the
 * same 30bps to the coin's creator -- and the program's snapshot correctly
 * skips a System-owned account, expecting and seeing an exact spend.
 *
 * Returns the byte offset of the flag only when the COMPLETE encoding is
 * verified; any unexpected byte returns undefined so an unknown layout is
 * never mutated.
 */
function pumpRawCurveTrackVolumeOffset(data: Buffer): number | undefined {
  if (data.length !== 40) return undefined;
  if (data.subarray(0, 8).toString("hex") !== ROUTE_V2_DISCRIMINATOR) {
    return undefined;
  }
  if (data.readUInt32LE(30) !== 1) return undefined; // exactly one route step
  if (data[34] !== PUMP_RAW_CURVE_ROUTE_V2_VARIANT) return undefined;
  if (data[35] !== 0 && data[35] !== 1) return undefined; // bool track_volume
  if (data.readUInt16LE(36) !== BPS_TOTAL) return undefined; // 100% one hop
  if (data[38] !== 0 || data[39] !== 1) return undefined; // in/out indexes
  return 35;
}

/**
 * Ensure the vault's Pump.fun volume accumulator is a bare System account
 * holding at least its rent, so a flag-cleared raw-curve leg conserves.
 *
 * Never calls `init_user_volume_accumulator`: an INITIALIZED (Pump-owned)
 * accumulator is snapshotted by the program and must then be closed in-route,
 * and a closing route returns its own in-route reward deposit on top of the
 * admitted credit -- 6019 either way while Pump's reward tier is nonzero.
 * Only the vault can sign the close, which it can only do inside a route, so
 * an already-initialized accumulator is reported as blocking rather than
 * "fixed" into a worse state.
 */
async function ensureBareSystemPumpAccumulator(
  connection: Connection,
  payer: Keypair,
  vault: PublicKey
): Promise<{ funded?: string; blockedBy?: string }> {
  const [accumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), vault.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  const rent = await connection.getMinimumBalanceForRentExemption(
    PUMP_USER_VOLUME_ACCUMULATOR_SPACE
  );
  const info = await connection.getAccountInfo(accumulator, "confirmed");
  if (info && !info.owner.equals(SystemProgram.programId)) {
    return { blockedBy: accumulator.toBase58() };
  }
  if (info && info.data.length !== 0) {
    return { blockedBy: accumulator.toBase58() };
  }
  const current = info?.lamports ?? 0;
  if (current >= rent) return {};
  await sendInstructions(connection, payer, "prefund-pump-accumulator", [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: accumulator,
      lamports: rent - current,
    }),
  ]);
  return { funded: `${accumulator.toBase58()}:${rent - current}` };
}

// ---------------------------------------------------------------------------
// Building one split burn
// ---------------------------------------------------------------------------

function assertV2Build(
  build: any,
  pda: PublicKey,
  wsolAta: PublicKey,
  targetMint: PublicKey,
  targetAta: PublicKey,
  targetTokenProgram: PublicKey,
  amountIn: bigint
): "route_v2" | "shared_accounts_route_v2" {
  if (build.error) throw new Error(`Jupiter V2 build failed: ${build.error}`);
  if (build.swapMode !== "ExactIn" || BigInt(build.inAmount) !== amountIn) {
    throw new Error(
      `Jupiter V2 build changed the authorized input: mode=${build.swapMode} amount=${build.inAmount}`
    );
  }
  if (build.swapInstruction?.programId !== JUPITER_PROGRAM.toBase58()) {
    throw new Error(`Jupiter V2 build returned a non-Jupiter swap instruction`);
  }

  const data = Buffer.from(build.swapInstruction.data, "base64");
  const discriminator = data.subarray(0, 8).toString("hex");
  const shared = discriminator === SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR;
  if (!shared && discriminator !== ROUTE_V2_DISCRIMINATOR) {
    throw new Error(`unsupported Jupiter V2 instruction ${discriminator}`);
  }
  const offsets = shared
    ? {
        fixed: 12,
        input: 9,
        platformFee: 27,
        positiveSlippageFee: 29,
        authority: 1,
        source: 2,
        destination: 5,
        sourceMint: 6,
        destinationMint: 7,
        sourceTokenProgram: 8,
        destinationTokenProgram: 9,
        eventAuthority: 10,
        program: 11,
      }
    : {
        fixed: 10,
        input: 8,
        platformFee: 26,
        positiveSlippageFee: 28,
        authority: 0,
        source: 1,
        destination: 2,
        sourceMint: 3,
        destinationMint: 4,
        sourceTokenProgram: 5,
        destinationTokenProgram: 6,
        eventAuthority: 8,
        program: 9,
      };
  if (data.length < offsets.positiveSlippageFee + 6) {
    throw new Error(`truncated Jupiter V2 instruction`);
  }
  if (data.readBigUInt64LE(offsets.input) !== amountIn) {
    throw new Error(
      `Jupiter V2 instruction input does not equal the authorized input`
    );
  }
  if (
    data.readUInt16LE(offsets.platformFee) !== 0 ||
    data.readUInt16LE(offsets.positiveSlippageFee) !== 0
  ) {
    throw new Error(`Jupiter V2 instruction contains a forbidden fee`);
  }

  const accounts = build.swapInstruction.accounts;
  if (!Array.isArray(accounts) || accounts.length < offsets.fixed) {
    throw new Error(`truncated Jupiter V2 account list`);
  }
  const expected: Array<[number, PublicKey]> = [
    [offsets.authority, pda],
    [offsets.source, wsolAta],
    [offsets.destination, targetAta],
    [offsets.sourceMint, NATIVE_MINT],
    [offsets.destinationMint, targetMint],
    [offsets.sourceTokenProgram, TOKEN_PROGRAM_ID],
    [offsets.destinationTokenProgram, targetTokenProgram],
    [offsets.eventAuthority, JUPITER_EVENT_AUTHORITY],
    [offsets.program, JUPITER_PROGRAM],
  ];
  if (!shared) expected.push([7, targetAta]);
  for (const [index, key] of expected) {
    if (accounts[index].pubkey !== key.toBase58()) {
      throw new Error(
        `Jupiter V2 account ${index} is ${
          accounts[index].pubkey
        }, expected ${key.toBase58()}`
      );
    }
  }
  const extraSigners = accounts.filter(
    (account: any) => account.isSigner && account.pubkey !== pda.toBase58()
  );
  if (extraSigners.length) {
    throw new Error(
      `Jupiter V2 route needs signatures the burner withholds: ${extraSigners
        .map((account: any) => account.pubkey)
        .join(",")}`
    );
  }
  return shared ? "shared_accounts_route_v2" : "route_v2";
}

function buildLookupTables(build: any): AddressLookupTableAccount[] {
  return Object.entries(build.addressesByLookupTableAddress ?? {}).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: (addresses as string[]).map(
            (address) => new PublicKey(address)
          ),
        },
      })
  );
}

async function prepareLegs(
  connection: Connection,
  payer: Keypair,
  pda: PublicKey,
  wsolAta: PublicKey,
  legs: Leg[],
  total: bigint,
  slippageBps: number | undefined,
  maxAccountsPerLeg: number | undefined
): Promise<PreparedLeg[]> {
  const amounts = splitAmounts(
    total,
    legs.map((leg) => leg.bps)
  );
  const prepared: PreparedLeg[] = [];
  const setupInstructions: TransactionInstruction[] = [];

  for (const [index, leg] of legs.entries()) {
    const mintInfo = await connection.getAccountInfo(leg.mint, "confirmed");
    if (!mintInfo)
      throw new Error(`mint ${leg.mint.toBase58()} not on the fork`);
    const tokenProgram = mintInfo.owner;
    const ata = getAssociatedTokenAddressSync(
      leg.mint,
      pda,
      true,
      tokenProgram
    );

    const url = new URL(`${JUPITER_API}/build`);
    url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
    url.searchParams.set("outputMint", leg.mint.toBase58());
    url.searchParams.set("amount", amounts[index].toString());
    url.searchParams.set("taker", pda.toBase58());
    url.searchParams.set("wrapAndUnwrapSol", "false");
    url.searchParams.set("destinationTokenAccount", ata.toBase58());
    // Production opts into Jupiter's Real-Time Slippage Estimator. Tests may
    // pass a fixed tolerance to isolate fork/mainnet state drift.
    url.searchParams.set("slippageBps", slippageBps?.toString() ?? "rtse");
    // Bound route width so N legs fit one transaction. Unlike
    // `onlyDirectRoutes` this does not exclude venues or forbid multi-hop --
    // Jupiter still routes freely, just not through the widest candidates.
    if (maxAccountsPerLeg) {
      url.searchParams.set("maxAccounts", String(maxAccountsPerLeg));
    }
    const dexes = leg.dexes?.length ? leg.dexes : FORK_ROUTABLE_DEXES;
    if (dexes.length) url.searchParams.set("dexes", dexes.join(","));
    let swap = await fetchJson<any>(url.toString(), undefined, true);
    // A tight `maxAccounts` plus the fork exclusion list can leave a thin
    // token with no candidate route at all. Widen once before giving up: a
    // wider route may not fit the transaction, but "did not fit" and "does
    // not exist" are different results and must not be conflated.
    if (swap.error && maxAccountsPerLeg) {
      url.searchParams.set("maxAccounts", String(maxAccountsPerLeg + 12));
      swap = await fetchJson<any>(url.toString(), undefined, true);
    }
    const routeKind = assertV2Build(
      swap,
      pda,
      wsolAta,
      leg.mint,
      ata,
      tokenProgram,
      amounts[index]
    );

    // Only idempotent ATA creation may be pre-run; anything else could move
    // burner funds outside the atomic instruction.
    const unexpected = (swap.setupInstructions ?? []).filter(
      (ix: any) =>
        ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() ||
        ix.data !== "AQ=="
    );
    if (
      unexpected.length ||
      swap.cleanupInstruction ||
      (swap.otherInstructions ?? []).length ||
      swap.tipInstruction
    ) {
      throw new Error(
        `unsafe auxiliary instructions for ${leg.label}: ${JSON.stringify({
          unexpected,
          cleanup: swap.cleanupInstruction,
          other: swap.otherInstructions,
          tip: swap.tipInstruction,
        })}`
      );
    }
    for (const ix of swap.setupInstructions ?? []) {
      // Restricted above to idempotent ATA creation, whose account 0 is the
      // funding account. Without a `payer` in the request Jupiter funds these
      // from `userPublicKey` -- the PDA, which cannot sign an ordinary
      // transaction -- so the payer is substituted here instead. Passing
      // `payer` to Jupiter would fix the funding but also add the payer as a
      // signer inside the ROUTE, which the program withholds by design.
      const keys = ix.accounts.map((a: any) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      }));
      keys[0] = { pubkey: payer.publicKey, isSigner: true, isWritable: true };
      setupInstructions.push(
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys,
          data: Buffer.from(ix.data, "base64"),
        })
      );
    }

    // Any route account that is a MISSING associated-token-account is one the
    // venue would otherwise create mid-swap and bill to the buyer -- which for
    // this program is the vault, whose lamport delta is pinned to exactly the
    // authorized input (6019). Pump's creator-fee vaults are the common case.
    // Creating them here, idempotently and paid by the caller, leaves the swap
    // nothing to fund. It cannot be abused: an ATA's address is a pure
    // function of (owner, mint, token program), so this can only bring into
    // existence the exact account the route already named.
    const routeKeys: PublicKey[] = swap.swapInstruction.accounts.map(
      (a: any) => new PublicKey(a.pubkey)
    );
    const routeInfos = await connection.getMultipleAccountsInfo(
      routeKeys,
      "confirmed"
    );
    for (const [index, info] of routeInfos.entries()) {
      if (info) continue;
      const missing = routeKeys[index];
      for (const [candidateMint, candidateProgram] of [
        [NATIVE_MINT, TOKEN_PROGRAM_ID],
        [leg.mint, tokenProgram],
      ] as const) {
        let matched = false;
        for (const owner of routeKeys) {
          let derived: PublicKey;
          try {
            derived = getAssociatedTokenAddressSync(
              candidateMint,
              owner,
              true,
              candidateProgram
            );
          } catch {
            continue;
          }
          if (!derived.equals(missing)) continue;
          setupInstructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey,
              missing,
              owner,
              candidateMint,
              candidateProgram
            )
          );
          matched = true;
          break;
        }
        if (matched) break;
      }
    }

    // `/build` returns the exact threshold embedded in route_v2. Enforce the
    // same floor in the burner instead of recomputing and risking a rounding
    // or estimator mismatch.
    const chosenSlippageBps = Number(swap.slippageBps);
    const minimumOutput = BigInt(swap.otherAmountThreshold);
    if (minimumOutput === 0n)
      throw new Error(`Jupiter V2 returned a zero output floor`);

    const jupiterData = Buffer.from(swap.swapInstruction.data, "base64");
    // A direct single-hop raw-curve leg is eligible for the track_volume
    // normalization; require Jupiter's own route plan to agree with the
    // byte-level verification before believing the offset.
    const pumpRawCurveFlagOffset =
      routeKind === "route_v2" &&
      (swap.routePlan ?? []).length === 1 &&
      swap.routePlan[0]?.swapInfo?.label === "Pump.fun"
        ? pumpRawCurveTrackVolumeOffset(jupiterData)
        : undefined;

    prepared.push({
      ...leg,
      tokenProgram,
      ata,
      amountIn: amounts[index],
      minimumOutput,
      routeAccounts: swap.swapInstruction.accounts.map((a: any) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: false,
        isWritable: a.isWritable,
      })),
      jupiterData,
      lookupTables: Object.keys(swap.addressesByLookupTableAddress ?? {}),
      resolvedLookupTables: buildLookupTables(swap),
      slippageBps: chosenSlippageBps,
      slippageSource: slippageBps === undefined ? "jupiter-rtse" : "fixed",
      routeLabel: `${routeKind}:${(swap.routePlan ?? [])
        .map((hop: any) => hop.swapInfo?.label)
        .filter(Boolean)
        .join(">")}`,
      routePriceImpactPct:
        swap.priceImpactPct === undefined ? undefined : String(swap.priceImpactPct),
      pumpRawCurveFlagOffset,
    });
  }

  if (setupInstructions.length) {
    await sendInstructions(
      connection,
      payer,
      "jupiter-route-account-setup",
      setupInstructions
    );
  }
  return prepared;
}

function buildSplitInstruction(
  payer: PublicKey,
  _reserved: PublicKey,
  pda: PublicKey,
  wsolAta: PublicKey,
  launchMint: PublicKey,
  legs: PreparedLeg[],
  total: bigint,
  overrides: {
    bpsOverride?: number[];
    minimumOutputOverride?: bigint[];
    dataTamper?: (data: Buffer) => Buffer;
    accountTamper?: (keys: any[]) => any[];
  } = {}
): TransactionInstruction {
  let keys: any[] = [
    { pubkey: payer, isSigner: true, isWritable: false },
    // Slot 1 held the retired quote authority. Keyless leaves it reserved and
    // unchecked; the program id is a convenient non-signer placeholder.
    { pubkey: PROGRAM, isSigner: false, isWritable: false },
    { pubkey: pda, isSigner: false, isWritable: true },
    { pubkey: wsolAta, isSigner: false, isWritable: true },
    { pubkey: launchMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
    ...legs.flatMap((leg) => [
      { pubkey: leg.mint, isSigner: false, isWritable: true },
      { pubkey: leg.ata, isSigner: false, isWritable: true },
      { pubkey: leg.tokenProgram, isSigner: false, isWritable: false },
    ]),
    ...legs.flatMap((leg) => leg.routeAccounts),
  ];
  if (overrides.accountTamper) keys = overrides.accountTamper(keys);

  let data = splitInstructionData(
    total,
    legs.map((leg, index) => ({
      bps: overrides.bpsOverride?.[index] ?? leg.bps,
      minimumOutput:
        overrides.minimumOutputOverride?.[index] ?? leg.minimumOutput,
      routeAccountCount: leg.routeAccounts.length,
      jupiterData: leg.jupiterData,
    }))
  );
  if (overrides.dataTamper) data = overrides.dataTamper(data);

  return new TransactionInstruction({ programId: PROGRAM, keys, data });
}

// ---------------------------------------------------------------------------
// One end-to-end case
// ---------------------------------------------------------------------------

type CaseResult = {
  name: string;
  legs: string;
  weights: string;
  totalSol: string;
  status: "burned" | "rejected" | "error";
  computeUnits?: number;
  txBytes?: number;
  accountLocks?: number;
  signature?: string;
  burned?: string[];
  routes?: string[];
  pumpAccumulatorsCreated?: string[];
  bondingCurvesMigrated?: string[];
  pumpCreatorVaultsFunded?: string[];
  pumpLamportCredit?: string;
  /** Raw-curve legs whose route-plan track_volume flag was cleared. */
  pumpVolumeTrackingDisabled?: string[];
  /** Set when the route was narrowed because it exhausted the compute budget. */
  computeNarrowedTo?: number;
  errorCode?: number;
  errorName?: string;
  rejectedBy?: "burner" | "external";
  detail?: string;
};

async function runSplitCase(
  connection: Connection,
  payer: Keypair,
  quoteAuthority: Keypair,
  name: string,
  launchMint: PublicKey,
  legs: Leg[],
  totalSol: string,
  options: {
    fundExtra?: bigint;
    slippageBps?: number;
    expectReject?: boolean;
    maxAccountsPerLeg?: number;
    /**
     * Who signs and pays for the burn transaction. Defaults to the same wallet
     * that set the vault up; passing a stranger proves the burn is
     * permissionless.
     */
    burnCaller?: Keypair;
    /** Deliberately do NOT pre-create the Pump volume accumulator. */
    skipPumpAccumulator?: boolean;
    overrides?: Parameters<typeof buildSplitInstruction>[7];
    pdaOverride?: PublicKey;
  } = {}
): Promise<CaseResult> {
  const total = solToLamports(totalSol);
  const summary: CaseResult = {
    name,
    legs: legs.map((leg) => leg.label).join("+"),
    weights: legs.map((leg) => `${leg.bps / 100}%`).join("/"),
    totalSol,
    status: "error",
  };

  try {
    const bpsSum = legs.reduce((sum, leg) => sum + leg.bps, 0);
    if (bpsSum !== BPS_TOTAL && !options.expectReject) {
      throw new Error(`weights sum to ${bpsSum}, not ${BPS_TOTAL}`);
    }
    const [derivedPda] = deriveSplitPda(launchMint, legs);
    const pda = options.pdaOverride ?? derivedPda;
    const wsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      pda,
      true,
      TOKEN_PROGRAM_ID
    );

    // The launcher creates the vault's ATAs once and pays their rent; the
    // program itself never creates an account.
    const ataIxs = [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        wsolAta,
        pda,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID
      ),
    ];
    for (const leg of legs) {
      const info = await connection.getAccountInfo(leg.mint, "confirmed");
      if (!info) throw new Error(`mint ${leg.label} missing on fork`);
      ataIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          getAssociatedTokenAddressSync(leg.mint, pda, true, info.owner),
          pda,
          leg.mint,
          info.owner
        )
      );
    }
    await sendInstructions(connection, payer, `${name}-atas`, ataIxs);

    // Deliberately NOT pre-initializing Pump volume accumulators any more.
    // Jupiter v2 makes the initialized accumulator either unnecessary or
    // actively harmful:
    //  - PumpSwap and zero-reward-tier Pump.fun legs create AND close the
    //    absent accumulator inside the route with net-zero lamport effect
    //    (or close a pre-existing one for exactly its snapshotted balance),
    //    which the program admits exactly. Pre-creation buys nothing.
    //  - Reward-tier raw-curve legs deposit a CEILed >=1-lamport reward into
    //    the accumulator mid-buy; a close then over-credits the vault by that
    //    deposit, so those legs must run with the close disabled and the
    //    accumulator as a bare pre-FUNDED System account (see the 6019 retry
    //    below). `init_user_volume_accumulator` would make that state
    //    unreachable: only the vault can sign the close that undoes it.
    summary.pumpAccumulatorsCreated = [];
    summary.bondingCurvesMigrated = options.skipPumpAccumulator
      ? []
      : await ensureBondingCurvesMigrated(
          connection,
          payer,
          legs.map((l) => l.mint)
        );

    const fundAmount = total + (options.fundExtra ?? 0n);
    await sendInstructions(connection, payer, `${name}-fund`, [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: pda,
        lamports: fundAmount,
      }),
    ]);

    const requestedMaxAccounts =
      options.maxAccountsPerLeg === 0
        ? undefined
        : options.maxAccountsPerLeg ??
          DEFAULT_MAX_ACCOUNTS_PER_LEG[legs.length];
    let prepared = await prepareLegs(
      connection,
      payer,
      pda,
      wsolAta,
      legs,
      total,
      // Production wiring is Jupiter's dynamic slippage (`undefined` here).
      // A Surfpool fork pins pool state at fork time while Jupiter quotes
      // live mainnet, so the fill can drift past any tolerance Jupiter picks
      // for real conditions; FORK_SLIPPAGE_BPS widens it for fork execution
      // coverage only and is never a production setting.
      options.slippageBps ??
        (process.env.FORK_SLIPPAGE_BPS
          ? Number(process.env.FORK_SLIPPAGE_BPS)
          : undefined),
      requestedMaxAccounts
    );
    summary.pumpCreatorVaultsFunded = await ensurePumpCreatorVaultsFunded(
      connection,
      payer,
      prepared
    );

    const lamportsBefore = await connection.getBalance(pda, "confirmed");
    const caller = options.burnCaller ?? payer;
    // A 1-leg burn lands uncapped at ~17 account locks with its keys static,
    // so it does not need a per-vault table -- and that table costs 2,394,240
    // lamports. Only build one when there is more than one leg to fit.
    const vaultLookupTable =
      prepared.length > 1
        ? await createVaultLookupTable(
            connection,
            payer,
            name,
            pda,
            wsolAta,
            launchMint,
            prepared
          )
        : undefined;
    const localLookupTables = await getLookupTables(connection, [
      ...new Set([
        (await ensureSharedLookupTable(connection, payer)).toBase58(),
        ...(vaultLookupTable ? [vaultLookupTable.toBase58()] : []),
      ]),
    ]);
    const compileBurn = async (candidate: PreparedLeg[]) => {
      const instruction = buildSplitInstruction(
        caller.publicKey,
        quoteAuthority.publicKey,
        pda,
        wsolAta,
        launchMint,
        candidate,
        total,
        options.overrides
      );
      const lookupTables = [
        ...new Map(
          [
            ...candidate.flatMap((leg) => leg.resolvedLookupTables),
            ...localLookupTables,
          ].map((table) => [table.key.toBase58(), table])
        ).values(),
      ];
      const validity = await connection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({
        payerKey: caller.publicKey,
        recentBlockhash: validity.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          instruction,
        ],
      }).compileToV0Message(lookupTables);
      const transaction = new VersionedTransaction(message);
      transaction.sign([caller]);
      let bytes: number;
      try {
        bytes = transaction.serialize().length;
      } catch {
        // Some oversized messages serialize to >1232 bytes while wider ones
        // throw `encoding overruns Uint8Array`. Both mean "retry narrower".
        bytes = MAX_TRANSACTION_BYTES + 1;
      }
      return {
        ...validity,
        message,
        transaction,
        bytes,
      };
    };

    let compiled = await compileBurn(prepared);
    // V2 routes can be several bytes wider than V1. web3.js serializes an
    // oversized VersionedTransaction without throwing, so checking the byte
    // count explicitly is mandatory. Start unrestricted, then ask Jupiter for
    // progressively narrower routes only when the complete signed message
    // does not fit Solana's 1232-byte wire limit.
    const fittingCaps = [40, 32, 26, 20, 16, 12].filter(
      (cap) => requestedMaxAccounts === undefined || cap < requestedMaxAccounts
    );
    for (const cap of fittingCaps) {
      if (compiled.bytes <= MAX_TRANSACTION_BYTES) break;
      prepared = await prepareLegs(
        connection,
        payer,
        pda,
        wsolAta,
        legs,
        total,
        options.slippageBps ??
          (process.env.FORK_SLIPPAGE_BPS
            ? Number(process.env.FORK_SLIPPAGE_BPS)
            : undefined),
        cap
      );
      compiled = await compileBurn(prepared);
    }
    summary.txBytes = compiled.bytes;
    if (compiled.bytes > MAX_TRANSACTION_BYTES) {
      summary.status = "rejected";
      summary.detail =
        `transaction is ${compiled.bytes} bytes after Jupiter fitting; ` +
        `wire limit is ${MAX_TRANSACTION_BYTES}`;
      return summary;
    }
    let pumpCreditSnapshots = await snapshotPumpLamportCredits(
      connection,
      pda,
      prepared
    );
    let simulation = await connection.simulateTransaction(compiled.transaction, {
      sigVerify: true,
    });

    // Route width is ALSO a compute lever, not only a wire-size one. The
    // fitting loop above narrows the route when the signed message will not
    // fit 1232 bytes; a route that fits comfortably can still exhaust the
    // 1.4M compute ceiling, because every extra hop costs CU. Measured on a
    // fresh fork: one RAY leg at an uncapped 53 locks exhausts the budget,
    // the same leg at maxAccounts=24 burns using 1,302,852 CU, and at 16 uses
    // 906,746. Without this, a burn that a narrower route would land simply
    // fails, so narrow on compute exhaustion for the same reason and with the
    // same caps.
    const exhaustedCompute = (result: typeof simulation) =>
      typeof result.value.err === "string"
        ? result.value.err === "ComputationalBudgetExceeded"
        : Boolean(
            result.value.logs?.some((line) =>
              line.includes("exceeded CUs meter") ||
              line.includes("Computational budget exceeded")
            )
          );
    if (exhaustedCompute(simulation) && !options.expectReject) {
      for (const cap of fittingCaps) {
        if (!exhaustedCompute(simulation)) break;
        prepared = await prepareLegs(
          connection,
          payer,
          pda,
          wsolAta,
          legs,
          total,
          options.slippageBps ??
            (process.env.FORK_SLIPPAGE_BPS
              ? Number(process.env.FORK_SLIPPAGE_BPS)
              : undefined),
          cap
        );
        compiled = await compileBurn(prepared);
        if (compiled.bytes > MAX_TRANSACTION_BYTES) continue;
        summary.txBytes = compiled.bytes;
        summary.computeNarrowedTo = cap;
        simulation = await connection.simulateTransaction(compiled.transaction, {
          sigVerify: true,
        });
      }
    }

    // Jupiter v2's raw-curve buy deposits a CEILed, market-cap-tiered reward
    // (>= 1 lamport when the tier is nonzero) into the vault's own volume
    // accumulator and then closes that accumulator, over-crediting the vault
    // by exactly the in-route deposit -- which the exact 6019 conservation
    // check correctly rejects. The tier is Pump's runtime state, so it is
    // DISCOVERED rather than predicted: first attempt the burn exactly as
    // Jupiter built it (the only conserving shape for zero-reward tiers and
    // for an already-initialized accumulator), and only on a burner 6019
    // retry once with each verified raw-curve leg's track_volume flag
    // cleared -- Jupiter then skips the close, the reward parks in the
    // accumulator exactly as v1 forfeited the same 30bps to the coin's
    // creator -- and the accumulator pre-funded as a bare System account so
    // Pump's in-route initialization charges the vault nothing.
    let flipNote: string | undefined;
    if (simulation.value.err && !options.expectReject) {
      const attributed = attributeFailure(
        simulation.value.logs,
        simulation.value.err
      );
      const flippable = prepared.filter(
        (leg) =>
          leg.pumpRawCurveFlagOffset !== undefined &&
          leg.jupiterData[leg.pumpRawCurveFlagOffset] === 1
      );
      if (attributed.isBurner && attributed.code === 6019 && flippable.length) {
        const accumulator = await ensureBareSystemPumpAccumulator(
          connection,
          payer,
          pda
        );
        if (accumulator.blockedBy) {
          flipNote =
            `vault Pump.fun volume accumulator ${accumulator.blockedBy} is ` +
            `already initialized: a reward-tier raw-curve close returns its ` +
            `own in-route deposit on top of the admitted credit, and only ` +
            `the vault can sign the close that would reset it`;
        } else {
          for (const leg of flippable) {
            leg.jupiterData[leg.pumpRawCurveFlagOffset!] = 0;
          }
          summary.pumpVolumeTrackingDisabled = flippable.map(
            (leg) => leg.label
          );
          compiled = await compileBurn(prepared);
          summary.txBytes = compiled.bytes;
          if (compiled.bytes > MAX_TRANSACTION_BYTES) {
            summary.status = "rejected";
            summary.detail =
              `transaction is ${compiled.bytes} bytes after the raw-curve ` +
              `normalization; wire limit is ${MAX_TRANSACTION_BYTES}`;
            return summary;
          }
          pumpCreditSnapshots = await snapshotPumpLamportCredits(
            connection,
            pda,
            prepared
          );
          simulation = await connection.simulateTransaction(
            compiled.transaction,
            { sigVerify: true }
          );
        }
      }
    }

    const { blockhash, lastValidBlockHeight, message, transaction } = compiled;
    summary.accountLocks =
      message.staticAccountKeys.length +
      message.addressTableLookups.reduce(
        (sum, lookup) =>
          sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
        0
      );
    const pumpLamportCredit = pumpCreditSnapshots.reduce(
      (totalCredit, snapshot) => totalCredit + snapshot.lamports,
      0n
    );
    summary.pumpLamportCredit = pumpLamportCredit.toString();

    if (simulation.value.err) {
      const attributed = attributeFailure(
        simulation.value.logs,
        simulation.value.err
      );
      summary.status = "rejected";
      summary.errorCode = attributed.code;
      summary.errorName = attributed.isBurner
        ? attributed.code
          ? ERROR_NAMES[attributed.code]
          : undefined
        : `(external: ${attributed.programId})`;
      summary.rejectedBy = attributed.isBurner ? "burner" : "external";
      summary.computeUnits = simulation.value.unitsConsumed;
      summary.detail = [
        flipNote,
        (simulation.value.logs ?? [])
          .filter((line) =>
            /Error|failed|Program log|insufficient/i.test(line)
          )
          .slice(-16)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n");
      return summary;
    }

    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, maxRetries: 3 }
    );
    summary.signature = signature;
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (confirmation.value.err) {
      const landedFailure = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const attributed = attributeFailure(
        landedFailure?.meta?.logMessages,
        confirmation.value.err
      );
      summary.status = "rejected";
      summary.errorCode = attributed.code;
      summary.errorName = attributed.isBurner
        ? attributed.code
          ? ERROR_NAMES[attributed.code]
          : undefined
        : `(external: ${attributed.programId})`;
      summary.rejectedBy = attributed.isBurner ? "burner" : "external";
      return summary;
    }

    const landed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    summary.computeUnits = landed?.meta?.computeUnitsConsumed ?? undefined;

    // ---- postconditions -------------------------------------------------
    const lamportsAfter = await connection.getBalance(pda, "confirmed");
    const netSpent = BigInt(lamportsBefore) - BigInt(lamportsAfter);
    const expectedNetSpent = total - pumpLamportCredit;
    if (netSpent !== expectedNetSpent) {
      throw new Error(
        `vault net spent ${netSpent}, expected input ${total} minus ` +
          `validated Pump credit ${pumpLamportCredit}`
      );
    }
    for (const snapshot of pumpCreditSnapshots) {
      const after = await connection.getAccountInfo(
        snapshot.address,
        "confirmed"
      );
      if (
        after &&
        (!after.owner.equals(SystemProgram.programId) ||
          after.data.length !== 0 ||
          after.lamports !== 0)
      ) {
        throw new Error(
          `Pump credit account ${snapshot.address.toBase58()} was not fully closed`
        );
      }
    }
    // The program logs `(amount_in, burned)` per leg via `sol_log_64_`. Assert
    // against that rather than the mint's `supply` field: a Surfpool fork
    // re-reads mainnet-resident accounts, so a mint's supply can be refreshed
    // out from under a local burn, while the program's own log cannot.
    const legLogs = (landed?.meta?.logMessages ?? [])
      .map((line) =>
        line.match(/^Program log: 0x0, 0x0, 0x0, 0x([0-9a-f]+), 0x([0-9a-f]+)$/)
      )
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => ({
        amountIn: BigInt(`0x${match[1]}`),
        burned: BigInt(`0x${match[2]}`),
      }));
    if (legLogs.length !== prepared.length) {
      throw new Error(
        `expected ${prepared.length} burn logs, saw ${legLogs.length}`
      );
    }
    const burned: string[] = [];
    for (const [index, leg] of prepared.entries()) {
      // The on-chain division must agree with the split this harness computed.
      if (legLogs[index].amountIn !== leg.amountIn) {
        throw new Error(
          `${leg.label} leg input ${legLogs[index].amountIn} != expected ${leg.amountIn}`
        );
      }
      if (legLogs[index].burned < leg.minimumOutput) {
        throw new Error(
          `${leg.label} burned ${legLogs[index].burned} below signed minimum ${leg.minimumOutput}`
        );
      }
      const account = await getAccount(
        connection,
        leg.ata,
        "confirmed",
        leg.tokenProgram
      );
      if (account.amount !== 0n) {
        throw new Error(`${leg.label} ATA retained ${account.amount}`);
      }
      burned.push(`${leg.label}:${legLogs[index].burned}`);
    }
    const wsol = await getAccount(
      connection,
      wsolAta,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    if (wsol.amount !== 0n) {
      throw new Error(`WSOL account retained ${wsol.amount}`);
    }
    summary.status = "burned";
    summary.burned = burned;
    summary.routes = prepared.map(
      (leg) =>
        `${leg.label}=${leg.routeLabel || "?"}@${leg.slippageBps}bps(${
          leg.slippageSource
        })`
    );
    return summary;
  } catch (error) {
    const code = customErrorCode(
      error instanceof Error ? error.message : error
    );
    // Only a burner-attributable custom code counts as a rejection. A quote
    // 429, a missing mint, or any other setup throw stays an `error`, so it
    // can never be read as "the program correctly refused this".
    summary.status =
      options.expectReject && code !== undefined ? "rejected" : "error";
    summary.errorCode = code;
    summary.errorName = code ? ERROR_NAMES[code] : undefined;
    summary.detail =
      error instanceof Error ? error.message.slice(0, 220) : String(error);
    return summary;
  }
}

export {
  BPS_TOTAL,
  buildSplitInstruction,
  CaseResult,
  deriveSplitPda,
  ensureSharedLookupTable,
  ensurePumpVolumeAccumulators,
  ensurePumpCreatorVaultsFunded,
  ensureBondingCurvesMigrated,
  extendBondingCurveIx,
  initUserVolumeAccumulatorIx,
  createVaultLookupTable,
  DEFAULT_MAX_ACCOUNTS_PER_LEG,
  ERROR_NAMES,
  fetchJson,
  FORK_ROUTABLE_DEXES,
  getLookupTables,
  Leg,
  PreparedLeg,
  prepareLegs,
  PROGRAM,
  readPayer,
  readQuoteAuthority,
  runSplitCase,
  sendInstructions,
  solToLamports,
  splitAmounts,
  splitInstructionData,
  SPLIT_DISCRIMINATOR,
  TOKENS,
};

export { RPC_URL, JUPITER_PROGRAM, customErrorCode, attributeFailure };
