/**
 * KEYLESS reference-market enumeration and auto-selection.
 *
 * OWNER DECISION 2026-08-26 (setup selection rule): a Pump-ecosystem target
 * uses the Pump venue (bonding curve pre-graduation, canonical PumpSwap pool
 * after) with no market comparison — it binds as the zero sentinel and
 * MIGRATES across graduation, so the vault address survives the token's own
 * success. Any other target enumerates ALL of its markets across the venues
 * the program can price (Raydium v4 / CP / CLMM, Meteora DLMM) and picks
 * per `rankCandidates` (OWNER 2026-08-28): durable locked depth first,
 * otherwise deepest SOL-side depth across every venue. Jupiter's 1 SOL hop
 * is not the default pick.
 *
 * Enumeration is REAL — `getProgramAccounts` with dataSize + mint memcmp
 * filters per venue, both mint orders — not a hardcoded table — and it is
 * the interactive default (OWNER 2026-08-28). Ranking is durable locked
 * depth first, otherwise absolute SOL-side depth; venue is only a tie-break.
 * Every candidate the ranking considers is then independently authenticated
 * by `resolveReference` (the proven program-floor mirror), so a wrong or
 * malicious enumeration source can at worst surface a genuine pool of an
 * allow-listed venue, never bind a fake one.
 *
 * DURABILITY, honestly stated per venue:
 *   - Raydium v4: `lpReserve` (offset 720) records LP ever minted; the LP
 *     mint's live supply is what can still withdraw. burned% = 1 − supply /
 *     lpReserve. Measured live: the NEIRO/WSOL v4 pool is 99.92% burned.
 *   - Raydium CP: same burned-LP signal via `lp_supply` (offset 333), PLUS
 *     Raydium Burn & Earn custody. Burn & Earn does not burn supply: it
 *     transfers LP into the canonical ATA of the lock program's fixed
 *     authority. Both balances are read and independently evidenced.
 *   - Raydium CLMM / Meteora DLMM: ordinary positions are individually
 *     owned and withdrawable, while venue-specific position locks also
 *     exist. NO position-lock signal is read here; the honest classification
 *     is "unverified". A pool-wide locked-depth claim requires enumerating
 *     positions and
 *     converting their liquidity at current ticks/bins. A lock NFT alone is
 *     not enough, so this module refuses to invent a percentage.
 *   - Pump curve / canonical PumpSwap: protocol-owned liquidity, the most
 *     durable — and the mandated branch for Pump coins anyway.
 */
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  AccountDataReader,
  canonicalPumpSwapPool,
  MIN_REFERENCE_DEPTH_LAMPORTS,
  PUMP_FUN_ADDRESS,
  resolvePumpVenue,
  ResolvedReference,
  resolveReference,
  WSOL_ADDRESS,
} from "./reference";

/** The one extra RPC surface enumeration needs beyond `AccountDataReader`. */
export interface ProgramAccountsReader {
  getProgramAddresses(
    program: PublicKey,
    filters: readonly (
      | { dataSize: number }
      | { memcmp: { offset: number; bytes: string } }
    )[]
  ): Promise<PublicKey[]>;
}

type EnumVenue = Readonly<{
  name: string;
  program: string;
  dataSize: number;
  mint0: number;
  mint1: number;
  vault0: number;
  vault1: number;
  durability: "cp-lp" | "positions";
  lpMint?: number;
  lpIssued?: number | "cp-lp-supply";
}>;

/**
 * Offsets triple-checked: they agree with the venue table in reference.ts
 * (vaults), with `keyless_leg_floor` (mints, discriminator-guarded), and
 * with live mainnet pools read byte-for-byte (probe run 2026-08-26).
 */
const ENUM_VENUES: readonly EnumVenue[] = [
  {
    name: "Raydium v4",
    program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    dataSize: 752,
    mint0: 400,
    mint1: 432,
    vault0: 336,
    vault1: 368,
    durability: "cp-lp",
    lpMint: 464,
    lpIssued: 720,
  },
  {
    name: "Raydium CP",
    program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    dataSize: 637,
    mint0: 168,
    mint1: 200,
    vault0: 72,
    vault1: 104,
    durability: "cp-lp",
    lpMint: 136,
    lpIssued: "cp-lp-supply", // u64 at 333
  },
  {
    name: "Raydium CLMM",
    program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    dataSize: 1544,
    mint0: 73,
    mint1: 105,
    vault0: 137,
    vault1: 169,
    durability: "positions",
  },
  {
    name: "Meteora DLMM",
    program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    dataSize: 904,
    mint0: 88,
    mint1: 120,
    vault0: 152,
    vault1: 184,
    durability: "positions",
  },
];

/**
 * Raydium SDK v2's mainnet Burn & Earn constants. The custody vault is the
 * legacy-token ATA of `RAYDIUM_CP_LOCK_AUTHORITY` for a pool's LP mint.
 * Individual `locked_liquidity` PDAs and Fee Key NFTs account for fee rights;
 * the aggregate ATA balance is the amount attributable to that LP mint/pool.
 */
