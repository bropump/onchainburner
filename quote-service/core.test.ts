import { expect } from "chai";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  assertSubmittableSignedTransaction,
  BurnRequest,
  classifySimulationFailure,
  describeSimulationAttribution,
  ChainGateway,
  deriveVault,
  InMemoryVaultLeaseStore,
  JUPITER_EVENT_AUTHORITY,
  JUPITER_PROGRAM,
  JupiterBuild,
  JupiterBuildParams,
  JupiterClient,
  MAX_TRANSACTION_BYTES,
  MintSnapshot,
  PolicyError,
  PrivateSubmitter,
  QuoteService,
  QuoteServiceDependencies,
  RawAccountSnapshot,
  SimulationResult,
  StaticRateFloorPolicy,
  TokenAccountSnapshot,
} from "./core";
import { JupiterV2HttpClient, LocalKeypairMessageSigner } from "./adapters";

const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function mint(address: PublicKey): MintSnapshot {
  return {
    address,
    ownerProgram: TOKEN_PROGRAM_ID,
    initialized: true,
    mintAuthority: null,
    freezeAuthority: null,
    extensionTypes: [],
  };
}

function tokenAccount(
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

class FakeChain implements ChainGateway {
  readonly mints = new Map<string, MintSnapshot>();
  readonly tokens = new Map<string, TokenAccountSnapshot>();
  readonly raw = new Map<string, RawAccountSnapshot>();
  readonly datas = new Map<string, { owner: PublicKey; data: Buffer }>();
  readonly alts = new Map<string, AddressLookupTableAccount>();
  simulated?: VersionedTransaction;
  simulation: SimulationResult = { error: null, unitsConsumed: 100_000 };

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
  async getAddressLookupTable(address: PublicKey) {
    return this.alts.get(address.toBase58()) ?? null;
  }
  async getLatestBlockhash() {
    return {
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_100,
      contextSlot: 99,
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

class CapturingSubmitter implements PrivateSubmitter {
  wire?: Uint8Array;
  metadata?: Readonly<Record<string, string>>;

  async submit(wire: Uint8Array, metadata: Readonly<Record<string, string>>) {
    this.wire = Uint8Array.from(wire);
    this.metadata = metadata;
    return { submissionId: "private-relay-123" };
  }
}

function routeBuild(
  params: JupiterBuildParams,
  mutate?: (build: any) => void
): JupiterBuild {
  const data = Buffer.alloc(34);
  Buffer.from("bb64facc31c4af14", "hex").copy(data, 0);
  data.writeBigUInt64LE(params.amount, 8);
  const out = params.amount * 2n;
  const threshold = (out * 99n) / 100n;
  const accounts = [
    [params.taker, true, true],
    [
      getAssociatedTokenAddressSync(NATIVE_MINT, params.taker, true),
      false,
      true,
    ],
    [params.destinationTokenAccount, false, true],
    [NATIVE_MINT, false, false],
    [params.outputMint, false, true],
    [TOKEN_PROGRAM_ID, false, false],
    [TOKEN_PROGRAM_ID, false, false],
    [params.destinationTokenAccount, false, true],
    [JUPITER_EVENT_AUTHORITY, false, false],
    [JUPITER_PROGRAM, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({
    pubkey: (pubkey as PublicKey).toBase58(),
    isSigner: isSigner as boolean,
    isWritable: isWritable as boolean,
  }));
  const build: any = {
    swapMode: "ExactIn",
    inputMint: NATIVE_MINT.toBase58(),
    outputMint: params.outputMint.toBase58(),
    inAmount: params.amount.toString(),
    outAmount: out.toString(),
    otherAmountThreshold: threshold.toString(),
    slippageBps: 100,
    priceImpactPct: "0.001",
    platformFee: null,
    swapInstruction: {
      programId: JUPITER_PROGRAM.toBase58(),
      accounts,
      data: data.toString("base64"),
    },
    setupInstructions: [],
    otherInstructions: [],
    addressesByLookupTableAddress: {},
  };
  mutate?.(build);
  return build;
}

class FakeJupiter implements JupiterClient {
  calls: JupiterBuildParams[] = [];
  constructor(private readonly mutate?: (build: any) => void) {}
  async build(params: JupiterBuildParams) {
    this.calls.push(params);
    return routeBuild(params, this.mutate);
  }
}

const RAYDIUM_V4_PROGRAM = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

/**
 * A synthetic Raydium v4 reference pool for one target mint: pool data with
 * the vault addresses at 336/368 and the real fee numerator/denominator at
 * 144/152, plus the two vault token accounts (mint at 0, shared authority at
 * 32, amount at 64) — exactly the bytes the reference resolver reads. Deep
 * reserves keep the mirror floor far below the Jupiter threshold so the
 * policy tests keep exercising the Jupiter-side guards.
 */
function installReferencePool(chain: FakeChain, targetMint: PublicKey) {
  const pool = Keypair.generate().publicKey;
  const tokenVault = Keypair.generate().publicKey;
  const solVault = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const poolData = Buffer.alloc(400);
  poolData.writeBigUInt64LE(25n, 144); // swap_fee_numerator
  poolData.writeBigUInt64LE(10_000n, 152); // swap_fee_denominator
  tokenVault.toBuffer().copy(poolData, 336);
  solVault.toBuffer().copy(poolData, 368);
  chain.datas.set(pool.toBase58(), {
    owner: RAYDIUM_V4_PROGRAM,
    data: poolData,
  });
  const vaultData = (vaultMint: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(165);
    vaultMint.toBuffer().copy(data, 0);
    authority.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    return data;
  };
  chain.datas.set(tokenVault.toBase58(), {
    owner: TOKEN_PROGRAM_ID,
    data: vaultData(targetMint, 2_000_000_000_000_000n),
  });
  chain.datas.set(solVault.toBase58(), {
    owner: TOKEN_PROGRAM_ID,
    data: vaultData(NATIVE_MINT, 1_000_000_000_000n),
  });
  return pool;
}

function fixture(
  mutate?: (build: any) => void,
  targetCount = 1,
  withIndependentFloor = true,
  targetMintOverrides?: readonly PublicKey[]
) {
  const chain = new FakeChain();
  const launchMint = Keypair.generate().publicKey;
  const targetMints =
    targetMintOverrides ??
    Array.from({ length: targetCount }, () => Keypair.generate().publicKey);
  const targetMint = targetMints[0];
  const feePayer = Keypair.generate();
  const references = new Map(
    targetMints.map((currentTarget) => [
      currentTarget.toBase58(),
      installReferencePool(chain, currentTarget),
    ])
  );
  const legs =
    targetMints.length === 1
      ? [{ targetMint, bps: 10_000 }]
      : [
          { targetMint: targetMints[0], bps: 3_000 },
          { targetMint: targetMints[1], bps: 7_000 },
        ];
  const burnerProgram = Keypair.generate().publicKey;
  // KEYLESS: the vault address commits to the reference set; a non-Pump
  // reference contributes its own address as the seed.
  const vault = deriveVault(
    burnerProgram,
    launchMint,
    legs.map((leg) => ({
      ...leg,
      refSeed: references.get(leg.targetMint.toBase58())!.toBuffer(),
    }))
  );
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
  chain.mints.set(launchMint.toBase58(), mint(launchMint));
  chain.tokens.set(
    wsol.toBase58(),
    tokenAccount(wsol, NATIVE_MINT, vault, true)
  );
  for (const currentTarget of targetMints) {
    const targetAta = getAssociatedTokenAddressSync(currentTarget, vault, true);
    chain.mints.set(currentTarget.toBase58(), mint(currentTarget));
    // A native target's ATA IS the vault's WSOL account; never overwrite the
    // canonical WSOL state the service checks first.
    if (targetAta.equals(wsol)) continue;
    chain.tokens.set(
      targetAta.toBase58(),
      tokenAccount(targetAta, currentTarget, vault, false)
    );
  }
  chain.raw.set(vault.toBase58(), {
    owner: SystemProgram.programId,
    lamports: 20_000_000n,
    dataLength: 0,
    executable: false,
  });
  const submitter = new CapturingSubmitter();
  const jupiter = new FakeJupiter(mutate);
  const service = new QuoteService({
    burnerProgram,
    chain,
    jupiter,
    feePayerSigner: new LocalKeypairMessageSigner(feePayer),
    submitter,
    leaseStore: new InMemoryVaultLeaseStore(),
    ...(withIndependentFloor
      ? {
          floorPolicy: new StaticRateFloorPolicy(
            new Map(
              targetMints.map(
                (currentTarget) =>
                  [
                    currentTarget.toBase58(),
                    { numerator: 1n, denominator: 1n },
                  ] as const
              )
            )
          ),
        }
      : {}),
    policy: {
      production: false,
      maxAmountPerBurn: 10_000_000n,
      maxSlippageBps: 150,
      maxPriceImpactBps: 100,
      computeUnitLimit: 1_400_000,
      minRemainingBlockHeights: 50,
      leaseTtlMs: 180_000,
      fittingMaxAccounts: [32, 20, 12],
      approvedLookupTables: new Set(),
    },
  });
  const request: BurnRequest = {
    requestId: "request-1",
    launchMint: launchMint.toBase58(),
    amountIn: "1000000",
    legs: legs.map((leg) => ({
      targetMint: leg.targetMint.toBase58(),
      bps: leg.bps,
      reference: references.get(leg.targetMint.toBase58())!.toBase58(),
    })),
  };
  return {
    service,
    request,
    chain,
    submitter,
    jupiter,
    feePayer,
    launchMint,
    targetMints,
    references,
    vault,
    wsol,
  };
}

/**
 * Passes ONLY when the specific expected PolicyError code is raised, never on
 * a generic throw or on success. Where several guards share a code, the
 * caller must also pass the message fragment that only the guard under test
 * produces (verified unique by grep against core.ts).
 */
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
  if (!rejected) {
    expect.fail(
      `expected PolicyError ${code}${
        messageIncludes ? ` (${messageIncludes})` : ""
      }, got success`
    );
  }
  expect(caught).to.be.instanceOf(PolicyError);
  expect((caught as PolicyError).code).to.equal(code);
  if (messageIncludes) {
    expect((caught as PolicyError).message).to.include(messageIncludes);
  }
}

function serviceDependencies(): QuoteServiceDependencies {
  return {
    burnerProgram: Keypair.generate().publicKey,
    chain: new FakeChain(),
    jupiter: new FakeJupiter(),
    feePayerSigner: new LocalKeypairMessageSigner(Keypair.generate()),
    submitter: new CapturingSubmitter(),
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
  };
}

function expectConstruction(
  dependencies: QuoteServiceDependencies,
  code: string,
  messageIncludes: string
) {
  let caught: unknown;
  let rejected = false;
  try {
    new QuoteService(dependencies);
  } catch (error) {
    caught = error;
    rejected = true;
  }
  if (!rejected) {
    expect.fail(
      `expected PolicyError ${code} (${messageIncludes}), got success`
    );
  }
  expect(caught).to.be.instanceOf(PolicyError);
  expect((caught as PolicyError).code).to.equal(code);
  expect((caught as PolicyError).message).to.include(messageIncludes);
}

/** Replaces the fixture's leg-0 target with a Token-2022 mint + ATA pair. */
function provisionToken2022Target(
  data: ReturnType<typeof fixture>,
  mintPatch: Partial<MintSnapshot>,
  accountExtensionTypes: readonly number[] = []
) {
  const target = data.targetMints[0];
  data.chain.mints.set(target.toBase58(), {
    ...mint(target),
    ownerProgram: TOKEN_2022_PROGRAM_ID,
    ...mintPatch,
  });
  const ata = getAssociatedTokenAddressSync(
    target,
    data.vault,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  data.chain.tokens.set(ata.toBase58(), {
    ...tokenAccount(ata, target, data.vault, false),
    ownerProgram: TOKEN_2022_PROGRAM_ID,
    extensionTypes: accountExtensionTypes,
  });
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

describe("production quote service boundary", () => {
  it("rejects serialized bytes and all unknown caller-controlled fields", async () => {
    const { service, request } = fixture();
    await expectPolicy(
      service.execute({ ...request, serializedTransaction: "attacker-bytes" }),
      "FORBIDDEN_REQUEST_FIELD"
    );
    await expectPolicy(
      service.execute({ ...request, minimumOutput: "1" }),
      "FORBIDDEN_REQUEST_FIELD"
    );
  });

  it("constructs, simulates, signs, and privately submits only compute-budget + burner", async () => {
    const { service, request, chain, submitter, jupiter, feePayer } = fixture();
    const receipt = await service.execute(request);
    expect(receipt.submissionId).to.equal("private-relay-123");
    expect(receipt).not.to.have.property("transaction");
    expect(receipt).not.to.have.property("serializedTransaction");
    expect(receipt.transactionBytes).to.be.at.most(MAX_TRANSACTION_BYTES);
    expect(jupiter.calls).to.have.length(1);
    expect(jupiter.calls[0].maxAccounts).to.equal(undefined);
    expect(jupiter.calls[0].taker.toBase58()).to.equal(receipt.vault);
    expect(chain.simulated).not.to.equal(undefined);
    expect(
      chain.simulated!.signatures.every((signature) =>
        signature.every((b) => b === 0)
      )
    ).to.equal(true);
    const submitted = VersionedTransaction.deserialize(submitter.wire!);
    expect(
      submitted.signatures.every((signature) => signature.some((b) => b !== 0))
    ).to.equal(true);
    const message = TransactionMessage.decompile(submitted.message);
    expect(message.instructions).to.have.length(2);
    expect(
      message.instructions[0].programId.equals(ComputeBudgetProgram.programId)
    ).to.equal(true);
    expect(
      message.instructions[1].programId.equals((service as any).burnerProgram)
    ).to.equal(true);
    // KEYLESS: exactly one required signature — the fee payer's.
    expect(submitted.message.header.numRequiredSignatures).to.equal(1);
    expect(submitted.signatures).to.have.length(1);
    expect(
      submitted.message.staticAccountKeys[0].equals(feePayer.publicKey)
    ).to.equal(true);
    expect(submitter.metadata?.messageSha256).to.equal(receipt.messageSha256);
    // The reserved slot (old quote-authority index 1) is the burner program
    // id, unsigned; the leg block carries the reference pool accounts.
    const burnKeys = message.instructions[1].keys;
    expect(burnKeys[1].pubkey.equals((service as any).burnerProgram)).to.equal(
      true
    );
    expect(burnKeys[1].isSigner).to.equal(false);
  });

  it("reconstructs split inputs and encodes the Pinocchio split discriminator", async () => {
    const { service, request, submitter, jupiter } = fixture(undefined, 2);
    const receipt = await service.execute(request);
    expect(jupiter.calls.map((call) => call.amount.toString())).to.deep.equal([
      "300000",
      "700000",
    ]);
    expect(receipt.minimumOutputs).to.have.length(2);
    const submitted = VersionedTransaction.deserialize(submitter.wire!);
    const message = TransactionMessage.decompile(submitted.message);
    expect(
      message.instructions[1].data.subarray(0, 8).toString("hex")
    ).to.equal("9d2dbae18e110269");
  });

  it("rejects a Jupiter fee and an extra signer before simulation/signing", async () => {
    const fee = fixture(
      (build) =>
        (build.swapInstruction.data = (() => {
          const data = Buffer.from(build.swapInstruction.data, "base64");
          data.writeUInt16LE(1, 26);
          return data.toString("base64");
        })())
    );
    await expectPolicy(fee.service.execute(fee.request), "JUPITER_FEE");
    expect(fee.chain.simulated).to.equal(undefined);

    const signer = fixture((build) => {
      build.swapInstruction.accounts.push({
        pubkey: Keypair.generate().publicKey.toBase58(),
        isSigner: true,
        isWritable: false,
      });
    });
    await expectPolicy(
      signer.service.execute(signer.request),
      "FORBIDDEN_ROUTE_SIGNER"
    );
  });

  it("rejects an independent floor violation even when Jupiter slippage is internally consistent", async () => {
    const data = fixture((build) => {
      build.outAmount = "100";
      build.otherAmountThreshold = "99";
    });
    await expectPolicy(data.service.execute(data.request), "INDEPENDENT_FLOOR");
  });

  it("uses Jupiter's RTSE threshold without requiring a per-mint rate table", async () => {
    const data = fixture(undefined, 1, false);
    const receipt = await data.service.execute(data.request);
    expect(receipt.minimumOutputs).to.have.length(1);
    expect(data.submitter.wire).not.to.equal(undefined);
  });

  it("rejects a claimed lookup table whose Jupiter snapshot differs from live RPC", async () => {
    const tableKey = Keypair.generate().publicKey;
    const liveAddress = Keypair.generate().publicKey;
    const advertised = Keypair.generate().publicKey;
    const data = fixture((build) => {
      build.addressesByLookupTableAddress = {
        [tableKey.toBase58()]: [advertised.toBase58()],
      };
    });
    data.chain.alts.set(
      tableKey.toBase58(),
      new AddressLookupTableAccount({
        key: tableKey,
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 1,
          lastExtendedSlotStartIndex: 0,
          authority: Keypair.generate().publicKey,
          addresses: [liveAddress],
        },
      })
    );
    await expectPolicy(data.service.execute(data.request), "ALT_MISMATCH");
  });

  it("never asks Jupiter /build for payer, direct-only routing, fees, or tips", async () => {
    const originalFetch = global.fetch;
    let called = "";
    global.fetch = (async (input: any) => {
      called = String(input);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new JupiterV2HttpClient("https://api.jup.ag/swap/v2/");
      await client.build({
        inputMint: NATIVE_MINT,
        outputMint: Keypair.generate().publicKey,
        amount: 1n,
        taker: Keypair.generate().publicKey,
        destinationTokenAccount: Keypair.generate().publicKey,
      });
      const url = new URL(called);
      expect(url.pathname).to.equal("/swap/v2/build");
      expect(url.searchParams.get("wrapAndUnwrapSol")).to.equal("false");
      expect(url.searchParams.get("slippageBps")).to.equal("rtse");
      expect(url.searchParams.has("payer")).to.equal(false);
      expect(url.searchParams.has("onlyDirectRoutes")).to.equal(false);
      expect(url.searchParams.has("platformFeeBps")).to.equal(false);
      expect(url.searchParams.has("tipLamports")).to.equal(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("rejects a Jupiter build that reports an error", async () => {
    const data = fixture((build) => {
      build.error = "TOKEN_NOT_TRADABLE";
    });
    await expectPolicy(
      data.service.execute(data.request),
      "JUPITER_BUILD_FAILED",
      "Jupiter build failed"
    );
  });

  it("rejects a build that is not ExactIn at the authorized input", async () => {
    const mode = fixture((build) => {
      build.swapMode = "ExactOut";
    });
    await expectPolicy(
      mode.service.execute(mode.request),
      "JUPITER_INPUT_MISMATCH",
      "changed ExactIn"
    );

    const repriced = fixture((build) => {
      build.inAmount = (BigInt(build.inAmount) + 1n).toString();
    });
    await expectPolicy(
      repriced.service.execute(repriced.request),
      "JUPITER_INPUT_MISMATCH",
      "changed ExactIn"
    );
  });

  it("rejects a route whose discriminator is neither v2 variant", async () => {
    // The legacy v1 `route` discriminator the program also refuses (6005).
    const data = fixture((build) => {
      const payload = Buffer.from(build.swapInstruction.data, "base64");
      Buffer.from("e517cb977ae3ad2a", "hex").copy(payload, 0);
      build.swapInstruction.data = payload.toString("base64");
    });
    await expectPolicy(
      data.service.execute(data.request),
      "INVALID_JUPITER_INSTRUCTION",
      "unsupported Jupiter discriminator"
    );
  });

  it("rejects route data whose embedded input differs from the authorized input", async () => {
    // Top-level build.inAmount stays honest; only the instruction bytes lie.
    const data = fixture((build) => {
      const payload = Buffer.from(build.swapInstruction.data, "base64");
      payload.writeBigUInt64LE(payload.readBigUInt64LE(8) + 1n, 8);
      build.swapInstruction.data = payload.toString("base64");
    });
    await expectPolicy(
      data.service.execute(data.request),
      "JUPITER_INPUT_MISMATCH",
      "instruction input differs"
    );
  });

  it("rejects a positive-slippage fee embedded in the route data", async () => {
    // Offset 28 is positive_slippage_fee_bps for route_v2; the platform-fee
    // half at 26 is covered by the existing JUPITER_FEE test.
    const data = fixture((build) => {
      const payload = Buffer.from(build.swapInstruction.data, "base64");
      payload.writeUInt16LE(1, 28);
      build.swapInstruction.data = payload.toString("base64");
    });
    await expectPolicy(
      data.service.execute(data.request),
      "JUPITER_FEE",
      "platform/positive-slippage fee"
    );
  });

  it("pins every fixed Jupiter route account including the event authority", async () => {
    const redirected = fixture((build) => {
      build.swapInstruction.accounts[2].pubkey =
        Keypair.generate().publicKey.toBase58();
    });
    await expectPolicy(
      redirected.service.execute(redirected.request),
      "INVALID_JUPITER_ACCOUNTS",
      "account 2 is not pinned"
    );

    const eventAuthority = fixture((build) => {
      build.swapInstruction.accounts[8].pubkey =
        Keypair.generate().publicKey.toBase58();
    });
    await expectPolicy(
      eventAuthority.service.execute(eventAuthority.request),
      "INVALID_JUPITER_ACCOUNTS",
      "account 8 is not pinned"
    );
  });

  it("rejects Jupiter slippage above the service maximum", async () => {
    const data = fixture((build) => {
      build.slippageBps = 151;
    });
    await expectPolicy(
      data.service.execute(data.request),
      "SLIPPAGE_POLICY",
      "Jupiter slippage"
    );
  });

  it("rejects an output threshold looser than the slippage policy implies", async () => {
    // slippageBps itself stays inside policy; only the threshold is loose.
    const data = fixture((build) => {
      build.otherAmountThreshold = (
        (BigInt(build.outAmount) * 90n) /
        100n
      ).toString();
    });
    await expectPolicy(
      data.service.execute(data.request),
      "SLIPPAGE_POLICY",
      "looser than service policy"
    );
  });

  it("rejects Jupiter price impact above the service ceiling", async () => {
    const data = fixture((build) => {
      build.priceImpactPct = "0.02";
    });
    await expectPolicy(
      data.service.execute(data.request),
      "PRICE_IMPACT_POLICY",
      "price impact"
    );
  });

  it("rejects a burn above the per-transaction notional limit", async () => {
    const { service, request } = fixture();
    await expectPolicy(
      service.execute({ ...request, amountIn: "10000001" }),
      "NOTIONAL_LIMIT",
      "per-transaction service limit"
    );
  });

  it("re-asserts the compiled top-level instruction set before signing", async () => {
    // The service builds the message itself, so the reparse tripwire cannot
    // be reached through public inputs while upstream code is correct. Fault
    // injection on the reparse view (never on the signed bytes) proves the
    // tripwire is wired and fires.
    const { service, request } = fixture();
    const original = TransactionMessage.decompile;
    TransactionMessage.decompile = ((message: any, args: any) => {
      const decompiled = original.call(TransactionMessage, message, args);
      decompiled.instructions.push(
        SystemProgram.transfer({
          fromPubkey: Keypair.generate().publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        })
      );
      return decompiled;
    }) as typeof TransactionMessage.decompile;
    try {
      await expectPolicy(
        service.execute(request),
        "TOP_LEVEL_INSTRUCTION_POLICY",
        "compute-budget + burner"
      );
    } finally {
      TransactionMessage.decompile = original;
    }
  });

  it("rejects a compiled message requiring any signer beyond the fee payer", async () => {
    // Marks the vault PDA as a signer without touching any instruction data,
    // so the top-level reparse (programId + data) still passes and only the
    // signer-layout assertion can catch the extra required signer.
    const { service, request } = fixture();
    const original = TransactionMessage.prototype.compileToV0Message;
    TransactionMessage.prototype.compileToV0Message = function (
      this: TransactionMessage,
      lookupTables?: AddressLookupTableAccount[]
    ) {
      this.instructions[1].keys[2].isSigner = true;
      return original.call(this, lookupTables);
    };
    try {
      await expectPolicy(
        service.execute(request),
        "SIGNER_LAYOUT",
        "other than the fee payer"
      );
    } finally {
      TransactionMessage.prototype.compileToV0Message = original;
    }
  });

  it("constructor refuses invalid policy configuration", () => {
    const cu = serviceDependencies();
    expectConstruction(
      { ...cu, policy: { ...cu.policy, computeUnitLimit: 200_000 } },
      "POLICY_CONFIGURATION",
      "computeUnitLimit"
    );

    const slippage = serviceDependencies();
    expectConstruction(
      { ...slippage, policy: { ...slippage.policy, maxSlippageBps: 0 } },
      "POLICY_CONFIGURATION",
      "maxSlippageBps"
    );

    const amount = serviceDependencies();
    expectConstruction(
      { ...amount, policy: { ...amount.policy, maxAmountPerBurn: 0n } },
      "POLICY_CONFIGURATION",
      "maxAmountPerBurn"
    );

    const impact = serviceDependencies();
    expectConstruction(
      { ...impact, policy: { ...impact.policy, maxPriceImpactBps: 10_001 } },
      "POLICY_CONFIGURATION",
      "maxPriceImpactBps"
    );

    const lease = serviceDependencies();
    expectConstruction(
      { ...lease, policy: { ...lease.policy, leaseTtlMs: 179_999 } },
      "POLICY_CONFIGURATION",
      "leaseTtlMs"
    );
  });

  it("rejects a vault that is not a funded bare System account", async () => {
    const foreign = fixture();
    foreign.chain.raw.set(foreign.vault.toBase58(), {
      owner: TOKEN_PROGRAM_ID,
      lamports: 20_000_000n,
      dataLength: 0,
      executable: false,
    });
    await expectPolicy(
      foreign.service.execute(foreign.request),
      "INVALID_VAULT",
      "bare System account"
    );

    const short = fixture();
    short.chain.raw.set(short.vault.toBase58(), {
      owner: SystemProgram.programId,
      lamports: 999_999n,
      dataLength: 0,
      executable: false,
    });
    await expectPolicy(
      short.service.execute(short.request),
      "INSUFFICIENT_VAULT_BALANCE",
      "cannot fund"
    );

    // 1_000_000 burn leaves 890_879, one lamport under the 890_880 floor.
    const dust = fixture();
    dust.chain.raw.set(dust.vault.toBase58(), {
      owner: SystemProgram.programId,
      lamports: 1_890_879n,
      dataLength: 0,
      executable: false,
    });
    await expectPolicy(
      dust.service.execute(dust.request),
      "DUST_REMAINDER",
      "sub-rent-floor"
    );
  });

  it("rejects an inadmissible launch mint", async () => {
    const uninitialized = fixture();
    uninitialized.chain.mints.set(uninitialized.launchMint.toBase58(), {
      ...mint(uninitialized.launchMint),
      initialized: false,
    });
    await expectPolicy(
      uninitialized.service.execute(uninitialized.request),
      "INVALID_MINT",
      "absent or uninitialized"
    );

    const foreignOwner = fixture();
    foreignOwner.chain.mints.set(foreignOwner.launchMint.toBase58(), {
      ...mint(foreignOwner.launchMint),
      ownerProgram: SystemProgram.programId,
    });
    await expectPolicy(
      foreignOwner.service.execute(foreignOwner.request),
      "INVALID_MINT_OWNER",
      "not owned by SPL Token"
    );

    const closable = fixture();
    closable.chain.mints.set(closable.launchMint.toBase58(), {
      ...mint(closable.launchMint),
      ownerProgram: TOKEN_2022_PROGRAM_ID,
      closeAuthority: Keypair.generate().publicKey,
    });
    await expectPolicy(
      closable.service.execute(closable.request),
      "LAUNCH_MINT_CLOSABLE",
      "live close authority"
    );
  });

  it("rejects an inadmissible target mint", async () => {
    const mintable = fixture();
    mintable.chain.mints.set(mintable.targetMints[0].toBase58(), {
      ...mint(mintable.targetMints[0]),
      mintAuthority: Keypair.generate().publicKey,
    });
    await expectPolicy(
      mintable.service.execute(mintable.request),
      "TARGET_MINTABLE",
      "mint authority"
    );

    const freezable = fixture();
    freezable.chain.mints.set(freezable.targetMints[0].toBase58(), {
      ...mint(freezable.targetMints[0]),
      freezeAuthority: Keypair.generate().publicKey,
    });
    await expectPolicy(
      freezable.service.execute(freezable.request),
      "TARGET_FREEZABLE",
      "freeze authority"
    );

    // A transfer hook that is INERT (program id unset) on a non-$PUMP mint
    // must still be refused, exactly as the program refuses it (6024).
    const hooked = fixture((build) => {
      build.swapInstruction.accounts[6].pubkey =
        TOKEN_2022_PROGRAM_ID.toBase58();
    });
    provisionToken2022Target(hooked, {
      extensionTypes: [14],
      transferHookAuthority: Keypair.generate().publicKey,
      transferHookProgram: null,
    });
    await expectPolicy(
      hooked.service.execute(hooked.request),
      "UNSUPPORTED_TOKEN_2022_MINT",
      "unsupported extension 14"
    );
  });

  it("rejects encumbered, wrong-state, or unsupported vault token accounts", async () => {
    const wrongState = fixture();
    wrongState.chain.tokens.set(wrongState.wsol.toBase58(), {
      ...tokenAccount(wrongState.wsol, NATIVE_MINT, wrongState.vault, true),
      authority: Keypair.generate().publicKey,
    });
    await expectPolicy(
      wrongState.service.execute(wrongState.request),
      "INVALID_TOKEN_ACCOUNT",
      "wrong state"
    );

    // The client-side mirror of the program's 6035 standing-claims guard.
    const encumbered = fixture();
    const encumberedAta = getAssociatedTokenAddressSync(
      encumbered.targetMints[0],
      encumbered.vault,
      true
    );
    encumbered.chain.tokens.set(encumberedAta.toBase58(), {
      ...tokenAccount(
        encumberedAta,
        encumbered.targetMints[0],
        encumbered.vault,
        false
      ),
      delegate: Keypair.generate().publicKey,
    });
    await expectPolicy(
      encumbered.service.execute(encumbered.request),
      "ENCUMBERED_TOKEN_ACCOUNT",
      "standing claim"
    );

    const extended = fixture((build) => {
      build.swapInstruction.accounts[6].pubkey =
        TOKEN_2022_PROGRAM_ID.toBase58();
    });
    provisionToken2022Target(extended, { extensionTypes: [18] }, [2]);
    await expectPolicy(
      extended.service.execute(extended.request),
      "UNSUPPORTED_TOKEN_2022_ACCOUNT",
      "unsupported extension 2"
    );
  });

  it("rejects a native target mint by identity", async () => {
    // Mirrors the program's 6038 TargetMintNative: both native mints pass
    // every authority/extension check, so only identity can refuse them.
    const wsolTarget = fixture(undefined, 1, true, [NATIVE_MINT]);
    await expectPolicy(
      wsolTarget.service.execute(wsolTarget.request),
      "TARGET_MINT_NATIVE",
      "native wrapped-SOL mint"
    );

    const native2022 = fixture(undefined, 1, true, [NATIVE_MINT_2022]);
    native2022.chain.mints.set(NATIVE_MINT_2022.toBase58(), {
      ...mint(NATIVE_MINT_2022),
      ownerProgram: TOKEN_2022_PROGRAM_ID,
    });
    await expectPolicy(
      native2022.service.execute(native2022.request),
      "TARGET_MINT_NATIVE",
      "native wrapped-SOL mint"
    );
  });

  it("returns a receipt with no serialized transaction under any field name", async () => {
    const { service, request } = fixture();
    const receipt = await service.execute(request);
    expect(receipt).not.to.have.property("transaction");
    expect(receipt).not.to.have.property("serializedTransaction");
    const strings = collectStrings(receipt);
    expect(strings.length).to.be.greaterThan(0);
    for (const value of strings) {
      // A signed burn transaction serializes to hundreds of bytes, so any
      // encoding of one (base64, base64url, base58, and hex all draw from
      // this charset) is a long blob. No legitimate receipt field is one.
      expect(
        value.length < 100 || !/^[A-Za-z0-9+/=_-]+$/.test(value),
        `receipt contains a long serialized blob: ${value.slice(0, 48)}`
      ).to.equal(true);
      for (const encoding of ["base64", "hex"] as const) {
        const decoded = Buffer.from(value, encoding);
        if (decoded.length === 0) continue;
        expect(
          () => VersionedTransaction.deserialize(decoded),
          `receipt string deserializes as a transaction (${encoding}): ${value.slice(
            0,
            48
          )}`
        ).to.throw();
      }
    }
  });

  it("encodes the keyless 7-account leg block with the resolved reference", async () => {
    const {
      service,
      request,
      submitter,
      references,
      targetMints,
      vault,
      wsol,
    } = fixture();
    await service.execute(request);
    const submitted = VersionedTransaction.deserialize(submitter.wire!);
    const burn = TransactionMessage.decompile(submitted.message)
      .instructions[1];
    const pool = references.get(targetMints[0].toBase58())!;
    // Fixed prefix: caller, reserved, pda, wsol, launch, system, token, jup.
    expect(burn.keys[2].pubkey.equals(vault)).to.equal(true);
    expect(burn.keys[3].pubkey.equals(wsol)).to.equal(true);
    // Leg block at 8..15: mint, ata, token program, reference pool, vault A,
    // vault B, fee source. Raydium v4's fee source IS the pool.
    expect(burn.keys[8].pubkey.equals(targetMints[0])).to.equal(true);
    expect(burn.keys[10].pubkey.equals(TOKEN_PROGRAM_ID)).to.equal(true);
    expect(burn.keys[11].pubkey.equals(pool)).to.equal(true);
    expect(burn.keys[14].pubkey.equals(pool)).to.equal(true);
    for (const index of [11, 12, 13, 14]) {
      expect(burn.keys[index].isSigner).to.equal(false);
      expect(burn.keys[index].isWritable).to.equal(false);
    }
  });

  it("derives a different vault when the bound reference changes", async () => {
    // The reference seed is part of the address, so nominating a different
    // pool lands on a different, unfunded vault — refused before any quote.
    const data = fixture();
    const otherPool = installReferencePool(data.chain, data.targetMints[0]);
    await expectPolicy(
      data.service.execute({
        ...data.request,
        legs: [{ ...data.request.legs[0], reference: otherPool.toBase58() }],
      }),
      "INVALID_VAULT",
      "bare System account"
    );
  });

  it("RT4: refuses a dust-token v4 reference whose floor is far below Jupiter's quote", async () => {
    // Hostile bound reference: 50+ SOL on the quote side (clears 6041) and
    // ~8e6 atoms on the token side so the CP floor is a handful of atoms.
    // FakeJupiter still quotes 2x input. The service must refuse
    // REFERENCE_DOES_NOT_PRICE_MARKET rather than co-sign the extraction.
    const dusty = fixture();
    const pool = dusty.references.get(dusty.targetMints[0].toBase58())!;
    const poolData = dusty.chain.datas.get(pool.toBase58())!.data;
    const tokenVault = new PublicKey(poolData.subarray(336, 368));
    dusty.chain.datas
      .get(tokenVault.toBase58())!
      .data.writeBigUInt64LE(8_000_000n, 64);
    await expectPolicy(
      dusty.service.execute(dusty.request),
      "REFERENCE_DOES_NOT_PRICE_MARKET",
      "live market quote"
    );
  });

  it("RT4 residual: a dust Jupiter quote matching the dust floor is not this guard", async () => {
    // If Jupiter is also pricing the hostile pool, quotedOut/2 is not above
    // the floor and REFERENCE_DOES_NOT_PRICE_MARKET does not fire. The
    // program then accepts the burn — that is the documented residual.
    const dusty = fixture((build) => {
      build.outAmount = "8";
      build.otherAmountThreshold = "8";
    });
    const pool = dusty.references.get(dusty.targetMints[0].toBase58())!;
    const poolData = dusty.chain.datas.get(pool.toBase58())!.data;
    const tokenVault = new PublicKey(poolData.subarray(336, 368));
    dusty.chain.datas
      .get(tokenVault.toBase58())!
      .data.writeBigUInt64LE(8_000_000n, 64);
    try {
      await dusty.service.execute(dusty.request);
    } catch (error) {
      expect(error).to.be.instanceOf(PolicyError);
      expect((error as PolicyError).code).to.not.equal(
        "REFERENCE_DOES_NOT_PRICE_MARKET"
      );
    }
  });

  it("lease store refuses a second concurrent acquire on the same vault", async () => {
    const store = new InMemoryVaultLeaseStore();
    const vault = Keypair.generate().publicKey;
    await store.acquire(vault, "request-a", 180_000);
    await expectPolicy(
      store.acquire(vault, "request-b", 180_000),
      "VAULT_BUSY"
    );
  });

  it("lease store refuses a requestId that already submitted", async () => {
    const store = new InMemoryVaultLeaseStore();
    const vault = Keypair.generate().publicKey;
    const lease = await store.acquire(vault, "request-dup", 180_000);
    await lease.release("submitted");
    await expectPolicy(
      store.acquire(Keypair.generate().publicKey, "request-dup", 180_000),
      "DUPLICATE_REQUEST"
    );
  });

  it("refuses a leg whose input exceeds the reference depth cap, mirroring 6040", async () => {
    const shallow = fixture();
    // Drain the reference pool's SOL vault so the cap
    // (solReserve * feeNum / feeDen = 1e8 * 25 / 10000 = 250_000) falls
    // below the request's 1_000_000 lamport input.
    const pool = shallow.references.get(shallow.targetMints[0].toBase58())!;
    const poolData = shallow.chain.datas.get(pool.toBase58())!.data;
    const solVault = new PublicKey(poolData.subarray(368, 400));
    shallow.chain.datas
      .get(solVault.toBase58())!
      .data.writeBigUInt64LE(100_000_000n, 64);
    await expectPolicy(
      shallow.service.execute(shallow.request),
      "REFERENCE_CAP_EXCEEDED",
      "depth cap"
    );
  });

  it("2-leg burn with no lookup table walks the fitting ladder instead of failing fast", async () => {
    // Measured 2026-08-27 (scripts/measure-2leg-size.ts, 18 uncapped walks
    // across six venue pairs): an uncapped 2-leg route fits Solana's
    // 1232-byte wire limit only 7/18 times, and a NARROWER rung fit every
    // other walk. The 3+ leg fail-fast (whose 8 + 7·legs vault keys leave
    // no headroom at any cap) must therefore NOT trigger at 2 legs — the
    // service narrows the route instead of refusing TRANSACTION_TOO_LARGE.
    let builds = 0;
    const { service, request, jupiter, submitter } = fixture((build) => {
      builds += 1;
      if (builds <= 2) {
        // Rung 0 (uncapped, one build per leg): pad the route far past the
        // wire and lock limits, as a wide multi-split Jupiter route does.
        for (let i = 0; i < 40; i += 1) {
          build.swapInstruction.accounts.push({
            pubkey: Keypair.generate().publicKey.toBase58(),
            isSigner: false,
            isWritable: false,
          });
        }
      }
    }, 2);
    const receipt = await service.execute(request);
    expect(submitter.wire).to.not.equal(undefined);
    expect(receipt.transactionBytes).to.be.at.most(MAX_TRANSACTION_BYTES);
    // The ladder really walked: rung 0 was uncapped and failed to fit; the
    // landed rung used the first fitting cap from policy.fittingMaxAccounts.
    expect(jupiter.calls[0].maxAccounts).to.equal(undefined);
    expect(jupiter.calls[jupiter.calls.length - 1].maxAccounts).to.equal(32);
  });

  it("prepare returns the unsigned caller-signer transaction and submits nothing", async () => {
    const { service, request, submitter, chain } = fixture();
    const caller = Keypair.generate();
    const prepared = await service.prepare(request, caller.publicKey);
    expect(submitter.wire).to.equal(undefined);
    expect(chain.simulated).not.to.equal(undefined);
    const message = prepared.transaction.message;
    expect(message.header.numRequiredSignatures).to.equal(1);
    expect(message.staticAccountKeys[0].equals(caller.publicKey)).to.equal(
      true
    );
    expect(
      prepared.transaction.signatures.every((signature) =>
        signature.every((byte) => byte === 0)
      )
    ).to.equal(true);
    expect(prepared.minimumOutputs).to.have.length(1);
  });

  it("execute without a fee-payer signer is refused", async () => {
    // A deps object without feePayerSigner can prepare but never pay for a
    // one-shot burn.
    const data = fixture();
    const { feePayerSigner: _unused, ...withoutPayer } = serviceDependencies();
    await expectPolicy(
      new QuoteService({ ...withoutPayer, chain: data.chain }).execute(
        data.request
      ),
      "SIGNER_CONFIGURATION",
      "fee-payer signer"
    );
  });

  it("submission gate accepts only a fully caller-signed burner transaction", async () => {
    const { service, request } = fixture();
    const caller = Keypair.generate();
    const prepared = await service.prepare(request, caller.publicKey);
    const burnerProgram = (service as any).burnerProgram as PublicKey;

    // Unsigned bytes are refused.
    let unsignedRefused = false;
    try {
      assertSubmittableSignedTransaction(
        Buffer.from(prepared.transaction.serialize()),
        burnerProgram
      );
    } catch (error) {
      unsignedRefused =
        error instanceof PolicyError &&
        error.code === "INVALID_CALLER_SIGNATURE";
    }
    expect(unsignedRefused).to.equal(true);

    // The caller's real signature passes the gate.
    prepared.transaction.sign([caller]);
    const wire = Buffer.from(prepared.transaction.serialize());
    const gate = assertSubmittableSignedTransaction(wire, burnerProgram);
    expect(gate.feePayer.equals(caller.publicKey)).to.equal(true);
    expect(gate.messageSha256).to.equal(prepared.messageSha256);

    // A transaction for any other program is not relayed.
    let foreignRefused = false;
    try {
      assertSubmittableSignedTransaction(wire, Keypair.generate().publicKey);
    } catch (error) {
      foreignRefused =
        error instanceof PolicyError && error.code === "INVALID_TRANSACTION";
    }
    expect(foreignRefused).to.equal(true);

    // A flipped signature byte fails verification.
    wire[1] ^= 0xff;
    let tamperedRefused = false;
    try {
      assertSubmittableSignedTransaction(wire, burnerProgram);
    } catch (error) {
      tamperedRefused =
        error instanceof PolicyError &&
        error.code === "INVALID_CALLER_SIGNATURE";
    }
    expect(tamperedRefused).to.equal(true);
  });
});

describe("simulation-failure attribution", () => {
  const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

  it("attributes to the INNERMOST failing frame, never the burner's unwind", () => {
    const burner = Keypair.generate().publicKey;
    // Log order of a real CPI failure: the innermost program fails first,
    // then each outer frame reports the same code as it unwinds.
    const logs = [
      "Program log: Left: 28200",
      "Program log: Right: 30000",
      `Program ${CLMM} failed: custom program error: 0x1788`,
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1788",
      `Program ${burner.toBase58()} failed: custom program error: 0x1788`,
    ];
    const attribution = classifySimulationFailure(
      { InstructionError: [1, { Custom: 6024 }] },
      logs,
      burner
    );
    expect(attribution.kind).to.equal("external");
    expect(attribution.programId).to.equal(CLMM);
    expect(attribution.code).to.equal(6024);
    // The description names the ACTUAL author and its own error, and gives
    // retry advice that follows from the attribution — Raydium CLMM's 6024
    // (InvalidFirstTickArrayAccount, transient) must never read as OUR 6024
    // (UnsupportedToken2022Extension, permanent).
    const description = describeSimulationAttribution(attribution);
    expect(description).to.include("Raydium CLMM");
    expect(description).to.include("InvalidFirstTickArrayAccount");
    expect(description).to.include("not a burner error code");
    expect(description).to.include("fresh quote");
  });

  it("states unknown authorship as unknown — never assumed to be the burner", () => {
    const attribution = classifySimulationFailure(
      { InstructionError: [1, { Custom: 6024 }] },
      [],
      Keypair.generate().publicKey
    );
    expect(attribution.kind).to.equal("unknown");
    const description = describeSimulationAttribution(attribution);
    expect(description).to.include("authorship");
    expect(description).to.include("unknown");
    expect(description).to.not.include("burner-attributed");
  });

  it("rejects an externally-attributed simulation failure with its own retryable code", async () => {
    const { service, request, chain } = fixture();
    chain.simulation = {
      error: { InstructionError: [1, { Custom: 6024 }] },
      logs: [
        `Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK failed: custom program error: 0x1788`,
        "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1788",
      ],
    };
    await expectPolicy(
      service.execute(request),
      "EXTERNAL_SIMULATION_FAILURE",
      "Raydium CLMM"
    );
  });

  it("still rejects a burner-attributed simulation failure as deterministic SIMULATION_FAILED", async () => {
    const { service, request, chain } = fixture();
    const program = (await import("./core")).DEFAULT_BURNER_PROGRAM;
    // The fixture's burner program is random; recover it from the failure
    // path instead: mark the innermost frame with the fixture's program by
    // using the vault-deriving program id embedded in the service.
    void program;
    chain.simulation = {
      error: { InstructionError: [1, { Custom: 6021 }] },
      logs: [
        `Program ${(
          service as unknown as { burnerProgram: PublicKey }
        ).burnerProgram.toBase58()} failed: custom program error: 0x1785`,
      ],
    };
    await expectPolicy(
      service.execute(request),
      "SIMULATION_FAILED",
      "burner-attributed code 6021"
    );
  });
});

describe("keyless 6021 re-quote", () => {
  it("retries a burner 6021 with a fresh quote inside the same lease, then lands", async () => {
    const { service, request, chain, jupiter } = fixture();
    const burnerId = (
      service as unknown as { burnerProgram: PublicKey }
    ).burnerProgram.toBase58();
    let simulations = 0;
    const original = chain.simulate.bind(chain);
    (chain as { simulate: typeof chain.simulate }).simulate = async (
      transaction
    ) => {
      simulations += 1;
      if (simulations === 1) {
        return {
          error: { InstructionError: [1, { Custom: 6021 }] },
          logs: [`Program ${burnerId} failed: custom program error: 0x1785`],
        };
      }
      return original(transaction);
    };
    const receipt = await service.execute(request);
    expect(receipt.submissionId).to.equal("private-relay-123");
    expect(simulations).to.equal(2);
    // The retry re-quoted: Jupiter was consulted again for the same leg.
    expect(jupiter.calls.length).to.be.greaterThan(1);
  });

  it("exhausted 6021 retries still reject as burner-attributed SIMULATION_FAILED", async () => {
    const { service, request, chain } = fixture();
    const burnerId = (
      service as unknown as { burnerProgram: PublicKey }
    ).burnerProgram.toBase58();
    chain.simulation = {
      error: { InstructionError: [1, { Custom: 6021 }] },
      logs: [`Program ${burnerId} failed: custom program error: 0x1785`],
    };
    await expectPolicy(
      service.execute(request),
      "SIMULATION_FAILED",
      "burner-attributed code 6021"
    );
  });
});
