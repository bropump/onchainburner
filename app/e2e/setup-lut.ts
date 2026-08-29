import assert from "node:assert/strict";
import { Buffer } from "buffer";
import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  measureTransaction,
  planSetupWithFeeShare,
} from "../src/chain/instructions";
import { SETUP_LOOKUP_TABLE_KEYS } from "../src/chain/setupLookupTable";

// Exact account/index shapes and data lengths from mainnet transactions
// 4tHmHajc... (validate + ATAs) and iJnGEDkd... (Pump fee share).
const setupKeys = [
  "4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ",
  "4jnveRpnJFntetTh21FXKxyc36DTyMUqxK5vuEmD5CxM",
  "AXTmzmsHm3HMeSpBTBgcamKGwHpAWyU7LCndth13tP55",
  "3eHZ1FGZCz4zJ8zbhhS7HsdjRr4D95b65qQPT2qZgasC",
  "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5",
  "Amwami3Ea6mvmpyCLsw4qWxBrNxFVcja9iAAcHSuThxx",
  "4tsYuQWbrkyANA7wqcoZH7SBpDLVZathq6uex9QTBDrb",
  "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC",
  "BmCXK8QFCHgjiqGm7peAtBbZpFPJNsp5fYP5rSRazMS8",
  "DaXhQ3pfN3J5dQnXxVU8YqW9bwA3RUVxXvq2iBjTDVt4",
  "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx",
  "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV",
  "Axv6REXfurAwU1uSN2To5FPW3ZMbFo1wxhebU7aDnkAm",
  "Aooy1NjoezvhAxrsJGoV35KCfDTxgmQ6TsSb4tUAmjys",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
].map((key) => new PublicKey(key));

const feeKeys = [
  "4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ",
  "4k2zsG9dyC7u7YLV9uBN2LQARaTXiCpt76KgKTTYYSas",
  "FyP2q4KSJ5o8ZLnJjBQRSjc3WxWQrUY2M9cU14QhrUb2",
  "GodY13incyqLQkaZAoYwiVtv2AHbzzHxfgs7ghEYYzYU",
  "FSk6wdiWeR2VdhkYc5ojYeYYoHk3oENhmHwsftcwPd9P",
  "A3Kn9qj7LjmWViizt8jRxhB7N7xbqPErks5XFUt34qRv",
  "4urMkEtigqWU5CoPrGNiCaQH5T6pWWJh5Wm9T99f3mp6",
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  "D6QxXDt6hhcCpto4HiZKkN2YQ2iZRF5R7S3caCHpUsML",
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
  "4tsYuQWbrkyANA7wqcoZH7SBpDLVZathq6uex9QTBDrb",
  "11111111111111111111111111111111",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
].map((key) => new PublicKey(key));

function instruction(
  keys: PublicKey[],
  programIndex: number,
  accountIndexes: number[],
  dataLength: number,
  writableIndexes: ReadonlySet<number>,
  payerIndex = 0
): TransactionInstruction {
  return new TransactionInstruction({
    programId: keys[programIndex],
    keys: accountIndexes.map((index) => ({
      pubkey: keys[index],
      isSigner: index === payerIndex,
      isWritable: writableIndexes.has(index),
    })),
    data: Buffer.alloc(dataLength),
  });
}

const validate = instruction(
  setupKeys,
  4,
  [5, 1, 6, 7, 2, 8, 9, 10, 11, 12, 13, 3, 14, 15, 16, 17, 15],
  33,
  new Set()
);
const atas = [
  [0, 1, 5, 19, 20, 14],
  [0, 2, 5, 7, 20, 8],
  [0, 3, 5, 13, 20, 14],
].map((indexes) =>
  instruction(setupKeys, 18, indexes, 1, new Set([0, indexes[1]]))
);
const feeWritable = new Set([0, 1, 2, 3, 4, 5, 6]);
const feeShare = [
  instruction(
    feeKeys,
    7,
    [8, 7, 0, 9, 10, 1, 11, 2, 12, 13, 7, 14, 15],
    8,
    feeWritable
  ),
  instruction(
    feeKeys,
    7,
    [8, 7, 0, 9, 10, 1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 5, 6, 0],
    46,
    feeWritable
  ),
];

const table = new AddressLookupTableAccount({
  key: new PublicKey("9gKjyMTifJryDgtjWt4CcGsWtBAhuvzTpEKXFmUgiJ3K"),
  state: {
    deactivationSlot: BigInt("18446744073709551615"),
    lastExtendedSlot: 1,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses: SETUP_LOOKUP_TABLE_KEYS,
  },
});

const payer = setupKeys[0];
assert.equal(
  measureTransaction(payer, [...feeShare, validate, ...atas]),
  1_368
);
const planned = planSetupWithFeeShare(payer, feeShare, validate, atas, [table]);
assert.equal(planned.atomic, true);
assert.equal(planned.transactions.length, 1);
assert.equal(planned.transactions[0].bytes, 1_123);
assert.ok(planned.transactions[0].bytes < 1_232);
assert.ok(planned.transactions[0].instructions.includes(validate));

assert.throws(
  () => planSetupWithFeeShare(payer, feeShare, validate, atas),
  /shared setup lookup table is required/
);

process.stdout.write(
  "setup LUT: exact mainnet fixture 1368 -> 1123 bytes; guarded no-ALT path refused\n"
);
