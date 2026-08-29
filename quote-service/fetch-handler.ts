/**
 * Web-standard HTTP transport for the quote service.
 *
 * This module owns Request/Response plumbing only. Transaction construction,
 * route validation, reference discovery, submission, and metadata upload are
 * injected through the same operations used by the Node transport.
 */
import { PolicyError, QuoteService } from "./core";
import {
  DEFAULT_REFERENCE_DISCOVERY_DEADLINE_MS,
  ReferenceDiscoveryError,
} from "./markets";
import {
  MAX_METADATA_UPLOAD_REQUEST_BYTES,
  MetadataImagePrepareInput,
  MetadataImagePrepareResult,
  MetadataUploadError,
  MetadataUploadInput,
  MetadataUploadResult,
  LogSink,
  parseMetadataImagePrepareRequest,
  parseMetadataUploadRequest,
  policyErrorStatus,
  sanitizeForTransport,
} from "./server";
import { isPlausibleMint, tokenImageBytes, tokenInfo } from "./token-info";

type JsonBody = Readonly<Record<string, unknown>> | readonly unknown[] | null;
type RecordResult = Promise<Readonly<Record<string, unknown>>>;

export type BurnFetchOptions = Readonly<{
  maxBodyBytes?: number;
  requestDeadlineMs?: number;
  maxInflightBurns?: number;
  maxInflightMetadataUploads?: number;
  metadataUploadMaxRequestBytes?: number;
  metadataUploadRateLimitPerIp?: number;
  metadataUploadGlobalRateLimit?: number;
  metadataUploadRateWindowMs?: number;
  referenceRequestDeadlineMs?: number;
  bearerToken?: string;
  burnEnabled?: boolean;
  prepare?: (parsed: JsonBody) => RecordResult;
  submitSigned?: (parsed: JsonBody) => RecordResult;
  oneShotEnabled?: boolean;
  readiness?: () => Promise<void>;
  health?: () => RecordResult;
  markets?: (mint: string) => RecordResult;
  resolve?: (mint: string, pool: string | null) => RecordResult;
  metadataUpload?: (
    input: MetadataUploadInput
  ) => Promise<MetadataUploadResult>;
  metadataImagePrepare?: (
    input: MetadataImagePrepareInput
  ) => Promise<MetadataImagePrepareResult>;
  metadataUploadGate?: Readonly<{
    acquire(
      ip: string,
      requestId: string,
      requestFingerprint: string
    ): Promise<
      | { kind: "acquired"; token: string }
      | { kind: "busy" }
      | { kind: "rate"; retryAfter: number }
      | { kind: "processing"; retryAfter: number }
      | { kind: "conflict" }
      | { kind: "replay"; result: MetadataUploadResult }
    >;
    complete(
      token: string,
      requestId: string,
      result: MetadataUploadResult
    ): Promise<void>;
    fail(token: string, requestId: string): Promise<void>;
    release(token: string): Promise<void>;
  }>;
  allowedOrigins?: readonly string[];
  log?: LogSink;
}>;

export type BurnFetchContext = Readonly<{
  waitUntil?: (promise: Promise<unknown>) => void;
}>;

export type BurnFetchHandler = (
  request: Request,
  context?: BurnFetchContext
) => Promise<Response>;

function defaultLogSink(line: Readonly<Record<string, unknown>>): void {
  // Never log request bodies, transaction bytes, or environment values.
  console.log(JSON.stringify(line));
}

function json(
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers?: HeadersInit
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function corsHeaders(
  request: Request,
  options: BurnFetchOptions,
  metadataRoute: boolean
): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
  });
  const origin = request.headers.get("origin");
  if (!metadataRoute && !options.allowedOrigins?.length) {
    headers.set("access-control-allow-origin", "*");
  } else if (origin && options.allowedOrigins?.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  return headers;
}

function withCors(response: Response, headers: Headers): Response {
  for (const [name, value] of headers) response.headers.set(name, value);
  return response;
}

