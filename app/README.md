# Onchain Burner — frontend

React + TanStack Router UI for the burner program
(`5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV`).

This app builds and signs SETUP transactions with the user's wallet (launch,
one-shot fee share, validate_config, ATA creation, funding). Burns are a
semantic POST to the quote service, which builds an unsigned transaction; the
connected wallet is the only required signer. There is no quote-authority key.

## Develop (against the local Surfpool fork)

Prerequisites: fork on `http://127.0.0.1:8899`, demo service on
`http://127.0.0.1:8787` (start with
`FORK_DEX_PROFILE=pool npx tsx scripts/demo-burn-service.ts` from the repo
root; `FORK_DEXES` narrows venues further — tick/bin-array venues misalign
against live Jupiter quotes on a drifted fork).

```sh
pnpm install
pnpm dev            # http://localhost:5173, demo mode by default
pnpm e2e            # headless proof of the chain layer against the fork
pnpm build          # tsc --noEmit + vite build -> dist/
```

## Network configuration (env, never code)

| Variable                | Demo default            | Mainnet                                                                         |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `VITE_NETWORK`          | `demo`                  | `mainnet`                                                                       |
| `VITE_RPC_URL`          | `http://127.0.0.1:8899` | your RPC                                                                        |
| `VITE_BURN_SERVICE_URL` | `http://127.0.0.1:8787` | absolute URL of the deployed Node quote service (or a same-origin `/api` proxy) |

`VITE_NETWORK=mainnet` removes every demo-only control (demo wallet,
airdrops, trade/distribute) and shows the MAINNET badge. Verified: the same
bundle logic, built with only these variables changed, hides all demo
surfaces.

Cloudflare Pages should set `VITE_BURN_SERVICE_URL` separately for preview and
production environments. Only the public service URL belongs in Vite. The Irys
wallet is the Node service's `IRYS_PRIVATE_KEY`; it must never be configured as
a `VITE_*` value or in Pages build variables.

## Deploy to Cloudflare

`wrangler.jsonc` serves `dist/` as static assets with SPA fallback.

```sh
pnpm build && npx wrangler deploy          # demo-configured build
VITE_NETWORK=mainnet VITE_RPC_URL=... VITE_BURN_SERVICE_URL=... pnpm build \
  && npx wrangler deploy                   # mainnet-configured build
```

`npx wrangler deploy --dry-run` validates without deploying. Deploying needs
a Cloudflare account (`npx wrangler login`).
