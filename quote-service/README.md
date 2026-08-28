# Quote-service status — KEYLESS (2026-08-26)

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

Endpoints (`server.ts`):

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

CORS (the browser app is ALWAYS on a different origin than this service, so
cross-origin is the normal case, not a dev workaround):

- Keyless-route default: `Access-Control-Allow-Origin: *`, preflight OPTIONS
  answered with allow-methods/headers and a 24h `Access-Control-Max-Age`.
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
- 3 attempts per IP per hour and 30 total attempts per process per hour;
- one paid upload in flight, sharing the service-wide inflight cap and request
  deadline;
- an exact CORS/Origin allowlist; set `BURNER_TRUST_PROXY=true` only behind a
  trusted proxy so `CF-Connecting-IP`/`X-Forwarded-For` can drive the IP limit;
- price both Irys writes and compare them with the funded balance before the
  first write; insufficient credit returns `IRYS_INSUFFICIENT_FUNDS`.

Operators may override the caps with `BURNER_MAX_UPLOAD_REQUEST_BYTES`,
`BURNER_MAX_INFLIGHT_UPLOADS`, `BURNER_UPLOADS_PER_IP_PER_HOUR`, and
`BURNER_UPLOADS_GLOBAL_PER_HOUR`. Raising them increases the shared-key spend
surface.

Gates:

```console
pnpm typecheck:quote-service
pnpm test:quote-service
pnpm build:quote-service
pnpm test:service-fork   # real burns through the real pipeline on a Surfpool fork
```
