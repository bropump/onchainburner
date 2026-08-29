# Quote-service status — KEYLESS Cloudflare Worker (2026-08-29)

Production transport is now a private Cloudflare Worker entry at `worker.ts`.
It has no `workers.dev` hostname and no route; `app/worker.ts` reaches it through
the `BURN_SERVICE` service binding after enforcing the app's exact-Origin and
per-IP gates. The Node entry moved to `node-main.ts` solely for local fork
testing while the Worker rollout is verified.

The Worker deliberately enables `nodejs_compat`: the transaction stack uses
`Buffer` and `node:crypto`, and the existing Irys Node uploader imports Node
modules. The Worker entry never selects `fork-e2e`, and the emitted bundle was
checked not to contain the local `~/.config/solana/id.json` path.
`worker-fetch-compat.ts` also removes Axios's unsupported `cache: "default"`
request option only when workerd rejects it; Node remains unpatched.

OWNER DECISION 2026-08-26: the burn builder is fully keyless and open. It
holds no burn key and signs no burn. Every control it used to enforce by
withholding a co-signature now lives in the program, on chain: route
validation, the reference-bound price floor (`KEYLESS_TOL_BPS = 100`), the
depth-admission gate, and the per-venue fee cap. What remains here is a
convenience BUILDER — route construction and keyless transaction assembly are
genuinely intricate — plus an optional relay. Anyone could build and submit
the identical transaction without it. The separate metadata-upload endpoint
does hold an Irys payment key and a Cloudflare Worker credential when
explicitly configured; neither has Solana burn authority and neither is ever
exposed to the browser.

