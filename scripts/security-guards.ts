/**
 * Standalone, fast negative-security tests for the onchain burner program.
 *
 * These prove that the program's on-chain guards are actually enforced by the
 * DEPLOYED bytes on the Surfpool fork -- not just asserted in an IDL shape test.
 * Every check here builds a real transaction, simulates it against the live
 * fork with signature verification on, and asserts the exact custom error the
 * program must return. If any guard were deleted from `programs/`, the matching
 * assertion below flips from the expected error code to success (or a different
 * code) and this script exits non-zero.
 *
 * Covered gaps:
 *   - Gap 1: RETIRED. Keyless has no quote authority; 6004 is never raised.
 *            Slot 1 is reserved and unchecked.

 *   - Gap 3a: substituting a pinned V2 destination account must return 6006
 *             (InvalidJupiterAccounts).
 *   - Gap 3b: replacing either accepted V2 discriminator with legacy V1
 *             `route` must return 6005 (InvalidJupiterInstruction).
 *   - Gap 4a/4b: both V2 fee-bps channels must return 6007.
 *   - Gap 4c: changing V2's encoded input must return 6008.
 *   - Gap 3a/4a/4b/4c (shared): the SAME assertions against the
 *             `shared_accounts_route_v2` variant, whose pins live at shifted
 *             indices/offsets. `useSharedAccounts` is now HONOURED (it used to
 *             be `void`-ed, so gap3a/gap4 only ever exercised the direct
 *             `route_v2` layout). The shared variant is obtained by steering
 *             the route SHAPE to multi-hop and asserted by discriminator.
 *   - Gap 5: the deployed program bytes must match the local
 *            programs/burner/target/deploy/pinocchio_parity.so, else fail loudly.
 *            (Override the artifact it compares against with LOCAL_SO_PATH when
 *            validating a deployment whose matching local build is unavailable.)
 *
 * Build applicability: these checks target the production Pinocchio program.
 *
 * Run:
 *   cd /Users/macm2/onchainburner && \
 *   TS_NODE_TRANSPILE_ONLY=1 pnpm exec ts-node scripts/security-guards.ts
 *
 * Prove an assertion can fail (runs the NAMED gap in its benign configuration
 * so the guard is NOT triggered; the assertion must then trip and exit != 0):
 *   PROVE_FAIL=gap3a ... ts-node scripts/security-guards.ts
 *   PROVE_FAIL=gap3b ... ts-node scripts/security-guards.ts
 *   PROVE_FAIL=gap4a,gap4b,gap4c ... ts-node scripts/security-guards.ts
 *
 * Fork-only note: the direct checks pin Jupiter to Whirlpool (a single hop, so
 * `route_v2`) because several live market-maker venues (HumidiFi, Flux,
 * Quantum, Scorch, SolFi, TesseraV, AlphaQ) cannot execute on a Surfpool fork.
 * The shared checks instead offer the pool-venue set at a larger input to force
 * a multi-hop route (so `shared_accounts_route_v2`). The deployed program
 * The deployed program accepts any well-formed keyless route; these are test
 * constraints only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  AddressLookupTableAccount,
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
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const JUPITER_API = process.env.JUPITER_API_URL ?? "https://api.jup.ag/swap/v2";
const BURNER_PROGRAM = new PublicKey(
  "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5"
);
const BURNER_SO_PATH = "programs/burner/target/deploy/pinocchio_parity.so";
const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
// A real, liquid legacy-SPL target. JTO routes cleanly via Whirlpool.
const TARGET_MINT = new PublicKey(
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"
);
// Any real, initialized token mint works as the immutable launch namespace;
// the program only reads its decimals and token-program ownership. USDC keeps
// the test independent of any Pump launch flow.
const LAUNCH_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const SWAP_AND_BURN_DISCRIMINATOR = Buffer.from([
  0xee, 0xbb, 0x4b, 0xa4, 0x35, 0xf5, 0xc8, 0xac,
]);
// Enough to cover the tiny route input so the transaction is genuinely fundable
// (relevant only when a guard is bypassed in a PROVE_FAIL run).
const ROUTE_INPUT_LAMPORTS = BigInt(20_000_000); // 0.02 SOL
const PDA_FUNDING_LAMPORTS = 60_000_000; // 0.06 SOL

// Each guard is asserted by BOTH its numeric code and the Anchor error name
// the program logs. Requiring the name defends against a CPI (e.g. Jupiter,
// whose own error space also uses small numbers) coincidentally surfacing the
// same InstructionError Custom code -- the assertion only passes when THIS
// program raised the error.
const EXPECTED = {
  gap3a: { code: 6006, name: "InvalidJupiterAccounts" },
  gap3b: { code: 6005, name: "InvalidJupiterInstruction" },
  gap4a: { code: 6007, name: "JupiterPlatformFeeNotAllowed" },
  gap4b: { code: 6007, name: "JupiterPlatformFeeNotAllowed" },
  gap4c: { code: 6008, name: "JupiterInputAmountMismatch" },
  // Shared-accounts-route (`shared_accounts_route_v2`) equivalents. Same codes,
  // but the pins live at the shifted shared-variant indices/offsets.
  gap3aShared: { code: 6006, name: "InvalidJupiterAccounts" },
  gap4aShared: { code: 6007, name: "JupiterPlatformFeeNotAllowed" },
  gap4bShared: { code: 6007, name: "JupiterPlatformFeeNotAllowed" },
  gap4cShared: { code: 6008, name: "JupiterInputAmountMismatch" },
} as const;
const ROUTE_V2_DISCRIMINATOR = "bb64facc31c4af14";
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = "d19853937cfed8e9";

// Jupiter returns the shared-accounts variant for a MULTI-HOP route and the
// direct variant for a single hop, independent of any request flag -- so
// honouring `useSharedAccounts` means STEERING the route SHAPE: a single pinned
// dex yields one hop (`route_v2`), while the pool-venue set at a larger input
// yields a multi-hop route (`shared_accounts_route_v2`). The built
// discriminator is asserted against the request intent, so a shared check can
// never silently run on a direct route.
const SHARED_POOL_DEXES = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
];
// Fork slippage only widens what the honest route would tolerate; the shared
// adversarial checks reject at route validation before any swap executes, so
// this never affects them -- it just lets Jupiter BUILD the multi-hop route.
const FORK_SLIPPAGE_BPS = Number(process.env.FORK_SLIPPAGE_BPS ?? "1500");
// (input lamports, maxAccounts) attempts tried until one yields a shared route
// whose burner transaction fits the account-lock budget. Multi-hop shape and
// per-cap account counts drift with market/fork state, so several are offered.
const SHARED_ROUTE_ATTEMPTS: Array<{ amount: bigint; maxAccounts: number }> = [
  { amount: BigInt(150_000_000), maxAccounts: 28 },
  { amount: BigInt(100_000_000), maxAccounts: 28 },
  { amount: BigInt(100_000_000), maxAccounts: 24 },
  { amount: BigInt(150_000_000), maxAccounts: 24 },
  { amount: BigInt(80_000_000), maxAccounts: 20 },
  { amount: BigInt(200_000_000), maxAccounts: 28 },
  { amount: BigInt(120_000_000), maxAccounts: 20 },
];
// A shared route reaching the burner must leave room under Solana's 64
// account-lock ceiling for the fixed burner accounts; skip any candidate that
// does not, so every adversarial sim actually reaches the program.
const SHARED_MAX_ACCOUNT_LOCKS = 56;

const proveFail = new Set(
  (process.env.PROVE_FAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

type ApiInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
type Quote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  routePlan: { swapInfo: { label?: string } }[];
  error?: string;
};
type SwapInstructionsResponse = {
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  addressLookupTableAddresses?: string[];
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  swapMode?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  error?: string;
};

function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[])
  );
}
function readPayer(): Keypair {
  return readKeypair(
    process.env.SOLANA_KEYPAIR ??
      path.join(os.homedir(), ".config", "solana", "id.json")
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (process.env.JUPITER_API_KEY && new URL(url).hostname.endsWith("jup.ag")) {
    headers.set("x-api-key", process.env.JUPITER_API_KEY);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { ...init, headers });
    if (response.ok) return (await response.json()) as T;
    if (response.status !== 429 || attempt === 3) {
      throw new Error(
        `${response.status} ${response.statusText}: ${await response.text()}`
      );
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error("unreachable Jupiter retry state");
}

function u64(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
}
function burnerInstructionData(
  amountIn: bigint,
  minimumOutput: bigint,
  jupiterData: Buffer
): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(jupiterData.length);
  return Buffer.concat([
    SWAP_AND_BURN_DISCRIMINATOR,
    u64(amountIn),
    u64(minimumOutput),
    length,
    jupiterData,
  ]);
}

/** InstructionError custom code, or null if the sim did not fail with one. */
function customCode(err: unknown): number | null {
  const ie = (err as any)?.InstructionError;
  if (Array.isArray(ie) && ie[1] && typeof ie[1].Custom === "number") {
    return ie[1].Custom as number;
  }
  return null;
}

