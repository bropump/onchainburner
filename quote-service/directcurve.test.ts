import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  assertDirectCurveLegShape,
  buildDirectCurveBuyAccounts,
  deriveBondingCurveV2,
  derivePumpCurve,
  deriveUserVolumeAccumulator,
  DIRECT_CURVE_VENUE,
} from "./directcurve";
import {
  AccountDataReader,
  PUMP_FUN_ADDRESS,
  resolveReference,
} from "./reference";
import {
  ChainGateway,
  deriveVault,
  DirectCurveClient,
  InMemoryVaultLeaseStore,
  MintSnapshot,
  PolicyError,
  PrivateSubmitter,
  QuoteService,
  RawAccountSnapshot,
  SimulationResult,
  SPLIT_DISCRIMINATOR,
  TokenAccountSnapshot,
} from "./core";
import { LocalKeypairMessageSigner } from "./adapters";

const PUMP_FUN = new PublicKey(PUMP_FUN_ADDRESS);
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

/** Program-order writability, byte for byte from directcurve.rs
 * PUMP_BUY_WRITABLE plus the two always-writable trailing accounts. */
const EXPECTED_WRITABLE = [
  false,
  true,
  false,
  true,
  true,
  true,
  true,
  false,
  false,
  true,
  false,
  false,
  false,
  true,
  false,
  false,
  true,
  true,
];

class MapReader implements AccountDataReader {
  readonly accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
  set(address: PublicKey, owner: PublicKey, data: Buffer) {
    this.accounts.set(address.toBase58(), { owner, data });
  }
  async getAccountData(address: PublicKey) {
    return this.accounts.get(address.toBase58()) ?? null;
  }
}

/** A live NORMAL curve: reserves at 8/16, complete=0 at 48, creator at
 * 49..81, mayhem byte 81 = 0. */
function liveCurveData(creator: PublicKey): Buffer {
  const data = Buffer.alloc(150);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 8); // virtual tokens
  data.writeBigUInt64LE(1_000_000_000_000n, 16); // virtual SOL (1000 SOL)
  data[48] = 0;
  creator.toBuffer().copy(data, 49);
  data[81] = 0;
  return data;
}

function installLiveCurveLeg(reader: MapReader, targetMint: PublicKey) {
  const creator = Keypair.generate().publicKey;
  const curve = derivePumpCurve(targetMint);
  reader.set(curve, PUMP_FUN, liveCurveData(creator));
  // Mint account bytes (supply at 36) for the resolver's mayhem branch.
  reader.set(targetMint, TOKEN_PROGRAM_ID, Buffer.alloc(82));
  reader.set(deriveBondingCurveV2(targetMint), PUMP_FUN, Buffer.alloc(8));
  return { creator, curve };
}

function buildParams(reader: MapReader, targetMint: PublicKey) {
  const vault = Keypair.generate().publicKey;
  reader.set(deriveUserVolumeAccumulator(vault), PUMP_FUN, Buffer.alloc(8));
  return {
    vault,
    targetMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    targetAta: getAssociatedTokenAddressSync(targetMint, vault, true),
    feeRecipient: Keypair.generate().publicKey,
    buybackFeeRecipient: Keypair.generate().publicKey,
  };
}

async function expectPolicy(
  promise: Promise<unknown>,
  code: string,
  messageIncludes?: string
) {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    caught = error;
    rejected = true;
  }
  if (!rejected) expect.fail(`expected PolicyError ${code}, got success`);
  expect(caught).to.be.instanceOf(PolicyError);
  expect((caught as PolicyError).code).to.equal(code);
  if (messageIncludes) {
    expect((caught as PolicyError).message).to.include(messageIncludes);
  }
}

