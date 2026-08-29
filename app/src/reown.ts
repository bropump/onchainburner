import { createAppKit } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana } from "@reown/appkit/networks";
import { REOWN_PROJECT_ID } from "./config";

const origin = globalThis.location?.origin ?? "https://onchainburner.com";

/**
 * Reown is initialized once, outside React. The Solana adapter discovers
 * Wallet Standard providers (Phantom, Solflare, Backpack and peers) and adds
 * WalletConnect for mobile/remote wallets. The app itself remains a static
 * browser bundle; RPC and burn-service calls stay ordinary HTTPS requests.
 */
export const appKit = createAppKit({
  adapters: [new SolanaAdapter({ registerWalletStandard: true })],
  networks: [solana],
  defaultNetwork: solana,
  projectId: REOWN_PROJECT_ID,
  metadata: {
    name: "Cooked",
    description: "Configuration-bound Solana community-burn vaults",
    url: origin,
    icons: [`${origin}/cooked-flame.png`],
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
  themeMode: "dark",
  themeVariables: {
    "--w3m-font-family": "inherit",
    "--w3m-border-radius-master": "2px",
    "--w3m-z-index": 2000,
  },
});