async function readBodyWithCap(
  request: Request,
  maxBytes: number
): Promise<Uint8Array | "TOO_LARGE"> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return "TOO_LARGE";
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        return "TOO_LARGE";
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeJson(bytes: Uint8Array): JsonBody | "INVALID_JSON" {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonBody;
  } catch {
    return "INVALID_JSON";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function uploadOriginAllowed(
  request: Request,
  options: BurnFetchOptions
): boolean {
  const origin = request.headers.get("origin");
  return Boolean(
    origin &&
      options.allowedOrigins?.length &&
      options.allowedOrigins.includes(origin) &&
      origin !== "*"
  );
}

function clientIp(request: Request): string {
  // The Worker has no public route. This header arrives from the app Worker,
  // which copies Cloudflare's own edge-provided value over a service binding.
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export function createBurnFetchHandler(
  service: Pick<QuoteService, "execute">,
  options: BurnFetchOptions = {}
): BurnFetchHandler {
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

  function emit(level: string, event: string, fields: Record<string, unknown>) {
    log({ ts: new Date().toISOString(), level, event, ...fields });
  }

  function continueAfterResponse(
    promise: Promise<unknown>,
    context?: BurnFetchContext
  ): void {
    // waitUntil is load-bearing on Workers: an operation that crossed the
    // response deadline must not be cancelled with the client response.
    context?.waitUntil?.(promise.catch(() => undefined));
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
    return null;
  }

  async function withReferenceDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ReferenceDiscoveryError(
                  "REFERENCE_DISCOVERY_TIMEOUT",
                  `reference request timed out after ${referenceRequestDeadlineMs} ms; retry`
                )
              ),
            referenceRequestDeadlineMs
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function handleMetadataUpload(
    request: Request,
    context?: BurnFetchContext
  ): Promise<Response> {
    const startedAt = Date.now();
    if (!options.metadataUpload) {
      return json(503, {
        code: "METADATA_UPLOAD_DISABLED",
        message:
          "metadata upload is disabled because the server-side Irys and Cloudflare pipeline is not configured",
      });
    }
    if (!uploadOriginAllowed(request, options)) {
      return json(403, {
        code: "UPLOAD_ORIGIN_FORBIDDEN",
        message:
          "this origin is not allowed to spend the metadata upload balance",
      });
    }
    if (
      inflight.size >= maxInflightBurns ||
      metadataUploadsInflight >= maxInflightMetadataUploads
    ) {
      return json(429, {
        code: "SERVER_BUSY",
        message: "too many concurrent requests; retry later",
      });
    }
    if (
      !/^application\/json\b/i.test(request.headers.get("content-type") ?? "")
    ) {
      return json(415, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "content-type must be application/json",
      });
    }
    const body = await readBodyWithCap(request, metadataUploadMaxRequestBytes);
    if (body === "TOO_LARGE") {
      return json(413, {
        code: "UPLOAD_TOO_LARGE",
        message: `metadata upload request exceeds ${metadataUploadMaxRequestBytes} bytes`,
      });
    }
    const parsed = decodeJson(body);
    if (parsed === "INVALID_JSON") {
      return json(400, {
        code: "INVALID_JSON",
        message: "request body is not valid JSON",
      });
    }
    let input: ReturnType<typeof parseMetadataUploadRequest>;
    try {
      input = parseMetadataUploadRequest(parsed);
    } catch (error) {
      if (error instanceof MetadataUploadError) {
        return json(error.status, { code: error.code, message: error.message });
      }
      throw error;
    }
    if (
      inflight.size >= maxInflightBurns ||
      metadataUploadsInflight >= maxInflightMetadataUploads
    ) {
      return json(429, {
        code: "SERVER_BUSY",
        message: "too many concurrent requests; retry later",
      });
    }
    let gateToken: string | undefined;
    let retryAfter: number | null = null;
    if (options.metadataUploadGate) {
      try {
        const gate = await options.metadataUploadGate.acquire(
          clientIp(request),
          input.requestId,
          await sha256Hex(body)
        );
        if (gate.kind === "replay") {
          emit("info", "metadata-upload-replayed", {
            requestId: input.requestId,
            ms: Date.now() - startedAt,
          });
          return json(200, gate.result);
        }
        if (gate.kind === "processing") {
          return json(
            409,
            {
              code: "UPLOAD_PROCESSING",
              message:
                "this metadata upload is still processing; retry shortly with the same launch details",
            },
            { "retry-after": String(gate.retryAfter) }
          );
        }
        if (gate.kind === "conflict") {
          return json(409, {
            code: "IDEMPOTENCY_CONFLICT",
            message: "requestId was already used for different metadata",
          });
        }
        if (gate.kind === "busy") {
          return json(429, {
            code: "SERVER_BUSY",
            message: "too many concurrent requests; retry later",
          });
        }
        if (gate.kind === "rate") retryAfter = gate.retryAfter;
        else gateToken = gate.token;
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`.replace(/https?:\/\/\S+/g, "[url]").slice(0, 240)
            : "unknown durable object error";
        emit("error", "metadata-upload-gate-error", {
          code: "METADATA_UPLOAD_GATE_UNAVAILABLE",
          detail,
        });
        return json(503, {
          code: "SERVICE_UNAVAILABLE",
          message: "metadata upload is temporarily unavailable",
        });
      }
    } else {
      // Node/local fallback. The production Worker injects a Durable Object
      // gate so these counters are not weakened by isolate churn.
      retryAfter = consumeMetadataUploadRate(clientIp(request));
    }
    if (retryAfter !== null) {
      return json(
        429,
        {
          code: "UPLOAD_RATE_LIMITED",
          message: "metadata upload rate limit reached; retry later",
        },
        { "retry-after": String(retryAfter) }
      );
    }

    const paidExecution = Promise.resolve().then(() =>
      options.metadataUpload!(input)
    );
    // Persist the receipt before considering the operation settled. A browser
    // that timed out can submit the exact same content-derived request id and
    // receive this receipt without a second paid Irys upload.
    const execution = paidExecution.then(
      async (result) => {
        if (gateToken && options.metadataUploadGate) {
          await options.metadataUploadGate.complete(
            gateToken,
            input.requestId,
            result
          );
        }
        return result;
      },
      async (error) => {
        if (gateToken && options.metadataUploadGate) {
          try {
            await options.metadataUploadGate.fail(gateToken, input.requestId);
          } catch {
            emit("error", "metadata-upload-gate-fail-error", {
              code: "METADATA_UPLOAD_GATE_UNAVAILABLE",
            });
          }
        }
        throw error;
      }
    );
    const tracked = execution.catch(() => undefined);
    metadataUploadsInflight += 1;
    inflight.add(tracked);
    const cleanup = tracked.finally(async () => {
      metadataUploadsInflight -= 1;
      inflight.delete(tracked);
      if (gateToken && options.metadataUploadGate) {
        try {
          await options.metadataUploadGate.release(gateToken);
        } catch {
          emit("error", "metadata-upload-gate-release-error", {
            code: "METADATA_UPLOAD_GATE_UNAVAILABLE",
          });
        }
      }
    });
    // Register cleanup before returning a response. In Workers, a detached
    // promise may be cancelled as soon as the response is delivered.
    continueAfterResponse(cleanup, context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      execution.then(
        (result) => ({ kind: "result" as const, result }),
        (error) => ({ kind: "error" as const, error })
      ),
      new Promise<"DEADLINE">((resolve) => {
        timer = setTimeout(() => resolve("DEADLINE"), requestDeadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "DEADLINE") {
      continueAfterResponse(execution, context);
      execution.then(
        (result) =>
          emit("info", "metadata-upload-completed-after-deadline", {
            uri: result.uri,
            originalImageBytes: result.originalImageBytes,
            imageBytes: result.imageBytes,
            ms: Date.now() - startedAt,
          }),
        () =>
          emit("error", "metadata-upload-failed-after-deadline", {
            code: "IRYS_UPLOAD_FAILED",
            ms: Date.now() - startedAt,
          })
      );
      return json(504, {
        code: "REQUEST_DEADLINE",
        message:
          "metadata upload is still processing; wait before retrying to avoid a duplicate paid upload",
      });
    }
    if (outcome.kind === "result") {
      emit("info", "metadata-upload-completed", {
        uri: outcome.result.uri,
        originalImageBytes: outcome.result.originalImageBytes,
        imageBytes: outcome.result.imageBytes,
        ms: Date.now() - startedAt,
      });
      return json(200, outcome.result);
    }
    if (outcome.error instanceof MetadataUploadError) {
      emit("info", "metadata-upload-rejected", {
        code: outcome.error.code,
        ms: Date.now() - startedAt,
      });
      return json(outcome.error.status, {
        code: outcome.error.code,
        message: outcome.error.message,
      });
    }
    emit("error", "metadata-upload-error", {
      code: "IRYS_UPLOAD_FAILED",
      ms: Date.now() - startedAt,
    });
    return json(502, {
      code: "IRYS_UPLOAD_FAILED",
      message: "Irys metadata upload failed",
    });
  }

  async function handleMetadataImagePrepare(
    request: Request
  ): Promise<Response> {
    const startedAt = Date.now();
    if (!options.metadataImagePrepare) {
      return json(503, {
        code: "IMAGE_PREPARATION_DISABLED",
        message: "Cloudflare image preparation is not configured",
      });
    }
    if (!uploadOriginAllowed(request, options)) {
      return json(403, {
        code: "UPLOAD_ORIGIN_FORBIDDEN",
        message: "this origin is not allowed to prepare metadata images",
      });
    }
    if (
      inflight.size >= maxInflightBurns ||
      metadataUploadsInflight >= maxInflightMetadataUploads
    ) {
      return json(429, {
        code: "SERVER_BUSY",
        message: "too many concurrent requests; retry later",
      });
    }
    if (
      !/^application\/json\b/i.test(request.headers.get("content-type") ?? "")
    ) {
      return json(415, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "content-type must be application/json",
      });
    }
    const body = await readBodyWithCap(request, metadataUploadMaxRequestBytes);
    if (body === "TOO_LARGE") {
      return json(413, {
        code: "UPLOAD_TOO_LARGE",
        message: `image preparation request exceeds ${metadataUploadMaxRequestBytes} bytes`,
      });
    }
    const parsed = decodeJson(body);
    if (parsed === "INVALID_JSON") {
      return json(400, {
        code: "INVALID_JSON",
        message: "request body is not valid JSON",
      });
    }
    let input: MetadataImagePrepareInput;
    try {
      input = parseMetadataImagePrepareRequest(parsed);
    } catch (error) {
      if (error instanceof MetadataUploadError) {
        return json(error.status, { code: error.code, message: error.message });
      }
      throw error;
    }
    metadataUploadsInflight += 1;
    try {
      const result = await options.metadataImagePrepare(input);
      emit("info", "metadata-image-prepared", {
        originalImageBytes: result.originalImageBytes,
        imageBytes: result.imageBytes,
        ms: Date.now() - startedAt,
      });
      return json(200, result);
    } catch (error) {
      if (error instanceof MetadataUploadError) {
        emit("info", "metadata-image-prepare-rejected", {
          code: error.code,
          ms: Date.now() - startedAt,
        });
        return json(error.status, { code: error.code, message: error.message });
      }
      emit("error", "metadata-image-prepare-error", {
        code: "IMAGE_COMPRESSION_FAILED",
        ms: Date.now() - startedAt,
      });
      return json(502, {
        code: "IMAGE_COMPRESSION_FAILED",
        message: "Cloudflare image compression is unavailable",
      });
    } finally {
      metadataUploadsInflight -= 1;
    }
  }

  async function handleOperation(
    request: Request,
    operation: "burn" | "prepare" | "submit",
    execute: (parsed: JsonBody) => RecordResult,
    context?: BurnFetchContext
  ): Promise<Response> {
    const startedAt = Date.now();
    if (options.bearerToken) {
      if (
        request.headers.get("authorization") !== `Bearer ${options.bearerToken}`
      ) {
        return json(401, {
          code: "UNAUTHORIZED",
          message: "missing or invalid bearer token",
        });
      }
    }
    if (inflight.size >= maxInflightBurns) {
      return json(429, {
        code: "SERVER_BUSY",
        message: "too many concurrent burns; retry later",
      });
    }
    if (
      !/^application\/json\b/i.test(request.headers.get("content-type") ?? "")
    ) {
      return json(415, {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "content-type must be application/json",
      });
    }
    const body = await readBodyWithCap(request, maxBodyBytes);
    if (body === "TOO_LARGE") {
      return json(413, {
        code: "BODY_TOO_LARGE",
        message: `request body exceeds ${maxBodyBytes} bytes`,
      });
    }
    const parsed = decodeJson(body);
    if (parsed === "INVALID_JSON") {
      return json(400, {
        code: "INVALID_JSON",
        message: "request body is not valid JSON",
      });
    }
    const requestId =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? String(
            (parsed as { requestId?: unknown; preparationId?: unknown })
              .requestId ??
              (parsed as { preparationId?: unknown }).preparationId ??
              ""
          ).slice(0, 128) || undefined
        : undefined;
    const execution = execute(parsed);
    const tracked = execution.catch(() => undefined);
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      execution.then(
        (result) => ({ kind: "result" as const, result }),
        (error) => ({ kind: "error" as const, error })
      ),
      new Promise<"DEADLINE">((resolve) => {
        timer = setTimeout(() => resolve("DEADLINE"), requestDeadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "DEADLINE") {
      continueAfterResponse(execution, context);
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
            ms: Date.now() - startedAt,
          })
      );
      return json(504, {
        code: "REQUEST_DEADLINE",
        message: `${operation} still processing; it will complete or fail under its vault lease`,
      });
    }
    if (outcome.kind === "result") {
      emit("info", `${operation}-completed`, {
        requestId: outcome.result.requestId ?? requestId,
        vault: outcome.result.vault,
        submissionId: outcome.result.submissionId,
        messageSha256: outcome.result.messageSha256,
        transactionBytes: outcome.result.transactionBytes,
        accountLocks: outcome.result.accountLocks,
        simulatedUnits: outcome.result.simulatedUnits,
        ms: Date.now() - startedAt,
      });
      return json(200, outcome.result);
    }
    if (outcome.error instanceof PolicyError) {
      emit("info", `${operation}-rejected`, {
        requestId,
        code: outcome.error.code,
        detail: sanitizeForTransport(outcome.error.message),
        ms: Date.now() - startedAt,
      });
      return json(policyErrorStatus(outcome.error.code), {
        code: outcome.error.code,
        message: sanitizeForTransport(outcome.error.message),
      });
    }
    emit("error", `${operation}-error`, {
      requestId,
      code: "INTERNAL",
      ms: Date.now() - startedAt,
    });
    return json(500, { code: "INTERNAL", message: "internal error" });
  }

  return async (request, context) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const metadataRoute =
      path === "/metadata/upload" ||
      path === "/metadata/finalize" ||
      path === "/metadata/image/prepare";
    const cors = corsHeaders(request, options, metadataRoute);
    try {
      if (request.method === "OPTIONS") {
        if (metadataRoute && !uploadOriginAllowed(request, options)) {
          return withCors(
            json(403, {
              code: "UPLOAD_ORIGIN_FORBIDDEN",
              message:
                "this origin is not allowed to spend the metadata upload balance",
            }),
            cors
          );
        }
        return withCors(new Response(null, { status: 204 }), cors);
      }
      let response: Response;
      if (request.method === "GET" && path === "/healthz") {
        response = json(200, { status: "ok", draining: false });
      } else if (request.method === "GET" && path === "/health") {
        if (!options.health) {
          response = json(200, { ok: true });
        } else {
          try {
            response = json(200, { ok: true, ...(await options.health()) });
          } catch {
            response = json(503, {
              ok: false,
              reason: "health dependency unavailable",
            });
          }
        }
      } else if (request.method === "GET" && path === "/readyz") {
        try {
          await options.readiness?.();
          response = json(200, { status: "ready" });
        } catch {
          response = json(503, {
            status: "not-ready",
            reason: "dependency unavailable",
          });
        }
      } else if (request.method === "GET" && path === "/token") {
        // Cosmetic metadata for the picker. Deliberately never an error: an
        // unnamed token must not break a page, so an unknown mint and an
        // upstream outage both answer 200 { found: false }.
        const mint = url.searchParams.get("mint");
        response = json(
          200,
          isPlausibleMint(mint) ? await tokenInfo(mint) : { found: false }
        );
      } else if (request.method === "GET" && path === "/token/image") {
        const mint = url.searchParams.get("mint");
        const icon = isPlausibleMint(mint) ? await tokenImageBytes(mint) : null;
        response = icon
          ? new Response(icon.body, {
              status: 200,
              headers: {
                "content-type": icon.type,
                // Icons are immutable for a mint, so let the browser and the
                // edge keep them rather than re-fetching per render.
                "cache-control": "public, max-age=86400",
              },
            })
          : new Response(null, { status: 404 });
      } else if (
        request.method === "GET" &&
        path === "/reference/markets" &&
        options.markets
      ) {
        const mint = url.searchParams.get("mint");
        if (!mint) {
          response = json(400, {
            code: "INVALID_REQUEST",
            message: "mint query parameter required",
          });
        } else {
          try {
            response = json(
              200,
              await withReferenceDeadline(options.markets(mint))
            );
          } catch (error) {
            if (error instanceof ReferenceDiscoveryError) {
              response = json(
                error.code === "REFERENCE_DISCOVERY_TIMEOUT" ? 504 : 503,
                {
                  code: error.code,
                  message:
                    error.code === "REFERENCE_DISCOVERY_TIMEOUT"
                      ? "reference request timed out; retry"
                      : "reference discovery unavailable; retry",
                }
              );
            } else if (error instanceof PolicyError) {
              response = json(policyErrorStatus(error.code), {
                code: error.code,
                message: sanitizeForTransport(error.message),
              });
            } else {
              response = json(500, {
                code: "INTERNAL",
                message: "internal error",
              });
            }
          }
        }
      } else if (
        request.method === "GET" &&
        path === "/reference/resolve" &&
        options.resolve
      ) {
        const mint = url.searchParams.get("mint");
        if (!mint) {
          response = json(400, {
            code: "INVALID_REQUEST",
            message: "mint query parameter required",
          });
        } else {
          try {
            response = json(
              200,
              await withReferenceDeadline(
                options.resolve(mint, url.searchParams.get("pool"))
              )
            );
          } catch (error) {
            if (error instanceof ReferenceDiscoveryError) {
              response = json(
                error.code === "REFERENCE_DISCOVERY_TIMEOUT" ? 504 : 503,
                {
                  code: error.code,
                  message:
                    error.code === "REFERENCE_DISCOVERY_TIMEOUT"
                      ? "reference request timed out; retry"
                      : "reference discovery unavailable; retry",
                }
              );
            } else {
              response = json(422, {
                code:
                  error instanceof PolicyError ? error.code : "RESOLVE_FAILED",
                message:
                  error instanceof PolicyError
                    ? sanitizeForTransport(error.message)
                    : "reference resolution failed",
              });
            }
          }
        }
      } else if (path === "/metadata/image/prepare") {
        response =
          request.method === "POST"
            ? await handleMetadataImagePrepare(request)
            : json(
                405,
                {
                  code: "METHOD_NOT_ALLOWED",
                  message: "use POST /metadata/image/prepare",
                },
                { allow: "POST" }
              );
      } else if (path === "/metadata/upload" || path === "/metadata/finalize") {
        response =
          request.method === "POST"
            ? await handleMetadataUpload(request, context)
            : json(
                405,
                {
                  code: "METHOD_NOT_ALLOWED",
                  message: `use POST ${path}`,
                },
                { allow: "POST" }
              );
      } else if (path.startsWith("/burn")) {
        if (options.burnEnabled === false) {
          response = json(503, {
            code: "BURNS_DISABLED",
            message: "burn submission is disabled on this revision",
          });
        } else if (path === "/burn" && options.oneShotEnabled === false) {
          response = json(410, {
            code: "CALLER_PAID_ONLY",
            message:
              "this revision has no fee payer; use POST /burn/prepare, sign, then POST /burn/submit",
          });
        } else {
          const action =
            path === "/burn/prepare"
              ? options.prepare
              : path === "/burn/submit"
              ? options.submitSigned
              : path === "/burn"
              ? (parsed: JsonBody) => service.execute(parsed) as RecordResult
              : undefined;
          if (!action) {
            response = json(404, {
              code: "NOT_FOUND",
              message: "unknown path",
            });
          } else if (request.method !== "POST") {
            response = json(
              405,
              {
                code: "METHOD_NOT_ALLOWED",
                message: `use POST ${path}`,
              },
              { allow: "POST" }
            );
          } else {
            response = await handleOperation(
              request,
              path === "/burn/prepare"
                ? "prepare"
                : path === "/burn/submit"
                ? "submit"
                : "burn",
              action,
              context
            );
          }
        }
      } else {
        response = json(404, { code: "NOT_FOUND", message: "unknown path" });
      }
      return withCors(response, cors);
    } catch {
      emit("error", "request-handler-error", {
        route: `${request.method} ${path}`,
        code: "INTERNAL",
      });
      return withCors(
        json(500, { code: "INTERNAL", message: "internal error" }),
        cors
      );
    }
  };
}
