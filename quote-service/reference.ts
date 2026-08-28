/**
 * KEYLESS reference resolution and price-floor mirror.
 *
 * The keyless program prices every leg off a REFERENCE pool that is bound
 * into the vault address at setup (`build_split_seeds` in
 * programs/burner/src/split.rs: one 32-byte seed per leg after the bps_blob;
 * Pump-venue references bind as the zero sentinel because their identity is
 * derived in-program). At burn time each leg carries a 7-account block
 * (`ACCOUNTS_PER_TARGET = 7`): target mint, target ATA, token program,
 * reference pool, both pool vaults, and the fee source. The program computes
 * a floor from the reference (`keyless_leg_floor` in swap_and_burn.rs) and
 * REFUSES any `minimum_output` below it (6021), so a builder must compute the
 * SAME floor from the SAME state or every burn it builds is refused.
 *
 * This module is a port of the proven mirror
 * `prototypes/switchboard-stateless-surfpool/resolver8.mjs` (44/44 keyless
 * burns on a fork, 2026-08-26) onto the service's ChainGateway. Same venue
 * offsets, same real per-pool fee reads, same math, same
 * `KEYLESS_TOL_BPS = 100`. Any divergence from `keyless_leg_floor` produces
 * deterministic 6021 refusals, so keep the three in lockstep:
 * swap_and_burn.rs (authoritative), resolver8.mjs (fork harness), this file.
 */
import { PublicKey } from "@solana/web3.js";
import { PolicyError } from "./core";

/** The one raw read this module needs; implemented by ChainGateway.
 * `lamports` is optional for backward compatibility; readers that supply it
 * let the direct-curve builder verify rent pre-funding. */
export interface AccountDataReader {
  getAccountData(
    address: PublicKey
  ): Promise<{ owner: PublicKey; data: Buffer; lamports?: bigint } | null>;
}

export const WSOL_ADDRESS = "So11111111111111111111111111111111111111112";
export const PUMP_FUN_ADDRESS = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP_ADDRESS = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
/** KEYLESS_TOL_BPS — must equal the program constant. */
export const REFERENCE_TOLERANCE_BPS = 100n;
/**
 * MIN_REFERENCE_DEPTH_LAMPORTS — must equal the program constant
 * (swap_and_burn.rs). Enforced on address-bound references only (Raydium
 * v4 / CP / CLMM, Meteora DLMM); the Pump venues (bonding curve, canonical
 * PumpSwap pool) are exempt exactly as they are in `keyless_leg_floor`,
 * because the flagship own-launch leg is intrinsically thin when fresh.
 * A reference below this floor is refused 6041 by EVERY burn, so the
 * resolver refuses it up front instead of building a doomed transaction.
 */
export const MIN_REFERENCE_DEPTH_LAMPORTS = 50_000_000_000n;
export const ZERO_REFERENCE_SEED: Buffer = Buffer.alloc(32);

type VenueSpec = Readonly<{
  name: string;
  kind: "cp" | "clmm" | "dlmm";
  va: number;
  vb: number;
  m0?: number;
  m1?: number;
  sq?: number;
  aid?: number;
  bs?: number;
  extraQuote?: number;
}>;

/** Venue table: byte offsets only; fees are read live per pool. */
const VENUES: Readonly<Record<string, VenueSpec>> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    name: "Raydium v4",
    kind: "cp",
    va: 336,
    vb: 368,
  },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: {
    name: "Raydium CP",
    kind: "cp",
    va: 72,
    vb: 104,
  },
  [PUMP_SWAP_ADDRESS]: {
    name: "PumpSwap",
    kind: "cp",
    va: 139,
    vb: 171,
    extraQuote: 245,
  },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: {
    name: "Raydium CLMM",
    kind: "clmm",
    va: 137,
    vb: 169,
    m0: 73,
    m1: 105,
    sq: 253,
  },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: {
    name: "Meteora DLMM",
    kind: "dlmm",
    va: 152,
    vb: 184,
    m0: 88,
    m1: 120,
    aid: 76,
    bs: 80,
  },
};

type FeeRatio = Readonly<{ num: bigint; den: bigint; pump: boolean }>;

const PUMP_FEE_FALLBACK: FeeRatio = { num: 1n, den: 10_000n, pump: true };
const PUMP_FEE_PLAUSIBLE_MAX = 1_000n;
const ONE_Q64 = 1n << 64n;

