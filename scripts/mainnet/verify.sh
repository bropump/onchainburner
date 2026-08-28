#!/usr/bin/env bash
#
#   pnpm verify:mainnet              # no key. chain bytes vs this build.
#   pnpm verify:mainnet:publish      # paste the upgrade-authority key, hidden.
#                                    # publishes solana-verify + remote job.
#
# Does not deploy. Does not revoke. Safe to re-run.
#
# Default mode never asks for a secret. Publish mode uses the same hidden
# paste as deploy (`read -s`, 0600 temp file, shredded on exit).

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
PUBLISH=0
case "${1:-}" in
  --publish) PUBLISH=1 ;;
  "") ;;
  *) die "usage: $0 [--publish]" ;;
esac

require_cli
require_solana_verify
require_program_identity
require_public_main

PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
[ "$PROGRAM_ID" = "$EXPECTED_PROGRAM_ID" ] || die "program id mismatch"

build_sbfv3_artifact
SOURCE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"

echo
echo "  program id        $PROGRAM_ID"
echo "  local sha256      $ARTIFACT_SHA"
echo "  local size        $ARTIFACT_SIZE bytes, ELF flags=$ARTIFACT_FLAGS"
echo "  source commit     $SOURCE_COMMIT"
echo "  expected authority  $EXPECTED_UPGRADE_AUTHORITY"
echo "  solana-verify      $(solana-verify --version)"
echo "  rpc               $MAINNET_RPC"
echo

ylw "comparing on-chain ProgramData to this build ..."
compare_deployed_artifact "$PROGRAM_ID"

echo
PROGRAM_SHOW="$(solana program show "$PROGRAM_ID" --keypair "$PROGRAM_KEYPAIR" --url "$MAINNET_RPC")" \
  || die "could not read current program metadata"
printf '%s\n' "$PROGRAM_SHOW"
ONCHAIN_AUTHORITY=$(printf '%s\n' "$PROGRAM_SHOW" | awk -F': ' '$1 == "Authority" {print $2; exit}')
[ "$ONCHAIN_AUTHORITY" = "$EXPECTED_UPGRADE_AUTHORITY" ] \
  || die "on-chain upgrade authority is ${ONCHAIN_AUTHORITY:-unreadable}, expected $EXPECTED_UPGRADE_AUTHORITY"

if [ "$PUBLISH" != "1" ]; then
  echo
  grn "verified: on-chain bytes match this build."
  echo "  to publish explorer/solana-verify attestation: pnpm verify:mainnet:publish"
  exit 0
fi

echo
ylw "publishing pinned build metadata (signed by the upgrade authority) ..."
read_authority_keypair "$EXPECTED_UPGRADE_AUTHORITY"
AUTH="$AUTH_KEYPAIR_PATH"

# solana-verify reads the Solana CLI config for its fee payer and ignores
# --keypair for that, so a stale or missing `keypair_path` there fails the
# upload after the clone and pre-flight have already succeeded. Point the
# config at the temp authority file for the duration and restore it after,
# so the key still never lands anywhere permanent.
PREV_CLI_KEYPAIR="$(solana config get keypair 2>/dev/null | awk -F': ' '/Keypair Path/{print $2}' | tr -d ' ')"
restore_cli_keypair() {
  [ -n "$PREV_CLI_KEYPAIR" ] \
    && solana config set --keypair "$PREV_CLI_KEYPAIR" >/dev/null 2>&1 || true
}
# _common.sh owns the EXIT/INT/TERM traps that SHRED the authority key. Chain
# onto them rather than replacing: a bare `trap ... EXIT` here would silently
# drop the shred and leave the key on disk.
trap 'restore_cli_keypair; cleanup_authority_keypair' EXIT
trap 'restore_cli_keypair; cleanup_authority_keypair; exit 130' INT
trap 'restore_cli_keypair; cleanup_authority_keypair; exit 143' TERM HUP
solana config set --keypair "$AUTH" >/dev/null 2>&1 \
  || die "could not point the Solana CLI config at the authority key"

solana-verify verify-from-repo \
  "$SOURCE_REPO_URL" \
  --commit-hash "$SOURCE_COMMIT" \
  --program-id "$PROGRAM_ID" \
  --keypair "$AUTH" \
  --url "$MAINNET_RPC" \
  --library-name pinocchio_parity \
  --mount-path programs/burner \
  --workspace-path programs/burner \
  --arch v3 \
  --cargo-build-sbf-args="--tools-version v1.53" \
  --skip-build \
  --skip-prompt

ylw "checking the uploaded verification record ..."
PDA_OUTPUT="$(solana-verify get-program-pda \
  --program-id "$PROGRAM_ID" \
  --signer "$EXPECTED_UPGRADE_AUTHORITY" \
  --url "$MAINNET_RPC" 2>&1)" || {
    printf '%s\n' "$PDA_OUTPUT"
    die "could not read the uploaded verification record"
  }
printf '%s\n' "$PDA_OUTPUT"
case "$PDA_OUTPUT" in
  *"Git Url: $SOURCE_REPO_URL"*"Commit: $SOURCE_COMMIT"*) ;;
  *) die "uploaded verification record is not pinned to $SOURCE_REPO_URL at $SOURCE_COMMIT" ;;
esac

ylw "submitting the remote reproducible build and waiting for its verdict ..."
VERIFY_OUTPUT="$(solana-verify remote submit-job \
  --program-id "$PROGRAM_ID" \
  --uploader "$EXPECTED_UPGRADE_AUTHORITY" \
  --url "$MAINNET_RPC" 2>&1)" || {
    printf '%s\n' "$VERIFY_OUTPUT"
    die "remote verification request failed"
  }
printf '%s\n' "$VERIFY_OUTPUT"
case "$VERIFY_OUTPUT" in
  *"has been verified."*) ;;
  *) die "remote builder did not report a verified program" ;;
esac

echo
grn "independently verified."
echo "  program id      $PROGRAM_ID"
echo "  sha256          $ARTIFACT_SHA"
echo "  source          $SOURCE_REPO_URL"
echo "  commit          $SOURCE_COMMIT"
echo "  upgrade authority remains $EXPECTED_UPGRADE_AUTHORITY by owner decision"
