import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ResolvedReference, resolveReference } from "./reference";
import { assertDirectCurveLegShape, DIRECT_CURVE_VENUE } from "./directcurve";

export const BURNER_SEED = Buffer.from("burner");
export const BPS_TOTAL = 10_000;
export const MAX_SPLIT_TARGETS = 4;
export const MAX_TRANSACTION_BYTES = 1232;
export const MAX_ACCOUNT_LOCKS = 64;

export const DEFAULT_BURNER_PROGRAM = new PublicKey(
  "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV"
);
export const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
export const JUPITER_EVENT_AUTHORITY = new PublicKey(
  "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
);
export const PUMP_MINT = new PublicKey(
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
);
export const PUMP_TRANSFER_HOOK_AUTHORITY = new PublicKey(
  "DMdBa812dBW1CHVhmTyUyVcrBnSbZbfoFC7U14k4riH1"
);
export const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
export const PUMP_AMM_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
/**
 * The documented recovery for a burner-attributed 6018 WsolNotFullyConsumed:
 * Jupiter's PumpSwap adapter, routing through a coin with Pump's cashback
 * mode, appends ClaimCashback and pays the cashback in WSOL into the vault's
 * own WSOL ATA, which the program's exact WSOL-conservation postcondition
 * correctly reverts. The retry re-quotes the offending leg with both Pump
 * venues excluded. This is a documented venue exclusion, NOT the prohibited
 * onlyDirectRoutes, and the on-chain check is never loosened.
 */
export const PUMP_VENUE_EXCLUDE_DEXES: readonly string[] = [
  "Pump.fun Amm",
  "Pump.fun",
];
/** Extra re-quote attempts for retryable simulation failures (see policy). */
export const DEFAULT_RETRY_ATTEMPTS = 2;

/**
 * KEYLESS: only the split instruction is reachable — the single-target
 * discriminator returns InvalidInstructionData on the production program, so
 * every burn (a 1-leg burn included) is encoded as a split.
 */
export const SPLIT_DISCRIMINATOR = Buffer.from([
  157, 45, 186, 225, 142, 17, 2, 105,
]);
const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";
const ACTIVE_ALT_SLOT = BigInt("18446744073709551615");

export class PolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

function reject(code: string, message: string): never {
  throw new PolicyError(code, message);
}

export type BurnLegRequest = Readonly<{
  targetMint: string;
  bps: number;
  /**
   * KEYLESS: the leg's price-floor reference pool, bound into the vault
   * address at setup. Omitted for a leg priced off the mint's own Pump
   * bonding curve (the program derives that address itself; the seed is the
   * zero sentinel). Required for every other venue: this must be the exact
   * pool the vault was derived with, or the burn lands on a different,
   * unfunded address (6012).
   */
  reference?: string;
}>;

/**
 * The complete public request surface. There is deliberately no transaction,
 * instruction, route, slippage, fee, blockhash, signer, or submission field.
 */
export type BurnRequest = Readonly<{
  requestId: string;
  launchMint: string;
  amountIn: string;
  legs: readonly BurnLegRequest[];
  /**
   * Creator-created per-vault address lookup table(s) covering the vault's
   * own deterministic burn accounts. Required for any 2+ leg burn (see the
   * structural fit check in buildAndSimulate). Permissionless: no service
   * approval is needed — a table only compresses accounts the service
   * itself placed in the instruction, and the program re-validates them all
   * on chain — so anyone's builder may create and pass one.
   */
  lookupTableAddresses?: readonly string[];
}>;

export function parseBurnRequest(value: unknown): BurnRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("INVALID_REQUEST", "burn request must be an object");
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([
    "requestId",
    "launchMint",
    "amountIn",
    "legs",
    "lookupTableAddresses",
  ]);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) {
    reject(
      "FORBIDDEN_REQUEST_FIELD",
      `request contains forbidden/unknown fields: ${unknown.join(",")}`
    );
  }
  if (
    typeof object.requestId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(object.requestId)
  ) {
    reject("INVALID_REQUEST_ID", "requestId must be 1-128 safe characters");
  }
  if (typeof object.launchMint !== "string") {
    reject("INVALID_LAUNCH_MINT", "launchMint must be a base58 public key");
  }
  try {
    new PublicKey(object.launchMint);
  } catch {
    reject("INVALID_LAUNCH_MINT", "launchMint must be a base58 public key");
  }
  if (
    typeof object.amountIn !== "string" ||
    !/^[1-9][0-9]*$/.test(object.amountIn)
  ) {
    reject("INVALID_AMOUNT", "amountIn must be a positive u64 decimal string");
  }
  const amount = BigInt(object.amountIn);
  if (amount > 0xffff_ffff_ffff_ffffn) {
    reject("INVALID_AMOUNT", "amountIn exceeds u64");
  }
  if (!Array.isArray(object.legs)) {
    reject("INVALID_LEGS", "legs must be an array");
  }
  if (object.legs.length === 0 || object.legs.length > MAX_SPLIT_TARGETS) {
    reject("INVALID_LEGS", `legs must contain 1-${MAX_SPLIT_TARGETS} entries`);
  }
  const legs = object.legs.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      reject("INVALID_LEG", `leg ${index} must be an object`);
    }
    const leg = raw as Record<string, unknown>;
    const legUnknown = Object.keys(leg).filter(
      (key) => key !== "targetMint" && key !== "bps" && key !== "reference"
    );
    if (legUnknown.length) {
      reject(
        "FORBIDDEN_REQUEST_FIELD",
        `leg ${index} contains forbidden/unknown fields: ${legUnknown.join(
          ","
        )}`
      );
    }
    if (typeof leg.targetMint !== "string") {
      reject("INVALID_TARGET_MINT", `leg ${index} targetMint is invalid`);
    }
    try {
      new PublicKey(leg.targetMint);
    } catch {
      reject("INVALID_TARGET_MINT", `leg ${index} targetMint is invalid`);
    }
    if (!Number.isInteger(leg.bps) || (leg.bps as number) <= 0) {
      reject("INVALID_WEIGHTS", `leg ${index} bps must be a positive integer`);
    }
    if (leg.reference !== undefined) {
      if (typeof leg.reference !== "string") {
        reject("INVALID_REFERENCE", `leg ${index} reference is invalid`);
      }
      try {
        new PublicKey(leg.reference);
      } catch {
        reject("INVALID_REFERENCE", `leg ${index} reference is invalid`);
      }
    }
    return {
      targetMint: leg.targetMint,
      bps: leg.bps as number,
      reference: leg.reference as string | undefined,
    };
  });
  if (legs.reduce((sum, leg) => sum + leg.bps, 0) !== BPS_TOTAL) {
    reject("INVALID_WEIGHTS", `leg weights must sum to ${BPS_TOTAL}`);
  }
  if (new Set(legs.map((leg) => leg.targetMint)).size !== legs.length) {
    reject("DUPLICATE_TARGET", "target mints must be distinct");
  }
  const lookupTableAddresses = object.lookupTableAddresses;
  if (
    lookupTableAddresses !== undefined &&
    (!Array.isArray(lookupTableAddresses) ||
      lookupTableAddresses.some((address) => typeof address !== "string"))
  ) {
    reject("INVALID_ALT", "lookupTableAddresses must be base58 strings");
  }
  for (const address of (lookupTableAddresses ?? []) as string[]) {
    try {
      new PublicKey(address);
    } catch {
      reject("INVALID_ALT", `invalid lookup table address ${address}`);
    }
  }
  return {
    requestId: object.requestId,
    launchMint: object.launchMint,
    amountIn: object.amountIn,
    legs,
    lookupTableAddresses: lookupTableAddresses as string[] | undefined,
  };
}

export type MintSnapshot = Readonly<{
  address: PublicKey;
  ownerProgram: PublicKey;
  initialized: boolean;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  closeAuthority?: PublicKey | null;
  extensionTypes: readonly number[];
  transferHookAuthority?: PublicKey | null;
  transferHookProgram?: PublicKey | null;
}>;

export type TokenAccountSnapshot = Readonly<{
  address: PublicKey;
  ownerProgram: PublicKey;
  initialized: boolean;
  mint: PublicKey;
  authority: PublicKey;
  amount: bigint;
  isNative: boolean;
  delegate: PublicKey | null;
  closeAuthority: PublicKey | null;
  extensionTypes: readonly number[];
}>;

export type RawAccountSnapshot = Readonly<{
  owner: PublicKey;
  lamports: bigint;
  dataLength: number;
  executable: boolean;
}>;

export type SimulationResult = Readonly<{
  error: unknown | null;
  logs?: readonly string[] | null;
  unitsConsumed?: number;
}>;

export interface ChainGateway {
  getMint(address: PublicKey): Promise<MintSnapshot | null>;
  getTokenAccount(address: PublicKey): Promise<TokenAccountSnapshot | null>;
  getRawAccount(address: PublicKey): Promise<RawAccountSnapshot | null>;
  /** Raw owner + data read; the keyless reference resolver prices off this.
   * `lamports` is optional; when present the direct-curve builder uses it to
   * verify rent pre-funding of Pump's lazily-created accounts. */
  getAccountData(
    address: PublicKey
  ): Promise<{ owner: PublicKey; data: Buffer; lamports?: bigint } | null>;
  getAddressLookupTable(
    address: PublicKey
  ): Promise<AddressLookupTableAccount | null>;
  getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
    contextSlot: number;
  }>;
  getBlockHeight(): Promise<number>;
  getRentFloorForZeroData(): Promise<bigint>;
  simulate(transaction: VersionedTransaction): Promise<SimulationResult>;
}

export interface MessageSigner {
  readonly publicKey: PublicKey;
  /** Must return one raw 64-byte Ed25519 signature over exactly message. */
  signMessage(
    message: Uint8Array,
    context: Readonly<Record<string, string>>
  ): Promise<Uint8Array>;
}

