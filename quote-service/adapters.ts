import { createPrivateKey, sign as nodeSign } from "node:crypto";
import {
  Keypair,
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getMintCloseAuthority,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  ChainGateway,
  DirectCurveClient,
  JupiterBuild,
  JupiterBuildParams,
  JupiterClient,
  MessageSigner,
  PolicyError,
  PrivateSubmitter,
  RawAccountSnapshot,
  SimulationResult,
  TokenAccountSnapshot,
  MintSnapshot,
  VaultLease,
  VaultLeaseStore,
} from "./core";
import { buildDirectCurveBuyAccounts } from "./directcurve";
import { AccountDataReader, PUMP_FUN_ADDRESS } from "./reference";

/** The Pump SDK ships CJS with a very large d.ts; a typed require keeps its
 * runtime Anchor coder (the layout authority for Global) without pulling
 * that surface into this build. Only `decodeGlobal` is used. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PUMP_SDK } = require("@pump-fun/pump-sdk") as {
  PUMP_SDK: {
    decodeGlobal(accountInfo: { data: Buffer }): {
      feeRecipient: PublicKey;
      feeRecipients: PublicKey[];
      buybackFeeRecipients: PublicKey[];
    };
  };
};

function requireHttps(url: string, label: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new PolicyError("INSECURE_ENDPOINT", `${label} must use HTTPS`);
  }
  return parsed;
}

async function checkedJson<T>(
  url: URL,
  init: RequestInit,
  label: string
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `${label} returned HTTP ${response.status}: ${(
        await response.text()
      ).slice(0, 500)}`
    );
  }
  return (await response.json()) as T;
}

export class JupiterV2HttpClient implements JupiterClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly apiKey?: string) {
    this.baseUrl = requireHttps(baseUrl, "Jupiter API");
  }

  async build(params: JupiterBuildParams): Promise<JupiterBuild> {
    const url = new URL(
      "build",
      this.baseUrl.toString().endsWith("/") ? this.baseUrl : `${this.baseUrl}/`
    );
    url.searchParams.set("inputMint", params.inputMint.toBase58());
    url.searchParams.set("outputMint", params.outputMint.toBase58());
    url.searchParams.set("amount", params.amount.toString());
    url.searchParams.set("taker", params.taker.toBase58());
    url.searchParams.set("wrapAndUnwrapSol", "false");
    url.searchParams.set(
      "destinationTokenAccount",
      params.destinationTokenAccount.toBase58()
    );
    // Production uses Jupiter's Real-Time Slippage Estimator. A fixed
    // override exists only for explicit fork-mode wiring, where RTSE
    // estimates from live mainnet state while fork pools are frozen;
    // QuoteService itself never sets it.
    url.searchParams.set(
      "slippageBps",
      params.slippageBps !== undefined ? String(params.slippageBps) : "rtse"
    );
    if (params.maxAccounts !== undefined) {
      url.searchParams.set("maxAccounts", String(params.maxAccounts));
    }
    // Venue levers, set only by their two documented owners: QuoteService
    // passes excludeDexes solely for the burner-attributed 6018 Pump-venue
    // exclusion, and explicit fork-mode wiring passes a dexes include-list
    // so routes stay on venues a Surfpool fork can serve. Production main()
    // configures neither, so production routes stay unrestricted.
    if (params.excludeDexes?.length) {
      url.searchParams.set("excludeDexes", params.excludeDexes.join(","));
    }
    if (params.dexes?.length) {
      url.searchParams.set("dexes", params.dexes.join(","));
    }
    // Intentionally absent: payer, onlyDirectRoutes, platformFeeBps,
    // prioritization fee, and tip. The service cannot accidentally ask
    // Jupiter to add their signers or force direct-only routing.
    const headers = new Headers({ accept: "application/json" });
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    return checkedJson<JupiterBuild>(
      url,
      { method: "GET", headers },
      "Jupiter V2 /build"
    );
  }
}

/**
 * Enumerate a Token-2022 TLV region without crashing on trailing slack.
 *
 * `@solana/spl-token` 0.4.x's `getExtensionTypes` iterates
 * `while (index < tlvData.length)` and reads a 4-byte type+length header
 * unchecked, so TLV data whose end is not a whole entry throws a RangeError.
 * That shape is REAL: Pump.fun `create_v2` launch mints (Token-2022,
 * MetadataPointer + TokenMetadata) have been observed with two zeroed
 * trailing bytes after the last entry, and Token-2022 itself accepts them —
 * over-allocation is legal, the on-chain program stops at the first
 * Uninitialized sentinel. Before this helper existed, that RangeError fell
 * into `getMint`'s fail-closed catch and a LIVE, working mint was reported
 * to callers as "absent or uninitialized" (INVALID_MINT), refusing every
 * burn whose vault named it. Walk with the same bounds rule the library's
 * own `getExtensionData` uses: stop when fewer than 4 bytes remain, and on
 * the Uninitialized (0) sentinel type.
 */
