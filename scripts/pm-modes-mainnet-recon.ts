/**
 * pm-modes-mainnet-recon: LIVE mainnet evidence for pump.fun's non-standard
 * launch modes (mayhem / cashback / tokenized-agent / non-SOL quote).
 *
 * Read-only. Answers, with real account bytes:
 *  1. Is each mode live on mainnet (Global toggles, real instances)?
 *  2. Where exactly does each mode flag live (account + byte offset), and do
 *     the SDK-declared offsets match real accounts?
 *  3. What do real mode mints look like to the burner's admission checks
 *     (owner program, extensions, freeze/mint authority)?
 */
import { Connection, PublicKey } from "@solana/web3.js";

const { PUMP_SDK } = require("@pump-fun/pump-sdk");

const MAINNET =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PUMP_FUN = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MAYHEM = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const AGENT_PAYMENTS = new PublicKey(
  "pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4"
);
const PUMP_FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN
  )[0];
}
function mayhemStatePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mayhem-state"), mint.toBuffer()],
    MAYHEM
  )[0];
}

/** Raw-offset decode of a BondingCurve account, independent of the SDK. */
function rawCurve(data: Buffer) {
  return {
    size: data.length,
    discriminator: data.subarray(0, 8).toString("hex"),
    complete: data[48],
    creator: new PublicKey(data.subarray(49, 81)).toBase58(),
    is_mayhem_mode_off81: data[81],
    is_cashback_coin_off82: data[82],
    quote_mint_off83: new PublicKey(data.subarray(83, 115)).toBase58(),
    tail_115_up_hex: data.subarray(115).toString("hex"),
  };
}

/** Minimal Token-2022 mint TLV walk: base 82 bytes, TLVs from 166. */
function describeMint(owner: PublicKey, data: Buffer) {
  const mintAuthorityTag = data.readUInt32LE(0);
  const freezeAuthorityTag = data.readUInt32LE(46);
  const out: any = {
    owner: owner.toBase58(),
    size: data.length,
    decimals: data[44],
    supply: data.readBigUInt64LE(36).toString(),
    mintAuthority:
      mintAuthorityTag === 1
        ? new PublicKey(data.subarray(4, 36)).toBase58()
        : null,
    freezeAuthority:
      freezeAuthorityTag === 1
        ? new PublicKey(data.subarray(50, 82)).toBase58()
        : null,
    extensions: [] as { type: number; name: string; length: number }[],
  };
  const NAMES: Record<number, string> = {
    1: "TransferFeeConfig",
    3: "MintCloseAuthority",
    4: "ConfidentialTransferMint",
    6: "DefaultAccountState",
    8: "MemoTransfer",
    9: "NonTransferable",
    10: "InterestBearingConfig",
    11: "CpiGuard",
    12: "PermanentDelegate",
    14: "TransferHook",
    16: "MetadataPointer",
    18: "TokenMetadata",
    19: "GroupPointer",
    21: "GroupMemberPointer",
    25: "ScaledUiAmount",
    26: "PausableConfig",
  };
  if (owner.equals(TOKEN_2022) && data.length > 165) {
    let cursor = 166;
    while (cursor + 4 <= data.length) {
      const type = data.readUInt16LE(cursor);
      const length = data.readUInt16LE(cursor + 2);
      if (type === 0) break;
      out.extensions.push({
        type,
        name: NAMES[type] ?? `Unknown(${type})`,
        length,
      });
      if (type === 14) {
        const body = data.subarray(cursor + 4, cursor + 4 + length);
        const authority = new PublicKey(body.subarray(0, 32));
        const programId = new PublicKey(body.subarray(32, 64));
        out.transferHook = {
          authority: authority.equals(PublicKey.default)
            ? null
            : authority.toBase58(),
          programId: programId.equals(PublicKey.default)
            ? null
            : programId.toBase58(),
        };
      }
      cursor += 4 + length;
    }
  }
  return out;
}