export interface PrivateSubmitter {
  submit(
    transaction: Uint8Array,
    metadata: Readonly<Record<string, string>>
  ): Promise<{ submissionId: string }>;
}

export interface VaultLease {
  release(outcome: "submitted" | "failed"): Promise<void>;
}

export interface VaultLeaseStore {
  acquire(
    vault: PublicKey,
    requestId: string,
    ttlMs: number
  ): Promise<VaultLease>;
  /**
   * Optional: the runner has watched a SUBMITTED burn settle on chain
   * (confirmed, or its blockhash expired), so the vault has no outstanding
   * transaction any more and may accept a new burn immediately instead of
   * waiting out the post-submission TTL hold. Advisory: a store without
   * this method keeps the TTL-expiry behavior, which remains the fallback
   * for runners that never confirm.
   */
  settle?(vault: PublicKey): Promise<void>;
}

export interface MinimumOutputPolicy {
  requiredMinimumOutput(
    inputLamports: bigint,
    targetMint: PublicKey
  ): Promise<bigint>;
}

export type JupiterBuildParams = Readonly<{
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  taker: PublicKey;
  destinationTokenAccount: PublicKey;
  maxAccounts?: number;
  /**
   * Venue exclusion. QuoteService sets this in exactly one case: the
   * documented Pump-venue exclusion after a burner-attributed 6018
   * (PUMP_VENUE_EXCLUDE_DEXES). `onlyDirectRoutes` remains prohibited and
   * has no parameter here on purpose.
   */
  excludeDexes?: readonly string[];
  /**
   * Venue include-list. NEVER set by QuoteService: production routes
   * unrestricted. Exists so explicit fork-mode wiring can restrict routes to
   * venues a Surfpool fork can serve (FORK_DEX_PROFILE=pool equivalent).
   */
  dexes?: readonly string[];
  /**
   * Fixed slippage tolerance override. NEVER set by QuoteService: production
   * uses Jupiter RTSE. Exists for explicit fork-mode wiring, where RTSE
   * estimates from live mainnet state while fork pools are frozen.
   */
  slippageBps?: number;
}>;

export interface JupiterClient {
  build(params: JupiterBuildParams): Promise<JupiterBuild>;
}

export type JupiterAccountMeta = Readonly<{
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}>;

export type JupiterInstruction = Readonly<{
  programId: string;
  accounts: readonly JupiterAccountMeta[];
  data: string;
}>;

export type JupiterBuild = Readonly<{
  error?: unknown;
  swapMode: string;
  inputMint?: string;
  outputMint?: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number | string;
  priceImpactPct?: string;
  platformFee?: unknown;
  swapInstruction: JupiterInstruction;
  setupInstructions?: readonly JupiterInstruction[];
  cleanupInstruction?: JupiterInstruction | null;
  otherInstructions?: readonly JupiterInstruction[];
  tipInstruction?: JupiterInstruction | null;
  addressesByLookupTableAddress?: Readonly<Record<string, readonly string[]>>;
  routePlan?: readonly unknown[];
}>;

export type QuoteServicePolicy = Readonly<{
  maxAmountPerBurn: bigint;
  maxSlippageBps: number;
  /** Ceiling in basis points; Jupiter's `priceImpactPct` wire field is a ratio. */
  maxPriceImpactBps: number;
  computeUnitLimit: number;
  minRemainingBlockHeights: number;
  leaseTtlMs: number;
  fittingMaxAccounts: readonly number[];
  approvedLookupTables: ReadonlySet<string>;
  production: boolean;
  /**
   * Extra re-quote attempts, within the SAME vault lease, for the failure
   * classes that are route variance rather than configuration: compute
   * exhaustion (retried at the next narrower fitting cap), externally
   * attributed simulation failures (fresh quote), and exactly one
   * burner-attributed 6018 with the Pump venues excluded. Burner-attributed
   * failures are deterministic and are never otherwise retried. Retries stop
   * before signing: nothing is ever re-quoted after a signature exists.
   * Default DEFAULT_RETRY_ATTEMPTS.
   */
  retryAttempts?: number;
}>;

/**
 * Builds the 18-account direct Pump bonding-curve buy for a leg whose bound
 * reference is a LIVE Pump curve. The program selects this path with EMPTY
 * route data (`split.rs` `is_curve_leg`) — no Jupiter involvement at all,
 * which is what makes a brand-new (or fork-only) own-launch mint burnable
 * before Jupiter has ever indexed it. The real implementation is
 * `PumpDirectCurveClient` in adapters.ts over the pure builder in
 * directcurve.ts.
 */
export interface DirectCurveClient {
  build(
    params: Readonly<{
      vault: PublicKey;
      targetMint: PublicKey;
      tokenProgram: PublicKey;
      targetAta: PublicKey;
    }>
  ): Promise<{
    accounts: readonly JupiterAccountMeta[];
    missingSetup: readonly string[];
  }>;
}

export type QuoteServiceDependencies = Readonly<{
  chain: ChainGateway;
  jupiter: JupiterClient;
  /**
   * Optional: without it, a leg bound to a live Pump bonding curve is
   * refused (DIRECT_CURVE_UNAVAILABLE) instead of silently asking Jupiter
   * to route a mint it may never have indexed.
   */
  directCurve?: DirectCurveClient;
  /**
   * KEYLESS: a burn needs exactly ONE signature — the fee payer's. This
   * signer is required only for the one-shot `execute` path, where the
   * service itself pays and submits (a keeper, or fork end-to-end mode).
   * `prepare` needs only the caller's PUBLIC key and no signer at all.
   * There is no quote authority: the program validates every route and
   * enforces its own reference-bound price floor on chain.
   */
  feePayerSigner?: MessageSigner;
  submitter: PrivateSubmitter;
  leaseStore: VaultLeaseStore;
  /**
   * Optional additional circuit breaker. Jupiter RTSE plus its signed
   * `otherAmountThreshold` is the normal pricing path; this is deliberately
   * not required for an arbitrary Jupiter-routable target mint.
   */
  floorPolicy?: MinimumOutputPolicy;
  burnerProgram?: PublicKey;
  policy: QuoteServicePolicy;
  /**
   * Structured observability hook. Receives only identifiers, codes, and
   * counts -- never request bodies, transactions, or signature material.
   */
  onEvent?: (fields: Readonly<Record<string, string>>) => void;
}>;

export type PreparedLeg = Readonly<{
  targetMint: PublicKey;
  targetTokenProgram: PublicKey;
  targetAta: PublicKey;
  bps: number;
  amountIn: bigint;
  minimumOutput: bigint;
  reference: ResolvedReference;
  routeAccounts: readonly JupiterAccountMeta[];
  routeData: Buffer;
  lookupTables: readonly AddressLookupTableAccount[];
}>;

export type BurnReceipt = Readonly<{
  requestId: string;
  vault: string;
  submissionId: string;
  messageSha256: string;
  lastValidBlockHeight: number;
  contextSlot: number;
  transactionBytes: number;
  accountLocks: number;
  simulatedUnits?: number;
  minimumOutputs: readonly string[];
}>;

/**
 * The result of `prepare`: a fully built, simulated, UNSIGNED transaction
 * whose sole required signer is the caller. Under keyless there is nothing
 * secret about these bytes — anyone could build the same transaction — so
 * returning them to the caller is the product, not a leak.
 */
export type PreparedBurn = Readonly<{
  requestId: string;
  vault: string;
  transaction: VersionedTransaction;
  messageSha256: string;
  lastValidBlockHeight: number;
  contextSlot: number;
  transactionBytes: number;
  accountLocks: number;
  simulatedUnits?: number;
  minimumOutputs: readonly string[];
}>;

function splitAmounts(total: bigint, bpsList: readonly number[]): bigint[] {
  const quotient = total / BigInt(BPS_TOTAL);
  const remainder = total % BigInt(BPS_TOTAL);
  const amounts: bigint[] = [];
  let allocated = 0n;
  for (const [index, bps] of bpsList.entries()) {
    const amount =
      index + 1 === bpsList.length
        ? total - allocated
        : quotient * BigInt(bps) +
          (remainder * BigInt(bps)) / BigInt(BPS_TOTAL);
    amounts.push(amount);
    allocated += amount;
  }
  return amounts;
}

/**
 * KEYLESS vault derivation, mirroring `build_split_seeds`:
 * `("burner", launch_mint, target_0..target_{n-1}, bps_blob,
 *   ref_0..ref_{n-1})` — one 32-byte reference seed per leg after the packed
 * weights. A Pump-venue reference contributes the zero sentinel; every other
 * venue contributes its pool address. There is no single-target derivation
 * any more: a 1-leg vault is a 1-leg split.
 */
export function deriveVault(
  burnerProgram: PublicKey,
  launchMint: PublicKey,
  legs: readonly { targetMint: PublicKey; bps: number; refSeed: Buffer }[]
): PublicKey {
  const weights = Buffer.alloc(2 * legs.length);
  legs.forEach((leg, index) => weights.writeUInt16LE(leg.bps, index * 2));
  return PublicKey.findProgramAddressSync(
    [
      BURNER_SEED,
      launchMint.toBuffer(),
      ...legs.map((leg) => leg.targetMint.toBuffer()),
      weights,
      ...legs.map((leg) => leg.refSeed),
    ],
    burnerProgram
  )[0];
}