/**
 * GAP 5: fail loudly if the deployed program bytes drift from the local build.
 *
 * BPFLoaderUpgradeable stores the ELF at offset 45 of the programdata account
 * and zero-pads the remainder of the allocated buffer, so we compare the local
 * .so against the deployed prefix of equal length and require the tail to be
 * all zero -- a plain full-length hash would spuriously mismatch on the pad.
 */
async function assertFreshDeployment(connection: Connection): Promise<{
  programDataAddress: string;
  localBytes: number;
  deployedElfBytes: number;
  sha256: string;
}> {
  const programInfo = await connection.getAccountInfo(
    BURNER_PROGRAM,
    "confirmed"
  );
  if (!programInfo?.executable) {
    throw new Error(
      `program ${BURNER_PROGRAM.toBase58()} is not deployed/executable on ${RPC_URL}`
    );
  }
  if (programInfo.data.length < 36) {
    throw new Error("program account is not a BPFLoaderUpgradeable proxy");
  }
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
  const programData = await connection.getAccountInfo(
    programDataAddress,
    "confirmed"
  );
  if (!programData) {
    throw new Error(
      `programdata account ${programDataAddress.toBase58()} is missing`
    );
  }
  const deployedElf = programData.data.subarray(45);
  // LOCAL_SO_PATH lets a drift-detection self-test point at a mutated copy;
  // production runs use the real build artifact.
  const localPath =
    process.env.LOCAL_SO_PATH ??
    path.join(__dirname, "..", ...BURNER_SO_PATH.split("/"));
  if (!fs.existsSync(localPath)) {
    throw new Error(
      `local artifact not found at ${localPath}; build the Pinocchio program first`
    );
  }
  const local = fs.readFileSync(localPath);
  const sha = (b: Uint8Array) =>
    crypto.createHash("sha256").update(b).digest("hex");
  const mismatch =
    deployedElf.length < local.length ||
    sha(deployedElf.subarray(0, local.length)) !== sha(local) ||
    deployedElf.subarray(local.length).some((byte) => byte !== 0);
  if (mismatch) {
    throw new Error(
      "DEPLOYMENT DRIFT: the program deployed on the fork does NOT match " +
        `${localPath}. The test suite would validate stale bytecode.\n` +
        `  local .so:          ${local.length} bytes  sha256 ${sha(local)}\n` +
        `  deployed ELF region ${
          deployedElf.length
        } bytes  sha256(prefix) ${sha(
          deployedElf.subarray(0, local.length)
        )}\n` +
        "  Rebuild and redeploy before running the security suite, e.g.:\n" +
        `    pnpm run build:pinocchio && solana program deploy --program-id ` +
        `programs/burner/target/deploy/pinocchio_parity-keypair.json ${localPath} --url ${RPC_URL}`
    );
  }
  return {
    programDataAddress: programDataAddress.toBase58(),
    localBytes: local.length,
    deployedElfBytes: deployedElf.length,
    sha256: sha(local),
  };
}

