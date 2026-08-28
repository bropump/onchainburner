/**
 * Browser client for the burn service.
 *
 * KEYLESS 2026-08-26: there is no quote authority and the service signs
 * nothing. The caller-paid flow is: POST /burn/prepare (semantic request in,
 * the UNSIGNED transaction out with the connected wallet as its ONLY
 * required signer), the wallet signs, then POST /burn/submit relays the
 * fully caller-signed bytes. The browser verifies the prepared transaction
 * is exactly ComputeBudget + burner before asking the wallet to sign — the
 * program enforces everything that matters on chain, this check just keeps a
 * misbehaving service from wasting a wallet prompt.
 *
 * Demo mode still uses the one-shot POST /burn, where the demo service pays.
 */
import { Buffer } from "buffer";
import { ComputeBudgetProgram, VersionedTransaction } from "@solana/web3.js";
import { PROGRAM } from "./constants";
import type { WalletHandle } from "./wallet";

export type ServiceHealth = {
  ok: boolean;
  mode: string;
  slot: number;
  program: string;
  /** Demo service only. Production fee payer is the connected caller. */
  payer?: string;
  /** Honest report of the Jupiter tier the service quotes through. Unkeyed
   * (free tier) rate-limits hard under real use: quotes are spaced and 429s
   * back off, so a multi-leg burn can take minutes. */
  jupiter?: {
    keyed: boolean;
    quoteSpacingMs?: number;
    rateLimitBackoffMs?: number;
  };
};

/** Demo-only Pump bonding-curve state for the trade/graduation UI. */
export type CurveState = {
  exists: boolean;
  complete: boolean;
  realSolLamports: string;
  progressPct: number;
  canonicalPool: string;
  poolExists: boolean;
};

export type BurnRequest = {
  launchMint: string;
  legs: { mint: string; bps: number; reference?: string }[];
  amountInLamports: string;
  /** The vault's creator-owned lookup table(s). Required for a 2+ leg burn:
   * without one the transaction cannot fit Solana's 1232-byte limit. */
  lookupTableAddresses?: string[];
};

export const MAX_METADATA_IMAGE_BYTES = 10_000_000;
export const METADATA_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type MetadataUploadRequest = Readonly<{
  name: string;
  symbol: string;
  description: string;
  image: Uint8Array;
  imageContentType: (typeof METADATA_IMAGE_TYPES)[number];
}>;

export type MetadataUploadReceipt = Readonly<{
  uri: string;
  imageUri: string;
  /** Cloudflare delivery mirror; never the token's permanent URI of record. */
  deliveryImageUri: string;
  originalImageBytes: number;
  imageBytes: number;
}>;

export type BurnReceipt =
  | {
      status: "burned";
      signature: string;
      /** 1 when the first quote landed; >1 when route weather was retried. */
      attempts?: number;
      computeUnits?: number;
      legs: { mint: string; amountIn: string; burned: string }[];
      vaultAfter: string;
    }
  | {
      status: "submitted";
      submissionId: string;
      messageSha256: string;
      simulatedUnits?: number;
      minimumOutputs: readonly string[];
    }
  | {
      status: "rejected";
      signature?: string;
      errorCode?: number;
      rejectedBy:
        | "burner"
        | "external"
        | "service"
        | "service-refused"
        | "deadline";
      /** One plain sentence for the primary view; logsTail is the detail. */
      headline?: string;
      attempts?: number;
      logsTail: string[];
    };

type Preparation = {
  preparationId: string;
  requestId: string;
  vault: string;
  callerPublicKey: string;
  transactionBase64: string;
  messageSha256: string;
  lastValidBlockHeight: number;
  simulatedUnits?: number;
  minimumOutputs?: readonly string[];
};

type SubmissionReceipt = {
  requestId?: string;
  submissionId: string;
  messageSha256: string;
  transactionBytes: number;
};

