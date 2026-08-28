import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { WalletHandle } from "./wallet";

const DEMO_WALLET_KEY = "onchainburner.demoWallet.v1";

/** Load (or create and persist) the browser demo keypair. Fork/dev only. */
export function loadDemoWallet(storage: Storage = localStorage): WalletHandle {
  let keypair: Keypair;
  const stored = storage.getItem(DEMO_WALLET_KEY);
  if (stored) {
    try {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
      keypair = Keypair.generate();
      storage.setItem(DEMO_WALLET_KEY, JSON.stringify([...keypair.secretKey]));
    }
  } else {
    keypair = Keypair.generate();
    storage.setItem(DEMO_WALLET_KEY, JSON.stringify([...keypair.secretKey]));
  }
  return walletFromKeypair(keypair);
}

/** Raw-key wrapper retained for fork/dev and the existing headless harness. */
export function walletFromKeypair(keypair: Keypair): WalletHandle {
  return {
    kind: "demo",
    label: "Demo wallet",
    publicKey: keypair.publicKey,
    signTransaction: async (transaction: VersionedTransaction) => {
      transaction.sign([keypair]);
      return transaction;
    },
  };
}
