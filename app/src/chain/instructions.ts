import { Buffer } from "buffer";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ERROR_NAMES,
  MAX_TRANSACTION_BYTES,
  PROGRAM,
  VALIDATE_CONFIG_DISCRIMINATOR,
} from "./constants";
import { deriveSplitPda, Leg } from "./derive";

/** A leg with its token program and vault ATA resolved from the chain. */
export type ResolvedLeg = Leg & {
  tokenProgram: PublicKey;
  ata: PublicKey;
  /**
   * KEYLESS: the leg's reference block for `validate_config` Mode A — the
   * same four accounts the burn carries at leg offsets +3..+6. `pool` is
   * the reference account itself (the bonding curve, or the bound pool);
   * for a Pump curve the curve is its own vault pair.
   */
  referenceBlock?: {
    pool: PublicKey;
    vaultA: PublicKey;
    vaultB: PublicKey;
    feeSource: PublicKey;
  };
};

export async function resolveLegs(
  connection: Connection,
  pda: PublicKey,
  legs: Leg[]
): Promise<ResolvedLeg[]> {
  const infos = await connection.getMultipleAccountsInfo(
    legs.map((l) => l.mint),
    "confirmed"
  );
  return legs.map((leg, i) => {
    const tokenProgram = infos[i]?.owner ?? TOKEN_PROGRAM_ID;
    return {
      ...leg,
      tokenProgram,
      ata: getAssociatedTokenAddressSync(leg.mint, pda, true, tokenProgram),
    };
  });
}

export function vaultWsolAta(pda: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(NATIVE_MINT, pda, true, TOKEN_PROGRAM_ID);
}

/**
 * KEYLESS `validate_config` Mode A (0x00) — the full pre-funding probe,
 * exactly as `bound_mode_a` decodes it: discriminator, mode byte, `u32` leg
 * count, one `u16` weight per leg, then one `u64` probe amount per leg (the
 * intended per-leg burn size — the handler runs the burn's own
 * `keyless_leg_floor` at that size, so a reference that cannot price a burn
 * fails HERE, before anything is funded, with the exact code a burn would
 * produce: 6039/6040/6041/6002). Accounts: burn_pda, wsol_ata, launch_mint,
 * then the burn's own 7-account leg block (mint, ata, token_program,
 * reference, vault A, vault B, fee source) — ALL read-only, no signer.
 */
export function buildValidateConfigModeA(
  pda: PublicKey,
  launchMint: PublicKey,
  legs: ResolvedLeg[],
  probeAmounts: bigint[]
): TransactionInstruction {
  const body = Buffer.alloc(1 + 4 + 2 * legs.length + 8 * legs.length);
  body.writeUInt8(0x00, 0);
  body.writeUInt32LE(legs.length, 1);
  legs.forEach((leg, i) => body.writeUInt16LE(leg.bps, 5 + 2 * i));
  probeAmounts.forEach((amount, i) =>
    body.writeBigUInt64LE(amount, 5 + 2 * legs.length + 8 * i)
  );
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: false },
      { pubkey: vaultWsolAta(pda), isSigner: false, isWritable: false },
      { pubkey: launchMint, isSigner: false, isWritable: false },
      ...legs.flatMap((leg) => {
        if (!leg.referenceBlock) {
          throw new Error(
            `leg ${leg.mint.toBase58()} has no resolved reference block; Mode A validation needs one`
          );
        }
        return [
          { pubkey: leg.mint, isSigner: false, isWritable: false },
          { pubkey: leg.ata, isSigner: false, isWritable: false },
          { pubkey: leg.tokenProgram, isSigner: false, isWritable: false },
          { pubkey: leg.referenceBlock.pool, isSigner: false, isWritable: false },
          { pubkey: leg.referenceBlock.vaultA, isSigner: false, isWritable: false },
          { pubkey: leg.referenceBlock.vaultB, isSigner: false, isWritable: false },
          { pubkey: leg.referenceBlock.feeSource, isSigner: false, isWritable: false },
        ];
      }),
    ],
    data: Buffer.concat([VALIDATE_CONFIG_DISCRIMINATOR, body]),
  });
}

