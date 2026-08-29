/**
 * Deployable HTTP boundary for the KEYLESS burn builder and paid metadata
 * upload.
 *
 * OWNER DECISION 2026-08-26: the BURN path is fully keyless and open. The
 * separate metadata endpoint may hold an Irys payment key and a Cloudflare
 * Worker credential; neither has burn authority, and both stay behind a much
 * tighter HTTP boundary. Every burn control still lives in the program, on
 * chain. What remains is a
 * convenience BUILDER (route construction and transaction assembly are
 * genuinely intricate) plus an optional relay; anyone could build and
 * submit the identical burn transaction without it.
 *
 *   POST /burn/prepare  semantic request + caller pubkey in; the UNSIGNED
 *                       transaction out, with the caller as its only
 *                       required signer. The caller signs and may submit it
 *                       anywhere — returning the bytes is the product.
 *   POST /burn/submit   a fully caller-signed transaction in; relay receipt
 *                       out. Stateless: the gate only refuses to relay
 *                       anything that is not exactly a signed burner burn.
 *   POST /burn          one-shot keeper burn (the service pays and submits);
 *                       enabled only where a fee-payer keypair is configured.
 *   GET  /healthz  liveness: process is up (stays 200 while draining).
 *   GET  /readyz   readiness: dependencies actually reachable. Returns 503
 *                  while draining so the platform stops routing.
 *
 * Two run modes, selected by BURNER_ENV. Anything else refuses to start.
 *
 *   BURNER_ENV=production  Stateless prepare/submit. No signer, no privileged
 *     key: nothing here requires a key to boot or run.
 *
 *   BURNER_ENV=fork-e2e    Explicit, opt-in local-fork end-to-end mode for
 *     exercising the REAL QuoteService pipeline (real Jupiter routes, real
 *     submission) against a Surfpool fork. It refuses any RPC that is not
 *     127.0.0.1/localhost, pays with a local keypair, submits via the fork
 *     RPC, and restricts Jupiter to venues a fork can serve
 *     (FORK_DEX_PROFILE=pool equivalent).
 *
 * Logging is structured JSON on stdout. The request body and transaction
 * bytes are never logged; outbound error messages are sanitized (long
 * byte-blob runs redacted, length capped) as defense in depth.
 */
import type http from "node:http";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  assertSubmittableSignedTransaction,
  DEFAULT_BURNER_PROGRAM,
  InMemoryVaultLeaseStore,
  JupiterBuildParams,
  JupiterClient,
  PolicyError,
  PrivateSubmitter,
  QuoteService,
  QuoteServicePolicy,
} from "./core";
import {
  HttpPrivateSubmitter,
  JupiterV2HttpClient,
  LocalKeypairMessageSigner,
  PumpDirectCurveClient,
  SolanaRpcGateway,
} from "./adapters";
import type { AccountDataReader } from "./reference";
import {
  createReferenceDiscovery,
  DEFAULT_REFERENCE_DISCOVERY_DEADLINE_MS,
  marketSelectionForTransport,
  ProgramAccountsReader,
  ReferenceDiscoveryError,
  resolveCandidate,
  selectReference,
  SUPPORTED_REFERENCE_DEXES,
} from "./markets";
import { WSOL_ADDRESS } from "./reference";

// ---------------------------------------------------------------------------
// Structured logging and outbound sanitization
// ---------------------------------------------------------------------------

export type LogSink = (line: Readonly<Record<string, unknown>>) => void;

export function defaultLogSink(line: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Outbound text hygiene for error messages and log details. A signed
 * transaction, a signature, or any other byte payload encodes to a long
 * unbroken base64/base58/hex run; no legitimate diagnostic needs one.
 * Public keys (32-44 chars) survive. Applied to every error message that
 * leaves the process, so even a hypothetical upstream error that embedded
 * bytes could not exfiltrate them.
 */
export function sanitizeForTransport(text: string): string {
  return text
    .replace(/[A-Za-z0-9+/=_-]{64,}/g, (match) => `[redacted:${match.length}]`)
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// Paid metadata-upload boundary
// ---------------------------------------------------------------------------

/** The decoded image, not its base64 transport envelope. */
export const MAX_METADATA_IMAGE_BYTES = 10_000_000;
/** Permanent icon bytes after the Cloudflare WebP normalization pass. */
export const MAX_COMPRESSED_METADATA_IMAGE_BYTES = 200_000;
export const MAX_METADATA_JSON_BYTES = 8_192;
/** 10M image -> ~13.4M base64, leaving a bounded JSON envelope. */
export const MAX_METADATA_UPLOAD_REQUEST_BYTES = 14_000_000;
export const ACCEPTED_METADATA_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type MetadataUploadInput = Readonly<{
  /** Content-derived browser id used to replay a paid upload safely. */
  requestId?: string;
  name: string;
  symbol: string;
  description: string;
  links?: Partial<Record<"website" | "twitter" | "telegram", string>>;
  image: Buffer;
  imageContentType: (typeof ACCEPTED_METADATA_IMAGE_TYPES)[number];
}>;

export type MetadataUploadResult = Readonly<{
  uri: string;
  imageUri: string;
  /** Optional delivery mirror. Never embedded in the permanent metadata. */
  deliveryImageUri: string;
  originalImageBytes: number;
  imageBytes: number;
}>;

export type MetadataImagePrepareInput = Readonly<{
  image: Buffer;
  imageContentType: (typeof ACCEPTED_METADATA_IMAGE_TYPES)[number];
}>;

export type MetadataImagePrepareResult = Readonly<{
  imageBase64: string;
  imageContentType: "image/webp";
  originalImageBytes: number;
  imageBytes: number;
}>;

export type MetadataImageCompressor = Readonly<{
  compress: (
    image: Buffer,
    contentType: MetadataUploadInput["imageContentType"]
  ) => Promise<
    Readonly<{
      image: Buffer;
      contentType: "image/webp";
    }>
  >;
  /** Map one permanent Irys image URI to the optional Cloudflare delivery URL. */
  deliveryUri: (permanentImageUri: string) => string;
}>;

export class MetadataUploadError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

function hasImageSignature(
  bytes: Buffer,
  contentType: MetadataUploadInput["imageContentType"]
): boolean {
  if (contentType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    );
  }
  if (contentType === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

const METADATA_LINK_KEYS = ["website", "twitter", "telegram"] as const;
type MetadataLinkKey = (typeof METADATA_LINK_KEYS)[number];

/** Optional socials, normalised to absolute http(s) URLs or dropped. */
function parseMetadataLinks(
  raw: unknown
): Partial<Record<MetadataLinkKey, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "links must be an object",
      400
    );
  }
  const object = raw as Record<string, unknown>;
  const unknown = Object.keys(object).filter(
    (key) => !(METADATA_LINK_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      `links contains unsupported fields: ${unknown.join(",")}`,
      400
    );
  }
  const out: Partial<Record<MetadataLinkKey, string>> = {};
  for (const key of METADATA_LINK_KEYS) {
    const value = object[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw new MetadataUploadError(
        "INVALID_UPLOAD_REQUEST",
        `${key} must be a string`,
        400
      );
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > 200) {
      throw new MetadataUploadError(
        "INVALID_UPLOAD_REQUEST",
        `${key} must not exceed 200 characters`,
        400
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new MetadataUploadError(
        "INVALID_UPLOAD_REQUEST",
        `${key} must be a full URL beginning http:// or https://`,
        400
      );
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new MetadataUploadError(
        "INVALID_UPLOAD_REQUEST",
        `${key} must use http or https`,
        400
      );
    }
    out[key] = parsed.toString();
  }
  return out;
}

export function parseMetadataUploadRequest(
  parsed: JsonBody
): MetadataUploadInput & { requestId: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "metadata upload request must be an object",
      400
    );
  }
  const object = parsed as Record<string, unknown>;
  const unknown = Object.keys(object).filter(
    (key) =>
      ![
        "requestId",
        "name",
        "symbol",
        "description",
        "image",
        "links",
      ].includes(key)
  );
  if (unknown.length) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      `metadata upload contains unsupported fields: ${unknown.join(",")}`,
      400
    );
  }
  const requestId =
    typeof object.requestId === "string" ? object.requestId : "";
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "requestId must be a 64-character lowercase content digest",
      400
    );
  }
  const name = typeof object.name === "string" ? object.name.trim() : "";
  const symbol = typeof object.symbol === "string" ? object.symbol.trim() : "";
  const description =
    typeof object.description === "string" ? object.description.trim() : "";
  if (!name || name.length > 32) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "name must contain 1 to 32 characters",
      400
    );
  }
  if (!symbol || symbol.length > 10) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "symbol must contain 1 to 10 characters",
      400
    );
  }
  if (description.length > 500) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "description must not exceed 500 characters",
      400
    );
  }
  // Optional socials. These are pasted by a stranger and then written to
  // PERMANENT storage, so each is parsed as a URL and restricted to http(s):
  // a `javascript:` or `data:` URI in a token's metadata is a live payload
  // for every site that renders it, and it could never be edited out.
  const links = parseMetadataLinks(object.links);
  if (
    !object.image ||
    typeof object.image !== "object" ||
    Array.isArray(object.image)
  ) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "image must contain contentType and dataBase64",
      400
    );
  }
  const image = object.image as Record<string, unknown>;
  const unknownImage = Object.keys(image).filter(
    (key) => key !== "contentType" && key !== "dataBase64"
  );
  if (unknownImage.length) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      `image contains unsupported fields: ${unknownImage.join(",")}`,
      400
    );
  }
  const contentType =
    typeof image.contentType === "string"
      ? image.contentType.toLowerCase()
      : "";
  if (
    !ACCEPTED_METADATA_IMAGE_TYPES.includes(
      contentType as MetadataUploadInput["imageContentType"]
    )
  ) {
    throw new MetadataUploadError(
      "UNSUPPORTED_IMAGE_TYPE",
      `image content type must be one of ${ACCEPTED_METADATA_IMAGE_TYPES.join(
        ", "
      )}`,
      415
    );
  }
  if (
    typeof image.dataBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      image.dataBase64
    )
  ) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "image dataBase64 must be canonical base64",
      400
    );
  }
  const bytes = Buffer.from(image.dataBase64, "base64");
  if (!bytes.length) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "image must not be empty",
      400
    );
  }
  if (bytes.length > MAX_METADATA_IMAGE_BYTES) {
    throw new MetadataUploadError(
      "UPLOAD_TOO_LARGE",
      `image exceeds ${MAX_METADATA_IMAGE_BYTES} bytes`,
      413
    );
  }
  const typedContentType =
    contentType as MetadataUploadInput["imageContentType"];
  if (!hasImageSignature(bytes, typedContentType)) {
    throw new MetadataUploadError(
      "IMAGE_TYPE_MISMATCH",
      "image bytes do not match the declared content type",
      415
    );
  }
  return {
    requestId,
    name,
    symbol,
    description,
    links,
    image: bytes,
    imageContentType: typedContentType,
  };
}

