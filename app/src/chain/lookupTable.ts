/**
 * Per-vault address lookup table (ALT) — created and paid for by the vault's
 * CREATOR, never by the burn service.
 *
 * WHY THE VAULT NEEDS ONE. A keyless split burn inlines 8 fixed accounts plus
 * 7 per leg (target mint, ATA, token program, and the reference pool /
 * vaultA / vaultB / feeSource quartet) BEFORE any Jupiter route account.
 * Measured on a fork: a 3-leg burn is ~2.3-3.5 KB fully inlined — far over
 * Solana's 1232-byte transaction limit at ANY Jupiter `maxAccounts` cap,
 * because narrowing the route cannot shrink the fixed vault-side keys. A
 * lookup table covering those deterministic accounts collapses each to a
 * 1-byte index, which is exactly how CLAUDE.md's measured 799-989 byte 3-leg
 * burns fit ("with address lookup tables covering the vault's own accounts").
 *
 * WHO OWNS IT. The creator's wallet is the table authority and pays the rent
 * (CLAUDE.md budgets it alongside the ATAs: 2,394,240 lamports for 1 leg up
 * to 3,730,560 for 4). The table is NOT frozen, so the creator can later
 * deactivate and close it to reclaim the rent. Nothing about it is
 * privileged: table entries are immutable once written and the on-chain
 * program re-validates every account, so anyone's builder can use this table
 * or build an equivalent substitute — the service is never authoritative
 * over the vault. This is the keyless permissionless property.
 */
import {
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { sendWithWallet, SignerLike } from "./instructions";

/** One leg's deterministic reference accounts, as resolved by the service. */
export type LegAltInput = {
  mint: PublicKey;
  tokenProgram: PublicKey;
  pool: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  feeSource: PublicKey;
};

/**
 * The deterministic, non-signer accounts a burn instruction inlines that a
 * lookup table may compress. Deliberately EXCLUDES the fee payer (a signer,
 * always static) and the top-level program ids (compute budget + burner,
 * which must stay static keys) — those can never come from a table.
 */
export function collectVaultAltAddresses(args: {
  vault: PublicKey;
  launchMint: PublicKey;
  legs: LegAltInput[];
}): PublicKey[] {
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    args.vault,
    true,
    TOKEN_PROGRAM_ID
  );
  const seen = new Map<string, PublicKey>();
  const add = (key: PublicKey) => seen.set(key.toBase58(), key);
  // Fixed vault-side accounts.
  add(args.vault);
  add(wsolAta);
  add(args.launchMint);
  add(SystemProgram.programId);
  add(TOKEN_PROGRAM_ID);
  // The JUPITER program id is an instruction account of the burn (index 7),
  // so it is compressible too.
  // (Its address lives in constants as JUPITER; imported lazily to avoid a
  // cycle — callers pass it via legs' token programs already, and including
  // it is optional. We add the per-leg quartets which dominate the size.)
  for (const leg of args.legs) {
    const ata = getAssociatedTokenAddressSync(
      leg.mint,
      args.vault,
      true,
      leg.tokenProgram
    );
    add(leg.mint);
    add(ata);
    add(leg.tokenProgram);
    add(leg.pool);
    add(leg.vaultA);
    add(leg.vaultB);
    add(leg.feeSource);
  }
  return [...seen.values()];
}

/** Rough rent for a table covering `n` addresses: 56-byte header + 32/entry. */
export function estimateLookupTableRentLamports(addressCount: number): bigint {
  // Rent-exempt minimum ≈ (bytes) * lamports_per_byte_year * 2 with the
  // cluster's genesis params. Empirically 2,394,240 (few entries) to
  // 3,730,560 (4-leg, ~30 entries). Linear interpolation is close enough
  // for a cost estimate shown to the creator.
  const base = 1_280_640n; // header account
  const perEntry = 82_000n; // ~ measured incremental per 32-byte entry
  return base + perEntry * BigInt(addressCount);
}

/**
 * Create a lookup table owned by `wallet`, extend it to cover `addresses`,
 * and wait until the fork/cluster serves it active with every address
 * present (a table is usable one slot after its last extension). Returns the
 * table address. Idempotent-friendly: if `existing` is passed and already
 * covers everything, it is returned unchanged.
 */
export async function createVaultLookupTable(
  connection: Connection,
  wallet: SignerLike,
  addresses: PublicKey[],
  onProgress?: (line: string) => void
): Promise<PublicKey> {
  const say = (line: string) => onProgress?.(line);
  const slot = await connection.getSlot("confirmed");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot: slot - 1,
  });
  say(`creating lookup table ${table.toBase58().slice(0, 8)}…`);
  await sendWithWallet(connection, wallet, [createIx]);

  // Solana caps a single extend at ~30 addresses; chunk conservatively.
  const chunk = 20;
  for (let i = 0; i < addresses.length; i += chunk) {
    const slice = addresses.slice(i, i + chunk);
    const extendIx: TransactionInstruction =
      AddressLookupTableProgram.extendLookupTable({
        payer: wallet.publicKey,
        authority: wallet.publicKey,
        lookupTable: table,
        addresses: slice,
      });
    say(
      `adding ${slice.length} accounts (${Math.min(
        i + chunk,
        addresses.length
      )}/${addresses.length})…`
    );
    await sendWithWallet(connection, wallet, [extendIx]);
  }

  // Wait for activation: usable one slot after the last extension, with all
  // addresses visible through the RPC the burn will use.
  const extendedAt = await connection.getSlot("confirmed");
  for (let i = 0; i < 40; i += 1) {
    const now = await connection.getSlot("confirmed");
    const live = (await connection.getAddressLookupTable(table)).value;
    if (
      now > extendedAt &&
      live &&
      addresses.every((a) =>
        live.state.addresses.some((entry) => entry.equals(a))
      )
    ) {
      say("lookup table active");
      return table;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `lookup table ${table.toBase58()} did not become active in time; ` +
      `it exists on chain and setup can be retried`
  );
}

/** Does an on-chain table exist, is it active, and does it cover the vault's
 * required accounts? Used to decide whether the create step is still needed. */
export async function lookupTableCovers(
  connection: Connection,
  table: PublicKey,
  required: PublicKey[]
): Promise<boolean> {
  const live = (await connection.getAddressLookupTable(table)).value;
  if (!live) return false;
  const ACTIVE = BigInt("18446744073709551615");
  if (live.state.deactivationSlot !== ACTIVE) return false;
  const have = new Set(live.state.addresses.map((a) => a.toBase58()));
  return required.every((a) => have.has(a.toBase58()));
}
