import { expect } from "chai";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  AccountDataReader,
  MIN_REFERENCE_DEPTH_LAMPORTS,
  WSOL_ADDRESS,
} from "./reference";
import {
  createReferenceDiscovery,
  inspectPoolLocking,
  MarketCandidate,
  MarketSelection,
  RAYDIUM_CP_LOCK_AUTHORITY,
  rankCandidates,
  ReferenceDiscoveryError,
  SOLANA_INCINERATOR,
} from "./markets";

const FLOOR = MIN_REFERENCE_DEPTH_LAMPORTS;
const SOL = 1_000_000_000n;
const pool = (byte: number) => new PublicKey(Buffer.alloc(32, byte)).toBase58();

function candidate(
  partial: Partial<MarketCandidate> &
    Pick<MarketCandidate, "pool" | "venue" | "depthLamports">
): MarketCandidate {
  const depth = BigInt(partial.depthLamports);
  return {
    durability: "unverified",
    durabilityReason: "test fixture",
    meetsDepthFloor: depth >= FLOOR,
    ...partial,
  };
}

describe("rankCandidates", () => {
  it("locked CP ≥ 50 SOL beats a deeper transient CLMM", () => {
    const clmm = candidate({
      pool: pool(1),
      venue: "Raydium CLMM",
      depthLamports: (5_000n * SOL).toString(),
    });
    const locked = candidate({
      pool: pool(2),
      venue: "Raydium CP",
      depthLamports: (80n * SOL).toString(),
      durability: "burned",
      lockedPct: 75,
      lockedDepthLamports: (60n * SOL).toString(),
    });
    // CLMM first: ranking must not follow array order.
    const { pick, reason } = rankCandidates([clmm, locked]);
    expect(pick?.pool).to.equal(pool(2));
    expect(reason).to.match(/durably-locked/);
  });

  it("among durable pools, deeper locked depth wins before total depth", () => {
    const moreTotal = candidate({
      pool: pool(21),
      venue: "Raydium v4",
      depthLamports: (5_000n * SOL).toString(),
      durability: "burned",
      lockedPct: 1.2,
      lockedDepthLamports: (60n * SOL).toString(),
    });
    const moreLocked = candidate({
      pool: pool(22),
      venue: "Raydium CP",
      depthLamports: (80n * SOL).toString(),
      durability: "locked-by-custody",
      lockedPct: 87.5,
      lockedDepthLamports: (70n * SOL).toString(),
    });
    expect(rankCandidates([moreTotal, moreLocked]).pick?.pool).to.equal(
      pool(22)
    );
  });

  it("equal locked-depth ties are stable across RPC response order", () => {
    const laterKey = candidate({
      pool: pool(24),
      venue: "Raydium CP",
      depthLamports: (80n * SOL).toString(),
      durability: "burned",
      lockedPct: 75,
      lockedDepthLamports: (60n * SOL).toString(),
    });
    const earlierKey = { ...laterKey, pool: pool(23) };
    expect(rankCandidates([laterKey, earlierKey]).pick?.pool).to.equal(
      pool(23)
    );
    expect(rankCandidates([earlierKey, laterKey]).pick?.pool).to.equal(
      pool(23)
    );
  });

  it("deeper CLMM/DLMM beats a shallower v4/CP regardless of venue", () => {
    const clmm = candidate({
      pool: pool(3),
      venue: "Raydium CLMM",
      depthLamports: (5_000n * SOL).toString(),
    });
    const dlmm = candidate({
      pool: pool(4),
      venue: "Meteora DLMM",
      depthLamports: (4_000n * SOL).toString(),
    });
    const v4 = candidate({
      pool: pool(5),
      venue: "Raydium v4",
      depthLamports: (80n * SOL).toString(),
    });
    const { pick, reason } = rankCandidates([clmm, dlmm, v4]);
    expect(pick?.pool).to.equal(pool(3));
    expect(reason).to.match(/deepest SOL-side/);

    const cp = candidate({
      pool: pool(6),
      venue: "Raydium CP",
      depthLamports: (90n * SOL).toString(),
    });
    const again = rankCandidates([dlmm, cp, clmm]);
    expect(again.pick?.pool).to.equal(pool(3));
    expect(again.reason).to.match(/deepest SOL-side/);
  });

  it("two DLMMs: deeper wins", () => {
    const shallow = candidate({
      pool: pool(7),
      venue: "Meteora DLMM",
      depthLamports: (200n * SOL).toString(),
    });
    const deep = candidate({
      pool: pool(8),
      venue: "Meteora DLMM",
      depthLamports: (5_700n * SOL).toString(),
    });
    const { pick, reason } = rankCandidates([shallow, deep]);
    expect(pick?.pool).to.equal(pool(8));
    expect(reason).to.match(/deepest SOL-side/);
  });

  it("equal-depth ties are stable across RPC response order", () => {
    const laterKey = candidate({
      pool: pool(10),
      venue: "Meteora DLMM",
      depthLamports: (200n * SOL).toString(),
    });
    const earlierKey = candidate({
      pool: pool(9),
      venue: "Meteora DLMM",
      depthLamports: (200n * SOL).toString(),
    });
    expect(rankCandidates([laterKey, earlierKey]).pick?.pool).to.equal(pool(9));
    expect(rankCandidates([earlierKey, laterKey]).pick?.pool).to.equal(pool(9));
  });

  it("venue only breaks an exactly equal-depth tie", () => {
    const clmm = candidate({
      pool: pool(1),
      venue: "Raydium CLMM",
      depthLamports: (200n * SOL).toString(),
    });
    const cp = candidate({
      pool: pool(20),
      venue: "Raydium CP",
      depthLamports: (200n * SOL).toString(),
    });
    expect(rankCandidates([clmm, cp]).pick?.pool).to.equal(pool(20));
  });

  it("none eligible → null + 6041 reason", () => {
    const thin = candidate({
      pool: pool(11),
      venue: "Raydium CLMM",
      depthLamports: (10n * SOL).toString(),
      meetsDepthFloor: false,
    });
    const rejected = candidate({
      pool: pool(12),
      venue: "Raydium v4",
      depthLamports: (500n * SOL).toString(),
      rejected: "authentication failed",
    });
    const { pick, reason } = rankCandidates([thin, rejected]);
    expect(pick).to.equal(null);
    expect(reason).to.match(/6041/);
  });
});