function requireAllowedMint(
  snapshot: MintSnapshot | null,
  target: boolean
): MintSnapshot {
  if (!snapshot || !snapshot.initialized) {
    reject("INVALID_MINT", "mint is absent or uninitialized");
  }
  if (
    !snapshot.ownerProgram.equals(TOKEN_PROGRAM_ID) &&
    !snapshot.ownerProgram.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    reject(
      "INVALID_MINT_OWNER",
      "mint is not owned by SPL Token or Token-2022"
    );
  }
  if (!target) {
    if (
      snapshot.ownerProgram.equals(TOKEN_2022_PROGRAM_ID) &&
      snapshot.closeAuthority
    ) {
      reject(
        "LAUNCH_MINT_CLOSABLE",
        `Token-2022 launch namespace ${snapshot.address.toBase58()} has a live close authority`
      );
    }
    return snapshot;
  }
  // Mirrors the program's 6038 TargetMintNative. WSOL and the Token-2022
  // native mint pass every authority and extension check below, but
  // BurnChecked refuses a native account and no WSOL->WSOL route exists, so
  // a native-target vault would be fundable and permanently unburnable.
  // Refused by identity here, in the shared target-mint admission, so every
  // path that admits a target mint rejects it. WSOL stays legitimate as the
  // swap INPUT side (the vault's own WSOL ATA); only a native TARGET is
  // refused, and the launch-mint namespace is not identity-checked.
  if (
    snapshot.address.equals(NATIVE_MINT) ||
    snapshot.address.equals(NATIVE_MINT_2022)
  ) {
    reject(
      "TARGET_MINT_NATIVE",
      `target ${snapshot.address.toBase58()} is a native wrapped-SOL mint`
    );
  }
  if (snapshot.mintAuthority) {
    reject(
      "TARGET_MINTABLE",
      `target ${snapshot.address.toBase58()} has a mint authority`
    );
  }
  if (snapshot.freezeAuthority) {
    reject(
      "TARGET_FREEZABLE",
      `target ${snapshot.address.toBase58()} has a freeze authority`
    );
  }
  if (snapshot.ownerProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    for (const extension of snapshot.extensionTypes) {
      // spl-token ExtensionType.MetadataPointer=18, TokenMetadata=19,
      // TransferHook=14. Unknown future values fail closed.
      if (extension === 18 || extension === 19) continue;
      if (
        extension === 14 &&
        snapshot.address.equals(PUMP_MINT) &&
        snapshot.transferHookAuthority?.equals(PUMP_TRANSFER_HOOK_AUTHORITY) &&
        snapshot.transferHookProgram === null
      ) {
        continue;
      }
      reject(
        "UNSUPPORTED_TOKEN_2022_MINT",
        `target ${snapshot.address.toBase58()} has unsupported extension ${extension}`
      );
    }
  }
  return snapshot;
}

function requireTokenAccount(
  snapshot: TokenAccountSnapshot | null,
  expectedAddress: PublicKey,
  program: PublicKey,
  mint: PublicKey,
  authority: PublicKey,
  native: boolean
): TokenAccountSnapshot {
  if (
    !snapshot ||
    !snapshot.address.equals(expectedAddress) ||
    !snapshot.initialized
  ) {
    reject(
      "INVALID_TOKEN_ACCOUNT",
      `required token account ${expectedAddress.toBase58()} is missing`
    );
  }
  if (
    !snapshot.ownerProgram.equals(program) ||
    !snapshot.mint.equals(mint) ||
    !snapshot.authority.equals(authority) ||
    snapshot.isNative !== native
  ) {
    reject(
      "INVALID_TOKEN_ACCOUNT",
      `token account ${expectedAddress.toBase58()} has wrong state`
    );
  }
  if (snapshot.delegate || snapshot.closeAuthority) {
    reject(
      "ENCUMBERED_TOKEN_ACCOUNT",
      `token account ${expectedAddress.toBase58()} has a standing claim`
    );
  }
  if (program.equals(TOKEN_2022_PROGRAM_ID)) {
    for (const extension of snapshot.extensionTypes) {
      // ImmutableOwner=7 and TransferHookAccount=15 are the on-chain allow-list.
      if (extension !== 7 && extension !== 15) {
        reject(
          "UNSUPPORTED_TOKEN_2022_ACCOUNT",
          `token account ${expectedAddress.toBase58()} has unsupported extension ${extension}`
        );
      }
    }
  } else if (snapshot.extensionTypes.length) {
    reject(
      "INVALID_TOKEN_ACCOUNT",
      "legacy token account unexpectedly has extensions"
    );
  }
  return snapshot;
}

async function resolveAndValidateLookupTables(
  chain: ChainGateway,
  claimed: Readonly<Record<string, readonly string[]>>,
  requested: readonly string[],
  approved: ReadonlySet<string>
): Promise<AddressLookupTableAccount[]> {
  const claimedAddresses = Object.keys(claimed);
  const all = [...new Set([...claimedAddresses, ...requested])];
  // KEYLESS / PERMISSIONLESS: a caller-supplied lookup table needs NO
  // service approval. A lookup table is pure address COMPRESSION —
  // `compileToV0Message` only replaces an inlined account key with a table
  // index when the table already contains that exact address, and table
  // entries are immutable once written, so a table can never substitute,
  // add, or redirect an account the service did not itself place in the
  // burn instruction. The on-chain program remains the security boundary:
  // it re-derives the vault, pins every route account (6006), pins the
  // vault as a bare System account (6012) and enforces the whole
  // postcondition set regardless of how the message was compressed. This is
  // exactly CLAUDE.md's keyless property — "anyone can build a substitute
  // table" — so requiring a service-owned approved set here would make the
  // service authoritative over a permissionless vault. The table must still
  // EXIST and be ACTIVE (checked below), because a missing/deactivated table
  // cannot be resolved at execution; `approved` is retained as an accepted
  // superset for the demo's own curve-leg tables but is no longer required.
  void approved;
  const tables: AddressLookupTableAccount[] = [];
  for (const address of all) {
    const key = new PublicKey(address);
    const table = await chain.getAddressLookupTable(key);
    if (!table) reject("MISSING_ALT", `lookup table ${address} does not exist`);
    if (table.state.deactivationSlot !== ACTIVE_ALT_SLOT) {
      reject("INACTIVE_ALT", `lookup table ${address} is deactivated`);
    }
    const advertised = claimed[address];
    if (advertised) {
      const live = table.state.addresses.map((item) => item.toBase58());
      if (
        advertised.length !== live.length ||
        advertised.some((item, index) => item !== live[index])
      ) {
        reject(
          "ALT_MISMATCH",
          `Jupiter lookup table snapshot ${address} differs from RPC`
        );
      }
    }
    tables.push(table);
  }
  return tables;
}

function assertRoute(
  build: JupiterBuild,
  pda: PublicKey,
  wsolAta: PublicKey,
  targetMint: PublicKey,
  targetAta: PublicKey,
  targetTokenProgram: PublicKey,
  amountIn: bigint
): Buffer {
  if (build.error)
    reject(
      "JUPITER_BUILD_FAILED",
      `Jupiter build failed: ${String(build.error)}`
    );
  if (build.swapMode !== "ExactIn" || BigInt(build.inAmount) !== amountIn) {
    reject(
      "JUPITER_INPUT_MISMATCH",
      "Jupiter changed ExactIn or the authorized input"
    );
  }
  if (build.inputMint && build.inputMint !== NATIVE_MINT.toBase58()) {
    reject("JUPITER_MINT_MISMATCH", "Jupiter changed the input mint");
  }
  if (build.outputMint && build.outputMint !== targetMint.toBase58()) {
    reject("JUPITER_MINT_MISMATCH", "Jupiter changed the output mint");
  }
  if (build.platformFee !== undefined && build.platformFee !== null) {
    const fee = build.platformFee as { amount?: string; feeBps?: number };
    if (fee.amount !== "0" || (fee.feeBps ?? 0) !== 0) {
      reject("JUPITER_FEE", "Jupiter returned a platform fee");
    }
  }
  if (build.swapInstruction?.programId !== JUPITER_PROGRAM.toBase58()) {
    reject("INVALID_JUPITER_PROGRAM", "swap instruction is not Jupiter v6");
  }
  const data = Buffer.from(build.swapInstruction.data, "base64");
  const discriminator = data.subarray(0, 8).toString("hex");
  const shared = discriminator === SHARED_ROUTE_V2_DISCRIMINATOR;
  if (!shared && discriminator !== ROUTE_V2_DISCRIMINATOR) {
    reject(
      "INVALID_JUPITER_INSTRUCTION",
      `unsupported Jupiter discriminator ${discriminator}`
    );
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
    reject("INVALID_JUPITER_INSTRUCTION", "truncated Jupiter instruction");
  }
  if (data.readBigUInt64LE(offsets.input) !== amountIn) {
    reject(
      "JUPITER_INPUT_MISMATCH",
      "Jupiter instruction input differs from authorized input"
    );
  }
  if (
    data.readUInt16LE(offsets.platformFee) !== 0 ||
    data.readUInt16LE(offsets.positiveSlippageFee) !== 0
  ) {
    reject(
      "JUPITER_FEE",
      "Jupiter instruction contains platform/positive-slippage fee"
    );
  }
  const accounts = build.swapInstruction.accounts;
  if (!Array.isArray(accounts) || accounts.length < offsets.fixed) {
    reject("INVALID_JUPITER_ACCOUNTS", "truncated Jupiter account list");
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
    if (accounts[index]?.pubkey !== key.toBase58()) {
      reject(
        "INVALID_JUPITER_ACCOUNTS",
        `Jupiter account ${index} is not pinned`
      );
    }
  }
  const forbiddenSigner = accounts.find(
    (account) => account.isSigner && account.pubkey !== pda.toBase58()
  );
  if (forbiddenSigner) {
    reject(
      "FORBIDDEN_ROUTE_SIGNER",
      `Jupiter route requests signer ${forbiddenSigner.pubkey}`
    );
  }
  return data;
}

function assertAuxiliaryInstructions(
  build: JupiterBuild
): readonly JupiterInstruction[] {
  if (
    build.cleanupInstruction ||
    build.tipInstruction ||
    (build.otherInstructions?.length ?? 0) > 0
  ) {
    reject(
      "AUXILIARY_INSTRUCTION",
      "cleanup, tip, and other Jupiter instructions are forbidden"
    );
  }
  const setup = build.setupInstructions ?? [];
  for (const instruction of setup) {
    if (
      instruction.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() ||
      instruction.data !== "AQ=="
    ) {
      reject(
        "UNSAFE_SETUP",
        "only idempotent ATA setup may be requested separately"
      );
    }
  }
  return setup;
}

