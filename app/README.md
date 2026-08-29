# Onchain Burner — frontend

React + TanStack Router UI for the burner program
(`burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5`).

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
| `VITE_RPC_URL`          | `http://127.0.0.1:8899` | omit; production defaults to same-origin `/rpc`                                 |
| `VITE_BURN_SERVICE_URL` | `http://127.0.0.1:8787` | omit; production defaults to same-origin `/api` |

`VITE_NETWORK=mainnet` removes every demo-only control (demo wallet,
airdrops, trade/distribute) and shows the MAINNET badge. Verified: the same
bundle logic, built with only these variables changed, hides all demo
surfaces.

Production `/api` is handled by `app/worker.ts`, which calls the private quote
Worker through the `BURN_SERVICE` service binding. There is no public quote
service URL to put in Vite. The RPC endpoint, Irys wallet, image Worker URL,
and image Worker token are Worker secrets and must never be configured as
`VITE_*` values or frontend build variables. Mainnet builds ignore
`VITE_RPC_URL` and `VITE_BURN_SERVICE_URL` in code; both are local-dev-only.

## Deploy to Cloudflare

`wrangler.jsonc` serves `dist/` as static assets with SPA fallback and binds
the private `onchainburner-quote-service` Worker. Deploy that Worker first.

```sh
pnpm build && npx wrangler deploy          # demo-configured build
VITE_NETWORK=mainnet pnpm build && npx wrangler deploy
```

`npx wrangler deploy --dry-run` validates without deploying. Deploying needs
a Cloudflare account (`npx wrangler login`).
