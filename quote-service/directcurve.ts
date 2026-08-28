/**
 * Direct Pump bonding-curve leg builder — the service-side counterpart of
 * `programs/burner/src/directcurve.rs`.
 *
 * A leg whose bound reference is the LIVE Pump bonding curve cannot be
 * routed by Jupiter at all when the mint is new (TOKEN_NOT_TRADABLE until
 * Jupiter indexes it, and never on a fork-only mint). The program already
 * has the answer: a leg carrying EMPTY route data selects the direct
 * bonding-curve buy instead of the Jupiter CPI (`split.rs`
 * `is_curve_leg = route_data.is_empty()`), and the on-chain adapter
 * validates all 18 Pump accounts itself. This module builds exactly the
 * account list that adapter accepts, in its order, with its writability.
 *
 * It is a port of the leg-0 builder in the proven fork harness
 * `prototypes/switchboard-stateless-surfpool/fable-ps-repeat-x.mjs`
 * (22/22 own-curve legs landed, 2026-08-26). Two facts from that campaign
 * are load-bearing here:
 *   - the minimum output MUST be computed in exact BigInt arithmetic (the
 *     harness's earlier float64 floors produced spurious 6021s) — this
 *     module never computes a floor at all; the caller passes the
 *     `ResolvedReference.floorFor` BigInt result through unchanged;
 *   - the deployed Pump program accepts ONLY the 18-account buy shape
 *     (16 named + `bonding_curve_v2` + one buyback vault; 16- and
 *     17-account shapes are refused Pump 6062/6074).
 *
 * Account order and writability mirror `directcurve.rs`
 * (`PUMP_BUY_WRITABLE`, buy_exact_sol_in):
 *   0 global | 1 fee_recipient(w) | 2 mint | 3 bonding_curve(w)
 *   4 assoc_bonding_curve(w) | 5 assoc_user(w) | 6 user = burn PDA (w;
 *     signer only inside the program's own CPI) | 7 system | 8 token_program
 *   9 creator_vault(w) | 10 event_authority | 11 pump program
 *  12 global_volume_accumulator | 13 user_volume_accumulator(w)
 *  14 fee_config | 15 fee_program | 16 bonding_curve_v2(w) | 17 buyback(w)
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PolicyError } from "./core";
import { AccountDataReader, PUMP_FUN_ADDRESS } from "./reference";

/** `ResolvedReference.venue` for a live bonding curve (reference.ts). */
export const DIRECT_CURVE_VENUE = "Pump curve";

const PUMP_FUN = new PublicKey(PUMP_FUN_ADDRESS);
const PUMP_FEE_PROGRAM = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
);
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

/** Same shape core.ts uses for Jupiter route accounts. Defined here (not
 * imported from core) so the two modules stay import-cycle-free. */
export type DirectCurveAccountMeta = Readonly<{
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}>;

export type DirectCurveBuildParams = Readonly<{
  /** The burn PDA — Pump's `user`; the program grants its signature there. */
  vault: PublicKey;
  targetMint: PublicKey;
  /** The mint's owning token program (Pump launches are Token-2022). */
  tokenProgram: PublicKey;
  /** The vault's target ATA — Pump's `associated_user`. */
  targetAta: PublicKey;
  /** From Pump's Global account (`fee_recipient`). Bare System wallet. */
  feeRecipient: PublicKey;
  /** From Pump's Global account (`buyback_fee_recipients[0]`). */
  buybackFeeRecipient: PublicKey;
}>;

export type DirectCurveLegBuild = Readonly<{
  accounts: readonly DirectCurveAccountMeta[];
  /**
   * Caller-funded setup that must land in a SEPARATE transaction before this
   * leg can burn. Anything Pump would otherwise create inside the buy would
   * be paid for by the burn PDA itself, which the program's exact lamport
   * conservation check (6019) correctly refuses. Empty means ready.
   */
  missingSetup: readonly string[];
}>;

function reject(code: string, message: string): never {
  throw new PolicyError(code, message);
}

