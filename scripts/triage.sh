#!/usr/bin/env bash
# Full triage of the burner against whatever is currently built and deployed.
#
# Runs every suite in sequence and prints one summary. Each suite already
# attributes failures to the program that raised them, so an AMM or fork
# problem is never counted against the burner -- the bar is ZERO
# burner-attributed failures.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${TRIAGE_OUT:-/tmp/triage}"
mkdir -p "$OUT"
export FORK_SLIPPAGE_BPS="${FORK_SLIPPAGE_BPS:-1500}"
export FORK_DEX_PROFILE="${FORK_DEX_PROFILE:-pool}"

run () { # name, script, extra-env
  local name="$1"; shift
  local script="$1"; shift
  printf '%-26s ' "$name"
  if env "$@" npx tsx "$script" >"$OUT/$name.json" 2>"$OUT/$name.log"; then
    printf 'PASS  %s\n' "$(grep -v bigint "$OUT/$name.log" | tail -1 | cut -c1-70)"
  else
    printf 'see-log  %s\n' "$(grep -v bigint "$OUT/$name.log" | tail -1 | cut -c1-70)"
  fi
}

echo "=== unit tests ==="
(cd programs/burner && rustup run 1.89.0-sbpf-solana-v1.53 cargo test 2>&1 | grep "test result:" | head -1)

echo
echo "=== security ==="
run negative        scripts/split-negative.ts
run permissionless  scripts/split-permissionless.ts
printf '%-26s ' "guards-pinocchio"
BURNER_PROGRAM=pinocchio npx tsx scripts/security-guards.ts >"$OUT/guards.json" 2>"$OUT/guards.log" \
  && printf 'PASS  %s\n' "$(grep -v bigint "$OUT/guards.log" | tail -1 | cut -c1-70)" \
  || printf 'FAIL  %s\n' "$(grep -v bigint "$OUT/guards.log" | tail -1 | cut -c1-60)"

echo
echo "=== burns ==="
run smoke-3leg      scripts/split-smoke.ts
run split-matrix    scripts/split-matrix.ts
run major-tokens    scripts/major-token-matrix.ts
run random-tokens   scripts/split-random.ts
run venue-coverage  scripts/split-venue-coverage.ts
run raw-curve       scripts/raw-curve-verdict.ts WANT=5
run launchpads      scripts/launchpad-burn-test.ts PER_VENUE=2

echo
echo "=== pump launch -> split burn ==="
run pump-launch     scripts/split-pump-launch.ts

echo
echo "=== live mainnet static guards ==="
run mainnet-sim     scripts/split-mainnet-sim.ts

echo
echo "=== BURNER-ATTRIBUTED FAILURES ACROSS ALL SUITES ==="
python3 - "$OUT" <<'PY'
import json, sys, glob, os
out = sys.argv[1]
faults = []
for f in glob.glob(os.path.join(out, "*.json")):
    try: data = json.load(open(f))
    except Exception: continue
    rows = data if isinstance(data, list) else [v for v in data.values() if isinstance(v, (list, dict))]
    def walk(x):
        if isinstance(x, list):
            for i in x: walk(i)
        elif isinstance(x, dict):
            by = x.get("by") or x.get("rejectedBy")
            st = x.get("status") or x.get("result")
            if by == "burner" and st in ("rejected", "error"):
                faults.append((os.path.basename(f), x.get("name") or x.get("label") or x.get("token") or x.get("symbol"), x.get("code") or x.get("errorCode"), x.get("errorName") or x.get("codeName")))
            for v in x.values(): walk(v)
    walk(rows)
# negative/permissionless suites EXPECT burner rejections; exclude them
faults = [f for f in faults if not f[0].startswith(("negative", "permissionless", "guards"))]
if faults:
    for f in faults: print("  !!", f)
else:
    print("  none")
PY