function splitData(total: bigint, legs: readonly PreparedLeg[]): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.writeBigUInt64LE(total, 0);
  prefix.writeUInt32LE(legs.length, 8);
  const parts: Buffer[] = [SPLIT_DISCRIMINATOR, prefix];
  for (const leg of legs) {
    if (leg.routeAccounts.length > 255) {
      reject("TOO_MANY_ROUTE_ACCOUNTS", "a route has more than 255 accounts");
    }
    const header = Buffer.alloc(15);
    header.writeUInt16LE(leg.bps, 0);
    header.writeBigUInt64LE(leg.minimumOutput, 2);
    header.writeUInt8(leg.routeAccounts.length, 10);
    header.writeUInt32LE(leg.routeData.length, 11);
    parts.push(header, leg.routeData);
  }
  return Buffer.concat(parts);
}

/**
 * KEYLESS split-burn account layout (split.rs "Account order"):
 *
 *   0 caller           (signer, fee payer)
 *   1 RESERVED         -- held the KMS quote authority; the program binds it
 *                         to `let _quote_authority` and never reads it, and
 *                         no signature is required. The burner program id is
 *                         placed here as a harmless, constant filler so the
 *                         layout and every downstream index are unchanged.
 *                         (The keyless fork harness uses the same filler.)
 *   2 burn_pda (w)  3 wsol_ata (w)  4 launch_mint  5 system  6 spl-token
 *   7 jupiter
 *   8.. per leg, SEVEN accounts: target_mint (w), target_ata (w),
 *       target_token_program, reference pool, pool vault A, pool vault B,
 *       fee source — the reference block `keyless_leg_floor` prices from.
 *   .. then every leg's Jupiter route accounts, leg 0 first.
 */
export function buildBurnInstruction(
  burnerProgram: PublicKey,
  feePayer: PublicKey,
  launchMint: PublicKey,
  pda: PublicKey,
  wsolAta: PublicKey,
  amount: bigint,
  legs: readonly PreparedLeg[]
): TransactionInstruction {
  return new TransactionInstruction({
    programId: burnerProgram,
    keys: [
      { pubkey: feePayer, isSigner: true, isWritable: false },
      { pubkey: burnerProgram, isSigner: false, isWritable: false },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: launchMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
      ...legs.flatMap((leg) => [
        { pubkey: leg.targetMint, isSigner: false, isWritable: true },
        { pubkey: leg.targetAta, isSigner: false, isWritable: true },
        { pubkey: leg.targetTokenProgram, isSigner: false, isWritable: false },
        { pubkey: leg.reference.pool, isSigner: false, isWritable: false },
        { pubkey: leg.reference.vaultA, isSigner: false, isWritable: false },
        { pubkey: leg.reference.vaultB, isSigner: false, isWritable: false },
        { pubkey: leg.reference.feeSource, isSigner: false, isWritable: false },
      ]),
      ...legs.flatMap((leg) =>
        leg.routeAccounts.map((account) => ({
          pubkey: new PublicKey(account.pubkey),
          // The burner grants only its PDA signature inside the Jupiter CPI.
          isSigner: false,
          isWritable: account.isWritable,
        }))
      ),
    ],
    data: splitData(amount, legs),
  });
}

export function verifyEd25519(
  publicKey: PublicKey,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  if (signature.length !== 64) return false;
  // RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    publicKey.toBuffer(),
  ]);
  return verifySignature(
    null,
    Buffer.from(message),
    createPublicKey({ key: spki, format: "der", type: "spki" }),
    Buffer.from(signature)
  );
}

async function signCompleteMessage(
  transaction: VersionedTransaction,
  signers: readonly MessageSigner[],
  context: Readonly<Record<string, string>>
): Promise<void> {
  const message = transaction.message.serialize();
  // KEYLESS: exactly one signer — the fee payer — signs the complete
  // service-built message. Every returned signature is verified before it is
  // attached, so a broken signer cannot produce an unsendable transaction.
  for (const signer of signers) {
    const signature = await signer.signMessage(message, context);
    if (!verifyEd25519(signer.publicKey, message, signature)) {
      reject(
        "INVALID_SIGNER_RESPONSE",
        `signer ${signer.publicKey.toBase58()} returned an invalid signature`
      );
    }
    transaction.addSignature(signer.publicKey, signature);
  }
}

export type SimulationFailureAttribution = Readonly<{
  /**
   * "burner": the burner program itself raised a custom error -- deterministic,
   * never retried (except the single documented 6018 venue-exclusion retry).
   * "external": another program (Jupiter or an AMM) raised the innermost
   * custom error -- route variance, retryable with a fresh quote.
   * "compute": the transaction exhausted its compute budget -- route variance,
   * retryable at a narrower fitting cap.
   * "unknown": no attributable frame; treated as retryable like "external"
   * because simulation failures are side-effect free.
   */
  kind: "burner" | "external" | "compute" | "unknown";
  code?: number;
  programId?: string;
}>;

/**
 * Attribute a simulation failure to the program that actually raised it. The
 * INNERMOST `Program <id> failed: custom program error` frame is the author:
 * Jupiter and every AMM it routes through are Anchor programs whose codes are
 * also 6000-based, so a bare Custom(N) from the transaction result must never
 * be credited to the burner without this frame. (In Solana logs the innermost
 * failing program prints its frame first.)
 */
export function classifySimulationFailure(
  error: unknown,
  logs: readonly string[] | null | undefined,
  burnerProgram: PublicKey
): SimulationFailureAttribution {
  for (const line of logs ?? []) {
    const failed =
      /^Program (\S+) failed: custom program error: 0x([0-9a-f]+)/i.exec(line);
    if (failed) {
      return {
        kind: failed[1] === burnerProgram.toBase58() ? "burner" : "external",
        code: parseInt(failed[2], 16),
        programId: failed[1],
      };
    }
  }
  const text = `${JSON.stringify(error ?? "")} ${(logs ?? []).join(" | ")}`;
  if (
    /ComputationalBudgetExceeded|ComputeBudgetExceeded|exceeded CUs meter|ProgramFailedToComplete/i.test(
      text
    )
  ) {
    return { kind: "compute" };
  }
  return { kind: "unknown" };
}

/** Route programs a burn's CPI chain can fail inside, by id. Naming the
 * actual author keeps an AMM's error from ever reading as a burner code —
 * a bare "Custom: 6024" from Raydium CLMM is its InvalidFirstTickArrayAccount
 * (transient), while OUR 6024 is UnsupportedToken2022Extension (permanent). */
export const KNOWN_ROUTE_PROGRAMS: Readonly<Record<string, string>> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium v4",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CP",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
};

/** Foreign error codes worth naming, keyed `programId:code`. Verified
 * against the archived on-chain IDLs (evidence/keyless-audit-20260823). */
const KNOWN_EXTERNAL_ERROR_NAMES: Readonly<Record<string, string>> = {
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK:6024":
    "InvalidFirstTickArrayAccount — a stale tick array in the quoted route",
};

/**
 * Human-readable authorship line for a simulation failure. The advice
 * follows from the attribution: an externally-authored failure is route
 * weather (fresh quote fixes it); unknown authorship is stated as unknown
 * and never credited to the burner.
 */
export function describeSimulationAttribution(
  attribution: SimulationFailureAttribution
): string {
  if (attribution.kind === "external") {
    const program = attribution.programId ?? "an unidentified program";
    const name = KNOWN_ROUTE_PROGRAMS[program];
    const errorName =
      attribution.code !== undefined
        ? KNOWN_EXTERNAL_ERROR_NAMES[`${program}:${attribution.code}`]
        : undefined;
    return (
      `the quoted route failed inside ${name ?? "program"} ${program}` +
      (attribution.code !== undefined
        ? ` with ITS error ${attribution.code}${
            errorName ? ` (${errorName})` : ""
          } — not a burner error code`
        : "") +
      `; this is transient route state, and a fresh quote is the fix`
    );
  }
  if (attribution.kind === "unknown") {
    return (
      "simulation failed with no attributable program frame — authorship " +
      "unknown (not assumed to be the burner); retry with a fresh quote"
    );
  }
  return `simulation failed (${attribution.kind})`;
}

/** Legs whose Jupiter route touches either Pump venue program. */
function pumpVenueLegIndexes(legs: readonly PreparedLeg[]): number[] {
  const pumpIds = new Set([
    PUMP_FUN_PROGRAM.toBase58(),
    PUMP_AMM_PROGRAM.toBase58(),
  ]);
  return legs.flatMap((leg, index) =>
    leg.routeAccounts.some((account) => pumpIds.has(account.pubkey))
      ? [index]
      : []
  );
}

export class InMemoryVaultLeaseStore implements VaultLeaseStore {
  /** vault -> the token of the lease currently holding it. The token guards
   * every deferred delete: once `settle` frees a vault early, a LATER burn
   * may re-acquire it, and the previous lease's still-pending TTL timer
   * must not free that newer lease mid-burn. */
  private readonly active = new Map<string, symbol>();
  private readonly submittedRequestIds = new Set<string>();

  async acquire(
    vault: PublicKey,
    requestId: string,
    ttlMs: number
  ): Promise<VaultLease> {
    const key = vault.toBase58();
    if (this.submittedRequestIds.has(requestId)) {
      reject(
        "DUPLICATE_REQUEST",
        `requestId ${requestId} was already submitted`
      );
    }
    if (this.active.has(key))
      reject("VAULT_BUSY", `vault ${key} already has an outstanding burn`);
    const token = Symbol(requestId);
    this.active.set(key, token);
    const deleteIfStillOurs = () => {
      if (this.active.get(key) === token) this.active.delete(key);
    };
    let released = false;
    return {
      release: async (outcome) => {
        if (!released && outcome === "failed") deleteIfStillOurs();
        if (!released && outcome === "submitted") {
          this.submittedRequestIds.add(requestId);
          const timer = setTimeout(deleteIfStillOurs, ttlMs);
          timer.unref();
        }
        released = true;
      },
    };
  }