const readPk = (data: Buffer, offset: number) =>
  new PublicKey(data.subarray(offset, offset + 32));
const u64 = (data: Buffer, offset: number) => data.readBigUInt64LE(offset);
const u128 = (data: Buffer, offset: number) =>
  data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);

/** (1 + binStep/10000)^activeId in Q64.64, exactly as the program computes. */
function dlmmPriceQ64(binStep: number, activeId: number): bigint {
  let base = (ONE_Q64 * (10_000n + BigInt(binStep))) / 10_000n;
  let exponent = BigInt(Math.abs(activeId));
  let result = ONE_Q64;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) >> 64n;
    exponent >>= 1n;
    if (exponent > 0n) base = (base * base) >> 64n;
  }
  return activeId < 0 ? (ONE_Q64 * ONE_Q64) / result : result;
}

function feeCap(depth: bigint, fee: FeeRatio): bigint {
  return (depth * fee.num) / fee.den;
}

function inputAfterFee(amount: bigint, fee: FeeRatio): bigint {
  const den = fee.pump ? fee.den + fee.num : fee.den;
  const num = fee.pump ? fee.den : fee.den - fee.num;
  let net = (amount * num) / den;
  if (fee.pump) net -= 1n; // Pump reserves one atom for its rounding correction
  return net;
}

/** Human SOL rendering for refusal messages (9 decimals trimmed). */
function sol(lamports: bigint): string {
  const sign = lamports < 0n ? "-" : "";
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

function reject(code: string, message: string): never {
  throw new PolicyError(code, message);
}

/**
 * Tiered Pump fee_config parse, mirroring the program's
 * `parse_pump_fee_config`: flat lp/protocol/creator fees at 41/49/57, tiers
 * of 40 bytes from 69 (u128 market-cap threshold + 3 u64 fees), last tier at
 * or below the market cap wins; anything unparseable or implausible falls
 * back to the program's conservative 1 bps.
 */
async function pumpFeeConfig(
  reader: AccountDataReader,
  venueProgram: string,
  marketCap: bigint,
  includeLp: boolean,
  includeCreator: boolean
): Promise<{ fee: FeeRatio; feeSource: PublicKey }> {
  const [feeSource] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), new PublicKey(venueProgram).toBuffer()],
    new PublicKey(PUMP_FEE_PROGRAM)
  );
  const account = await reader.getAccountData(feeSource);
  if (!account || account.owner.toBase58() !== PUMP_FEE_PROGRAM) {
    return { fee: PUMP_FEE_FALLBACK, feeSource };
  }
  const data = account.data;
  try {
    if (data.length < 69) return { fee: PUMP_FEE_FALLBACK, feeSource };
    const count = data.readUInt32LE(65);
    if (data.length < 69 + count * 40) {
      return { fee: PUMP_FEE_FALLBACK, feeSource };
    }
    let lp = u64(data, 41);
    let protocol = u64(data, 49);
    let creator = u64(data, 57);
    for (let index = 0; index < count; index += 1) {
      const at = 69 + 40 * index;
      if (u128(data, at) > marketCap) break;
      lp = u64(data, at + 16);
      protocol = u64(data, at + 24);
      creator = u64(data, at + 32);
    }
    const total =
      (includeLp ? lp : 0n) + protocol + (includeCreator ? creator : 0n);
    if (total >= 1n && total <= PUMP_FEE_PLAUSIBLE_MAX) {
      return { fee: { num: total, den: 10_000n, pump: true }, feeSource };
    }
  } catch {
    /* fall through to the conservative fallback */
  }
  return { fee: PUMP_FEE_FALLBACK, feeSource };
}

export type ResolvedReference = Readonly<{
  /** The reference account the burn carries at leg offset +3. */
  pool: PublicKey;
  /** Leg offsets +4 and +5: the pool's vaults (the curve itself for Pump). */
  vaultA: PublicKey;
  vaultB: PublicKey;
  /** Leg offset +6: the explicit authenticated fee source. */
  feeSource: PublicKey;
  /**
   * The 32-byte seed this leg contributes to the vault derivation: the zero
   * sentinel for Pump-venue references, the pool address otherwise
   * (`build_split_seeds`).
   */
  seed: Buffer;
  venue: string;
  /**
   * The SOL-side depth the program prices and gates from: the WSOL vault
   * balance (plus the virtual quote for PumpSwap; the virtual SOL reserve
   * for a bonding curve). The 6041 gate compares THIS number to 50 SOL on
   * address-bound venues.
   */
  depthLamports: bigint;
  /** The live pool fee, in basis points (display only; math uses num/den). */
  feeBps: number;
  /** Lamport input above this is refused by the program (6040). */
  capLamports: bigint;
  /**
   * The exact floor the program will compute for this input from the state
   * read here. Throws REFERENCE_CAP_EXCEEDED / REFERENCE_FLOOR_ZERO where
   * the program would refuse 6040 / 6002.
   */
  floorFor(amountIn: bigint): bigint;
}>;

