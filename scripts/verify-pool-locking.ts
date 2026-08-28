#!/usr/bin/env npx tsx
/**
 * Chain-state liquidity durability verifier.
 *
 * Usage:
 *   npx tsx scripts/verify-pool-locking.ts <POOL>
 *   npx tsx scripts/verify-pool-locking.ts <POOL> --rpc <HTTPS_RPC>
 *
 * The verdict comes only from quote-service/markets.ts. Largest-holder data
 * is printed as corroborating evidence and never upgrades a verdict.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
// Preserve the quote service's established import order (server.ts imports
// core before markets) so its existing core/reference/directcurve cycle is
// fully initialised before markets loads.
import "../quote-service/core";
import { inspectPoolLocking } from "../quote-service/markets";
import type {
  CustodyEvidence,
  PoolLockingReport,
} from "../quote-service/markets";
import type { AccountDataReader } from "../quote-service/reference";

type Args = Readonly<{
  pool: PublicKey;
  rpcUrl: string;
  includeHolders: boolean;
}>;

type HolderEntry = Readonly<{
  address: string;
  amount: string;
  decimals: number;
}>;

type HolderSnapshot = Readonly<{
  fetchedAt: string;
  contextSlot: number;
  source: "getTokenLargestAccounts" | "getProgramAccounts-fallback";
  entries: readonly HolderEntry[];
}>;

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "usage: npx tsx scripts/verify-pool-locking.ts <POOL> [--rpc <HTTPS_RPC>] [--no-holders]"
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  let poolText: string | undefined;
  let rpcUrl =
    process.env.MAINNET_RPC_URL ??
    process.env.SOLANA_RPC_URL ??
    process.env.RPC_URL ??
    "https://api.mainnet-beta.solana.com";
  let includeHolders = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rpc") {
      rpcUrl = argv[++index] ?? usage("--rpc requires a URL");
    } else if (arg === "--no-holders") {
      includeHolders = false;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (!poolText) {
      poolText = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }
  if (!poolText) usage("pool address is required");
  let pool: PublicKey;
  try {
    pool = new PublicKey(poolText);
  } catch {
    usage(`invalid pool address: ${poolText}`);
  }
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.protocol !== "https:" && parsedRpc.hostname !== "127.0.0.1") {
    usage("RPC must be HTTPS (or local 127.0.0.1)");
  }
  return { pool, rpcUrl, includeHolders };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cachePath(mint: PublicKey, rpcUrl: string): string {
  const directory =
    process.env.POOL_LOCK_CACHE_DIR ??
    join(tmpdir(), "onchainburner-pool-locking");
  // Do not let a local/fork response masquerade as mainnet evidence when the
  // same mint is checked against another endpoint within the cache window.
  const endpoint = createHash("sha256")
    .update(rpcUrl)
    .digest("hex")
    .slice(0, 12);
  return join(directory, `${mint.toBase58()}-${endpoint}.json`);
}

async function readHolderCache(
  mint: PublicKey,
  rpcUrl: string,
  maxAgeMs = 5 * 60_000
): Promise<HolderSnapshot | null> {
  try {
    const parsed = JSON.parse(
      await readFile(cachePath(mint, rpcUrl), "utf8")
    ) as HolderSnapshot | undefined;
    if (
      !parsed ||
      !Array.isArray(parsed.entries) ||
      Date.now() - Date.parse(parsed.fetchedAt) > maxAgeMs
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeHolderCache(
  mint: PublicKey,
  rpcUrl: string,
  snapshot: HolderSnapshot
): Promise<void> {
  const path = cachePath(mint, rpcUrl);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function getLargestHolders(
  connection: Connection,
  mint: PublicKey,
  rpcUrl: string
): Promise<HolderSnapshot> {
  const cached = await readHolderCache(mint, rpcUrl);
  if (cached) return cached;

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await connection.getTokenLargestAccounts(
        mint,
        "confirmed"
      );
      const snapshot: HolderSnapshot = {
        fetchedAt: new Date().toISOString(),
        contextSlot: response.context.slot,
        source: "getTokenLargestAccounts",
        entries: response.value.map((item) => ({
          address: item.address.toBase58(),
          amount: item.amount,
          decimals: item.decimals,
        })),
      };
      await writeHolderCache(mint, rpcUrl, snapshot).catch(() => undefined);
      return snapshot;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(750 * 2 ** attempt);
    }
  }

  // Some public RPCs rate-limit getTokenLargestAccounts specifically. A
  // mint-filtered token-program scan is slower but independently complete.
  try {
    const response = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint.toBase58() } },
      ],
    });
    const entries = response
      .filter((item) => item.account.data.length >= 72)
      .map((item) => ({
        address: item.pubkey.toBase58(),
        amount: item.account.data.readBigUInt64LE(64).toString(),
        decimals: 0,
      }))
      .sort((a, b) => {
        const amountA = BigInt(a.amount);
        const amountB = BigInt(b.amount);
        return amountA === amountB ? 0 : amountA > amountB ? -1 : 1;
      })
      .slice(0, 20);
    const snapshot: HolderSnapshot = {
      fetchedAt: new Date().toISOString(),
      contextSlot: await connection.getSlot("confirmed"),
      source: "getProgramAccounts-fallback",
      entries,
    };
    await writeHolderCache(mint, rpcUrl, snapshot).catch(() => undefined);
    return snapshot;
  } catch (fallbackError) {
    throw new Error(
      `largest-holder reads failed after backoff (${String(
        lastError
      )}); token-program fallback also failed (${String(fallbackError)})`
    );
  }
}

function custodyLabel(evidence: CustodyEvidence): string {
  if (evidence.mechanism === "raydium-burn-and-earn") {
    return "Raydium Burn & Earn";
  }
  return "Solana incinerator";
}

function verdictLabel(report: PoolLockingReport): string {
  if (report.verdict === "burned" || report.verdict === "locked-by-custody") {
    return "LOCKED";
  }
  return report.verdict === "not-locked" ? "NOT LOCKED" : "UNVERIFIABLE";
}

function printEvidence(report: PoolLockingReport): void {
  console.log("Pool locking evidence");
  console.log(`  pool:             ${report.pool}`);
  console.log(`  pool owner:       ${report.poolOwner}`);
  console.log(`  venue:            ${report.venue}`);
  console.log(`  SOL depth atoms:  ${report.depthLamports}`);
  if (report.lpMint) console.log(`  LP mint:          ${report.lpMint}`);
  if (report.issuedLpAtoms !== undefined) {
    console.log(`  pool-issued LP:   ${report.issuedLpAtoms}`);
  }
  if (report.liveLpSupplyAtoms !== undefined) {
    console.log(`  live mint supply: ${report.liveLpSupplyAtoms}`);
  }
  if (report.burnedLpAtoms !== undefined) {
    console.log(`  burned LP:        ${report.burnedLpAtoms}`);
  }
  for (const item of report.custody) {
    console.log(`  custody:          ${custodyLabel(item)} [${item.status}]`);
    if (item.program) console.log(`    program:        ${item.program}`);
    console.log(`    authority:      ${item.authority}`);
    console.log(`    token account:  ${item.tokenAccount}`);
    if (item.amountAtoms !== undefined) {
      console.log(`    LP atoms:       ${item.amountAtoms}`);
    }
    console.log(`    check:          ${item.reason}`);
  }
  if (report.nonWithdrawableLpAtoms !== undefined) {
    console.log(
      `  non-withdrawable: ${report.nonWithdrawableLpAtoms} LP atoms`
    );
  }
  if (report.lockedPct !== undefined) {
    console.log(`  locked percent:   ${report.lockedPct.toFixed(4)}%`);
  }
  if (report.lockedDepthLamports !== undefined) {
    console.log(`  locked SOL depth: ${report.lockedDepthLamports} lamports`);
  }
  console.log(`  reason:           ${report.reason}`);
}

async function printTopHolders(
  connection: Connection,
  rpcUrl: string,
  mint: PublicKey,
  report: PoolLockingReport
): Promise<void> {
  const snapshot = await getLargestHolders(connection, mint, rpcUrl);
  if (snapshot.entries.length === 0) {
    console.log("");
    console.log(
      `Top LP holders: none returned (${snapshot.source}, slot ${snapshot.contextSlot})`
    );
    return;
  }
  const addresses = snapshot.entries.map((item) => new PublicKey(item.address));
  const infos = await connection.getMultipleAccountsInfo(
    addresses,
    "confirmed"
  );
  const authorities = infos.map((info) =>
    info && info.owner.equals(TOKEN_PROGRAM_ID) && info.data.length >= 64
      ? new PublicKey(info.data.subarray(32, 64))
      : null
  );
  const uniqueAuthorities = [
    ...new Map(
      authorities
        .filter((item): item is PublicKey => item !== null)
        .map((item) => [item.toBase58(), item])
    ).values(),
  ];
  const authorityInfos = uniqueAuthorities.length
    ? await connection.getMultipleAccountsInfo(uniqueAuthorities, "confirmed")
    : [];
  const authorityInfoByKey = new Map(
    uniqueAuthorities.map((key, index) => [
      key.toBase58(),
      authorityInfos[index],
    ])
  );
  const recognisedByAccount = new Map(
    report.custody
      .filter((item) => item.status === "verified")
      .map((item) => [item.tokenAccount, custodyLabel(item)])
  );
  const supply = report.liveLpSupplyAtoms
    ? BigInt(report.liveLpSupplyAtoms)
    : null;

  console.log("");
  console.log(
    `Top LP holders (${snapshot.source}, slot ${snapshot.contextSlot}, cached ${snapshot.fetchedAt})`
  );
  snapshot.entries.forEach((entry, index) => {
    const info = infos[index];
    const authority = authorities[index];
    const authorityInfo = authority
      ? authorityInfoByKey.get(authority.toBase58())
      : null;
    const recognised = recognisedByAccount.get(entry.address);
    const share =
      supply && supply > 0n
        ? Number((BigInt(entry.amount) * 1_000_000n) / supply) / 10_000
        : undefined;
    console.log(
      `  ${String(index + 1).padStart(2)}. ${entry.address}  ${
        entry.amount
      } atoms${share === undefined ? "" : ` (${share.toFixed(4)}%)`}`
    );
    console.log(
      `      account program owner: ${
        info?.owner.toBase58() ?? "missing"
      }; token authority: ${authority?.toBase58() ?? "unparseable"}`
    );
    if (authority) {
      const authorityKind = PublicKey.isOnCurve(authority.toBuffer())
        ? "on-curve signer"
        : authorityInfo
        ? `off-curve/account owned by ${authorityInfo.owner.toBase58()}`
        : "off-curve, unallocated PDA/address";
      console.log(`      authority kind: ${authorityKind}`);
    }
    console.log(
      `      recognised locker: ${recognised ?? "no positive match"}`
    );
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpcUrl, {
    commitment: "confirmed",
    // This script owns the bounded exponential backoff. Disable web3.js's
    // hidden retry loop so a rate-limited largest-holder call cannot hang for
    // minutes before our fallback gets a chance.
    disableRetryOnRateLimit: true,
  });
  const startSlot = await connection.getSlot("confirmed");
  const reader: AccountDataReader = {
    async getAccountData(address) {
      const info = await connection.getAccountInfo(address, "confirmed");
      return info
        ? {
            owner: info.owner,
            data: Buffer.from(info.data),
            lamports: BigInt(info.lamports),
          }
        : null;
    },
  };
  const report = await inspectPoolLocking(reader, args.pool);
  const endSlot = await connection.getSlot("confirmed");
  printEvidence(report);
  console.log(`  observation slots: ${startSlot}..${endSlot}`);

  if (args.includeHolders && report.lpMint) {
    try {
      await printTopHolders(
        connection,
        args.rpcUrl,
        new PublicKey(report.lpMint),
        report
      );
    } catch (error) {
      console.log("");
      console.log(
        `Top LP holders: UNAVAILABLE (${
          error instanceof Error ? error.message : String(error)
        })`
      );
      console.log(
        "  Holder-list failure does not upgrade or downgrade the verdict."
      );
    }
  }

  console.log("");
  console.log(`VERDICT: ${verdictLabel(report)} (${report.verdict})`);
  console.log(`EVIDENCE: ${report.reason}`);
  if (report.verdict === "unverified") process.exitCode = 3;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