export class ServiceError extends Error {
  /** True when the service ANSWERED with a refusal (HTTP error + message);
   * false when it could not be reached at all. The vault-page receipt
   * renders these very differently — a refusal must never be presented as
   * "retry when the service is back". */
  refused: boolean;
  /** The service's machine-readable code when it answered with one.
   * EXTERNAL_SIMULATION_FAILURE is Jupiter/AMM route weather — retryable
   * with a fresh quote, never "the service refused". */
  code?: string;
  /** True when the BROWSER abandoned the request at its deadline. The
   * service may still be working: the burn can still land afterwards. */
  timedOut: boolean;
  constructor(
    message: string,
    refused = false,
    code?: string,
    timedOut = false
  ) {
    super(message);
    this.refused = refused;
    this.code = code;
    this.timedOut = timedOut;
  }
}

/** Client-side deadline on a burn request. Measured 2026-08-26 after the
 * service dropped its fixed 6s quote spacing: a multi-leg burn lands in
 * seconds, and the worst honest path (4 fresh-quote attempts, each leg
 * retried through 429 backoff) stays under a minute — so 90s is a generous
 * bound on "still working", not an SLA. On expiry the receipt says plainly
 * that the burn may still land. */
export const BURN_DEADLINE_MS = 90_000;

async function post<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs?: number,
  timeoutMessage?: string
): Promise<T> {
  let response: Response;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new ServiceError(
        timeoutMessage ??
          `the browser stopped waiting after ${Math.round(
            (timeoutMs ?? 0) / 1000
          )}s — the burn service may still be working on this request, and the burn can still land; watch the vault balance before retrying`,
        false,
        undefined,
        true
      );
    }
    throw new ServiceError(`burn service unreachable at ${baseUrl}: ${error}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const payload = (await response.json().catch(() => null)) as
    | (T & { code?: string; message?: string; error?: string })
    | null;
  if (!response.ok || payload === null) {
    throw new ServiceError(
      payload?.message ??
        payload?.error ??
        `service returned HTTP ${response.status}`,
      payload !== null, // the service answered: this is a refusal, not an outage
      payload?.code
    );
  }
  return payload;
}

async function sha256Hex(message: Uint8Array): Promise<string> {
  const copy = new Uint8Array(message);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Buffer.from(digest).toString("hex");
}

function isZeroSignature(signature: Uint8Array): boolean {
  return signature.every((byte) => byte === 0);
}

async function callerPaidBurn(
  baseUrl: string,
  request: BurnRequest,
  wallet: WalletHandle
): Promise<BurnReceipt> {
  const requestId = crypto.randomUUID();
  const preparation = await post<Preparation>(baseUrl, "/burn/prepare", {
    requestId,
    callerPublicKey: wallet.publicKey.toBase58(),
    launchMint: request.launchMint,
    amountIn: request.amountInLamports,
    legs: request.legs.map((leg) => ({
      targetMint: leg.mint,
      bps: leg.bps,
      ...(leg.reference ? { reference: leg.reference } : {}),
    })),
    ...(request.lookupTableAddresses?.length
      ? { lookupTableAddresses: request.lookupTableAddresses }
      : {}),
  });
  if (
    preparation.requestId !== requestId ||
    preparation.callerPublicKey !== wallet.publicKey.toBase58()
  ) {
    throw new ServiceError("burn service returned a mismatched preparation");
  }
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(preparation.transactionBase64, "base64")
  );
  const message = transaction.message.serialize();
  if ((await sha256Hex(message)) !== preparation.messageSha256) {
    throw new ServiceError(
      "burn preparation digest does not match transaction"
    );
  }
  // KEYLESS: the connected wallet is the ONLY required signer. A prepared
  // transaction demanding any other signature is not a keyless burn.
  const required = transaction.message.staticAccountKeys.slice(
    0,
    transaction.message.header.numRequiredSignatures
  );
  if (
    required.length !== 1 ||
    !required[0].equals(wallet.publicKey) ||
    transaction.signatures.length !== 1 ||
    !transaction.signatures.every(isZeroSignature)
  ) {
    throw new ServiceError("burn preparation has an unsafe signer layout");
  }
  const instructions = transaction.message.compiledInstructions;
  const staticKeys = transaction.message.staticAccountKeys;
  if (
    instructions.length !== 2 ||
    !staticKeys[instructions[0].programIdIndex]?.equals(
      ComputeBudgetProgram.programId
    ) ||
    !staticKeys[instructions[1].programIdIndex]?.equals(PROGRAM)
  ) {
    throw new ServiceError(
      "burn preparation is not exactly ComputeBudget + burner"
    );
  }

  const signed = await wallet.signTransaction(transaction);
  const signedMessage = signed.message.serialize();
  if (!Buffer.from(signedMessage).equals(Buffer.from(message))) {
    throw new ServiceError("wallet changed the prepared transaction message");
  }
  if (isZeroSignature(signed.signatures[0])) {
    throw new ServiceError("wallet did not sign the burn transaction");
  }
  // The fully signed transaction goes back for relay. Nothing about it is
  // secret: the caller could equally submit it to any RPC themselves.
  const receipt = await post<SubmissionReceipt>(baseUrl, "/burn/submit", {
    requestId,
    signedTransactionBase64: Buffer.from(signed.serialize()).toString("base64"),
  });
  return {
    status: "submitted",
    submissionId: receipt.submissionId,
    messageSha256: receipt.messageSha256,
    simulatedUnits: preparation.simulatedUnits,
    minimumOutputs: preparation.minimumOutputs ?? [],
  };
}

export function makeService(baseUrl: string, callerPaid = false) {
  return {
    baseUrl,
    uploadMetadata(
      request: MetadataUploadRequest
    ): Promise<MetadataUploadReceipt> {
      return post<MetadataUploadReceipt>(
        baseUrl,
        "/metadata/upload",
        {
          name: request.name,
          symbol: request.symbol,
          description: request.description,
          image: {
            contentType: request.imageContentType,
            dataBase64: Buffer.from(request.image).toString("base64"),
          },
        },
        BURN_DEADLINE_MS,
        "the browser stopped waiting for the metadata upload; it may still complete, so wait before uploading the same image again"
      );
    },
    async health(): Promise<ServiceHealth> {
      const response = await fetch(`${baseUrl}/health`);
      if (!response.ok) throw new ServiceError(`HTTP ${response.status}`);
      return response.json();
    },
    burn(request: BurnRequest, wallet?: WalletHandle): Promise<BurnReceipt> {
      // The fork-only demo key keeps the service-funded one-shot loop. A real
      // Reown account always signs the prepared caller-paid transaction, even
      // when the UI is pointed at a development fork.
      if (!callerPaid && wallet?.kind === "demo") {
        return post(baseUrl, "/burn", request, BURN_DEADLINE_MS);
      }
      if (!wallet) {
        return Promise.reject(
          new ServiceError("connect a wallet to pay for and sign the burn")
        );
      }
      return callerPaidBurn(baseUrl, request, wallet);
    },
    demoAirdrop(address: string, lamports: bigint) {
      if (callerPaid) {
        return Promise.reject(new ServiceError("demo endpoints are disabled"));
      }
      return post<{ funded: string; lamports: string }>(
        baseUrl,
        "/demo/airdrop",
        {
          address,
          lamports: lamports.toString(),
        }
      );
    },
    demoTrade(mint: string, solAmounts?: string[]) {
      if (callerPaid) {
        return Promise.reject(new ServiceError("demo endpoints are disabled"));
      }
      return post<{
        buys: string[];
        graduated?: boolean;
        nearGraduation?: boolean;
        progressPct?: number;
        poolExists?: boolean;
        canonicalPool?: string;
        message?: string;
      }>(baseUrl, "/demo/trade", {
        mint,
        ...(solAmounts ? { solAmounts } : {}),
      });
    },
    async demoCurve(mint: string): Promise<CurveState> {
      if (callerPaid) throw new ServiceError("demo endpoints are disabled");
      const response = await fetch(
        `${baseUrl}/demo/curve?mint=${encodeURIComponent(mint)}`
      );
      if (!response.ok) throw new ServiceError(`HTTP ${response.status}`);
      return response.json();
    },
    demoMigrate(mint: string) {
      if (callerPaid) {
        return Promise.reject(new ServiceError("demo endpoints are disabled"));
      }
      return post<{
        pool: string;
        alreadyExisted: boolean;
        poolExists?: boolean;
      }>(baseUrl, "/demo/migrate", { mint });
    },
    demoDistribute(mint: string, vault: string) {
      if (callerPaid) {
        return Promise.reject(new ServiceError("demo endpoints are disabled"));
      }
      return post<{ vaultLamportsDelta: number; vaultLamports: number }>(
        baseUrl,
        "/demo/distribute",
        { mint, vault }
      );
    },
  };
}