function pumpPda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PUMP_FUN)[0];
}

/** Zero-data rent-exempt minimum in lamports — the pre-fund `bonding_curve_v2`
 * needs so Pump's lazy creation can never bill the vault (6019). */
export const BONDING_CURVE_V2_RENT_FLOOR = 890_880n;

export function derivePumpCurve(mint: PublicKey): PublicKey {
  return pumpPda([Buffer.from("bonding-curve"), mint.toBuffer()]);
}

export function deriveBondingCurveV2(mint: PublicKey): PublicKey {
  return pumpPda([Buffer.from("bonding-curve-v2"), mint.toBuffer()]);
}

export function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  return pumpPda([Buffer.from("user_volume_accumulator"), user.toBuffer()]);
}

function deriveCreatorVault(creator: PublicKey): PublicKey {
  return pumpPda([Buffer.from("creator-vault"), creator.toBuffer()]);
}

function derivePumpFeeConfig(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), PUMP_FUN.toBuffer()],
    PUMP_FEE_PROGRAM
  )[0];
}

/**
 * Build the exact 18-account direct-curve buy the program's adapter accepts,
 * plus the list of setup steps still missing. Reads the curve (creator,
 * liveness) and probes the two lazily-created Pump accounts.
 */
export async function buildDirectCurveBuyAccounts(
  reader: AccountDataReader,
  params: DirectCurveBuildParams
): Promise<DirectCurveLegBuild> {
  const {
    vault,
    targetMint,
    tokenProgram,
    targetAta,
    feeRecipient,
    buybackFeeRecipient,
  } = params;
  const curve = derivePumpCurve(targetMint);
  const curveAccount = await reader.getAccountData(curve);
  if (
    !curveAccount ||
    !curveAccount.owner.equals(PUMP_FUN) ||
    curveAccount.data.length < 82
  ) {
    reject(
      "REFERENCE_INVALID",
      `no live Pump bonding curve for ${targetMint.toBase58()}; a direct-curve leg needs one`
    );
  }
  if (curveAccount.data[48] === 1) {
    reject(
      "REFERENCE_INVALID",
      `Pump curve for ${targetMint.toBase58()} has graduated; the program refuses a graduated curve (6039) — this leg burns via the canonical PumpSwap pool through Jupiter instead`
    );
  }
  const creator = new PublicKey(curveAccount.data.subarray(49, 81));

  const missingSetup: string[] = [];
  const bondingCurveV2 = deriveBondingCurveV2(targetMint);
  const bondingCurveV2Account = await reader.getAccountData(bondingCurveV2);
  // MEASURED 2026-08-26 on a fork: Pump's `buy_exact_sol_in` ACCEPTS a
  // rent-pre-funded System account here and leaves it System-owned — that
  // is the exact state the 22/22 own-curve harness burns ran with
  // (fable-ps-repeat-x setupVault: `fund-bcv2` + warm buy; the warm lands
  // and does NOT assign the PDA to Pump). What setup must guarantee is that
  // the account holds at least the zero-data rent floor, so any future
  // lazy creation by Pump can never bill the vault (whose exact lamport
  // conservation, 6019, would revert the burn).
  const bondingCurveV2Ready =
    bondingCurveV2Account !== null &&
    (bondingCurveV2Account.owner.equals(PUMP_FUN) ||
      bondingCurveV2Account.lamports === undefined ||
      bondingCurveV2Account.lamports >= BONDING_CURVE_V2_RENT_FLOOR);
  if (!bondingCurveV2Ready) {
    missingSetup.push(
      `bonding_curve_v2 ${bondingCurveV2.toBase58()} is not rent-funded — send it a plain System transfer of ${BONDING_CURVE_V2_RENT_FLOOR} lamports (any party can) so Pump's lazy creation can never bill the vault`
    );
  }
  const userVolumeAccumulator = deriveUserVolumeAccumulator(vault);
  const accumulatorAccount = await reader.getAccountData(userVolumeAccumulator);
  if (!accumulatorAccount || !accumulatorAccount.owner.equals(PUMP_FUN)) {
    // `init_user_volume_accumulator` takes `user` as a plain pubkey, so any
    // third party can create the vault's accumulator (CLAUDE.md, Pump
    // venue pre-payments). The proven harness always ran with it created.
    missingSetup.push(
      `user_volume_accumulator ${userVolumeAccumulator.toBase58()} for the vault is not initialized — send Pump's init_user_volume_accumulator(payer, user=vault) first`
    );
  }

  const meta = (
    pubkey: PublicKey,
    isWritable: boolean
  ): DirectCurveAccountMeta => ({
    pubkey: pubkey.toBase58(),
    isSigner: false,
    isWritable,
  });
  const accounts: DirectCurveAccountMeta[] = [
    meta(pumpPda([Buffer.from("global")]), false),
    meta(feeRecipient, true),
    meta(targetMint, false),
    meta(curve, true),
    meta(
      getAssociatedTokenAddressSync(targetMint, curve, true, tokenProgram),
      true
    ),
    meta(targetAta, true),
    // The burn PDA. NEVER a transaction-level signer: the program grants its
    // signature at exactly this index inside its own CPI (directcurve.rs
    // PUMP_USER_INDEX), the same way the Jupiter path grants it.
    meta(vault, true),
    meta(SYSTEM_PROGRAM, false),
    meta(tokenProgram, false),
    meta(deriveCreatorVault(creator), true),
    meta(pumpPda([Buffer.from("__event_authority")]), false),
    meta(PUMP_FUN, false),
    meta(pumpPda([Buffer.from("global_volume_accumulator")]), false),
    meta(userVolumeAccumulator, true),
    meta(derivePumpFeeConfig(), false),
    meta(PUMP_FEE_PROGRAM, false),
    // Remaining accounts, forwarded writable exactly as the program's CPI
    // metas mark them (directcurve.rs: `index >= 16 -> writable`).
    meta(bondingCurveV2, true),
    meta(buybackFeeRecipient, true),
  ];
  return { accounts, missingSetup };
}

