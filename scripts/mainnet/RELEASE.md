# Mainnet release

Prerequisites: the exact release source is committed, pushed to the public
`main` branch at `https://github.com/bropump/onchainburner`, and the working
tree is clean. Run the required production/fork validation first, including
`pnpm ci:pinocchio` and `FORK_DEX_PROFILE=pool pnpm test:service-fork`. The
gitignored program-id keypair must already exist at
`programs/burner/target/deploy/`; never commit it.

Run, in order:

```sh
pnpm deploy:mainnet:dry-run
pnpm deploy:mainnet
pnpm verify:mainnet:publish
```

1. `deploy:mainnet:dry-run` prompts for nothing and spends nothing. Check the
   named public commit, program id, live wallet balance/cost quote, artifact
   size, SHA-256, and `ELF flags 3 (SBPFv3)`.
2. `deploy:mainnet` asks you to type the program id, then paste the payer /
   deployer / upgrade-authority secret key with hidden input. It locks the
   printed program and ProgramData rent, consumes the estimated transaction
   fees, and temporarily needs the printed buffer rent (refunded on success).
   Check the post-deploy executable hashes match and the displayed authority is
   `4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ`.
3. `verify:mainnet:publish` rebuilds before asking for the same hidden wallet
   key. It writes/updates the solana-verify PDA (rent plus transaction/priority
   fee), then submits the remote reproducible build. Check it reports verified
   and prints this repo plus the exact commit from step 1.

The artifact is keyless and has no Cargo release feature; all networks build
identical bytes. Client errors are append-only through 6043. The single-target
instruction and `validate_config` Mode B (`0x01`) remain refused at dispatch.

Do **not** run `pnpm revoke:mainnet` as part of release. Owner decision
2026-08-26 retains the authority. Moving it behind the selected timelocked
multisig and publishing the upgrade policy are separate owner operations;
revocation is available only after a future recorded reversal.