  /** A submitted burn was watched to settlement (confirmed or expired):
   * clear the vault hold now. Without this, a CONFIRMED burn still blocks
   * its vault for the full TTL — observed live 2026-08-26: a burn confirmed
   * at 20:39:59 left its vault refusing VAULT_BUSY until the 180s timer
   * fired. Callers must invoke this only for a burn they THEMSELVES just
   * watched settle, before issuing new requests for the vault (the demo
   * settles synchronously after confirmation, inside the request that held
   * the lease). requestId dedup is deliberately untouched. */
  async settle(vault: PublicKey): Promise<void> {
    this.active.delete(vault.toBase58());
  }
}

export class StaticRateFloorPolicy implements MinimumOutputPolicy {
  constructor(
    private readonly rates: ReadonlyMap<
      string,
      Readonly<{ numerator: bigint; denominator: bigint }>
    >
  ) {}

  async requiredMinimumOutput(input: bigint, mint: PublicKey): Promise<bigint> {
    const rate = this.rates.get(mint.toBase58());
    if (!rate || rate.numerator <= 0n || rate.denominator <= 0n) {
      reject(
        "NO_PRICE_FLOOR",
        `no independent output floor configured for ${mint.toBase58()}`
      );
    }
    return (input * rate.numerator + rate.denominator - 1n) / rate.denominator;
  }
}

export class QuoteService {
  private readonly burnerProgram: PublicKey;

  constructor(private readonly dependencies: QuoteServiceDependencies) {
    this.burnerProgram = dependencies.burnerProgram ?? DEFAULT_BURNER_PROGRAM;
    const { policy } = dependencies;
    if (
      policy.computeUnitLimit <= 200_000 ||
      policy.computeUnitLimit > 1_400_000 ||
      !Number.isInteger(policy.computeUnitLimit)
    ) {
      reject(
        "POLICY_CONFIGURATION",
        "computeUnitLimit must be an integer in 200001..1400000"
      );
    }
    if (policy.maxSlippageBps <= 0 || policy.maxSlippageBps >= BPS_TOTAL) {
      reject("POLICY_CONFIGURATION", "maxSlippageBps is invalid");
    }
    if (policy.maxAmountPerBurn <= 0n) {
      reject("POLICY_CONFIGURATION", "maxAmountPerBurn must be positive");
    }
    if (
      !Number.isFinite(policy.maxPriceImpactBps) ||
      policy.maxPriceImpactBps < 0 ||
      policy.maxPriceImpactBps > BPS_TOTAL
    ) {
      reject("POLICY_CONFIGURATION", "maxPriceImpactBps is invalid");
    }
    if (policy.leaseTtlMs < 180_000) {
      reject(
        "POLICY_CONFIGURATION",
        "leaseTtlMs must cover preparation and the blockhash window (>=180000ms)"
      );
    }
    if (
      policy.retryAttempts !== undefined &&
      (!Number.isInteger(policy.retryAttempts) ||
        policy.retryAttempts < 0 ||
        policy.retryAttempts > 5)
    ) {
      reject(
        "POLICY_CONFIGURATION",
        "retryAttempts must be an integer in 0..5"
      );
    }
  }

  /**
   * Measure one awaited pipeline phase with a monotonic clock. The event is
   * deliberately metadata-only: it never contains transaction bytes, route
   * data, signatures, or request bodies.
   */
  private async timed<T>(
    requestId: string,
    phase: string,
    fields: Readonly<Record<string, string>>,
    action: () => Promise<T>
  ): Promise<T> {
    const started = performance.now();
    let outcome = "ok";
    let errorCode = "";
    try {
      return await action();
    } catch (error) {
      outcome = "error";
      errorCode = error instanceof PolicyError ? error.code : "";
      throw error;
    } finally {
      this.dependencies.onEvent?.({
        event: "phase-timing",
        requestId,
        phase,
        elapsedMs: (performance.now() - started).toFixed(1),
        outcome,
        errorCode,
        ...fields,
      });
    }
  }

  /**
   * Parse the request, resolve every leg's keyless reference, and derive the
   * vault the program will derive: the reference seeds are part of the
   * address, so resolution must precede derivation.
   */
  private async resolveRequest(rawRequest: unknown): Promise<ResolvedRequest> {
    const request = parseBurnRequest(rawRequest);
    const launchMint = new PublicKey(request.launchMint);
    const amount = BigInt(request.amountIn);
    if (amount > this.dependencies.policy.maxAmountPerBurn) {
      reject(
        "NOTIONAL_LIMIT",
        "burn amount exceeds the per-transaction service limit"
      );
    }
    // A native (wrapped-SOL) TARGET is refused by identity — no network read
    // needed (mirrors the program's 6038 TargetMintNative). Decided here so a
    // native target never costs a reference resolution or a mint read.
    for (const leg of request.legs) {
      const targetMint = new PublicKey(leg.targetMint);
      if (targetMint.equals(NATIVE_MINT) || targetMint.equals(NATIVE_MINT_2022)) {
        reject(
          "TARGET_MINT_NATIVE",
          `leg target ${leg.targetMint} is a native wrapped-SOL mint, which ` +
            `cannot be a burn target (6038)`
        );
      }
    }
    const requestedLegs = await this.timed(
      request.requestId,
      "reference-resolution",
      { legCount: String(request.legs.length) },
      () =>
        Promise.all(
          request.legs.map(async (leg, legIndex) =>
            this.timed(
              request.requestId,
              "reference-resolution-leg",
              {
                leg: String(legIndex),
                targetMint: leg.targetMint,
              },
              async () => {
                const targetMint = new PublicKey(leg.targetMint);
                const reference = await resolveReference(
                  this.dependencies.chain,
                  targetMint,
                  leg.reference ? new PublicKey(leg.reference) : undefined
                );
                return { targetMint, bps: leg.bps, reference };
              }
            )
          )
        )
    );
    // FAST LOCAL REFUSALS — the per-leg cap (6040), reference depth floor
    // (6041), floor-collapse (6002) and zero-input are FULLY determined by
    // the references just resolved plus the pure split. They need no vault,
    // mint, ATA, or Jupiter read. Deciding them HERE — before the lease is
    // acquired and before buildAndSimulate's account pre-flight — refuses an
    // over-cap or too-shallow burn in ~reference-resolution time (the pools
    // are already read) instead of after a chain of reads and, in the worst
    // prior case, the whole fitting ladder. buildAndSimulate re-derives the
    // exact floor per leg; this is the same computation surfaced early.
    const legAmounts = splitAmounts(
      amount,
      requestedLegs.map((leg) => leg.bps)
    );
    requestedLegs.forEach((leg, index) => {
      if (legAmounts[index] === 0n) {
        reject("ZERO_LEG_AMOUNT", `leg ${index} rounds to zero input`);
      }
      // Throws REFERENCE_CAP_EXCEEDED (6040) / REFERENCE_TOO_SHALLOW (6041) /
      // REFERENCE_FLOOR_ZERO (6002) exactly where the program would refuse.
      leg.reference.floorFor(legAmounts[index]);
    });
    const pda = deriveVault(
      this.burnerProgram,
      launchMint,
      requestedLegs.map((leg) => ({
        targetMint: leg.targetMint,
        bps: leg.bps,
        refSeed: leg.reference.seed,
      }))
    );
    return { request, launchMint, amount, requestedLegs, pda };
  }

  /**
   * Build, validate, and simulate an UNSIGNED burn for a caller who will
   * sign and pay for it themselves. No lease, no signer, no submission: the
   * caller owns the rest of the lifecycle, exactly as any stranger building
   * their own transaction would.
   */
  async prepare(
    rawRequest: unknown,
    feePayer: PublicKey
  ): Promise<PreparedBurn> {
    const resolved = await this.resolveRequest(rawRequest);
    const built = await this.buildAndSimulate(resolved, feePayer);
    return {
      requestId: resolved.request.requestId,
      vault: resolved.pda.toBase58(),
      transaction: built.transaction,
      messageSha256: built.digest,
      lastValidBlockHeight: built.validity.lastValidBlockHeight,
      contextSlot: built.validity.contextSlot,
      transactionBytes: built.bytes,
      accountLocks: built.locks,
      simulatedUnits: built.simulatedUnits,
      minimumOutputs: built.legs.map((leg) => leg.minimumOutput.toString()),
    };
  }

  /** One-shot keeper path: the service pays, signs, and submits. */
  async execute(rawRequest: unknown): Promise<BurnReceipt> {
    const feePayerSigner = this.dependencies.feePayerSigner;
    if (!feePayerSigner) {
      reject(
        "SIGNER_CONFIGURATION",
        "one-shot execute needs a configured fee-payer signer; use prepare for caller-paid burns"
      );
    }
    const resolved = await this.resolveRequest(rawRequest);
    const { request, pda } = resolved;
    const lease = await this.timed(
      request.requestId,
      "lease-acquire",
      { vault: pda.toBase58() },
      () =>
        this.dependencies.leaseStore.acquire(
          pda,
          request.requestId,
          this.dependencies.policy.leaseTtlMs
        )
    );
    let submitted = false;
    try {
      const receipt = await this.executeUnderLease(resolved, feePayerSigner);
      submitted = true;
      return receipt;
    } finally {
      try {
        await lease.release(submitted ? "submitted" : "failed");
      } catch (releaseError) {
        // A lease-release failure fails SAFE (the backing store keeps the
        // vault locked until TTL expiry), so it must never mask the outcome:
        // a submitted burn's receipt would be lost, or a preparation error
        // would be replaced by a lease-plumbing error.
        this.dependencies.onEvent?.({
          event: "lease-release-failed",
          requestId: request.requestId,
          vault: pda.toBase58(),
          outcome: submitted ? "submitted" : "failed",
          error:
            releaseError instanceof Error
              ? releaseError.message.slice(0, 200)
              : String(releaseError).slice(0, 200),
        });
      }
    }
  }

