import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PublicKey } from "@solana/web3.js";
import { useApp, type VaultRecord } from "../state/AppContext";
import { deriveSplitPda, legsToParam } from "../chain/derive";
import { isPlatformFeeLeg } from "../chain/policy";
import { useTokenPreview } from "../chain/tokenName";
import { shortAddress } from "../ui";

const LAMPORTS_PER_SOL = 1_000_000_000;

function formatVaultBalance(lamports: number | undefined) {
  if (lamports === undefined) return "Checking balance";
  const sol = lamports / LAMPORTS_PER_SOL;
  return `${sol.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: sol < 0.01 ? 6 : 3,
  })} SOL`;
}

function SavedVaultCard({
  record,
  connection,
  staleReason,
  balance,
}: {
  record: VaultRecord;
  connection: ReturnType<typeof useApp>["connection"];
  staleReason?: string;
  balance?: number;
}) {
  const launch = useTokenPreview(connection, record.launchMint);
  const platformFeeLeg = record.legs.find((leg) =>
    isPlatformFeeLeg(leg.mint, leg.bps)
  );
  const burnLegs = record.legs.filter(
    (leg) => !isPlatformFeeLeg(leg.mint, leg.bps)
  );
  const primaryLeg = burnLegs.reduce(
    (largest, leg) => (leg.bps > largest.bps ? leg : largest),
    burnLegs[0] ?? record.legs[0]
  );
  const target = useTokenPreview(connection, primaryLeg?.mint ?? null);
  const launchName = launch.token?.name || record.label || "Saved launch";
  const launchSymbol = launch.token?.symbol || record.label;
  const targetName =
    target.token?.symbol || target.token?.name || shortAddress(primaryLeg.mint);
  const initials = (launchSymbol || launchName)
    .replace(/^\$/, "")
    .slice(0, 2)
    .toUpperCase();

  return (
    <Link
      to="/vault"
      search={{
        launch: record.launchMint,
        legs: legsToParam(record.legs),
        label: record.label,
      }}
      className="saved-vault-card"
      aria-label={`Open ${launchName} vault`}
    >
      <div className="saved-vault-card-head">
        <span className="saved-vault-art" aria-hidden="true">
          {launch.image ? <img src={launch.image} alt="" /> : initials}
        </span>
        <span className="saved-vault-identity">
          <span className="saved-vault-name">{launchName}</span>
          {launchSymbol && launchSymbol !== launchName && (
            <span className="saved-vault-symbol">${launchSymbol.replace(/^\$/, "")}</span>
          )}
        </span>
        <span className="saved-vault-open">Open vault <span aria-hidden="true">→</span></span>
      </div>

      <div className="saved-vault-burn">
        <span className="saved-vault-burn-label">Burns</span>
        <strong>{targetName}</strong>
        <span>{(primaryLeg.bps / 100).toFixed(0)}%</span>
        {platformFeeLeg && (
          <span className="saved-vault-fee">
            Platform fees {platformFeeLeg.bps / 100}%
          </span>
        )}
      </div>

      <div className="saved-vault-meta">
        <span>
          <span className="saved-vault-meta-label">Vault balance</span>
          <strong>{formatVaultBalance(balance)}</strong>
        </span>
        <span>
          <span className="saved-vault-meta-label">Vault</span>
          <code>{shortAddress(record.vault, 6)}</code>
        </span>
      </div>

      {staleReason && (
        <span className="saved-vault-warning" title={staleReason}>
          Unavailable on this network
        </span>
      )}
    </Link>
  );
}