type RawInfo = { owner: PublicKey; data: Buffer };

class FixtureReader implements AccountDataReader {
  constructor(private readonly accounts: Map<string, RawInfo>) {}

  async getAccountData(address: PublicKey): Promise<RawInfo | null> {
    return this.accounts.get(address.toBase58()) ?? null;
  }
}

function legacyMint(supply: bigint): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data[44] = 9;
  data[45] = 1;
  return data;
}

function legacyTokenAccount(
  mint: PublicKey,
  authority: PublicKey,
  amount: bigint,
  delegate = false
): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  authority.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  if (delegate) {
    data.writeUInt32LE(1, 72);
    new PublicKey(Buffer.alloc(32, 99)).toBuffer().copy(data, 76);
    data.writeBigUInt64LE(1n, 121);
  }
  data[108] = 1;
  return data;
}

function cpFixture(options: {
  issued: bigint;
  supply: bigint;
  custody?: bigint;
  custodyDelegate?: boolean;
  incinerator?: bigint;
  depth?: bigint;
}): {
  reader: FixtureReader;
  pool: PublicKey;
  lockAta: PublicKey;
  incineratorAta: PublicKey;
} {
  const pool = new PublicKey("EyktEFod1gAgsuM1hXmEpqkitFFk9XczkqLPx2vKiceg");
  const lpMint = new PublicKey("9Rn2JYRE94aJpXmVtsurJUqsQCix133EvSSS7p7CmzYX");
  const wsolVault = new PublicKey(Buffer.alloc(32, 51));
  const tokenVault = new PublicKey(Buffer.alloc(32, 52));
  const vaultAuthority = new PublicKey(Buffer.alloc(32, 53));
  const targetMint = new PublicKey(Buffer.alloc(32, 54));
  const cpProgram = new PublicKey(
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
  );
  const poolData = Buffer.alloc(637);
  wsolVault.toBuffer().copy(poolData, 72);
  tokenVault.toBuffer().copy(poolData, 104);
  lpMint.toBuffer().copy(poolData, 136);
  new PublicKey(WSOL_ADDRESS).toBuffer().copy(poolData, 168);
  targetMint.toBuffer().copy(poolData, 200);
  poolData.writeBigUInt64LE(options.issued, 333);

  const accounts = new Map<string, RawInfo>([
    [pool.toBase58(), { owner: cpProgram, data: poolData }],
    [
      lpMint.toBase58(),
      { owner: TOKEN_PROGRAM_ID, data: legacyMint(options.supply) },
    ],
    [
      wsolVault.toBase58(),
      {
        owner: TOKEN_PROGRAM_ID,
        data: legacyTokenAccount(
          new PublicKey(WSOL_ADDRESS),
          vaultAuthority,
          options.depth ?? 1_425_750_000_000n
        ),
      },
    ],
    [
      tokenVault.toBase58(),
      {
        owner: TOKEN_PROGRAM_ID,
        data: legacyTokenAccount(targetMint, vaultAuthority, 1n),
      },
    ],
  ]);
  const lockAta = getAssociatedTokenAddressSync(
    lpMint,
    RAYDIUM_CP_LOCK_AUTHORITY,
    true,
    TOKEN_PROGRAM_ID
  );
  if (options.custody !== undefined) {
    accounts.set(lockAta.toBase58(), {
      owner: TOKEN_PROGRAM_ID,
      data: legacyTokenAccount(
        lpMint,
        RAYDIUM_CP_LOCK_AUTHORITY,
        options.custody,
        options.custodyDelegate
      ),
    });
  }
  const incineratorAta = getAssociatedTokenAddressSync(
    lpMint,
    SOLANA_INCINERATOR,
    true,
    TOKEN_PROGRAM_ID
  );
  if (options.incinerator !== undefined) {
    accounts.set(incineratorAta.toBase58(), {
      owner: TOKEN_PROGRAM_ID,
      data: legacyTokenAccount(lpMint, SOLANA_INCINERATOR, options.incinerator),
    });
  }
  return {
    reader: new FixtureReader(accounts),
    pool,
    lockAta,
    incineratorAta,
  };
}