function readExtensionTypes(tlvData: Buffer | Uint8Array): number[] {
  const data = Buffer.from(tlvData.buffer, tlvData.byteOffset, tlvData.length);
  const types: number[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (type === 0) break; // ExtensionType.Uninitialized: zeroed tail
    types.push(type);
    offset += 4 + length;
  }
  return types;
}

export class SolanaRpcGateway implements ChainGateway {
  constructor(private readonly connection: Connection) {}

  async getMint(address: PublicKey): Promise<MintSnapshot | null> {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    if (!info) return null;
    if (
      !info.owner.equals(TOKEN_PROGRAM_ID) &&
      !info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ) {
      return {
        address,
        ownerProgram: info.owner,
        initialized: false,
        mintAuthority: null,
        freezeAuthority: null,
        extensionTypes: [],
      };
    }
    try {
      const mint = unpackMint(address, info, info.owner);
      const hook = info.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? getTransferHook(mint)
        : null;
      const close = info.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? getMintCloseAuthority(mint)
        : null;
      const none = PublicKey.default;
      return {
        address,
        ownerProgram: info.owner,
        initialized: mint.isInitialized,
        mintAuthority: mint.mintAuthority,
        freezeAuthority: mint.freezeAuthority,
        closeAuthority: close
          ? close.closeAuthority.equals(none)
            ? null
            : close.closeAuthority
          : undefined,
        extensionTypes: info.owner.equals(TOKEN_2022_PROGRAM_ID)
          ? readExtensionTypes(mint.tlvData)
          : [],
        transferHookAuthority: hook
          ? hook.authority.equals(none)
            ? null
            : hook.authority
          : undefined,
        transferHookProgram: hook
          ? hook.programId.equals(none)
            ? null
            : hook.programId
          : undefined,
      };
    } catch {
      return {
        address,
        ownerProgram: info.owner,
        initialized: false,
        mintAuthority: null,
        freezeAuthority: null,
        extensionTypes: [],
      };
    }
  }

  async getTokenAccount(
    address: PublicKey
  ): Promise<TokenAccountSnapshot | null> {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    if (!info) return null;
    if (
      !info.owner.equals(TOKEN_PROGRAM_ID) &&
      !info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ) {
      return null;
    }
    try {
      const account = unpackAccount(address, info, info.owner);
      return {
        address,
        ownerProgram: info.owner,
        initialized: account.isInitialized && !account.isFrozen,
        mint: account.mint,
        authority: account.owner,
        amount: account.amount,
        isNative: account.isNative,
        delegate: account.delegate,
        closeAuthority: account.closeAuthority,
        extensionTypes: info.owner.equals(TOKEN_2022_PROGRAM_ID)
          ? readExtensionTypes(account.tlvData)
          : [],
      };
    } catch {
      return null;
    }
  }

  async getRawAccount(address: PublicKey): Promise<RawAccountSnapshot | null> {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    return info
      ? {
          owner: info.owner,
          lamports: BigInt(info.lamports),
          dataLength: info.data.length,
          executable: info.executable,
        }
      : null;
  }

  /** Raw owner + data read for the keyless reference resolver. */
  async getAccountData(
    address: PublicKey
  ): Promise<{ owner: PublicKey; data: Buffer; lamports?: bigint } | null> {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    return info
      ? {
          owner: info.owner,
          data: Buffer.from(info.data),
          lamports: BigInt(info.lamports),
        }
      : null;
  }

  async getAddressLookupTable(address: PublicKey) {
    return (
      await this.connection.getAddressLookupTable(address, {
        commitment: "confirmed",
      })
    ).value;
  }

  async getLatestBlockhash() {
    const result = await this.connection.getLatestBlockhashAndContext(
      "confirmed"
    );
    return { ...result.value, contextSlot: result.context.slot };
  }

  async getBlockHeight() {
    return this.connection.getBlockHeight("confirmed");
  }

  async getRentFloorForZeroData() {
    return BigInt(
      await this.connection.getMinimumBalanceForRentExemption(0, "confirmed")
    );
  }

  async simulate(transaction: VersionedTransaction): Promise<SimulationResult> {
    const result = await this.connection.simulateTransaction(transaction, {
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: false,
      innerInstructions: true,
    });
    return {
      error: result.value.err,
      logs: result.value.logs,
      unitsConsumed: result.value.unitsConsumed,
    };
  }
}

