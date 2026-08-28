/**
 * pm-plainwallet-buy: land the identical Jupiter v2 raw-curve route with a
 * PLAIN WALLET as taker and print every account's lamport delta, so a pump
 * launch mode's extra charges/credits are identified by address and amount.
 *
 * Standalone pm- replacement for the retired diag-plainwallet-v2.ts (same
 * measurement), used here to characterize mayhem/cashback fee arithmetic.
 *
 * Usage: ts-node scripts/pm-plainwallet-buy.ts <mint> [lamports]
 * Env: PRE_ACCUM=0 skips accumulator init; FLIP=<offset> clears a route byte.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  fetchJson, initUserVolumeAccumulatorIx, readPayer, RPC_URL, sendInstructions,
} from "./surfpool-split-e2e";

const JUPITER_API = process.env.JUPITER_API_URL ?? "https://api.jup.ag/swap/v2";
const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const funder = readPayer();
  const wallet = Keypair.generate();
  const mint = new PublicKey(process.argv[2]);
  const amount = BigInt(process.argv[3] ?? "100000000");
  const preAccumulators = process.env.PRE_ACCUM !== "0";

  await sendInstructions(connection, funder, "fund-wallet", [
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: wallet.publicKey, lamports: 1_000_000_000 }),
  ]);

  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  const tokenProgram = mintInfo!.owner;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, true, TOKEN_PROGRAM_ID);
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, true, tokenProgram);
  const setup: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, mint, tokenProgram),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: Number(amount) }),
    createSyncNativeInstruction(wsolAta),
  ];
  if (preAccumulators) {
    setup.push(initUserVolumeAccumulatorIx(PUMP_FUN, wallet.publicKey, wallet.publicKey));
  }
  await sendInstructions(connection, wallet as any, "wallet-setup", setup);

  const url = new URL(`${JUPITER_API}/build`);
  url.searchParams.set("inputMint", NATIVE_MINT.toBase58());
  url.searchParams.set("outputMint", mint.toBase58());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("taker", wallet.publicKey.toBase58());
  url.searchParams.set("wrapAndUnwrapSol", "false");
  url.searchParams.set("destinationTokenAccount", ata.toBase58());
  url.searchParams.set("slippageBps", process.env.FORK_SLIPPAGE_BPS ?? "1500");
  url.searchParams.set("dexes", process.env.DEXES ?? "Pump.fun");
  const swap = await fetchJson<any>(url.toString(), undefined, true);
  if (swap.error) { console.log("BUILD ERROR:", swap.error); return; }
  const data = Buffer.from(swap.swapInstruction.data, "base64");
  console.log("route data:", data.toString("hex"));
  console.log("route:", data.subarray(0, 8).toString("hex"),
    (swap.routePlan ?? []).map((h: any) => h.swapInfo?.label).join(">"));

  if (process.env.FLIP) {
    const at = Number(process.env.FLIP);
    console.log(`flipping data[${at}] ${data[at]} -> ${process.env.FLIP_TO ?? 0}`);
    data[at] = Number(process.env.FLIP_TO ?? 0);
  }
  const ix = new TransactionInstruction({
    programId: new PublicKey(swap.swapInstruction.programId),
    keys: swap.swapInstruction.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable,
    })),
    data,
  });
  const tables = Object.entries(swap.addressesByLookupTableAddress ?? {}).map(([key, addresses]: any) => ({
    key: new PublicKey(key),
    state: {
      deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0, addresses: addresses.map((x: string) => new PublicKey(x)),
    },
  })) as any[];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: wallet.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  const landed = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  console.log("sig:", sig);
  console.log("err:", JSON.stringify(landed?.meta?.err ?? null), "fee:", landed?.meta?.fee);
  const keys = landed!.transaction.message.getAccountKeys({
    accountKeysFromLookups: landed!.meta!.loadedAddresses as any,
  });
  console.log("\naccount lamport deltas (nonzero):");
  for (let i = 0; i < landed!.meta!.preBalances.length; i++) {
    const d = landed!.meta!.postBalances[i] - landed!.meta!.preBalances[i];
    if (d === 0) continue;
    const k = keys.get(i)!.toBase58();
    const tag =
      k === wallet.publicKey.toBase58() ? "  <= WALLET (taker)" :
      k === wsolAta.toBase58() ? "  <= wallet WSOL ata" :
      k === ata.toBase58() ? "  <= wallet target ata" : "";
    console.log(`  ${k.padEnd(45)} ${String(d).padStart(12)}${tag}`);
  }
  console.log("\nwallet delta ex-fee:", landed!.meta!.postBalances[0] - landed!.meta!.preBalances[0] + landed!.meta!.fee);
  console.log("\ninstruction log lines:");
  for (const l of landed?.meta?.logMessages ?? []) {
    if (/Instruction:|failed/.test(l)) console.log(l);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
