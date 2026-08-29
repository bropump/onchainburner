import { useState } from "react";
import { useApp } from "../state/AppContext";
import { shortAddress } from "../ui";

function compactSol(lamports: bigint): string {
  const hundredths = (lamports + 5_000_000n) / 10_000_000n;
  return `${hundredths / 100n}.${(hundredths % 100n)
    .toString()
    .padStart(2, "0")}`;
}

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
          className="btn primary wallet-connect"
          disabled={walletConnectionStatus === "connecting"}
          onClick={() => connectWallet().catch((e) => setError(String(e)))}
        >
          {walletConnectionStatus === "connecting"
            ? "Connecting…"
            : "Connect"}
        </button>
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
  const address = wallet.publicKey.toBase58();
  const walletAction = wallet.kind === "reown" ? manageWallet : disconnectWallet;
  return (
    <div className="wallet-gate">
      <button
        className={`wallet-chip${needsFunds ? " warning" : ""}`}
        aria-label={`${wallet.label}, ${compactSol(lamports)} SOL, ${shortAddress(
          address,
          6
        )}, ${walletNetwork}${needsFunds ? ", needs funds" : ""}`}
        title={`${shortAddress(address, 6)} · ${walletNetwork}${
          wallet.kind === "reown" ? " · Open account" : " · Disconnect"
        }`}
        onClick={() => walletAction().catch((e) => setError(String(e)))}
      >
        <span className="wallet-status" aria-hidden="true" />
        <span className="wallet-provider">{wallet.label}</span>
        <span className="wallet-separator" aria-hidden="true">
          ·
        </span>
        <span className="mono">{compactSol(lamports)} SOL</span>
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
      {error && <span className="wallet-error">{error}</span>}
    </div>
  );
}
