#!/usr/bin/env bash
# Shared helpers for the mainnet scripts.
#
# The upgrade-authority key lives in a browser wallet, so these scripts read it
# once, use it, and destroy it. That is deliberately the ONLY moment it exists
# on disk: it is the key that can replace the entire program, so it must never
# be left in a file, an env var, or shell history.

set -euo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT="$REPO/programs/burner/target/deploy/pinocchio_parity.so"
PROGRAM_KEYPAIR="$REPO/programs/burner/target/deploy/pinocchio_parity-keypair.json"
MAINNET_RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
readonly SOURCE_REPO_URL="https://github.com/bropump/onchainburner"

# Program identity and the wallet that pays + holds upgrade authority.
# The program keypair is NOT the wallet: it only names the program id.
# The wallet secret is pasted at the terminal, never echoed, never in argv.
EXPECTED_PROGRAM_ID="${EXPECTED_PROGRAM_ID:-burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5}"
EXPECTED_UPGRADE_AUTHORITY="${EXPECTED_UPGRADE_AUTHORITY:-4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ}"
PINNED_TOOLCHAIN="$REPO/tmp/toolchains/agave-4.0.0/bin"

ARTIFACT_SIZE=""
ARTIFACT_SHA=""
ARTIFACT_FLAGS=""

AUTH_TEMP_DIR=""
AUTH_KEYPAIR_PATH=""

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { red "error: $*" >&2; exit 1; }

require_cli() {
  # Mainnet operations use these exact repo-local CLI binaries.
  [ -x "$PINNED_TOOLCHAIN/solana" ] || die "missing pinned Solana CLI:
   $PINNED_TOOLCHAIN/solana"
  [ -x "$PINNED_TOOLCHAIN/solana-keygen" ] || die "missing pinned solana-keygen:
   $PINNED_TOOLCHAIN/solana-keygen"

  case ":$PATH:" in
    *":$PINNED_TOOLCHAIN:"*) ;;
    *) PATH="$PINNED_TOOLCHAIN:$PATH"; export PATH ;;
  esac

  local v
  v="$(solana --version 2>&1)"
  case "$v" in
    *"solana-cli 4.0.0"*) ;;
    *) die "expected solana-cli 4.0.0, found: $v
   pinned path: $PINNED_TOOLCHAIN/solana" ;;
  esac
}

require_build_toolchain() {
  # Never fall back to a same-named executable on PATH: that can silently
  # change the deployed artifact.
  [ -x "$PINNED_TOOLCHAIN/cargo-build-sbf" ] || die "missing pinned SBF builder:
   $PINNED_TOOLCHAIN/cargo-build-sbf
   mainnet releases must not use cargo-build-sbf from PATH"

  local build_v
  build_v="$("$PINNED_TOOLCHAIN/cargo-build-sbf" --version 2>&1)"
  case "$build_v" in
    *"cargo-build-sbf 4.0.0"*"platform-tools v1.53"*) ;;
    *) die "wrong pinned SBF toolchain at $PINNED_TOOLCHAIN/cargo-build-sbf
   expected cargo-build-sbf 4.0.0 with platform-tools v1.53
   observed: $build_v" ;;
  esac

  export PINOCCHIO_CARGO_BUILD_SBF="$PINNED_TOOLCHAIN/cargo-build-sbf"
}

require_solana_verify() {
  command -v solana-verify >/dev/null 2>&1 || die "solana-verify is not installed; verification cannot be skipped:
   cargo +1.89.0-sbpf-solana-v1.53 install solana-verify --locked"
}

