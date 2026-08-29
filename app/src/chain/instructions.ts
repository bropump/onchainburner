import { Buffer } from "buffer";
import {
  AddressLookupTableAccount,
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
  TOKEN_2022_PROGRAM_ID,
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
  legs: Leg[],
  pendingToken2022Mints: ReadonlySet<string> = new Set()
): Promise<ResolvedLeg[]> {
  const infos = await connection.getMultipleAccountsInfo(
    legs.map((l) => l.mint),
    "confirmed"
  );
  return legs.map((leg, i) => {
    const tokenProgram = pendingToken2022Mints.has(leg.mint.toBase58())
      ? TOKEN_2022_PROGRAM_ID
      : infos[i]?.owner ?? TOKEN_PROGRAM_ID;
    return {
      ...leg,
      tokenProgram,
      ata: getAssociatedTokenAddressSync(leg.mint, pda, true, tokenProgram),
    };
  });
}

export function vaultWsolAta(pda: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
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
          {
            pubkey: leg.referenceBlock.pool,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: leg.referenceBlock.vaultA,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: leg.referenceBlock.vaultB,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: leg.referenceBlock.feeSource,
            isSigner: false,
            isWritable: false,
          },
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
  lookupTables: AddressLookupTableAccount[];
  /** Serialized v0 size with a placeholder blockhash, for the wire budget. */
  bytes: number;
};

export function measureTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = []
): number {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(lookupTables);
  const shortVecBytes = (value: number) => {
    let bytes = 1;
    while (value >= 128) {
      value = Math.floor(value / 128);
      bytes++;
    }
    return bytes;
  };
  // web3.js allocates only PACKET_DATA_SIZE while serializing, so an
  // oversized message throws before revealing its real size. Calculate the
  // v0 wire layout directly; this is also exact for messages over 1,232.
  let messageBytes =
    1 + // version prefix
    3 + // message header
    shortVecBytes(message.staticAccountKeys.length) +
    32 * message.staticAccountKeys.length +
    32 + // recent blockhash
    shortVecBytes(message.compiledInstructions.length);
  for (const instruction of message.compiledInstructions) {
    messageBytes +=
      1 +
      shortVecBytes(instruction.accountKeyIndexes.length) +
      instruction.accountKeyIndexes.length +
      shortVecBytes(instruction.data.length) +
      instruction.data.length;
  }
  messageBytes += shortVecBytes(message.addressTableLookups.length);
  for (const lookup of message.addressTableLookups) {
    messageBytes +=
      32 +
      shortVecBytes(lookup.writableIndexes.length) +
      lookup.writableIndexes.length +
      shortVecBytes(lookup.readonlyIndexes.length) +
      lookup.readonlyIndexes.length;
  }
  const signatures = message.header.numRequiredSignatures;
  return shortVecBytes(signatures) + 64 * signatures + messageBytes;
}

/**
 * Plan the vault setup for a config that must also commit a Pump fee share.
 *
 * A Pump fee share is IMMUTABLE once set (every re-point is refused with
 * 0x1779) — the creator gets exactly one shot. The preferred grouping
 * [createFeeSharingConfig][updateFeeSharesV2][validate_config Mode A]
 * [create ATAs] fits at two legs when compiled with the verified shared
 * setup ALT. Mode B used to sit next to the fee share as a fake gate: it
 * could approve a different address than Mode A proved (RT8), so it remains
 * deleted. If the full grouping does not fit, the fallback repeats Mode A in
 * the fee-share transaction. If even that cannot fit, planning fails before
 * the launch's first signature; validation is never silently omitted.
 */
