#!/usr/bin/env bash
# Native build and validation wrapper. This is NOT a cross-machine
# reproducible-build wrapper: cargo-build-sbf selects an OS/architecture-specific
# platform-tools archive, and v1.53's macOS/arm64 and Linux/x86_64 sysroots emit
# different SBPF bytes. The public release artifact must be built in the same
# digest-pinned Linux/x86_64 solana-verify container used by the remote verifier,
# and those exact container-built bytes must be deployed without a native rebuild.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_dir/programs/burner/Cargo.toml"
lockfile="$repo_dir/programs/burner/Cargo.lock"
out_dir="$repo_dir/programs/burner/target/deploy"
artifact="$out_dir/pinocchio_parity.so"
build_sbf="${PINOCCHIO_CARGO_BUILD_SBF:-cargo-build-sbf}"
expected_cli_version="4.0.0"
tools_version="v1.53"
sbpf_arch="v3"

if ! command -v "$build_sbf" >/dev/null 2>&1; then
  echo "error: cargo-build-sbf $expected_cli_version is required" >&2
  exit 1
fi

version_output="$($build_sbf --version 2>&1)"
case "$version_output" in
  *" $expected_cli_version"*) ;;
  *)
    echo "error: unsupported SBF toolchain" >&2
    echo "expected: cargo-build-sbf $expected_cli_version" >&2
    echo "observed: $version_output" >&2
    exit 1
    ;;
esac

if [[ ! -f "$lockfile" ]]; then
  echo "error: missing locked dependency graph: $lockfile" >&2
  exit 1
fi

build_args=(
  --arch "$sbpf_arch"
  --manifest-path "$manifest"
  --sbf-out-dir "$out_dir"
  --tools-version "$tools_version"
)

# PINOCCHIO_BUILD_NETWORK no longer changes the artifact. Within one fixed build
# environment every network builds the same bytes; the variable is kept so
# existing callers do not break.
case "${PINOCCHIO_BUILD_NETWORK:-development}" in
  development|devnet|localnet|mainnet) ;;
  *)
    echo "error: PINOCCHIO_BUILD_NETWORK must be development, devnet, localnet, or mainnet" >&2
    exit 1
    ;;
esac

"$build_sbf" "${build_args[@]}" -- --locked

if [[ ! -s "$artifact" ]]; then
  echo "error: build did not produce $artifact" >&2
  exit 1
fi

# e_flags is the four-byte word at offset 48 in an ELF64 header. Anza maps
# values 0..3 directly to SBPF versions v0..v3. Fail closed so a wrapper or
# toolchain regression cannot silently put a deprecated v0/v1/v2 artifact on
# the production path ahead of SIMD-500.
elf_flags="$(od -An -t u4 -j 48 -N 4 "$artifact" | tr -d '[:space:]')"
if [[ "$elf_flags" != "3" ]]; then
  echo "error: expected SBPFv3 ELF flags=3, observed ${elf_flags:-unreadable}" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "$artifact" | awk '{print $1}')"
else
  digest="$(shasum -a 256 "$artifact" | awk '{print $1}')"
fi

echo "Pinocchio artifact: $artifact"
echo "SBPF architecture: $sbpf_arch (ELF flags=$elf_flags)"
echo "SHA-256: $digest"
