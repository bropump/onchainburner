#!/usr/bin/env bash
set -euo pipefail

# Build both real SBF programs with the pinned v3 toolchain, then run the
# host-side Mollusk regression.  No validator, Surfpool, devnet, or mainnet
# process is contacted by this script.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_sbf="${PINOCCHIO_CARGO_BUILD_SBF:-cargo-build-sbf}"
expected_cli_version="4.0.0"
tools_version="v1.53"
# The keyless-only build ships the split path; the hostile fixture it drives is
# the keyless one (a superset of tests/hostile-jupiter-fixture that adds the
# honest JUST_SWAP mode the re-pointed suite's admitted control needs).
fixture_manifest="$repo_dir/programs/burner/tests/hostile-keyless-fixture/Cargo.toml"
fixture_out="$repo_dir/programs/burner/tests/hostile-keyless-fixture/target/deploy"

version_output="$($build_sbf --version 2>&1 || true)"
case "$version_output" in
  *" $expected_cli_version"*) ;;
  *)
    echo "error: Mollusk hostile-Jupiter requires cargo-build-sbf $expected_cli_version" >&2
    echo "observed: ${version_output:-missing}" >&2
    exit 1
    ;;
esac

"$repo_dir/scripts/build-pinocchio.sh"
"$build_sbf" \
  --arch v3 \
  --tools-version "$tools_version" \
  --manifest-path "$fixture_manifest" \
  --sbf-out-dir "$fixture_out"

fixture="$fixture_out/hostile_keyless.so"
if [[ ! -s "$fixture" ]]; then
  echo "error: hostile Jupiter fixture was not produced: $fixture" >&2
  exit 1
fi
flags="$(od -An -t u4 -j 48 -N 4 "$fixture" | tr -d '[:space:]')"
if [[ "$flags" != "3" ]]; then
  echo "error: hostile fixture must be SBPFv3, observed flags=${flags:-unreadable}" >&2
  exit 1
fi

# The host test dependencies require rustc 1.89; the default toolchain here is
# 1.87, which fails to resolve them. Pin the same sbpf toolchain the program is
# built with so this script runs standalone.
RUN_MOLLUSK_HOSTILE_JUPITER=1 rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
  --manifest-path "$repo_dir/programs/burner/Cargo.toml" \
  --test mollusk_hostile_jupiter \
  -- --ignored --nocapture
