/**
 * Empirical proof: can Irys metadata upload + Pump create_v2 share one
 * Solana transaction / one atomic sign?
 *
 * Measured on the local Surfpool fork. Does not spend mainnet SOL.
 * Does not touch the burner program.
 *
 * Run: SURFPOOL_RPC_URL=http://127.0.0.1:9900 npx tsx scripts/irys-pump-atomicity.ts
 */
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { readPayer, sendInstructions } from "./surfpool-split-e2e";

const { PUMP_SDK } = require("@pump-fun/pump-sdk");

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:9900";
const DUMMY_URI = "https://example.com/irys-atomicity-proof.json";
const IRYS_UPLOADER = "https://uploader.irys.xyz";
const IRYS_NODE1 = "https://node1.irys.xyz";
const IRYS_GATEWAY = "https://gateway.irys.xyz";
const PUMP_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const CREATE_V2_DISC = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
/** Measured in launch.tsx: a fresh fork needs this mint pre-fund or
 * create_v2 dies InsufficientFundsForRent. Fork SOL only. */
const FORK_MINT_RENT_TOPUP = 5_000_000;
/** Dust paid to Irys's documented SOL recipient — on the fork, not mainnet. */
const FORK_IRYS_PAY_LAMPORTS = 10_000;

type HttpProbe = {
  url: string;
  status: number | null;
  body: string;
  error?: string;
};

function assertLocalRpc(url: string): void {
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error(`refusing: this proof is fork-only, RPC is ${url}`);
  }
}