function v4Fixture(
  issued: bigint,
  supply: bigint
): {
  reader: FixtureReader;
  pool: PublicKey;
} {
  const pool = new PublicKey("HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV");
  const program = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const lpMint = new PublicKey(Buffer.alloc(32, 61));
  const wsolVault = new PublicKey(Buffer.alloc(32, 62));
  const targetVault = new PublicKey(Buffer.alloc(32, 63));
  const authority = new PublicKey(Buffer.alloc(32, 64));
  const targetMint = new PublicKey(Buffer.alloc(32, 65));
  const data = Buffer.alloc(752);
  wsolVault.toBuffer().copy(data, 336);
  targetVault.toBuffer().copy(data, 368);
  lpMint.toBuffer().copy(data, 464);
  data.writeBigUInt64LE(issued, 720);
  return {
    pool,
    reader: new FixtureReader(
      new Map<string, RawInfo>([
        [pool.toBase58(), { owner: program, data }],
        [
          lpMint.toBase58(),
          { owner: TOKEN_PROGRAM_ID, data: legacyMint(supply) },
        ],
        [
          wsolVault.toBase58(),
          {
            owner: TOKEN_PROGRAM_ID,
            data: legacyTokenAccount(
              new PublicKey(WSOL_ADDRESS),
              authority,
              1_000_000n
            ),
          },
        ],
        [
          targetVault.toBase58(),
          {
            owner: TOKEN_PROGRAM_ID,
            data: legacyTokenAccount(targetMint, authority, 1n),
          },
        ],
      ])
    ),
  };
}