/** Parse the early, non-permanent Cloudflare image-normalization request. */
export function parseMetadataImagePrepareRequest(
  parsed: JsonBody
): MetadataImagePrepareInput {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      "image preparation request must be an object",
      400
    );
  }
  const object = parsed as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => key !== "image");
  if (unknown.length) {
    throw new MetadataUploadError(
      "INVALID_UPLOAD_REQUEST",
      `image preparation contains unsupported fields: ${unknown.join(",")}`,
      400
    );
  }
  // Reuse the permanent boundary's strict MIME, base64, signature, and size
  // validation with harmless placeholder metadata, then retain only image.
  const validated = parseMetadataUploadRequest({
    requestId: "0".repeat(64),
    name: "draft",
    symbol: "DRAFT",
    description: "",
    image: object.image,
  });
  return {
    image: validated.image,
    imageContentType: validated.imageContentType,
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export type BurnServerOptions = Readonly<{
  port?: number;
  /** Bind address. In-process tests default to loopback; main passes 0.0.0.0. */
  host?: string;
  /** Reject request bodies larger than this before JSON parsing. */
  maxBodyBytes?: number;
  /**
   * Overall processing deadline for one /burn request. On expiry the CLIENT
   * gets 504, but the in-flight burn is never aborted: it may already be
   * signing or submitting, so it runs to completion under its vault lease
   * and its outcome is logged. The caller retries with a NEW requestId and
   * the lease/requestId dedup at the lease service prevents double burns.
   */
  requestDeadlineMs?: number;
  /** Maximum concurrently processing burns; excess requests get 429. */
  maxInflightBurns?: number;
  /** Maximum paid metadata uploads in flight. Kept separate from burns. */
  maxInflightMetadataUploads?: number;
  /** Decoded JSON envelope cap for POST /metadata/upload. */
  metadataUploadMaxRequestBytes?: number;
  /** Per-client-IP paid upload limit inside one rate window. */
  metadataUploadRateLimitPerIp?: number;
  /** Whole-service paid upload limit; caps distributed spend attacks. */
  metadataUploadGlobalRateLimit?: number;
  metadataUploadRateWindowMs?: number;
  /** Trust CF-Connecting-IP / X-Forwarded-For only behind a known proxy. */
  trustProxy?: boolean;
  /** Grace period for in-flight burns after SIGTERM before forced close. */
  shutdownGraceMs?: number;
  /** Overall deadline for either interactive reference endpoint. */
  referenceRequestDeadlineMs?: number;
  /** Optional bearer token required on /burn (defense in depth). */
  bearerToken?: string;
  /** Fail closed for infrastructure-only revisions. Defaults to true. */
  burnEnabled?: boolean;
  /**
   * KEYLESS caller-paid endpoints. `prepare` builds and returns the unsigned
   * transaction (caller is the sole required signer); `submitSigned` relays
   * a fully caller-signed burn. When `prepare` is configured and the wiring
   * has no fee payer, one-shot POST /burn answers 410.
   */
  prepare?: (parsed: JsonBody) => Promise<Readonly<Record<string, unknown>>>;
  submitSigned?: (
    parsed: JsonBody
  ) => Promise<Readonly<Record<string, unknown>>>;
  /** One-shot /burn is enabled only where the wiring pays for burns itself. */
  oneShotEnabled?: boolean;
  /** Throws when a dependency is not reachable; drives GET /readyz. */
  readiness?: () => Promise<void>;
  /**
   * Rich liveness for the browser app's GET /health badge:
   * `{ ok, mode, slot, program, payer? }`.
   */
  health?: () => Promise<Readonly<Record<string, unknown>>>;
  /**
   * GET /reference/markets?mint=… — the keyless reference selection
   * (Pump branch or the durability-then-depth market scan). The setup UI
   * depends on it; burns do not.
   */
  markets?: (mint: string) => Promise<Readonly<Record<string, unknown>>>;
  /**
   * GET /reference/resolve?mint=…&pool=… — authenticate ONE candidate
   * (`pool=` explicit override, or "pump" for the Pump venue). With no
   * `pool`, runs `selectReference` (GPA + rankCandidates). A mint with
   * no eligible market gets a 422.
   */
  resolve?: (
    mint: string,
    pool: string | null
  ) => Promise<Readonly<Record<string, unknown>>>;
  /** Paid Irys upload. Undefined means the endpoint is explicitly disabled. */
  metadataUpload?: (
    input: MetadataUploadInput
  ) => Promise<MetadataUploadResult>;
  /**
   * CORS allowlist. The browser app is served from a different origin than
   * this service in EVERY deployment, so cross-origin is the normal case.
   *
   * DELIBERATE DECISION, 2026-08-26 — CORS is NOT an access control for the
   * keyless routes, whose default remains `*`. The paid metadata route is an
   * explicit exception: it never emits `*`, requires an exact Origin from
   * this list, and still relies on its IP/global rate and size limits because
   * non-browser callers can forge Origin.
   */
  allowedOrigins?: readonly string[];
  log?: LogSink;
  installSignalHandlers?: boolean;
}>;

export type BurnServerHandle = Readonly<{
  server: http.Server;
  listen: () => Promise<number>;
  /** Drain: stop accepting, finish in-flight burns, close. Idempotent. */
  shutdown: (reason: string) => Promise<void>;
  inflightCount: () => number;
}>;

type BurnExecutor = Pick<QuoteService, "execute">;

type JsonBody = Readonly<Record<string, unknown>> | readonly unknown[] | null;

function respondJson(
  response: http.ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

export function policyErrorStatus(code: string): number {
  if (
    code === "VAULT_BUSY" ||
    code === "DUPLICATE_REQUEST" ||
    code === "PREPARATION_STATE"
  )
    return 409;
  if (code === "PREPARATION_NOT_FOUND") return 404;
  if (code === "PREPARATION_EXPIRED") return 410;
  // Externally-authored simulation failure (Jupiter/AMM route weather):
  // an upstream failure, retryable with a fresh quote — not a client error.
  if (code === "EXTERNAL_SIMULATION_FAILURE") return 502;
  return 400;
}

async function readBodyWithCap(
  request: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer | "TOO_LARGE"> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return "TOO_LARGE";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) return "TOO_LARGE";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createBurnServer(
  service: BurnExecutor,
  options: BurnServerOptions = {}
): BurnServerHandle {
  // Kept inside the Node adapter so the Worker bundle has no node:http/net
  // imports at module evaluation time.
  const http = require("node:http") as typeof import("node:http");
  const { isIP } = require("node:net") as typeof import("node:net");
  const log = options.log ?? defaultLogSink;
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;
  const requestDeadlineMs = options.requestDeadlineMs ?? 150_000;
  const maxInflightBurns = options.maxInflightBurns ?? 8;
  const maxInflightMetadataUploads = options.maxInflightMetadataUploads ?? 1;
  const metadataUploadMaxRequestBytes =
    options.metadataUploadMaxRequestBytes ?? MAX_METADATA_UPLOAD_REQUEST_BYTES;
  const metadataUploadRateLimitPerIp =
    options.metadataUploadRateLimitPerIp ?? 3;
  const metadataUploadGlobalRateLimit =
    options.metadataUploadGlobalRateLimit ?? 30;
  const metadataUploadRateWindowMs =
    options.metadataUploadRateWindowMs ?? 60 * 60 * 1_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 25_000;
  const referenceRequestDeadlineMs =
    options.referenceRequestDeadlineMs ??
    DEFAULT_REFERENCE_DISCOVERY_DEADLINE_MS + 1_000;
  const inflight = new Set<Promise<unknown>>();
  let metadataUploadsInflight = 0;
  const metadataUploadRates = new Map<
    string,
    { windowStartedAt: number; count: number }
  >();
  let globalMetadataUploadRate = { windowStartedAt: Date.now(), count: 0 };
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;

  function emit(level: string, event: string, fields: Record<string, unknown>) {
    log({ ts: new Date().toISOString(), level, event, ...fields });
  }

  function withReferenceRequestDeadline<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new ReferenceDiscoveryError(
              "REFERENCE_DISCOVERY_TIMEOUT",
              `reference request timed out after ${referenceRequestDeadlineMs} ms; retry`
            )
          ),
        referenceRequestDeadlineMs
      );
      timer.unref();
      operation.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  function uploadOriginAllowed(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin;
    return Boolean(
      origin &&
        options.allowedOrigins?.length &&
        options.allowedOrigins.includes(origin) &&
        origin !== "*"
    );
  }

  function metadataUploadClientIp(request: http.IncomingMessage): string {
    if (options.trustProxy) {
      const cloudflare = request.headers["cf-connecting-ip"];
      const forwarded = request.headers["x-forwarded-for"];
      const candidate = String(
        cloudflare ??
          (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(
            ","
          )[0] ??
          ""
      ).trim();
      if (isIP(candidate)) return candidate;
    }
    return request.socket.remoteAddress ?? "unknown";
  }

  function consumeMetadataUploadRate(ip: string): number | null {
    const now = Date.now();
    if (
      now - globalMetadataUploadRate.windowStartedAt >=
      metadataUploadRateWindowMs
    ) {
      globalMetadataUploadRate = { windowStartedAt: now, count: 0 };
    }
    const prior = metadataUploadRates.get(ip);
    const bucket =
      !prior || now - prior.windowStartedAt >= metadataUploadRateWindowMs
        ? { windowStartedAt: now, count: 0 }
        : prior;
    if (
      bucket.count >= metadataUploadRateLimitPerIp ||
      globalMetadataUploadRate.count >= metadataUploadGlobalRateLimit
    ) {
      const blockedUntil = [
        ...(bucket.count >= metadataUploadRateLimitPerIp
          ? [bucket.windowStartedAt + metadataUploadRateWindowMs]
          : []),
        ...(globalMetadataUploadRate.count >= metadataUploadGlobalRateLimit
          ? [
              globalMetadataUploadRate.windowStartedAt +
                metadataUploadRateWindowMs,
            ]
          : []),
      ];
      return Math.max(1, Math.ceil((Math.max(...blockedUntil) - now) / 1_000));
    }
    bucket.count += 1;
    globalMetadataUploadRate.count += 1;
    metadataUploadRates.set(ip, bucket);
    if (metadataUploadRates.size > 10_000) {
      for (const [key, value] of metadataUploadRates) {
        if (now - value.windowStartedAt >= metadataUploadRateWindowMs) {
          metadataUploadRates.delete(key);
        }
      }
    }
    return null;
  }

  async function handleMetadataUpload(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const startedAt = Date.now();
    if (draining) {
      respondJson(response, 503, {
        code: "DRAINING",
        message: "service is shutting down",
      });
      return;
    }
    if (!options.metadataUpload) {
      respondJson(response, 503, {
        code: "METADATA_UPLOAD_DISABLED",
        message:
          "metadata upload is disabled because the server-side Irys and Cloudflare pipeline is not configured",
      });
      return;
    }
    if (!uploadOriginAllowed(request)) {
      respondJson(response, 403, {
        code: "UPLOAD_ORIGIN_FORBIDDEN",
        message:
          "this origin is not allowed to spend the metadata upload balance",
      });
      return;
    }
    if (
      inflight.size >= maxInflightBurns ||
      metadataUploadsInflight >= maxInflightMetadataUploads
    ) {
      respondJson(response, 429, {
        code: "SERVER_BUSY",
        message: "too many concurrent requests; retry later",
      });
      return;
    }
    const contentType = String(request.headers["content-type"] ?? "");
    if (!/^application\/json\b/i.test(contentType)) {
      respondJson(response, 415, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "content-type must be application/json",
      });
      return;
    }
    const body = await readBodyWithCap(request, metadataUploadMaxRequestBytes);
    if (body === "TOO_LARGE") {
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      respondJson(response, 413, {
        code: "UPLOAD_TOO_LARGE",
        message: `metadata upload request exceeds ${metadataUploadMaxRequestBytes} bytes`,
      });
      return;
    }
    let parsed: JsonBody;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      respondJson(response, 400, {
        code: "INVALID_JSON",
        message: "request body is not valid JSON",
      });
      return;
    }
    let input: MetadataUploadInput;
    try {
      input = parseMetadataUploadRequest(parsed);
    } catch (error) {
      if (error instanceof MetadataUploadError) {
        respondJson(response, error.status, {
          code: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }

    // Recheck after receiving/validating the body: several requests may have
    // passed the early check while their bodies were still arriving.
    if (
      inflight.size >= maxInflightBurns ||
      metadataUploadsInflight >= maxInflightMetadataUploads
    ) {
      respondJson(response, 429, {
        code: "SERVER_BUSY",
        message: "too many concurrent requests; retry later",
      });
      return;
    }
    // Count only a valid request that is ready to spend; malformed requests
    // cannot exhaust the global paid-upload allowance as an availability DoS.
    const retryAfter = consumeMetadataUploadRate(
      metadataUploadClientIp(request)
    );
    if (retryAfter !== null) {
      response.setHeader("retry-after", String(retryAfter));
      respondJson(response, 429, {
        code: "UPLOAD_RATE_LIMITED",
        message: "metadata upload rate limit reached; retry later",
      });
      return;
    }

    // Like burns, an upload is not aborted after its paid operation starts.
    // A late completion is logged, and the dedicated concurrency cap plus
    // rate limits prevent retries from creating unbounded spend.
    const execution = Promise.resolve().then(() =>
      options.metadataUpload!(input)
    );
    const tracked = execution.catch(() => undefined);
    metadataUploadsInflight += 1;
    inflight.add(tracked);
    void tracked.finally(() => {
      metadataUploadsInflight -= 1;
      inflight.delete(tracked);
    });
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"DEADLINE">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("DEADLINE"), requestDeadlineMs);
      deadlineTimer.unref();
    });
    const outcome = await Promise.race([
      execution.then(
        (result) => ({ kind: "result" as const, result }),
        (error) => ({ kind: "error" as const, error })
      ),
      deadline,
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (outcome === "DEADLINE") {
      respondJson(response, 504, {
        code: "REQUEST_DEADLINE",
        message:
          "metadata upload is still processing; wait before retrying to avoid a duplicate paid upload",
      });
      execution.then(
        (result) =>
          emit("info", "metadata-upload-completed-after-deadline", {
            uri: result.uri,
            originalImageBytes: result.originalImageBytes,
            imageBytes: result.imageBytes,
            ms: Date.now() - startedAt,
          }),
        (error) =>
          emit("error", "metadata-upload-failed-after-deadline", {
            code:
              error instanceof MetadataUploadError
                ? error.code
                : "IRYS_UPLOAD_FAILED",
            ms: Date.now() - startedAt,
          })
      );
      return;
    }
    if (outcome.kind === "result") {
      emit("info", "metadata-upload-completed", {
        uri: outcome.result.uri,
        originalImageBytes: outcome.result.originalImageBytes,
        imageBytes: outcome.result.imageBytes,
        ms: Date.now() - startedAt,
      });
      respondJson(response, 200, outcome.result);
      return;
    }
    const error = outcome.error;
    if (error instanceof MetadataUploadError) {
      emit("info", "metadata-upload-rejected", {
        code: error.code,
        ms: Date.now() - startedAt,
      });
      respondJson(response, error.status, {
        code: error.code,
        message: error.message,
      });
      return;
    }
    // Never log an SDK error detail here: this is the only route holding a
    // real secret, so even a future SDK that embeds its wallet in an error
    // cannot make the key reach logs or a response body.
    emit("error", "metadata-upload-error", {
      code: "IRYS_UPLOAD_FAILED",
      ms: Date.now() - startedAt,
    });
    respondJson(response, 502, {
      code: "IRYS_UPLOAD_FAILED",
      message: "Irys metadata upload failed",
    });
  }

  async function handleOperation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    operation: "burn" | "prepare" | "submit",
    execute: (parsed: JsonBody) => Promise<Readonly<Record<string, unknown>>>
  ): Promise<void> {
    const startedAt = Date.now();
    if (draining) {
      respondJson(response, 503, {
        code: "DRAINING",
        message: "service is shutting down",
      });
      return;
    }
    if (options.bearerToken) {
      const header = request.headers.authorization ?? "";
      if (header !== `Bearer ${options.bearerToken}`) {
        respondJson(response, 401, {
          code: "UNAUTHORIZED",
          message: "missing or invalid bearer token",
        });
        return;
      }
    }
    if (inflight.size >= maxInflightBurns) {
      respondJson(response, 429, {
        code: "SERVER_BUSY",
        message: "too many concurrent burns; retry later",
      });
      return;
    }
    const contentType = String(request.headers["content-type"] ?? "");
    if (!/^application\/json\b/i.test(contentType)) {
      respondJson(response, 415, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "content-type must be application/json",
      });
      return;
    }
    const body = await readBodyWithCap(request, maxBodyBytes);
    if (body === "TOO_LARGE") {
      // Refused BEFORE parsing; a semantic BurnRequest is well under 2KB.
      // The connection is closed after the response flushes because the
      // unread remainder of the body would corrupt keep-alive framing.
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      respondJson(response, 413, {
        code: "BODY_TOO_LARGE",
        message: `request body exceeds ${maxBodyBytes} bytes`,
      });
      return;
    }
    let parsed: JsonBody;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      // Never echo the body: unparseable input is described, not quoted.
      respondJson(response, 400, {
        code: "INVALID_JSON",
        message: "request body is not valid JSON",
      });
      return;
    }
    const requestId =
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (typeof (parsed as { requestId?: unknown }).requestId === "string" ||
        typeof (parsed as { preparationId?: unknown }).preparationId ===
          "string")
        ? String(
            (parsed as { requestId?: string; preparationId?: string })
              .requestId ?? (parsed as { preparationId: string }).preparationId
          ).slice(0, 128)
        : undefined;

    // The burn itself. Never aborted once started: the lease and the
    // signing/submission sequence must run to completion or fail cleanly.
    const execution = execute(parsed);
    const tracked = execution.catch(() => undefined);
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"DEADLINE">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("DEADLINE"), requestDeadlineMs);
      deadlineTimer.unref();
    });
    const outcome = await Promise.race([
      execution.then(
        (result) => ({ kind: "result" as const, result }),
        (error) => ({ kind: "error" as const, error })
      ),
      deadline,
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);

    if (outcome === "DEADLINE") {
      respondJson(response, 504, {
        code: "REQUEST_DEADLINE",
        message: `${operation} still processing; it will complete or fail under its vault lease`,
      });
      execution.then(
        (result) =>
          emit("info", `${operation}-completed-after-deadline`, {
            requestId,
            vault: result.vault,
            submissionId: result.submissionId,
            messageSha256: result.messageSha256,
            ms: Date.now() - startedAt,
          }),
        (error) =>
          emit("error", `${operation}-failed-after-deadline`, {
            requestId,
            code: error instanceof PolicyError ? error.code : "INTERNAL",
            detail: sanitizeForTransport(
              error instanceof Error ? error.message : String(error)
            ),
            ms: Date.now() - startedAt,
          })
      );
      return;
    }

    if (outcome.kind === "result") {
      const result = outcome.result;
      emit("info", `${operation}-completed`, {
        requestId: result.requestId ?? requestId,
        vault: result.vault,
        submissionId: result.submissionId,
        messageSha256: result.messageSha256,
        transactionBytes: result.transactionBytes,
        accountLocks: result.accountLocks,
        simulatedUnits: result.simulatedUnits,
        ms: Date.now() - startedAt,
      });
      respondJson(response, 200, result);
      return;
    }

    const error = outcome.error;
    if (error instanceof PolicyError) {
      // Policy messages describe the rejection; they never contain request
      // bodies or transaction bytes, and sanitizeForTransport enforces that
      // invariant even against future drift.
      emit("info", `${operation}-rejected`, {
        requestId,
        code: error.code,
        detail: sanitizeForTransport(error.message),
        ms: Date.now() - startedAt,
      });
      respondJson(response, policyErrorStatus(error.code), {
        code: error.code,
        message: sanitizeForTransport(error.message),
      });
      return;
    }
    // Unexpected failures (adapter/network faults) return a GENERIC body so
    // no upstream response fragment can leak through; detail goes to the log
    // only, sanitized.
    emit("error", `${operation}-error`, {
      requestId,
      detail: sanitizeForTransport(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      ),
      ms: Date.now() - startedAt,
    });
    respondJson(response, 500, {
      code: "INTERNAL",
      message: "internal error",
    });
  }

  async function handleReadyz(response: http.ServerResponse): Promise<void> {
    if (draining) {
      respondJson(response, 503, { status: "draining" });
      return;
    }
    if (!options.readiness) {
      respondJson(response, 200, { status: "ready" });
      return;
    }
    try {
      await options.readiness();
      respondJson(response, 200, { status: "ready" });
    } catch (error) {
      respondJson(response, 503, {
        status: "not-ready",
        reason: sanitizeForTransport(
          error instanceof Error ? error.message : String(error)
        ),
      });
    }
  }

  const server = http.createServer((request, response) => {
    const [url, query] = (request.url ?? "/").split("?");
    const route = `${request.method} ${url}`;
    const isMetadataUploadRoute = url === "/metadata/upload";
    // Keyless routes retain their permissive default. The paid upload route
    // NEVER emits `*`: it only echoes an exact configured origin and also
    // rejects a missing/disallowed Origin in the handler below.
    const origin = request.headers.origin;
    if (
      !isMetadataUploadRoute &&
      (!options.allowedOrigins || options.allowedOrigins.length === 0)
    ) {
      response.setHeader("access-control-allow-origin", "*");
    } else if (origin && options.allowedOrigins?.includes(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "content-type, authorization"
    );
    response.setHeader("access-control-max-age", "86400");
    if (request.method === "OPTIONS") {
      if (isMetadataUploadRoute && !uploadOriginAllowed(request)) {
        respondJson(response, 403, {
          code: "UPLOAD_ORIGIN_FORBIDDEN",
          message:
            "this origin is not allowed to spend the metadata upload balance",
        });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    const handled = (async () => {
      if (route === "GET /healthz") {
        respondJson(response, 200, { status: "ok", draining });
        return;
      }
      if (route === "GET /health") {
        if (!options.health) {
          respondJson(response, 200, { ok: !draining });
          return;
        }
        try {
          respondJson(response, 200, {
            ok: !draining,
            ...(await options.health()),
          });
        } catch (error) {
          respondJson(response, 503, {
            ok: false,
            reason: sanitizeForTransport(
              error instanceof Error ? error.message : String(error)
            ),
          });
        }
        return;
      }
      if (route === "GET /reference/resolve" && options.resolve) {
        const params = new URLSearchParams(query ?? "");
        const mint = params.get("mint");
        const pool = params.get("pool");
        if (!mint) {
          respondJson(response, 400, {
            code: "INVALID_REQUEST",
            message: "mint query parameter required",
          });
          return;
        }
        try {
          respondJson(
            response,
            200,
            await withReferenceRequestDeadline(options.resolve(mint, pool))
          );
        } catch (error) {
          if (error instanceof ReferenceDiscoveryError) {
            respondJson(
              response,
              error.code === "REFERENCE_DISCOVERY_TIMEOUT" ? 504 : 503,
              {
                code: error.code,
                message: sanitizeForTransport(error.message),
              }
            );
            return;
          }
          respondJson(response, 422, {
            code: error instanceof PolicyError ? error.code : "RESOLVE_FAILED",
            message: sanitizeForTransport(
              error instanceof Error ? error.message : String(error)
            ),
          });
        }
        return;
      }
      if (route === "GET /reference/markets" && options.markets) {
        const mint = new URLSearchParams(query ?? "").get("mint");
        if (!mint) {
          respondJson(response, 400, {
            code: "INVALID_REQUEST",
            message: "mint query parameter required",
          });
          return;
        }
        try {
          respondJson(
            response,
            200,
            await withReferenceRequestDeadline(options.markets(mint))
          );
        } catch (error) {
          if (error instanceof ReferenceDiscoveryError) {
            respondJson(
              response,
              error.code === "REFERENCE_DISCOVERY_TIMEOUT" ? 504 : 503,
              {
                code: error.code,
                message: sanitizeForTransport(error.message),
              }
            );
            return;
          }
          if (error instanceof PolicyError) {
            respondJson(response, policyErrorStatus(error.code), {
              code: error.code,
              message: sanitizeForTransport(error.message),
            });
            return;
          }
          respondJson(response, 500, {
            code: "INTERNAL",
            message: sanitizeForTransport(
              error instanceof Error ? error.message : String(error)
            ),
          });
        }
        return;
      }
      if (route === "GET /readyz") {
        await handleReadyz(response);
        return;
      }
      if (url === "/metadata/upload") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          respondJson(response, 405, {
            code: "METHOD_NOT_ALLOWED",
            message: "use POST /metadata/upload",
          });
          return;
        }
        await handleMetadataUpload(request, response);
        return;
      }
      if (url.startsWith("/burn")) {
        if (options.burnEnabled === false) {
          respondJson(response, 503, {
            code: "BURNS_DISABLED",
            message: "burn submission is disabled on this revision",
          });
          return;
        }
        if (url === "/burn" && options.oneShotEnabled === false) {
          respondJson(response, 410, {
            code: "CALLER_PAID_ONLY",
            message:
              "this revision has no fee payer; use POST /burn/prepare, sign, then POST /burn/submit",
          });
          return;
        }
        const callerPaidAction =
          url === "/burn/prepare"
            ? options.prepare
            : url === "/burn/submit"
            ? options.submitSigned
            : undefined;
        if (callerPaidAction) {
          if (request.method !== "POST") {
            response.setHeader("allow", "POST");
            respondJson(response, 405, {
              code: "METHOD_NOT_ALLOWED",
              message: `use POST ${url}`,
            });
            return;
          }
          await handleOperation(
            request,
            response,
            url.endsWith("prepare") ? "prepare" : "submit",
            callerPaidAction
          );
          return;
        }
        if (url !== "/burn") {
          respondJson(response, 404, {
            code: "NOT_FOUND",
            message: "unknown path",
          });
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          respondJson(response, 405, {
            code: "METHOD_NOT_ALLOWED",
            message: "use POST /burn",
          });
          return;
        }
        await handleOperation(
          request,
          response,
          "burn",
          (parsed) =>
            service.execute(parsed) as Promise<
              Readonly<Record<string, unknown>>
            >
        );
        return;
      }
      respondJson(response, 404, {
        code: "NOT_FOUND",
        message: "unknown path",
      });
    })();
    handled.catch((error) => {
      emit("error", "request-handler-error", {
        route,
        detail: sanitizeForTransport(
          error instanceof Error ? error.message : String(error)
        ),
      });
      if (!response.headersSent) {
        respondJson(response, 500, {
          code: "INTERNAL",
          message: "internal error",
        });
      } else {
        response.destroy();
      }
    });
  });
  // Time to RECEIVE a request; processing time is governed per-burn above.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  async function shutdown(reason: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      draining = true;
      emit("info", "shutdown-start", { reason, inflight: inflight.size });
      const closed = server.listening
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : Promise.resolve();
      if (server.listening) server.closeIdleConnections();
      const drainDeadline = new Promise<"FORCED">((resolve) => {
        const timer = setTimeout(() => resolve("FORCED"), shutdownGraceMs);
        timer.unref();
      });
      const drained = await Promise.race([
        Promise.allSettled([...inflight]).then(() => "DRAINED" as const),
        drainDeadline,
      ]);
      if (drained === "FORCED" && inflight.size > 0) {
        // Never abort the burns; the platform may SIGKILL us, but anything
        // already submitted is complete and self-broadcasting, and anything
        // not yet submitted fails cleanly with its lease expiring by TTL.
        emit("error", "shutdown-forced-with-inflight", {
          inflight: inflight.size,
        });
      }
      if (server.listening) server.closeAllConnections();
      await closed.catch(() => undefined);
      emit("info", "shutdown-complete", {
        drained: drained === "DRAINED",
        inflight: inflight.size,
      });
    })();
    return shutdownPromise;
  }

  if (options.installSignalHandlers) {
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  }

  return {
    server,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      }),
    shutdown,
    inflightCount: () => inflight.size,
  };
}