function makeFloor(
  kind: "cp" | "clmm" | "dlmm" | "curve",
  fee: FeeRatio,
  state: Readonly<{
    reserveToken: bigint;
    reserveSol: bigint;
    sq?: bigint;
    solIs0?: boolean;
    binStep?: number;
    activeId?: number;
    solIsX?: boolean;
  }>,
  depthGated = false
): { cap: bigint; floorFor: (amountIn: bigint) => bigint } {
  const cap = feeCap(state.reserveSol, fee);
  const floorFor = (amountIn: bigint): bigint => {
    if (amountIn > cap) {
      // Actionable, in SOL, with the why and the what-next: the program's
      // refusal is a FEATURE (a burn much larger than its reference pool
      // moves the price against itself and is exactly the size worth
      // sandwiching), and a vault holding more than the cap is normal — it
      // burns over several transactions.
      reject(
        "REFERENCE_CAP_EXCEEDED",
        `this leg can burn at most ${sol(cap)} SOL per transaction; you ` +
          `asked ${sol(amountIn)} SOL. Burn less and repeat. (6040, the ` +
          `reference depth cap: a burn much larger than its pool is worth ` +
          `front-running, so the program refuses it.)`
      );
    }
    // The program's 6041 depth-admission gate, mirrored in the program's own
    // ORDER: the cap refusal above wins for an over-cap input even on a
    // shallow pool; an in-cap input on an address-bound reference below the
    // 50 SOL floor is ReferenceTooShallow on EVERY burn. Pump venues
    // (curve, PumpSwap) are exempt, exactly as in `keyless_leg_floor`.
    if (depthGated && state.reserveSol < MIN_REFERENCE_DEPTH_LAMPORTS) {
      reject(
        "REFERENCE_TOO_SHALLOW",
        `the bound reference pool holds ${sol(state.reserveSol)} SOL, ` +
          `under the program's ${sol(
            MIN_REFERENCE_DEPTH_LAMPORTS
          )} SOL floor (6041). Burns pause until depth returns; the vault's ` +
          `SOL is safe. Nothing to fix — retry when liquidity is back.`
      );
    }
    const net = inputAfterFee(amountIn, fee);
    if (net <= 0n) {
      reject(
        "REFERENCE_FLOOR_ZERO",
        "leg input nets to zero after the reference fee; the program refuses this"
      );
    }
    let expected: bigint;
    if (kind === "clmm") {
      const sq = state.sq!;
      expected = state.solIs0
        ? (((net * sq) >> 64n) * sq) >> 64n
        : (((net << 64n) / sq) << 64n) / sq;
    } else if (kind === "dlmm") {
      const price = dlmmPriceQ64(state.binStep!, state.activeId!);
      expected = state.solIsX ? (net * price) >> 64n : (net << 64n) / price;
    } else {
      expected = (state.reserveToken * net) / (state.reserveSol + net);
    }
    const floor = (expected * (10_000n - REFERENCE_TOLERANCE_BPS)) / 10_000n;
    if (expected === 0n || floor === 0n) {
      reject(
        "REFERENCE_FLOOR_ZERO",
        "reference floor computes to zero; the program refuses this (6002)"
      );
    }
    return floor;
  };
  return { cap, floorFor };
}

