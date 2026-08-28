import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { BPS_TOTAL, PROGRAM } from "./constants";

export type Leg = {
  mint: PublicKey;
  bps: number;
  /**
   * KEYLESS: the leg's bound price-floor reference pool. Omitted for a leg
   * priced off the mint's own Pump bonding curve or a PumpSwap pool — those
   * bind as the zero sentinel because the program derives their identity
   * itself. Any other venue's pool must be named here, or the derived
   * address is not the vault the program will accept.
   */
  ref?: PublicKey;
};

const ZERO_REF = Buffer.alloc(32);

/**
 * KEYLESS split vault derivation, mirroring `build_split_seeds` —
 * `("burner", launch_mint, target_0 .. target_{n-1}, bps_blob,
 *   ref_0 .. ref_{n-1})` where the bps_blob is the little-endian `u16`
 * weights packed in leg order and each leg contributes one 32-byte
 * reference seed after them (the zero sentinel for Pump-venue references).
 *
 * The configuration IS the address: change any mint, weight, reference, or
 * the leg count and this derives a different vault.
 */
export function deriveSplitPda(
  launchMint: PublicKey,
  legs: Leg[]
): [PublicKey, number] {
  const bpsBlob = Buffer.alloc(2 * legs.length);
  legs.forEach((leg, index) => bpsBlob.writeUInt16LE(leg.bps, 2 * index));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("burner"),
      launchMint.toBuffer(),
      ...legs.map((leg) => leg.mint.toBuffer()),
      bpsBlob,
      ...legs.map((leg) => (leg.ref ? leg.ref.toBuffer() : ZERO_REF)),
    ],
    PROGRAM
  );
}

/**
 * The exact division `split.rs` performs: `total * bps / 10_000` computed as
 * `q*bps + floor(r*bps/10_000)`, with the last leg absorbing the remainder so
 * the legs sum to `total`.
 */
export function splitAmounts(total: bigint, bpsList: number[]): bigint[] {
  const quotient = total / BigInt(BPS_TOTAL);
  const remainder = total % BigInt(BPS_TOTAL);
  const amounts: bigint[] = [];
  let allocated = 0n;
  bpsList.forEach((bps, index) => {
    const amount =
      index + 1 === bpsList.length
        ? total - allocated
        : quotient * BigInt(bps) +
          (remainder * BigInt(bps)) / BigInt(BPS_TOTAL);
    amounts.push(amount);
    allocated += amount;
  });
  return amounts;
}

/** Serialize a leg config for a URL: `mint:bps[:ref],mint:bps[:ref]`. */
export function legsToParam(
  legs: { mint: string; bps: number; ref?: string }[]
): string {
  return legs
    .map((l) => (l.ref ? `${l.mint}:${l.bps}:${l.ref}` : `${l.mint}:${l.bps}`))
    .join(",");
}

/** Parse the URL form back. Returns null on malformed input. */
export function legsFromParam(
  value: string
): { mint: string; bps: number; ref?: string }[] | null {
  if (!value) return null;
  const legs: { mint: string; bps: number; ref?: string }[] = [];
  for (const part of value.split(",")) {
    const [mint, bpsRaw, ref] = part.split(":");
    const bps = Number(bpsRaw);
    if (!mint || !Number.isInteger(bps)) return null;
    try {
      new PublicKey(mint);
      if (ref) new PublicKey(ref);
    } catch {
      return null;
    }
    legs.push(ref ? { mint, bps, ref } : { mint, bps });
  }
  return legs.length ? legs : null;
}