// ---------------------------------------------------------------------------
// Environment configuration (same surface as cli.ts)
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (!raw && fallback !== undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function cloudflareWorkerOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CLOUDFLARE_IMAGE_WORKER_URL must be a valid URL origin");
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.origin !== raw.replace(/\/$/, "") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CLOUDFLARE_IMAGE_WORKER_URL must be an HTTPS origin without credentials or a path"
    );
  }
  return url.origin;
}

async function readFetchBodyWithCap(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new MetadataUploadError(
          "IMAGE_COMPRESSION_FAILED",
          "Cloudflare returned an oversized compressed image",
          502
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Cloudflare is deliberately a stateless transform/delivery layer here. The
 * Worker receives bounded bytes, returns a normalized WebP, and stores no
 * source object. Both URIs written into token metadata remain Irys URIs.
 */
export function createCloudflareImageCompressor(
  workerUrl: string,
  bearerToken: string,
  fetchImplementation: typeof fetch = fetch
): MetadataImageCompressor {
  const origin = cloudflareWorkerOrigin(workerUrl);
  if (bearerToken.length < 32) {
    throw new Error(
      "CLOUDFLARE_IMAGE_WORKER_TOKEN must contain at least 32 characters"
    );
  }
  return {
    async compress(image, contentType) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      // Node timers expose unref(); Web-standard Worker timers do not.
      (timer as unknown as { unref?: () => void }).unref?.();
      try {
        const requestBody = new ArrayBuffer(image.length);
        new Uint8Array(requestBody).set(image);
        const response = await fetchImplementation(`${origin}/compress`, {
          method: "POST",
          headers: {
            accept: "image/webp",
            authorization: `Bearer ${bearerToken}`,
            "content-type": contentType,
          },
          body: requestBody,
          // NOT `redirect: "error"`: workerd rejects that value outright —
          // "won't be implemented since it does not make sense at the edge" —
          // and it throws when the Request is built, so the compressor never
          // even reaches the image Worker. Observed live as a blanket
          // IMAGE_COMPRESSION_FAILED with zero requests arriving at the
          // pipeline. "manual" keeps the same property (a redirect is never
          // followed) and is checked explicitly below.
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new MetadataUploadError(
            "IMAGE_COMPRESSION_FAILED",
            "Cloudflare image compression is unavailable",
            502
          );
        }
        if (!response.ok) {
          if ([400, 413, 415, 422].includes(response.status)) {
            throw new MetadataUploadError(
              "INVALID_IMAGE",
              "image could not be decoded and compressed",
              415
            );
          }
          throw new MetadataUploadError(
            "IMAGE_COMPRESSION_FAILED",
            "Cloudflare image compression is unavailable",
            502
          );
        }
        if (
          !/^image\/webp\b/i.test(response.headers.get("content-type") ?? "")
        ) {
          throw new MetadataUploadError(
            "IMAGE_COMPRESSION_FAILED",
            "Cloudflare returned an invalid compressed image type",
            502
          );
        }
        const compressed = await readFetchBodyWithCap(
          response,
          MAX_COMPRESSED_METADATA_IMAGE_BYTES
        );
        if (
          !compressed.length ||
          !hasImageSignature(compressed, "image/webp")
        ) {
          throw new MetadataUploadError(
            "IMAGE_COMPRESSION_FAILED",
            "Cloudflare returned invalid compressed image bytes",
            502
          );
        }
        return { image: compressed, contentType: "image/webp" };
      } catch (error) {
        if (error instanceof MetadataUploadError) throw error;
        // Never transport upstream diagnostics: the request contains the
        // Worker credential in an Authorization header.
        throw new MetadataUploadError(
          "IMAGE_COMPRESSION_FAILED",
          "Cloudflare image compression is unavailable",
          502
        );
      } finally {
        clearTimeout(timer);
      }
    },
    deliveryUri(permanentImageUri) {
      const permanent = new URL(permanentImageUri);
      const match = permanent.pathname.match(
        /^\/(?:([A-Za-z0-9_-]{43})|([1-9A-HJ-NP-Za-km-z]{44}))$/
      );
      if (
        permanent.origin !== "https://gateway.irys.xyz" ||
        permanent.search ||
        permanent.hash ||
        !match
      ) {
        throw new MetadataUploadError(
          "IRYS_UPLOAD_FAILED",
          "Irys returned an invalid image URI",
          502
        );
      }
      return `${origin}/irys/${match[1] ?? match[2]}`;
    },
  };
}

type IrysInteger = Readonly<{ toString: () => string }>;
type IrysReceipt = unknown;
type IrysUploaderClient = Readonly<{
  address?: string;
  ready?: () => Promise<unknown>;
  getBalance: () => Promise<IrysInteger>;
  getPrice: (bytes: number) => Promise<IrysInteger>;
  upload: (
    data: Uint8Array | string,
    options: Readonly<{
      tags: readonly Readonly<{ name: string; value: string }>[];
    }>
  ) => Promise<IrysReceipt>;
  utils: Readonly<{
    fromAtomic: (value: IrysInteger) => unknown;
  }>;
}>;

function irysInteger(value: IrysInteger): bigint {
  const raw = value.toString();
  if (!/^\d+$/.test(raw)) {
    throw new MetadataUploadError(
      "IRYS_UPLOAD_FAILED",
      "Irys returned an invalid balance or price",
      502
    );
  }
  return BigInt(raw);
}

function isIrysInsufficientFunds(error: unknown): boolean {
  const status =
    error && typeof error === "object"
      ? Number(
          (error as { status?: unknown }).status ??
            (error as { response?: { status?: unknown } }).response?.status
        )
      : NaN;
  if (status === 402) return true;
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("not enough balance") ||
    message.includes("insufficient balance") ||
    message.includes("insufficient funds")
  );
}

function normalizeIrysId(value: unknown): string | null {
  if (
    typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)
  ) {
    // Current Irys mainnet receipts use a base58-encoded 32-byte id. Parsing
    // through Solana's PublicKey implementation proves both the alphabet and
    // decoded width; re-encoding rejects non-canonical spellings.
    try {
      if (new PublicKey(value).toBase58() === value) return value;
    } catch {
      // Fall through to the historical base64url receipt format.
    }
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}=?$/.test(value)) {
    return null;
  }
  // Irys historically returned the canonical unpadded 43-character base64url
  // transaction id. Its current uploader may return the equivalent 44-byte
  // spelling with one trailing `=`. Decode before normalising so no other
  // 44-character string can be mistaken for an id.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return null;
  }
  return decoded.length === 32 ? value.replace(/=$/, "") : null;
}