/** Pump bonding curve: DERIVED from the mint, never discovered. */
async function resolveCurve(
  reader: AccountDataReader,
  targetMint: PublicKey
): Promise<ResolvedReference> {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), targetMint.toBuffer()],
    new PublicKey(PUMP_FUN_ADDRESS)
  );
  const account = await reader.getAccountData(curve);
  if (
    !account ||
    account.owner.toBase58() !== PUMP_FUN_ADDRESS ||
    account.data.length < 82
  ) {
    reject(
      "REFERENCE_INVALID",
      `no live Pump bonding curve for ${targetMint.toBase58()}; pass the leg's bound reference pool explicitly`
    );
  }
  const data = account.data;
  if (data[48] === 1) {
    reject(
      "REFERENCE_INVALID",
      `Pump curve for ${targetMint.toBase58()} has graduated; the program rejects a graduated curve reference — pass the canonical PumpSwap pool instead`
    );
  }
  const reserveToken = u64(data, 8);
  const reserveSol = u64(data, 16);
  if (reserveToken === 0n || reserveSol === 0n) {
    reject("REFERENCE_INVALID", "Pump curve reserves are zero");
  }
  const mintAccount = await reader.getAccountData(targetMint);
  if (!mintAccount || mintAccount.data.length < 44) {
    reject("REFERENCE_INVALID", "target mint is unreadable");
  }
  // Normal curves use Pump's fixed one-billion supply for the market cap;
  // mayhem curves use the actual mint supply (byte 81).
  const supplyForCap =
    data[81] === 0 ? 1_000_000_000_000_000n : u64(mintAccount.data, 36);
  const marketCap = (reserveSol * supplyForCap) / reserveToken;
  const creatorNonDefault = !data.subarray(49, 81).equals(Buffer.alloc(32));
  const { fee, feeSource } = await pumpFeeConfig(
    reader,
    PUMP_FUN_ADDRESS,
    marketCap,
    false,
    creatorNonDefault
  );
  const { cap, floorFor } = makeFloor("curve", fee, {
    reserveToken,
    reserveSol,
  });
  return {
    pool: curve,
    vaultA: curve,
    vaultB: curve,
    feeSource,
    seed: ZERO_REFERENCE_SEED,
    venue: "Pump curve",
    depthLamports: reserveSol,
    feeBps: feeToBps(fee),
    capLamports: cap,
    floorFor,
  };
}

function feeToBps(fee: FeeRatio): number {
  return Number((fee.num * 1_000_000n) / fee.den) / 100;
}