export const RAYDIUM_BURN_AND_EARN_PROGRAM = new PublicKey(
  "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE"
);
export const RAYDIUM_CP_LOCK_AUTHORITY_SEED = "lock_cp_authority_seed";
export const [RAYDIUM_CP_LOCK_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from(RAYDIUM_CP_LOCK_AUTHORITY_SEED)],
  RAYDIUM_BURN_AND_EARN_PROGRAM
);
/** Solana's runtime incinerator, pinned in this repository's AGENTS.md. */
export const SOLANA_INCINERATOR = new PublicKey(
  "1nc1nerator11111111111111111111111111111111"
);

export type MarketDurability =
  | "protocol-owned"
  | "burned"
  | "locked-by-custody"
  | "not-locked"
  | "unverified";

export type CustodyEvidence = Readonly<{
  mechanism: "raydium-burn-and-earn" | "solana-incinerator";
  tokenAccount: string;
  authority: string;
  program?: string;
  status: "verified" | "absent" | "invalid";
  amountAtoms?: string;
  reason: string;
}>;

export type PoolLockingReport = Readonly<{
  pool: string;
  poolOwner: string;
  venue: string;
  verdict: Exclude<MarketDurability, "protocol-owned">;
  reason: string;
  depthLamports: string;
  lpMint?: string;
  issuedLpAtoms?: string;
  liveLpSupplyAtoms?: string;
  burnedLpAtoms?: string;
  custodyLockedLpAtoms?: string;
  nonWithdrawableLpAtoms?: string;
  lockedPct?: number;
  lockedDepthLamports?: string;
  custody: readonly CustodyEvidence[];
}>;

export type MarketCandidate = {
  pool: string;
  venue: string;
  /** SOL-side vault balance in lamports (pre-authentication read). */
  depthLamports: string;
  /** Positive-evidence durability verdict. `unverified` is never ranked safe. */
  durability: MarketDurability;
  /** UI-facing explanation of exactly which on-chain evidence earned it. */
  durabilityReason: string;
  /** cp venues only: measured share of LP burned/custodied, 0..100. */
  lockedPct?: number;
  /** depth × locked fraction — the depth that cannot be withdrawn. */
  lockedDepthLamports?: string;
  /** Full JSON-safe evidence chain used by the verifier and curation UI. */
  durabilityEvidence?: PoolLockingReport;
  /** Clears the program's 50 SOL depth-admission gate (6041). */
  meetsDepthFloor: boolean;
  /** Set once the candidate was fully authenticated by resolveReference. */
  feeBps?: number;
  capLamports?: string;
  /** Reference block the burn/validate instructions carry. */
  vaultA?: string;
  vaultB?: string;
  feeSource?: string;
  /** Zero-sentinel or the pool address, as build_split_seeds derives it. */
  seed?: "zero-sentinel" | "pool-address";
  /** Why this candidate is not eligible, when it is not. */
  rejected?: string;
};

export type MarketSelection = {
  targetMint: string;
  branch: "pump-curve" | "pump-swap-canonical" | "market-enumeration";
  /** The auto-picked reference, fully authenticated. Null when none exists. */
  chosen: (MarketCandidate & { reference: ResolvedReference }) | null;
  /** Why the chosen candidate won (or why nothing is eligible). */
  pickReason: string;
  /** Every market found, deepest first. Pump branches list the venue only. */
  candidates: MarketCandidate[];
  /** Where the addresses came from, for honest attribution. */
  enumerationSource: string;
};

/** JSON-safe form of a selection: the resolver closure stripped. */
export function marketSelectionForTransport(
  selection: MarketSelection
): Readonly<Record<string, unknown>> {
  const { chosen, ...rest } = selection;
  if (!chosen) return { ...rest, chosen: null };
  const { reference: _reference, ...candidate } = chosen;
  return { ...rest, chosen: candidate };
}

const readPk = (data: Buffer, offset: number) =>
  new PublicKey(data.subarray(offset, offset + 32));
const u64 = (data: Buffer, offset: number) => data.readBigUInt64LE(offset);

const TOKEN_ACCOUNT_LENGTH = 165;
const TOKEN_MINT_LENGTH = 82;

function percentOf(part: bigint, whole: bigint): number {
  // Four decimal places is ample for UI/reporting, while every decision and
  // locked-depth calculation below remains integer-only.
  return Number((part * 1_000_000n) / whole) / 10_000;
}

async function inspectCustodyAccount(
  reader: AccountDataReader,
  lpMint: PublicKey,
  authority: PublicKey,
  mechanism: CustodyEvidence["mechanism"],
  program?: PublicKey
): Promise<CustodyEvidence> {
  const tokenAccount = getAssociatedTokenAddressSync(
    lpMint,
    authority,
    true,
    TOKEN_PROGRAM_ID
  );
  const base = {
    mechanism,
    tokenAccount: tokenAccount.toBase58(),
    authority: authority.toBase58(),
    ...(program ? { program: program.toBase58() } : {}),
  };
  const info = await reader.getAccountData(tokenAccount);
  if (!info) {
    return {
      ...base,
      status: "absent",
      reason: "the canonical custody ATA does not exist",
    };
  }

  const failures: string[] = [];
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    failures.push(`account program owner is ${info.owner.toBase58()}`);
  }
  if (info.data.length < TOKEN_ACCOUNT_LENGTH) {
    failures.push(`token-account data is only ${info.data.length} bytes`);
  }
  if (failures.length) {
    return {
      ...base,
      status: "invalid",
      reason: failures.join("; "),
    };
  }

  const data = info.data;
  if (!readPk(data, 0).equals(lpMint)) failures.push("mint field mismatch");
  if (!readPk(data, 32).equals(authority)) {
    failures.push("token authority field mismatch");
  }
  const state = data[108];
  if (state !== 1 && state !== 2) failures.push(`invalid state ${state}`);
  if (data.readUInt32LE(72) !== 0) failures.push("delegate is present");
  if (u64(data, 121) !== 0n) failures.push("delegated amount is non-zero");
  if (data.readUInt32LE(129) !== 0) {
    failures.push("close authority is present");
  }
  if (data.readUInt32LE(109) !== 0) failures.push("account is native");
  const amount = u64(data, 64);
  if (failures.length) {
    return {
      ...base,
      status: "invalid",
      amountAtoms: amount.toString(),
      reason: failures.join("; "),
    };
  }
  return {
    ...base,
    status: "verified",
    amountAtoms: amount.toString(),
    reason:
      mechanism === "raydium-burn-and-earn"
        ? "canonical LP ATA of Raydium's fixed Burn & Earn authority; mint/authority/state/delegate/close-authority all verified"
        : "canonical LP ATA of Solana's off-curve runtime incinerator; mint/authority/state/delegate/close-authority all verified",
  };
}