function irysUri(receipt: IrysReceipt): string {
  // The Irys Node client normally returns the decoded receipt object. Under
  // workerd its Axios fetch adapter can leave the JSON body serialized, and
  // some adapter versions retain one `data` response wrapper. Accept those
  // transport representations only; the final value must still be the exact
  // public 32-byte content id before it can become a URI.
  let value: unknown = receipt;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      const id = normalizeIrysId(trimmed);
      if (id) {
        return `https://gateway.irys.xyz/${id}`;
      }
      try {
        value = JSON.parse(trimmed) as unknown;
        continue;
      } catch {
        break;
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Readonly<Record<string, unknown>>;
      const id = normalizeIrysId(object.id);
      if (id) {
        return `https://gateway.irys.xyz/${id}`;
      }
      if ("data" in object) {
        value = object.data;
        continue;
      }
    }
    break;
  }
  throw new MetadataUploadError(
    "IRYS_UPLOAD_FAILED",
    "Irys returned an invalid upload receipt",
    502
  );
}

/**
 * The paid executor is separately injectable so HTTP tests never need a
 * secret or a live Irys account. It preflights the price of BOTH writes and
 * never auto-funds: an empty account is an explicit operator error.
 */
export function createIrysMetadataUploadExecutor(
  irys: IrysUploaderClient,
  compressor: MetadataImageCompressor
): (input: MetadataUploadInput) => Promise<MetadataUploadResult> {
  return async (input) => {
    const compressed = await compressor.compress(
      input.image,
      input.imageContentType
    );
    const placeholderImageUri = `https://gateway.irys.xyz/${"x".repeat(43)}`;
    const metadataFor = (image: string) =>
      Buffer.from(
        JSON.stringify({
          name: input.name,
          symbol: input.symbol,
          description: input.description,
          image,
          // Pump and the explorers read these at the top level. Absent keys
          // are omitted rather than written empty, so a token with no socials
          // carries no dead fields in permanent storage.
          ...(input.links ?? {}),
        }),
        "utf8"
      );
    const estimatedMetadata = metadataFor(placeholderImageUri);
    if (estimatedMetadata.length > MAX_METADATA_JSON_BYTES) {
      throw new MetadataUploadError(
        "UPLOAD_TOO_LARGE",
        `metadata JSON exceeds ${MAX_METADATA_JSON_BYTES} bytes`,
        413
      );
    }
    try {
      const [balanceValue, imagePriceValue, metadataPriceValue] =
        await Promise.all([
          irys.getBalance(),
          irys.getPrice(compressed.image.length),
          irys.getPrice(estimatedMetadata.length),
        ]);
      const balance = irysInteger(balanceValue);
      const required =
        irysInteger(imagePriceValue) + irysInteger(metadataPriceValue);
      if (balance < required) {
        throw new MetadataUploadError(
          "IRYS_INSUFFICIENT_FUNDS",
          "metadata upload is unavailable because the service's Irys balance is insufficient",
          503
        );
      }
      const imageUri = irysUri(
        await irys.upload(compressed.image, {
          tags: [
            { name: "Content-Type", value: compressed.contentType },
            { name: "application-id", value: "onchain-burner" },
          ],
        })
      );
      // This URL is for optional app delivery only. The permanent JSON below
      // points at imageUri, so loss of our Cloudflare account cannot break the
      // token's recorded image.
      const deliveryImageUri = compressor.deliveryUri(imageUri);
      const metadata = metadataFor(imageUri);
      const uri = irysUri(
        await irys.upload(metadata, {
          tags: [
            { name: "Content-Type", value: "application/json" },
            { name: "application-id", value: "onchain-burner" },
          ],
        })
      );
      return {
        uri,
        imageUri,
        deliveryImageUri,
        originalImageBytes: input.image.length,
        imageBytes: compressed.image.length,
      };
    } catch (error) {
      if (error instanceof MetadataUploadError) throw error;
      if (isIrysInsufficientFunds(error)) {
        throw new MetadataUploadError(
          "IRYS_INSUFFICIENT_FUNDS",
          "metadata upload is unavailable because the service's Irys balance is insufficient",
          503
        );
      }
      // The SDK's message is deliberately discarded. It must never echo the
      // wallet material through either this typed error or the HTTP logger.
      throw new MetadataUploadError(
        "IRYS_UPLOAD_FAILED",
        "Irys metadata upload failed",
        502
      );
    }
  };
}