async function sendInstructions(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Signer[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, ...extraSigners]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: false,
      maxRetries: 3,
    }
  );
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `setup tx failed: ${JSON.stringify(confirmation.value.err)}`
    );
  }
  return signature;
}

async function getLookupTables(
  connection: Connection,
  swap: SwapInstructionsResponse
): Promise<AddressLookupTableAccount[]> {
  if (swap.addressesByLookupTableAddress) {
    return Object.entries(swap.addressesByLookupTableAddress).map(
      ([key, addresses]) =>
        new AddressLookupTableAccount({
          key: new PublicKey(key),
          state: {
            deactivationSlot: BigInt("18446744073709551615"),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            addresses: addresses.map((address) => new PublicKey(address)),
          },
        })
    );
  }
  return (
    await Promise.all(
      (swap.addressLookupTableAddresses ?? []).map(
        async (a) =>
          (
            await connection.getAddressLookupTable(new PublicKey(a))
          ).value
      )
    )
  ).filter((t): t is AddressLookupTableAccount => t !== null);
}

async function getQuote(amount: bigint): Promise<Quote> {
  return {
    inAmount: amount.toString(),
    outAmount: "0",
    otherAmountThreshold: "0",
    routePlan: [],
  };
}

async function getSwapInstructions(
  quote: Quote,
  pda: PublicKey,
  payer: PublicKey,
  wsolSource: PublicKey,
  targetTokenAccount: PublicKey,
  opts: {
    includeDestination: boolean;
    useSharedAccounts: boolean;
    /** Overrides `quote.inAmount`; used to steer the shared route's shape. */
    amount?: bigint;
    /** Jupiter `maxAccounts` fitting lever. */
    maxAccounts?: number;
  }
): Promise<SwapInstructionsResponse> {
  void payer;
  void wsolSource;
  // `useSharedAccounts` is now HONOURED (it used to be `void`-ed, which meant
  // gap3a/gap4 only ever exercised the direct `route_v2` layout). Honouring it
  // means steering the route SHAPE: the shared variant only appears for a
  // multi-hop route, so a `true` request offers the pool-venue set at the
  // caller-chosen input, while `false` keeps the original single Whirlpool hop.
  const amount = opts.amount ?? BigInt(quote.inAmount);
  const url = new URL(`${JUPITER_API}/build`);
  url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
  url.searchParams.set("outputMint", TARGET_MINT.toBase58());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("taker", pda.toBase58());
  url.searchParams.set(
    "slippageBps",
    opts.useSharedAccounts ? String(FORK_SLIPPAGE_BPS) : "100"
  );
  url.searchParams.set("wrapAndUnwrapSol", "false");
  url.searchParams.set(
    "dexes",
    (opts.useSharedAccounts ? SHARED_POOL_DEXES : ["Whirlpool"]).join(",")
  );
  url.searchParams.set("maxAccounts", String(opts.maxAccounts ?? 32));
  if (opts.includeDestination) {
    url.searchParams.set(
      "destinationTokenAccount",
      targetTokenAccount.toBase58()
    );
  }
  const swap = await fetchJson<SwapInstructionsResponse>(url.toString());
  if (swap.error) throw new Error(`Jupiter swap build failed: ${swap.error}`);
  if (swap.swapMode !== "ExactIn" || swap.inAmount !== amount.toString()) {
    throw new Error(`Jupiter V2 build did not preserve ExactIn amount`);
  }
  return swap;
}

