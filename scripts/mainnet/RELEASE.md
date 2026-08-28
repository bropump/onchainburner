# Mainnet release

Prerequisites: the exact release source is committed, pushed to the public
`main` branch at `https://github.com/bropump/onchainburner`, and the working
tree is clean. Run the required production/fork validation first, including
`pnpm ci:pinocchio` and `FORK_DEX_PROFILE=pool pnpm test:service-fork`. The
gitignored program-id keypair must already exist at
`programs/burner/target/deploy/`; never commit it.

## Canonical artifact and current release blocker

The canonical public release artifact is the ELF produced by the digest-pinned
Linux/x86_64 `solana-verify` container selected by
`[workspace.metadata.cli]`. Build in that container, validate that exact ELF,
and deploy those exact bytes without rebuilding them natively. A native
`cargo-build-sbf` build is not a substitute, even with cargo-build-sbf 4.0.0,
platform-tools v1.53, `--arch v3`, and `--locked`: platform-tools v1.53 ships
different host-specific sysroots, and its macOS/arm64 and Linux/x86_64 builds
do not produce the same ELF. A `rust-toolchain.toml` pin does not change which
host-specific platform-tools archive emits the SBPF program.

The current `deploy:mainnet:dry-run`, `deploy:mainnet`, and
`verify:mainnet:publish` scripts rebuild through the native wrapper. They must
not be used for a release from macOS/arm64. Before another authorized upgrade,
the deployment flow must be changed to consume and preserve the
container-built ELF rather than rebuilding it. That tooling change is a release
blocker; do not work around it by copying a native hash into the attestation.

Once a no-rebuild deployment path exists, the required order is:

1. Build in the pinned `solana-verify` Linux/x86_64 container. Record the full
   SHA-256, executable hash, size, and `ELF flags 3 (SBPFv3)`.
2. Run all production and fork validation against that exact container ELF.
3. Dry-run and deploy that exact ELF without invoking a native build. Confirm
   the post-deploy executable hash equals the recorded container hash and the
   displayed authority is
   `4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ`.
4. Publish the solana-verify PDA for the exact public commit with `--arch v3`
   and `--cargo-build-sbf-args="--tools-version v1.53"`, then submit the remote
   job. It must report verified and reproduce the container executable hash.

The artifact is keyless and has no Cargo release feature; within the canonical
container all networks build identical bytes. Client errors are append-only
through 6043. The single-target instruction and `validate_config` Mode B
(`0x01`) remain refused at dispatch.

Do **not** run `pnpm revoke:mainnet` as part of release. Owner decision
2026-08-26 retains the authority. Moving it behind the selected timelocked
multisig and publishing the upgrade policy are separate owner operations;
revocation is available only after a future recorded reversal.