export function createMetadataImagePrepareExecutor(
  compressor: MetadataImageCompressor
): (input: MetadataImagePrepareInput) => Promise<MetadataImagePrepareResult> {
  return async (input) => {
    const compressed = await compressor.compress(
      input.image,
      input.imageContentType
    );
    return {
      imageBase64: compressed.image.toString("base64"),
      imageContentType: compressed.contentType,
      originalImageBytes: input.image.length,
      imageBytes: compressed.image.length,
    };
  };
}

function irysWalletFromEnvironment(raw: string): string | Uint8Array {
  if (!raw.trim().startsWith("[")) return raw.trim();
  try {
    const bytes = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(bytes) ||
      bytes.length !== 64 ||
      bytes.some(
        (value) =>
          !Number.isSafeInteger(value) ||
          Number(value) < 0 ||
          Number(value) > 255
      )
    ) {
      throw new Error("invalid");
    }
    return Uint8Array.from(bytes as number[]);
  } catch {
    // Fixed text only: never repeat the rejected secret.
    throw new Error(
      "IRYS_PRIVATE_KEY must be a base58 Solana secret key or a 64-byte JSON array"
    );
  }
}

export async function metadataUploadFromEnvironment(
  log: LogSink,
  allowedOrigins: readonly string[],
  imageFetch: typeof fetch = fetch
): Promise<
  ((input: MetadataUploadInput) => Promise<MetadataUploadResult>) | undefined