function unverifiedReport(
  pool: PublicKey,
  poolOwner: string,
  venue: string,
  depth: bigint,
  reason: string,
  custody: readonly CustodyEvidence[] = []
): PoolLockingReport {
  return {
    pool: pool.toBase58(),
    poolOwner,
    venue,
    verdict: "unverified",
    reason,
    depthLamports: depth.toString(),
    custody,
  };
}

async function measurePoolLocking(
  reader: AccountDataReader,
  pool: PublicKey,
  poolOwner: string,
  venue: EnumVenue,
  data: Buffer,
  depth: bigint
): Promise<PoolLockingReport> {
  if (venue.durability === "positions") {
    const detail =
      venue.name === "Raydium CLMM"
        ? "Raydium CLMM Burn & Earn locks position NFTs, but this verifier does not yet enumerate every locked-position account and convert tick-range liquidity into the pool's current SOL depth"
        : "Meteora DLMM stores liquidity in per-bin positions with lock release points; this verifier does not yet enumerate all positions and convert their bin liquidity into the pool's current SOL depth";
    return unverifiedReport(pool, poolOwner, venue.name, depth, detail);
  }
  if (venue.lpMint === undefined || venue.lpIssued === undefined) {
    return unverifiedReport(
      pool,
      poolOwner,
      venue.name,
      depth,
      "venue has no verified LP-mint layout"
    );
  }
  const issuedOffset = venue.lpIssued === "cp-lp-supply" ? 333 : venue.lpIssued;
  const needed = Math.max(venue.lpMint + 32, issuedOffset + 8);
  if (data.length < needed) {
    return unverifiedReport(
      pool,
      poolOwner,
      venue.name,
      depth,
      `pool data is ${data.length} bytes; ${needed} required for verified LP fields`
    );
  }

  const lpMint = readPk(data, venue.lpMint);
  const issued = u64(data, issuedOffset);
  const lpInfo = await reader.getAccountData(lpMint);
  if (
    !lpInfo ||
    !lpInfo.owner.equals(TOKEN_PROGRAM_ID) ||
    lpInfo.data.length < TOKEN_MINT_LENGTH ||
    lpInfo.data[45] !== 1
  ) {
    return {
      ...unverifiedReport(
        pool,
        poolOwner,
        venue.name,
        depth,
        "LP mint is absent, not an initialized legacy SPL mint, or too short"
      ),
      lpMint: lpMint.toBase58(),
      issuedLpAtoms: issued.toString(),
    };
  }
  const supply = u64(lpInfo.data, 36);
  if (issued === 0n || supply > issued) {
    return {
      ...unverifiedReport(
        pool,
        poolOwner,
        venue.name,
        depth,
        issued === 0n
          ? "pool reports zero issued LP"
          : `LP mint supply ${supply} exceeds pool-issued LP ${issued}`
      ),
      lpMint: lpMint.toBase58(),
      issuedLpAtoms: issued.toString(),
      liveLpSupplyAtoms: supply.toString(),
    };
  }

  const custody: CustodyEvidence[] = [];
  if (venue.name === "Raydium CP") {
    custody.push(
      await inspectCustodyAccount(
        reader,
        lpMint,
        RAYDIUM_CP_LOCK_AUTHORITY,
        "raydium-burn-and-earn",
        RAYDIUM_BURN_AND_EARN_PROGRAM
      )
    );
  }
  custody.push(
    await inspectCustodyAccount(
      reader,
      lpMint,
      SOLANA_INCINERATOR,
      "solana-incinerator"
    )
  );

  const burned = issued - supply;
  const custodyLocked = custody.reduce(
    (sum, item) =>
      item.status === "verified" && item.amountAtoms !== undefined
        ? sum + BigInt(item.amountAtoms)
        : sum,
    0n
  );
  const nonWithdrawable = burned + custodyLocked;
  if (nonWithdrawable > issued) {
    return {
      ...unverifiedReport(
        pool,
        poolOwner,
        venue.name,
        depth,
        `burned + verified custody (${nonWithdrawable}) exceeds issued LP (${issued})`,
        custody
      ),
      lpMint: lpMint.toBase58(),
      issuedLpAtoms: issued.toString(),
      liveLpSupplyAtoms: supply.toString(),
      burnedLpAtoms: burned.toString(),
      custodyLockedLpAtoms: custodyLocked.toString(),
    };
  }

  const invalidCustody = custody.filter((item) => item.status === "invalid");
  const verdict: PoolLockingReport["verdict"] =
    custodyLocked > 0n
      ? "locked-by-custody"
      : burned > 0n
      ? "burned"
      : invalidCustody.length
      ? "unverified"
      : "not-locked";
  const lockedPct = percentOf(nonWithdrawable, issued);
  const lockedDepth = (depth * nonWithdrawable) / issued;
  let reason: string;
  if (verdict === "locked-by-custody") {
    const mechanisms = custody
      .filter(
        (item) => item.status === "verified" && BigInt(item.amountAtoms!) > 0n
      )
      .map((item) => `${item.mechanism}=${item.amountAtoms}`)
      .join(", ");
    const ignored = invalidCustody.length
      ? `; invalid custody evidence was ignored (${invalidCustody
          .map((item) => `${item.mechanism}: ${item.reason}`)
          .join("; ")})`
      : "";
    reason = `${custodyLocked} LP atoms are in verified non-withdrawable custody (${mechanisms}); ${burned} additional LP atoms are burned${ignored}`;
  } else if (verdict === "burned") {
    const custodyQualification = invalidCustody.length
      ? `custody was not counted because it failed verification (${invalidCustody
          .map((item) => `${item.mechanism}: ${item.reason}`)
          .join("; ")})`
      : "verified recognised custody accounts hold zero";
    reason = `pool-issued LP ${issued} exceeds live mint supply ${supply} by ${burned} atoms; ${custodyQualification}`;
  } else if (verdict === "not-locked") {
    reason =
      "live LP mint supply equals pool-issued LP and every recognised venue custody address is absent or holds zero";
  } else {
    reason = `custody address exists but failed verification: ${invalidCustody
      .map((item) => `${item.mechanism}: ${item.reason}`)
      .join("; ")}`;
  }
  return {
    pool: pool.toBase58(),
    poolOwner,
    venue: venue.name,
    verdict,
    reason,
    depthLamports: depth.toString(),
    lpMint: lpMint.toBase58(),
    issuedLpAtoms: issued.toString(),
    liveLpSupplyAtoms: supply.toString(),
    burnedLpAtoms: burned.toString(),
    custodyLockedLpAtoms: custodyLocked.toString(),
    nonWithdrawableLpAtoms: nonWithdrawable.toString(),
    lockedPct,
    lockedDepthLamports: lockedDepth.toString(),
    custody,
  };
}

