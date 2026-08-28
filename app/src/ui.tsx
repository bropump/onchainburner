import { useState } from "react";
import type { CheckResult } from "./chain/admission";
import { knownSymbol } from "./chain/constants";
import { cachedTokenName, type TokenName } from "./chain/tokenName";

export type TokenNameMap = ReadonlyMap<string, TokenName>;

// ---- formatting -----------------------------------------------------------

export function lamportsToSol(lamports: bigint | number | string): string {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole.toLocaleString()}.${frac}`;
}

export function formatRaw(amount: bigint | string, decimals: number | null): string {
  const value = BigInt(amount);
  if (decimals === null || decimals === 0) return value.toLocaleString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString();
}

export function shortAddress(address: string, chars = 4): string {
  return address.length <= chars * 2 + 1
    ? address
    : `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function legLabel(mint: string, names?: TokenNameMap): string {
  // Curated symbol first, then the coin's own on-chain metadata (a fresh Pump
  // launch has no entry in any registry but does carry its name in the mint),
  // then the truncated address as a last resort.
  const known = knownSymbol(mint);
  if (known) return known;
  const onChain = names?.get(mint) ?? cachedTokenName(mint);
  if (onChain) {
    const { symbol, name } = onChain;
    if (symbol && name && symbol !== name) return `${symbol} — ${name}`;
    return symbol || name;
  }
  return shortAddress(mint);
}

// ---- primitives -----------------------------------------------------------

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="iconbtn"
      title="Copy to clipboard"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export function AddressBlock({
  value,
  hero,
  label,
}: {
  value: string;
  hero?: boolean;
  label?: string;
}) {
  return (
    <div>
      {label && (
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-2)", marginBottom: 5 }}>
          {label}
        </div>
      )}
      <div className={`addr${hero ? " hero" : ""}`}>
        <code>{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

/** Plain confirmation copy for irreversible setup actions. Still used by the
 *  "existing token" flow; removed from the launch page at the owner's request
 *  2026-08-28. */
export function PermanenceConfirmation({
  vault,
  legs,
}: {
  vault: string;
  legs: { mint: string; bps: number }[];
}) {
  return (
    <p className="permanence-copy">
      <strong>Permanent after signing.</strong> The vault is{" "}
      <code>{vault}</code>. Exact legs: {legs.map((leg, index) => (
        <span key={`${leg.mint}-${index}`}>
          {index > 0 && "; "}
          <code>{leg.mint}</code> at {(leg.bps / 100).toFixed(2)}% ({leg.bps}{" "}
          bps)
        </span>
      ))}. There is no withdrawal or config-change instruction; changing a
      mint or weight derives a different vault address. A Pump fee share can
      be committed only once, and Pump refuses re-pointing with 0x1779.
    </p>
  );
}

export function CheckRows({ checks }: { checks: CheckResult[] }) {
  if (!checks.length) return null;
  return (
    <div className="checklist">
      {checks.map((check, i) => (
        <div key={`${check.id}-${i}`} className={`checkrow ${check.status}`}>
          <span className="state">
            {check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : check.status === "warn" ? "WARN" : "INFO"}
          </span>
          <span className="label">{check.label}</span>
          {check.code !== undefined && <span className="code">{check.code}</span>}
          <span className="detail">{check.detail}</span>
        </div>
      ))}
    </div>
  );
}

const SEGMENT_CLASSES = ["w0", "w1", "w2", "w3"];

export function WeightBar({ legs }: { legs: { mint: string; bps: number }[] }) {
  const total = legs.reduce((sum, leg) => sum + Math.max(0, leg.bps || 0), 0);
  const overflow = total > 10_000;
  return (
    <div>
      <div className="weightbar" role="img" aria-label="weight allocation">
        {legs.map((leg, i) => (
          <div
            key={i}
            className={`seg ${SEGMENT_CLASSES[i % 4]}`}
            style={{ width: `${Math.min(100, (Math.max(0, leg.bps || 0) / 100))}%` }}
            title={`${legLabel(leg.mint)} ${leg.bps} bps`}
          />
        ))}
        {total < 10_000 && (
          <div className="seg rest" style={{ width: `${(10_000 - total) / 100}%` }} />
        )}
      </div>
      <div className="legendrow">
        {legs.map((leg, i) => (
          <span key={i}>
            <span className={`swatch`} style={{ background: `var(--seg-${i}, ${["#c2571f", "#3f6f8f", "#6f8f4a", "#8f6f9f"][i % 4]})` }} />
            {legLabel(leg.mint)} <span className="mono">{leg.bps ? (leg.bps / 100).toFixed(2) : "0"}%</span>
          </span>
        ))}
        <span className="mono" style={{ marginLeft: "auto", color: overflow ? "var(--err)" : total === 10_000 ? "var(--ok)" : "var(--warn)" }}>
          {total.toLocaleString()} / 10,000 bps
        </span>
      </div>
    </div>
  );
}

export type StepState = {
  label: string;
  status: "idle" | "running" | "done" | "failed";
  signature?: string;
  detail?: string;
};

export function TxSteps({ steps }: { steps: StepState[] }) {
  return (
    <div className="steps">
      {steps.map((step, i) => (
        <div key={i} className={`step ${step.status}`}>
          <span className="marker">
            {step.status === "done" ? "DONE" : step.status === "failed" ? "FAILED" : step.status === "running" ? "…" : `${i + 1}`}
          </span>
          <div className="body">
            <div className="title">
              {step.label} {step.status === "running" && <span className="spin" />}
            </div>
            {step.signature && <div className="sig">{step.signature}</div>}
            {step.detail && (
              <div className="sig" style={{ color: step.status === "failed" ? "var(--err)" : undefined }}>
                {step.detail}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
