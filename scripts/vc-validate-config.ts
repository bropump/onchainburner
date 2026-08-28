/**
 * Adversarial coverage for the read-only `validate_config` instruction.
 *
 * The instruction runs the burn's OWN admission code against a split
 * configuration before anything is funded, so a launcher cannot strand SOL on
 * a vault that can never burn. This suite proves, on the fork:
 *
 *   (a) a known-good 3-leg config validates;
 *   (b) every rejection class returns the exact expected code, ATTRIBUTED TO
 *       THE BURNER via the innermost `Program <id> failed` log frame;
 *   (c) the atomic setup flow works: `[validate_config, create ATAs..,
 *       transfer]` lands for a good config, and for a BAD config the WHOLE
 *       transaction reverts with no ATA created and no SOL moved.
 *
 * A separate file, `vc-consistency.ts`, proves validate_config agrees with a
 * real burn in both directions.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  attributeFailure,
  deriveSplitPda,
  ERROR_NAMES,
  PROGRAM,
  readPayer,
  RPC_URL,
  sendInstructions,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

/** `sha256("global:validate_config")[0..8]` — must match constants.rs. */
const VALIDATE_CONFIG_DISCRIMINATOR = Buffer.from([28, 98, 92, 82, 243, 62, 65, 93]);

const TOKEN_2022_NATIVE_MINT = new PublicKey(
  "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP"
);
/** USDC has a live freeze authority (6036); META has a live mint authority (6037). */
const META = new PublicKey("METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m");
/** A PUMP-mint clone planted at a non-$PUMP address: an inert Token-2022 hook
 * on the wrong identity, the canonical 6024 fixture. Planted by the runner. */
const HOOK_CLONE = new PublicKey("C1oneHookM1nt1111111111111111111111111111112");

export type VCLeg = { mint: PublicKey; bps: number; tokenProgram?: PublicKey };

async function tokenProgramOf(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  return info?.owner ?? TOKEN_PROGRAM_ID;
}

/**
 * Encode the instruction exactly as `validate_config::handler` decodes it:
 * discriminator, `u32` leg count, then one little-endian `u16` weight per leg.
 * Accounts: burn_pda, wsol_ata, launch_mint, then (mint, ata, token_program)
 * per leg — all read-only, no signer.
 */
export function buildValidateConfigInstruction(
  pda: PublicKey,
  launchMint: PublicKey,
  legs: (VCLeg & { tokenProgram: PublicKey; ata: PublicKey })[],
  overrides: {
    weightsOverride?: number[];
    legCountOverride?: number;
    rawData?: Buffer;
    accountTamper?: (keys: any[]) => any[];
  } = {}
): TransactionInstruction {
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  let keys: any[] = [
    { pubkey: pda, isSigner: false, isWritable: false },
    { pubkey: wsolAta, isSigner: false, isWritable: false },
    { pubkey: launchMint, isSigner: false, isWritable: false },
    ...legs.flatMap((leg) => [
      { pubkey: leg.mint, isSigner: false, isWritable: false },
      { pubkey: leg.ata, isSigner: false, isWritable: false },
      { pubkey: leg.tokenProgram, isSigner: false, isWritable: false },
    ]),
  ];
  if (overrides.accountTamper) keys = overrides.accountTamper(keys);

  let data: Buffer;
  if (overrides.rawData) {
    data = overrides.rawData;
  } else {
    const weights = overrides.weightsOverride ?? legs.map((l) => l.bps);
    const legCount = overrides.legCountOverride ?? weights.length;
    const body = Buffer.alloc(4 + 2 * weights.length);
    body.writeUInt32LE(legCount, 0);
    weights.forEach((w, i) => body.writeUInt16LE(w, 4 + 2 * i));
    data = Buffer.concat([VALIDATE_CONFIG_DISCRIMINATOR, body]);
  }
  return new TransactionInstruction({ programId: PROGRAM, keys, data });
}

export async function resolveLegs(
  connection: Connection,
  pda: PublicKey,
  legs: VCLeg[]
): Promise<(VCLeg & { tokenProgram: PublicKey; ata: PublicKey })[]> {
  const out = [];
  for (const leg of legs) {
    const tokenProgram = leg.tokenProgram ?? (await tokenProgramOf(connection, leg.mint));
    out.push({
      ...leg,
      tokenProgram,
      ata: getAssociatedTokenAddressSync(leg.mint, pda, true, tokenProgram),
    });
  }
  return out;
}

export type SimOutcome = {
  accepted: boolean;
  code?: number;
  by: "burner" | "runtime" | string;
};

/**
 * Simulate a single-instruction validate_config transaction and attribute the
 * result. validate_config needs no signer, so the payer alone signs.
 */
