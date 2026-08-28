#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$repo_dir/programs/burner/target/deploy/pinocchio_parity.so"
solana_cli="${PINOCCHIO_SOLANA_CLI:-solana}"
mainnet_genesis="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
devnet_genesis="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"

: "${DEPLOY_NETWORK:?set DEPLOY_NETWORK to localnet, devnet, or mainnet}"
: "${DEPLOY_RPC_URL:?set DEPLOY_RPC_URL to the intended cluster RPC URL}"
: "${PINOCCHIO_PROGRAM_ID:?set PINOCCHIO_PROGRAM_ID to the intended program public key}"
: "${DEPLOY_UPGRADE_AUTHORITY:?set DEPLOY_UPGRADE_AUTHORITY explicitly}"
: "${EXPECTED_UPGRADE_AUTHORITY:?set EXPECTED_UPGRADE_AUTHORITY to the intended upgrade-authority public key}"
: "${DEPLOY_FEE_PAYER:?set DEPLOY_FEE_PAYER explicitly}"

solana_version="$("$solana_cli" --version 2>&1)"
case "$solana_version" in
  *"solana-cli 4.0.0"*) ;;
  *)
    echo "error: deployment requires solana-cli 4.0.0; observed: $solana_version" >&2
    exit 1
    ;;
esac

derived_upgrade_authority="$("$solana_cli" address --keypair "$DEPLOY_UPGRADE_AUTHORITY")"
if [[ "$derived_upgrade_authority" != "$EXPECTED_UPGRADE_AUTHORITY" ]]; then
  echo "error: upgrade-authority signer is $derived_upgrade_authority, expected $EXPECTED_UPGRADE_AUTHORITY" >&2
  exit 1
fi

rpc_genesis="$("$solana_cli" genesis-hash --url "$DEPLOY_RPC_URL")"
case "$DEPLOY_NETWORK" in
  mainnet)
    if [[ "$rpc_genesis" != "$mainnet_genesis" ]]; then
      echo "error: DEPLOY_NETWORK=mainnet requires genesis $mainnet_genesis; RPC returned $rpc_genesis" >&2
      exit 1
    fi
    ;;
  devnet)
    if [[ "$rpc_genesis" != "$devnet_genesis" ]]; then
      echo "error: DEPLOY_NETWORK=devnet requires genesis $devnet_genesis; RPC returned $rpc_genesis" >&2
      exit 1
    fi
    ;;
  localnet)
    if [[ "$rpc_genesis" == "$mainnet_genesis" || "$rpc_genesis" == "$devnet_genesis" ]]; then
      echo "error: DEPLOY_NETWORK=localnet refuses canonical mainnet/devnet genesis $rpc_genesis" >&2
      exit 1
    fi
    ;;
  *)
    echo "error: DEPLOY_NETWORK must be localnet, devnet, or mainnet" >&2
    exit 1
    ;;
esac
echo "Verified $DEPLOY_NETWORK RPC genesis: $rpc_genesis"

case "$DEPLOY_NETWORK" in
  localnet|devnet)
    PINOCCHIO_BUILD_NETWORK="$DEPLOY_NETWORK" "$repo_dir/scripts/build-pinocchio.sh"
    ;;
  mainnet)
    if [[ "${CONFIRM_MAINNET_PROGRAM_ID:-}" != "$PINOCCHIO_PROGRAM_ID" ]]; then
      echo "error: CONFIRM_MAINNET_PROGRAM_ID must match PINOCCHIO_PROGRAM_ID" >&2
      exit 1
    fi
    PINOCCHIO_BUILD_NETWORK=mainnet "$repo_dir/scripts/build-pinocchio.sh"
    ;;
  *)
    echo "error: DEPLOY_NETWORK must be localnet, devnet, or mainnet" >&2
    exit 1
    ;;
esac

program_id_arg="$PINOCCHIO_PROGRAM_ID"
if [[ -n "${PINOCCHIO_PROGRAM_KEYPAIR:-}" ]]; then
  [[ -f "$PINOCCHIO_PROGRAM_KEYPAIR" ]] || {
    echo "error: program keypair not found: $PINOCCHIO_PROGRAM_KEYPAIR" >&2
    exit 1
  }
  keypair_program_id="$($solana_cli address --keypair "$PINOCCHIO_PROGRAM_KEYPAIR")"
  if [[ "$keypair_program_id" != "$PINOCCHIO_PROGRAM_ID" ]]; then
    echo "error: program keypair is $keypair_program_id, expected $PINOCCHIO_PROGRAM_ID" >&2
    exit 1
  fi
  program_id_arg="$PINOCCHIO_PROGRAM_KEYPAIR"
fi

"$solana_cli" program deploy \
  --url "$DEPLOY_RPC_URL" \
  --commitment finalized \
  --program-id "$program_id_arg" \
  --upgrade-authority "$DEPLOY_UPGRADE_AUTHORITY" \
  --fee-payer "$DEPLOY_FEE_PAYER" \
  "$artifact"

DEPLOY_RPC_URL="$DEPLOY_RPC_URL" \
PINOCCHIO_PROGRAM_ID="$PINOCCHIO_PROGRAM_ID" \
PINOCCHIO_ARTIFACT="$artifact" \
EXPECTED_UPGRADE_AUTHORITY="$EXPECTED_UPGRADE_AUTHORITY" \
node "$repo_dir/scripts/verify-pinocchio-deployment.cjs"