/**
 * Deterministically inspect one bindable reference pool from raw chain state.
 * Unsupported owners and position venues fail closed as `unverified`.
 */
export async function inspectPoolLocking(
  reader: AccountDataReader,
  pool: PublicKey
): Promise<PoolLockingReport> {
  const info = await reader.getAccountData(pool);
  if (!info) {
    return unverifiedReport(
      pool,
      "missing",
      "unrecognised",
      0n,
      "pool account does not exist"
    );
  }
  const owner = info.owner.toBase58();
  const venue = ENUM_VENUES.find((item) => item.program === owner);
  if (!venue) {
    return unverifiedReport(
      pool,
      owner,
      "unrecognised",
      0n,
      `pool owner ${owner} has no verified layout in the reference verifier`
    );
  }
  const vaultNeeded = Math.max(venue.vault0, venue.vault1) + 32;
  if (info.data.length < vaultNeeded) {
    return unverifiedReport(
      pool,
      owner,
      venue.name,
      0n,
      `pool data is ${info.data.length} bytes; ${vaultNeeded} required for vault fields`
    );
  }
  let depth = 0n;
  for (const offset of [venue.vault0, venue.vault1]) {
    const vault = await reader.getAccountData(readPk(info.data, offset));
    if (
      vault &&
      vault.owner.equals(TOKEN_PROGRAM_ID) &&
      vault.data.length >= TOKEN_ACCOUNT_LENGTH &&
      readPk(vault.data, 0).toBase58() === WSOL_ADDRESS
    ) {
      depth = u64(vault.data, 64);
    }
  }
  return measurePoolLocking(reader, pool, owner, venue, info.data, depth);
}

