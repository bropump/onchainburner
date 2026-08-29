/**
 * Private Cloudflare Worker entry for the production quote service.
 *
 * This Worker intentionally has no workers.dev or route trigger. The public
 * app Worker reaches it through a service binding and is the only public API
 * edge. Production mode is selected in code: fork-e2e and its filesystem
 * keypair path are not reachable from this entry.
 */
import {
  buildProductionWiring,
  LogSink,
  MAX_METADATA_UPLOAD_REQUEST_BYTES,
  metadataPipelineFromEnvironment,
} from "./server";
import { BurnFetchHandler, createBurnFetchHandler } from "./fetch-handler";
import { DurableObject } from "cloudflare:workers";

export interface QuoteWorkerEnv {
  BURNER_RPC_URL?: string;
  BURNER_ALLOWED_ORIGINS?: string;
  IRYS_PRIVATE_KEY?: string;
  JUPITER_PRIVATE_KEY?: string;
  CLOUDFLARE_IMAGE_WORKER_URL?: string;
  CLOUDFLARE_IMAGE_WORKER_TOKEN?: string;
  /** Private Worker-to-Worker path for image compression. */
  IMAGE_PIPELINE?: { fetch(request: Request): Promise<Response> };
  /** Durable, global gate protecting the paid Irys balance. */
  METADATA_UPLOAD_GATE?: DurableObjectNamespace<MetadataUploadGateV3>;
}

type MetadataGateResult =
  | { kind: "acquired"; token: string }
  | { kind: "busy" }
  | { kind: "rate"; retryAfter: number };

const METADATA_RATE_WINDOW_MS = 60 * 60 * 1_000;
const METADATA_RATE_PER_IP = 3;
const METADATA_RATE_GLOBAL = 30;
const METADATA_LEASE_MS = 3 * 60 * 1_000;

/**
 * One deliberately global coordination atom for paid metadata writes. The
 * product permits only one paid write at a time and caps total spend at 30
 * per hour, so a single object is the desired serialization boundary rather
 * than a throughput bottleneck. SQLite survives object eviction and isolate
 * churn; leases expire if a Worker dies before release.
 */
export class MetadataUploadGateV3 extends DurableObject<QuoteWorkerEnv> {
  constructor(ctx: DurableObjectState, env: QuoteWorkerEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_windows (
          scope TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leases (
          token TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);
    });
  }

  async acquire(clientKey: string): Promise<MetadataGateResult> {
    if (!/^[0-9a-f]{64}$/.test(clientKey)) {
      throw new Error("invalid metadata client key");
    }
    const now = Date.now();
    const result = this.ctx.storage.transactionSync<MetadataGateResult>(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM leases WHERE expires_at <= ?",
        now
      );
      const active = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM leases")
        .toArray()[0]?.count;
      if ((active ?? 0) >= 1) return { kind: "busy" };

      const readWindow = (scope: string) => {
        const stored = this.ctx.storage.sql
          .exec<{ started_at: number; count: number }>(
            "SELECT started_at, count FROM rate_windows WHERE scope = ?",
            scope
          )
          .toArray()[0];
        return !stored || now - stored.started_at >= METADATA_RATE_WINDOW_MS
          ? { startedAt: now, count: 0 }
          : { startedAt: stored.started_at, count: stored.count };
      };
      const globalWindow = readWindow("global");
      const clientWindow = readWindow(`client:${clientKey}`);
      const blockedUntil: number[] = [];
      if (globalWindow.count >= METADATA_RATE_GLOBAL) {
        blockedUntil.push(
          globalWindow.startedAt + METADATA_RATE_WINDOW_MS
        );
      }
      if (clientWindow.count >= METADATA_RATE_PER_IP) {
        blockedUntil.push(
          clientWindow.startedAt + METADATA_RATE_WINDOW_MS
        );
      }
      if (blockedUntil.length) {
        return {
          kind: "rate",
          retryAfter: Math.max(
            1,
            Math.ceil((Math.max(...blockedUntil) - now) / 1_000)
          ),
        };
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO rate_windows (scope, started_at, count) VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET started_at = excluded.started_at,
           count = excluded.count`,
        "global",
        globalWindow.startedAt,
        globalWindow.count + 1
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_windows (scope, started_at, count) VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET started_at = excluded.started_at,
           count = excluded.count`,
        `client:${clientKey}`,
        clientWindow.startedAt,
        clientWindow.count + 1
      );
      // Old client buckets carry no value after their window and should not
      // become indefinite identifiers in storage.
      this.ctx.storage.sql.exec(
        "DELETE FROM rate_windows WHERE scope != 'global' AND started_at <= ?",
        now - METADATA_RATE_WINDOW_MS
      );
      const token = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO leases (token, expires_at) VALUES (?, ?)",
        token,
        now + METADATA_LEASE_MS
      );
      return { kind: "acquired", token };
    });
    if (result.kind === "acquired") {
      const cleanupAt = now + METADATA_RATE_WINDOW_MS + 1_000;
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null || currentAlarm > cleanupAt) {
        await this.ctx.storage.setAlarm(cleanupAt);
      }
    }
    return result;
  }

  async release(token: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(token)) return;
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE token = ?", token);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const nextStartedAt = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM leases WHERE expires_at <= ?",
        now
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM rate_windows WHERE scope != 'global' AND started_at <= ?",
        now - METADATA_RATE_WINDOW_MS
      );
      return this.ctx.storage.sql
        .exec<{ started_at: number }>(
          "SELECT MIN(started_at) AS started_at FROM rate_windows WHERE scope != 'global'"
        )
        .toArray()[0]?.started_at;
    });
    if (Number.isFinite(nextStartedAt)) {
      await this.ctx.storage.setAlarm(
        Number(nextStartedAt) + METADATA_RATE_WINDOW_MS + 1_000
      );
    }
  }
}

