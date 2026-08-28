import { useState } from "react";
import { useApp } from "../state/AppContext";
import { lamportsToSol, shortAddress } from "../ui";

/** Reown account controls, plus the explicitly fork-only demo wallet. */
export function WalletGate() {
  const {
    wallet,
    walletBalance,
    walletNetwork,
    walletConnectionStatus,
    connectWallet,
    manageWallet,
    useDemoWallet,
    disconnectWallet,
    isDemo,
    service,
    refreshBalance,
  } = useApp();
  const demoEnabled = import.meta.env.DEV && isDemo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!wallet) {
    return (
      <div className="wallet-gate">
        <button
          className="btn small"
          disabled={walletConnectionStatus === "connecting"}
          onClick={() => connectWallet().catch((e) => setError(String(e)))}
        >
          {walletConnectionStatus === "connecting"
            ? "Connecting…"
            : "Connect wallet"}
        </button>
        <span className="wallet-network">{walletNetwork}</span>
        {demoEnabled && (
          <button
            className="btn small"
            onClick={() =>
              useDemoWallet().catch((e) => setError(String(e)))
            }
          >
            Use demo wallet
          </button>
        )}
        {error && <span className="wallet-error">{error}</span>}
      </div>
    );
  }

  const lamports = walletBalance ?? 0n;
  const needsFunds = lamports < 50_000_000n;
  return (
    <div className="wallet-gate">
      <span>
        {wallet.label}{" "}
        <code className="mono">
          {shortAddress(wallet.publicKey.toBase58(), 6)}
        </code>
        {" · "}
        <span className="mono">{lamportsToSol(lamports)} SOL</span>
        {" · "}
        <span className="wallet-network">{walletNetwork}</span>
      </span>
      {wallet.kind === "reown" && (
        <button
          className="btn small"
          onClick={() => manageWallet().catch((e) => setError(String(e)))}
        >
          Account
        </button>
      )}
      <button
        className="btn small"
        onClick={() =>
          disconnectWallet().catch((e) => setError(String(e)))
        }
      >
        Disconnect
      </button>
      {demoEnabled && (
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await service.demoAirdrop(wallet.publicKey.toBase58(), 100_000_000_000n);
              await refreshBalance();
            } catch (e) {
              setError(String((e as Error).message ?? e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Funding…" : "Airdrop 100 SOL"}
        </button>
      )}
      {needsFunds && <span className="wallet-warning">Fund this wallet first.</span>}
      {error && <span className="wallet-error">{error}</span>}
    </div>
  );
}
