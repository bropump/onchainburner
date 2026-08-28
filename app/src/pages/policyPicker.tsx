import { useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { KNOWN_TOKENS, knownSymbol } from "../chain/constants";
import {
  buildPolicyLegs,
  PolicyResult,
  VaultPolicy,
} from "../chain/policy";
import { useTokenPreview } from "../chain/tokenName";
import { useApp } from "../state/AppContext";
import { shortAddress } from "../ui";
import { LegDraft } from "./configEditor";

const PRESET_ORDER = [
  "NEIRO",
  "WIF",
  "FARTCOIN",
  "POPCAT",
  "RAY",
  "$PUMP",
  "JUP",
  "MET",
  "KET",
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
        <img
          src={image}
          alt=""
          onError={() => setFailedSrc(image)}
        />
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

  const selectedName = ownSelected
    ? ownTokenName.trim() || "Your new token"
    : preview.token?.name || "";
  const selectedSymbol = ownSelected
    ? ownTokenSymbol.trim() || "TOKEN"
    : preview.token?.symbol || knownSymbol(creatorMint) || "";

  return (
    <div className="token-picker">
      <label className="field token-search">
        <span className="name">Mint address</span>
        <input
          type="text"
          className="mono"
          value={creatorMint}
          placeholder="Paste a mint address"
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value.trim())}
        />
      </label>

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
      ) : !ownSelected && preview.loading ? (
        <div className="token-card state">Looking up token…</div>
      ) : !ownSelected && !preview.token ? (
        <div className="token-card state err">
          <span>Token not found</span>
          <code>{shortAddress(creatorMint, 6)}</code>
        </div>
      ) : deferSummary ? null : (
        <div className="token-card">
          <TokenAvatar
            label={selectedSymbol || selectedName}
            image={ownSelected ? undefined : preview.image}
            large
          />
          <span className="token-card-copy">
            <strong>{selectedName || selectedSymbol}</strong>
            {selectedSymbol && <span className="token-ticker">{selectedSymbol}</span>}
            <code title={creatorMint}>{shortAddress(creatorMint, 7)}</code>
          </span>
        </div>
      )}

      {result.error ? (
        <p className="picker-state err">{result.error}</p>
      ) : deferSummary ? null : (
        <div className="split-summary">
          <div className="split-summary-head">
            <span>Fixed split</span>
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
                leg.mint === creatorMint
                  ? selectedSymbol || selectedName || shortAddress(leg.mint)
                  : knownSymbol(leg.mint) || shortAddress(leg.mint);
              const locked = policy.fixedLegs.some(
                (fixed) => fixed.mint === leg.mint && creatorMint !== leg.mint
              );
              return (
                <span key={leg.mint}>
                  <span className={`split-dot s${index}`} />
                  <strong>{label}</strong>
                  {locked ? " locked" : " your pick"}
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
