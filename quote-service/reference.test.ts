import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PolicyError } from "./core";
import {
  AccountDataReader,
  MIN_REFERENCE_DEPTH_LAMPORTS,
  PUMP_FUN_ADDRESS,
  REFERENCE_TOLERANCE_BPS,
  resolveReference,
  ZERO_REFERENCE_SEED,
} from "./reference";

const RAYDIUM_V4 = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

class FakeReader implements AccountDataReader {
  readonly accounts = new Map<string, { owner: PublicKey; data: Buffer }>();

  set(address: PublicKey, owner: PublicKey, data: Buffer) {
    this.accounts.set(address.toBase58(), { owner, data });
  }

  async getAccountData(address: PublicKey) {
    return this.accounts.get(address.toBase58()) ?? null;
  }
}

function tokenAccountData(
  mint: PublicKey,
  authority: PublicKey,
  amount: bigint
): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  authority.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

function v4Fixture(
  reserveToken: bigint,
  reserveSol: bigint,
  feeNumerator: bigint,
  feeDenominator: bigint
) {
  const reader = new FakeReader();
  const targetMint = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const tokenVault = Keypair.generate().publicKey;
  const solVault = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const poolData = Buffer.alloc(400);
  poolData.writeBigUInt64LE(feeNumerator, 144);
  poolData.writeBigUInt64LE(feeDenominator, 152);
  tokenVault.toBuffer().copy(poolData, 336);
  solVault.toBuffer().copy(poolData, 368);
  reader.set(pool, RAYDIUM_V4, poolData);
  reader.set(
    tokenVault,
    TOKEN_PROGRAM_ID,
    tokenAccountData(targetMint, authority, reserveToken)
  );
  reader.set(
    solVault,
    TOKEN_PROGRAM_ID,
    tokenAccountData(NATIVE_MINT, authority, reserveSol)
  );
  return { reader, targetMint, pool, tokenVault, solVault };
}

async function expectPolicy(
  promise: Promise<unknown>,
  code: string
): Promise<PolicyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(PolicyError);
    expect((error as PolicyError).code).to.equal(code);
    return error as PolicyError;
  }
  throw new Error(`expected PolicyError ${code}, got success`);
}

