/**
 * e2e verification: the TARGET-ADMISSION guards, proven ON CHAIN against the
 * DEPLOYED program on the fork, and attributed to the burner.
 *
 * Two independent proofs of the same rules:
 *
 *  A. `validate_config` (discriminator 1c625c5253...) — the deployed read-only
 *     admission instruction. It runs the burn's own
 *     `validate_split_target_admission`, needs no Jupiter route, no funding and
 *     no quote authority, so it deterministically exercises the exact admission
 *     decision for pathological mints that may not route on a fork. Every
 *     failure is attributed to the burner's program-id log frame.
 *
 *  B. A real burn attempt (`runSplitCase`) for the cases whose mints ARE
 *     liquid enough to route, so the admission code is also proven on the
 *     actual burn path, not only the validator.
 *
 * Codes covered: 6036 (freezable, USDC/USDT), 6037 (mintable, JitoSOL/mSOL),
 * 6024 (disallowed Token-2022 extension, a transfer-fee mint), 6038
 * (native/WSOL target). Good targets (JTO, NEIRO, PUMP, BONK) must PASS
 * validate_config.
 */
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
  PROGRAM,
  readPayer,
  readQuoteAuthority,
  RPC_URL,
  runSplitCase,
  solToLamports,
  TOKENS,
} from "./surfpool-split-e2e";

const VALIDATE_CONFIG_DISCRIMINATOR = Buffer.from([
  28, 98, 92, 82, 243, 62, 65, 93,
]);
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const JITOSOL = new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const MSOL = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
// A routable Token-2022 transfer-FEE mint (no freeze, no mint authority) so
// admission lands on the extension allow-list (6024), not 6036/6037.
const BERN = new PublicKey("CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo");