export function planSetupWithFeeShare(
  payer: PublicKey,
  feeShareInstructions: TransactionInstruction[],
  validateModeA: TransactionInstruction,
  ataInstructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = []
): { atomic: boolean; transactions: PlannedTransaction[] } {
  const atomicInstructions = [
    ...feeShareInstructions,
    validateModeA,
    ...ataInstructions,
  ];
  const atomicBytes = measureTransaction(
    payer,
    atomicInstructions,
    lookupTables
  );
  if (atomicBytes <= MAX_TRANSACTION_BYTES) {
    return {
      atomic: true,
      transactions: [
        {
          label: "fee share + validate (Mode A) + create ATAs (atomic)",
          instructions: atomicInstructions,
          lookupTables,
          bytes: atomicBytes,
        },
      ],
    };
  }
  const setup = [validateModeA, ...ataInstructions];
  // The fee share is immutable. Re-run the full on-chain verdict in the SAME
  // transaction that commits it; a previously successful simulation or
  // transaction is not a substitute. If this guarded fallback cannot fit,
  // refuse before the launch's first signature instead of silently dropping
  // validate_config (the bug that left the observed flow at three prompts).
  const guardedFeeShare = [...feeShareInstructions, validateModeA];
  const guardedFeeShareBytes = measureTransaction(
    payer,
    guardedFeeShare,
    lookupTables
  );
  if (guardedFeeShareBytes > MAX_TRANSACTION_BYTES) {
    throw new Error(
      `fee share + repeated validate_config is ${guardedFeeShareBytes} bytes; ` +
        "the verified shared setup lookup table is required"
    );
  }
  return {
    atomic: false,
    transactions: [
      {
        label: "validate (Mode A probe) + create ATAs",
        instructions: setup,
        lookupTables,
        bytes: measureTransaction(payer, setup, lookupTables),
      },
      {
        label: "fee share + repeated validate (Mode A)",
        instructions: guardedFeeShare,
        lookupTables,
        bytes: guardedFeeShareBytes,
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
    lookupTables: [],
    bytes: measureTransaction(payer, instructions),
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

/**
 * Confirm over HTTP only, by polling `getSignatureStatuses` until the
 * signature is confirmed or its blockhash expires.
 *
 * `connection.confirmTransaction` cannot be used here. It subscribes to
 * `signatureSubscribe` over a WebSocket, and web3.js derives that endpoint
 * from the HTTP one — so against the same-origin `/rpc` proxy it would dial
 * `wss://<origin>/rpc`, which the Worker does not serve. The subscription
 * never opens, and the call sits there until the block height is exceeded and
 * then reports failure for a transaction that may well have landed. Polling
 * asks the same question over the transport we actually have.
 */
async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number
): Promise<{ value: { err: unknown } }> {
  const POLL_MS = 1000;
  for (;;) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status) {
      const level = status.confirmationStatus;
      if (status.err) return { value: { err: status.err } };
      if (level === "confirmed" || level === "finalized") {
        return { value: { err: null } };
      }
    }
    // A signature the cluster has never seen is only decisive once its
    // blockhash can no longer be accepted; until then it may still land.
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      const late = await connection.getSignatureStatuses([signature]);
      const lateStatus = late.value[0];
      if (lateStatus && !lateStatus.err) return { value: { err: null } };
      return {
        value: {
          err:
            lateStatus?.err ??
            `block height ${height} exceeded ${lastValidBlockHeight} without confirmation`,
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Compile, sign (wallet + any extra keypairs), send, confirm. Failures are
 * attributed to the program that raised them and thrown as SetupError. */
export async function sendWithWallet(
  connection: Connection,
  wallet: SignerLike,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = [],
  lookupTables: AddressLookupTableAccount[] = []
): Promise<string> {
  const validity = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: validity.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
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
        ? await (error as { getLogs: (c: Connection) => Promise<string[]> })
            .getLogs(connection)
            .catch(() => [])
        : []);
    const attribution = attributeFailure(logs, String(error));
    throw new SetupError(
      attribution.code !== undefined
        ? `rejected with code ${attribution.code}${
            attribution.name ? ` ${attribution.name}` : ""
          }`
        : String((error as Error).message ?? error).slice(0, 300),
      attribution,
      logs.slice(-8)
    );
  }
  const confirmed = await confirmByPolling(
    connection,
    signature,
    validity.lastValidBlockHeight
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