export async function simulateValidate(
  connection: Connection,
  payer: Keypair,
  instruction: TransactionInstruction
): Promise<SimOutcome> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      instruction,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const sim = await connection.simulateTransaction(transaction, {
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (!sim.value.err) return { accepted: true, by: "burner" };
  const attributed = attributeFailure(sim.value.logs, sim.value.err);
  return {
    accepted: false,
    code: attributed.code,
    by: attributed.isBurner ? "burner" : attributed.programId ?? "runtime",
  };
}

async function plantHookClone(connection: Connection) {
  const pump = await connection.getAccountInfo(TOKENS.PUMP, "confirmed");
  if (!pump) throw new Error("$PUMP mint missing on fork");
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        HOOK_CLONE.toBase58(),
        {
          lamports: pump.lamports,
          data: pump.data.toString("hex"),
          owner: pump.owner.toBase58(),
        },
      ],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`plant hook clone: ${JSON.stringify(body.error)}`);
}

// A launch namespace (any mint) plus three clean, distinct, burnable targets.
const LAUNCH = TOKENS.FARTCOIN;
const GOOD_LEGS: VCLeg[] = [
  { mint: TOKENS.JTO, bps: 1500 },
  { mint: TOKENS.BONK, bps: 1500 },
  { mint: TOKENS.WIF, bps: 7000 },
];

type Case = {
  name: string;
  expect: number | "accept";
  build: (ctx: Ctx) => Promise<TransactionInstruction>;
};

type Ctx = {
  connection: Connection;
  payer: Keypair;
};

async function goodInstruction(ctx: Ctx): Promise<TransactionInstruction> {
  const [pda] = deriveSplitPda(LAUNCH, GOOD_LEGS);
  const legs = await resolveLegs(ctx.connection, pda, GOOD_LEGS);
  return buildValidateConfigInstruction(pda, LAUNCH, legs);
}