let initialized: Promise<BurnFetchHandler> | undefined;

function secretPatterns(env: QuoteWorkerEnv): string[] {
  const patterns = new Set<string>();
  for (const raw of [
    env.BURNER_RPC_URL,
    env.IRYS_PRIVATE_KEY,
    env.JUPITER_PRIVATE_KEY,
    env.CLOUDFLARE_IMAGE_WORKER_URL,
    env.CLOUDFLARE_IMAGE_WORKER_TOKEN,
  ]) {
    if (!raw) continue;
    patterns.add(raw);
    try {
      const url = new URL(raw);
      for (const part of [
        url.username,
        url.password,
        ...url.searchParams.values(),
        ...url.pathname.split("/"),
      ]) {
        if (part.length >= 6) patterns.add(part);
      }
    } catch {
      // Non-URL secrets are already covered as complete strings.
    }
  }
  return [...patterns].sort((left, right) => right.length - left.length);
}

function makeLogSink(env: QuoteWorkerEnv): LogSink {
  const patterns = secretPatterns(env);
  return (line) => {
    const safe = JSON.parse(
      JSON.stringify(line, (_key, value) => {
        if (typeof value !== "string") return value;
        let redacted = value;
        for (const pattern of patterns) {
          redacted = redacted.replaceAll(pattern, "[redacted]");
        }
        return redacted;
      })
    );
    console.log(JSON.stringify(safe));
  };
}

function allowedOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  for (const origin of origins) {
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
  return origins;
}

async function metadataClientKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function initialize(env: QuoteWorkerEnv): Promise<BurnFetchHandler> {
  // nodejs_compat_v2 deliberately mirrors Worker bindings into process.env.
  // Check the binding itself as well so a compatibility/config regression
  // fails closed with a fixed message instead of an upstream URL.
  if (!env.BURNER_RPC_URL) {
    throw new Error("the quote Worker RPC secret is not configured");
  }
  const origins = allowedOrigins(env.BURNER_ALLOWED_ORIGINS);
  const sink = makeLogSink(env);
  const wiring = buildProductionWiring(sink);
  if (!env.IMAGE_PIPELINE) {
    throw new Error("the image pipeline service binding is not configured");
  }
  if (!env.METADATA_UPLOAD_GATE) {
    throw new Error("the metadata upload gate is not configured");
  }
  const imageFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    env.IMAGE_PIPELINE!.fetch(new Request(input, init))) as typeof fetch;
  const metadataPipeline = await metadataPipelineFromEnvironment(
    sink,
    origins,
    imageFetch
  );
  return createBurnFetchHandler(wiring.service, {
    maxBodyBytes: 16_384,
    requestDeadlineMs: 150_000,
    referenceRequestDeadlineMs: 16_000,
    maxInflightBurns: 8,
    maxInflightMetadataUploads: 1,
    metadataUploadMaxRequestBytes: MAX_METADATA_UPLOAD_REQUEST_BYTES,
    metadataUploadRateLimitPerIp: 3,
    metadataUploadGlobalRateLimit: 30,
    metadataUploadRateWindowMs: 60 * 60 * 1_000,
    burnEnabled: wiring.burnEnabled,
    oneShotEnabled: wiring.oneShotEnabled,
    prepare: wiring.prepare,
    submitSigned: wiring.submitSigned,
    health: wiring.health,
    markets: wiring.markets,
    resolve: wiring.resolve,
    readiness: wiring.readiness,
    metadataUpload: metadataPipeline?.upload,
    metadataImagePrepare: metadataPipeline?.prepareImage,
    metadataUploadGate: {
      // Durable Object stubs are request-bound I/O objects. `initialize()` is
      // cached across requests, so a stub captured here would work once and
      // then fail with "Cannot perform I/O on behalf of a different request".
      // Resolve a fresh stub for every RPC instead.
      acquire: async (ip) =>
        env.METADATA_UPLOAD_GATE!.getByName("paid-metadata-v3").acquire(
          await metadataClientKey(ip)
        ),
      release: async (token) =>
        env.METADATA_UPLOAD_GATE!.getByName("paid-metadata-v3").release(token),
    },
    allowedOrigins: origins,
    log: sink,
  });
}

export default {
  async fetch(
    request: Request,
    env: QuoteWorkerEnv,
    context: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      initialized ??= initialize(env);
      const handler = await initialized;
      return await handler(request, context);
    } catch {
      // Startup and runtime diagnostics can contain dependency URLs. Never
      // transport them; operators get the fixed failure class only.
      return new Response(
        JSON.stringify({
          code: "SERVICE_UNAVAILABLE",
          message: "quote service unavailable",
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        }
      );
    }
  },
};