async function resolvePool(
  reader: AccountDataReader,
  targetMint: PublicKey,
  pool: PublicKey
): Promise<ResolvedReference> {
  const account = await reader.getAccountData(pool);
  if (!account) {
    reject("REFERENCE_INVALID", `reference ${pool.toBase58()} does not exist`);
  }
  const owner = account.owner.toBase58();
  const venue = VENUES[owner];
  if (!venue) {
    reject(
      "REFERENCE_INVALID",
      `reference ${pool.toBase58()} is owned by unsupported program ${owner}`
    );
  }
  const data = account.data;
  if (data.length < Math.max(venue.va, venue.vb) + 32) {
    reject("REFERENCE_INVALID", "reference pool data is too short");
  }
  const vaultAddressA = readPk(data, venue.va);
  const vaultAddressB = readPk(data, venue.vb);
  const [vaultInfoA, vaultInfoB] = await Promise.all([
    reader.getAccountData(vaultAddressA),
    reader.getAccountData(vaultAddressB),
  ]);
  if (!vaultInfoA || !vaultInfoB) {
    reject("REFERENCE_INVALID", "reference pool vault accounts are missing");
  }
  const vaults = [
    { key: vaultAddressA, info: vaultInfoA },
    { key: vaultAddressB, info: vaultInfoB },
  ].map(({ key, info }) => ({
    key,
    owner: info.owner.toBase58(),
    mint: readPk(info.data, 0).toBase58(),
    authority: info.data.subarray(32, 64).toString("hex"),
    amount: u64(info.data, 64),
  }));
  if (!vaults.every((vault) => TOKEN_PROGRAMS.includes(vault.owner))) {
    reject("REFERENCE_INVALID", "reference pool vaults are not token accounts");
  }
  const tokenVault = vaults.find(
    (vault) => vault.mint === targetMint.toBase58()
  );
  const solVault = vaults.find((vault) => vault.mint === WSOL_ADDRESS);
  if (
    !tokenVault ||
    !solVault ||
    tokenVault.amount === 0n ||
    solVault.amount === 0n
  ) {
    reject(
      "REFERENCE_INVALID",
      `reference ${pool.toBase58()} is not a live ${targetMint.toBase58()}/WSOL pool`
    );
  }
  if (venue.kind === "cp" && tokenVault.authority !== solVault.authority) {
    reject("REFERENCE_INVALID", "reference pool vault authorities differ");
  }
  let depth = solVault.amount;

  let fee: FeeRatio;
  let feeSource: PublicKey;
  if (venue.name === "Raydium v4") {
    if (data.length < 160) reject("REFERENCE_INVALID", "short v4 pool");
    fee = { num: u64(data, 144), den: u64(data, 152), pump: false };
    feeSource = pool;
  } else if (venue.name === "Raydium CP") {
    feeSource = readPk(data, 8);
    const config = await reader.getAccountData(feeSource);
    if (
      !config ||
      config.owner.toBase58() !== owner ||
      config.data.length < 20
    ) {
      reject("REFERENCE_INVALID", "Raydium CP amm_config unreadable");
    }
    fee = { num: u64(config.data, 12), den: 1_000_000n, pump: false };
  } else if (venue.name === "Raydium CLMM") {
    feeSource = readPk(data, 9);
    const config = await reader.getAccountData(feeSource);
    if (
      !config ||
      config.owner.toBase58() !== owner ||
      config.data.length < 51
    ) {
      reject("REFERENCE_INVALID", "Raydium CLMM amm_config unreadable");
    }
    // AmmConfig discriminator, exactly as the program checks.
    if (
      !config.data
        .subarray(0, 8)
        .equals(Buffer.from([218, 244, 33, 104, 203, 203, 43, 111]))
    ) {
      reject("REFERENCE_INVALID", "Raydium CLMM amm_config discriminator");
    }
    fee = {
      num: BigInt(config.data.readUInt32LE(47)),
      den: 1_000_000n,
      pump: false,
    };
  } else if (venue.name === "Meteora DLMM") {
    if (data.length < 35) reject("REFERENCE_INVALID", "short DLMM pool");
    const baseFactor = BigInt(data.readUInt16LE(8));
    const power = data[34];
    const binStep = BigInt(data.readUInt16LE(venue.bs!));
    fee = {
      num: baseFactor * binStep * 10n * 10n ** BigInt(power),
      den: 1_000_000_000n,
      pump: false,
    };
    feeSource = pool;
  } else if (venue.name === "PumpSwap") {
    // Virtual quote joins the depth; market cap prices the fee tier.
    if (data.length < 261) reject("REFERENCE_INVALID", "short PumpSwap pool");
    const virtualQuote = u128(data, venue.extraQuote!);
    if (virtualQuote >= 1n << 127n) {
      reject("REFERENCE_INVALID", "PumpSwap virtual quote is negative");
    }
    depth += virtualQuote;
    const mintAccount = await reader.getAccountData(targetMint);
    if (!mintAccount || mintAccount.data.length < 44) {
      reject("REFERENCE_INVALID", "target mint is unreadable");
    }
    const supply = u64(mintAccount.data, 36);
    const marketCap = (depth * supply) / tokenVault.amount;
    const creatorNonDefault = !data.subarray(211, 243).equals(Buffer.alloc(32));
    ({ fee, feeSource } = await pumpFeeConfig(
      reader,
      PUMP_SWAP_ADDRESS,
      marketCap,
      true,
      creatorNonDefault
    ));
  } else {
    reject("REFERENCE_INVALID", `unhandled venue ${venue.name}`);
  }
  if (fee.num === 0n || fee.den === 0n || fee.num >= fee.den) {
    reject("REFERENCE_INVALID", "reference fee is implausible");
  }

  const state: {
    reserveToken: bigint;
    reserveSol: bigint;
    sq?: bigint;
    solIs0?: boolean;
    binStep?: number;
    activeId?: number;
    solIsX?: boolean;
  } = { reserveToken: tokenVault.amount, reserveSol: depth };
  if (venue.kind === "clmm") {
    if (data.length < venue.sq! + 16) {
      reject("REFERENCE_INVALID", "short CLMM pool");
    }
    state.sq = u128(data, venue.sq!);
    if (state.sq === 0n) reject("REFERENCE_INVALID", "CLMM sqrt price is zero");
    state.solIs0 = readPk(data, venue.m0!).toBase58() === WSOL_ADDRESS;
  }
  if (venue.kind === "dlmm") {
    state.activeId = data.readInt32LE(venue.aid!);
    state.binStep = data.readUInt16LE(venue.bs!);
    if (state.binStep === 0) reject("REFERENCE_INVALID", "DLMM bin step zero");
    state.solIsX = readPk(data, venue.m0!).toBase58() === WSOL_ADDRESS;
  }
  const pumpVenue = owner === PUMP_SWAP_ADDRESS;
  const { cap, floorFor } = makeFloor(venue.kind, fee, state, !pumpVenue);
  return {
    pool,
    vaultA: tokenVault.key,
    vaultB: solVault.key,
    feeSource,
    seed: pumpVenue ? ZERO_REFERENCE_SEED : pool.toBuffer(),
    venue: venue.name,
    depthLamports: depth,
    feeBps: feeToBps(fee),
    capLamports: cap,
    floorFor,
  };
}