/**
 * Structural pins core.ts re-asserts on a built curve leg before splicing it
 * into the burn — the service-side mirror of what assertRoute does for a
 * Jupiter leg. The program re-validates all of it on chain
 * (`validate_pump_buy_accounts`); this exists so a service bug is refused
 * before simulation rather than diagnosed from a 6006.
 */
export function assertDirectCurveLegShape(
  accounts: readonly DirectCurveAccountMeta[],
  expected: Readonly<{
    vault: PublicKey;
    targetMint: PublicKey;
    targetAta: PublicKey;
  }>
): void {
  // 16 named + bonding_curve_v2 + at least one buyback vault; the program
  // bounds trailing accounts at 16 + 1 + 8 (PUMP_BUYBACK_RECIPIENTS).
  if (accounts.length < 18 || accounts.length > 25) {
    reject(
      "DIRECT_CURVE_SHAPE",
      `direct-curve leg has ${accounts.length} accounts; the deployed Pump buy shape is 18`
    );
  }
  if (accounts.some((account) => account.isSigner)) {
    reject(
      "DIRECT_CURVE_SHAPE",
      "no direct-curve account may demand a transaction-level signature"
    );
  }
  const vault = expected.vault.toBase58();
  if (
    accounts[2].pubkey !== expected.targetMint.toBase58() ||
    accounts[3].pubkey !== derivePumpCurve(expected.targetMint).toBase58() ||
    accounts[5].pubkey !== expected.targetAta.toBase58() ||
    accounts[6].pubkey !== vault
  ) {
    reject(
      "DIRECT_CURVE_SHAPE",
      "direct-curve leg accounts do not pin the vault, mint, curve, and target ATA"
    );
  }
  for (const [index, account] of accounts.entries()) {
    if (index !== 6 && account.pubkey === vault) {
      reject(
        "DIRECT_CURVE_SHAPE",
        `burn PDA appears at direct-curve index ${index}; only index 6 may be the vault`
      );
    }
  }
}
