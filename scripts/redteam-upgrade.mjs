/**
 * Fork-only: steal the loader-v3 upgrade authority via surfnet_setAccount,
 * then Upgrade the production program ID with the local SBPFv3 ELF.
 *
 * Byte overlays of programdata do NOT reload Surfpool's loaded executable —
 * Mode B kept succeeding at ~5k CU after a verified prefix match. A real
 * Upgrade instruction is what invalidates that cache.
 *
 * Refuses non-loopback RPC.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const RPC = process.argv[2] ?? process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC)) {
  throw new Error(`refusing non-loopback RPC ${RPC}`);
}
const SO =
  process.argv[3] ??
  path.join("programs", "burner", "target", "deploy", "pinocchio_parity.so");
const PROGRAM = new PublicKey(
  process.argv[4] ??
    process.env.BURNER_PROGRAM_ID ??
    "5kTgbKKDWTcyPoEp2S5Lunz1vsSLN92CzwNis4GQhnkV"
);

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const HEADER = 45;

const c = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        process.env.PAYER_KEYPAIR ??
          path.join(os.homedir(), ".config", "solana", "id.json"),
        "utf8"
      )
    )
  )
);
const elf = fs.readFileSync(SO);
const elfSha = crypto.createHash("sha256").update(elf).digest("hex");
console.log(`upgrade ${PROGRAM.toBase58()} <- ${SO} (${elf.length} bytes sha256 ${elfSha})`);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function sendTx(tx, extraSigners = []) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(payer, ...extraSigners);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await c.confirmTransaction(sig, "confirmed");
  return sig;
}

const progInfo = await c.getAccountInfo(PROGRAM);
if (!progInfo?.executable) throw new Error("program missing or not executable");
if (progInfo.data.length < 36) throw new Error("not a loader-v3 program account");
const programdata = new PublicKey(progInfo.data.subarray(4, 36));
const pdInfo = await c.getAccountInfo(programdata);
if (!pdInfo) throw new Error(`missing programdata ${programdata.toBase58()}`);
const pd = Buffer.from(pdInfo.data);
if (pd.readUInt32LE(0) !== 3) throw new Error(`not ProgramData disc=${pd.readUInt32LE(0)}`);
console.log(`programdata ${programdata.toBase58()} ${pd.length} bytes slot=${pd.readBigUInt64LE(4)}`);

// Steal upgrade authority so the subsequent Upgrade is signed by us.
const stolen = Buffer.from(pd);
stolen.writeUInt8(1, 12); // Option::Some
stolen.set(payer.publicKey.toBytes(), 13);
await rpc("surfnet_setAccount", [
  programdata.toBase58(),
  {
    lamports: pdInfo.lamports,
    owner: LOADER.toBase58(),
    executable: false,
    data: stolen.toString("hex"),
    rentEpoch: 0,
  },
]);
console.log(`authority stolen -> ${payer.publicKey.toBase58()}`);

const bufKp = Keypair.generate();
const bufferSpace = 37 + elf.length;
const init = new Transaction();
init.add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: bufKp.publicKey,
    space: bufferSpace,
    lamports: await c.getMinimumBalanceForRentExemption(bufferSpace),
    programId: LOADER,
  }),
  new TransactionInstruction({
    keys: [
      { pubkey: bufKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
    ],
    programId: LOADER,
    data: Buffer.from([0, 0, 0, 0]), // InitializeBuffer
  })
);
await sendTx(init, [bufKp]);

const CHUNK = 800;
for (let off = 0; off < elf.length; off += CHUNK) {
  const bytes = elf.subarray(off, Math.min(off + CHUNK, elf.length));
  const d = Buffer.alloc(16 + bytes.length);
  d.writeUInt32LE(1, 0); // Write
  d.writeUInt32LE(off, 4);
  d.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(d, 16);
  const wtx = new Transaction();
  wtx.add(
    new TransactionInstruction({
      keys: [
        { pubkey: bufKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      programId: LOADER,
      data: d,
    })
  );
  await sendTx(wtx);
}
console.log("buffer written");

const up = new Transaction();
up.add(
  new TransactionInstruction({
    keys: [
      { pubkey: programdata, isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: true },
      { pubkey: bufKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    programId: LOADER,
    data: Buffer.from([3, 0, 0, 0]), // Upgrade
  })
);
await sendTx(up);
console.log("Upgrade landed");

const after = await c.getAccountInfo(programdata);
const afterElf = Buffer.from(after.data.subarray(HEADER, HEADER + elf.length));
const afterSha = crypto.createHash("sha256").update(afterElf).digest("hex");
if (afterSha !== elfSha) {
  throw new Error(`post-upgrade ELF mismatch local=${elfSha} onchain=${afterSha}`);
}
const tail = Buffer.from(after.data.subarray(HEADER + elf.length));
if (tail.some((b) => b !== 0)) {
  throw new Error("post-upgrade ELF tail is not zero");
}
console.log(
  `verified prefix sha256 ${afterSha} (${elf.length} of ${after.data.length - HEADER} bytes, tail zero)`
);
