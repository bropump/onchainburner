# Onchain Burner

An immutable Solana burner vault. A vault's configuration is its PDA address:
there is no configuration account, update instruction, or withdrawal path.
The production program converts vault SOL through Jupiter (or a bound Pump
bonding-curve buy) and atomically burns the configured target tokens.

There is no quote authority and no Cloud KMS key. Anyone may build and submit
a burn. Price protection is the on-chain reference-bound floor.

- Program: `burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5`
- Framework: Pinocchio
- Target: SBPFv3

## Validate

```console
pnpm install
pnpm ci:pinocchio
pnpm test:quote-service
pnpm fuzz
```

Fork burn measurements must set `FORK_DEX_PROFILE=pool`. See
[the production runbook](runbooks/README.md) for the complete build, Surfpool,
deployment, verification, canary, and authority-revocation sequence.

## Mainnet release

The wallet `4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ` is the payer, the
deployer, and the upgrade authority. You paste its secret at the prompt.
Input is hidden (`read -s`): the key is never printed, never in `ps`, never
in shell history, and the temp file is shredded when the script exits.

Deploy and verify are separate commands. Deploy never publishes attestation.

```console
pnpm deploy:mainnet:dry-run    # no key. build, identity, cost, funding check
pnpm deploy:mainnet            # paste the wallet key (hidden). deploys
pnpm verify:mainnet            # no key. on-chain bytes vs this build
pnpm verify:mainnet:publish    # paste the same key (hidden). solana-verify
```

The tree must be clean and match public `main` before deploy (and before
publish). Place the production program keypair at
`programs/burner/target/deploy/pinocchio_parity-keypair.json` first — it is
gitignored and must already be program id
`burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5`. Do not let the builder mint
a new one.

Every network builds the same bytes. `PINOCCHIO_BUILD_NETWORK=mainnet` does
not change the artifact.

Upgrade authority stays live after deploy. Making the program immutable is a
separate, irreversible command:

```console
pnpm revoke:mainnet
```

Do not revoke until `pnpm verify:mainnet:publish` has landed and real
mainnet canaries have burned. The standing decision is to hold the upgrade
authority behind a timelocked multisig until the program no longer parses
any upgradeable third-party pool layout.
