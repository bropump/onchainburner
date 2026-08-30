import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { KNOWN_TOKENS, knownSymbol } from "../chain/constants";
import {
  buildPolicyLegs,
  isPlatformFeeLeg,
  PolicyResult,
  VaultPolicy,
} from "../chain/policy";
import {
  searchServiceTokens,
  type TokenSearchResult,
  useTokenPreview,
} from "../chain/tokenName";
import { useApp } from "../state/AppContext";
import { shortAddress } from "../ui";
import { LegDraft } from "./configEditor";

const PRESET_ORDER = [
  "$COOK",
  "NEIRO",
  "WIF",
  "FARTCOIN",
  "POPCAT",
  "RAY",
  "$PUMP",
  "JUP",
  "MET",
  "KET",
  "CHILLHOUSE",
  "ANSEM",
  "STNK",
] as const;

const PRESETS = PRESET_ORDER.map((symbol) =>
  KNOWN_TOKENS.find((token) => token.symbol === symbol)
).filter((token): token is (typeof KNOWN_TOKENS)[number] => !!token);

export function policyToLegs(result: PolicyResult): LegDraft[] {
  return result.legs.map((leg) => ({ mint: leg.mint, bps: leg.bps }));
}

function initials(value: string): string {
  return value.replace(/^\$/, "").slice(0, 2).toUpperCase() || "?";
}

