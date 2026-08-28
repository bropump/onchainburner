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
          Your creator fees go to an address you pick the rules for. When
          money arrives, anyone can press go: it buys the tokens you chose,
          in the shares you chose, and burns them. If any part of that
          fails, the whole thing is undone and your money stays where it is.
        </p>
        <p>
          Nobody can change it afterwards — not us, not you. There is no way
          to withdraw the money, no way to edit the tokens, and no owner.
          The rules are baked into the address itself, so changing anything
          just gives you a different, empty address.
        </p>
      </div>

      <div className="cards">
        <Link to="/launch" className="card" style={{ textDecoration: "none" }}>
          <h3>Launch a token + vault</h3>
          <p>
            Create a Pump.fun token, choose burn targets and weights, and
            commit the one-shot creator fee share to the vault — atomically
            with the proof that the vault can actually burn.
          </p>
          <span className="go">launch →</span>
        </Link>
        <Link to="/existing" className="card" style={{ textDecoration: "none" }}>
          <h3>Vault for an existing token</h3>
          <p>
            Paste any mint, pick targets, validate on chain, create the ATAs,
            and get an address to point payouts at. Works for any SOL source,
            not just Pump.
          </p>
          <span className="go">create a vault →</span>
        </Link>
      </div>

      {vaults.length > 0 && (
        <div className="panel" style={{ marginTop: 24 }}>
          <h2>Vaults created in this browser</h2>
          <p className="sub">
            The chain stores no config account, so these configs live only
            here (and in the addresses they derive).
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