> {
  const secret = process.env.IRYS_PRIVATE_KEY;
  const cloudflareWorkerUrl = process.env.CLOUDFLARE_IMAGE_WORKER_URL;
  const cloudflareWorkerToken = process.env.CLOUDFLARE_IMAGE_WORKER_TOKEN;
  const missing = [
    ...(!secret ? ["IRYS_PRIVATE_KEY"] : []),
    ...(!cloudflareWorkerUrl ? ["CLOUDFLARE_IMAGE_WORKER_URL"] : []),
    ...(!cloudflareWorkerToken ? ["CLOUDFLARE_IMAGE_WORKER_TOKEN"] : []),
  ];
  if (missing.length) {
    log({
      ts: new Date().toISOString(),
      level: "warn",
      event: "metadata-upload-disabled",
      reason: `${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } not configured`,
    });
    return undefined;
  }
  if (!allowedOrigins.length || allowedOrigins.includes("*")) {
    throw new Error(
      "BURNER_ALLOWED_ORIGINS must contain explicit origins when IRYS_PRIVATE_KEY is configured"
    );
  }
  const compressor = createCloudflareImageCompressor(
    cloudflareWorkerUrl!,
    cloudflareWorkerToken!,
    imageFetch
  );
  const wallet = irysWalletFromEnvironment(secret!);
  let irys: IrysUploaderClient;
  try {
    // Keep tests and revisions without metadata upload from initializing the
    // SDK. The local module uses STATIC package imports so Wrangler must bundle
    // them; an unresolved bare import can no longer survive a false-positive
    // dry-run only to fail on the first paid upload.
    const { createIrysUploader } = await import("./irys-client");
    irys = (await createIrysUploader(
      wallet,
      process.env.BURNER_RPC_URL
    )) as unknown as IrysUploaderClient;
    await irys.ready?.();
    const balance = await irys.getBalance();
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "metadata-upload-enabled",
      balanceAtomic: balance.toString(),
      balanceSol: String(irys.utils.fromAtomic(balance)),
      imagePipeline: "cloudflare-images-to-irys",
      allowedOrigins: allowedOrigins.length,
    });
  } catch {
    // Do not forward SDK diagnostics: future versions could include wallet
    // configuration in a thrown object.
    throw new Error("Irys metadata upload failed to initialize");
  }
  return createIrysMetadataUploadExecutor(irys, compressor);
}

export async function metadataPipelineFromEnvironment(
  log: LogSink,
  allowedOrigins: readonly string[],
  imageFetch: typeof fetch = fetch
): Promise<
  | Readonly<{
      upload: (input: MetadataUploadInput) => Promise<MetadataUploadResult>;
      prepareImage: (
        input: MetadataImagePrepareInput
      ) => Promise<MetadataImagePrepareResult>;
    }>
  | undefined
> {
  const upload = await metadataUploadFromEnvironment(
    log,
    allowedOrigins,
    imageFetch
  );
  if (!upload) return undefined;
  const workerUrl = process.env.CLOUDFLARE_IMAGE_WORKER_URL!;
  const workerToken = process.env.CLOUDFLARE_IMAGE_WORKER_TOKEN!;
  const compressor = createCloudflareImageCompressor(
    workerUrl,
    workerToken,
    imageFetch
  );
  return {
    upload,
    prepareImage: createMetadataImagePrepareExecutor(compressor),
  };
}

function policyFromEnv(
  production: boolean,
  defaults: Partial<{
    maxAmountLamports: string;
    maxSlippageBps: number;
    maxPriceImpactBps: number;
  }> = {}
): QuoteServicePolicy {
  const maxAmount =
    process.env.BURNER_MAX_AMOUNT_LAMPORTS ?? defaults.maxAmountLamports;
  if (!maxAmount) {
    throw new Error(
      "missing required environment variable BURNER_MAX_AMOUNT_LAMPORTS"
    );
  }
  return {
    production,
    maxAmountPerBurn: BigInt(maxAmount),
    maxSlippageBps: positiveInteger(
      "BURNER_MAX_SLIPPAGE_BPS",
      defaults.maxSlippageBps
    ),
    maxPriceImpactBps: positiveInteger(
      "BURNER_MAX_PRICE_IMPACT_BPS",
      defaults.maxPriceImpactBps
    ),
    computeUnitLimit: positiveInteger("BURNER_COMPUTE_UNIT_LIMIT", 1_400_000),
    minRemainingBlockHeights: positiveInteger(
      "BURNER_MIN_REMAINING_BLOCK_HEIGHTS",
      50
    ),
    leaseTtlMs: positiveInteger("BURNER_VAULT_LEASE_TTL_MS", 180_000),
    retryAttempts:
      process.env.BURNER_RETRY_ATTEMPTS !== undefined
        ? nonNegativeInteger("BURNER_RETRY_ATTEMPTS", 2)
        : undefined,
    fittingMaxAccounts: (
      process.env.BURNER_FITTING_MAX_ACCOUNTS ?? "40,32,26,20,16,12"
    )
      .split(",")
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0),
    approvedLookupTables: new Set(
      (process.env.BURNER_APPROVED_LOOKUP_TABLES ?? "")
        .split(",")
        .filter(Boolean)
    ),
  };
}