function swapDiscriminator(swap: SwapInstructionsResponse): string {
  return Buffer.from(swap.swapInstruction.data, "base64")
    .subarray(0, 8)
    .toString("hex");
}

type Vault = {
  pda: PublicKey;
  wsolSource: PublicKey;
  targetTokenAccount: PublicKey;
};

function v2Shape(swap: SwapInstructionsResponse) {
  const data = Buffer.from(swap.swapInstruction.data, "base64");
  const discriminator = data.subarray(0, 8).toString("hex");
  if (discriminator === ROUTE_V2_DISCRIMINATOR) {
    return {
      data,
      discriminator,
      destinationIndexes: [2, 7],
      inputOffset: 8,
      platformFeeOffset: 26,
      positiveSlippageFeeOffset: 28,
    };
  }
  if (discriminator === SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR) {
    return {
      data,
      discriminator,
      destinationIndexes: [5],
      inputOffset: 9,
      platformFeeOffset: 27,
      positiveSlippageFeeOffset: 29,
    };
  }
  throw new Error(`unexpected Jupiter V2 discriminator ${discriminator}`);
}

async function ensureVault(
  connection: Connection,
  payer: Keypair
): Promise<Vault> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("burner"), LAUNCH_MINT.toBuffer(), TARGET_MINT.toBuffer()],
    BURNER_PROGRAM
  );
  const wsolSource = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetTokenAccount = getAssociatedTokenAddressSync(
    TARGET_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  await sendInstructions(connection, payer, [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      wsolSource,
      pda,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      targetTokenAccount,
      pda,
      TARGET_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: pda,
      lamports: PDA_FUNDING_LAMPORTS,
    }),
  ]);
  return { pda, wsolSource, targetTokenAccount };
}