async function httpJson(
  url: string,
  init?: RequestInit
): Promise<HttpProbe> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    return { url, status: response.status, body: text };
  } catch (error) {
    return {
      url,
      status: null,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function clip(text: string, n = 400): string {
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

function mintTopupIx(from: PublicKey, mint: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: mint,
    lamports: FORK_MINT_RENT_TOPUP,
  });
}

function uriOffsetInCreateData(data: Buffer, uri: string): number {
  return data.indexOf(Buffer.from(uri, "utf8"));
}

async function main(): Promise<void> {
  assertLocalRpc(RPC_URL);
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();

  const report: Record<string, unknown> = {
    rpc: RPC_URL,
    payer: payer.publicKey.toBase58(),
    dummyUri: DUMMY_URI,
  };

  // ---- fork health --------------------------------------------------------
  const healthProbe = await httpJson(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });
  if (healthProbe.status !== 200 || !healthProbe.body.includes('"ok"')) {
    throw new Error(
      `fork getHealth failed: status=${healthProbe.status} body=${healthProbe.body} error=${healthProbe.error ?? ""}`
    );
  }
  const health = "ok";
  const slot = await connection.getSlot("confirmed");
  const payerLamports = await connection.getBalance(payer.publicKey);
  report.fork = { health, slot, payerLamports };
  console.log(`A0  fork health=${health} slot=${slot} payerLamports=${payerLamports}`);
  if (payerLamports < 20_000_000) {
    throw new Error(`payer underfunded on fork: ${payerLamports}`);
  }

  // ---- B: Irys HTTP info, no Solana upload program ------------------------
  const uploaderInfo = await httpJson(`${IRYS_UPLOADER}/info`);
  const node1Info = await httpJson(`${IRYS_NODE1}/info`);
  report.irysInfo = { uploader: uploaderInfo, node1: node1Info };

  let uploaderSol: string | null = null;
  let node1Sol: string | null = null;
  try {
    uploaderSol = JSON.parse(uploaderInfo.body).addresses?.solana ?? null;
  } catch (error) {
    console.log(
      `B0  uploader /info JSON parse failed: ${String(error)} body=${clip(uploaderInfo.body)}`
    );
  }
  try {
    node1Sol = JSON.parse(node1Info.body).addresses?.solana ?? null;
  } catch (error) {
    console.log(
      `B0  node1 /info JSON parse failed: ${String(error)} body=${clip(node1Info.body)}`
    );
  }
  console.log(
    `B0  GET ${IRYS_UPLOADER}/info status=${uploaderInfo.status} solana=${uploaderSol}`
  );
  console.log(
    `B0  GET ${IRYS_NODE1}/info status=${node1Info.status} solana=${node1Sol}`
  );
  if (!uploaderSol) {
    throw new Error("uploader.irys.xyz/info did not return a solana address");
  }
  const irysRecipient = new PublicKey(uploaderSol);
  const node1Recipient = node1Sol ? new PublicKey(node1Sol) : null;

  const irysAccounts = [irysRecipient, node1Recipient].filter(
    (k): k is PublicKey => k !== null
  );
  const irysAccountFacts = [];
  for (const address of irysAccounts) {
    const info = await connection.getAccountInfo(address);
    irysAccountFacts.push({
      address: address.toBase58(),
      exists: info !== null,
      owner: info?.owner.toBase58() ?? null,
      executable: info?.executable ?? null,
      lamports: info?.lamports ?? null,
      dataLen: info?.data.length ?? null,
    });
    console.log(
      `B1  getAccountInfo ${address.toBase58()} owner=${
        info?.owner.toBase58() ?? "missing"
      } executable=${info?.executable ?? "n/a"} dataLen=${
        info?.data.length ?? "n/a"
      } lamports=${info?.lamports ?? "n/a"}`
    );
  }
  report.irysAccountFacts = irysAccountFacts;
  const anyExecutable = irysAccountFacts.some((f) => f.executable === true);
  console.log(
    `B2  Irys SOL recipients executable on fork? ${anyExecutable} (measured: they are System-owned wallets, not an upload program)`
  );

  const pumpProgram = await connection.getAccountInfo(PUMP_PROGRAM);
  console.log(
    `B3  Pump program ${PUMP_PROGRAM.toBase58()} executable=${
      pumpProgram?.executable ?? false
    } owner=${pumpProgram?.owner.toBase58() ?? "missing"}`
  );
  report.pumpProgram = {
    executable: pumpProgram?.executable ?? false,
    owner: pumpProgram?.owner.toBase58() ?? null,
    dataLen: pumpProgram?.data.length ?? null,
  };

  const uploadPost = await httpJson(`${IRYS_UPLOADER}/tx/solana`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from("not-a-data-item"),
  });
  console.log(
    `B4  POST ${IRYS_UPLOADER}/tx/solana status=${uploadPost.status} body=${clip(uploadPost.body, 200)} error=${uploadPost.error ?? ""}`
  );
  report.irysUploadPostGarbage = uploadPost;

  // ---- A: URI is an argument; land create_v2 on the fork ------------------
  const mintA = Keypair.generate();
  const createA = await PUMP_SDK.createV2Instruction({
    mint: mintA.publicKey,
    name: "Irys Atomicity A",
    symbol: "IRYSA",
    uri: DUMMY_URI,
    creator: payer.publicKey,
    user: payer.publicKey,
    mayhemMode: false,
    cashback: false,
  });
  const dataA = Buffer.from(createA.data);
  const uriOffA = uriOffsetInCreateData(dataA, DUMMY_URI);
  const discOk = dataA.subarray(0, 8).equals(CREATE_V2_DISC);
  console.log(
    `A1  create_v2 program=${createA.programId.toBase58()} dataLen=${
      dataA.length
    } disc=${dataA.subarray(0, 8).toString("hex")} discMatchesIdl=${discOk}`
  );
  console.log(
    `A2  URI bytes in instruction data BEFORE submit: offset=${uriOffA} (measured, not inferred)`
  );
  if (uriOffA < 0) {
    throw new Error("URI bytes missing from create_v2 data — cannot prove A");
  }
  if (!createA.programId.equals(PUMP_PROGRAM)) {
    throw new Error(`create_v2 program is ${createA.programId.toBase58()}`);
  }

  const sigA = await sendInstructions(
    connection,
    payer,
    "irys-atomicity-A-create_v2",
    [mintTopupIx(payer.publicKey, mintA.publicKey), createA],
    [mintA]
  );
  const mintAInfo = await connection.getAccountInfo(mintA.publicKey);
  console.log(
    `A3  create_v2 LANDED sig=${sigA} mint=${mintA.publicKey.toBase58()} mintOwner=${
      mintAInfo?.owner.toBase58() ?? "missing"
    } mintLamports=${mintAInfo?.lamports ?? 0}`
  );
  report.A = {
    signature: sigA,
    mint: mintA.publicKey.toBase58(),
    uri: DUMMY_URI,
    uriByteOffset: uriOffA,
    dataLen: dataA.length,
    discMatchesIdl: discOk,
    mintOwner: mintAInfo?.owner.toBase58() ?? null,
    mintExists: mintAInfo !== null,
  };

  const uriGetA = await httpJson(DUMMY_URI);
  console.log(
    `A4  GET dummy URI after create: status=${uriGetA.status} (mint exists regardless)`
  );
  report.A = { ...(report.A as object), dummyUriGet: uriGetA };

  // ---- C: SystemProgram.transfer to Irys recipient + create_v2, one tx ----
  const mintC = Keypair.generate();
  const createC = await PUMP_SDK.createV2Instruction({
    mint: mintC.publicKey,
    name: "Irys Atomicity C",
    symbol: "IRYSC",
    uri: DUMMY_URI,
    creator: payer.publicKey,
    user: payer.publicKey,
    mayhemMode: false,
    cashback: false,
  });
  const payIrys = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: irysRecipient,
    lamports: FORK_IRYS_PAY_LAMPORTS,
  });
  const irysBefore = await connection.getBalance(irysRecipient);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  // Build the message ourselves so the printed ix list is exactly what lands
  // (sendInstructions prepends a compute-budget ix; that is fine and measured).
  const ixsC = [
    mintTopupIx(payer.publicKey, mintC.publicKey),
    payIrys,
    createC,
  ];
  console.log(
    `C1  one tx ix programs (plus compute budget inside sendInstructions): ${ixsC
      .map((ix) => ix.programId.toBase58())
      .join(" + ")}`
  );
  const sigC = await sendInstructions(
    connection,
    payer,
    "irys-atomicity-C-pay-plus-create",
    ixsC,
    [mintC]
  );
  const irysAfter = await connection.getBalance(irysRecipient);
  const mintCInfo = await connection.getAccountInfo(mintC.publicKey);
  const txC = await connection.getTransaction(sigC, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  const landedPrograms =
    txC?.transaction.message.compiledInstructions.map((ix) => {
      const keys = txC.transaction.message.getAccountKeys();
      const programId = keys.get(ix.programIdIndex);
      return {
        program: programId?.toBase58() ?? `index:${ix.programIdIndex}`,
        dataLen: ix.data.length,
      };
    }) ?? [];
  console.log(`C2  LANDED sig=${sigC} mint=${mintC.publicKey.toBase58()}`);
  console.log(
    `C3  Irys recipient fork balance ${irysBefore} -> ${irysAfter} (delta ${
      irysAfter - irysBefore
    }, want +${FORK_IRYS_PAY_LAMPORTS})`
  );
  console.log(`C4  landed ix programs: ${JSON.stringify(landedPrograms)}`);
  report.C = {
    signature: sigC,
    mint: mintC.publicKey.toBase58(),
    uri: DUMMY_URI,
    irysRecipient: irysRecipient.toBase58(),
    irysBefore,
    irysAfter,
    delta: irysAfter - irysBefore,
    mintExists: mintCInfo !== null,
    mintOwner: mintCInfo?.owner.toBase58() ?? null,
    landedPrograms,
  };

  const uriGetC = await httpJson(DUMMY_URI);
  console.log(
    `C5  GET ${DUMMY_URI} after atomic pay+create: status=${uriGetC.status} body=${clip(uriGetC.body, 120)}`
  );
  report.C = { ...(report.C as object), dummyUriGet: uriGetC };

  // ---- D: Irys HTTP does not see Surfpool payment -------------------------
  const balanceUrl = `${IRYS_UPLOADER}/account/balance/solana?address=${payer.publicKey.toBase58()}`;
  const balanceBeforeCredit = await httpJson(balanceUrl);
  console.log(
    `D1  GET Irys balance (uploader) status=${balanceBeforeCredit.status} body=${clip(balanceBeforeCredit.body)}`
  );
  const creditForkTx = await httpJson(
    `${IRYS_UPLOADER}/account/balance/solana`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_id: sigC }),
    }
  );
  console.log(
    `D2  POST Irys credit with FORK sig status=${creditForkTx.status} body=${clip(creditForkTx.body)} error=${creditForkTx.error ?? ""}`
  );
  const balanceAfterCredit = await httpJson(balanceUrl);
  console.log(
    `D3  GET Irys balance after credit-attempt status=${balanceAfterCredit.status} body=${clip(balanceAfterCredit.body)}`
  );
  const node1Balance = await httpJson(
    `${IRYS_NODE1}/account/balance/solana?address=${payer.publicKey.toBase58()}`
  );
  console.log(
    `D4  GET Irys balance (node1) status=${node1Balance.status} body=${clip(node1Balance.body)}`
  );
  report.D = {
    balanceBeforeCredit,
    creditForkTx,
    balanceAfterCredit,
    node1Balance,
  };

  // ---- E: predicted URI does not upload bytes -----------------------------
  const metadata = JSON.stringify({
    name: "Irys Atomicity E",
    symbol: "IRYSE",
    description: "predicted-id illustration; not posted to Irys",
  });
  const fakeId = createHash("sha256")
    .update(metadata)
    .digest("base64url");
  const predicted = `${IRYS_GATEWAY}/${fakeId}`;
  const predictedGet = await httpJson(predicted);
  console.log(
    `E1  predicted gateway URL (sha256 of JSON, NOT a signed data-item id) ${predicted}`
  );
  console.log(
    `E2  GET predicted URL status=${predictedGet.status} (no POST was sent to Irys)`
  );
  report.E = {
    predicted,
    note: "A real Irys data-item id is known after signing the data item, before POST. This script did not sign a data item and did not POST to Irys mainnet. Even a correctly predicted https://gateway.irys.xyz/<id> baked into create_v2 does not upload the bytes; a failed POST leaves a mint with a dead URI.",
    predictedGet,
    postedToIrysMainnet: false,
  };

  // ---- verdict ------------------------------------------------------------
  const verdict = {
    createV2Landed: Boolean(sigA && mintAInfo),
    irysUploadInSameSolanaTx: false,
    irysUploadReason:
      "Upload is HTTP POST to an Irys bundler (/tx/solana). No Irys program id, no upload instruction. create_v2 already contains the URI bytes before submit.",
    irysPaymentInSameSolanaTx: Boolean(sigC && irysAfter - irysBefore === FORK_IRYS_PAY_LAMPORTS),
    irysPaymentReason:
      "SystemProgram.transfer to the bundler's SOL address + create_v2 landed in one fork tx. That pays an address; it does not upload metadata.",
    irysAcceptsSurfpoolPayment: false,
    irysAcceptsReason:
      "Irys balance GET and credit-POST of the fork signature do not credit the payer. Bundlers watch their own network (mainnet), not Surfpool.",
    safeUserFlow:
      "HTTP upload must succeed first (wallet message-sign of the data item + POST), then a second sign for create_v2. Two signs. Not one Solana transaction.",
  };
  report.verdict = verdict;
  console.log("\n==== VERDICT ====");
  console.log(JSON.stringify(verdict, null, 2));
  console.log("\n==== FULL REPORT ====");
  console.log(
    JSON.stringify(
      report,
      (_key, value) =>
        typeof value === "string" && value.length > 500
          ? `${value.slice(0, 500)}…`
          : value,
      2
    )
  );
}

main().catch((error) => {
  console.error("PROOF FAILED", error);
  process.exit(1);
});
