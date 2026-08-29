/**
 * Node resolution of "#pump-sdk" (headless e2e under tsx): load the SDK's
 * CJS build via createRequire. The ESM build cannot load under node because
 * its dependency @pump-fun/agent-payments-sdk uses named imports from
 * @coral-xyz/anchor's CJS that node's ESM loader cannot enumerate. The CJS
 * chain is exactly how the repo's own scripts consume the SDK.
 */
import { createRequire } from "node:module";
import type { PublicKey } from "@solana/web3.js";
import type { PumpSdk } from "@pump-fun/pump-sdk";

const require = createRequire(import.meta.url);
const sdk = require("@pump-fun/pump-sdk") as {
  PUMP_SDK: PumpSdk;
  PUMP_AMM_PROGRAM_ID: PublicKey;
  PUMP_FEE_PROGRAM_ID: PublicKey;
  canonicalPumpPoolPda: (mint: PublicKey) => PublicKey;
  creatorVaultPda: (creator: PublicKey) => PublicKey;
  feeSharingConfigPda: (mint: PublicKey) => PublicKey;
};

export const PUMP_SDK: PumpSdk = sdk.PUMP_SDK;
export const PUMP_AMM_PROGRAM_ID = sdk.PUMP_AMM_PROGRAM_ID;
export const PUMP_FEE_PROGRAM_ID = sdk.PUMP_FEE_PROGRAM_ID;
export const canonicalPumpPoolPda = sdk.canonicalPumpPoolPda;
export const creatorVaultPda = sdk.creatorVaultPda;
export const feeSharingConfigPda = sdk.feeSharingConfigPda;
