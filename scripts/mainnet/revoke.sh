#!/usr/bin/env bash
# OPTIONAL, OUTSIDE THE RELEASE FLOW: make the program immutable forever.
#
# OWNER DECISION 2026-08-26 is DO NOT REVOKE. Keep the authority behind a
# timelocked multisig with a published upgrade policy, and revisit only after
# the program no longer parses upgradeable third-party byte layouts. This
# script remains available solely for a future explicit reversal of that
# decision; its presence is not a recommendation to run it.
#
# After this:
#   - the code can never be changed, so any bug is permanent, and this program
#     has no withdrawal instruction to recover stranded funds
#   - the keyless floor's hardcoded byte offsets into THIRD-PARTY pool
#     layouts are frozen. Every read fails closed, so a venue reordering a
#     struct does not misprice -- it bricks every vault bound to that venue at
#     once, with fees still arriving and no way out. Those frozen layout
#     assumptions cannot be rotated away after revocation.
#
# Do not run without a new, recorded owner decision reversing the current one.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ "$#" -eq 0 ] || die "usage: $0"
require_cli
require_program_identity

PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
echo
PROGRAM_SHOW="$(solana program show "$PROGRAM_ID" --keypair "$PROGRAM_KEYPAIR" --url "$MAINNET_RPC")" \
  || die "could not read current program metadata"
printf '%s\n' "$PROGRAM_SHOW"
ONCHAIN_AUTHORITY=$(printf '%s\n' "$PROGRAM_SHOW" | awk -F': ' '$1 == "Authority" {print $2; exit}')
[ "$ONCHAIN_AUTHORITY" = "$EXPECTED_UPGRADE_AUTHORITY" ] \
  || die "on-chain authority is ${ONCHAIN_AUTHORITY:-unreadable}, not the direct wallet $EXPECTED_UPGRADE_AUTHORITY; this script does not invent a multisig signing path"
echo
red  "  OWNER DECISION 2026-08-26 IS DO NOT REVOKE."
red  "  This makes $PROGRAM_ID PERMANENTLY IMMUTABLE."
red  "  No upgrades. No bug fixes. No venue-layout fixes. Forever."
echo
ylw "  Checklist before continuing:"
ylw "    - solana-verify has been published and matches"
ylw "    - real vaults have funded and burned successfully on mainnet"
ylw "    - you accept that a third-party pool layout change bricks vaults permanently"
ylw "    - you have accepted that a bug after this point strands funds permanently"
echo
confirm "  type MAKE IMMUTABLE to continue: " "MAKE IMMUTABLE"
confirm "  type the program id to confirm:  " "$PROGRAM_ID"

read_authority_keypair "$EXPECTED_UPGRADE_AUTHORITY"
AUTH_KEYPAIR="$AUTH_KEYPAIR_PATH"

solana program set-upgrade-authority "$PROGRAM_ID" \
  --upgrade-authority "$AUTH_KEYPAIR" \
  --url "$MAINNET_RPC" \
  --final

echo
solana program show "$PROGRAM_ID" --keypair "$AUTH_KEYPAIR" --url "$MAINNET_RPC"
grn "  program is now immutable."
