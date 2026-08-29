/**
 * pm-modes-launch: create pump.fun launches in EVERY launch mode on the
 * Surfpool fork, and measure per mode:
 *
 *   1. does permissionless create work (normal / cashback / mayhem / agent /
 *      USDC-quoted), and what exactly differs at birth (mint, curve flags,
 *      supply split, mayhem_state, agent PDA);
 *   2. the deployed burner's OWN admission verdict for the fresh mint as a
 *      burn target (read-only `validate_config`);
 *   3. whether Pump creator fees still FUND a burner vault (fee share ->
 *      real buys -> distribute -> vault delta), and in what asset.
 *
 * Modes selectable: ts-node scripts/pm-modes-launch.ts [normal cashback
 * mayhem agent usdc]. Defaults to all.
 */
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  attributeFailure,
  deriveSplitPda,
  ERROR_NAMES,
  Leg,
  PROGRAM,
  readPayer,
  RPC_URL,
  sendInstructions,
} from "./surfpool-split-e2e";

const {
  OnlinePumpSdk,
  PUMP_SDK,
  feeSharingConfigPda,
  getBuyTokenAmountFromSolAmount,
  getMayhemStatePda,
  getSolVaultPda,
  getTokenVaultPda,
} = require("@pump-fun/pump-sdk");

const {
  PumpAgentOffline,
  getTokenAgentPaymentsPDA,
} = require("@pump-fun/agent-payments-sdk");

const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VALIDATE_CONFIG_DISCRIMINATOR = Buffer.from([
  28, 98, 92, 82, 243, 62, 65, 93,
]);

const EXT_NAMES: Record<number, string> = {
  14: "TransferHook",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
};

function describeMintData(owner: PublicKey, data: Buffer) {
  const extensions: string[] = [];
  if (owner.equals(TOKEN_2022_PROGRAM_ID) && data.length > 165) {
    let cursor = 166;
    while (cursor + 4 <= data.length) {
      const type = data.readUInt16LE(cursor);
      const length = data.readUInt16LE(cursor + 2);
      if (type === 0) break;
      extensions.push(EXT_NAMES[type] ?? `Unknown(${type})`);
      cursor += 4 + length;
    }
  }
  return {
    owner: owner.toBase58(),
    supply: data.readBigUInt64LE(36).toString(),
    mintAuthority: data.readUInt32LE(0) === 1 ? "SET" : null,
    freezeAuthority: data.readUInt32LE(46) === 1 ? "SET" : null,
    extensions,
  };
}

function rawCurve(data: Buffer) {
  return {
    size: data.length,
    virtual_token: data.readBigUInt64LE(8).toString(),
    virtual_quote: data.readBigUInt64LE(16).toString(),
    real_token: data.readBigUInt64LE(24).toString(),
    token_total_supply: data.readBigUInt64LE(40).toString(),
    creator: new PublicKey(data.subarray(49, 81)).toBase58(),
    is_mayhem_mode_off81: data[81],
    is_cashback_coin_off82: data[82],
    quote_mint_off83: new PublicKey(data.subarray(83, 115)).toBase58(),
  };
}

/** The deployed burner's read-only admission verdict for one target mint. */
async function validateConfigOnChain(
  connection: Connection,
  payer: Keypair,
  launchMint: PublicKey,
  target: PublicKey
): Promise<{ ok: boolean; code?: number; name?: string; by?: string }> {
  const legs = [{ mint: target, bps: 10000 }] as Leg[];
  const [pda] = deriveSplitPda(launchMint, legs);
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    pda,
    true,
    TOKEN_PROGRAM_ID
  );
  const targetInfo = await connection.getAccountInfo(target, "confirmed");
  const targetProgram = targetInfo?.owner ?? TOKEN_PROGRAM_ID;
  const targetAta = getAssociatedTokenAddressSync(
    target,
    pda,
    true,
    targetProgram
  );
  const body = Buffer.alloc(6);
  body.writeUInt32LE(1, 0);
  body.writeUInt16LE(10000, 4);
  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: pda, isSigner: false, isWritable: false },
      { pubkey: wsolAta, isSigner: false, isWritable: false },
      { pubkey: launchMint, isSigner: false, isWritable: false },
      { pubkey: target, isSigner: false, isWritable: false },
      { pubkey: targetAta, isSigner: false, isWritable: false },
      { pubkey: targetProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([VALIDATE_CONFIG_DISCRIMINATOR, body]),
  });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      instruction,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
  });
  if (!simulation.value.err) return { ok: true };
  const attributed = attributeFailure(
    simulation.value.logs,
    simulation.value.err
  );
  return {
    ok: false,
    code: attributed.code,
    name:
      attributed.isBurner && attributed.code
        ? ERROR_NAMES[attributed.code]
        : undefined,
    by: attributed.isBurner ? "burner" : `external:${attributed.programId}`,
  };
}