/** Idempotent creates for the vault's WSOL ATA plus every target ATA. */
export function buildAtaInstructions(
  payer: PublicKey,
  pda: PublicKey,
  legs: ResolvedLeg[]
): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      vaultWsolAta(pda),
      pda,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    ),
    ...legs.map((leg) =>
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        leg.ata,
        pda,
        leg.mint,
        leg.tokenProgram
      )
    ),
  ];
}

export type PlannedTransaction = {
  label: string;
  instructions: TransactionInstruction[];
  /** Serialized v0 size with a placeholder blockhash, for the wire budget. */
  bytes: number;
};

function measure(payer: PublicKey, instructions: TransactionInstruction[]): number {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  try {
    return new VersionedTransaction(message).serialize().length;
  } catch {
    return MAX_TRANSACTION_BYTES + 1;
  }
}

/**
 * Plan the vault setup for a config that must also commit a Pump fee share.
 *
 * A Pump fee share is IMMUTABLE once set (every re-point is refused with
 * 0x1779) — the creator gets exactly one shot. The preferred grouping
 * [createFeeSharingConfig][updateFeeSharesV2][validate_config Mode A]
 * [create ATAs] fits the 1232-byte wire limit at 1–2 legs. When it does
 * not, Mode B used to sit next to the fee share as a fake gate: it could
 * approve a different address than Mode A proved (RT8). Mode B is deleted.
 * The fallback is two transactions: Mode A + ATAs first, then the fee
 * share pointed at the PDA Mode A already proved. Cost is one extra
 * setup transaction, once.
 */
export function planSetupWithFeeShare(
  payer: PublicKey,
  feeShareInstructions: TransactionInstruction[],
  validateModeA: TransactionInstruction,
  ataInstructions: TransactionInstruction[]
): { atomic: boolean; transactions: PlannedTransaction[] } {
  const atomicInstructions = [
    ...feeShareInstructions,
    validateModeA,
    ...ataInstructions,
  ];
  const atomicBytes = measure(payer, atomicInstructions);
  if (atomicBytes <= MAX_TRANSACTION_BYTES) {
    return {
      atomic: true,
      transactions: [
        {
          label: "fee share + validate (Mode A) + create ATAs (atomic)",
          instructions: atomicInstructions,
          bytes: atomicBytes,
        },
      ],
    };
  }
  const setup = [validateModeA, ...ataInstructions];
  return {
    atomic: false,
    transactions: [
      {
        label: "validate (Mode A probe) + create ATAs",
        instructions: setup,
        bytes: measure(payer, setup),
      },
      {
        label: "fee share (PDA already proven by Mode A)",
        instructions: feeShareInstructions,
        bytes: measure(payer, feeShareInstructions),
      },
    ],
  };
}

/** Flow B setup: [validate_config][create ATAs] in one transaction. */
export function planSetupOnly(
  payer: PublicKey,
  validateInstruction: TransactionInstruction,
  ataInstructions: TransactionInstruction[]
): PlannedTransaction {
  const instructions = [validateInstruction, ...ataInstructions];
  return {
    label: "validate + create ATAs (atomic)",
    instructions,
    bytes: measure(payer, instructions),
  };
}

// ---------------------------------------------------------------------------
// Failure attribution — port of attributeFailure from surfpool-split-e2e.ts
// ---------------------------------------------------------------------------

export type Attribution = {
  code?: number;
  programId?: string;
  isBurner: boolean;
  name?: string;
};

export function attributeFailure(
  logs: string[] | null | undefined,
  fallback: unknown
): Attribution {
  for (const line of logs ?? []) {
    const failed = line.match(
      /^Program (\S+) failed: custom program error: 0x([0-9a-f]+)/i
    );
    if (failed) {
      const code = parseInt(failed[2], 16);
      const isBurner = failed[1] === PROGRAM.toBase58();
      return {
        code,
        programId: failed[1],
        isBurner,
        name: isBurner ? ERROR_NAMES[code] : undefined,
      };
    }
  }
  const text = JSON.stringify(fallback ?? "");
  const match =
    text.match(/"Custom":\s*(\d+)/) ??
    text.match(/custom program error: 0x([0-9a-f]+)/i);
  const code = match
    ? match[0].includes("0x")
      ? parseInt(match[1], 16)
      : Number(match[1])
    : undefined;
  // No `Program ... failed` frame: authorship is UNKNOWN, never claimed ours.
  return { code, programId: undefined, isBurner: false };
}

