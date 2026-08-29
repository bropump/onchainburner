import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
} from "@solana/web3.js";

/**
 * Reusable addresses shared by every normal Pump launch setup.
 *
 * This table is only a wire-compression aid for the creator's setup
 * transaction. It is deliberately independent from the optional per-vault
 * lookup tables used by 3+ leg burns. None of these addresses is a signer,
 * and loading an address through an ALT does not change its privileges.
 *
 * The set is measured against the landed 90/10 mainnet launch at
 * 4tHmHajc... + iJnGEDkd...: it reduces the combined fee-share,
 * validate_config and ATA transaction from 1,368 to 1,123 bytes.
 */
export const SETUP_LOOKUP_TABLE_ADDRESSES = [
  "11111111111111111111111111111111", // System program (passed account)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "So11111111111111111111111111111111111111112", // WSOL mint
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", // Pump global
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", // Pump event authority
  "D6QxXDt6hhcCpto4HiZKkN2YQ2iZRF5R7S3caCHpUsML", // fee sharing global
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // Pump AMM program account
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR", // fee sharing account
] as const;

export const SETUP_LOOKUP_TABLE_KEYS = SETUP_LOOKUP_TABLE_ADDRESSES.map(
  (address) => new PublicKey(address)
);

const ACTIVE_DEACTIVATION_SLOT = BigInt("18446744073709551615");

/** Load and fully verify the configured shared setup ALT. */
export async function loadSetupLookupTable(
  connection: Connection,
  address: string | null
): Promise<AddressLookupTableAccount | null> {
  if (!address) return null;
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    throw new Error("the configured shared setup lookup table is not base58");
  }
  const table = (
    await connection.getAddressLookupTable(key, {
      commitment: "confirmed",
    })
  ).value;
  if (!table)
    throw new Error("the configured shared setup lookup table is missing");
  if (table.state.deactivationSlot !== ACTIVE_DEACTIVATION_SLOT) {
    throw new Error("the configured shared setup lookup table is inactive");
  }
  const live = new Set(table.state.addresses.map((item) => item.toBase58()));
  const missing = SETUP_LOOKUP_TABLE_ADDRESSES.filter(
    (item) => !live.has(item)
  );
  if (missing.length) {
    throw new Error(
      `the configured shared setup lookup table is incomplete (${missing.length} fixed addresses missing)`
    );
  }
  const currentSlot = await connection.getSlot("confirmed");
  if (table.state.lastExtendedSlot >= currentSlot) {
    throw new Error(
      "the configured shared setup lookup table is not active yet"
    );
  }
  return table;
}