/** Give the payer a USDC balance by writing its ATA via surfnet_setAccount. */
async function conjureUsdc(
  payer: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    USDC,
    payer,
    true,
    TOKEN_PROGRAM_ID
  );
  const data = Buffer.alloc(165);
  USDC.toBuffer().copy(data, 0);
  payer.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1; // state = Initialized
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [
        ata.toBase58(),
        {
          lamports: 2_100_000,
          data: data.toString("hex"),
          owner: TOKEN_PROGRAM_ID.toBase58(),
        },
      ],
    }),
  });
  const body = await response.json();
  if (body.error)
    throw new Error(`surfnet_setAccount: ${JSON.stringify(body.error)}`);
  return ata;
}

type ModeSpec = {
  name: string;
  mayhemMode: boolean;
  cashback: boolean;
  agent?: boolean;
  quoteMint?: PublicKey;
};

const MODES: ModeSpec[] = [
  { name: "normal", mayhemMode: false, cashback: false },
  { name: "cashback", mayhemMode: false, cashback: true },
  { name: "mayhem", mayhemMode: true, cashback: false },
  { name: "agent", mayhemMode: false, cashback: false, agent: true },
  { name: "usdc", mayhemMode: false, cashback: false, quoteMint: USDC },
];

async function runMode(
  connection: Connection,
  payer: Keypair,
  onlinePump: any,
  spec: ModeSpec
): Promise<any> {
  const report: any = { mode: spec.name };
  const mint = Keypair.generate();
  report.mint = mint.publicKey.toBase58();

  // ---- create -------------------------------------------------------------
  const createInstructions: TransactionInstruction[] = [
    await PUMP_SDK.createV2Instruction({
      mint: mint.publicKey,
      name: `pm-${spec.name}`,
      symbol: spec.name.slice(0, 6).toUpperCase(),
      uri: `https://example.com/pm-${spec.name}.json`,
      creator: payer.publicKey,
      user: payer.publicKey,
      mayhemMode: spec.mayhemMode,
      cashback: spec.cashback,
      quoteMint: spec.quoteMint,
    }),
  ];
  if (spec.agent) {
    const agentSdk = PumpAgentOffline.load(mint.publicKey);
    createInstructions.push(
      await agentSdk.create({
        authority: payer.publicKey,
        mint: mint.publicKey,
        agentAuthority: payer.publicKey,
        buybackBps: 500,
      })
    );
  }
  try {
    await sendInstructions(
      connection,
      payer,
      `pm-create-${spec.name}`,
      createInstructions,
      [mint]
    );
    report.create = "ok";
  } catch (error) {
    report.create = `FAILED: ${String(error).slice(0, 400)}`;
    return report;
  }

  // ---- birth state --------------------------------------------------------
  const [curvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.publicKey.toBuffer()],
    PUMP_FUN
  );
  const mintInfo = await connection.getAccountInfo(mint.publicKey, "confirmed");
  const curveInfo = await connection.getAccountInfo(curvePda, "confirmed");
  report.mintState = mintInfo
    ? describeMintData(mintInfo.owner, mintInfo.data)
    : null;
  report.curve = curveInfo ? rawCurve(curveInfo.data) : null;

  const mayhemState = getMayhemStatePda(mint.publicKey);
  const mayhemInfo = await connection.getAccountInfo(mayhemState, "confirmed");
  report.mayhemState = mayhemInfo
    ? { exists: true, size: mayhemInfo.data.length }
    : { exists: false };
  if (spec.mayhemMode) {
    const vault = getTokenVaultPda(mint.publicKey);
    const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
    report.mayhemTokenVault = vaultInfo
      ? {
          address: vault.toBase58(),
          tokens: vaultInfo.data.readBigUInt64LE(64).toString(),
        }
      : { exists: false };
    report.solVaultPda = getSolVaultPda().toBase58();
  }
  if (spec.agent) {
    const [agentPda] = getTokenAgentPaymentsPDA(mint.publicKey);
    const agentInfo = await connection.getAccountInfo(agentPda, "confirmed");
    report.agentState = agentInfo
      ? {
          exists: true,
          address: agentPda.toBase58(),
          size: agentInfo.data.length,
          buybackBps: agentInfo.data.readUInt16LE(8 + 1 + 32 + 32),
        }
      : { exists: false, address: agentPda.toBase58() };
  }

  // ---- deployed burner's admission verdict for this mint as a target ------
  report.burnerAdmission = await validateConfigOnChain(
    connection,
    payer,
    mint.publicKey,
    mint.publicKey
  );

  // ---- fee share to a burner vault ---------------------------------------
  const legs: Leg[] = [{ label: "OWN", mint: mint.publicKey, bps: 10000 }];
  const [vault] = deriveSplitPda(mint.publicKey, legs);
  report.vault = vault.toBase58();
  const shareQuoteMint = spec.quoteMint ?? NATIVE_MINT;
  try {
    await sendInstructions(connection, payer, `pm-fee-config-${spec.name}`, [
      await PUMP_SDK.createFeeSharingConfig({
        creator: payer.publicKey,
        mint: mint.publicKey,
        pool: null,
      }),
    ]);
    await sendInstructions(connection, payer, `pm-fee-share-${spec.name}`, [
      await PUMP_SDK.updateFeeSharesV2({
        authority: payer.publicKey,
        mint: mint.publicKey,
        currentShareholders: [payer.publicKey],
        newShareholders: [{ address: vault, shareBps: 10_000 }],
        quoteMint: shareQuoteMint,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ]);
    report.feeShare = "100% to vault, ok";
  } catch (error) {
    report.feeShare = `FAILED: ${String(error).slice(0, 300)}`;
  }

  // ---- real buys to accrue creator fees ----------------------------------
  const quoteAmounts = spec.quoteMint
    ? [new BN(50_000_000), new BN(100_000_000)] // 50 / 100 USDC (6 dp)
    : [new BN(5_000_000_000), new BN(10_000_000_000)]; // 5 / 10 SOL
  if (spec.quoteMint) {
    await conjureUsdc(payer.publicKey, 10_000_000_000n); // 10k USDC
    report.usdcConjured = true;
  }
  const buys: string[] = [];
  try {
    const global = await onlinePump.fetchGlobal();
    const feeConfig = await onlinePump.fetchFeeConfig();
    for (const quoteAmount of quoteAmounts) {
      const {
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
      } = await onlinePump.fetchBuyState(
        mint.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID
      );
      const mintState = await getMint(
        connection,
        mint.publicKey,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      await sendInstructions(
        connection,
        payer,
        `pm-buy-${spec.name}`,
        await PUMP_SDK.buyV2Instructions({
          global,
          feeConfig,
          bondingCurveAccountInfo,
          bondingCurve,
          associatedUserAccountInfo,
          mint: mint.publicKey,
          user: payer.publicKey,
          amount: getBuyTokenAmountFromSolAmount({
            global,
            feeConfig,
            mintSupply: new BN(mintState.supply.toString()),
            bondingCurve,
            amount: quoteAmount,
            quoteMint: shareQuoteMint,
          }),
          quoteAmount,
          slippage: 2,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
        })
      );
      buys.push(quoteAmount.toString());
    }
    report.buys = buys;
  } catch (error) {
    report.buys = buys;
    report.buyError = String(error).slice(0, 400);
  }

  // ---- distribute and measure what the vault received ---------------------
  const vaultQuoteAta = getAssociatedTokenAddressSync(
    shareQuoteMint,
    vault,
    true,
    TOKEN_PROGRAM_ID
  );
  const lamportsBefore = await connection.getBalance(vault, "confirmed");
  const quoteAtaBefore = await connection.getAccountInfo(
    vaultQuoteAta,
    "confirmed"
  );
  try {
    const sharingConfigAddress = feeSharingConfigPda(mint.publicKey);
    const sharingConfigInfo = await connection.getAccountInfo(
      sharingConfigAddress
    );
    const sharingConfig = PUMP_SDK.decodeSharingConfig(sharingConfigInfo!);
    await sendInstructions(connection, payer, `pm-distribute-${spec.name}`, [
      await PUMP_SDK.distributeCreatorFeesV2({
        mint: mint.publicKey,
        sharingConfig,
        sharingConfigAddress,
        quoteMint: shareQuoteMint,
        payer: payer.publicKey,
        shouldInitializeAta: true,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ]);
    const lamportsAfter = await connection.getBalance(vault, "confirmed");
    const quoteAtaAfter = await connection.getAccountInfo(
      vaultQuoteAta,
      "confirmed"
    );
    report.distribution = {
      vaultLamportsDelta: lamportsAfter - lamportsBefore,
      vaultQuoteAtaDelta:
        quoteAtaAfter && !shareQuoteMint.equals(NATIVE_MINT)
          ? (
              quoteAtaAfter.data.readBigUInt64LE(64) -
              (quoteAtaBefore?.data.readBigUInt64LE(64) ?? 0n)
            ).toString()
          : undefined,
      vaultQuoteAta: shareQuoteMint.equals(NATIVE_MINT)
        ? undefined
        : vaultQuoteAta.toBase58(),
    };
  } catch (error) {
    report.distribution = { error: String(error).slice(0, 400) };
  }

  return report;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const onlinePump = new OnlinePumpSdk(connection);
  const requested = process.argv.slice(2);
  const modes = requested.length
    ? MODES.filter((m) => requested.includes(m.name))
    : MODES;
  const reports: any[] = [];
  for (const spec of modes) {
    console.error(`--- running mode: ${spec.name}`);
    try {
      reports.push(await runMode(connection, payer, onlinePump, spec));
    } catch (error) {
      reports.push({ mode: spec.name, fatal: String(error).slice(0, 500) });
    }
  }
  console.log(JSON.stringify(reports, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