# Remove the one temporary authority file on every exit path. `shred` is used
# when the host provides it; APFS/SSD hosts cannot promise physical overwrite,
# but the file is always unlinked and its private 0700 directory removed.
cleanup_authority_keypair() {
  if [ -n "$AUTH_KEYPAIR_PATH" ] && [ -f "$AUTH_KEYPAIR_PATH" ]; then
    if command -v shred >/dev/null 2>&1 \
      && shred -u "$AUTH_KEYPAIR_PATH" 2>/dev/null; then
      :
    else
      # macOS does not ship `shred`. Overwrite the file before unlinking it.
      # APFS/SSD copy-on-write still cannot promise physical-sector erasure;
      # the containing directory is private and is removed immediately after.
      local secret_size
      secret_size=$(stat -f%z "$AUTH_KEYPAIR_PATH" 2>/dev/null || stat -c%s "$AUTH_KEYPAIR_PATH" 2>/dev/null || echo 0)
      if [ "$secret_size" -gt 0 ]; then
        dd if=/dev/zero of="$AUTH_KEYPAIR_PATH" bs=1 count="$secret_size" conv=notrunc 2>/dev/null || true
      fi
      rm -f "$AUTH_KEYPAIR_PATH"
    fi
  fi
  if [ -n "$AUTH_TEMP_DIR" ] && [ -d "$AUTH_TEMP_DIR" ]; then
    rmdir "$AUTH_TEMP_DIR" 2>/dev/null || true
  fi
  AUTH_KEYPAIR_PATH=""
  AUTH_TEMP_DIR=""
}

trap cleanup_authority_keypair EXIT
trap 'cleanup_authority_keypair; exit 130' INT
trap 'cleanup_authority_keypair; exit 143' TERM HUP