describe("keyless reference resolver", () => {
  it("resolves a Raydium v4 pool and mirrors the program floor exactly", async () => {
    const reserveToken = 2_000_000_000_000_000n;
    const reserveSol = 1_000_000_000_000n;
    const feeNumerator = 25n;
    const feeDenominator = 10_000n;
    const { reader, targetMint, pool, tokenVault, solVault } = v4Fixture(
      reserveToken,
      reserveSol,
      feeNumerator,
      feeDenominator
    );
    const resolved = await resolveReference(reader, targetMint, pool);
    expect(resolved.venue).to.equal("Raydium v4");
    expect(resolved.vaultA.equals(tokenVault)).to.equal(true);
    expect(resolved.vaultB.equals(solVault)).to.equal(true);
    // v4's fee source IS the pool; a non-Pump seed IS the pool address.
    expect(resolved.feeSource.equals(pool)).to.equal(true);
    expect(resolved.seed.equals(pool.toBuffer())).to.equal(true);
    // The exact constant-product mirror: net = amount*(den-num)/den, then
    // expected = rt*net/(rs+net), floor = expected*(10000-TOL)/10000.
    const amount = 1_000_000n;
    const net = (amount * (feeDenominator - feeNumerator)) / feeDenominator;
    const expected = (reserveToken * net) / (reserveSol + net);
    const floor = (expected * (10_000n - REFERENCE_TOLERANCE_BPS)) / 10_000n;
    expect(resolved.floorFor(amount)).to.equal(floor);
    // The depth cap the program enforces as 6040.
    expect(resolved.capLamports).to.equal(
      (reserveSol * feeNumerator) / feeDenominator
    );
    expect(() => resolved.floorFor(resolved.capLamports + 1n)).to.throw(
      PolicyError
    );
  });

  it("refuses a reference owned by an unsupported program", async () => {
    const { reader, targetMint, pool } = v4Fixture(1n, 1n, 25n, 10_000n);
    const foreign = Keypair.generate().publicKey;
    reader.set(foreign, Keypair.generate().publicKey, Buffer.alloc(400));
    await expectPolicy(
      resolveReference(reader, targetMint, foreign),
      "REFERENCE_INVALID"
    );
    void pool;
  });

  it("refuses an implausible pool fee, mirroring keyless_fee", async () => {
    const { reader, targetMint, pool } = v4Fixture(
      1_000_000n,
      1_000_000n,
      10_000n, // num == den: fee of 100% is refused
      10_000n
    );
    await expectPolicy(
      resolveReference(reader, targetMint, pool),
      "REFERENCE_INVALID"
    );
  });

  it("derives the Pump curve when no reference is given and refuses a graduated one", async () => {
    const reader = new FakeReader();
    const targetMint = Keypair.generate().publicKey;
    const [curve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), targetMint.toBuffer()],
      new PublicKey(PUMP_FUN_ADDRESS)
    );
    const curveData = Buffer.alloc(150);
    curveData.writeBigUInt64LE(1_000_000_000_000_000n, 8); // virtual tokens
    curveData.writeBigUInt64LE(30_000_000_000n, 16); // virtual SOL
    const mintData = Buffer.alloc(82);
    mintData.writeBigUInt64LE(1_000_000_000_000_000n, 36);
    reader.set(curve, new PublicKey(PUMP_FUN_ADDRESS), curveData);
    reader.set(targetMint, TOKEN_PROGRAM_ID, mintData);
    const resolved = await resolveReference(reader, targetMint, undefined);
    // The curve is its own vault pair; the seed is the Pump zero sentinel
    // (its identity is derived in-program and survives graduation).
    expect(resolved.pool.equals(curve)).to.equal(true);
    expect(resolved.vaultA.equals(curve)).to.equal(true);
    expect(resolved.vaultB.equals(curve)).to.equal(true);
    expect(resolved.seed.equals(ZERO_REFERENCE_SEED)).to.equal(true);
    // No fee_config account in this fixture: the resolver must fall back to
    // the program's conservative 1 bps, never fail open.
    const amount = 1_000_000n;
    const net = (amount * 10_000n) / 10_001n - 1n;
    const expected = (1_000_000_000_000_000n * net) / (30_000_000_000n + net);
    expect(resolved.floorFor(amount)).to.equal(
      (expected * (10_000n - REFERENCE_TOLERANCE_BPS)) / 10_000n
    );

    curveData[48] = 1; // complete = true — and no canonical PumpSwap pool
    // in the fixture, so this is the migration window, named precisely.
    await expectPolicy(
      resolveReference(reader, targetMint, undefined),
      "REFERENCE_MIGRATING"
    );
  });

  // ------------------------------------------------------------------------
  // PROPERTY / BOUNDARY / EDGE sweeps for the floor + cap + depth MIRROR.
  //
  // The bar (per the service's own review notes): a wrong byte offset, a
  // rounding change (floor -> half-up), or a drifted constant in the mirror
  // must FAIL a test without anyone having written that specific case. Each
  // sweep re-derives the expected value with the program's EXACT integer
  // formula and asserts equality across many magnitudes and both boundary
  // sides, so a single-case fixture cannot hide a magnitude-dependent drift.
  // ------------------------------------------------------------------------
  // Program-matching constants pinned as LITERALS here, NOT imported from
  // reference.ts. A differential oracle that reuses the module's own constant
  // shares the module's blind spot — mutation-proven: drifting
  // REFERENCE_TOLERANCE_BPS was NOT caught while the oracle imported it. These
  // literals make a constant drift fail, and the two assertions below pin the
  // source constants to the values the on-chain program uses.
  const TOLERANCE_BPS_LITERAL = 100n;
  const DEPTH_FLOOR = 50_000_000_000n; // MIN_REFERENCE_DEPTH_LAMPORTS
  it("pins the mirror's constants to the program's values", () => {
    expect(REFERENCE_TOLERANCE_BPS).to.equal(TOLERANCE_BPS_LITERAL);
    expect(MIN_REFERENCE_DEPTH_LAMPORTS).to.equal(DEPTH_FLOOR);
  });
  // Deterministic LCG so a failure reproduces exactly (no flaky fuzz).
  function lcg(seed: number): () => bigint {
    let state = BigInt(seed) & 0xffffffffn;
    return () => {
      state = (state * 1103515245n + 12345n) & 0x7fffffffn;
      return state;
    };
  }
  const v4Floor = (
    reserveToken: bigint,
    reserveSol: bigint,
    feeNum: bigint,
    feeDen: bigint,
    amount: bigint
  ) => {
    const net = (amount * (feeDen - feeNum)) / feeDen;
    const expected = (reserveToken * net) / (reserveSol + net);
    return (expected * (10_000n - TOLERANCE_BPS_LITERAL)) / 10_000n;
  };

  it("v4 floor + cap match the exact integer formula across a magnitude sweep", async () => {
    const rng = lcg(20260826);
    const feeTiers: Array<[bigint, bigint]> = [
      [25n, 10_000n],
      [30n, 10_000n],
      [100n, 10_000n],
      [1n, 10_000n],
    ];
    let cases = 0;
    for (let i = 0; i < 240; i += 1) {
      const [feeNum, feeDen] = feeTiers[Number(rng() % 4n)];
      // reserveSol in [50 SOL, ~50 SOL + 5000 SOL] so the depth gate passes
      // and the cap is meaningfully > 0.
      const reserveSol = DEPTH_FLOOR + (rng() % 5_000_000_000_000n);
      const reserveToken = 1_000_000n + rng() * 1_000_000n;
      const cap = (reserveSol * feeNum) / feeDen;
      // an amount strictly inside the cap, at varied magnitudes
      const amount = 1n + (rng() % (cap > 1n ? cap : 2n));
      const { reader, targetMint, pool } = v4Fixture(
        reserveToken,
        reserveSol,
        feeNum,
        feeDen
      );
      const resolved = await resolveReference(reader, targetMint, pool);
      expect(resolved.capLamports, `cap case ${i}`).to.equal(cap);
      expect(resolved.floorFor(amount), `floor case ${i}`).to.equal(
        v4Floor(reserveToken, reserveSol, feeNum, feeDen, amount)
      );
      cases += 1;
    }
    expect(cases).to.equal(240);
  });

  it("v4 cap boundary: at cap accepts, cap+1 refuses 6040 (every magnitude)", async () => {
    const rng = lcg(4041);
    for (let i = 0; i < 60; i += 1) {
      const feeNum = 25n;
      const feeDen = 10_000n;
      const reserveSol = DEPTH_FLOOR + (rng() % 20_000_000_000_000n);
      const { reader, targetMint, pool } = v4Fixture(
        2_000_000_000_000_000n,
        reserveSol,
        feeNum,
        feeDen
      );
      const resolved = await resolveReference(reader, targetMint, pool);
      const cap = resolved.capLamports;
      // exactly AT the cap is admissible (the program refuses input > cap)
      expect(() => resolved.floorFor(cap), `at-cap case ${i}`).to.not.throw();
      // one lamport over is 6040
      expect(() => resolved.floorFor(cap + 1n), `over-cap ${i}`).to.throw(
        PolicyError
      );
    }
  });

  it("v4 depth gate boundary: 50 SOL accepts, one lamport under refuses 6041", async () => {
    const mk = async (reserveSol: bigint) => {
      const { reader, targetMint, pool } = v4Fixture(
        2_000_000_000_000_000n,
        reserveSol,
        25n,
        10_000n
      );
      return resolveReference(reader, targetMint, pool);
    };
    // Exactly at the floor: admissible for an in-cap amount.
    const atFloor = await mk(DEPTH_FLOOR);
    expect(() => atFloor.floorFor(atFloor.capLamports)).to.not.throw();
    // One lamport under the floor: every in-cap burn is refused 6041.
    const underFloor = await mk(DEPTH_FLOOR - 1n);
    await expectPolicy(
      Promise.resolve().then(() => underFloor.floorFor(1n)),
      "REFERENCE_TOO_SHALLOW"
    );
  });

  it("v4 arithmetic holds at u64/u128 magnitude edges without overflow", async () => {
    // reserveToken near u64::MAX, deep reserveSol, amount at the cap: the
    // reserveToken*net product exceeds u64 and must be computed in u128/bigint
    // exactly, matching the program's widening.
    const reserveToken = (1n << 64n) - 1n;
    const reserveSol = 100_000_000_000_000n; // 100k SOL
    const { reader, targetMint, pool } = v4Fixture(
      reserveToken,
      reserveSol,
      25n,
      10_000n
    );
    const resolved = await resolveReference(reader, targetMint, pool);
    const cap = resolved.capLamports;
    expect(cap).to.equal((reserveSol * 25n) / 10_000n);
    expect(resolved.floorFor(cap)).to.equal(
      v4Floor(reserveToken, reserveSol, 25n, 10_000n, cap)
    );
    // and one over the cap is still 6040 at this magnitude
    expect(() => resolved.floorFor(cap + 1n)).to.throw(PolicyError);
  });
});