describe("direct-curve leg builder", () => {
  it("builds the program's exact 18-account buy in order and writability", async () => {
    const reader = new MapReader();
    const targetMint = Keypair.generate().publicKey;
    const { creator, curve } = installLiveCurveLeg(reader, targetMint);
    const params = buildParams(reader, targetMint);
    const { accounts, missingSetup } = await buildDirectCurveBuyAccounts(
      reader,
      params
    );
    expect(missingSetup).to.deep.equal([]);
    expect(accounts).to.have.length(18);
    expect(accounts.map((a) => a.isWritable)).to.deep.equal(EXPECTED_WRITABLE);
    expect(accounts.every((a) => !a.isSigner)).to.equal(true);
    const pda = (seeds: (Buffer | Uint8Array)[]) =>
      PublicKey.findProgramAddressSync(seeds, PUMP_FUN)[0].toBase58();
    expect(accounts.map((a) => a.pubkey)).to.deep.equal([
      pda([Buffer.from("global")]),
      params.feeRecipient.toBase58(),
      targetMint.toBase58(),
      curve.toBase58(),
      getAssociatedTokenAddressSync(
        targetMint,
        curve,
        true,
        TOKEN_PROGRAM_ID
      ).toBase58(),
      params.targetAta.toBase58(),
      params.vault.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      pda([Buffer.from("creator-vault"), creator.toBuffer()]),
      pda([Buffer.from("__event_authority")]),
      PUMP_FUN.toBase58(),
      pda([Buffer.from("global_volume_accumulator")]),
      deriveUserVolumeAccumulator(params.vault).toBase58(),
      PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), PUMP_FUN.toBuffer()],
        new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ")
      )[0].toBase58(),
      "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
      deriveBondingCurveV2(targetMint).toBase58(),
      params.buybackFeeRecipient.toBase58(),
    ]);
    // The shape assertion the pipeline runs must accept its own builder.
    assertDirectCurveLegShape(accounts, {
      vault: params.vault,
      targetMint,
      targetAta: params.targetAta,
    });
  });

  it("reports missing bonding_curve_v2 and vault accumulator as setup, not failure", async () => {
    const reader = new MapReader();
    const targetMint = Keypair.generate().publicKey;
    const { curve } = installLiveCurveLeg(reader, targetMint);
    void curve;
    reader.accounts.delete(deriveBondingCurveV2(targetMint).toBase58());
    const params = buildParams(reader, targetMint);
    reader.accounts.delete(
      deriveUserVolumeAccumulator(params.vault).toBase58()
    );
    const { missingSetup } = await buildDirectCurveBuyAccounts(reader, params);
    expect(missingSetup).to.have.length(2);
    expect(missingSetup[0]).to.include("bonding_curve_v2");
    expect(missingSetup[1]).to.include("user_volume_accumulator");
  });

  it("refuses a graduated curve — that leg belongs to PumpSwap via Jupiter", async () => {
    const reader = new MapReader();
    const targetMint = Keypair.generate().publicKey;
    const { creator } = installLiveCurveLeg(reader, targetMint);
    const graduated = liveCurveData(creator);
    graduated[48] = 1;
    reader.set(derivePumpCurve(targetMint), PUMP_FUN, graduated);
    await expectPolicy(
      buildDirectCurveBuyAccounts(reader, buildParams(reader, targetMint)),
      "REFERENCE_INVALID",
      "graduated"
    );
  });

  it("shape assertion refuses a signer, a displaced vault, and a wrong ATA", async () => {
    const reader = new MapReader();
    const targetMint = Keypair.generate().publicKey;
    installLiveCurveLeg(reader, targetMint);
    const params = buildParams(reader, targetMint);
    const { accounts } = await buildDirectCurveBuyAccounts(reader, params);
    const expected = {
      vault: params.vault,
      targetMint,
      targetAta: params.targetAta,
    };
    const withSigner = accounts.map((account, index) =>
      index === 6 ? { ...account, isSigner: true } : account
    );
    expect(() => assertDirectCurveLegShape(withSigner, expected)).to.throw(
      PolicyError,
      /transaction-level signature/
    );
    const vaultElsewhere = accounts.map((account, index) =>
      index === 1 ? { ...account, pubkey: params.vault.toBase58() } : account
    );
    expect(() => assertDirectCurveLegShape(vaultElsewhere, expected)).to.throw(
      PolicyError,
      /index 1/
    );
    expect(() =>
      assertDirectCurveLegShape(accounts, {
        ...expected,
        targetAta: Keypair.generate().publicKey,
      })
    ).to.throw(PolicyError, /pin the vault/);
    expect(() =>
      assertDirectCurveLegShape(accounts.slice(0, 17), expected)
    ).to.throw(PolicyError, /17 accounts/);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: a 1-leg own-curve burn through the REAL QuoteService — Jupiter is
// never consulted, the route data is empty (the program's curve selector),
// and the minimum output is the resolver's exact BigInt program floor.
// ---------------------------------------------------------------------------

function mintSnapshot(address: PublicKey): MintSnapshot {
  return {
    address,
    ownerProgram: TOKEN_PROGRAM_ID,
    initialized: true,
    mintAuthority: null,
    freezeAuthority: null,
    extensionTypes: [],
  };
}

function tokenSnapshot(
  address: PublicKey,
  mintAddress: PublicKey,
  authority: PublicKey,
  native: boolean
): TokenAccountSnapshot {
  return {
    address,
    ownerProgram: TOKEN_PROGRAM_ID,
    initialized: true,
    mint: mintAddress,
    authority,
    amount: 0n,
    isNative: native,
    delegate: null,
    closeAuthority: null,
    extensionTypes: [],
  };
}

class CurveFakeChain implements ChainGateway {
  readonly mints = new Map<string, MintSnapshot>();
  readonly tokens = new Map<string, TokenAccountSnapshot>();
  readonly raw = new Map<string, RawAccountSnapshot>();
  readonly datas = new Map<string, { owner: PublicKey; data: Buffer }>();
  simulated?: VersionedTransaction;
  simulation: SimulationResult = { error: null, unitsConsumed: 120_000 };

  async getMint(address: PublicKey) {
    return this.mints.get(address.toBase58()) ?? null;
  }
  async getTokenAccount(address: PublicKey) {
    return this.tokens.get(address.toBase58()) ?? null;
  }
  async getRawAccount(address: PublicKey) {
    return this.raw.get(address.toBase58()) ?? null;
  }
  async getAccountData(address: PublicKey) {
    return this.datas.get(address.toBase58()) ?? null;
  }
  async getAddressLookupTable() {
    return null;
  }
  async getLatestBlockhash() {
    return {
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_100,
      contextSlot: 9,
    };
  }
  async getBlockHeight() {
    return 1_000;
  }
  async getRentFloorForZeroData() {
    return 890_880n;
  }
  async simulate(transaction: VersionedTransaction) {
    this.simulated = VersionedTransaction.deserialize(transaction.serialize());
    return this.simulation;
  }
}

describe("direct-curve burn through the pipeline", () => {
  async function curveFixture() {
    const chain = new CurveFakeChain();
    const launchMint = Keypair.generate().publicKey;
    const targetMint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const curve = derivePumpCurve(targetMint);
    chain.datas.set(curve.toBase58(), {
      owner: PUMP_FUN,
      data: liveCurveData(creator),
    });
    chain.datas.set(targetMint.toBase58(), {
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(82),
    });
    const burnerProgram = Keypair.generate().publicKey;
    // Pump-venue references bind as the ZERO sentinel seed.
    const vault = deriveVault(burnerProgram, launchMint, [
      { targetMint, bps: 10_000, refSeed: Buffer.alloc(32) },
    ]);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
    const targetAta = getAssociatedTokenAddressSync(targetMint, vault, true);
    chain.mints.set(launchMint.toBase58(), mintSnapshot(launchMint));
    chain.mints.set(targetMint.toBase58(), mintSnapshot(targetMint));
    chain.tokens.set(
      wsol.toBase58(),
      tokenSnapshot(wsol, NATIVE_MINT, vault, true)
    );
    chain.tokens.set(
      targetAta.toBase58(),
      tokenSnapshot(targetAta, targetMint, vault, false)
    );
    chain.raw.set(vault.toBase58(), {
      owner: SystemProgram.programId,
      lamports: 20_000_000n,
      dataLength: 0,
      executable: false,
    });
    chain.datas.set(deriveBondingCurveV2(targetMint).toBase58(), {
      owner: PUMP_FUN,
      data: Buffer.alloc(8),
    });
    chain.datas.set(deriveUserVolumeAccumulator(vault).toBase58(), {
      owner: PUMP_FUN,
      data: Buffer.alloc(8),
    });
    const feeRecipient = Keypair.generate().publicKey;
    const buybackFeeRecipient = Keypair.generate().publicKey;
    const directCurve: DirectCurveClient & { calls: number } = {
      calls: 0,
      async build(params) {
        directCurve.calls += 1;
        return buildDirectCurveBuyAccounts(chain, {
          ...params,
          feeRecipient,
          buybackFeeRecipient,
        });
      },
    };
    const jupiterCalls: unknown[] = [];
    const submitter: PrivateSubmitter & { wire?: Uint8Array } = {
      async submit(wire: Uint8Array) {
        submitter.wire = Uint8Array.from(wire);
        return { submissionId: "direct-curve-relay" };
      },
    };
    const feePayer = Keypair.generate();
    const service = new QuoteService({
      burnerProgram,
      chain,
      jupiter: {
        async build(params) {
          jupiterCalls.push(params);
          throw new Error("Jupiter must never be consulted for a curve leg");
        },
      },
      directCurve,
      feePayerSigner: new LocalKeypairMessageSigner(feePayer),
      submitter,
      leaseStore: new InMemoryVaultLeaseStore(),
      policy: {
        production: false,
        maxAmountPerBurn: 10_000_000n,
        maxSlippageBps: 150,
        maxPriceImpactBps: 100,
        computeUnitLimit: 1_400_000,
        minRemainingBlockHeights: 50,
        leaseTtlMs: 180_000,
        fittingMaxAccounts: [32, 20, 12],
        approvedLookupTables: new Set<string>(),
      },
    });
    const request = {
      requestId: "curve-1",
      launchMint: launchMint.toBase58(),
      amountIn: "1000000",
      legs: [{ targetMint: targetMint.toBase58(), bps: 10_000 }],
    };
    return {
      service,
      request,
      chain,
      submitter,
      directCurve,
      jupiterCalls,
      vault,
      targetMint,
      targetAta,
      curve,
    };
  }

  it("burns an own-curve leg with empty route data, the exact program floor, and no Jupiter call", async () => {
    const fixture = await curveFixture();
    const receipt = await fixture.service.execute(fixture.request);
    expect(receipt.submissionId).to.equal("direct-curve-relay");
    expect(fixture.jupiterCalls).to.have.length(0);
    expect(fixture.directCurve.calls).to.be.greaterThan(0);

    // The exact BigInt floor the program will compute from the same state.
    const reference = await resolveReference(
      fixture.chain,
      fixture.targetMint,
      undefined
    );
    expect(reference.venue).to.equal(DIRECT_CURVE_VENUE);
    const floor = reference.floorFor(1_000_000n);
    expect(receipt.minimumOutputs).to.deep.equal([floor.toString()]);

    const transaction = VersionedTransaction.deserialize(
      Buffer.from(fixture.submitter.wire!)
    );
    const decompiled = TransactionMessage.decompile(transaction.message);
    const burn = decompiled.instructions[1];
    // 8 base + 7 leg block + 18 direct-curve accounts, nothing else.
    expect(burn.keys).to.have.length(33);
    expect(burn.keys[2].pubkey.equals(fixture.vault)).to.equal(true);
    // Leg block reference slots all carry the derived curve.
    expect(burn.keys[11].pubkey.equals(fixture.curve)).to.equal(true);
    expect(burn.keys[12].pubkey.equals(fixture.curve)).to.equal(true);
    expect(burn.keys[13].pubkey.equals(fixture.curve)).to.equal(true);
    // Route accounts 15.. are the Pump buy; index 6 within them is the vault
    // and it is NOT a transaction-level signer.
    expect(burn.keys[15 + 6].pubkey.equals(fixture.vault)).to.equal(true);
    expect(burn.keys[15 + 6].isSigner).to.equal(false);

    // Instruction data: split discriminator, total, one leg, EMPTY route
    // data (the program's curve-path selector), floor as minimum.
    const data = burn.data;
    expect(data.subarray(0, 8).equals(SPLIT_DISCRIMINATOR)).to.equal(true);
    expect(data.readBigUInt64LE(8)).to.equal(1_000_000n);
    expect(data.readUInt32LE(16)).to.equal(1);
    expect(data.readUInt16LE(20)).to.equal(10_000);
    expect(data.readBigUInt64LE(22)).to.equal(floor);
    expect(data.readUInt8(30)).to.equal(18); // route account count
    expect(data.readUInt32LE(31)).to.equal(0); // EMPTY route data
    expect(data).to.have.length(35);
  });

  it("refuses with SETUP_REQUIRED when the vault accumulator is uninitialized", async () => {
    const fixture = await curveFixture();
    fixture.chain.datas.delete(
      deriveUserVolumeAccumulator(fixture.vault).toBase58()
    );
    await expectPolicy(
      fixture.service.execute({ ...fixture.request, requestId: "curve-2" }),
      "SETUP_REQUIRED",
      "user_volume_accumulator"
    );
  });

  it("refuses a curve leg when no direct-curve builder is configured", async () => {
    const fixture = await curveFixture();
    const bare = new QuoteService({
      burnerProgram: undefined,
      chain: fixture.chain,
      jupiter: {
        async build() {
          throw new Error("unreachable");
        },
      },
      feePayerSigner: new LocalKeypairMessageSigner(Keypair.generate()),
      submitter: fixture.submitter,
      leaseStore: new InMemoryVaultLeaseStore(),
      policy: {
        production: false,
        maxAmountPerBurn: 10_000_000n,
        maxSlippageBps: 150,
        maxPriceImpactBps: 100,
        computeUnitLimit: 1_400_000,
        minRemainingBlockHeights: 50,
        leaseTtlMs: 180_000,
        fittingMaxAccounts: [32],
        approvedLookupTables: new Set<string>(),
      },
    });
    // Same request, default program id: the vault derivation differs, so
    // reuse the fixture chain but expect the DIRECT_CURVE_UNAVAILABLE guard
    // to fire before any vault check needs to pass — it must not, so derive
    // the right vault for the default program instead.
    const targetMint = fixture.targetMint;
    const launchMint = new PublicKey(fixture.request.launchMint);
    const { DEFAULT_BURNER_PROGRAM } = await import("./core");
    const vault = deriveVault(DEFAULT_BURNER_PROGRAM, launchMint, [
      { targetMint, bps: 10_000, refSeed: Buffer.alloc(32) },
    ]);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
    const targetAta = getAssociatedTokenAddressSync(targetMint, vault, true);
    fixture.chain.tokens.set(
      wsol.toBase58(),
      tokenSnapshot(wsol, NATIVE_MINT, vault, true)
    );
    fixture.chain.tokens.set(
      targetAta.toBase58(),
      tokenSnapshot(targetAta, targetMint, vault, false)
    );
    fixture.chain.raw.set(vault.toBase58(), {
      owner: SystemProgram.programId,
      lamports: 20_000_000n,
      dataLength: 0,
      executable: false,
    });
    await expectPolicy(
      bare.execute({ ...fixture.request, requestId: "curve-3" }),
      "DIRECT_CURVE_UNAVAILABLE"
    );
  });
});
