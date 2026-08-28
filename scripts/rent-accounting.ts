/**
 * Measure, on the fork, exactly what a vault costs to set up and how much of
 * that is permanently locked.
 *
 * The program never creates or closes an account, so every account a burn
 * needs is created beforehand by whoever sets the vault up. Closing an SPL
 * token account requires its OWNER to sign -- the owner is the vault PDA, and
 * the program never signs a CloseAccount -- so the vault's ATAs, and the rent
 * in them, are unrecoverable by construction. This measures the real number
 * rather than reasoning about it.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveSplitPda, readPayer, readQuoteAuthority, RPC_URL, runSplitCase, solToLamports, TOKENS } from "./surfpool-split-e2e";

const rent = (bytes: number) => (128 + bytes) * 3480 * 2;
const sol = (l: number) => (l / 1e9).toFixed(6);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const qa = readQuoteAuthority();

  console.error("=== rent by account size (formula: (128 + bytes) * 3480 * 2) ===");
  for (const [label, bytes] of [["SPL token account", 165], ["0-data System account (the vault)", 0]] as const) {
    console.error(`  ${label.padEnd(36)} ${bytes}B  ${sol(rent(bytes))} SOL`);
  }
  // Token-2022 ATA real size, measured not assumed.
  const t22Ata = getAssociatedTokenAddressSync(TOKENS.PUMP, PublicKey.default, true,
    new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
  console.error(`  (Token-2022 ATA size measured live below)`);

  // The realistic product config: own launch 70 / NEIRO 15 / PUMP 15.
  const legs = [
    { label: "OWN", mint: TOKENS.FARTCOIN, bps: 7000 },
    { label: "NEIRO", mint: TOKENS.NEIRO, bps: 1500 },
    { label: "PUMP", mint: TOKENS.PUMP, bps: 1500 },
  ];
  const [vault] = deriveSplitPda(TOKENS.FARTCOIN, legs);
  const before = await connection.getBalance(payer.publicKey, "confirmed");

  const r = await runSplitCase(
    connection, payer, qa, "rent-accounting", TOKENS.FARTCOIN, legs, "0.2",
    { maxAccountsPerLeg: 0, fundExtra: solToLamports("0.05"), slippageBps: 1500 }
  );
  const after = await connection.getBalance(payer.publicKey, "confirmed");
  const vaultBal = await connection.getBalance(vault, "confirmed");

  console.error(`\n=== measured, 3-leg vault (own 70 / NEIRO 15 / PUMP 15 [Token-2022]) ===`);
  console.error(`  burn status                 ${r.status} ${r.errorCode ?? ""}`);
  console.error(`  caller total outlay         ${sol(before - after)} SOL   (includes ${sol(Number(solToLamports("0.25")))} funded INTO the vault)`);
  console.error(`  vault balance after         ${sol(vaultBal)} SOL`);
  console.error(`  => real setup cost          ${sol(before - after - Number(solToLamports("0.25")))} SOL`);
  console.error(`  accumulators created        ${JSON.stringify(r.pumpAccumulatorsCreated)}`);
  console.error(`  bonding curves migrated     ${JSON.stringify(r.bondingCurvesMigrated)}`);

  // What the vault owns, and whether it is closable.
  console.error(`\n=== accounts the vault owns (rent locked in each) ===`);
  let locked = 0;
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  for (const [label, addr] of [["WSOL ATA", wsol],
    ...legs.map((l) => [`${l.label} ATA`, null as any] as const)] as any) {
    let pk = addr;
    if (!pk) continue;
    const info = await connection.getAccountInfo(pk, "confirmed");
    if (info) { locked += info.lamports; console.error(`  ${label.padEnd(14)} ${pk.toBase58()} ${info.data.length}B ${sol(info.lamports)} SOL`); }
  }
  for (const l of legs) {
    const mi = await connection.getAccountInfo(l.mint, "confirmed");
    const ata = getAssociatedTokenAddressSync(l.mint, vault, true, mi!.owner);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (info) { locked += info.lamports; console.error(`  ${(l.label + " ATA").padEnd(14)} ${ata.toBase58()} ${info.data.length}B ${sol(info.lamports)} SOL`); }
  }
  console.error(`\n  PERMANENTLY LOCKED IN VAULT-OWNED ATAs: ${sol(locked)} SOL`);
  console.error(`  (the program has no CloseAccount path, and 6035 now forbids installing a close authority)`);
  console.log(JSON.stringify({ status: r.status, lockedLamports: locked, lockedSol: sol(locked) }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
