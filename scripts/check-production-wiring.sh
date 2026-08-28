#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if ! rg -q 'get_program_from_native_project' runbooks/deployment/main.tx; then
  echo "error: runbook is not wired to the native Pinocchio artifact" >&2
  exit 1
fi
if rg -qi 'benchmarks/pinocchio-parity|programs/onchain_burner' runbooks/deployment/main.tx; then
  echo "error: runbook references a retired program path" >&2
  exit 1
fi

node <<'NODE'
const scripts = require("./package.json").scripts ?? {};
for (const name of [
  "build:pinocchio",
  "build:pinocchio:mainnet",
  "deploy:pinocchio",
  "verify:pinocchio",
  "deploy:mainnet",
  "verify:mainnet",
  "verify:mainnet:publish",
  "typecheck:production",
  "test:guards",
]) {
  if (!scripts[name]) throw new Error(`missing package script ${name}`);
}
if (scripts["test:guards"] !== "pnpm run test:security-guards") {
  throw new Error("test:guards must invoke the production guard suite directly");
}
NODE

test -f programs/burner/Cargo.lock
echo "Production wiring is Pinocchio-only."
