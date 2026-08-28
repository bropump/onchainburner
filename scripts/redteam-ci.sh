#!/usr/bin/env bash
# Fresh-fork red-team orchestration. Surfpool shares one state store through
# `.surfpool/` in the repo root — setAccount writes leak across "fresh" forks
# and survive restarts unless that directory is deleted AND every instance is
# killed. This script is the only supported way to run the campaign in CI.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

if [[ "${RPC:-}" != "" && ! "${RPC}" =~ ^http://(127\.0\.0\.1|localhost) ]]; then
  echo "error: redteam CI refuses non-loopback RPC ${RPC}" >&2
  exit 1
fi

port="${SURFPOOL_PORT:-9900}"
export RPC="${RPC:-http://127.0.0.1:${port}}"
export BURNER_PROGRAM_ID="${BURNER_PROGRAM_ID:-5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV}"
export FORK_DEX_PROFILE=pool

echo "== redteam-ci: stop leftover surfpool, wipe .surfpool/ =="
pkill -f "surfpool start" 2>/dev/null || true
sleep 1
if pgrep -f "surfpool start" >/dev/null 2>&1; then
  echo "error: surfpool still running after pkill" >&2
  pgrep -lf "surfpool start" || true
  exit 1
fi
rm -rf "$repo/.surfpool"

echo "== redteam-ci: start fork on :${port} =="
surfpool start --no-tui --no-studio -p "$port" -w $((port + 1)) -u https://api.mainnet-beta.solana.com \
  >/tmp/redteam-surfpool.log 2>&1 &
for i in $(seq 1 60); do
  if curl -s "$RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok; then
    break
  fi
  sleep 2
done

echo "== redteam-ci: upgrade production program id with current artifact =="
# Byte overlays of programdata do not reload Surfpool's executable cache.
# A real loader-v3 Upgrade is what makes Mode B (and everything else) hit
# the bytes we just built. See scripts/redteam-upgrade.mjs.
node scripts/redteam-upgrade.mjs "$RPC" programs/burner/target/deploy/pinocchio_parity.so "$BURNER_PROGRAM_ID"

echo "== redteam-ci: campaign =="
npx tsx scripts/redteam-campaign.ts rt8
npx tsx scripts/redteam-followup.ts all

echo "== redteam-ci: done =="