// KEYLESS: there is no quote authority. The program validates every route
// and enforces its own reference-bound price floor on chain. The only
// signer left here is the local fee-payer keypair used by fork/keeper
// one-shot mode.

/** Local keypair signer for the fork/keeper fee payer. */
export class LocalKeypairMessageSigner implements MessageSigner {
  constructor(readonly keypair: Keypair) {}

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(this.keypair.secretKey.subarray(0, 32)),
    ]);
    return nodeSign(
      null,
      Buffer.from(message),
      createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
    );
  }
}

/**
 * Distributed one-outstanding-burn lease boundary. The backing service must
 * implement an atomic unique lease on vault until expiry/release.
 */
export class HttpVaultLeaseStore implements VaultLeaseStore {
  private readonly endpoint: URL;

  constructor(endpoint: string, private readonly bearerToken?: string) {
    this.endpoint = requireHttps(endpoint, "vault lease endpoint");
  }

  async acquire(
    vault: PublicKey,
    requestId: string,
    ttlMs: number
  ): Promise<VaultLease> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.bearerToken)
      headers.set("authorization", `Bearer ${this.bearerToken}`);
    const acquired = await checkedJson<{ leaseId: string }>(
      new URL(
        "acquire",
        this.endpoint.toString().endsWith("/")
          ? this.endpoint
          : `${this.endpoint}/`
      ),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ vault: vault.toBase58(), requestId, ttlMs }),
      },
      "vault lease service"
    );
    let released = false;
    return {
      release: async (outcome) => {
        if (released) return;
        released = true;
        await checkedJson<unknown>(
          new URL(
            `lease/${encodeURIComponent(acquired.leaseId)}`,
            this.endpoint.toString().endsWith("/")
              ? this.endpoint
              : `${this.endpoint}/`
          ),
          {
            method: "DELETE",
            headers,
            body: JSON.stringify({ outcome }),
          },
          "vault lease service"
        );
      },
    };
  }
}

export class HttpPrivateSubmitter implements PrivateSubmitter {
  private readonly endpoint: URL;

  constructor(endpoint: string, private readonly bearerToken?: string) {
    this.endpoint = requireHttps(endpoint, "private submission endpoint");
  }

  async submit(
    transaction: Uint8Array,
    metadata: Readonly<Record<string, string>>
  ) {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.bearerToken)
      headers.set("authorization", `Bearer ${this.bearerToken}`);
    return checkedJson<{ submissionId: string }>(
      this.endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          transactionBase64: Buffer.from(transaction).toString("base64"),
          encoding: "base64",
          metadata,
        }),
      },
      "private submitter"
    );
  }
}

/**
 * Real DirectCurveClient: the two Global-derived recipients come from Pump's
 * own account (decoded by the Pump SDK's Anchor coder, so a Global layout
 * change cannot silently misread them), everything else is the pure PDA
 * derivation in directcurve.ts. Read-only — this client signs and pays for
 * nothing.
 *
 * Recipient choice is deterministic: `global.feeRecipient` (the first entry
 * of the SDK's own accepted static list) and `global.buybackFeeRecipients[0]`.
 * The proven fork harness used random picks from the same sets (22/22
 * own-curve legs landed, 2026-08-26).
 */
export class PumpDirectCurveClient implements DirectCurveClient {
  private readonly reader: AccountDataReader;

  constructor(connection: Connection) {
    this.reader = {
      async getAccountData(address: PublicKey) {
        const info = await connection.getAccountInfo(address, "confirmed");
        return info
          ? {
              owner: info.owner,
              data: info.data,
              lamports: BigInt(info.lamports),
            }
          : null;
      },
    };
  }

  async build(
    params: Readonly<{
      vault: PublicKey;
      targetMint: PublicKey;
      tokenProgram: PublicKey;
      targetAta: PublicKey;
    }>
  ) {
    const globalAddress = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      new PublicKey(PUMP_FUN_ADDRESS)
    )[0];
    const globalInfo = await this.reader.getAccountData(globalAddress);
    if (!globalInfo) {
      throw new PolicyError(
        "DIRECT_CURVE_UNAVAILABLE",
        "Pump global account is unreadable on this chain"
      );
    }
    const global = PUMP_SDK.decodeGlobal({ data: globalInfo.data });
    const buybackFeeRecipient = global.buybackFeeRecipients?.[0];
    if (!buybackFeeRecipient) {
      throw new PolicyError(
        "DIRECT_CURVE_UNAVAILABLE",
        "Pump global has no buyback fee recipient configured"
      );
    }
    return buildDirectCurveBuyAccounts(this.reader, {
      ...params,
      feeRecipient: global.feeRecipient,
      buybackFeeRecipient,
    });
  }
}
