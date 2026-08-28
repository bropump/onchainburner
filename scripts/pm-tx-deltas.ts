/**
 * pm-tx-deltas: print every nonzero per-account lamport delta (and token
 * balance changes) for landed fork transactions, labelling known accounts.
 * Evidence for where each pump mode's fee slices actually go.
 *
 * Usage: ts-node scripts/pm-tx-deltas.ts <signature...>
 */
import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";

const LABELS: Record<string, string> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun program",
  MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e: "mayhem program",
  pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4: "agent-payments program",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter v6",
  "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5": "burner program",
};

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  for (const signature of process.argv.slice(2)) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      console.log(`\n=== ${signature}: NOT FOUND`);
      continue;
    }
    console.log(`\n=== ${signature}`);
    console.log(`err: ${JSON.stringify(tx.meta?.err ?? null)} fee: ${tx.meta?.fee}`);
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses as any,
    });
    console.log("-- lamport deltas:");
    for (let i = 0; i < tx.meta!.preBalances.length; i++) {
      const delta = tx.meta!.postBalances[i] - tx.meta!.preBalances[i];
      if (delta === 0) continue;
      const key = keys.get(i)!.toBase58();
      console.log(
        `  ${key.padEnd(45)} ${String(delta).padStart(13)}  ${LABELS[key] ?? ""}`
      );
    }
    console.log("-- token balance changes:");
    const pre = tx.meta!.preTokenBalances ?? [];
    const post = tx.meta!.postTokenBalances ?? [];
    const indices = new Set([
      ...pre.map((b) => b.accountIndex),
      ...post.map((b) => b.accountIndex),
    ]);
    for (const index of indices) {
      const before = pre.find((b) => b.accountIndex === index);
      const after = post.find((b) => b.accountIndex === index);
      const delta =
        BigInt(after?.uiTokenAmount.amount ?? "0") -
        BigInt(before?.uiTokenAmount.amount ?? "0");
      if (delta === 0n) continue;
      const mint = (after ?? before)!.mint;
      const owner = (after ?? before)!.owner ?? "?";
      console.log(
        `  acct#${index} mint=${mint.slice(0, 8)} owner=${owner.slice(0, 12)} delta=${delta}`
      );
    }
    console.log("-- pump/mayhem log lines:");
    for (const line of tx.meta?.logMessages ?? []) {
      if (/MAyh|invoke|failed|Instruction:/.test(line)) console.log("  " + line);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