  private async executeUnderLease(
    resolved: ResolvedRequest,
    feePayerSigner: MessageSigner
  ): Promise<BurnReceipt> {
    const { request, pda } = resolved;
    const built = await this.buildAndSimulate(
      resolved,
      feePayerSigner.publicKey
    );
    const { policy } = this.dependencies;
    const signingContext = {
      purpose: "onchain-burner-keyless-burn",
      requestId: request.requestId,
      programId: this.burnerProgram.toBase58(),
      vault: pda.toBase58(),
      launchMint: resolved.launchMint.toBase58(),
      targetMints: built.legs.map((leg) => leg.targetMint.toBase58()).join(","),
      amountIn: resolved.amount.toString(),
      minimumOutputs: built.legs
        .map((leg) => leg.minimumOutput.toString())
        .join(","),
      computeUnitLimit: String(policy.computeUnitLimit),
      messageSha256: built.digest,
      lastValidBlockHeight: String(built.validity.lastValidBlockHeight),
      contextSlot: String(built.validity.contextSlot),
      transactionBytes: String(built.bytes),
      accountLocks: String(built.locks),
      simulatedUnits: String(built.simulatedUnits ?? ""),
    };
    await this.timed(
      request.requestId,
      "signing",
      {},
      () =>
        signCompleteMessage(
          built.transaction,
          [feePayerSigner],
          signingContext
        )
    );
    const heightAfterSigning = await this.dependencies.chain.getBlockHeight();
    if (
      built.validity.lastValidBlockHeight - heightAfterSigning <
      policy.minRemainingBlockHeights
    ) {
      reject(
        "BLOCKHASH_TOO_OLD",
        "too little blockhash lifetime remains after signing"
      );
    }
    const wire = built.transaction.serialize();
    const submission = await this.timed(
      request.requestId,
      "submission",
      {},
      () => this.dependencies.submitter.submit(wire, signingContext)
    );
    return {
      requestId: request.requestId,
      vault: pda.toBase58(),
      submissionId: submission.submissionId,
      messageSha256: built.digest,
      lastValidBlockHeight: built.validity.lastValidBlockHeight,
      contextSlot: built.validity.contextSlot,
      transactionBytes: built.bytes,
      accountLocks: built.locks,
      simulatedUnits: built.simulatedUnits,
      minimumOutputs: built.legs.map((leg) => leg.minimumOutput.toString()),
    };
  }

