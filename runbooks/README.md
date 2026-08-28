# Pinocchio production release

The deployable burner is the native Pinocchio crate at `programs/burner`.
It is the only program in this repository; the Anchor scaffold that once sat
alongside it has been deleted, along with the benchmark crates.

These runbooks require the `txtx` CLI. The supported mainnet path is
`scripts/mainnet/deploy.sh` to deploy and `scripts/mainnet/verify.sh` to
check the chain (and optionally publish solana-verify). They need no extra
tooling beyond the pinned Solana CLI.

## Reproducible build

The checked-in wrapper requires `cargo-build-sbf 4.0.0`, pins
`platform-tools v1.53` (SBF Rust/Cargo 1.89) with the SBPF v3 architecture, and
uses the checked-in
`programs/burner/Cargo.lock` via `--locked`.

SBPFv3 is intentional, not merely the newest available target. [Anza's SBPFv3
migration guidance](https://github.com/anza-xyz/cargo-build-sbf#sbfpv3-migration) has
deprecated SBPFv0/v1/v2 deployments and plans to reject them when SIMD-500 is
activated in Agave 4.3. The build wrapper passes `--arch v3` and independently
checks the resulting ELF header flags are exactly `3`; a lower architecture
therefore fails the release build instead of producing a soon-undeployable
artifact.

Install the pinned builder separately from any older Solana CLI bundle:

```console
cargo install cargo-build-sbf --version 4.0.0 --locked
```

If an older Solana-bundled binary comes first on `PATH`, point
`PINOCCHIO_CARGO_BUILD_SBF` at the pinned executable.

```console
pnpm build:pinocchio
pnpm build:pinocchio:mainnet
```

The artifact is
`programs/burner/target/deploy/pinocchio_parity.so`; the wrapper
prints its SHA-256. Every network builds the same bytes. There is no
quote-authority key and no `--features mainnet` pin.

`cargo-build-sbf` may generate a program keypair beside the artifact. Generated
keypairs are for local/devnet only. Production identity must come from secure
custody, match `PINOCCHIO_PROGRAM_ID`, and never be committed (`*-keypair.json`
is ignored).

## Checks, deploy, and verify

Run the secret-free checks before a release:

```console
pnpm ci:pinocchio
```

This validates Pinocchio-only wiring, type-checks the production guard runner,
performs the pinned build, and runs host tests. Fork integration and adversarial
suites must also pass against the Pinocchio deployment; results from retired
implementations are not production evidence.

The supported mainnet commands build the exact SBPFv3 artifact and refuse a
dirty tree or a commit that is not public `main`. Deploy asks for the
`4YBss...` wallet secret once with hidden terminal input — that wallet is
payer, deployer, and upgrade authority. It refuses a key that derives to any
other address. Verify is a separate command and does not need a key unless
you publish solana-verify:

```console
pnpm deploy:mainnet:dry-run
pnpm deploy:mainnet
pnpm verify:mainnet
pnpm verify:mainnet:publish
```

The dry run performs every secret-free preflight and exits before confirmation
or key entry. Verification is pinned to the public source commit, Agave 4.0.0,
platform-tools v1.53, and SBPFv3.
The upgrade authority remains live after deployment so a mainnet canary can be
run. Revocation is intentionally separate and irreversible:

```console
pnpm revoke:mainnet
```

The generic CLI wrapper below remains available for devnet and explicit
operator-controlled deployments. It builds the selected network flavor,
deploys, then compares the on-chain ProgramData bytes with the local ELF.

It also requires `solana-cli 4.0.0`; set `PINOCCHIO_SOLANA_CLI` when the pinned
binary is not the first `solana` on `PATH`.

```console
DEPLOY_NETWORK=devnet \
DEPLOY_RPC_URL=https://api.devnet.solana.com \
PINOCCHIO_PROGRAM_ID=<PROGRAM_ID> \
PINOCCHIO_PROGRAM_KEYPAIR=/secure/path/program-keypair.json \
DEPLOY_UPGRADE_AUTHORITY=/secure/path/upgrade-authority.json \
EXPECTED_UPGRADE_AUTHORITY=<UPGRADE_AUTHORITY_PUBKEY> \
DEPLOY_FEE_PAYER=/secure/path/fee-payer.json \
pnpm deploy:pinocchio
```

For an upgrade, `PINOCCHIO_PROGRAM_KEYPAIR` may be omitted and the public
program id is passed to the loader. Initial deployment requires the keypair.
For mainnet, set `DEPLOY_NETWORK=mainnet` and set
`CONFIRM_MAINNET_PROGRAM_ID` to the exact same public key. The gated mainnet
build runs automatically. Before any build or write, the wrapper requires the
RPC genesis hash to match the canonical devnet or mainnet hash; localnet also
refuses either public-network hash.

Re-check an existing deployment without signing:

```console
DEPLOY_RPC_URL=<RPC_URL> \
PINOCCHIO_PROGRAM_ID=<PROGRAM_ID> \
pnpm verify:pinocchio
```

`EXPECTED_UPGRADE_AUTHORITY=<PUBKEY>` is required for verification; use `none`
only when verifying an intentionally immutable program.

## Surfpool runbook

The `deployment` runbook uses `svm::get_program_from_native_project` with
explicit Pinocchio artifact and keypair paths. Build first, place the intended
keypair at the ignored documented path, then run:

```console
surfpool run --env localnet deployment
surfpool run --env devnet deployment
```

It uses the real loader flow even on Surfnet. Use the CLI wrapper for mainnet;
it adds explicit network, program-id, build-gate, and byte-verification checks.
