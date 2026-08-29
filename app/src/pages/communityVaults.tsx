import { useEffect, useMemo, useState } from "react";
import { KNOWN_TOKENS } from "../chain/constants";
import { useTokenPreview } from "../chain/tokenName";
import { useApp } from "../state/AppContext";
import { CopyButton, shortAddress } from "../ui";

type Community = Readonly<{
  mint: string;
  solLamports: string;
  burnedAtoms: string;
  burnCount: number;
  vaultCount: number;
  launchCount: number;
  lastBurnAt: number | null;
  decimals: number | null;
  currentSupplyAtoms: string | null;
}>;

type Launch = Readonly<{
  mint: string;
  solLamports: string;
  burnCount: number;
  vaultCount: number;
  targetCount: number;
  lastBurnAt: number | null;
}>;

type Leaderboard = Readonly<{
  program: string;
  finalized: boolean;
  totals: {
    solLamports: string;
    burnCount: number;
    communityCount: number;
    launchCount: number;
  };
  communities: readonly Community[];
  launches: readonly Launch[];
  index: {
    updatedAt: number;
    slot: number;
    backfillComplete: boolean;
  };
}>;

const known = new Map(KNOWN_TOKENS.map((token) => [token.mint, token]));

function formatUnits(atoms: string, decimals: number, fractionDigits = 4) {
  const value = BigInt(atoms);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, fractionDigits)
    .replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function formatSol(lamports: string) {
  return `${formatUnits(lamports, 9, 4)} SOL`;
}

function burnedShare(row: Community): string {
  if (row.currentSupplyAtoms === null) return "—";
  const burned = BigInt(row.burnedAtoms);
  const denominator = burned + BigInt(row.currentSupplyAtoms);
  if (denominator === 0n) return "—";
  const hundredths = (burned * 10_000n) / denominator;
  return `${hundredths / 100n}.${(hundredths % 100n)
    .toString()
    .padStart(2, "0")}%`;
}

function timeLabel(timestamp: number | null): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1_000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function TokenIdentity({ mint, appHref }: { mint: string; appHref?: string }) {
  const { connection } = useApp();
  const preset = known.get(mint);
  const preview = useTokenPreview(connection, mint);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [mint, preview.image]);

  const symbol = preset?.symbol ?? preview.token?.symbol ?? null;
  const name = preview.token?.name ?? null;
  const identity = (
    <>
      <span className="community-avatar" aria-hidden="true">
        {preview.image && !imageFailed ? (
          <img
            src={preview.image}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          symbol?.slice(0, 2) ?? "◎"
        )}
      </span>
      <span>
        <strong>{symbol ?? name ?? "Community token"}</strong>
        <span className="community-token-address">{shortAddress(mint, 5)}</span>
      </span>
    </>
  );
  return appHref ? (
    <a className="community-token community-token-link" href={appHref}>
      {identity}
    </a>
  ) : (
    <a
      className="community-token community-token-link"
      href={`https://solscan.io/token/${mint}`}
      target="_blank"
      rel="noreferrer"
      title={mint}
    >
      {identity}
    </a>
  );
}