  private async buildAndSimulate(
    resolved: ResolvedRequest,
    feePayer: PublicKey
  ): Promise<BuiltBurn> {
    const { request, launchMint, amount, requestedLegs, pda } = resolved;
    const { chain, policy } = this.dependencies;
    const { wsolAta } = await this.timed(
      request.requestId,
      "vault-admission",
      { vault: pda.toBase58() },
      async () => {
        requireAllowedMint(await chain.getMint(launchMint), false);
        const vault = await chain.getRawAccount(pda);
        if (
          !vault ||
          !vault.owner.equals(SystemProgram.programId) ||
          vault.dataLength !== 0
        ) {
          reject("INVALID_VAULT", "derived vault is not a bare System account");
        }
        if (vault.lamports < amount)
          reject(
            "INSUFFICIENT_VAULT_BALANCE",
            `the vault cannot fund the burn: it holds ${vault.lamports} lamports, you asked ${amount}. Burn at most the balance`
          );
        const rentFloor = await chain.getRentFloorForZeroData();
        const remainder = vault.lamports - amount;
        if (remainder !== 0n && remainder < rentFloor) {
          reject(
            "DUST_REMAINDER",
            `this burn would leave a sub-rent-floor remainder of ${remainder} lamports (floor ${rentFloor}, 6026). Burn less — leave at least the floor — or empty the vault exactly`
          );
        }
        const wsolAta = getAssociatedTokenAddressSync(
          NATIVE_MINT,
          pda,
          true,
          TOKEN_PROGRAM_ID
        );
        requireTokenAccount(
          await chain.getTokenAccount(wsolAta),
          wsolAta,
          TOKEN_PROGRAM_ID,
          NATIVE_MINT,
          pda,
          true
        );
        return { wsolAta };
      }
    );
    const amounts = splitAmounts(
      amount,
      requestedLegs.map((leg) => leg.bps)
    );
    const admitted = await this.timed(
      request.requestId,
      "target-admission",
      { legCount: String(requestedLegs.length) },
      () =>
        Promise.all(
          requestedLegs.map(async (leg, index) => {
            if (amounts[index] === 0n)
              reject("ZERO_LEG_AMOUNT", `leg ${index} rounds to zero input`);
            const mint = requireAllowedMint(
              await chain.getMint(leg.targetMint),
              true
            );
            const ata = getAssociatedTokenAddressSync(
              leg.targetMint,
              pda,
              true,
              mint.ownerProgram
            );
            requireTokenAccount(
              await chain.getTokenAccount(ata),
              ata,
              mint.ownerProgram,
              leg.targetMint,
              pda,
              false
            );
            // The exact floor the program will compute for this leg from its
            // bound reference (throws where the program would refuse 6040/6002).
            const programFloor = leg.reference.floorFor(amounts[index]);
            return {
              ...leg,
              amountIn: amounts[index],
              tokenProgram: mint.ownerProgram,
              ata,
              programFloor,
            };
          })
        )
    );

    // Caller-supplied lookup tables are the SAME on every fitting rung, so
    // resolve them ONCE here rather than per rung inside the ladder.
    const requestedTables = await this.timed(
      request.requestId,
      "lookup-table-resolution",
      { source: "request" },
      () =>
        resolveAndValidateLookupTables(
          chain,
          {},
          request.lookupTableAddresses ?? [],
          policy.approvedLookupTables
        )
    );

    // Does a caller-supplied lookup table cover the vault's OWN deterministic
    // burn accounts? A keyless burn inlines 8 fixed accounts + 7 per leg
    // (target mint, ATA, token program, and the reference pool/vaultA/vaultB/
    // feeSource quartet) BEFORE any Jupiter route account. Measured: a 3-leg
    // burn is ~2.3-3.5 KB fully inlined — over Solana's 1232-byte limit at
    // ANY Jupiter `maxAccounts` cap, because narrowing the route cannot
    // shrink the fixed vault-side keys. The per-vault table is CREATOR-owned
    // setup (CLAUDE.md budgets its rent alongside the ATAs); the service
    // never creates it. This coverage verdict lets the ladder fail FAST (one
    // Jupiter call, not six) the moment the widest route proves it will not
    // fit without such a table — see the rung-0 short-circuit below.
    const coveredByAlt = new Set(
      requestedTables.flatMap((table) =>
        table.state.addresses.map((address) => address.toBase58())
      )
    );
    const requiredVaultAccounts = new Map<string, string>();
    requiredVaultAccounts.set(pda.toBase58(), "vault PDA");
    requiredVaultAccounts.set(wsolAta.toBase58(), "vault WSOL account");
    for (let i = 0; i < admitted.length; i += 1) {
      const leg = admitted[i];
      requiredVaultAccounts.set(leg.ata.toBase58(), `leg ${i} target ATA`);
      requiredVaultAccounts.set(
        leg.reference.pool.toBase58(),
        `leg ${i} reference pool`
      );
    }
    const missingFromAlt = [...requiredVaultAccounts.entries()].filter(
      ([address]) => !coveredByAlt.has(address)
    );
    const vaultAltCovers = missingFromAlt.length === 0;

    const caps: Array<number | undefined> = [
      undefined,
      ...policy.fittingMaxAccounts,
    ];
    const retryLimit = policy.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const pumpExcludedLegs = new Set<number>();
    let capStartIndex = 0;
    let cashbackRetryUsed = false;
    let final:
      | {
          transaction: VersionedTransaction;
          lookupTables: AddressLookupTableAccount[];
          legs: PreparedLeg[];
          bytes: number;
          locks: number;
          capIndex: number;
          validity: {
            blockhash: string;
            lastValidBlockHeight: number;
            contextSlot: number;
          };
        }
      | undefined;
    let simulation: SimulationResult = { error: null };
    // Retryable SIMULATION failures are re-quoted inside the SAME lease and
    // strictly BEFORE any signature exists. Deterministic guard rejections
    // thrown during preparation propagate immediately and are never retried,
    // and nothing below the end of this loop (signing, submission) is ever
    // re-entered.
    for (let attempt = 0; ; attempt += 1) {
      final = undefined;
      for (
        let capIndex = capStartIndex;
        capIndex < caps.length;
        capIndex += 1
      ) {
        const cap = caps[capIndex];
        const legs = await Promise.all(
          admitted.map(async (leg, legIndex): Promise<PreparedLeg> => {
            if (leg.reference.venue === DIRECT_CURVE_VENUE) {
              // DIRECT CURVE: the reference is the live Pump bonding curve,
              // so the program buys straight off it — EMPTY route data
              // selects that path on chain, and Jupiter is never consulted
              // (it cannot route a mint it has not indexed, which every
              // fresh own-launch mint is). Ported from the proven harness
              // fable-ps-repeat-x.mjs (22/22 own-curve legs, 2026-08-26).
              const directCurve = this.dependencies.directCurve;
              if (!directCurve) {
                reject(
                  "DIRECT_CURVE_UNAVAILABLE",
                  `leg ${legIndex} (${leg.targetMint.toBase58()}) is bound to a live Pump bonding curve, and this service instance has no direct-curve builder configured`
                );
              }
              const curveBuild = await this.timed(
                request.requestId,
                "direct-curve-build",
                {
                  pipelineAttempt: String(attempt + 1),
                  leg: String(legIndex),
                  targetMint: leg.targetMint.toBase58(),
                },
                () =>
                  directCurve.build({
                    vault: pda,
                    targetMint: leg.targetMint,
                    tokenProgram: leg.tokenProgram,
                    targetAta: leg.ata,
                  })
              );
              if (curveBuild.missingSetup.length) {
                reject(
                  "SETUP_REQUIRED",
                  `direct-curve leg ${legIndex} needs caller-funded setup in a separate transaction before a burn: ${curveBuild.missingSetup.join(
                    "; "
                  )}`
                );
              }
              assertDirectCurveLegShape(curveBuild.accounts, {
                vault: pda,
                targetMint: leg.targetMint,
                targetAta: leg.ata,
              });
              return {
                targetMint: leg.targetMint,
                targetTokenProgram: leg.tokenProgram,
                targetAta: leg.ata,
                bps: leg.bps,
                amountIn: leg.amountIn,
                // The program's OWN reference floor, computed in exact
                // BigInt arithmetic by the resolver (the float64 floors an
                // earlier harness used produced spurious 6021s). There is
                // no Jupiter threshold on this path to tighten it.
                minimumOutput: leg.programFloor,
                reference: leg.reference,
                routeAccounts: curveBuild.accounts,
                routeData: Buffer.alloc(0),
                lookupTables: [],
              } satisfies PreparedLeg;
            }
            const build = await this.timed(
              request.requestId,
              "jupiter-quote",
              {
                pipelineAttempt: String(attempt + 1),
                fittingRung: String(capIndex + 1),
                maxAccounts: cap === undefined ? "unbounded" : String(cap),
                leg: String(legIndex),
                targetMint: leg.targetMint.toBase58(),
              },
              () =>
                this.dependencies.jupiter.build({
                  inputMint: NATIVE_MINT,
                  outputMint: leg.targetMint,
                  amount: leg.amountIn,
                  taker: pda,
                  destinationTokenAccount: leg.ata,
                  maxAccounts: cap,
                  excludeDexes: pumpExcludedLegs.has(legIndex)
                    ? PUMP_VENUE_EXCLUDE_DEXES
                    : undefined,
                })
            );
            const routeData = assertRoute(
              build,
              pda,
              wsolAta,
              leg.targetMint,
              leg.ata,
              leg.tokenProgram,
              leg.amountIn
            );
            const setup = assertAuxiliaryInstructions(build);
            // Setup is never placed in the burn transaction. If Jupiter still
            // reports idempotent ATA setup, its target must already exist.
            for (const instruction of setup) {
              const ata = instruction.accounts[1];
              if (
                !ata ||
                !(await chain.getRawAccount(new PublicKey(ata.pubkey)))
              ) {
                reject(
                  "SETUP_REQUIRED",
                  "caller-funded ATA setup must land in a separate transaction before requesting a burn"
                );
              }
            }
            const quotedOut = BigInt(build.outAmount);
            const threshold = BigInt(build.otherAmountThreshold);
            if (quotedOut <= 0n || threshold <= 0n || threshold > quotedOut) {
              reject(
                "INVALID_OUTPUT_FLOOR",
                "Jupiter returned an invalid output threshold"
              );
            }
            // KEYLESS REFERENCE SANITY (RT4, red-team 2026-08-28): the bound
            // reference must price this leg within a sane factor of the live
            // market. A reference whose floor sits far BELOW Jupiter's quote
            // is hostile or decayed — e.g. a dust-token pool the attacker
            // owns: gross SOL depth passes 6039/6040/6041 while the floor
            // collapses to atoms, and a caller who patches Jupiter's
            // quoted_out_amount (which the program deliberately does not pin)
            // then extracts ~all of the leg while every postcondition holds.
            // The program cannot see this on chain; this check is the
            // service-side control. Factor 2 is generous: honest references
            // sit within ~KEYLESS_TOL_BPS + venue fee of the market quote,
            // orders of magnitude above the dust case. Liveness-only cost:
            // an honestly-drifted reference re-quotes like any 6021.
            if (quotedOut / 2n > leg.programFloor) {
              reject(
                "REFERENCE_DOES_NOT_PRICE_MARKET",
                `the bound reference prices this leg at ${leg.programFloor} ` +
                  `atoms but the live market quote is ${quotedOut}; the ` +
                  `reference cannot protect this burn — re-select a real ` +
                  `pool for this target`
              );
            }
            const slippageBps = Number(build.slippageBps);
            if (
              !Number.isInteger(slippageBps) ||
              slippageBps < 0 ||
              slippageBps > policy.maxSlippageBps
            ) {
              reject(
                "SLIPPAGE_POLICY",
                `Jupiter slippage ${build.slippageBps} exceeds policy`
              );
            }
            if (
              threshold * BigInt(BPS_TOTAL) <
              quotedOut * BigInt(BPS_TOTAL - policy.maxSlippageBps)
            ) {
              reject(
                "SLIPPAGE_POLICY",
                "Jupiter threshold is looser than service policy"
              );
            }
            const priceImpact = Number(build.priceImpactPct ?? "0");
            const priceImpactBps = priceImpact * BPS_TOTAL;
            if (
              !Number.isFinite(priceImpact) ||
              priceImpact < 0 ||
              priceImpactBps > policy.maxPriceImpactBps
            ) {
              reject(
                "PRICE_IMPACT_POLICY",
                `Jupiter price impact ${priceImpactBps}bps exceeds policy`
              );
            }
            if (this.dependencies.floorPolicy) {
              const independentFloor =
                await this.dependencies.floorPolicy.requiredMinimumOutput(
                  leg.amountIn,
                  leg.targetMint
                );
              if (threshold < independentFloor) {
                reject(
                  "INDEPENDENT_FLOOR",
                  `Jupiter threshold ${threshold} is below independent floor ${independentFloor}`
                );
              }
            }
            const lookupTables = await this.timed(
              request.requestId,
              "lookup-table-resolution",
              {
                source: "jupiter",
                pipelineAttempt: String(attempt + 1),
                fittingRung: String(capIndex + 1),
                leg: String(legIndex),
              },
              () =>
                resolveAndValidateLookupTables(
                  chain,
                  build.addressesByLookupTableAddress ?? {},
                  [],
                  policy.approvedLookupTables
                )
            );
            return {
              targetMint: leg.targetMint,
              targetTokenProgram: leg.tokenProgram,
              targetAta: leg.ata,
              bps: leg.bps,
              amountIn: leg.amountIn,
              // The program refuses any minimum below its own reference
              // floor (6021), so the encoded minimum is at least that floor;
              // Jupiter's threshold tightens it further when it is higher.
              minimumOutput:
                leg.programFloor > threshold ? leg.programFloor : threshold,
              reference: leg.reference,
              routeAccounts: build.swapInstruction.accounts,
              routeData,
              lookupTables,
            } satisfies PreparedLeg;
          })
        );
        const lookupTables = [
          ...new Map(
            [
              ...legs.flatMap((leg) => leg.lookupTables),
              ...requestedTables,
            ].map((table) => [table.key.toBase58(), table])
          ).values(),
        ];
        const burn = buildBurnInstruction(
          this.burnerProgram,
          feePayer,
          launchMint,
          pda,
          wsolAta,
          amount,
          legs
        );
        const validity = await chain.getLatestBlockhash();
        const compute = ComputeBudgetProgram.setComputeUnitLimit({
          units: policy.computeUnitLimit,
        });
        const message = new TransactionMessage({
          payerKey: feePayer,
          recentBlockhash: validity.blockhash,
          // These are the only permitted top-level instructions. Setup and
          // private-submission metadata never enter this transaction.
          instructions: [compute, burn],
        }).compileToV0Message(lookupTables);
        const transaction = new VersionedTransaction(message);
        let bytes: number;
        try {
          bytes = transaction.serialize().length;
        } catch {
          bytes = MAX_TRANSACTION_BYTES + 1;
        }
        const locks =
          message.staticAccountKeys.length +
          message.addressTableLookups.reduce(
            (sum, lookup) =>
              sum +
              lookup.writableIndexes.length +
              lookup.readonlyIndexes.length,
            0
          );
        if (bytes <= MAX_TRANSACTION_BYTES && locks <= MAX_ACCOUNT_LOCKS) {
          // Reparse the compiled message as a final defense against accidental
          // top-level instruction expansion.
          const decompiled = TransactionMessage.decompile(message, {
            addressLookupTableAccounts: lookupTables,
          });
          if (
            decompiled.instructions.length !== 2 ||
            !decompiled.instructions[0].programId.equals(
              ComputeBudgetProgram.programId
            ) ||
            !decompiled.instructions[1].programId.equals(this.burnerProgram) ||
            !decompiled.instructions[0].data.equals(compute.data) ||
            !decompiled.instructions[1].data.equals(burn.data)
          ) {
            reject(
              "TOP_LEVEL_INSTRUCTION_POLICY",
              "compiled transaction is not compute-budget + burner"
            );
          }
          // KEYLESS: the fee payer is the ONLY required signer. Nothing
          // else may demand a signature — the reserved slot is a non-signer
          // and the burn PDA signs only inside the program's own CPIs.
          const requiredSigners = message.staticAccountKeys.slice(
            0,
            message.header.numRequiredSignatures
          );
          if (
            requiredSigners.length !== 1 ||
            !requiredSigners[0].equals(feePayer)
          ) {
            reject(
              "SIGNER_LAYOUT",
              "full message requires a signer other than the fee payer"
            );
          }
          final = {
            transaction,
            lookupTables,
            legs,
            bytes,
            locks,
            capIndex,
            validity,
          };
          break;
        }
        // FAIL FAST — one Jupiter call, not six — but only for 3+ legs. The
        // widest possible route (cap === undefined) just failed to fit, and
        // no lookup table covers the vault's own accounts. Narrowing
        // `maxAccounts` on later rungs only trims Jupiter ROUTE accounts; it
        // cannot shrink the fixed 8 + 7·legs vault-side keys inlined here —
        // and at 3 legs those alone push the widest-margin transaction to
        // 1233 bytes (measured 2026-08-26), so no rung can fit and walking
        // the ladder would waste five Jupiter calls proving it.
        //
        // TWO legs are different, and this was measured rather than assumed
        // (scripts/measure-2leg-size.ts, 2026-08-27, 18 uncapped walks
        // across six venue pairs): the 22 vault-side keys leave real but
        // UNRELIABLE headroom. Uncapped routes fit only 7/18 times; a
        // narrower rung (40/32/26) fit in every one of the other walks, with
        // margins as thin as 1230/1232 bytes. So a 2-leg no-ALT burn must
        // WALK the ladder — failing fast here would refuse burns a fitting
        // cap serves — and callers should still create the per-vault table
        // for the margin, not the possibility.
        if (cap === undefined && admitted.length >= 3 && !vaultAltCovers) {
          reject(
            "TRANSACTION_TOO_LARGE",
            `this ${admitted.length}-leg vault has no address lookup table ` +
              `covering its own accounts, so the burn cannot fit in one ` +
              `Solana transaction (measured ${bytes} bytes, limit ` +
              `${MAX_TRANSACTION_BYTES}). Every vault account is inlined ` +
              `(${8 + admitted.length * 7} vault-side keys before any Jupiter ` +
              `route account); narrowing the route cannot shrink them, so no ` +
              `fitting cap can help and the amount is irrelevant. The vault's ` +
              `setup must create a per-vault lookup table (the creator pays ` +
              `its rent, ~0.0024-0.0037 SOL, and it stays deactivatable and ` +
              `reclaimable), then pass it as lookupTableAddresses. Missing ` +
              `from the provided table(s): ` +
              missingFromAlt.map(([, label]) => label).join(", ") +
              `.`
          );
        }
      }
      if (!final)
        reject(
          "TRANSACTION_TOO_LARGE",
          `no Jupiter route for this ${admitted.length}-leg burn fits ` +
            `Solana's 1232-byte limit, even narrowed to ${
              policy.fittingMaxAccounts[policy.fittingMaxAccounts.length - 1]
            } accounts per leg` +
            (requestedTables.length === 0
              ? ` and with NO lookup table provided (the dominant cause — a ` +
                `multi-leg burn needs a per-vault table covering its own ` +
                `accounts; setup must create one)`
              : ` even with the provided lookup table(s); the route itself ` +
                `is too wide — try fewer legs, a smaller set of venues, or a ` +
                `different target`) +
            `.`
        );

      simulation = await this.timed(
        request.requestId,
        "simulation",
        {
          pipelineAttempt: String(attempt + 1),
          fittingRung: String(final.capIndex + 1),
          transactionBytes: String(final.bytes),
          accountLocks: String(final.locks),
        },
        () => chain.simulate(final!.transaction)
      );
      const overComputeLimit =
        !simulation.error &&
        simulation.unitsConsumed !== undefined &&
        simulation.unitsConsumed > policy.computeUnitLimit;
      if (!simulation.error && !overComputeLimit) break;

      const attribution: SimulationFailureAttribution = simulation.error
        ? classifySimulationFailure(
            simulation.error,
            simulation.logs,
            this.burnerProgram
          )
        : { kind: "compute" };
      const detail = `exact unsigned message simulation failed: ${JSON.stringify(
        simulation.error ?? "compute-unit limit exceeded"
      )}; logs=${(simulation.logs ?? []).slice(-8).join(" | ")}`;
      this.dependencies.onEvent?.({
        event: "simulation-failed",
        requestId: request.requestId,
        vault: pda.toBase58(),
        attempt: String(attempt),
        kind: attribution.kind,
        code: attribution.code === undefined ? "" : String(attribution.code),
        programId: attribution.programId ?? "",
      });
      if (attribution.kind === "burner") {
        if (
          attribution.code === 6018 &&
          !cashbackRetryUsed &&
          attempt < retryLimit
        ) {
          // 6018 WsolNotFullyConsumed has exactly one known benign trigger:
          // Jupiter's PumpSwap cashback claim paying WSOL back into the
          // vault's own WSOL ATA, which the exact on-chain conservation check
          // correctly reverts. Re-quote with the Pump venues excluded for the
          // legs whose route touched them. The on-chain check is untouched.
          cashbackRetryUsed = true;
          const offending = pumpVenueLegIndexes(final.legs);
          for (const index of offending.length
            ? offending
            : final.legs.map((_, legIndex) => legIndex)) {
            pumpExcludedLegs.add(index);
          }
          continue;
        }
        if (attribution.code === 6021 && attempt < retryLimit) {
          // KEYLESS 6021 (SlippageExceeded) is the SECOND retryable burner
          // code, and the only other one: the program's floor is priced off
          // the leg's BOUND REFERENCE pool, but the fill comes from whatever
          // route Jupiter chose for THIS quote. When that route is worse
          // than reference-minus-tolerance the program correctly refuses —
          // and a FRESH quote can land on a route that clears the same
          // floor (observed 2026-08-26: an identical request refused 6021
          // then landed unchanged on re-quote; the fork harness's RETRYABLE
          // set was {6021, 6018} for the same reason). The on-chain floor
          // is untouched; only the quote is refreshed, bounded by the same
          // retry budget. Every OTHER burner code stays deterministic.
          continue;
        }
        reject(
          "SIMULATION_FAILED",
          `burner-attributed code ${
            attribution.code ?? "unknown"
          } is deterministic and is not retried${
            attribution.code === 6021
              ? " further (6021 is reference-floor vs route divergence; fresh quotes were already retried within budget and each still fell below the program's floor)"
              : ""
          }: ${detail}`
        );
      }
      if (attribution.kind === "compute") {
        // Compute exhaustion is route variance, not configuration, and
        // narrowing the route is also a compute lever: retry with a FRESH
        // quote starting at the next narrower service fitting cap.
        if (attempt < retryLimit && final.capIndex + 1 < caps.length) {
          capStartIndex = final.capIndex + 1;
          continue;
        }
        reject(
          "COMPUTE_LIMIT",
          `route exhausts the compute budget and no narrower fitting cap remains: ${detail}`
        );
      }
      if (attempt < retryLimit) continue;
      // NOT a burner refusal: the innermost failing frame is another
      // program (or authorship is unknown, which must never be presented as
      // ours). This is route weather — a fresh quote is exactly the fix —
      // so it carries its own code, distinct from the deterministic
      // burner-attributed SIMULATION_FAILED above, and callers should retry.
      reject(
        "EXTERNAL_SIMULATION_FAILURE",
        `${describeSimulationAttribution(attribution)}: ${detail}`
      );
    }
    if (!final) {
      reject("TRANSACTION_TOO_LARGE", "no fitting candidate was prepared");
    }
    const height = await chain.getBlockHeight();
    if (
      final.validity.lastValidBlockHeight - height <
      policy.minRemainingBlockHeights
    ) {
      reject(
        "BLOCKHASH_TOO_OLD",
        "too little blockhash lifetime remains after simulation"
      );
    }

    const messageBytes = final.transaction.message.serialize();
    const digest = createHash("sha256").update(messageBytes).digest("hex");
    return {
      transaction: final.transaction,
      legs: final.legs,
      bytes: final.bytes,
      locks: final.locks,
      validity: final.validity,
      simulatedUnits: simulation.unitsConsumed,
      digest,
    };
  }
}