export type Wiring = Readonly<{
  service: BurnExecutor;
  readiness: () => Promise<void>;
  mode: "production" | "fork-e2e";
  burnEnabled?: boolean;
  oneShotEnabled?: boolean;
  prepare?: (parsed: JsonBody) => Promise<Readonly<Record<string, unknown>>>;
  submitSigned?: (
    parsed: JsonBody
  ) => Promise<Readonly<Record<string, unknown>>>;
  health?: () => Promise<Readonly<Record<string, unknown>>>;
  markets?: (mint: string) => Promise<Readonly<Record<string, unknown>>>;
  resolve?: (
    mint: string,
    pool: string | null
  ) => Promise<Readonly<Record<string, unknown>>>;
}>;

/**
 * The GET /health and GET /reference/markets providers, shared by both
 * wirings. Market enumeration runs real filtered getProgramAccounts against
 * the wiring's own RPC (a Surfpool fork proxies those to its mainnet
 * datasource) and each candidate is then authenticated by the proven
 * resolver, so a wrong or hostile enumeration answer can at worst surface a
 * genuine allow-listed pool, never bind a fake one.
 */
type ReferenceRouteProbe = (
  mint: PublicKey
) => Promise<readonly unknown[] | undefined>;

function makeReferenceRouteProbe(
  apiKey: string | undefined
): ReferenceRouteProbe | undefined {
  if (!apiKey) return undefined;
  const endpoint = new URL(
    process.env.JUPITER_REFERENCE_QUOTE_URL ??
      "https://api.jup.ag/swap/v1/quote"
  );
  if (endpoint.protocol !== "https:") {
    throw new Error("JUPITER_REFERENCE_QUOTE_URL must use HTTPS");
  }
  let nextAllowedAt = 0;
  return async (mint) => {
    const now = Date.now();
    // The configured Jupiter tier is 0.5 RPS. Do not queue interactive
    // lookups behind one another; skip the optional hint and use RPC when an
    // isolate has spent its one request in the preceding two seconds.
    if (now < nextAllowedAt) return undefined;
    nextAllowedAt = now + 2_100;
    const url = new URL(endpoint);
    url.searchParams.set("inputMint", WSOL_ADDRESS);
    url.searchParams.set("outputMint", mint.toBase58());
    url.searchParams.set("amount", "100000000");
    url.searchParams.set("slippageBps", "100");
    url.searchParams.set("restrictIntermediateTokens", "true");
    url.searchParams.set("dexes", SUPPORTED_REFERENCE_DEXES.join(","));
    const response = await fetch(url, {
      headers: { accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { routePlan?: unknown };
    return Array.isArray(payload.routePlan) ? payload.routePlan : undefined;
  };
}

function makeInfoHandlers(
  connection: Connection,
  rpcUrl: string,
  mode: string,
  burnerProgram: PublicKey,
  payer?: PublicKey,
  routeProbe?: ReferenceRouteProbe
): Pick<Wiring, "health" | "markets" | "resolve"> {
  async function retryReferenceRpc<T>(
    label: string,
    operation: () => Promise<T>
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 150 * 2 ** (attempt - 1));
            timer.unref();
          });
        }
      }
    }
    throw new ReferenceDiscoveryError(
      "REFERENCE_DISCOVERY_UNAVAILABLE",
      `${label} failed after 3 attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  const accountReader: AccountDataReader = {
    async getAccountData(address: PublicKey) {
      const info = await retryReferenceRpc(
        `getAccountInfo(${address.toBase58()})`,
        () => connection.getAccountInfo(address, "confirmed")
      );
      return info ? { owner: info.owner, data: info.data } : null;
    },
  };
  const gpaReader: ProgramAccountsReader = {
    async getProgramAddresses(program, filters) {
      const result = await retryReferenceRpc(
        `getProgramAccounts(${program.toBase58()})`,
        () =>
          connection.getProgramAccounts(program, {
            commitment: "confirmed",
            dataSlice: { offset: 0, length: 0 },
            filters: filters as never,
          })
      );
      return result.map((entry) => entry.pubkey);
    },
  };
  const discoverReference = createReferenceDiscovery((mint) =>
    selectReference(
      accountReader,
      gpaReader,
      mint,
      `getProgramAccounts via ${rpcUrl}`,
      routeProbe ? () => routeProbe(mint) : undefined
    )
  );
  return {
    health: async () => ({
      mode,
      slot: await connection.getSlot("confirmed"),
      program: burnerProgram.toBase58(),
      ...(payer ? { payer: payer.toBase58() } : {}),
    }),
    markets: async (mint: string) =>
      marketSelectionForTransport(await discoverReference(new PublicKey(mint))),
    resolve: async (mintRaw: string, poolRaw: string | null) => {
      const mint = new PublicKey(mintRaw);
      const strip = (
        resolved: Awaited<ReturnType<typeof resolveCandidate>>,
        discovery: string
      ) => {
        const { reference: _reference, ...candidate } = resolved;
        return { candidate, discovery };
      };
      if (poolRaw) {
        return strip(
          await resolveCandidate(
            accountReader,
            mint,
            poolRaw === "pump" ? "pump" : new PublicKey(poolRaw)
          ),
          poolRaw === "pump" ? "Pump venue (derived)" : "explicit pool"
        );
      }
      const selection = await discoverReference(mint);
      if (!selection.chosen) {
        throw new PolicyError("RESOLVE_FAILED", selection.pickReason);
      }
      return strip(selection.chosen, selection.pickReason);
    },
  };
}

async function endpointReachable(url: string, label: string): Promise<void> {
  try {
    await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
      redirect: "manual",
    });
  } catch (error) {
    throw new Error(
      `${label} unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * The keyless caller-paid handlers, shared by both wirings.
 *
 * prepare: `{ callerPublicKey, ...BurnRequest }` in; the unsigned
 * transaction (caller = sole required signer) plus its receipt metadata out.
 * submit: `{ signedTransactionBase64 }` in; the gate refuses anything that
 * is not exactly a fully caller-signed [ComputeBudget, burner] transaction,
 * then relays it. Both are stateless — there is no preparation store,
 * because there is no service signature for one to protect.
 */
function makeCallerPaidHandlers(
  service: QuoteService,
  burnerProgram: PublicKey,
  submitter: PrivateSubmitter
): Pick<Wiring, "prepare" | "submitSigned"> {
  return {
    prepare: async (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PolicyError(
          "INVALID_REQUEST",
          "prepare request must be an object"
        );
      }
      const { callerPublicKey, ...semantic } = parsed as Record<
        string,
        unknown
      >;
      if (typeof callerPublicKey !== "string") {
        throw new PolicyError(
          "INVALID_CALLER",
          "callerPublicKey must be a base58 public key"
        );
      }
      let caller: PublicKey;
      try {
        caller = new PublicKey(callerPublicKey);
      } catch {
        throw new PolicyError(
          "INVALID_CALLER",
          "callerPublicKey must be a base58 public key"
        );
      }
      const prepared = await service.prepare(semantic, caller);
      return {
        preparationId: prepared.requestId,
        requestId: prepared.requestId,
        vault: prepared.vault,
        callerPublicKey: caller.toBase58(),
        transactionBase64: Buffer.from(
          prepared.transaction.serialize()
        ).toString("base64"),
        messageSha256: prepared.messageSha256,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        contextSlot: prepared.contextSlot,
        transactionBytes: prepared.transactionBytes,
        accountLocks: prepared.accountLocks,
        simulatedUnits: prepared.simulatedUnits,
        minimumOutputs: prepared.minimumOutputs,
      };
    },
    submitSigned: async (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PolicyError(
          "INVALID_REQUEST",
          "submit request must be an object"
        );
      }
      const object = parsed as Record<string, unknown>;
      const unknown = Object.keys(object).filter(
        (key) => key !== "requestId" && key !== "signedTransactionBase64"
      );
      if (unknown.length) {
        throw new PolicyError(
          "FORBIDDEN_REQUEST_FIELD",
          `submit contains forbidden fields: ${unknown.join(",")}`
        );
      }
      if (
        typeof object.signedTransactionBase64 !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(object.signedTransactionBase64)
      ) {
        throw new PolicyError(
          "INVALID_TRANSACTION",
          "signedTransactionBase64 must be base64"
        );
      }
      const wire = Buffer.from(object.signedTransactionBase64, "base64");
      const gate = assertSubmittableSignedTransaction(wire, burnerProgram);
      const submission = await submitter.submit(wire, {
        purpose: "onchain-burner-keyless-relay",
        messageSha256: gate.messageSha256,
        feePayer: gate.feePayer.toBase58(),
        ...(typeof object.requestId === "string"
          ? { requestId: object.requestId.slice(0, 128) }
          : {}),
      });
      return {
        requestId:
          typeof object.requestId === "string"
            ? object.requestId.slice(0, 128)
            : undefined,
        submissionId: submission.submissionId,
        messageSha256: gate.messageSha256,
        transactionBytes: wire.length,
      };
    },
  };
}

/** Straight-to-RPC submitter used where no private relay is configured. */
class RpcSubmitter implements PrivateSubmitter {
  constructor(private readonly connection: Connection) {}

  async submit(transaction: Uint8Array) {
    const submissionId = await this.connection.sendRawTransaction(
      Buffer.from(transaction),
      { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }
    );
    return { submissionId };
  }
}