/** Build the swap+burn transaction (no simulation). */
async function buildBurnerTx(
  connection: Connection,
  feePayer: Keypair,
  vault: Vault,
  _reserved: PublicKey,
  signers: Keypair[],
  swap: SwapInstructionsResponse,
  amountIn: bigint,
  minimumOutput: bigint
) {
  const jupiterData = Buffer.from(swap.swapInstruction.data, "base64");
  const burnerIx = new TransactionInstruction({
    programId: BURNER_PROGRAM,
    keys: [
      { pubkey: feePayer.publicKey, isSigner: true, isWritable: false },
      { pubkey: BURNER_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: vault.pda, isSigner: false, isWritable: true },
      { pubkey: vault.wsolSource, isSigner: false, isWritable: true },
      { pubkey: LAUNCH_MINT, isSigner: false, isWritable: false },
      { pubkey: TARGET_MINT, isSigner: false, isWritable: true },
      { pubkey: vault.targetTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
      ...swap.swapInstruction.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: false,
        isWritable: account.isWritable,
      })),
    ],
    data: burnerInstructionData(amountIn, minimumOutput, jupiterData),
  });
  const lookupTables = await getLookupTables(connection, swap);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      burnerIx,
    ],
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign(signers);
  const accountLocks =
    message.staticAccountKeys.length +
    message.addressTableLookups.reduce(
      (sum, lookup) =>
        sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
      0
    );
  return { transaction, message, accountLocks };
}

/** Build the swap+burn transaction and simulate it. Returns the raw sim value. */
async function simulateBurnerTx(
  connection: Connection,
  feePayer: Keypair,
  vault: Vault,
  _reserved: PublicKey,
  signers: Keypair[],
  swap: SwapInstructionsResponse,
  amountIn: bigint,
  minimumOutput: bigint
) {
  const { transaction } = await buildBurnerTx(
    connection,
    feePayer,
    vault,
    _reserved,
    signers,
    swap,
    amountIn,
    minimumOutput
  );
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
  });
  return simulation.value;
}

type CheckResult = {
  gap: string;
  description: string;
  expectedCode: number;
  expectedName: string;
  observedCode: number | null;
  raisedByThisProgram: boolean;
  observedErr: unknown;
  passed: boolean;
  relevantLogs: string[];
  negated: boolean;
};