export function CommunityVaultsPage() {
  const [data, setData] = useState<Leaderboard | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<"sol" | "tokens" | "burns">("sol");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/community-vaults", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("leaderboard unavailable");
        return response.json();
      })
      .then((value) => setData(value as Leaderboard))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(true);
        }
      });
    return () => controller.abort();
  }, []);

  const communities = useMemo(() => {
    if (!data) return [];
    return [...data.communities].sort((left, right) => {
      if (sort === "burns") return right.burnCount - left.burnCount;
      const leftValue = BigInt(
        sort === "tokens" ? left.burnedAtoms : left.solLamports
      );
      const rightValue = BigInt(
        sort === "tokens" ? right.burnedAtoms : right.solLamports
      );
      return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
    });
  }, [data, sort]);

  return (
    <div className="community-page">
      <div className="hero-copy">
        <span className="eyebrow">COMMUNITY VAULTS</span>
        <h1>Every community burn, ranked from the chain.</h1>
        <p>
          Any token burned successfully by a Cooked vault appears
          here automatically. Preset support does not affect eligibility.
        </p>
      </div>

      {error && (
        <div className="notice err">
          The finalized burn index is temporarily unavailable. No estimates are
          shown in its place.
        </div>
      )}

      {!data && !error && (
        <div className="panel community-loading">Reading finalized burns…</div>
      )}

      {data && (
        <>
          <div className="community-stats">
            <div className="community-stat">
              <span>Burn volume</span>
              <strong>{formatSol(data.totals.solLamports)}</strong>
            </div>
            <div className="community-stat">
              <span>Completed burns</span>
              <strong>{data.totals.burnCount.toLocaleString()}</strong>
            </div>
            <div className="community-stat">
              <span>Communities</span>
              <strong>{data.totals.communityCount.toLocaleString()}</strong>
            </div>
            <div className="community-stat">
              <span>Launch tokens funding vaults</span>
              <strong>{data.totals.launchCount.toLocaleString()}</strong>
            </div>
          </div>

          <section className="panel community-board">
            <div className="community-board-head">
              <div>
                <h2>Community burn ranking</h2>
                <p>
                  SOL volume and token supply destroyed by this burner program.
                </p>
              </div>
              <label>
                Rank by
                <select
                  value={sort}
                  onChange={(event) =>
                    setSort(event.target.value as typeof sort)
                  }
                >
                  <option value="sol">SOL burned</option>
                  <option value="tokens">Token amount</option>
                  <option value="burns">Burn count</option>
                </select>
              </label>
            </div>

            {communities.length === 0 ? (
              <div className="community-empty">
                <strong>No finalized mainnet burns yet.</strong>
                <span>The first successful community burn takes rank #1.</span>
              </div>
            ) : (
              <div className="community-table-wrap">
                <table className="data community-table">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Community</th>
                      <th className="num">SOL burned</th>
                      <th className="num">Tokens burned</th>
                      <th className="num">Supply burned</th>
                      <th className="num">Burns</th>
                      <th>Latest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {communities.map((row, index) => (
                      <tr key={row.mint}>
                        <td className="num community-rank">{index + 1}</td>
                        <td><TokenIdentity mint={row.mint} /></td>
                        <td className="num">{formatSol(row.solLamports)}</td>
                        <td className="num">
                          {row.decimals === null
                            ? `${BigInt(row.burnedAtoms).toLocaleString()} atoms`
                            : formatUnits(row.burnedAtoms, row.decimals)}
                        </td>
                        <td className="num">{burnedShare(row)}</td>
                        <td className="num">{row.burnCount.toLocaleString()}</td>
                        <td>{timeLabel(row.lastBurnAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.launches.length > 0 && (
            <section className="panel community-board">
              <div className="community-board-head">
                <div>
                  <h2>Vault funding activity</h2>
                  <p>Which launch namespaces have funded the most burning.</p>
                </div>
              </div>
              <div className="community-table-wrap">
                <table className="data community-table">
                  <thead>
                    <tr>
                      <th>Launch mint</th>
                      <th className="num">SOL burned</th>
                      <th className="num">Burns</th>
                      <th className="num">Targets</th>
                      <th>Latest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.launches.map((row) => (
                      <tr key={row.mint}>
                        <td>
                          <TokenIdentity
                            mint={row.mint}
                            appHref={`/community/launch/${encodeURIComponent(row.mint)}`}
                          />
                        </td>
                        <td className="num">{formatSol(row.solLamports)}</td>
                        <td className="num">{row.burnCount}</td>
                        <td className="num">{row.targetCount}</td>
                        <td>{timeLabel(row.lastBurnAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="community-proof">
            Finalized Solana transactions only · indexed at slot {data.index.slot.toLocaleString()}
            {data.index.updatedAt
              ? ` · updated ${timeLabel(data.index.updatedAt)}`
              : ""}
            {data.index.backfillComplete ? " · history complete" : " · history syncing"}
          </p>
        </>
      )}
    </div>
  );
}

type LaunchDetail = Readonly<{
  launchMint: string;
  totals: {
    solLamports: string;
    burnCount: number;
    vaultCount: number;
    targetCount: number;
    lastBurnAt: number | null;
  };
  vaults: readonly {
    vault: string;
    solLamports: string;
    burnCount: number;
    targetCount: number;
    lastBurnAt: number | null;
  }[];
}>;

type VaultDetail = Readonly<{
  vault: string;
  launchMints: readonly string[];
  totals: {
    solLamports: string;
    burnCount: number;
    targetCount: number;
    lastBurnAt: number | null;
  };
  targets: readonly {
    mint: string;
    solLamports: string;
    burnedAtoms: string;
    burnCount: number;
    lastBurnAt: number | null;
  }[];
}>;

function DetailLoading() {
  return <div className="panel community-loading">Reading finalized burns…</div>;
}

function DetailError() {
  return <div className="notice err">This community page is unavailable.</div>;
}

export function CommunityLaunchPage({ mint }: { mint: string }) {
  const [data, setData] = useState<LaunchDetail | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/community-vaults?launch=${encodeURIComponent(mint)}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("launch unavailable");
        return response.json();
      })
      .then((value) => setData(value as LaunchDetail))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, [mint]);

  return (
    <div className="community-page">
      <a className="community-back" href="/community">← Community vaults</a>
      <div className="hero-copy community-detail-hero">
        <span className="eyebrow">LAUNCH</span>
        <TokenIdentity mint={mint} />
      </div>
      {error ? <DetailError /> : !data ? <DetailLoading /> : (
        <>
          <div className="community-stats">
            <div className="community-stat"><span>SOL burned</span><strong>{formatSol(data.totals.solLamports)}</strong></div>
            <div className="community-stat"><span>Burns</span><strong>{data.totals.burnCount}</strong></div>
            <div className="community-stat"><span>Vaults</span><strong>{data.totals.vaultCount}</strong></div>
            <div className="community-stat"><span>Tokens</span><strong>{data.totals.targetCount}</strong></div>
          </div>
          <section className="panel community-board">
            <div className="community-board-head"><div><h2>Vaults</h2></div></div>
            <div className="community-table-wrap">
              <table className="data community-table">
                <thead><tr><th>Vault</th><th className="num">SOL burned</th><th className="num">Burns</th><th className="num">Tokens</th><th>Latest</th></tr></thead>
                <tbody>
                  {data.vaults.map((row) => (
                    <tr key={row.vault}>
                      <td>
                        <a className="community-vault-link" href={`/community/vault/${encodeURIComponent(row.vault)}`}>
                          <span className="community-avatar">V</span>
                          <span><strong>Open vault</strong><small>{shortAddress(row.vault, 6)}</small></span>
                        </a>
                      </td>
                      <td className="num">{formatSol(row.solLamports)}</td>
                      <td className="num">{row.burnCount}</td>
                      <td className="num">{row.targetCount}</td>
                      <td>{timeLabel(row.lastBurnAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function CommunityVaultDetailPage({ vault }: { vault: string }) {
  const [data, setData] = useState<VaultDetail | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/community-vaults?vault=${encodeURIComponent(vault)}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("vault unavailable");
        return response.json();
      })
      .then((value) => setData(value as VaultDetail))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, [vault]);

  return (
    <div className="community-page">
      <a className="community-back" href="/community">← Community vaults</a>
      <div className="hero-copy community-detail-hero">
        <span className="eyebrow">VAULT</span>
        <div className="community-vault-address"><code>{vault}</code><CopyButton value={vault} /></div>
      </div>
      {error ? <DetailError /> : !data ? <DetailLoading /> : (
        <>
          {data.launchMints.map((launch) => (
            <div className="community-detail-launch" key={launch}>
              <span>Funded by</span>
              <TokenIdentity mint={launch} appHref={`/community/launch/${encodeURIComponent(launch)}`} />
            </div>
          ))}
          <div className="community-stats community-stats-three">
            <div className="community-stat"><span>SOL burned</span><strong>{formatSol(data.totals.solLamports)}</strong></div>
            <div className="community-stat"><span>Burns</span><strong>{data.totals.burnCount}</strong></div>
            <div className="community-stat"><span>Tokens</span><strong>{data.totals.targetCount}</strong></div>
          </div>
          <section className="panel community-board">
            <div className="community-board-head"><div><h2>Tokens burned</h2></div></div>
            <div className="community-table-wrap">
              <table className="data community-table">
                <thead><tr><th>Token</th><th className="num">SOL burned</th><th className="num">Burns</th><th>Latest</th></tr></thead>
                <tbody>
                  {data.targets.map((row) => (
                    <tr key={row.mint}>
                      <td><TokenIdentity mint={row.mint} /></td>
                      <td className="num">{formatSol(row.solLamports)}</td>
                      <td className="num">{row.burnCount}</td>
                      <td>{timeLabel(row.lastBurnAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
