#!/usr/bin/env bash
set -euo pipefail

# Fuzz the production burner.  Two layers, no validator, Surfpool, devnet, or
# mainnet process contacted:
#
#   1. Host property fuzzing (proptest): the `mod fuzz` modules in
#      src/split.rs and src/token.rs — differential decode model, structured
#      corruption of the split wire format, the split-arithmetic identity and
#      its through-the-handler zero-boundary oracle, and every token.rs byte
#      reader against an independent layout model at every length.
#   2. Real-artifact fuzzing (Mollusk): tests/fuzz_artifact.rs executes the
#      pinned SBPFv3 ELF under the real SBF VM — arbitrary instruction data
#      must always end in a named BurnerError (never an abort or access
#      violation), and the deployed split arithmetic must agree exactly with
#      an independent 128-bit reference via the program's own 6008 in_amount
#      pin.
#
# Case counts (defaults are the quick campaign; CI-speed):
#   PROPTEST_CASES     host cases per property        (default 1024-8192/test)
#   BURNER_FUZZ_ITERS  artifact iterations per campaign (default 5000)
#   BURNER_FUZZ_SEED   fix the artifact RNG seed to reproduce a failure; the
#                      failing run prints the seed and the exact input.
#
# A long campaign is
#   PROPTEST_CASES=200000 BURNER_FUZZ_ITERS=500000 scripts/fuzz-burner.sh
# proptest failures also persist minimal counterexamples under
# programs/burner/proptest-regressions/ and replay automatically.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_dir/programs/burner/Cargo.toml"

# The artifact campaigns must run against the real, pinned SBPFv3 ELF.
"$repo_dir/scripts/build-pinocchio.sh"

# The host test dependencies require rustc 1.89; pin the same sbpf toolchain
# the program is built with so this script runs standalone.
rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
  --manifest-path "$manifest" \
  --lib \
  -- fuzz

# RUST_LOG=off: the campaigns run tens of thousands of failing instructions
# on purpose, and the runtime's per-instruction DEBUG log would swamp the
# seed/iteration lines a reproduction needs.
RUST_LOG=off rustup run 1.89.0-sbpf-solana-v1.53 cargo test \
  --manifest-path "$manifest" \
  --test fuzz_artifact \
  -- --ignored --nocapture