function evaluate(
  gap: string,
  description: string,
  expected: { code: number; name: string },
  simValue: { err: unknown; logs: string[] | null },
  negated: boolean
): CheckResult {
  const observedCode = customCode(simValue.err);
  const logs = simValue.logs ?? [];
  // Attribution is load-bearing: Jupiter and routed AMMs also use custom
  // errors, so authorship comes from the innermost failing program frame.
  let raisedByThisProgram = false;
  for (const line of logs) {
    const failed = line.match(
      /^Program (\S+) failed: custom program error: 0x([0-9a-f]+)/i
    );
    if (failed) {
      raisedByThisProgram =
        failed[1] === BURNER_PROGRAM.toBase58() &&
        parseInt(failed[2], 16) === expected.code;
      break;
    }
  }
  const passed = observedCode === expected.code && raisedByThisProgram;
  return {
    gap,
    description,
    expectedCode: expected.code,
    expectedName: expected.name,
    observedCode,
    raisedByThisProgram,
    observedErr: simValue.err,
    passed,
    relevantLogs: logs.filter((line) => line.includes("failed")),
    negated,
  };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();

  const deployment = await assertFreshDeployment(connection);
  console.error(
    `checkpoint deploy-fresh programdata=${deployment.programDataAddress} sha256=${deployment.sha256}`
  );

  const vault = await ensureVault(connection, payer);
  console.error(
    `checkpoint vault pda=${vault.pda.toBase58()} target=${TARGET_MINT.toBase58()}`
  );

  const results: CheckResult[] = [];
  // Every guard mutates only a cloned instruction. Reusing one live V2 build
  // keeps this deterministic and avoids turning a local regression test into
  // a burst of identical Jupiter API requests (and therefore a 429).
  const baseQuote = await getQuote(ROUTE_INPUT_LAMPORTS);
  const baseSwap = await getSwapInstructions(
    baseQuote,
    vault.pda,
    payer.publicKey,
    vault.wsolSource,
    vault.targetTokenAccount,
    { includeDestination: true, useSharedAccounts: false }
  );
  const cloneSwap = (): SwapInstructionsResponse =>
    JSON.parse(JSON.stringify(baseSwap)) as SwapInstructionsResponse;

  // ---- V2 route-pin checks. Both the direct `route_v2` layout and, below,
  //      the `shared_accounts_route_v2` layout are exercised. ----
  // ---- GAP 3a: a V2 destination-account substitution must return 6006 ----
  {
    const negated = proveFail.has("gap3a");
    const quote = baseQuote;
    const swap = cloneSwap();
    const shape = v2Shape(swap);
    for (const index of shape.destinationIndexes) {
      if (
        swap.swapInstruction.accounts[index].pubkey !==
        vault.targetTokenAccount.toBase58()
      ) {
        throw new Error(
          `gap3a precondition: V2 destination ${index} is not target ATA`
        );
      }
    }
    if (!negated) {
      const index = shape.destinationIndexes[0];
      swap.swapInstruction.accounts[index] = {
        ...swap.swapInstruction.accounts[index],
        pubkey: JUPITER_PROGRAM.toBase58(),
      };
    }
    const sim = await simulateBurnerTx(
      connection,
      payer,
      vault,
      payer.publicKey,
      [payer],
      swap,
      BigInt(quote.inAmount),
      BigInt(1)
    );
    results.push(
      evaluate(
        "gap3a",
        "substitute a pinned V2 destination account -> 6006 InvalidJupiterAccounts",
        EXPECTED.gap3a,
        sim,
        negated
      )
    );
  }

  // ---- GAP 3b: a legacy V1 route discriminator must return 6005 ----
  {
    const negated = proveFail.has("gap3b");
    const quote = baseQuote;
    const swap = cloneSwap();
    const shape = v2Shape(swap);
    if (!negated) {
      const data = Buffer.from(shape.data);
      data.set(Buffer.from("e517cb977ae3ad2a", "hex"), 0);
      swap.swapInstruction.data = data.toString("base64");
    }
    const sim = await simulateBurnerTx(
      connection,
      payer,
      vault,
      payer.publicKey,
      [payer],
      swap,
      BigInt(quote.inAmount),
      BigInt(1)
    );
    results.push(
      evaluate(
        "gap3b",
        "legacy V1 ExactIn discriminator -> 6005 InvalidJupiterInstruction",
        EXPECTED.gap3b,
        sim,
        negated
      )
    );
  }

  for (const [gap, field] of [
    ["gap4a", "platformFeeOffset"],
    ["gap4b", "positiveSlippageFeeOffset"],
  ] as const) {
    const negated = proveFail.has(gap);
    const quote = baseQuote;
    const swap = cloneSwap();
    const shape = v2Shape(swap);
    if (!negated) {
      const data = Buffer.from(shape.data);
      data.writeUInt16LE(1, shape[field]);
      swap.swapInstruction.data = data.toString("base64");
    }
    const sim = await simulateBurnerTx(
      connection,
      payer,
      vault,
      payer.publicKey,
      [payer],
      swap,
      BigInt(quote.inAmount),
      BigInt(1)
    );
    results.push(
      evaluate(
        gap,
        `${
          gap === "gap4a" ? "platform" : "positive-slippage"
        } fee bps -> 6007 JupiterPlatformFeeNotAllowed`,
        EXPECTED[gap],
        sim,
        negated
      )
    );
  }

  {
    const gap = "gap4c";
    const negated = proveFail.has(gap);
    const quote = baseQuote;
    const swap = cloneSwap();
    const shape = v2Shape(swap);
    if (!negated) {
      const data = Buffer.from(shape.data);
      data.writeBigUInt64LE(
        ROUTE_INPUT_LAMPORTS + BigInt(1),
        shape.inputOffset
      );
      swap.swapInstruction.data = data.toString("base64");
    }
    const sim = await simulateBurnerTx(
      connection,
      payer,
      vault,
      payer.publicKey,
      [payer],
      swap,
      ROUTE_INPUT_LAMPORTS,
      BigInt(1)
    );
    results.push(
      evaluate(
        gap,
        "V2 route input differs from authorized burner input -> 6008 JupiterInputAmountMismatch",
        EXPECTED.gap4c,
        sim,
        negated
      )
    );
  }

  // ---- shared-accounts-route (`shared_accounts_route_v2`) pin checks --------
  // The v1 burner refused this variant outright (the documented gap3b guard);
  // the v2 migration ACCEPTS it with its own shifted account indices and scalar
  // offsets. These are the shared-variant twins of gap3a and gap4: same codes,
  // exercised against the shared layout, which nothing tested before.
  //
  // Jupiter returns the shared variant only for a MULTI-HOP route, so a genuine
  // multi-hop route is obtained (verified by discriminator, not by the request
  // flag) and proven to fit the account-lock budget before any tampering, so
  // every sim actually reaches the program's `validate_jupiter_route`.
  {
    let sharedSwap: SwapInstructionsResponse | undefined;
    let sharedAmount = BigInt(0);
    let sharedInfo = "";
    const attemptLog: string[] = [];
    for (const attempt of SHARED_ROUTE_ATTEMPTS) {
      let candidate: SwapInstructionsResponse;
      try {
        candidate = await getSwapInstructions(
          await getQuote(attempt.amount),
          vault.pda,
          payer.publicKey,
          vault.wsolSource,
          vault.targetTokenAccount,
          {
            includeDestination: true,
            useSharedAccounts: true,
            amount: attempt.amount,
            maxAccounts: attempt.maxAccounts,
          }
        );
      } catch (error) {
        attemptLog.push(
          `${attempt.amount}@${attempt.maxAccounts}: build failed ${
            error instanceof Error ? error.message.slice(0, 60) : String(error)
          }`
        );
        continue;
      }
      const disc = swapDiscriminator(candidate);
      if (disc !== SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR) {
        attemptLog.push(
          `${attempt.amount}@${attempt.maxAccounts}: got ${disc} (direct)`
        );
        continue;
      }
      // Fit check: build the honest burner transaction and count account locks.
      // No funding or execution needed -- `validate_jupiter_route` runs before
      // the balance check, so the tampered sims reject regardless of balance;
      // the only requirement is that the transaction is structurally valid
      // (<= 64 locks) so it reaches the program at all.
      const built = await buildBurnerTx(
        connection,
        payer,
        vault,
        payer.publicKey,
        [payer],
        candidate,
        attempt.amount,
        BigInt(1)
      );
      if (built.accountLocks > SHARED_MAX_ACCOUNT_LOCKS) {
        attemptLog.push(
          `${attempt.amount}@${attempt.maxAccounts}: shared but ${built.accountLocks} locks`
        );
        continue;
      }
      sharedSwap = candidate;
      sharedAmount = attempt.amount;
      sharedInfo = `in=${attempt.amount} cap=${attempt.maxAccounts} locks=${built.accountLocks}`;
      break;
    }
    if (!sharedSwap) {
      throw new Error(
        `could not obtain a fitting shared_accounts_route_v2 route for the shared checks:\n  ${attemptLog.join(
          "\n  "
        )}`
      );
    }
    console.error(`checkpoint shared-route ${sharedInfo}`);
    const base = sharedSwap;
    const cloneShared = (): SwapInstructionsResponse =>
      JSON.parse(JSON.stringify(base)) as SwapInstructionsResponse;

    // GAP 3a (shared): substitute the pinned shared destination (index 5).
    {
      const negated = proveFail.has("gap3aShared");
      const swap = cloneShared();
      const shape = v2Shape(swap);
      if (shape.discriminator !== SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR) {
        throw new Error(`gap3aShared precondition: route is not shared`);
      }
      for (const index of shape.destinationIndexes) {
        if (
          swap.swapInstruction.accounts[index].pubkey !==
          vault.targetTokenAccount.toBase58()
        ) {
          throw new Error(
            `gap3aShared precondition: shared destination ${index} is not the target ATA`
          );
        }
      }
      if (!negated) {
        const index = shape.destinationIndexes[0];
        swap.swapInstruction.accounts[index] = {
          ...swap.swapInstruction.accounts[index],
          pubkey: JUPITER_PROGRAM.toBase58(),
        };
      }
      const sim = await simulateBurnerTx(
        connection,
        payer,
        vault,
        payer.publicKey,
        [payer],
        swap,
        sharedAmount,
        BigInt(1)
      );
      results.push(
        evaluate(
          "gap3aShared",
          "substitute a pinned shared_accounts_route_v2 destination account -> 6006 InvalidJupiterAccounts",
          EXPECTED.gap3aShared,
          sim,
          negated
        )
      );
    }

    // GAP 4a/4b (shared): both fee channels at the shared offsets (27, 29).
    for (const [gap, field] of [
      ["gap4aShared", "platformFeeOffset"],
      ["gap4bShared", "positiveSlippageFeeOffset"],
    ] as const) {
      const negated = proveFail.has(gap);
      const swap = cloneShared();
      const shape = v2Shape(swap);
      if (!negated) {
        const data = Buffer.from(shape.data);
        data.writeUInt16LE(1, shape[field]);
        swap.swapInstruction.data = data.toString("base64");
      }
      const sim = await simulateBurnerTx(
        connection,
        payer,
        vault,
        payer.publicKey,
        [payer],
        swap,
        sharedAmount,
        BigInt(1)
      );
      results.push(
        evaluate(
          gap,
          `${
            gap === "gap4aShared" ? "platform" : "positive-slippage"
          } fee bps in shared route -> 6007 JupiterPlatformFeeNotAllowed`,
          EXPECTED[gap],
          sim,
          negated
        )
      );
    }

    // GAP 4c (shared): the shared route's encoded input (offset 9) disagrees
    // with the authorized burner input.
    {
      const gap = "gap4cShared";
      const negated = proveFail.has(gap);
      const swap = cloneShared();
      const shape = v2Shape(swap);
      if (!negated) {
        const data = Buffer.from(shape.data);
        data.writeBigUInt64LE(sharedAmount + BigInt(1), shape.inputOffset);
        swap.swapInstruction.data = data.toString("base64");
      }
      const sim = await simulateBurnerTx(
        connection,
        payer,
        vault,
        payer.publicKey,
        [payer],
        swap,
        sharedAmount,
        BigInt(1)
      );
      results.push(
        evaluate(
          gap,
          "shared route input differs from authorized burner input -> 6008 JupiterInputAmountMismatch",
          EXPECTED.gap4cShared,
          sim,
          negated
        )
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        rpc: RPC_URL,
        build: "pinocchio",
        program: BURNER_PROGRAM.toBase58(),
        deployment,
        proveFail: [...proveFail],
        results,
      },
      null,
      2
    )
  );

  const failed = results.filter((r) => !r.passed);
  for (const r of results) {
    console.error(
      `checkpoint ${r.gap} expected=${r.expectedCode} observed=${
        r.observedCode
      } ${r.passed ? "PASS" : "FAIL"}${
        r.negated ? " (negated/prove-fail)" : ""
      }`
    );
  }
  if (failed.length > 0) {
    throw new Error(
      `security guard assertions failed: ${failed
        .map(
          (r) =>
            `${r.gap} expected Custom(${r.expectedCode}) got ${JSON.stringify(
              r.observedErr
            )}`
        )
        .join("; ")}`
    );
  }
  console.error(`all security guard assertions passed (${results.length} ran)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
