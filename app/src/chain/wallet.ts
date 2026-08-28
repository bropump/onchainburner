import type { PublicKey, VersionedTransaction } from "@solana/web3.js";

/**
 * Transaction-facing surface shared by Reown and the fork-only demo key.
 * Production obtains this from AppKit's Solana provider; the application
 * never receives or stores the connected wallet's secret key.
 */

export type WalletHandle = {
  kind: "reown" | "demo";
  label: string;
  publicKey: PublicKey;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
};

// Compatibility for the headless fork harness. The production application
// never imports this export; the app lazy-loads demoWallet only in Vite dev.
export { walletFromKeypair } from "./demoWallet";
