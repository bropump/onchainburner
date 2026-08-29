/**
 * The shipped vault policy is 90% to the creator's selected token and 10% to
 * NEIRO. The selected token defaults to the token being launched.
 *
 * Two-leg burns are deliberately created without a per-vault lookup table.
 * The quote service's measured maxAccounts fitting ladder keeps the routes
 * inside Solana's transaction limits. Lookup-table support remains available
 * as a fallback and for larger custom vaults; it is not part of this policy.
 *
 * # Why the duplicate case has to be MERGED, not rejected
 *
 * The program refuses two legs naming the same mint (6034
 * `DuplicateSplitTarget`) — verified on chain: a config of
 * NEIRO 90% / NEIRO 10% is rejected by the burner, and would be rejected
 * identically by `validate_config` before anything is funded.
 *
 * So a creator whose pick collides with a fixed leg cannot get the full leg
 * count. What they mean is "burn MORE of it", and the config that expresses
 * that is the merged single-leg NEIRO 100% vault.
 *
 * Fewer legs is a different vault ADDRESS, which is correct and
 * unavoidable: the configuration is the address. The creator is choosing a
 * different vault, not a variant of the same one.
 */
import { PublicKey } from "@solana/web3.js";

export type PolicyFixedLeg = { symbol: string; mint: string; bps: number };

const NEIRO_LEG: PolicyFixedLeg = {
  symbol: "NEIRO",
  mint: "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump",
  bps: 1000,
};

export type VaultPolicyId = "duo-9010";

export type VaultPolicy = {
  id: VaultPolicyId;
  /** Short selector label, e.g. "90/10". */
  label: string;
  /** One-line description shown next to the selector. */
  blurb: string;
  fixedLegs: readonly PolicyFixedLeg[];
  /** The creator's share when their pick is a distinct extra mint. */
  creatorBps: number;
};

export const POLICIES: readonly VaultPolicy[] = [
  {
    id: "duo-9010",
    label: "90/10",
    blurb: "your pick 90% + NEIRO 10%",
    fixedLegs: [NEIRO_LEG],
    creatorBps: 9000,
  },
];

export const DEFAULT_POLICY = POLICIES[0];
export const BPS_TOTAL = 10000;

export type PolicyLeg = {
  mint: string;
  bps: number;
  locked: boolean;
  symbol?: string;
};

export type PolicyResult = {
  legs: PolicyLeg[];
  /** Set when the creator's pick collided with a fixed leg and was merged. */
  merged?: { symbol: string; bps: number };
  error?: string;
};

/**
 * Build the vault configuration from the creator's single choice under the
 * given policy (default: 90/10).
 *
 * Returns legs in the order the vault's `bps_blob` seed commits to, so the
 * derived address matches what the burn will rebuild.
 */
export function buildPolicyLegs(
  creatorMint: string,
  policy: VaultPolicy = DEFAULT_POLICY
): PolicyResult {
  const trimmed = creatorMint.trim();
  if (!trimmed) {
    return {
      legs: policy.fixedLegs.map((l) => ({
        mint: l.mint,
        bps: l.bps,
        locked: true,
        symbol: l.symbol,
      })),
      error: `choose a token for the remaining ${policy.creatorBps / 100}%`,
    };
  }
  try {
    new PublicKey(trimmed);
  } catch {
    return { legs: [], error: "not a valid mint address" };
  }

  const collision = policy.fixedLegs.find((l) => l.mint === trimmed);
  if (collision) {
    // Merge rather than emit a duplicate the program would reject with 6034.
    const others = policy.fixedLegs.filter((l) => l.mint !== trimmed);
    return {
      legs: [
        {
          mint: collision.mint,
          bps: policy.creatorBps + collision.bps,
          locked: false,
          symbol: collision.symbol,
        },
        ...others.map((l) => ({
          mint: l.mint,
          bps: l.bps,
          locked: true,
          symbol: l.symbol,
        })),
      ],
      merged: {
        symbol: collision.symbol,
        bps: policy.creatorBps + collision.bps,
      },
    };
  }

  return {
    legs: [
      { mint: trimmed, bps: policy.creatorBps, locked: false },
      ...policy.fixedLegs.map((l) => ({
        mint: l.mint,
        bps: l.bps,
        locked: true,
        symbol: l.symbol,
      })),
    ],
  };
}