// Each case derives the pda that its OWN config commits to, then mutates one
// thing, so a rejection is attributable to the mutation and not to a stale
// address.
const CASES: Case[] = [
  { name: "good-3-leg", expect: "accept", build: goodInstruction },
  {
    name: "weights-do-not-sum-to-10000",
    expect: 6033,
    build: async (ctx) => {
      const [pda] = deriveSplitPda(LAUNCH, GOOD_LEGS);
      const legs = await resolveLegs(ctx.connection, pda, GOOD_LEGS);
      return buildValidateConfigInstruction(pda, LAUNCH, legs, {
        weightsOverride: [1500, 1500, 6000],
      });
    },
  },
  {
    name: "zero-weight-leg",
    expect: 6033,
    build: async (ctx) => {
      const [pda] = deriveSplitPda(LAUNCH, GOOD_LEGS);
      const legs = await resolveLegs(ctx.connection, pda, GOOD_LEGS);
      return buildValidateConfigInstruction(pda, LAUNCH, legs, {
        weightsOverride: [0, 3000, 7000],
      });
    },
  },
  {
    name: "duplicate-target-mint",
    expect: 6034,
    build: async (ctx) => {
      const dupLegs: VCLeg[] = [
        { mint: TOKENS.JTO, bps: 4000 },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, dupLegs);
      const legs = await resolveLegs(ctx.connection, pda, dupLegs);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
  {
    name: "leg-count-zero",
    expect: 6032,
    build: async (ctx) => {
      const [pda] = deriveSplitPda(LAUNCH, GOOD_LEGS);
      const legs = await resolveLegs(ctx.connection, pda, GOOD_LEGS);
      const raw = Buffer.concat([
        VALIDATE_CONFIG_DISCRIMINATOR,
        Buffer.from(Uint32Array.of(0).buffer),
      ]);
      return buildValidateConfigInstruction(pda, LAUNCH, legs, { rawData: raw });
    },
  },
  {
    name: "leg-count-above-max",
    expect: 6032,
    build: async (ctx) => {
      const [pda] = deriveSplitPda(LAUNCH, GOOD_LEGS);
      const legs = await resolveLegs(ctx.connection, pda, GOOD_LEGS);
      const body = Buffer.alloc(4 + 2 * 5);
      body.writeUInt32LE(5, 0);
      for (let i = 0; i < 5; i += 1) body.writeUInt16LE(2000, 4 + 2 * i);
      return buildValidateConfigInstruction(pda, LAUNCH, legs, {
        rawData: Buffer.concat([VALIDATE_CONFIG_DISCRIMINATOR, body]),
      });
    },
  },
  {
    // The config commits weights [1500,1500,7000] in the pda seeds; the data
    // says [3000,3000,4000], which derives a DIFFERENT address, so the passed
    // burn_pda is not the derivation. This is the whole security property.
    name: "wrong-vault-address-for-config",
    expect: 6012,
    build: async (ctx) => {
      const [pda] = deriveSplitPda(LAUNCH, GOOD_LEGS);
      const legs = await resolveLegs(ctx.connection, pda, GOOD_LEGS);
      return buildValidateConfigInstruction(pda, LAUNCH, legs, {
        weightsOverride: [3000, 3000, 4000],
      });
    },
  },
  {
    name: "freezable-target-usdc",
    expect: 6036,
    build: async (ctx) => {
      const legsSpec: VCLeg[] = [
        { mint: TOKENS.USDC, bps: 4000 },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, legsSpec);
      const legs = await resolveLegs(ctx.connection, pda, legsSpec);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
  {
    name: "mintable-target-meta",
    expect: 6037,
    build: async (ctx) => {
      const legsSpec: VCLeg[] = [
        { mint: META, bps: 4000 },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, legsSpec);
      const legs = await resolveLegs(ctx.connection, pda, legsSpec);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
  {
    name: "disallowed-token2022-extension",
    expect: 6024,
    build: async (ctx) => {
      const legsSpec: VCLeg[] = [
        { mint: HOOK_CLONE, bps: 4000, tokenProgram: TOKEN_2022_PROGRAM_ID },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, legsSpec);
      const legs = await resolveLegs(ctx.connection, pda, legsSpec);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
  {
    // A vault CONFIGURED with a non-mint target: derive the pda from the
    // non-mint address so the seed pin passes and the owner check is reached.
    name: "non-mint-target",
    expect: 6010,
    build: async (ctx) => {
      const nonMint = new PublicKey("SysvarC1ock11111111111111111111111111111111");
      const legsSpec: VCLeg[] = [
        { mint: nonMint, bps: 4000, tokenProgram: TOKEN_PROGRAM_ID },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, legsSpec);
      const legs = await resolveLegs(ctx.connection, pda, legsSpec);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
  {
    name: "wsol-target-native",
    expect: 6038,
    build: async (ctx) => {
      const legsSpec: VCLeg[] = [
        { mint: NATIVE_MINT, bps: 4000, tokenProgram: TOKEN_PROGRAM_ID },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, legsSpec);
      const legs = await resolveLegs(ctx.connection, pda, legsSpec);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
  {
    name: "token2022-native-target",
    expect: 6038,
    build: async (ctx) => {
      const legsSpec: VCLeg[] = [
        { mint: TOKEN_2022_NATIVE_MINT, bps: 4000, tokenProgram: TOKEN_2022_PROGRAM_ID },
        { mint: TOKENS.JTO, bps: 6000 },
      ];
      const [pda] = deriveSplitPda(LAUNCH, legsSpec);
      const legs = await resolveLegs(ctx.connection, pda, legsSpec);
      return buildValidateConfigInstruction(pda, LAUNCH, legs);
    },
  },
];

/** Clone a real mint's bytes to a fresh random address, so the vault it
 * namespaces is provably unused and its ATAs provably absent before the
 * atomic transaction — the "before" half of the no-funds-lost proof only
 * means something on a never-seen vault. `validate_launch_mint` accepts any
 * initialised mint under either token program, so a JTO clone is a valid
 * namespace. */
async function plantFreshNamespace(connection: Connection): Promise<PublicKey> {
  const source = await connection.getAccountInfo(TOKENS.JTO, "confirmed");
  if (!source) throw new Error("JTO mint missing on fork");
  const namespace = Keypair.generate().publicKey;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        namespace.toBase58(),
        {
          lamports: source.lamports,
          data: source.data.toString("hex"),
          owner: source.owner.toBase58(),
        },
      ],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`plant namespace: ${JSON.stringify(body.error)}`);
  return namespace;
}

async function atomicSetupProof(ctx: Ctx) {
  const { connection, payer } = ctx;
  // A fresh launch namespace makes each vault address unused, so its ATAs are
  // provably absent before the transaction and provably created (or not) by
  // it — the whole point of the "no funds lost" proof.
  const namespace = await plantFreshNamespace(connection);

  async function run(label: string, legsSpec: VCLeg[], expectLand: boolean) {
    const [pda] = deriveSplitPda(namespace, legsSpec);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, pda, true, TOKEN_PROGRAM_ID);
    const legs = await resolveLegs(connection, pda, legsSpec);
    const fundLamports = solToLamports("0.05");

    // Snapshot BEFORE.
    const ataAddrs = [wsolAta, ...legs.map((l) => l.ata)];
    const before = {
      vault: await connection.getBalance(pda, "confirmed"),
      atas: await connection.getMultipleAccountsInfo(ataAddrs, "confirmed"),
    };

    const validateIx = buildValidateConfigInstruction(pda, namespace, legs);
    const ataIxs = [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        wsolAta,
        pda,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID
      ),
      ...legs.map((leg) =>
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          leg.ata,
          pda,
          leg.mint,
          leg.tokenProgram
        )
      ),
    ];
    const transferIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: pda,
      lamports: fundLamports,
    });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        validateIx,
        ...ataIxs,
        transferIx,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer]);

    let landed = false;
    let code: number | undefined;
    let by = "runtime";
    try {
      const sig = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const conf = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight },
        "confirmed"
      );
      landed = !conf.value.err;
      if (conf.value.err) {
        const tx = await connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        const attributed = attributeFailure(tx?.meta?.logMessages, conf.value.err);
        code = attributed.code;
        by = attributed.isBurner ? "burner" : attributed.programId ?? "runtime";
      }
    } catch (error) {
      const sim = await connection.simulateTransaction(transaction, { sigVerify: false });
      const attributed = attributeFailure(sim.value.logs, sim.value.err);
      code = attributed.code;
      by = attributed.isBurner ? "burner" : attributed.programId ?? "runtime";
    }

    // Snapshot AFTER.
    const after = {
      vault: await connection.getBalance(pda, "confirmed"),
      atas: await connection.getMultipleAccountsInfo(ataAddrs, "confirmed"),
    };

    const atasBeforeAbsent = before.atas.every((a) => a === null);
    const atasAfterPresent = after.atas.every((a) => a !== null);
    const atasAfterAbsent = after.atas.every((a) => a === null);
    const solMoved = after.vault !== before.vault;

    const pass = expectLand
      ? landed && atasBeforeAbsent && atasAfterPresent && solMoved
      : !landed &&
        by === "burner" &&
        atasBeforeAbsent &&
        atasAfterAbsent &&
        !solMoved;

    return {
      label,
      expectLand,
      landed,
      code,
      codeName: code ? ERROR_NAMES[code] : undefined,
      by,
      before: { vaultLamports: before.vault, atasPresent: before.atas.map((a) => a !== null) },
      after: { vaultLamports: after.vault, atasPresent: after.atas.map((a) => a !== null) },
      pass,
    };
  }

  // Good config: three distinct burnable targets under an unused vault. Bad
  // config: identical but with USDC (freezable) swapped in, so validate_config
  // rejects and the ATAs / transfer that FOLLOW it in the same transaction
  // must never take effect.
  const good = await run(
    "atomic-good-config-lands",
    [
      { mint: TOKENS.BONK, bps: 3000 },
      { mint: TOKENS.WIF, bps: 3000 },
      { mint: TOKENS.RAY, bps: 4000 },
    ],
    true
  );
  const bad = await run(
    "atomic-bad-config-reverts-whole-tx",
    [
      { mint: TOKENS.USDC, bps: 3000 },
      { mint: TOKENS.WIF, bps: 3000 },
      { mint: TOKENS.RAY, bps: 4000 },
    ],
    false
  );
  return [good, bad];
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  await plantHookClone(connection);
  const ctx: Ctx = { connection, payer };

  const results: any[] = [];
  for (const testCase of CASES) {
    const instruction = await testCase.build(ctx);
    const outcome = await simulateValidate(connection, payer, instruction);
    const pass =
      testCase.expect === "accept"
        ? outcome.accepted
        : !outcome.accepted && outcome.by === "burner" && outcome.code === testCase.expect;
    results.push({
      name: testCase.name,
      expect: testCase.expect,
      accepted: outcome.accepted,
      code: outcome.code,
      codeName: outcome.code ? ERROR_NAMES[outcome.code] : undefined,
      by: outcome.by,
      pass,
    });
    process.stderr.write(
      `${pass ? "PASS" : "FAIL"}  ${testCase.name} -> ${
        outcome.accepted ? "ACCEPT" : outcome.code ?? outcome.by
      } (expected ${testCase.expect})\n`
    );
  }

  process.stderr.write("\n-- atomic setup flow --\n");
  const atomic = await atomicSetupProof(ctx);
  for (const outcome of atomic) {
    process.stderr.write(
      `${outcome.pass ? "PASS" : "FAIL"}  ${outcome.label} -> landed=${outcome.landed} ` +
        `by=${outcome.by} code=${outcome.code ?? "-"} ` +
        `atasBefore=${JSON.stringify(outcome.before.atasPresent)} ` +
        `atasAfter=${JSON.stringify(outcome.after.atasPresent)} ` +
        `vault=${outcome.before.vaultLamports}->${outcome.after.vaultLamports}\n`
    );
  }

  console.log(JSON.stringify({ admission: results, atomic }, null, 2));
  const passed = [...results, ...atomic].filter((r) => r.pass).length;
  const total = results.length + atomic.length;
  process.stderr.write(`\n${passed}/${total} validate_config checks passed\n`);
  process.exit(passed === total ? 0 : 1);
}

// Only run when executed directly (`tsx <file>`), so importing the exported
// helpers from another suite does not fire this suite's side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
