#!/usr/bin/env bash
#
#   pnpm deploy:mainnet
#   pnpm deploy:mainnet:dry-run
#
# Deploys the burner to mainnet. Does NOT publish solana-verify — that is
# `pnpm verify:mainnet` / `pnpm verify:mainnet:publish`.
#
# 4YBss... is the payer, the deployer, and the upgrade authority. You paste
# its secret key ONCE, hidden (`read -s`). It is never echoed, never written
# to shell history, never passed through argv (so it cannot be seen in `ps`),
# and the 0600 temp file holding it is shredded on every exit path including
# Ctrl-C.
#
# It spends only what the deploy actually costs: rent-exemption for the
# program account plus transaction fees. Whatever else is in the wallet stays.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
[ "$#" -eq 0 ] || die "usage: $0"
require_cli
require_solana_verify
require_program_identity
require_public_main

PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
SOURCE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"

build_sbfv3_artifact
SIZE="$ARTIFACT_SIZE"
SHA="$ARTIFACT_SHA"

PROGRAMDATA_LEN=$((45 + SIZE))
BUFFER_LEN=$((37 + SIZE))
RENT_PROGRAMDATA=$(solana rent "$PROGRAMDATA_LEN" --url "$MAINNET_RPC" --output json 2>/dev/null \
  | python3 -c "import sys,json;print(int(float(json.load(sys.stdin)['rentExemptMinimumLamports'])))" 2>/dev/null) \
  || die "could not obtain live ProgramData rent from $MAINNET_RPC"
RENT_PROGRAM=$(solana rent 36 --url "$MAINNET_RPC" --output json 2>/dev/null \
  | python3 -c "import sys,json;print(int(float(json.load(sys.stdin)['rentExemptMinimumLamports'])))" 2>/dev/null) \
  || die "could not obtain live program-account rent from $MAINNET_RPC"
RENT_BUFFER=$(solana rent "$BUFFER_LEN" --url "$MAINNET_RPC" --output json 2>/dev/null \
  | python3 -c "import sys,json;print(int(float(json.load(sys.stdin)['rentExemptMinimumLamports'])))" 2>/dev/null) \
  || die "could not obtain live temporary-buffer rent from $MAINNET_RPC"
TX_COUNT=$(( SIZE / 1000 + 8 ))
FEES=$(( TX_COUNT * 5000 ))
RENT=$(( RENT_PROGRAMDATA + RENT_PROGRAM ))
TOTAL=$(( RENT + FEES ))
PEAK_REQUIRED=$(( TOTAL + RENT_BUFFER ))

HAVE=$(solana balance "$EXPECTED_UPGRADE_AUTHORITY" --url "$MAINNET_RPC" --lamports 2>/dev/null | awk '{print $1}')
HAVE=${HAVE:-0}

echo
echo "  ============================================================"
echo "   WHAT THIS DOES"
echo "  ============================================================"
echo "   deploy $PROGRAM_ID to mainnet"
echo "   (verification is a separate command: pnpm verify:mainnet)"
echo
echo "   program id        $PROGRAM_ID"
echo "   artifact          $SIZE bytes, SBPFv3"
echo "   sha256            $SHA"
echo "   payer/upgrade     $EXPECTED_UPGRADE_AUTHORITY"
echo "   source repo       $SOURCE_REPO_URL"
echo "   source commit     $SOURCE_COMMIT"
echo "   rpc               $MAINNET_RPC"
echo
echo "  ============================================================"
echo "   WHAT YOU PAY"
echo "  ============================================================"
python3 - <<PYCOST
rp, ra, rb, f, t, peak, have = $RENT_PROGRAMDATA, $RENT_PROGRAM, $RENT_BUFFER, $FEES, $TOTAL, $PEAK_REQUIRED, $HAVE
row = lambda l, v: print(f"   {l:<34}{v/1e9:>12.6f} SOL")
row("programdata rent (recoverable)", rp)
row("program account rent (recoverable)", ra)
row(f"transaction fees (~$TX_COUNT tx, spent)", f)
print("   " + "-"*46)
row("NET DEPLOY COST", t)
row("temporary buffer rent (refunded)", rb)
row("PEAK BALANCE NEEDED", peak)
print()
row("wallet balance now", have)
row("balance after", have - t)
print()
print(f"   Of that, {(rp+ra)/1e9:.4f} SOL is rent-exemption LOCKED in the program")
print(f"   account -- not spent. It returns only if the program is ever closed.")
print(f"   Genuinely consumed: {f/1e9:.6f} SOL in fees.")
PYCOST
echo "  ============================================================"
echo

[ "$HAVE" -ge "$PEAK_REQUIRED" ] || die "wallet holds $(python3 -c "print(f'{$HAVE/1e9:.4f}')") SOL, needs a peak balance of $(python3 -c "print(f'{$PEAK_REQUIRED/1e9:.4f}')") SOL (temporary buffer rent is refunded)"

if [ "${MAINNET_DEPLOY_DRY_RUN:-0}" = "1" ]; then
  grn "dry run passed: source, toolchain, artifact, identity, RPC and funding are ready"
  echo "  no key was read. next: pnpm deploy:mainnet"
  exit 0
fi

ylw "This deploys to MAINNET and retains the upgrade authority by owner decision."
confirm "  type the program id to continue: " "$PROGRAM_ID"

read_authority_keypair "$EXPECTED_UPGRADE_AUTHORITY"
AUTH="$AUTH_KEYPAIR_PATH"

solana program deploy "$ARTIFACT" \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$AUTH" \
  --upgrade-authority "$AUTH" \
  --url "$MAINNET_RPC"

grn "deployed."
echo
PROGRAM_SHOW="$(solana program show "$PROGRAM_ID" --keypair "$AUTH" --url "$MAINNET_RPC")" \
  || die "deployment landed but program metadata could not be read"
printf '%s\n' "$PROGRAM_SHOW"
ONCHAIN_AUTHORITY=$(printf '%s\n' "$PROGRAM_SHOW" | awk -F': ' '$1 == "Authority" {print $2; exit}')
[ "$ONCHAIN_AUTHORITY" = "$EXPECTED_UPGRADE_AUTHORITY" ] \
  || die "deployed upgrade authority is ${ONCHAIN_AUTHORITY:-unreadable}, expected $EXPECTED_UPGRADE_AUTHORITY"
echo
ylw "comparing the just-deployed ProgramData to the artifact above ..."
compare_deployed_artifact "$PROGRAM_ID"
echo
grn "  program id          $PROGRAM_ID"
echo "  sha256              $SHA"
echo "  upgrade authority   $EXPECTED_UPGRADE_AUTHORITY"
echo
echo "  next: pnpm verify:mainnet:publish"
echo "        paste the same wallet key to publish the named repo commit"
echo "  owner decision: retain the authority; revocation is not a release step"