const ENUMERATION_SCAN_CONCURRENCY = 2;
const CANDIDATE_READ_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await visit(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

function describeReference(
  reference: ResolvedReference
): Pick<
  MarketCandidate,
  "feeBps" | "capLamports" | "vaultA" | "vaultB" | "feeSource" | "seed"
> {
  return {
    feeBps: reference.feeBps,
    capLamports: reference.capLamports.toString(),
    vaultA: reference.vaultA.toBase58(),
    vaultB: reference.vaultB.toBase58(),
    feeSource: reference.feeSource.toBase58(),
    seed: reference.seed.every((byte) => byte === 0)
      ? "zero-sentinel"
      : "pool-address",
  };
}

/**
 * Enumerate every market for `mint` across the supported venues. Returns
 * candidates with SOL depth and the durability signal, deepest first —
 * NOT yet authenticated (that happens per-candidate in `selectReference`).
 */
export async function enumerateMarkets(
  reader: AccountDataReader,
  gpa: ProgramAccountsReader,
  mint: PublicKey
): Promise<MarketCandidate[]> {
  const wsol = WSOL_ADDRESS;
  const scans: {
    venue: EnumVenue;
    mint0: string;
    mint1: string;
  }[] = [];
  for (const venue of ENUM_VENUES) {
    for (const [a, b] of [
      [mint.toBase58(), wsol],
      [wsol, mint.toBase58()],
    ]) {
      scans.push({ venue, mint0: a, mint1: b });
    }
  }
  const groups = await mapWithConcurrency(
    scans,
    ENUMERATION_SCAN_CONCURRENCY,
    async ({ venue, mint0, mint1 }) => {
      const pools = await gpa.getProgramAddresses(
        new PublicKey(venue.program),
        [
          { dataSize: venue.dataSize },
          { memcmp: { offset: venue.mint0, bytes: mint0 } },
          { memcmp: { offset: venue.mint1, bytes: mint1 } },
        ]
      );
      return pools.map((pool) => ({ venue, pool }));
    }
  );
  const found = groups.flat();
  const candidates = await mapWithConcurrency(
    found,
    CANDIDATE_READ_CONCURRENCY,
    async ({ venue, pool }): Promise<MarketCandidate> => {
      const candidate: MarketCandidate = {
        pool: pool.toBase58(),
        venue: venue.name,
        depthLamports: "0",
        durability: "unverified",
        durabilityReason:
          venue.durability === "positions"
            ? "position liquidity has not been enumerated and converted into current pool depth"
            : "LP durability evidence has not been read yet",
        meetsDepthFloor: false,
      };
      try {
        const info = await reader.getAccountData(pool);
        if (!info) return candidate;
        const data = info.data;
        const vaults = [readPk(data, venue.vault0), readPk(data, venue.vault1)];
        let depth = 0n;
        let tokenDepth = 0n;
        for (const vault of vaults) {
          const vaultInfo = await reader.getAccountData(vault);
          if (!vaultInfo || vaultInfo.data.length < 72) continue;
          const vaultMint = readPk(vaultInfo.data, 0).toBase58();
          if (vaultMint === wsol) {
            depth = u64(vaultInfo.data, 64);
          } else if (vaultMint === mint.toBase58()) {
            // RT4 (red-team 2026-08-28): the program's 6041 gate reads the
            // SOL-side GROSS amount only, so a pool an attacker owns — dust on
            // the token side, >= 50 SOL of donated WSOL on the quote side —
            // clears every on-chain admission while its floor collapses to
            // atoms. Rank candidates by the TOKEN side as well, so such a
            // pool can never surface as a reference for real burns.
            tokenDepth = u64(vaultInfo.data, 64);
          }
        }
        candidate.depthLamports = depth.toString();
        candidate.meetsDepthFloor =
          depth >= MIN_REFERENCE_DEPTH_LAMPORTS && tokenDepth > 0n;
        await applyDurability(reader, pool, venue, data, depth, candidate);
      } catch (error) {
        if (error instanceof ReferenceDiscoveryError) throw error;
        candidate.durability = "unverified";
        candidate.durabilityReason = `durability read failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      return candidate;
    }
  );
  return candidates.sort(compareDepthVenueAndPool);
}

/** Apply the same evidence report exposed by `inspectPoolLocking`. */
async function applyDurability(
  reader: AccountDataReader,
  pool: PublicKey,
  venue: EnumVenue,
  data: Buffer,
  depth: bigint,
  candidate: MarketCandidate
): Promise<void> {
  const report = await measurePoolLocking(
    reader,
    pool,
    venue.program,
    venue,
    data,
    depth
  );
  candidate.durability = report.verdict;
  candidate.durabilityReason = report.reason;
  candidate.durabilityEvidence = report;
  candidate.lockedPct = report.lockedPct;
  candidate.lockedDepthLamports = report.lockedDepthLamports;
}

/**
 * Authenticate ONE candidate pool for a mint and return its display row —
 * the fast path for a SHIPPED reference-table candidate: no enumeration, a
 * handful of account reads, and the same resolver authentication the burn
 * uses. A shipped candidate is a CANDIDATE, never a trust assumption: this
 * live check (and the on-chain `validate_config` Mode A probe in the setup
 * transaction) decides, not the table.
 */
export async function resolveCandidate(
  reader: AccountDataReader,
  mint: PublicKey,
  pool: PublicKey | "pump"
): Promise<MarketCandidate & { reference: ResolvedReference }> {
  const reference =
    pool === "pump"
      ? await resolvePumpVenue(reader, mint)
      : await resolveReference(reader, mint, pool);
  const candidate: MarketCandidate = {
    pool: reference.pool.toBase58(),
    venue: reference.venue,
    depthLamports: reference.depthLamports.toString(),
    durability: reference.seed.every((byte) => byte === 0)
      ? "protocol-owned"
      : "unverified",
    durabilityReason: reference.seed.every((byte) => byte === 0)
      ? "protocol-owned Pump liquidity"
      : "durability evidence has not been read yet",
    meetsDepthFloor:
      reference.seed.every((byte) => byte === 0) ||
      reference.depthLamports >= MIN_REFERENCE_DEPTH_LAMPORTS,
    ...describeReference(reference),
  };
  if (pool !== "pump") {
    const info = await reader.getAccountData(pool);
    if (info) {
      const venue = ENUM_VENUES.find(
        (entry) => entry.program === info.owner.toBase58()
      );
      if (venue) {
        await applyDurability(
          reader,
          pool,
          venue,
          info.data,
          reference.depthLamports,
          candidate
        );
      }
    }
  }
  return { ...candidate, reference };
}

/**
 * OWNER DECISION 2026-08-28: interactive discovery MUST use
 * `selectReference` / GPA. Jupiter's 1 SOL `/build` hop is no longer the
 * default pick — it chose a thin DLMM for JUP and a Raydium CLMM for $PUMP
 * over the protocol pool. The trust still lives entirely in on-chain
 * verification: the ranked pool must pass the same resolver checks (owner,
 * discriminator, vaults, >= 50 SOL depth, fee) and the setup transaction's
 * `validate_config` Mode A probe, or the answer is "not supported, here is
 * why". The interactive wrapper bounds that expensive scan with retries,
 * a deadline, per-mint single-flight, and a short success-only cache.
 *
 * `candidateFromRoutePlan` remains for leftover callers. Default resolve
 * must not use it. `KNOWN_REFERENCE_POOLS` is documentation / offline
 * tooling / explicit-pool hints; it is not consulted on the default
 * resolve path.
 */
/**
 * The venues the program's `keyless_leg_floor` can price a reference from.
 * DISCOVERY quotes are restricted to these — otherwise Jupiter optimizes
 * pure execution and (measured live, 2026-08-26) routes JTO multi-hop via
 * Whirlpool and BONK/WIF through Whirlpool pools the program cannot price,
 * wrongly branding supportable mints unsupported. This is a documented,
 * tested venue restriction on a DISCOVERY PROBE only; burn routing remains
 * unrestricted exactly as CLAUDE.md requires.
 */
export const SUPPORTED_REFERENCE_DEXES: readonly string[] = [
  "Raydium",
  "Raydium CP",
  "Raydium CLMM",
  "Meteora DLMM",
  "Pump.fun",
  "Pump.fun Amm",
];

/**
 * Historical burn-proven pools from the 2026-08-26 fork campaign
 * (evidence/deploy-verify-20260826/tm-matrix-v3-results.jsonl). Documentation
 * / offline tooling / explicit-pool hints only — NOT consulted on the
 * default resolve path (OWNER 2026-08-28: live GPA + `rankCandidates`).
 * `$PUMP` has a real bonding curve, so live pick is the Pump venue, not
 * the CLMM recorded here.
 */
export const KNOWN_REFERENCE_POOLS: Readonly<Record<string, string>> = {
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL:
    "JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo", // JTO / Raydium CLMM
  CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump:
    "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV", // NEIRO / Raydium v4
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn:
    "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5", // HISTORICAL $PUMP CLMM — live pick is Pump venue
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:
    "GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN", // BONK / Raydium CLMM
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm:
    "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx", // WIF / Raydium v4
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump":
    "Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw", // FARTCOIN / Raydium v4
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr":
    "FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxRF2x9RwLLMo", // POPCAT / Raydium v4
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R":
    "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA", // RAY / Raydium v4
};

export type RoutePlanEntry = {
  percent?: number;
  swapInfo?: {
    ammKey?: string;
    label?: string;
    inputMint?: string;
    outputMint?: string;
  };
};

/** Leftover helper: default resolve must not use this. */
export async function candidateFromRoutePlan(
  reader: AccountDataReader,
  mint: PublicKey,
  routePlan: readonly unknown[] | undefined
): Promise<MarketCandidate & { reference: ResolvedReference }> {
  const entries = (routePlan ?? []) as readonly RoutePlanEntry[];
  if (!entries.length) {
    throw new Error(
      "Jupiter returned no route for this mint — not tradable yet, so no reference pool can be verified"
    );
  }
  const labels = entries
    .map((entry) => entry.swapInfo?.label ?? "?")
    .join(" -> ");
  const singleHop = entries.every(
    (entry) =>
      entry.swapInfo?.inputMint === WSOL_ADDRESS &&
      entry.swapInfo?.outputMint === mint.toBase58()
  );
  if (!singleHop) {
    throw new Error(
      `Jupiter routes this mint multi-hop (${labels}); there is no single SOL reference pool — not supported`
    );
  }
  // A split single-hop route lists several pools; the largest share is the
  // main market.
  const main = entries.reduce((best, entry) =>
    (entry.percent ?? 0) > (best.percent ?? 0) ? entry : best
  );
  if (!main.swapInfo?.ammKey) {
    throw new Error("Jupiter route carries no pool address");
  }
  return resolveCandidate(reader, mint, new PublicKey(main.swapInfo.ammKey));
}

/** True when the mint has a REAL Pump bonding curve (owner-checked — the
 * curve PDA can be a lamport-dusted System account, observed for $PUMP). */
export async function hasPumpCurve(
  reader: AccountDataReader,
  mint: PublicKey
): Promise<boolean> {
  const [curveAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    new PublicKey(PUMP_FUN_ADDRESS)
  );
  const curve = await reader.getAccountData(curveAddress);
  return (
    curve !== null &&
    curve.owner.toBase58() === PUMP_FUN_ADDRESS &&
    curve.data.length >= 82
  );
}

/**
 * The ranking rule (OWNER 2026-08-28), exactly:
 *
 *   Eligible = meetsDepthFloor && !rejected (50 SOL gate, 6041).
 *   Do not use array order (`eligible[0]` is a bug if unsorted).
 *
 *   1. If any eligible candidate's locked depth alone clears the gate
 *      (lockedDepth >= 50 SOL), the most-locked wins (durability).
 *   2. Otherwise the deepest SOL-side pool wins across every venue.
 *   3. Only equal depths use venue preference, then pool-pubkey byte order.
 *      No age field is used: CLMM `open_time` is disabled, while DLMM
 *      `activation_point` is not a cross-venue creation timestamp.
 *
 * Pump coins are NOT ranked here — `selectReference` binds the Pump venue
 * before enumeration. DBC graduates to DAMM v2, which is not a bindable
 * reference venue, so they fall through to this concentrated rule.
 *
 * The trade-off, stated: rule 1 can prefer a shallower pool, which lowers
 * the per-burn cap (6040: cap = fee × depth) in exchange for liveness that
 * cannot be withdrawn.
 */
const VENUE_TIE_BREAK = new Map([
  ["Raydium v4", 0],
  ["Raydium CP", 1],
  ["Raydium CLMM", 2],
  ["Meteora DLMM", 3],
]);

function comparePoolPubkeys(a: MarketCandidate, b: MarketCandidate): number {
  return Buffer.compare(
    new PublicKey(a.pool).toBuffer(),
    new PublicKey(b.pool).toBuffer()
  );
}

function compareDepthVenueAndPool(
  a: MarketCandidate,
  b: MarketCandidate
): number {
  const depthA = BigInt(a.depthLamports);
  const depthB = BigInt(b.depthLamports);
  if (depthA !== depthB) return depthA > depthB ? -1 : 1;
  const venueA = VENUE_TIE_BREAK.get(a.venue) ?? Number.MAX_SAFE_INTEGER;
  const venueB = VENUE_TIE_BREAK.get(b.venue) ?? Number.MAX_SAFE_INTEGER;
  if (venueA !== venueB) return venueA - venueB;
  return comparePoolPubkeys(a, b);
}

function compareLockedDepthThenPool(
  a: MarketCandidate,
  b: MarketCandidate
): number {
  const lockedA = BigInt(a.lockedDepthLamports!);
  const lockedB = BigInt(b.lockedDepthLamports!);
  if (lockedA !== lockedB) return lockedA > lockedB ? -1 : 1;
  return compareDepthVenueAndPool(a, b);
}

function describeDepth(candidate: MarketCandidate): string {
  return `${candidate.venue}, ${(Number(candidate.depthLamports) / 1e9).toFixed(
    1
  )} SOL`;
}

export function rankCandidates(candidates: readonly MarketCandidate[]): {
  pick: MarketCandidate | null;
  reason: string;
} {
  const eligible = candidates.filter(
    (candidate) => candidate.meetsDepthFloor && !candidate.rejected
  );
  if (!eligible.length) {
    return {
      pick: null,
      reason:
        "no market clears the program's 50 SOL depth-admission gate (6041); a vault bound to any of these could never burn",
    };
  }
  const durable = eligible.filter(
    (candidate) =>
      candidate.lockedDepthLamports !== undefined &&
      BigInt(candidate.lockedDepthLamports) >= MIN_REFERENCE_DEPTH_LAMPORTS
  );
  if (durable.length) {
    const pick = [...durable].sort(compareLockedDepthThenPool)[0];
    return {
      pick,
      reason: `most durably-locked SOL depth (${(
        Number(pick.lockedDepthLamports) / 1e9
      ).toFixed(1)} SOL of ${(Number(pick.depthLamports) / 1e9).toFixed(
        1
      )} SOL cannot be withdrawn — ${pick.lockedPct?.toFixed(2)}% of LP is ${
        pick.durability === "locked-by-custody"
          ? "in verified custody or burned"
          : "burned"
      }); it clears the 50 SOL gate on locked depth alone`,
    };
  }
  const pick = [...eligible].sort(compareDepthVenueAndPool)[0];
  return {
    pick,
    reason: `deepest SOL-side eligible market (${describeDepth(
      pick
    )}); no pool clears the 50 SOL gate on locked depth alone, so venue can only break an equal-depth tie`,
  };
}

export type ReferenceDiscoveryErrorCode =
  | "REFERENCE_DISCOVERY_TIMEOUT"
  | "REFERENCE_DISCOVERY_UNAVAILABLE";

/** A retryable discovery failure, distinct from a verified unsupported mint. */
export class ReferenceDiscoveryError extends Error {
  readonly code: ReferenceDiscoveryErrorCode;

  constructor(code: ReferenceDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "ReferenceDiscoveryError";
    this.code = code;
  }
}

export const DEFAULT_REFERENCE_DISCOVERY_DEADLINE_MS = 15_000;
export const DEFAULT_REFERENCE_DISCOVERY_CACHE_TTL_MS = 30_000;

function withDiscoveryDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ReferenceDiscoveryError(
            "REFERENCE_DISCOVERY_TIMEOUT",
            `reference-market discovery timed out after ${deadlineMs} ms; retry — no unsupported result was cached`
          )
        ),
      deadlineMs
    );
    timer.unref();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Adds a bounded lifetime, per-mint single-flight, and a short success cache
 * to the expensive live scan. A null selection and every thrown error are
 * deliberately never cached, so transient RPC weather cannot brand a mint
 * unsupported even for the cache TTL.
 */
export function createReferenceDiscovery(
  scan: (mint: PublicKey) => Promise<MarketSelection>,
  options: Readonly<{
    deadlineMs?: number;
    cacheTtlMs?: number;
  }> = {}
): (mint: PublicKey) => Promise<MarketSelection> {
  const deadlineMs =
    options.deadlineMs ?? DEFAULT_REFERENCE_DISCOVERY_DEADLINE_MS;
  const cacheTtlMs =
    options.cacheTtlMs ?? DEFAULT_REFERENCE_DISCOVERY_CACHE_TTL_MS;
  const cache = new Map<
    string,
    { expiresAt: number; selection: MarketSelection }
  >();
  const inFlight = new Map<string, Promise<MarketSelection>>();

  return async (mint: PublicKey): Promise<MarketSelection> => {
    const key = mint.toBase58();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.selection;
    if (cached) cache.delete(key);

    let work = inFlight.get(key);
    if (!work) {
      const scanPromise = Promise.resolve().then(() => scan(mint));
      work = withDiscoveryDeadline(scanPromise, deadlineMs)
        .then((selection) => {
          if (selection.chosen) {
            cache.set(key, {
              expiresAt: Date.now() + cacheTtlMs,
              selection,
            });
          }
          return selection;
        })
        .catch((error: unknown) => {
          if (error instanceof ReferenceDiscoveryError) throw error;
          throw new ReferenceDiscoveryError(
            "REFERENCE_DISCOVERY_UNAVAILABLE",
            `reference-market discovery is temporarily unavailable; retry: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      inFlight.set(key, work);
      const clear = () => {
        if (inFlight.get(key) === work) inFlight.delete(key);
      };
      void work.then(clear, clear);
    }
    return work;
  };
}

/**
 * The full owner-decided selection: Pump branch for Pump coins, otherwise
 * real GPA enumeration ranked by locked depth, then absolute SOL-side
 * depth, with each considered candidate authenticated by the proven
 * resolver before it may win.
 */
export async function selectReference(
  reader: AccountDataReader,
  gpa: ProgramAccountsReader,
  mint: PublicKey,
  enumerationSource: string
): Promise<MarketSelection> {
  // Pump branch: a REAL bonding curve (owner-checked — the curve PDA can be
  // a lamport-dusted System account, observed live for $PUMP) routes to the
  // Pump venue with no market comparison.
  const [curveAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    new PublicKey(PUMP_FUN_ADDRESS)
  );
  const curve = await reader.getAccountData(curveAddress);
  if (
    curve &&
    curve.owner.toBase58() === PUMP_FUN_ADDRESS &&
    curve.data.length >= 82
  ) {
    const graduated = curve.data[48] === 1;
    if (
      !graduated ||
      (await reader.getAccountData(canonicalPumpSwapPool(mint)))
    ) {
      const reference = await resolvePumpVenue(reader, mint);
      const candidate: MarketCandidate = {
        pool: reference.pool.toBase58(),
        venue: reference.venue,
        depthLamports: reference.depthLamports.toString(),
        durability: "protocol-owned",
        durabilityReason:
          "Pump venue liquidity is protocol-owned and does not use holder-withdrawable LP positions",
        lockedDepthLamports: reference.depthLamports.toString(),
        meetsDepthFloor: true, // Pump venues are exempt from the 6041 gate
        ...describeReference(reference),
      };
      return {
        targetMint: mint.toBase58(),
        branch: graduated ? "pump-swap-canonical" : "pump-curve",
        chosen: { ...candidate, reference },
        pickReason: graduated
          ? "Pump coin, graduated: the canonical PumpSwap pool is the mandated reference — protocol-owned liquidity, zero-sentinel seed, same vault address as before graduation"
          : "Pump coin on its bonding curve: the curve is the mandated reference — protocol-owned, exempt from the depth gate, and the binding MIGRATES to the canonical PumpSwap pool at graduation without changing the vault address",
        candidates: [candidate],
        enumerationSource: "derived (Pump PDA, no enumeration needed)",
      };
    }
    // Graduated but no canonical PumpSwap pool: a Raydium-era graduate
    // (e.g. NEIRO, FARTCOIN). Fall through to market enumeration.
  }

  const candidates = await enumerateMarkets(reader, gpa, mint);
  // Authenticate candidates best-first until one passes; record why any
  // ranked-above candidate was refused.
  for (let round = 0; ; round += 1) {
    const { pick, reason } = rankCandidates(candidates);
    if (!pick) {
      return {
        targetMint: mint.toBase58(),
        branch: "market-enumeration",
        chosen: null,
        pickReason: reason,
        candidates,
        enumerationSource,
      };
    }
    try {
      const reference = await resolveReference(
        reader,
        mint,
        new PublicKey(pick.pool)
      );
      Object.assign(pick, describeReference(reference));
      return {
        targetMint: mint.toBase58(),
        branch: "market-enumeration",
        chosen: { ...pick, reference },
        pickReason: reason,
        candidates,
        enumerationSource,
      };
    } catch (error) {
      if (error instanceof ReferenceDiscoveryError) throw error;
      pick.rejected = String((error as Error).message ?? error).slice(0, 200);
      if (round >= candidates.length) {
        return {
          targetMint: mint.toBase58(),
          branch: "market-enumeration",
          chosen: null,
          pickReason:
            "every depth-eligible market failed reference authentication",
          candidates,
          enumerationSource,
        };
      }
    }
  }
}