/**
 * Simulate `validate_config` — the deployed burner's OWN admission verdict
 * for this configuration, with nothing signed and nothing spent. Resolves
 * token programs and ATAs itself, against the PDA THIS config derives:
 * ATAs computed against any other vault would fail 6014 for the wrong
 * reason.
 *
 * KEYLESS: Mode A is the only `validate_config`. Every leg must carry a
 * resolved reference block and a probe amount so the price-floor gates
 * (6039/6040/6041/6002) actually run. Missing those is not a bind-only
 * fallback — Mode B was deleted (RT8).
 */
export async function simulateValidateConfig(
  connection: Connection,
  feePayer: PublicKey,
  launchMint: PublicKey,
  rawLegs: (Leg & {
    referenceBlock?: ResolvedLeg["referenceBlock"];
  })[],
  probeAmounts?: bigint[]
): Promise<{ ok: boolean; skipped?: boolean } & Attribution> {
  const [pda] = deriveSplitPda(launchMint, rawLegs);
  const legs = (await resolveLegs(connection, pda, rawLegs)).map(
    (leg, index) => ({ ...leg, referenceBlock: rawLegs[index].referenceBlock })
  );
  const modeA =
    probeAmounts !== undefined && legs.every((leg) => leg.referenceBlock);
  if (!modeA) {
    return {
      ok: false,
      skipped: true,
      isBurner: false,
      name: "Mode A requires resolved reference blocks",
    };
  }
  const instruction = buildValidateConfigModeA(
    pda,
    launchMint,
    legs,
    probeAmounts
  );
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      instruction,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (!simulation.value.err) return { ok: true, isBurner: false };
  return {
    ok: false,
    ...attributeFailure(simulation.value.logs, simulation.value.err),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export class SetupError extends Error {
  attribution: Attribution;
  logs: string[];
  constructor(message: string, attribution: Attribution, logs: string[]) {
    super(message);
    this.attribution = attribution;
    this.logs = logs;
  }
}

export type SignerLike = {
  publicKey: PublicKey;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
};

/** Compile, sign (wallet + any extra keypairs), send, confirm. Failures are
 * attributed to the program that raised them and thrown as SetupError. */
export async function sendWithWallet(
  connection: Connection,
  wallet: SignerLike,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = []
): Promise<string> {
  const validity = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: validity.blockhash,
    instructions,
  }).compileToV0Message();
  let transaction = new VersionedTransaction(message);
  if (extraSigners.length) transaction.sign(extraSigners);
  transaction = await wallet.signTransaction(transaction);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
    });
  } catch (error) {
    const logs: string[] =
      (error as { logs?: string[] }).logs ??
      (typeof (error as { getLogs?: unknown }).getLogs === "function"
        ? await (error as { getLogs: (c: Connection) => Promise<string[]> }).getLogs(connection).catch(() => [])
        : []);
    const attribution = attributeFailure(logs, String(error));
    throw new SetupError(
      attribution.code !== undefined
        ? `rejected with code ${attribution.code}${attribution.name ? ` ${attribution.name}` : ""}`
        : String((error as Error).message ?? error).slice(0, 300),
      attribution,
      logs.slice(-8)
    );
  }
  const confirmed = await connection.confirmTransaction(
    {
      signature,
      blockhash: validity.blockhash,
      lastValidBlockHeight: validity.lastValidBlockHeight,
    },
    "confirmed"
  );
  if (confirmed.value.err) {
    const landed = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = landed?.meta?.logMessages ?? [];
    const attribution = attributeFailure(logs, confirmed.value.err);
    throw new SetupError(
      `transaction ${signature.slice(0, 8)}… failed on chain`,
      attribution,
      logs.slice(-8)
    );
  }
  return signature;
}