export function HomePage() {
  const { vaults, connection } = useApp();
  /** record.vault -> plain-language staleness reason. Saved configs outlive
   * the fork/network they were created on; flag the ones this chain cannot
   * serve instead of letting a burn discover it as a bare refusal. */
  const [stale, setStale] = useState<Record<string, string>>({});
  const [vaultBalances, setVaultBalances] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!vaults.length) return;
    let cancelled = false;
    (async () => {
      const mints = [
        ...new Set(
          vaults.flatMap((r) => [r.launchMint, ...r.legs.map((l) => l.mint)])
        ),
      ];
      const addresses = [...mints, ...vaults.map((record) => record.vault)];
      const infos = await connection.getMultipleAccountsInfo(
        addresses.map((address) => new PublicKey(address)),
        "confirmed"
      );
      if (cancelled) return;
      const exists = new Map(mints.map((m, i) => [m, infos[i] !== null]));
      const nextBalances = Object.fromEntries(
        vaults.map((record, index) => [
          record.vault,
          infos[mints.length + index]?.lamports ?? 0,
        ])
      );
      const next: Record<string, string> = {};
      for (const record of vaults) {
        const missing = [
          record.launchMint,
          ...record.legs.map((l) => l.mint),
        ].filter((m) => !exists.get(m));
        if (missing.length) {
          next[record.vault] =
            "not on this chain — created against a different fork/network";
          continue;
        }
        try {
          const derived = deriveSplitPda(
            new PublicKey(record.launchMint),
            record.legs.map((l) => ({
              mint: new PublicKey(l.mint),
              bps: l.bps,
              ref: l.ref ? new PublicKey(l.ref) : undefined,
            }))
          )[0].toBase58();
          if (derived !== record.vault) {
            next[record.vault] =
              "saved under a different program deployment — address differs here";
          }
        } catch {
          /* malformed record; the vault page explains */
        }
      }
      setStale(next);
      setVaultBalances(nextBalances);
    })().catch(() => {
      /* RPC unreachable; the status badge in the header covers it */
    });
    return () => {
      cancelled = true;
    };
  }, [connection, vaults]);
  return (
    <div>
      <div className="hero-copy">
        <h1>
          Use Pump creator fees to buy any token and burn it — onchain,
          provably.
        </h1>
        <p>
          Your creator fees go into a vault on Solana. The vault has one
          job: buy the tokens you picked and burn them. That is the only
          thing it can ever do.
        </p>
        <p>
          Nobody can take the money out — not us, not you, not anyone.
          There is no withdraw button, because one was never written. And
          the vault's rules are fixed the moment you create it: they are
          part of its address, so they can never be edited afterwards.
        </p>
      </div>

      <figure className="how-it-works">
        <svg viewBox="-3 -2 726 137" role="img" aria-labelledby="how-title">
          <title id="how-title">
            Creator fees go into a vault, which buys your chosen tokens and
            burns them.
          </title>
          <defs>
            <marker
              id="hiw-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="var(--line-strong)" />
            </marker>
          </defs>

          {/* fees in */}
          <rect x="1" y="30" width="150" height="52" rx="8" />
          <text className="hiw-h" x="76" y="52">Creator fees</text>
          <text className="hiw-s" x="76" y="69">arrive as SOL</text>

          <line
            x1="153" y1="56" x2="207" y2="56"
            markerEnd="url(#hiw-arrow)"
          />

          {/* vault */}
          <rect className="hiw-key" x="211" y="16" width="176" height="80" rx="8" />
          <text className="hiw-h" x="299" y="46">Your vault</text>
          <text className="hiw-s" x="299" y="64">rules fixed forever,</text>
          <text className="hiw-s" x="299" y="79">no way to withdraw</text>

          <line
            x1="389" y1="56" x2="443" y2="56"
            markerEnd="url(#hiw-arrow)"
          />

          {/* buy */}
          <rect x="447" y="30" width="118" height="52" rx="8" />
          <text className="hiw-h" x="506" y="52">Buys</text>
          <text className="hiw-s" x="506" y="69">the tokens you picked</text>

          <line
            x1="567" y1="56" x2="601" y2="56"
            markerEnd="url(#hiw-arrow)"
          />

          {/* burn */}
          <rect className="hiw-burn" x="605" y="30" width="114" height="52" rx="8" />
          <text className="hiw-h hiw-burn-t" x="662" y="52">Burns them</text>
          <text className="hiw-s hiw-burn-t" x="662" y="69">gone for good</text>

          <text className="hiw-foot" x="360" y="124">
            If any step fails, the whole thing is undone and your money stays put.
          </text>
        </svg>
      </figure>

      <div className="cards">
        <Link to="/launch" className="card" style={{ textDecoration: "none" }}>
          <h3>Launch a new token</h3>
          <p>
            Make a Pump.fun token, choose which tokens its fees should buy
            and burn, and point the fees at the vault. You get one shot at
            pointing them, so we check the vault works first, in the same
            transaction.
          </p>
          <span className="go">launch →</span>
        </Link>
        <Link to="/existing" className="card" style={{ textDecoration: "none" }}>
          <h3>Vault for a token you already have</h3>
          <p>
            Paste the token's address, choose what to buy and burn, and get
            a vault address to send fees to. Any source of SOL works, not
            just Pump.
          </p>
          <span className="go">create a vault →</span>
        </Link>
        <Link to="/community" className="card" style={{ textDecoration: "none" }}>
          <h3>Community vault rankings</h3>
          <p>
            See every token community burned by the program, ranked by SOL
            committed, token supply destroyed, and completed burns.
          </p>
          <span className="go">view rankings →</span>
        </Link>
      </div>

      {vaults.length > 0 && (
        <section className="saved-vaults">
          <div className="saved-vaults-heading">
            <div>
              <h2>New vaults burning</h2>
            </div>
            <span className="saved-vaults-count">{vaults.length}</span>
          </div>
          <div className="saved-vault-grid">
            {vaults.map((record) => (
              <SavedVaultCard
                key={record.vault}
                record={record}
                connection={connection}
                staleReason={stale[record.vault]}
                balance={vaultBalances[record.vault]}
              />
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
