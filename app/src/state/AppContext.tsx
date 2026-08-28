import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  useDisconnect,
  useWalletInfo,
} from "@reown/appkit/react";
import type { Provider } from "@reown/appkit-adapter-solana/react";
import { BURN_SERVICE_URL, IS_DEMO, NETWORK, RPC_URL } from "../config";
import { makeService, ServiceHealth } from "../chain/service";
import type { WalletHandle } from "../chain/wallet";

export type VaultRecord = {
  label: string;
  launchMint: string;
  legs: { mint: string; bps: number; ref?: string }[];
  vault: string;
  createdAt: number;
  feeShare?: boolean;
};

const VAULTS_KEY = "onchainburner.vaults.v1";
/** vault address -> its creator-owned lookup table address. Kept separate
 * from VaultRecord so it survives a vault opened by URL config (no saved
 * record) and so a table created later is remembered without rewriting the
 * record. The table itself lives on chain; this is just the local pointer. */
const VAULT_ALTS_KEY = "onchainburner.vaultAlts.v1";

function readVaults(): VaultRecord[] {
  try {
    return JSON.parse(localStorage.getItem(VAULTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function readVaultAlts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VAULT_ALTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

type AppState = {
  network: typeof NETWORK;
  isDemo: boolean;
  rpcUrl: string;
  connection: Connection;
  service: ReturnType<typeof makeService>;
  health: ServiceHealth | "down" | null;
  wallet: WalletHandle | null;
  walletBalance: bigint | null;
  walletNetwork: string;
  walletConnectionStatus: "connected" | "disconnected" | "connecting" | "reconnecting";
  connectWallet: () => Promise<void>;
  manageWallet: () => Promise<void>;
  useDemoWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  vaults: VaultRecord[];
  saveVault: (record: VaultRecord) => void;
  /** The creator-owned lookup table remembered for a vault, or null. */
  vaultLookupTable: (vault: string) => string | null;
  /** Remember (or clear) a vault's lookup table pointer in this browser. */
  setVaultLookupTable: (vault: string, table: string | null) => void;
  /** Remove a saved config by its content (launch mint + exact legs). Keyed
   * on content rather than the stored vault address because a config saved
   * against another fork/deployment derives a different address under the
   * current program. */
  removeVaultConfig: (launchMint: string, legsKey: string) => void;
};

const Context = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const { open } = useAppKit();
  const reownAccount = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<Provider>("solana");
  const { caipNetwork } = useAppKitNetwork();
  const { walletInfo } = useWalletInfo();
  const { disconnect } = useDisconnect();
  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);
  const service = useMemo(() => makeService(BURN_SERVICE_URL, !IS_DEMO), []);
  const [health, setHealth] = useState<ServiceHealth | "down" | null>(null);
  const [demoWallet, setDemoWallet] = useState<WalletHandle | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [vaults, setVaults] = useState<VaultRecord[]>(readVaults);
  const [vaultAlts, setVaultAlts] =
    useState<Record<string, string>>(readVaultAlts);
  const reownWallet = useMemo<WalletHandle | null>(() => {
    if (!reownAccount.isConnected || !reownAccount.address || !walletProvider) {
      return null;
    }
    try {
      return {
        kind: "reown",
        label: walletInfo?.name || "Connected wallet",
        publicKey: new PublicKey(reownAccount.address),
        signTransaction: (transaction) =>
          walletProvider.signTransaction(transaction),
      };
    } catch {
      return null;
    }
  }, [
    reownAccount.address,
    reownAccount.isConnected,
    walletInfo?.name,
    walletProvider,
  ]);
  const wallet = demoWallet ?? reownWallet;
  const walletNetwork =
    demoWallet !== null
      ? "Solana fork"
      : NETWORK === "mainnet"
        ? "Solana Mainnet"
        : `${caipNetwork?.name ?? "Solana"} · fork RPC`;
  const walletConnectionStatus = demoWallet
    ? "connected"
    : reownAccount.status ?? "disconnected";

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      service
        .health()
        .then((h) => !cancelled && setHealth(h))
        .catch(() => !cancelled && setHealth("down"));
    poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service]);

  const refreshBalance = useCallback(async () => {
    if (!wallet) return setWalletBalance(null);
    const balance = await connection.getBalance(wallet.publicKey, "confirmed");
    setWalletBalance(BigInt(balance));
  }, [connection, wallet]);

  useEffect(() => {
    refreshBalance();
    const timer = setInterval(refreshBalance, 8_000);
    return () => clearInterval(timer);
  }, [refreshBalance]);

  const connectWallet = useCallback(async () => {
    setDemoWallet(null);
    await open({ view: "Connect", namespace: "solana" });
  }, [open]);
  const manageWallet = useCallback(async () => {
    if (demoWallet) return;
    await open({ view: "Account" });
  }, [demoWallet, open]);
  const useDemoWalletCb = useCallback(async () => {
    // Vite replaces import.meta.env.DEV at build time. In a production build
    // this branch ends before the dynamic import, so no demo key code is
    // linked into a reachable application path.
    if (!import.meta.env.DEV || !IS_DEMO) {
      throw new Error("demo wallet is demo-mode only");
    }
    const { loadDemoWallet } = await import("../chain/demoWallet");
    setDemoWallet(loadDemoWallet());
  }, []);
  const disconnectWallet = useCallback(async () => {
    if (demoWallet) {
      setDemoWallet(null);
      return;
    }
    await disconnect({ namespace: "solana" });
  }, [demoWallet, disconnect]);

  const saveVault = useCallback((record: VaultRecord) => {
    setVaults((current) => {
      const next = [
        record,
        ...current.filter((v) => v.vault !== record.vault),
      ].slice(0, 20);
      localStorage.setItem(VAULTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const vaultLookupTable = useCallback(
    (vault: string) => vaultAlts[vault] ?? null,
    [vaultAlts]
  );
  const setVaultLookupTable = useCallback(
    (vault: string, table: string | null) => {
      setVaultAlts((current) => {
        const next = { ...current };
        if (table) next[vault] = table;
        else delete next[vault];
        localStorage.setItem(VAULT_ALTS_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  const removeVaultConfig = useCallback(
    (launchMint: string, legsKey: string) => {
      const keyOf = (record: VaultRecord) =>
        record.legs
          .map((leg) =>
            leg.ref
              ? `${leg.mint}:${leg.bps}:${leg.ref}`
              : `${leg.mint}:${leg.bps}`
          )
          .join(",");
      setVaults((current) => {
        const next = current.filter(
          (record) =>
            !(record.launchMint === launchMint && keyOf(record) === legsKey)
        );
        localStorage.setItem(VAULTS_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  const value: AppState = {
    network: NETWORK,
    isDemo: IS_DEMO,
    rpcUrl: RPC_URL,
    connection,
    service,
    health,
    wallet,
    walletBalance,
    walletNetwork,
    walletConnectionStatus,
    connectWallet,
    manageWallet,
    useDemoWallet: useDemoWalletCb,
    disconnectWallet,
    refreshBalance,
    vaults,
    saveVault,
    vaultLookupTable,
    setVaultLookupTable,
    removeVaultConfig,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApp(): AppState {
  const state = useContext(Context);
  if (!state) throw new Error("useApp outside AppProvider");
  return state;
}