async function main() {
  const connection = new Connection(MAINNET, "confirmed");
  const report: any = { rpc: MAINNET, slot: await connection.getSlot() };

  // ---- 1. Global toggles --------------------------------------------------
  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_FUN
  );
  const globalInfo = await connection.getAccountInfo(globalPda, "confirmed");
  if (!globalInfo) throw new Error("pump global missing");
  const global = PUMP_SDK.decodeGlobal(globalInfo);
  report.global = {
    address: globalPda.toBase58(),
    size: globalInfo.data.length,
    createV2Enabled: global.createV2Enabled,
    mayhemModeEnabled: global.mayhemModeEnabled,
    isCashbackEnabled: global.isCashbackEnabled,
    feeBasisPoints: global.feeBasisPoints.toString(),
    creatorFeeBasisPoints: global.creatorFeeBasisPoints.toString(),
    buybackBasisPoints: global.buybackBasisPoints?.toString?.(),
    reservedFeeRecipient: global.reservedFeeRecipient?.toBase58?.(),
    whitelistedQuoteMints: (global.whitelistedQuoteMints ?? []).map(
      (k: PublicKey) => k.toBase58()
    ),
    initialVirtualQuoteReserves: global.initialVirtualQuoteReserves?.toString?.(),
  };

  await sleep(400);

  // ---- 2. Real mayhem coins: enumerate the mayhem program's accounts ------
  try {
    const mayhemAccounts = await connection.getProgramAccounts(MAYHEM, {
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
    });
    report.mayhemProgram = {
      accountCount: mayhemAccounts.length,
      sample: mayhemAccounts.slice(0, 10).map((a) => a.pubkey.toBase58()),
    };
    await sleep(400);
    // Sizes tell the account types apart; fetch a handful in full.
    const detail = await connection.getMultipleAccountsInfo(
      mayhemAccounts.slice(0, 10).map((a) => a.pubkey)
    );
    report.mayhemProgram.sampleDetail = detail.map((info, index) => ({
      address: mayhemAccounts[index].pubkey.toBase58(),
      size: info?.data.length,
      discriminator: info?.data.subarray(0, 8).toString("hex"),
      // mayhem_state layout is unknown; dump candidate embedded pubkeys.
      pubkeyAt8: info && info.data.length >= 40
        ? new PublicKey(info.data.subarray(8, 40)).toBase58()
        : undefined,
      pubkeyAt40: info && info.data.length >= 72
        ? new PublicKey(info.data.subarray(40, 72)).toBase58()
        : undefined,
    }));
  } catch (error) {
    report.mayhemProgram = {
      error: `getProgramAccounts refused: ${String(error).slice(0, 200)}`,
    };
  }

  await sleep(400);

  // ---- 3. Real tokenized-agent coins --------------------------------------
  try {
    const agentAccounts = await connection.getProgramAccounts(AGENT_PAYMENTS, {
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
    });
    report.agentProgram = {
      accountCount: agentAccounts.length,
      sample: agentAccounts.slice(0, 10).map((a) => a.pubkey.toBase58()),
    };
  } catch (error) {
    report.agentProgram = {
      error: `getProgramAccounts refused: ${String(error).slice(0, 200)}`,
    };
  }

  await sleep(400);

  // ---- 4. Recent live launches: measure real flag prevalence --------------
  // Jupiter's recent list gives real, current pump mints; their curves are
  // the ground truth for the flag offsets.
  const curves: any[] = [];
  try {
    const recent = await fetchJson<any[]>(
      "https://lite-api.jup.ag/tokens/v2/recent"
    );
    const pumpMints = recent
      .filter((t) => typeof t.id === "string" && t.id.endsWith("pump"))
      .slice(0, 25)
      .map((t) => ({ mint: new PublicKey(t.id), symbol: t.symbol }));
    report.recentSampleSize = pumpMints.length;

    for (let i = 0; i < pumpMints.length; i += 5) {
      const batch = pumpMints.slice(i, i + 5);
      const infos = await connection.getMultipleAccountsInfo(
        batch.map((c) => bondingCurvePda(c.mint))
      );
      const mintInfos = await connection.getMultipleAccountsInfo(
        batch.map((c) => c.mint)
      );
      batch.forEach((c, j) => {
        const info = infos[j];
        if (!info) return;
        curves.push({
          symbol: c.symbol,
          mint: c.mint.toBase58(),
          mintOwner: mintInfos[j]?.owner.toBase58(),
          curve: rawCurve(info.data),
        });
      });
      await sleep(500);
    }
  } catch (error) {
    report.recentError = String(error).slice(0, 200);
  }
  report.recentCurves = curves;
  report.flagTally = {
    total: curves.length,
    mayhem: curves.filter((c) => c.curve.is_mayhem_mode_off81 === 1).length,
    cashback: curves.filter((c) => c.curve.is_cashback_coin_off82 === 1).length,
    nonDefaultQuote: curves.filter(
      (c) =>
        c.curve.quote_mint_off83 !== PublicKey.default.toBase58()
    ).length,
    token2022Mints: curves.filter(
      (c) => c.mintOwner === TOKEN_2022.toBase58()
    ).length,
    sizes: [...new Set(curves.map((c) => c.curve.size))],
  };

  // ---- 5. If a real mayhem mint surfaced, inspect it fully ----------------
  const candidateMints: string[] = [];
  for (const d of report.mayhemProgram?.sampleDetail ?? []) {
    for (const key of [d.pubkeyAt8, d.pubkeyAt40]) {
      if (!key) continue;
      candidateMints.push(key);
    }
  }
  report.mayhemMintProbes = [];
  for (const candidate of candidateMints.slice(0, 6)) {
    try {
      const mint = new PublicKey(candidate);
      const curveInfo = await connection.getAccountInfo(
        bondingCurvePda(mint),
        "confirmed"
      );
      if (!curveInfo) continue;
      const mintInfo = await connection.getAccountInfo(mint, "confirmed");
      report.mayhemMintProbes.push({
        mint: candidate,
        curve: rawCurve(curveInfo.data),
        mintState: mintInfo
          ? describeMint(mintInfo.owner, mintInfo.data)
          : null,
        mayhemState: mayhemStatePda(mint).toBase58(),
      });
      await sleep(400);
    } catch {
      /* not a mint */
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