async function validateConfigOnChain(
  connection: Connection,
  payer: Keypair,
  launchMint: PublicKey,
  target: PublicKey
): Promise<{ code?: number; by: string; name?: string; logs: string[] }> {
  const legs = [{ mint: target, bps: 10000 }];
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

  const data = Buffer.concat([
    VALIDATE_CONFIG_DISCRIMINATOR,
    (() => {
      const b = Buffer.alloc(4 + 2);
      b.writeUInt32LE(1, 0);
      b.writeUInt16LE(10000, 4);
      return b;
    })(),
  ]);
  const keys = [
    { pubkey: pda, isSigner: false, isWritable: false },
    { pubkey: wsolAta, isSigner: false, isWritable: false },
    { pubkey: launchMint, isSigner: false, isWritable: false },
    { pubkey: target, isSigner: false, isWritable: false },
    { pubkey: targetAta, isSigner: false, isWritable: false },
    { pubkey: targetProgram, isSigner: false, isWritable: false },
  ];
  const instruction = new TransactionInstruction({
    programId: PROGRAM,
    keys,
    data,
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
  const logs = simulation.value.logs ?? [];
  if (!simulation.value.err) {
    return { by: "accepted", logs };
  }
  const attributed = attributeFailure(logs, simulation.value.err);
  return {
    code: attributed.code,
    by: attributed.isBurner ? "burner" : attributed.programId ?? "runtime",
    name: attributed.code ? ERROR_NAMES[attributed.code] : undefined,
    logs,
  };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readPayer();
  const quoteAuthority = readQuoteAuthority();

  // Launch namespace mint: any real legacy-SPL mint. FARTCOIN is one.
  const LAUNCH = TOKENS.FARTCOIN;

  const dangerous: {
    label: string;
    mint: PublicKey;
    expect: number;
    realBurn: boolean;
  }[] = [
    { label: "USDC(freezable)", mint: TOKENS.USDC, expect: 6036, realBurn: true },
    { label: "USDT(freezable)", mint: USDT, expect: 6036, realBurn: false },
    { label: "JitoSOL(mintable)", mint: JITOSOL, expect: 6037, realBurn: true },
    { label: "mSOL(mintable)", mint: MSOL, expect: 6037, realBurn: false },
    { label: "BERN(transfer-fee T22)", mint: BERN, expect: 6024, realBurn: true },
    { label: "WSOL(native)", mint: NATIVE_MINT, expect: 6038, realBurn: false },
  ];
  const good: { label: string; mint: PublicKey }[] = [
    { label: "JTO", mint: TOKENS.JTO },
    { label: "NEIRO", mint: TOKENS.NEIRO },
    { label: "PUMP", mint: TOKENS.PUMP },
    { label: "BONK", mint: TOKENS.BONK },
  ];

  const report: any = { validateConfig: [], realBurn: [] };

  console.error("=== validate_config on-chain: dangerous targets must be REFUSED ===");
  for (const target of dangerous) {
    // Report why it is dangerous, read from the same bytes the program reads.
    let mintState = "";
    try {
      const info = await connection.getAccountInfo(target.mint, "confirmed");
      if (info) {
        const m = await getMint(connection, target.mint, "confirmed", info.owner);
        mintState = `mintAuth=${m.mintAuthority ? "LIVE" : "null"} freezeAuth=${m.freezeAuthority ? "LIVE" : "null"} ${info.owner.equals(TOKEN_2022_PROGRAM_ID) ? "t22" : "legacy"}`;
      }
    } catch {
      /* WSOL getMint may vary; ignore */
    }
    const result = await validateConfigOnChain(
      connection,
      payer,
      LAUNCH,
      target.mint
    );
    const pass = result.by === "burner" && result.code === target.expect;
    report.validateConfig.push({
      label: target.label,
      mint: target.mint.toBase58(),
      mintState,
      expect: target.expect,
      code: result.code,
      by: result.by,
      name: result.name,
      pass,
    });
    console.error(
      `  ${target.label.padEnd(24)} ${mintState.padEnd(42)} -> ${String(result.code ?? result.by).padEnd(5)} ${(result.name ?? "").padEnd(20)} by=${result.by.slice(0, 10).padEnd(10)} expect ${target.expect} ${pass ? "PASS" : "FAIL"}`
    );
  }

  console.error("\n=== validate_config on-chain: good targets must be ACCEPTED ===");
  for (const target of good) {
    const result = await validateConfigOnChain(
      connection,
      payer,
      LAUNCH,
      target.mint
    );
    const pass = result.by === "accepted";
    report.validateConfig.push({
      label: `${target.label}(good)`,
      mint: target.mint.toBase58(),
      expect: "accept",
      code: result.code,
      by: result.by,
      pass,
    });
    console.error(
      `  ${target.label.padEnd(10)} -> ${result.by === "accepted" ? "ACCEPTED" : `${result.code} by ${result.by}`} ${pass ? "PASS" : "FAIL"}`
    );
  }

  console.error("\n=== real burn attempt on liquid dangerous targets (burn path) ===");
  for (const target of dangerous.filter((t) => t.realBurn)) {
    const r = await runSplitCase(
      connection,
      payer,
      quoteAuthority,
      `admission-${target.label.replace(/[^a-zA-Z0-9]/g, "")}`,
      LAUNCH,
      [{ label: target.label, mint: target.mint, bps: 10000 }],
      "0.1",
      {
        maxAccountsPerLeg: 0,
        fundExtra: solToLamports("0.05"),
        slippageBps: 1500,
        expectReject: true,
      }
    );
    const pass = r.rejectedBy === "burner" && r.errorCode === target.expect;
    report.realBurn.push({
      label: target.label,
      expect: target.expect,
      status: r.status,
      code: r.errorCode,
      by: r.rejectedBy,
      pass,
    });
    console.error(
      `  ${target.label.padEnd(24)} -> ${r.status.padEnd(9)} ${String(r.errorCode ?? "").padEnd(5)} by=${(r.rejectedBy ?? "?").padEnd(8)} expect ${target.expect} ${pass ? "PASS" : "FAIL"}`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(JSON.stringify(report, null, 2));
  const vcPass = report.validateConfig.every((r: any) => r.pass);
  const rbPass = report.realBurn.every((r: any) => r.pass);
  console.error(
    `\nvalidate_config: ${report.validateConfig.filter((r: any) => r.pass).length}/${report.validateConfig.length} | real-burn: ${report.realBurn.filter((r: any) => r.pass).length}/${report.realBurn.length}`
  );
  process.exit(vcPass && rbPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
