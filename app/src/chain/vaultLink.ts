import { PublicKey } from "@solana/web3.js";
import { deriveSplitPda, legsToParam } from "./derive";

export type IndexedVaultConfig = Readonly<{
  launchMint: string;
  vault: string;
  legs: readonly Readonly<{
    mint: string;
    bps: number;
    referencePool: string;
  }>[];
}>;

/**
 * Rebuild the canonical interactive vault URL from a finalized burn.
 *
 * Pump references use the zero seed even though the transaction carries its
 * live curve/pool account. Other venues seed the literal reference address.
 * Trying both forms and matching the indexed vault PDA avoids trusting a
 * mutable off-chain venue label and proves that the generated URL is exact.
 */
export function vaultHref(
  config: IndexedVaultConfig | null | undefined,
  label?: string | null
): string | undefined {
  if (!config || config.legs.length < 1 || config.legs.length > 4) {
    return undefined;
  }
  try {
    const launch = new PublicKey(config.launchMint);
    const expectedVault = new PublicKey(config.vault).toBase58();
    const variants = 1 << config.legs.length;
    for (let mask = 0; mask < variants; mask += 1) {
      const legs = config.legs.map((leg, index) => ({
        mint: leg.mint,
        bps: leg.bps,
        ...(leg.referencePool && (mask & (1 << index)) !== 0
          ? { ref: leg.referencePool }
          : {}),
      }));
      const [candidate] = deriveSplitPda(
        launch,
        legs.map((leg) => ({
          mint: new PublicKey(leg.mint),
          bps: leg.bps,
          ref: leg.ref ? new PublicKey(leg.ref) : undefined,
        }))
      );
      if (candidate.toBase58() !== expectedVault) continue;

      const params = new URLSearchParams({
        launch: config.launchMint,
        legs: legsToParam(legs),
      });
      const cleanLabel = label?.replace(/^\$/, "").trim();
      if (cleanLabel) params.set("label", cleanLabel);
      return `/vault?${params.toString()}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