/**
 * The canonical PumpSwap pool for a graduated Pump coin:
 * `PDA(["pool", u16(0), pool_authority, mint, WSOL], PumpSwap)` where
 * `pool_authority = PDA(["pool-authority", mint], Pump.fun)`. The program
 * pins the pool's stored `creator` to that same authority PDA
 * (`keyless_leg_floor`), so no other PumpSwap pool can take this role.
 */
export function canonicalPumpSwapPool(targetMint: PublicKey): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), targetMint.toBuffer()],
    new PublicKey(PUMP_FUN_ADDRESS)
  );
  const [pool] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      Buffer.alloc(2),
      authority.toBuffer(),
      targetMint.toBuffer(),
      new PublicKey(WSOL_ADDRESS).toBuffer(),
    ],
    new PublicKey(PUMP_SWAP_ADDRESS)
  );
  return pool;
}

/**
 * The Pump-venue sentinel reference for a mint, following the program's own
 * migration rule: a LIVE bonding curve prices the leg pre-graduation; a
 * GRADUATED curve hands off to the canonical PumpSwap pool. Both bind as the
 * zero sentinel, so the vault address is unchanged across graduation.
 */
export async function resolvePumpVenue(
  reader: AccountDataReader,
  targetMint: PublicKey
): Promise<ResolvedReference> {
  const [curve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), targetMint.toBuffer()],
    new PublicKey(PUMP_FUN_ADDRESS)
  );
  const account = await reader.getAccountData(curve);
  if (
    account &&
    account.owner.toBase58() === PUMP_FUN_ADDRESS &&
    account.data.length >= 82 &&
    account.data[48] === 1
  ) {
    // Graduated: the program refuses the curve (6039) and accepts only the
    // canonical PumpSwap pool — same zero-sentinel seed, same vault address.
    const pool = canonicalPumpSwapPool(targetMint);
    if (!(await reader.getAccountData(pool))) {
      // The REAL migration window: curve complete, canonical pool not yet
      // created. On mainnet Pump's migrator cranks this within minutes and
      // burns resume by themselves; on a fork the crank may never run.
      // Named precisely so a UI never presents it as a config error.
      reject(
        "REFERENCE_MIGRATING",
        `${targetMint.toBase58()} has graduated but its canonical PumpSwap pool ${pool.toBase58()} does not exist yet. The vault address is UNCHANGED and its SOL is safe; burns of this leg resume as soon as Pump's migration creates the pool (mainnet: minutes; a local fork may need the migration cranked manually)`
      );
    }
    return resolvePool(reader, targetMint, pool);
  }
  return resolveCurve(reader, targetMint);
}

/**
 * Resolve one leg's reference. With no explicit reference the leg is priced
 * off the mint's Pump venue (the DERIVED bonding curve, or after graduation
 * the canonical PumpSwap pool — the program derives the same addresses, so
 * nothing can impersonate them). An explicit reference may be the curve
 * itself or a pool on any allow-listed venue; the program only accepts the
 * reference the vault address was DERIVED with, so this must be the pool
 * the creator bound at setup.
 */
export async function resolveReference(
  reader: AccountDataReader,
  targetMint: PublicKey,
  reference: PublicKey | undefined
): Promise<ResolvedReference> {
  if (!reference) return resolvePumpVenue(reader, targetMint);
  const account = await reader.getAccountData(reference);
  if (!account) {
    reject(
      "REFERENCE_INVALID",
      `reference ${reference.toBase58()} does not exist`
    );
  }
  if (account.owner.toBase58() === PUMP_FUN_ADDRESS) {
    const resolved = await resolveCurve(reader, targetMint);
    if (!resolved.pool.equals(reference)) {
      reject(
        "REFERENCE_INVALID",
        `reference ${reference.toBase58()} is not the derived Pump curve for ${targetMint.toBase58()}`
      );
    }
    return resolved;
  }
  return resolvePool(reader, targetMint, reference);
}