describe("inspectPoolLocking", () => {
  it("recognises STNK-shaped Raydium Burn & Earn custody despite unchanged LP supply", async () => {
    expect(RAYDIUM_CP_LOCK_AUTHORITY.toBase58()).to.equal(
      "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH"
    );
    // Live mainnet snapshot, 2026-08-28. The 100-atom supply delta alone is
    // effectively zero; the canonical custody ATA is the decisive evidence.
    const issued = 2_252_609_609_953n;
    const supply = 2_252_609_609_853n;
    const custody = 2_252_193_669_218n;
    const { reader, pool, lockAta } = cpFixture({
      issued,
      supply,
      custody,
      depth: 1_560_201_090_836n,
    });
    const report = await inspectPoolLocking(reader, pool);
    expect(report.verdict).to.equal("locked-by-custody");
    expect(report.burnedLpAtoms).to.equal("100");
    expect(report.custodyLockedLpAtoms).to.equal(custody.toString());
    expect(report.nonWithdrawableLpAtoms).to.equal((custody + 100n).toString());
    expect(report.lockedPct).to.equal(99.9815);
    expect(report.lockedDepthLamports).to.equal("1559913002287");
    expect(report.custody[0].tokenAccount).to.equal(lockAta.toBase58());
    expect(lockAta.toBase58()).to.equal(
      "3VfWCJRgcxtVhPr3VymiNdzrAfUHKSczfhVB3CLdfbLa"
    );
    expect(report.custody[0].status).to.equal("verified");
  });

  it("does not count a custody account carrying a standing delegate", async () => {
    const { reader, pool } = cpFixture({
      issued: 1_000n,
      supply: 900n,
      custody: 800n,
      custodyDelegate: true,
      depth: 1_000_000n,
    });
    const report = await inspectPoolLocking(reader, pool);
    expect(report.verdict).to.equal("burned");
    expect(report.custodyLockedLpAtoms).to.equal("0");
    expect(report.nonWithdrawableLpAtoms).to.equal("100");
    expect(report.custody[0].status).to.equal("invalid");
    expect(report.custody[0].reason).to.match(/delegate/);
    expect(report.reason).to.match(/custody was not counted.*delegate/);
  });

  it("reports a verified zero-burn, zero-custody CP pool as not locked", async () => {
    const { reader, pool } = cpFixture({ issued: 1_000n, supply: 1_000n });
    const report = await inspectPoolLocking(reader, pool);
    expect(report.verdict).to.equal("not-locked");
    expect(report.lockedPct).to.equal(0);
    expect(report.lockedDepthLamports).to.equal("0");
  });

  it("counts LP sent to the canonical Solana incinerator ATA as custody-locked", async () => {
    const { reader, pool, incineratorAta } = cpFixture({
      issued: 1_000n,
      supply: 1_000n,
      incinerator: 750n,
      depth: 2_000_000n,
    });
    const report = await inspectPoolLocking(reader, pool);
    expect(report.verdict).to.equal("locked-by-custody");
    expect(report.burnedLpAtoms).to.equal("0");
    expect(report.custodyLockedLpAtoms).to.equal("750");
    expect(report.lockedDepthLamports).to.equal("1500000");
    expect(report.custody[1]).to.include({
      mechanism: "solana-incinerator",
      tokenAccount: incineratorAta.toBase58(),
      status: "verified",
    });
  });

  it("fails closed when pool accounting contradicts the LP mint", async () => {
    const { reader, pool } = cpFixture({ issued: 999n, supply: 1_000n });
    const report = await inspectPoolLocking(reader, pool);
    expect(report.verdict).to.equal("unverified");
    expect(report.reason).to.match(/exceeds pool-issued/);
  });

  it("keeps the NEIRO-shaped v4 99.9% supply-burn signal as burned", async () => {
    const { reader, pool } = v4Fixture(1_000n, 1n);
    const report = await inspectPoolLocking(reader, pool);
    expect(report.verdict).to.equal("burned");
    expect(report.burnedLpAtoms).to.equal("999");
    expect(report.lockedPct).to.equal(99.9);
    expect(report.lockedDepthLamports).to.equal("999000");
  });

  it("fails closed for a position venue until positions are enumerated", async () => {
    const pool = new PublicKey(Buffer.alloc(32, 71));
    const clmm = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
    const report = await inspectPoolLocking(
      new FixtureReader(
        new Map([[pool.toBase58(), { owner: clmm, data: Buffer.alloc(1544) }]])
      ),
      pool
    );
    expect(report.verdict).to.equal("unverified");
    expect(report.reason).to.match(/does not yet enumerate every/);
    expect(report.lockedDepthLamports).to.equal(undefined);
  });
});

