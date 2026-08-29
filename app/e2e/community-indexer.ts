import assert from "node:assert/strict";
import {
  aggregateVaultBurnRows,
  BURNER_PROGRAM,
  decodeBurnTransaction,
  missingTransactionSignatures,
  nextLatestSignature,
} from "../community-indexer";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) {
    out += "1";
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    out += ALPHABET[digits[index]];
  }
  return out;
}

function splitData(total: bigint, weights: readonly number[]): string {
  const bytes = new Uint8Array(20 + weights.length * 15);
  bytes.set([157, 45, 186, 225, 142, 17, 2, 105]);
  new DataView(bytes.buffer).setBigUint64(8, total, true);
  new DataView(bytes.buffer).setUint32(16, weights.length, true);
  weights.forEach((weight, index) => {
    const offset = 20 + index * 15;
    new DataView(bytes.buffer).setUint16(offset, weight, true);
    // minimum output, route-account count and route data are zero in this
    // parser fixture. They do not affect attribution.
  });
  return base58(bytes);
}

const keys = Array.from({ length: 24 }, (_, index) => `key-${index}`);
keys[2] = "vault11111111111111111111111111111111111";
keys[4] = "launch111111111111111111111111111111111";
keys[8] = "targetA111111111111111111111111111111111";
keys[15] = "targetB111111111111111111111111111111111";
keys[23] = BURNER_PROGRAM;
const accounts = Array.from({ length: 22 }, (_, index) => index);

function fixture(secondInput = 11n) {
  return {
    slot: 42,
    blockTime: 1_787_947_200,
    meta: {
      err: null,
      logMessages: [
        `Program ${BURNER_PROGRAM} invoke [1]`,
        `Program ${BURNER_PROGRAM} success`,
        `Program ${BURNER_PROGRAM} invoke [1]`,
        "Program log: 0x0, 0x0, 0x0, 0x5a, 0x64",
        `Program log: 0x0, 0x0, 0x0, 0x${secondInput.toString(16)}, 0x32`,
        `Program ${BURNER_PROGRAM} success`,
      ],
    },
    transaction: {
      message: {
        accountKeys: keys,
        instructions: [
          // A validate_config call before the burn must not shift log
          // attribution. It has no burn log of its own.
          { programIdIndex: 23, accounts: [], data: base58(Uint8Array.of(1)) },
          {
            programIdIndex: 23,
            accounts,
            data: splitData(101n, [9_000, 1_000]),
          },
        ],
      },
    },
  };
}

const rows = decodeBurnTransaction("signature", fixture());
assert.equal(rows.length, 2);
assert.deepEqual(
  rows.map((row) => ({
    mint: row.targetMint,
    bps: row.bps,
    sol: row.solLamports,
    burned: row.burnedAtoms,
  })),
  [
    { mint: keys[8], bps: 9_000, sol: "90", burned: "100" },
    { mint: keys[15], bps: 1_000, sol: "11", burned: "50" },
  ]
);

// One inconsistent log invalidates the complete call; never publish a
// partially attributed multi-leg burn.
assert.deepEqual(decodeBurnTransaction("signature", fixture(10n)), []);

// D1 integer aggregation is unsafe for large token supplies. The per-vault
// endpoint preserves the exact decimal strings even beyond signed u64.
const summary = aggregateVaultBurnRows([
  {
    signature: "sig-a",
    instruction_index: 1,
    launch_mint: keys[4],
    target_mint: keys[8],
    sol_lamports: "9000000000000000000",
    burned_atoms: "18446744073709551616",
    block_time: 10,
  },
  {
    signature: "sig-a",
    instruction_index: 1,
    launch_mint: keys[4],
    target_mint: keys[15],
    sol_lamports: "1000000000000000000",
    burned_atoms: "50",
    block_time: 10,
  },
  {
    signature: "sig-b",
    instruction_index: 0,
    launch_mint: keys[4],
    target_mint: keys[8],
    sol_lamports: "7",
    burned_atoms: "9",
    block_time: 11,
  },
]);
assert.equal(summary.solLamports, "10000000000000000007");
assert.equal(summary.burnCount, 2);
assert.equal(summary.targets[0].burnedAtoms, "18446744073709551625");
assert.equal(summary.lastBurnAt, 11);

// A transiently missing finalized transaction must abort the cron before its
// cursor advances, so the next run retries rather than undercounting forever.
assert.deepEqual(
  missingTransactionSignatures(
    ["newest", "middle", "oldest"],
    new Set(["newest", "oldest"])
  ),
  ["middle"]
);
assert.deepEqual(
  missingTransactionSignatures(["newest"], new Set(["newest"])),
  []
);

// A quiet incremental page while historical backfill is active preserves the
// real head; an old backfill signature must never replace it.
assert.equal(nextLatestSignature("head-signature", undefined), "head-signature");
assert.equal(
  nextLatestSignature("head-signature", "new-head-signature"),
  "new-head-signature"
);

console.log("community indexer checks passed");
