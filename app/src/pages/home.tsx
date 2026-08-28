import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PublicKey } from "@solana/web3.js";
import { useApp } from "../state/AppContext";
import { deriveSplitPda, legsToParam } from "../chain/derive";
import { legLabel, shortAddress } from "../ui";

export function HomePage() {
  const { vaults, connection } = useApp();
  /** record.vault -> plain-language staleness reason. Saved configs outlive
   * the fork/network they were created on; flag the ones this chain cannot
   * serve instead of letting a burn discover it as a bare refusal. */
  const [stale, setStale] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!vaults.length) return;
    let cancelled = false;
    (async () => {
      const mints = [
        ...new Set(
          vaults.flatMap((r) => [r.launchMint, ...r.legs.map((l) => l.mint)])
        ),
      ];
      const infos = await connection.getMultipleAccountsInfo(
        mints.map((m) => new PublicKey(m)),
        "confirmed"
      );
      if (cancelled) return;
      const exists = new Map(mints.map((m, i) => [m, infos[i] !== null]));
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
      </div>

      {vaults.length > 0 && (
        <div className="panel" style={{ marginTop: 24 }}>
          <h2>Vaults created in this browser</h2>
          <p className="sub">
            Solana does not store your choices anywhere, so they are kept in
            this browser. The vault address itself is the permanent record.
          </p>
          <div className="vaultlist">
            {vaults.map((record) => (
              <Link
                key={record.vault}
                to="/vault"
                search={{
                  launch: record.launchMint,
                  legs: legsToParam(record.legs),
                  label: record.label,
                }}
                className="row"
              >
                <strong>{record.label || shortAddress(record.launchMint)}</strong>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                  {record.legs
                    .map((leg) => `${legLabel(leg.mint)} ${(leg.bps / 100).toFixed(0)}%`)
                    .join(" / ")}
                </span>
                {stale[record.vault] && (
                  <span className="tag warn">{stale[record.vault]}</span>
                )}
                <code style={{ marginLeft: "auto" }}>{shortAddress(record.vault, 6)}</code>
              </Link>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