export function buildProductionWiring(log: LogSink): Wiring {
  const rpcUrl = required("BURNER_RPC_URL");
  if (!rpcUrl.startsWith("https://")) {
    throw new Error("BURNER_RPC_URL must use HTTPS");
  }
  const burnerProgram = new PublicKey(
    process.env.BURNER_PROGRAM_ID ?? DEFAULT_BURNER_PROGRAM
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const chain = new SolanaRpcGateway(connection);
  const jupiterApiKey =
    process.env.JUPITER_API_KEY ?? process.env.JUPITER_PRIVATE_KEY;
  const jupiter = new JupiterV2HttpClient(
    process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
    jupiterApiKey
  );
  // A private relay (e.g. a Jito bundle endpoint) is optional operational
  // hygiene, not a control: with no service signature there is nothing to
  // withhold, and callers can always submit their signed burn anywhere.
  const privateSubmitUrl = process.env.BURNER_PRIVATE_SUBMIT_URL;
  const submitter: PrivateSubmitter = privateSubmitUrl
    ? new HttpPrivateSubmitter(
        privateSubmitUrl,
        process.env.BURNER_PRIVATE_SUBMIT_BEARER_TOKEN
      )
    : new RpcSubmitter(connection);
  const policy = policyFromEnv(true);
  const service = new QuoteService({
    burnerProgram,
    chain,
    jupiter,
    directCurve: new PumpDirectCurveClient(connection),
    // No fee payer: production is caller-paid only, and prepare needs no
    // signer of any kind. One-shot /burn answers 410.
    submitter,
    leaseStore: new InMemoryVaultLeaseStore(),
    policy,
    onEvent: (fields) =>
      log({ ts: new Date().toISOString(), level: "info", ...fields }),
  });
  return {
    mode: "production",
    burnEnabled: true,
    oneShotEnabled: false,
    service,
    ...makeCallerPaidHandlers(service, burnerProgram, submitter),
    ...makeInfoHandlers(
      connection,
      rpcUrl,
      "production",
      burnerProgram,
      undefined,
      makeReferenceRouteProbe(jupiterApiKey)
    ),
    readiness: async () => {
      await Promise.all([
        chain.getBlockHeight(),
        ...(privateSubmitUrl
          ? [endpointReachable(privateSubmitUrl, "private submitter")]
          : []),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Explicit fork end-to-end mode
// ---------------------------------------------------------------------------

/** Venues a Surfpool fork can serve (FORK_DEX_PROFILE=pool equivalent). */
const POOL_ONLY_FORK_DEXES: readonly string[] = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
  "Pump.fun Amm",
  "Pump.fun",
];

/**
 * Fork-only route shaping. Applies the pool venue include-list (minus any
 * venues the QuoteService excluded, e.g. the 6018 Pump exclusion) and a
 * fixed slippage tolerance, because Jupiter RTSE estimates from LIVE mainnet
 * state while fork pools are frozen at the fork slot. Production wiring
 * never constructs this class.
 */
class ForkDexProfileJupiterClient implements JupiterClient {
  constructor(
    private readonly inner: JupiterClient,
    private readonly profile: readonly string[],
    private readonly slippageBps: number | undefined
  ) {}

  async build(params: JupiterBuildParams) {
    const excluded = new Set(params.excludeDexes ?? []);
    return this.inner.build({
      ...params,
      excludeDexes: undefined,
      dexes: this.profile.filter((venue) => !excluded.has(venue)),
      slippageBps: params.slippageBps ?? this.slippageBps,
    });
  }
}

function readKeypairFile(filename: string): Keypair {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(filename, "utf8")) as number[])
  );
}

function buildForkWiring(log: LogSink): Wiring {
  const rpcUrl = process.env.BURNER_RPC_URL ?? "http://127.0.0.1:8899";
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(rpcUrl)) {
    throw new Error(
      `fork-e2e mode refuses non-local RPC ${rpcUrl}; it exists only for a local Surfpool fork`
    );
  }
  const payer = readKeypairFile(
    process.env.SOLANA_KEYPAIR ??
      require("node:path").join(
        require("node:os").homedir(),
        ".config",
        "solana",
        "id.json"
      )
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const chain = new SolanaRpcGateway(connection);
  const burnerProgram = new PublicKey(
    process.env.BURNER_PROGRAM_ID ?? DEFAULT_BURNER_PROGRAM
  );
  const submitter = new RpcSubmitter(connection);
  const forkDexes = (process.env.BURNER_FORK_DEXES ?? "")
    .split(",")
    .map((venue) => venue.trim())
    .filter(Boolean);
  const rawJupiter = new JupiterV2HttpClient(
    process.env.JUPITER_V2_URL ?? "https://api.jup.ag/swap/v2/",
    process.env.JUPITER_API_KEY
  );
  const forkJupiter = new ForkDexProfileJupiterClient(
    rawJupiter,
    forkDexes.length ? forkDexes : POOL_ONLY_FORK_DEXES,
    nonNegativeInteger("BURNER_FORK_SLIPPAGE_BPS", 1_500) || undefined
  );
  const service = new QuoteService({
    burnerProgram,
    chain,
    jupiter: forkJupiter,
    directCurve: new PumpDirectCurveClient(connection),
    feePayerSigner: new LocalKeypairMessageSigner(payer),
    submitter,
    leaseStore: new InMemoryVaultLeaseStore(),
    policy: policyFromEnv(false, {
      maxAmountLamports: "200000000000",
      maxSlippageBps: 2_000,
      maxPriceImpactBps: 2_500,
    }),
    onEvent: (fields) =>
      log({ ts: new Date().toISOString(), level: "info", ...fields }),
  });
  return {
    service,
    mode: "fork-e2e",
    oneShotEnabled: true,
    ...makeCallerPaidHandlers(service, burnerProgram, submitter),
    ...makeInfoHandlers(
      connection,
      rpcUrl,
      "fork-e2e",
      burnerProgram,
      payer.publicKey
    ),
    readiness: async () => {
      await chain.getBlockHeight();
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const log = defaultLogSink;
  const mode = process.env.BURNER_ENV;
  const allowedOrigins = (process.env.BURNER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("BURNER_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) {
      throw new Error(
        "BURNER_ALLOWED_ORIGINS entries must be exact http(s) origins without paths"
      );
    }
  }
  let wiring: Wiring;
  if (mode === "production") {
    wiring = buildProductionWiring(log);
  } else if (mode === "fork-e2e") {
    wiring = buildForkWiring(log);
  } else {
    throw new Error("BURNER_ENV must be 'production' or 'fork-e2e'");
  }
  const metadataUpload = await metadataUploadFromEnvironment(
    log,
    allowedOrigins
  );
  const handle = createBurnServer(wiring.service, {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "0.0.0.0",
    maxBodyBytes: positiveInteger("BURNER_MAX_BODY_BYTES", 16_384),
    requestDeadlineMs: positiveInteger("BURNER_REQUEST_DEADLINE_MS", 150_000),
    referenceRequestDeadlineMs: positiveInteger(
      "BURNER_REFERENCE_DEADLINE_MS",
      DEFAULT_REFERENCE_DISCOVERY_DEADLINE_MS + 1_000
    ),
    maxInflightBurns: positiveInteger("BURNER_MAX_INFLIGHT", 8),
    maxInflightMetadataUploads: positiveInteger(
      "BURNER_MAX_INFLIGHT_UPLOADS",
      1
    ),
    metadataUploadMaxRequestBytes: positiveInteger(
      "BURNER_MAX_UPLOAD_REQUEST_BYTES",
      MAX_METADATA_UPLOAD_REQUEST_BYTES
    ),
    metadataUploadRateLimitPerIp: positiveInteger(
      "BURNER_UPLOADS_PER_IP_PER_HOUR",
      3
    ),
    metadataUploadGlobalRateLimit: positiveInteger(
      "BURNER_UPLOADS_GLOBAL_PER_HOUR",
      30
    ),
    metadataUploadRateWindowMs: 60 * 60 * 1_000,
    trustProxy: process.env.BURNER_TRUST_PROXY === "true",
    shutdownGraceMs: positiveInteger("BURNER_SHUTDOWN_GRACE_MS", 8_000),
    bearerToken: process.env.BURNER_SERVICE_BEARER_TOKEN,
    burnEnabled: wiring.burnEnabled,
    oneShotEnabled: wiring.oneShotEnabled,
    prepare: wiring.prepare,
    submitSigned: wiring.submitSigned,
    health: wiring.health,
    markets: wiring.markets,
    resolve: wiring.resolve,
    metadataUpload,
    allowedOrigins,
    readiness: wiring.readiness,
    log,
    installSignalHandlers: true,
  });
  process.on("uncaughtException", (error) => {
    log({
      ts: new Date().toISOString(),
      level: "fatal",
      event: "uncaught-exception",
      detail: sanitizeForTransport(error.message),
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log({
      ts: new Date().toISOString(),
      level: "fatal",
      event: "unhandled-rejection",
      detail: sanitizeForTransport(
        reason instanceof Error ? reason.message : String(reason)
      ),
    });
    process.exit(1);
  });
  const port = await handle.listen();
  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "listening",
    mode: wiring.mode,
    port,
  });
  const exitAfterShutdown = () =>
    void handle.shutdown("signal").then(() => process.exit(0));
  process.once("SIGTERM", exitAfterShutdown);
  process.once("SIGINT", exitAfterShutdown);
}