`core.ts` is the tested transaction-construction boundary. It accepts a
semantic burn request, resolves each leg's bound REFERENCE pool
(`reference.ts`, the mirror of the program's `keyless_leg_floor`), derives the
reference-committed vault, builds Jupiter routes, validates all accounts and
route data, encodes the keyless 7-account leg blocks, compiles exactly
ComputeBudget + burner, and simulates the exact message. A burn requires
exactly ONE signature: the fee payer's.

**Direct-curve legs (own-launch tokens).** A leg whose bound reference is a
LIVE Pump bonding curve is not routed through Jupiter at all: `core.ts`
builds the program's direct bonding-curve buy (`directcurve.ts`, the port of
the harness that landed 22/22 own-curve legs on 2026-08-26) — 18 Pump
accounts, EMPTY route data (the program's curve-path selector), and the
resolver's exact BigInt program floor as the minimum. This is what makes a
brand-new launch burnable before Jupiter has ever indexed it, and the ONLY
path for a fork-only mint. Two pieces of caller-funded setup must exist
first (the service refuses with `SETUP_REQUIRED` naming them): the vault's
Pump `user_volume_accumulator` (any third party may init it) and a
rent-pre-funded `bonding_curve_v2` PDA. A 3-leg burn containing a curve leg
also needs an approved address lookup table covering the deterministic burn
accounts — the demo service maintains one per vault; production callers pass
`lookupTableAddresses` vetted against `BURNER_APPROVED_LOOKUP_TABLES`.

**Simulation-failure attribution.** A failed simulation is attributed to the
INNERMOST `Program <id> failed` frame. Burner-attributed failures are
deterministic (`SIMULATION_FAILED`) with exactly two route-weather
exceptions, both bounded by the retry budget: 6018 (one re-quote with the
Pump venues excluded) and keyless 6021 (plain re-quote — the program floor
is priced off the bound reference pool while the fill comes from Jupiter's
route, so a fresh route can clear the same floor; observed landing unchanged
on re-quote 2026-08-26). Externally-authored failures — Jupiter or an AMM raising
its OWN error, e.g. Raydium CLMM 6024 `InvalidFirstTickArrayAccount`, which
is NOT our 6024 — reject as `EXTERNAL_SIMULATION_FAILURE` (HTTP 502): route
weather, retryable with a fresh quote. Unknown authorship is reported as
unknown, never as ours.

**Jupiter tier (degraded path, documented rather than a hang).** Without
`JUPITER_API_KEY` the free tier rate-limits hard under real use (429
bursts). The demo service serializes quotes at 6 s spacing, backs off 25 s
on a 429, and reports the tier in `/health` (`jupiter.keyed`); the browser
surfaces it and bounds the wait with a 240 s client deadline. At production
volume a key is mandatory, not optional. Direct-curve legs are unaffected —
they never call Jupiter.

Production endpoints (`server.ts` and `fetch-handler.ts`):

- `POST /burn/prepare` — semantic request + caller pubkey in; the UNSIGNED
  transaction out (caller is the sole required signer). Stateless.
- `POST /burn/submit` — a fully caller-signed transaction in; the gate
  refuses anything that is not exactly a signed burner burn, then relays it.
- `POST /burn` — one-shot keeper burn (service pays and submits); enabled
  only where a fee-payer keypair is configured (`BURNER_ENV=fork-e2e`).
- `POST /metadata/upload` — `{ name, symbol, description, image:
{ contentType, dataBase64 } }` in; sends the bounded icon through the
  stateless Cloudflare Images Worker, uploads the normalized icon and then
  its metadata JSON to Irys, and returns both permanent Irys URIs plus an
  optional Cloudflare delivery URI. Disabled unless the complete
  server-side pipeline is configured.
- `GET /health` — rich liveness for the browser app's status badge:
  `{ ok, mode, slot, program, payer? }` (`/healthz` and `/readyz` remain the
  platform probes).
- `GET /reference/markets?mint=…` — the keyless reference selection the
  setup UI binds into the vault address: the Pump branch for Pump coins
  (curve, then the canonical PumpSwap pool after graduation), otherwise REAL
  market enumeration (filtered `getProgramAccounts` per venue: Raydium
  v4/CP/CLMM, Meteora DLMM) ranked durability-then-depth (`markets.ts`).
  Every candidate the ranking considers is re-authenticated by
  `reference.ts` before it may win.

`BURNER_ENV=production` needs only an HTTPS RPC and the policy env vars for
burns. Metadata upload is opt-in through three server-only values:
`IRYS_PRIVATE_KEY` (base58 or a 64-byte Solana keypair JSON array),
`CLOUDFLARE_IMAGE_WORKER_URL` (the exact Worker origin), and
`CLOUDFLARE_IMAGE_WORKER_TOKEN` (at least 32 random characters). The service
checks and logs the funded Irys balance at boot and never auto-funds. It logs
a fixed `metadata-upload-disabled` reason when any value is absent; no secret
is logged or sent to the browser.

`cloudflare-image-worker.mjs` and `wrangler.image-pipeline.jsonc` define the
Cloudflare side. Configure its matching secret with `wrangler secret put
IMAGE_PIPELINE_TOKEN --config quote-service/wrangler.image-pipeline.jsonc`.
The Worker uses the Images binding in memory; it does not persist the source
in Images, R2, or KV.

Permanence and ordering are deliberate:

1. Cloudflare decodes the image, scales it down to at most 512x512, strips
   metadata by encoding WebP, starts at quality 82, and uses bounded fallback
   passes until the result is at most 200,000 bytes.
2. The service prices both permanent writes, uploads that WebP to Irys, then
   uploads minified JSON whose `image` field is the **Irys** image URI.
3. Only after both receipts validate does the endpoint return the metadata
   URI to the launch page. A failure cannot populate the launch form with a
   non-permanent URI. If the second Irys write fails, the first permanent
   image may be an unreferenced Irys item, but no launch URI is returned.
4. The Cloudflare delivery URL is a cache/proxy of the permanent Irys image.
   It is never embedded in token metadata. Losing the Cloudflare account
   therefore loses only the acceleration layer, not the token image.

The JSON is already minified and capped at 8 KiB. Gzip would save negligible
bytes and would make client compatibility worse, so only the image is
re-encoded.

CORS in the shared transport remains for the local Node test server. In
production the browser calls same-origin `/api`; the app Worker forwards the
request over a private service binding:

- Keyless-route default in the transport: `Access-Control-Allow-Origin: *`,
  with preflight OPTIONS and a 24h `Access-Control-Max-Age`. The app Worker
  does not relay those CORS headers because its public endpoint is same-origin.
- `BURNER_ALLOWED_ORIGINS` — optional comma-separated origin allowlist; when
  set, only listed origins are echoed (with `Vary: Origin`).
- The paid upload route is the exception: it never emits `*`, requires an
  exact allowed `Origin`, and refuses startup with a complete upload pipeline
  unless the allowlist is non-empty. Origin is only a browser control, so the
  route also has per-IP and global hourly limits.

Metadata spend guardrails (defaults, all enforced before SDK upload):

- 14,000,000-byte HTTP envelope, 10,000,000 decoded source image bytes, 200,000
  compressed WebP bytes, and 8,192 metadata JSON bytes;
- PNG, JPEG, and WebP only, with matching file signatures (SVG/GIF refused);
- 3 attempts per IP per hour, 30 attempts globally per hour, and one paid
  upload in flight, enforced account-wide by a single named Durable Object;
- a three-minute Durable Object lease prevents a crashed invocation from
  permanently blocking uploads; the request deadline remains 150 seconds;
- an exact Origin allowlist; the app Worker forwards only Cloudflare's trusted
  `CF-Connecting-IP` value to the private Worker for the IP budget;
- price both Irys writes and compare them with the funded balance before the
  first write; insufficient credit returns `IRYS_INSUFFICIENT_FUNDS`.

The production Worker pins these spend limits to the documented defaults. The
Node-only local server still accepts its historical `BURNER_MAX_*` overrides.

The metadata budget is deliberately not held in module memory: Worker isolates
can be created or evicted. The Durable Object serializes acquisitions and keeps
the old single-process global spend and concurrency controls intact.

`/demo/*` is not an endpoint of the production quote service. Those operations
are implemented only by `scripts/demo-burn-service.ts`, the local Surfpool
stand-in, and require a local fork and local payer.

`/token` and `/token/image` ARE production endpoints (`token-info.ts`). The
launch picker calls both on every render, so without them every burn target
renders unnamed and iconless — and the icon cannot simply be hotlinked:
ipfs.io, which Jupiter returns for a large share of Pump coins, answers 403 to
any browser User-Agent, so the bytes must be re-served from the Worker.

## Worker deployment

Deploy in dependency order: the image pipeline (the quote Worker's
`CLOUDFLARE_IMAGE_WORKER_URL` must already resolve), then the private quote
Worker, then the app Worker — Cloudflare requires a service-binding target to
exist before deploying its caller.

```console
# 1. Image pipeline. Its token is a shared secret you choose; set the SAME
#    value here and as CLOUDFLARE_IMAGE_WORKER_TOKEN below (min 32 chars).
npx wrangler secret put IMAGE_PIPELINE_TOKEN --config quote-service/wrangler.image-pipeline.jsonc
npx wrangler deploy --config quote-service/wrangler.image-pipeline.jsonc

# 2. Quote Worker. Every one of these is REQUIRED: buildProductionWiring reads
#    them from process.env (nodejs_compat mirrors bindings there) and throws on
#    a missing one, which surfaces as a 503 on every route, not just the one
#    that needed it.
npx wrangler secret put BURNER_RPC_URL --config quote-service/wrangler.jsonc
npx wrangler secret put BURNER_MAX_AMOUNT_LAMPORTS --config quote-service/wrangler.jsonc
npx wrangler secret put BURNER_MAX_SLIPPAGE_BPS --config quote-service/wrangler.jsonc
npx wrangler secret put BURNER_MAX_PRICE_IMPACT_BPS --config quote-service/wrangler.jsonc
npx wrangler secret put IRYS_PRIVATE_KEY --config quote-service/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_IMAGE_WORKER_URL --config quote-service/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_IMAGE_WORKER_TOKEN --config quote-service/wrangler.jsonc
npx wrangler secret put BURNER_ALLOWED_ORIGINS --config quote-service/wrangler.jsonc
npx wrangler deploy --config quote-service/wrangler.jsonc

# 3. App Worker, which is the only public edge.
cd app && npx wrangler deploy
```

The Irys wallet must hold a balance before any upload succeeds. Startup logs
`metadata-upload-enabled` with the balance it found; a zero balance still boots,
then fails at the first paid upload.

None of these values belongs in `VITE_*`. `BURNER_ALLOWED_ORIGINS` must be the
exact public app origin(s); include localhost only when remote local development
is intentional. The 7.67 MiB uncompressed Worker bundle requires Workers Paid
(the free-plan script limit is 3 MiB).

Gates:

```console
pnpm typecheck:quote-service
pnpm test:quote-service
pnpm build:quote-service
npx wrangler deploy --dry-run --config quote-service/wrangler.jsonc
pnpm test:service-fork   # real burns through the real pipeline on a Surfpool fork
```