function selection(mint: PublicKey, supported = true): MarketSelection {
  return {
    targetMint: mint.toBase58(),
    branch: "market-enumeration",
    chosen: supported
      ? ({
          pool: pool(30),
          venue: "Raydium CLMM",
          depthLamports: (200n * SOL).toString(),
          durability: "unverified",
          durabilityReason: "test fixture",
          meetsDepthFloor: true,
        } as MarketSelection["chosen"])
      : null,
    pickReason: supported ? "supported" : "unsupported",
    candidates: [],
    enumerationSource: "test",
  };
}

describe("createReferenceDiscovery", () => {
  const mint = new PublicKey(Buffer.alloc(32, 40));

  it("single-flights concurrent scans and caches only a supported success", async () => {
    let calls = 0;
    let release!: (value: MarketSelection) => void;
    const discover = createReferenceDiscovery(
      async () => {
        calls += 1;
        return new Promise<MarketSelection>((resolve) => {
          release = resolve;
        });
      },
      { deadlineMs: 1_000, cacheTtlMs: 1_000 }
    );
    const first = discover(mint);
    const second = discover(mint);
    await Promise.resolve();
    expect(calls).to.equal(1);
    release(selection(mint));
    expect(await first).to.equal(await second);
    await discover(mint);
    expect(calls).to.equal(1);
  });

  it("does not cache failures or unsupported selections", async () => {
    let calls = 0;
    const discoverFailure = createReferenceDiscovery(async () => {
      calls += 1;
      if (calls === 1) throw new Error("429");
      return selection(mint);
    });
    let failure: unknown;
    try {
      await discoverFailure(mint);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ReferenceDiscoveryError);
    expect((failure as ReferenceDiscoveryError).code).to.equal(
      "REFERENCE_DISCOVERY_UNAVAILABLE"
    );
    await discoverFailure(mint);
    expect(calls).to.equal(2);

    let unsupportedCalls = 0;
    const discoverUnsupported = createReferenceDiscovery(async () => {
      unsupportedCalls += 1;
      return selection(mint, false);
    });
    await discoverUnsupported(mint);
    await discoverUnsupported(mint);
    expect(unsupportedCalls).to.equal(2);
  });

  it("returns a typed timeout instead of waiting indefinitely", async () => {
    const discover = createReferenceDiscovery(
      async () =>
        new Promise<MarketSelection>((resolve) =>
          setTimeout(() => resolve(selection(mint)), 100)
        ),
      { deadlineMs: 5 }
    );
    let failure: unknown;
    try {
      await discover(mint);
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(ReferenceDiscoveryError);
    expect((failure as ReferenceDiscoveryError).code).to.equal(
      "REFERENCE_DISCOVERY_TIMEOUT"
    );
  });
});
