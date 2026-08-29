# Cooked

**Cooked is a permissionless buyback-and-burn system for Solana communities.**

A token creator can direct Pump trading fees into an immutable Cooked vault.
Anyone can then use the vault's SOL to buy the configured token or tokens and
burn the entire output onchain. No operator takes custody, no backend key
authorizes a burn, and a funded vault cannot be redirected or withdrawn.

- App: [cooked.diy](https://cooked.diy)
- Solana program: [`burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5`](https://solscan.io/account/burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5)
- Framework: Pinocchio
- Artifact: SBPFv3

## What Cooked does

1. A creator launches a normal, SOL-quoted token on Pump or connects an
   existing launch.
2. The creator chooses what the trading fees will buy and burn. A vault may
   target one token or split each burn across as many as four tokens.
3. Cooked validates the targets and derives the vault address from the complete
   configuration: launch mint, target mints, weights, and reference pools.
4. The launch's Pump fee share is pointed at that vault.
5. Anyone can claim accrued Pump creator fees into the vault. The caller only
   pays the transaction fee; claimed SOL goes directly to the vault.
6. Anyone can trigger a burn. The program atomically wraps the vault's SOL,
   swaps through Jupiter, and permanently burns every token received.

If any leg fails, the entire burn reverts and the vault remains untouched.

The current Cooked app offers a simple 90/10 community split: 90% buys and
burns the chosen community token and 10% buys and burns NEIRO. The onchain
program itself supports one to four distinct targets with fixed weights that
sum to 100%.

## Why the vault cannot be changed

A Cooked vault has no configuration account. Its configuration **is its PDA
address**:

```text
PDA("burner", launch mint, target mints, weights, reference pools)
```

Changing any target, weight, or reference derives a different address. There
is no update instruction, withdrawal instruction, admin sweep, treasury path,
or creator override. SOL sent to a vault can only be spent by executing the
buyback-and-burn configuration encoded in that vault's address.

This is intentionally irreversible. The app runs the program's read-only
`validate_config` instruction before funding a vault, and a new configuration
should always be proven with a small burn before it receives meaningful fees.

## Onchain protections

Every burn independently enforces:

- the exact vault PDA, target mints, weights, token accounts, and reference
  pools;
- the Jupiter v2 program and supported route layouts, with no platform or
  positive-slippage fee;
- a price floor derived from the vault's bound reference market;
- a depth-based limit that keeps each burn small relative to its market;
- exact lamport conservation and complete consumption of the authorized SOL;
- zero leftover target or intermediate-token balances;
- `BurnChecked` of the complete swap output;
- null mint and freeze authorities on every target;
- strict Token-2022 extension checks; and
- all-or-nothing execution for multi-token burns.

The program is keyless: there is no quote authority or Cloud KMS signer. The
quote service builds and simulates transactions for convenience, but it cannot
approve a burn, redirect funds, or weaken the checks enforced onchain.

## Markets and token support

Cooked can bind its onchain price protection to:

- Pump bonding curves and canonical PumpSwap pools;
- Raydium v4 and Raydium CP pools;
- Raydium CLMM pools; and
- Meteora DLMM pools.

For fungible-LP AMMs, the app requires meaningful burned or locked liquidity.
For CLMM and DLMM position markets, it selects a deep qualifying reference and
uses trustworthy pool age when available. Pump references are derived
canonically by the program. Meteora DAMM v1/v2 is **not yet supported** as a
burner reference.

A token does not need to be a predefined example in the UI. Any target that
passes the program's mint checks and the app's reference-market admission can
be used and will appear automatically in the community rankings after a
successful finalized burn.

The supported fee-funding product is a normal, SOL-quoted Pump launch. Cashback,
mayhem, agent, and non-SOL quote modes are outside the launch flow. In
particular, cashback and non-SOL quote launches do not deliver native SOL to
this vault design.

## Community accounting

[Cooked community vaults](https://cooked.diy/community) are ranked from
finalized Solana transactions emitted by the deployed burner program. The
index shows SOL committed to buybacks, exact token amounts burned, burn counts,
launch activity, and the vaults responsible for each community's burns. It
does not use estimated or self-reported totals.

## Repository layout

- `programs/burner/` — production Pinocchio Solana program.
- `quote-service/` — keyless Jupiter transaction builder, simulator, metadata
  upload service, and optional relay.
- `app/` — Cooked web app, Cloudflare Worker, and finalized community index.
- `scripts/` — fork tests, security guards, fuzzing, deployment, and
  verification tooling.
- `runbooks/` — production build and release procedures.

## Development and verification

```console
pnpm install
pnpm ci:pinocchio
pnpm test:quote-service
pnpm fuzz
pnpm --dir app build
```

Fork burn measurements must set `FORK_DEX_PROFILE=pool`. See the
[production runbook](runbooks/README.md) for reproducible SBPFv3 builds,
Surfpool testing, mainnet deployment, byte verification, canaries, and upgrade
authority controls.

The production release commands are deliberately separate:

```console
pnpm deploy:mainnet:dry-run
pnpm deploy:mainnet
pnpm verify:mainnet
pnpm verify:mainnet:publish
```

Making the program immutable is a separate, irreversible operation. Do not run
`pnpm revoke:mainnet` until the deployed bytes are publicly verified and the
required mainnet canaries have passed.