function TokenAvatar({
  label,
  image,
  large = false,
}: {
  label: string;
  image?: string;
  large?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showLogo = !!image && image !== failedSrc;
  return (
    <span className={`token-avatar${large ? " large" : ""}`} aria-hidden="true">
      {showLogo ? (
        <img src={image} alt="" onError={() => setFailedSrc(image)} />
      ) : (
        initials(label)
      )}
    </span>
  );
}

function PresetChip({
  mint,
  symbol,
  active,
  disabled,
  onPick,
}: {
  mint: string;
  symbol: string;
  active: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  const { connection } = useApp();
  const { image } = useTokenPreview(connection, mint);
  return (
    <button
      type="button"
      className={`token-preset${active ? " active" : ""}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPick}
    >
      <TokenAvatar label={symbol} image={image} />
      {symbol}
    </button>
  );
}

export function PolicyPicker({
  policy,
  creatorMint,
  onChange,
  ownTokenMint,
  ownTokenName = "",
  ownTokenSymbol = "",
  deferSummary = false,
  disabled,
}: {
  policy: VaultPolicy;
  onPolicyChange: (policy: VaultPolicy) => void;
  creatorMint: string;
  onChange: (mint: string) => void;
  ownTokenMint?: string;
  ownTokenName?: string;
  ownTokenSymbol?: string;
  /** The launch page combines this summary with the permanent pool verdict. */
  deferSummary?: boolean;
  disabled?: boolean;
}) {
  const { connection } = useApp();
  const [searchInput, setSearchInput] = useState(creatorMint);
  const [searchState, setSearchState] = useState<{
    query: string;
    loading: boolean;
    results: TokenSearchResult[];
  }>({ query: "", loading: false, results: [] });
  const result = buildPolicyLegs(creatorMint, policy);
  const ownSelected = !!ownTokenMint && creatorMint === ownTokenMint;
  const parsedMint = useMemo(() => {
    if (!creatorMint || ownSelected) return null;
    try {
      return new PublicKey(creatorMint).toBase58();
    } catch {
      return null;
    }
  }, [creatorMint, ownSelected]);
  const preview = useTokenPreview(connection, parsedMint);

  useEffect(() => {
    setSearchInput(creatorMint);
  }, [creatorMint]);

  const normalizedSearch = searchInput.trim().replace(/\s+/g, " ");
  const inputMint = useMemo(() => {
    try {
      return normalizedSearch
        ? new PublicKey(normalizedSearch).toBase58()
        : null;
    } catch {
      return null;
    }
  }, [normalizedSearch]);
  const editingSearch = normalizedSearch !== creatorMint;
  const looksLikeCa = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalizedSearch);

  useEffect(() => {
    if (
      disabled ||
      !editingSearch ||
      inputMint ||
      looksLikeCa ||
      normalizedSearch.length < 2
    ) {
      setSearchState({ query: "", loading: false, results: [] });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchState({ query: normalizedSearch, loading: true, results: [] });
      void searchServiceTokens(normalizedSearch, controller.signal).then(
        (results) => {
          if (!controller.signal.aborted) {
            setSearchState({
              query: normalizedSearch,
              loading: false,
              results,
            });
          }
        }
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, editingSearch, inputMint, looksLikeCa, normalizedSearch]);

  const updateSearch = (value: string) => {
    setSearchInput(value);
    const trimmed = value.trim();
    if (!trimmed) {
      onChange("");
      return;
    }
    try {
      // A pasted CA stays on the fast path: select it immediately without
      // waiting for Jupiter search or token metadata.
      onChange(new PublicKey(trimmed).toBase58());
    } catch {
      // A name/ticker is only a search query. Keep the current immutable
      // policy selection until the user chooses a concrete mint below.
    }
  };

  const pickSearchResult = (mint: string) => {
    setSearchInput(mint);
    setSearchState({ query: "", loading: false, results: [] });
    onChange(mint);
  };

  const selectedName = ownSelected
    ? ownTokenName.trim() || "Your new token"
    : preview.token?.name || "";
  const selectedSymbol = ownSelected
    ? ownTokenSymbol.trim() || "TOKEN"
    : preview.token?.symbol || knownSymbol(creatorMint) || "";

  return (
    <div className="token-picker">
      <label className="field token-search">
        <span className="name">Find the token to burn</span>
        <input
          type="text"
          className="token-search-input"
          value={searchInput}
          placeholder="Search name or ticker, or paste CA"
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => updateSearch(event.target.value)}
        />
        <span className="token-search-help">
          Search by token name or ticker, or paste its contract address (CA).
        </span>
      </label>

      {editingSearch && looksLikeCa && !inputMint ? (
        <p className="picker-state err">
          That CA is not a valid Solana mint address.
        </p>
      ) : editingSearch && searchState.loading ? (
        <div className="token-search-status">Searching tokens…</div>
      ) : editingSearch &&
        searchState.query === normalizedSearch &&
        searchState.results.length > 0 ? (
        <div className="token-search-results" role="listbox">
          {searchState.results.map((token) => (
            <button
              key={token.mint}
              type="button"
              className="token-search-result"
              role="option"
              aria-selected={creatorMint === token.mint}
              onClick={() => pickSearchResult(token.mint)}
            >
              <TokenAvatar
                label={token.symbol || token.name}
                image={token.image}
              />
              <span className="token-search-result-copy">
                <strong>{token.name || token.symbol}</strong>
                {token.symbol && <span>{token.symbol}</span>}
                <code title={token.mint}>{shortAddress(token.mint, 7)}</code>
              </span>
              <span className="token-search-select">Select</span>
            </button>
          ))}
        </div>
      ) : editingSearch &&
        normalizedSearch.length >= 2 &&
        searchState.query === normalizedSearch ? (
        <div className="token-search-status">
          No matches. You can still paste the token CA.
        </div>
      ) : null}

      <div className="preset-list" aria-label="Common burn targets">
        {ownTokenMint && (
          <button
            type="button"
            className={`token-preset own${ownSelected ? " active" : ""}`}
            aria-pressed={ownSelected}
            disabled={disabled}
            onClick={() => onChange(ownTokenMint)}
          >
            <TokenAvatar label={ownTokenSymbol || "NEW"} />
            My new token — default
          </button>
        )}
        {PRESETS.map((token) => (
          <PresetChip
            key={token.mint}
            mint={token.mint}
            symbol={token.symbol}
            active={creatorMint === token.mint}
            disabled={disabled}
            onPick={() => onChange(token.mint)}
          />
        ))}
      </div>

      {!creatorMint ? null : !ownSelected && !parsedMint ? (
        <p className="picker-state err">Not a valid mint address.</p>
      ) : deferSummary ? null : !ownSelected && preview.loading ? (
        <div className="token-card state">Looking up token…</div>
      ) : !ownSelected && !preview.token ? (
        <div className="token-card state err">
          <span>Token not found</span>
          <code>{shortAddress(creatorMint, 6)}</code>
        </div>
      ) : (
        <div className="token-card">
          <TokenAvatar
            label={selectedSymbol || selectedName}
            image={ownSelected ? undefined : preview.image}
            large
          />
          <span className="token-card-copy">
            <strong>{selectedName || selectedSymbol}</strong>
            {selectedSymbol && (
              <span className="token-ticker">{selectedSymbol}</span>
            )}
            <code title={creatorMint}>{shortAddress(creatorMint, 7)}</code>
          </span>
        </div>
      )}

      {result.error ? (
        <p className="picker-state err">{result.error}</p>
      ) : deferSummary ? null : (
        <div className="split-summary">
          <div className="split-summary-head">
            <span>Burn allocation</span>
            <span className="mono">
              {result.legs.map((leg) => leg.bps / 100).join(" / ")}
            </span>
          </div>
          <div className="split-bar" aria-label="Fixed burn split">
            {result.legs.map((leg, index) => (
              <span
                key={leg.mint}
                className={`split-segment s${index}`}
                style={{ width: `${leg.bps / 100}%` }}
              />
            ))}
          </div>
          <div className="split-legend">
            {result.legs.map((leg, index) => {
              const label =
                isPlatformFeeLeg(leg.mint, leg.bps) && leg.mint !== creatorMint
                  ? "Platform fees"
                  : leg.mint === creatorMint
                  ? selectedSymbol || selectedName || shortAddress(leg.mint)
                  : knownSymbol(leg.mint) || shortAddress(leg.mint);
              const locked = policy.fixedLegs.some(
                (fixed) => fixed.mint === leg.mint && creatorMint !== leg.mint
              );
              return (
                <span key={leg.mint}>
                  <span className={`split-dot s${index}`} />
                  <strong>{label}</strong>
                  {!locked && " burn"}
                  <span className="mono">{leg.bps / 100}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
