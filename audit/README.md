# Audit notes

The KMS quote-authority audit package that used to live here described a
design that no longer exists. There is no quote authority, no Cloud KMS
key, and no `--features mainnet` key pin. The program is fully keyless:
price protection is the on-chain reference-bound floor.

Authoritative sources for a mainnet review:

- Program: `programs/burner/src/`
- Release recipe: `scripts/build-pinocchio.sh` and `scripts/mainnet/deploy.sh`
- Decisions: `CLAUDE.md` (the 2026-08-26 keyless reversal is the current rule)
