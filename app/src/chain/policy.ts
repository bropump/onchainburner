/**
 * Vault policies. Two SELECTABLE shapes ship, and the numbers below are the
 * authoritative ones (keep prose elsewhere derived from them):
 *
 *   - classic-801010: $PUMP and NEIRO fixed at 10% each, the creator picks
 *     the remaining 80%. The original shipped policy.
 *   - duo-9010: NEIRO fixed at 10%, the creator picks the remaining 90%.
 *     Added 2026-08-27 at the owner's request (own launch token 90% +
 *     NEIRO 10%). NOTE the product consequence of choosing this shape: it
 *     has no $PUMP leg, so a creator's fees stop buying $PUMP entirely.
 *     That is a product decision, not a bytes decision — both shapes remain
 *     available so they can be compared side by side.
 *
 * Wire-size context for the 2-leg shape (measured 2026-08-27,
 * scripts/measure-2leg-size.ts): a 2-leg burn does NOT reliably fit
 * Solana's 1232-byte transaction without the per-vault lookup table —
 * uncapped Jupiter routes fit only 7/18 walks, and narrowed routes fit with
 * margins as thin as 1230/1232 — so setup still creates the table for every
 * 2+ leg vault. The burn service can usually land a 2-leg burn without one
 * by narrowing the route, but the table is what makes it reliable.
 *
 * # Why the duplicate case has to be MERGED, not rejected
 *
 * The program refuses two legs naming the same mint (6034
 * `DuplicateSplitTarget`) — verified on chain: a config of
 * NEIRO 80% / $PUMP 10% / NEIRO 10% is rejected by the burner, and would be
 * rejected identically by `validate_config` before anything is funded.
 *
 * So a creator whose pick collides with a fixed leg cannot get the full leg
 * count. What they mean is "burn MORE of it", and the config that expresses
 * that is the merged vault with the weights added together — e.g.
 * NEIRO 90% / $PUMP 10% under classic, or a single-leg NEIRO 100% vault
 * under duo-9010. Those burn normally (verified: NEIRO:44612123026 +
 * PUMP:698957004 in one transaction), so they are built rather than refused.
 *
 * Fewer legs is a different vault ADDRESS, which is correct and
 * unavoidable: the configuration is the address. The creator is choosing a
 * different vault, not a variant of the same one.
 */
import { PublicKey } from "@solana/web3.js";

export type PolicyFixedLeg = { symbol: string; mint: string; bps: number };

const PUMP_LEG: PolicyFixedLeg = {
  symbol: "$PUMP",
  mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
  bps: 1000,
};
const NEIRO_LEG: PolicyFixedLeg = {
  symbol: "NEIRO",
  mint: "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump",
  bps: 1000,
};

export type VaultPolicyId = "classic-801010";

export type VaultPolicy = {
  id: VaultPolicyId;
  /** Short selector label, e.g. "80/10/10". */
  label: string;
  /** One-line description shown next to the selector. */
  blurb: string;
  fixedLegs: readonly PolicyFixedLeg[];
  /** The creator's share when their pick is a distinct extra mint. */
  creatorBps: number;
};

export const POLICIES: readonly VaultPolicy[] = [
  {
    id: "classic-801010",
    label: "80/10/10",
    blurb: "your pick 80% + $PUMP 10% + NEIRO 10%",
    fixedLegs: [PUMP_LEG, NEIRO_LEG],
    creatorBps: 8000,
  },
  // A duo-9010 shape (creator 90% + NEIRO 10%, no $PUMP leg) was built
  // 2026-08-27 to test whether dropping to two legs avoided needing an address
  // lookup table. Measurement said no: 2 legs is ALSO unreliable without one
  // (7 of 18 uncapped routes fit, two of those at 1230 and 1232 bytes against
  // the 1232 limit), and 3 legs works fine WITH one. So the shape solved
  // nothing and was removed rather than left as a way to create a vault
  // without a $PUMP leg by accident. Re-add it only as a deliberate product
  // decision, never as a size workaround.
];

export const DEFAULT_POLICY = POLICIES[0];
export const BPS_TOTAL = 10000;

export type PolicyLeg = { mint: string; bps: number; locked: boolean; symbol?: string };

export type PolicyResult = {
  legs: PolicyLeg[];
  /** Set when the creator's pick collided with a fixed leg and was merged. */
  merged?: { symbol: string; bps: number };
  error?: string;
};

/**
 * Build the vault configuration from the creator's single choice under the
 * given policy (default: the classic 80/10/10).
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
      merged: { symbol: collision.symbol, bps: policy.creatorBps + collision.bps },
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