type ResolvedRequest = Readonly<{
  request: BurnRequest;
  launchMint: PublicKey;
  amount: bigint;
  requestedLegs: readonly {
    targetMint: PublicKey;
    bps: number;
    reference: ResolvedReference;
  }[];
  pda: PublicKey;
}>;

type BuiltBurn = Readonly<{
  transaction: VersionedTransaction;
  legs: readonly PreparedLeg[];
  bytes: number;
  locks: number;
  validity: {
    blockhash: string;
    lastValidBlockHeight: number;
    contextSlot: number;
  };
  simulatedUnits?: number;
  digest: string;
}>;

/**
 * Gate for the stateless signed-submission endpoint. Under keyless the
 * service signs nothing, so a submit endpoint is a plain relay — but it is
 * OUR relay, so it refuses to carry anything that is not a fully
 * caller-signed burner transaction: exactly [ComputeBudget, burner], one
 * required signer, and a signature that verifies over these exact bytes.
 */
export function assertSubmittableSignedTransaction(
  wire: Buffer,
  burnerProgram: PublicKey
): Readonly<{
  transaction: VersionedTransaction;
  feePayer: PublicKey;
  messageSha256: string;
}> {
  if (wire.length > MAX_TRANSACTION_BYTES) {
    reject("TRANSACTION_TOO_LARGE", "signed transaction exceeds 1232 bytes");
  }
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(wire);
  } catch {
    reject("INVALID_TRANSACTION", "bytes are not a versioned transaction");
  }
  const message = transaction.message;
  const instructions = message.compiledInstructions;
  // Program ids are always static message keys, so lookup tables cannot hide
  // an instruction's target program from this check.
  if (
    instructions.length !== 2 ||
    !message.staticAccountKeys[instructions[0].programIdIndex]?.equals(
      ComputeBudgetProgram.programId
    ) ||
    !message.staticAccountKeys[instructions[1].programIdIndex]?.equals(
      burnerProgram
    )
  ) {
    reject(
      "INVALID_TRANSACTION",
      "transaction is not exactly ComputeBudget + burner"
    );
  }
  if (
    message.header.numRequiredSignatures !== 1 ||
    transaction.signatures.length !== 1
  ) {
    reject(
      "INVALID_TRANSACTION",
      "a keyless burn requires exactly the fee payer's signature"
    );
  }
  const feePayer = message.staticAccountKeys[0];
  const serialized = message.serialize();
  if (!verifyEd25519(feePayer, serialized, transaction.signatures[0])) {
    reject(
      "INVALID_CALLER_SIGNATURE",
      "fee-payer signature does not verify against the transaction"
    );
  }
  return {
    transaction,
    feePayer,
    messageSha256: createHash("sha256").update(serialized).digest("hex"),
  };
}
