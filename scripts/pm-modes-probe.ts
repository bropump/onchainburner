/**
 * pm-modes-probe: deep-probe specific live pump mints (mainnet, read-only).
 * For each mint: Token-2022 extension TLVs, authorities, bonding-curve decode
 * at raw offsets, mayhem_state PDA existence and bytes, and whether Jupiter
 * quotes SOL -> mint (i.e. whether a real burn attempt is even routable).
 *
 * Usage: ts-node scripts/pm-modes-probe.ts <mint...>
 */
import { Connection, PublicKey } from "@solana/web3.js";

const MAINNET =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MAYHEM = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const AGENT_PAYMENTS = new PublicKey(
  "pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4"
);
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WSOL = "So11111111111111111111111111111111111111112";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// spl-token-2022 ExtensionType numbering (verified against TLV bodies).
const EXT_NAMES: Record<number, string> = {
  1: "TransferFeeConfig",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  6: "DefaultAccountState",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  12: "PermanentDelegate",
  14: "TransferHook",
  16: "ConfidentialTransferFeeConfig",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
};

function describeMint(owner: PublicKey, data: Buffer) {
  const out: any = {
    owner: owner.toBase58(),
    size: data.length,
    decimals: data[44],
    supply: data.readBigUInt64LE(36).toString(),
    mintAuthority:
      data.readUInt32LE(0) === 1
        ? new PublicKey(data.subarray(4, 36)).toBase58()
        : null,
    freezeAuthority:
      data.readUInt32LE(46) === 1
        ? new PublicKey(data.subarray(50, 82)).toBase58()
        : null,
    extensions: [] as any[],
  };
  if (owner.equals(TOKEN_2022) && data.length > 165) {
    let cursor = 166;
    while (cursor + 4 <= data.length) {
      const type = data.readUInt16LE(cursor);
      const length = data.readUInt16LE(cursor + 2);
      if (type === 0) break;
      const entry: any = { type, name: EXT_NAMES[type] ?? `Unknown(${type})` };
      if (type === 14) {
        const body = data.subarray(cursor + 4, cursor + 4 + length);
        const authority = new PublicKey(body.subarray(0, 32));
        const programId = new PublicKey(body.subarray(32, 64));
        entry.hookAuthority = authority.equals(PublicKey.default)
          ? null
          : authority.toBase58();
        entry.hookProgramId = programId.equals(PublicKey.default)
          ? null
          : programId.toBase58();
      }
      out.extensions.push(entry);
      cursor += 4 + length;
    }
  }
  return out;
}

function rawCurve(data: Buffer) {
  return {
    size: data.length,
    virtual_token_reserves: data.readBigUInt64LE(8).toString(),
    virtual_quote_reserves: data.readBigUInt64LE(16).toString(),
    real_token_reserves: data.readBigUInt64LE(24).toString(),
    real_quote_reserves: data.readBigUInt64LE(32).toString(),
    token_total_supply: data.readBigUInt64LE(40).toString(),
    complete: data[48],
    creator: new PublicKey(data.subarray(49, 81)).toBase58(),
    is_mayhem_mode_off81: data[81],
    is_cashback_coin_off82: data[82],
    quote_mint_off83: new PublicKey(data.subarray(83, 115)).toBase58(),
    tail_hex: data.subarray(115).toString("hex"),
  };
}

async function main() {
  const connection = new Connection(MAINNET, "confirmed");
  const mints = process.argv.slice(2).map((m) => new PublicKey(m));
  const report: any[] = [];
  for (const mint of mints) {
    const entry: any = { mint: mint.toBase58() };
    const [curvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      PUMP_FUN
    );
    const [mayhemState] = PublicKey.findProgramAddressSync(
      [Buffer.from("mayhem-state"), mint.toBuffer()],
      MAYHEM
    );
    const [agentState] = PublicKey.findProgramAddressSync(
      [Buffer.from("token-agent-payments"), mint.toBuffer()],
      AGENT_PAYMENTS
    );
    const [mintInfo, curveInfo, mayhemInfo, agentInfo] =
      await connection.getMultipleAccountsInfo([
        mint,
        curvePda,
        mayhemState,
        agentState,
      ]);
    entry.mintState = mintInfo
      ? describeMint(mintInfo.owner, mintInfo.data)
      : null;
    entry.curve = curveInfo ? rawCurve(curveInfo.data) : null;
    entry.curveAddress = curvePda.toBase58();
    entry.mayhemState = mayhemInfo
      ? {
          address: mayhemState.toBase58(),
          size: mayhemInfo.data.length,
          owner: mayhemInfo.owner.toBase58(),
          lamports: mayhemInfo.lamports,
          hex: mayhemInfo.data.toString("hex"),
        }
      : { address: mayhemState.toBase58(), exists: false };
    entry.agentState = agentInfo
      ? {
          address: agentState.toBase58(),
          size: agentInfo.data.length,
          hex: agentInfo.data.subarray(0, 96).toString("hex"),
        }
      : { address: agentState.toBase58(), exists: false };

    // Associated bonding curve (Token-2022 ATA of the curve) holds the
    // tradable supply; the mayhem token vault may hold a separate slice.
    try {
      const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
      url.searchParams.set("inputMint", WSOL);
      url.searchParams.set("outputMint", mint.toBase58());
      url.searchParams.set("amount", "100000000");
      url.searchParams.set("slippageBps", "2000");
      const res = await fetch(url.toString());
      const body: any = await res.json();
      entry.jupiterQuote = body.error
        ? { error: body.error, errorCode: body.errorCode }
        : {
            ok: true,
            outAmount: body.outAmount,
            route: (body.routePlan ?? []).map(
              (h: any) => h.swapInfo?.label
            ),
          };
    } catch (error) {
      entry.jupiterQuote = { error: String(error).slice(0, 120) };
    }
    report.push(entry);
    await sleep(600);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
