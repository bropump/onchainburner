/**
 * Red-team helper: deploy an SBPFv3 ELF to a local fork as a loader-v3
 * (upgradeable) program, bypassing the solana-cli's client-side ELF parser.
 *
 * Wire encoding per solana-loader-v3-interface: bincode enum tag = u32,
 * Vec<u8> length = u64, usize fields = u64, Option = u8 tag; buffer
 * metadata = 37 bytes, programdata metadata = 45 bytes, program = 36. ProgramData is created by
 * DeployWithMaxDataLen itself; only the buffer and program accounts are
 * created via SystemProgram::create_account.
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

const RPC = process.argv[2] ?? process.env.RPC ?? "http://127.0.0.1:9900";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(RPC)) {
  throw new Error(`refusing non-loopback RPC ${RPC}`);
}
const SO = process.argv[3] ?? "programs/burner/target/deploy/pinocchio_parity.so";
const KEYDIR = process.env.REDTEAM_KEYDIR ?? `${process.cwd()}/.ps-run/redteam-keys`;
fs.mkdirSync(KEYDIR, { recursive: true });
const OUT = `${KEYDIR}/redteam-prog-id.txt`;

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const c = new Connection(RPC, "confirmed");
const payerPath =
  process.env.PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(payerPath, "utf8")))
);

let prog;
const progKeyFile = `${KEYDIR}/rt-program-keypair.json`;
if (fs.existsSync(progKeyFile)) {
  prog = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(progKeyFile))));
} else {
  prog = Keypair.generate();
  fs.writeFileSync(progKeyFile, JSON.stringify(Array.from(prog.secretKey)));
}
const existing = await c.getAccountInfo(prog.publicKey);
if (existing) {
  console.log(`program already deployed at ${prog.publicKey.toBase58()}`);
  fs.writeFileSync(OUT, prog.publicKey.toBase58());
  process.exit(0);
}

const so = fs.readFileSync(SO);
console.log(`deploying ${so.length} bytes -> ${prog.publicKey.toBase58()} on ${RPC}`);

async function sendTx(tx, extraSigners = []) {
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.sign(payer, ...extraSigners);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await c.confirmTransaction(sig, "confirmed");
  return sig;
}

const bufKp = Keypair.generate();
const bufferSpace = 37 + so.length;
const programSpace = 36;
const maxDataLen = so.length;

// 1. create + initialize the buffer
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
    data: Buffer.from([0, 0, 0, 0]), // InitializeBuffer (u32 tag)
  })
);
await sendTx(init, [bufKp]);

// 2. write chunks: bincode Write { offset: u32, bytes: Vec<u8> (u64 len) }
const CHUNK = 800;
for (let off = 0; off < so.length; off += CHUNK) {
  const bytes = so.subarray(off, Math.min(off + CHUNK, so.length));
  const d = Buffer.alloc(16 + bytes.length);
  d.writeUInt32LE(1, 0); // Write (u32 tag)
  d.writeUInt32LE(off, 4); // offset
  d.writeBigUInt64LE(BigInt(bytes.length), 8); // Vec<u8> length (u64 in bincode)
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

// 3. create the program account, then DeployWithMaxDataLen creates programdata
// at the loader's canonical PDA of the program address.
const programdata = PublicKey.findProgramAddressSync([prog.publicKey.toBytes()], LOADER)[0];
const dep = new Transaction();
dep.add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: prog.publicKey,
    space: programSpace,
    lamports: await c.getMinimumBalanceForRentExemption(programSpace),
    programId: LOADER,
  }),
  new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: programdata, isSigner: false, isWritable: true },
      { pubkey: prog.publicKey, isSigner: false, isWritable: true },
      { pubkey: bufKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    programId: LOADER,
    data: (() => {
      const d = Buffer.alloc(12);
      d.writeUInt32LE(2, 0); // DeployWithMaxDataLen (u32 tag)
      d.writeBigUInt64LE(BigInt(maxDataLen), 4); // usize field = u64 in bincode
      return d;
    })(),
  })
);
await sendTx(dep, [prog]);

const info = await c.getAccountInfo(prog.publicKey);
if (!info) throw new Error("deploy failed: program account missing");
const pdInfo = await c.getAccountInfo(programdata);
console.log(
  `DEPLOYED ${prog.publicKey.toBase58()} (programdata ${programdata.toBase58()}, ${pdInfo ? pdInfo.data.length : "?"} bytes, authority ${payer.publicKey.toBase58()})`
);
fs.writeFileSync(OUT, prog.publicKey.toBase58());