# Read a base58 secret key with no echo and write it to a 0600 temporary file.
# This function MUST be called directly, not through command substitution: it
# stores the surviving path in AUTH_KEYPAIR_PATH for the caller.
#
# Accepts either a base58 secret key (what Phantom/Solflare "export private
# key" gives you) or a JSON byte array.
read_authority_keypair() {
  local expect_pubkey="$1" tmp secret pubkey
  tmp="$(mktemp -d)"
  chmod 700 "$tmp"
  AUTH_TEMP_DIR="$tmp"
  AUTH_KEYPAIR_PATH="$tmp/authority.json"

  ylw "Paste the secret key for $expect_pubkey (input is hidden)." >&2
  ylw "It is written to a 0600 temp file and removed when this script exits." >&2
  read -r -s -p "  secret key: " secret >&2 || [ -n "$secret" ]
  echo >&2
  [ -n "$secret" ] || die "no key entered"

  if [[ "$secret" == \[* ]]; then
    printf '%s' "$secret" > "$AUTH_KEYPAIR_PATH"
  else
    # base58 -> JSON byte array. The secret travels only over stdin: never in
    # argv, an environment variable, a file name, or shell history.
    printf '%s' "$secret" | python3 -c '
import json, sys
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
s = sys.stdin.read().strip()
n = 0
for ch in s:
    if ch not in A: raise SystemExit("not valid base58")
    n = n * 58 + A.index(ch)
b = n.to_bytes((n.bit_length() + 7) // 8, "big")
b = b"\0" * (len(s) - len(s.lstrip("1"))) + b
if len(b) != 64: raise SystemExit(f"expected a 64-byte secret key, got {len(b)}")
json.dump(list(b), open(sys.argv[1], "w"))
' "$AUTH_KEYPAIR_PATH"
  fi
  unset secret
  chmod 600 "$AUTH_KEYPAIR_PATH"

  pubkey="$(solana-keygen pubkey "$AUTH_KEYPAIR_PATH")" || die "could not read that key"
  [ "$pubkey" = "$expect_pubkey" ] || die "that key is $pubkey, expected $expect_pubkey"
  grn "  key verified: $pubkey" >&2
}

confirm() {
  local prompt="$1" want="$2" got
  read -r -p "$prompt" got
  [ "$got" = "$want" ] || die "aborted"
}

# The program keypair must already be in place. `cargo-build-sbf` will mint a
# random one if it is missing, and that would deploy a different program id.
require_program_identity() {
  [ -f "$PROGRAM_KEYPAIR" ] || die "missing program keypair: $PROGRAM_KEYPAIR
   this file names program id $EXPECTED_PROGRAM_ID and is gitignored.
   copy it into place before deploying — do not let cargo-build-sbf generate a new one"
  local id
  id="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" || die "could not read $PROGRAM_KEYPAIR"
  [ "$id" = "$EXPECTED_PROGRAM_ID" ] || die "program keypair is $id, expected $EXPECTED_PROGRAM_ID"
}

# solana-verify can only attest a commit that is already on public main.
require_public_main() {
  [ -z "$(git -C "$REPO" status --porcelain)" ] \
    || die "working tree is not clean; commit and push the exact source first"
  local source_commit remote_commit
  source_commit="$(git -C "$REPO" rev-parse HEAD)"
  remote_commit="$(git ls-remote "$SOURCE_REPO_URL" refs/heads/main | awk 'NR == 1 {print $1}')"
  [ -n "$remote_commit" ] || die "cannot resolve public source ref $SOURCE_REPO_URL main"
  [ "$source_commit" = "$remote_commit" ] \
    || die "local HEAD $source_commit is not public main $remote_commit"
}

# A MAINNET artifact is built in the same container the public verifier uses,
# never with the host toolchain. Measured 2026-08-28: the host build and the
# container build of the SAME commit differ (executable ddda7cad… vs
# 7de38c89…), because nothing pins the host rustc — this machine had 1.98.0,
# the container has 1.93.1. Deploying a host build therefore produces a
# program that can never be verified from source, which was exactly what
# happened. The container build reproduced OtterSec's hash byte for byte.
#
# `scripts/build-pinocchio.sh` remains the fast path for tests and CI; it is
# reproducible ON ONE MACHINE, which is enough for a test and not enough for
# a release.
build_sbfv3_artifact() {
  command -v solana-verify >/dev/null 2>&1 \
    || die "solana-verify is required to build a release artifact"
  docker info >/dev/null 2>&1 \
    || die "docker must be running to build a release artifact:
   colima start   (or start Docker Desktop), then re-run"
  ylw "building SBPFv3 artifact in the verifier container (slow: ~5 min) ..."
  solana-verify build \
    --library-name pinocchio_parity \
    --arch v3 \
    --cargo-build-sbf-args="--tools-version v1.53" \
    "$REPO/programs/burner" \
    || die "container build failed"
  [ -s "$ARTIFACT" ] || die "build did not produce $ARTIFACT"
  ARTIFACT_SIZE=$(stat -f%z "$ARTIFACT" 2>/dev/null || stat -c%s "$ARTIFACT")
  ARTIFACT_SHA=$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)
  ARTIFACT_FLAGS=$(od -An -tu4 -j48 -N4 "$ARTIFACT" | tr -d ' ')
  [ "$ARTIFACT_FLAGS" = "3" ] || die "artifact is not SBPFv3 (ELF flags=$ARTIFACT_FLAGS)"

  echo
  echo "  artifact          $ARTIFACT"
  echo "  size              $ARTIFACT_SIZE bytes"
  echo "  sha256            $ARTIFACT_SHA"
  echo "  ELF flags         $ARTIFACT_FLAGS (SBPFv3)"
}

compare_deployed_artifact() {
  local program_id="$1" onchain_output local_output onchain_hash local_hash

  require_solana_verify
  if ! onchain_output="$(solana-verify get-program-hash "$program_id" --url "$MAINNET_RPC" 2>&1)"; then
    printf '%s\n' "$onchain_output" >&2
    die "could not hash deployed ProgramData for $program_id"
  fi
  if ! local_output="$(solana-verify get-executable-hash "$ARTIFACT" 2>&1)"; then
    printf '%s\n' "$local_output" >&2
    die "could not hash local artifact $ARTIFACT"
  fi
  onchain_hash=$(printf '%s\n' "$onchain_output" | tail -1)
  local_hash=$(printf '%s\n' "$local_output" | tail -1)

  echo "  on-chain executable hash  $onchain_hash"
  echo "  local executable hash     $local_hash"
  [ -n "$onchain_hash" ] && [ "$onchain_hash" = "$local_hash" ] \
    || die "deployed bytes do NOT match $ARTIFACT"
  grn "  deployed bytes match the local artifact"
}
