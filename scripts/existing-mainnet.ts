/**
 * Existing-token path against live mainnet (read + simulate only).
 * Same resolver the Existing page's burn service uses. Does not send a tx.
 *
 *   npx tsx scripts/existing-mainnet.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DEFAULT_BURNER_PROGRAM,
  deriveVault,
} from "../quote-service/core";
import {
  type AccountDataReader,
  resolveReference,
} from "../quote-service/reference";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

const JTO = "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const NEIRO = "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump";

const LEGS: { symbol: string; mint: string; bps: number; pool: string }[] = [
  {
    symbol: "JTO",
    mint: JTO,
    bps: 8_000,
    pool: "JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo",
  },
  {
    symbol: "$PUMP",
    mint: PUMP,
    bps: 1_000,
    pool: "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5",
  },
  {
    symbol: "NEIRO",
    mint: NEIRO,
    bps: 1_000,
    pool: "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV",
  },
];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const reader: AccountDataReader = {
    async getAccountData(address: PublicKey) {
      const info = await connection.getAccountInfo(address, "confirmed");
      return info ? { owner: info.owner, data: info.data } : null;
    },
  };

  const programInfo = await connection.getAccountInfo(
    DEFAULT_BURNER_PROGRAM,
    "confirmed"
  );
  check(
    "burner program deployed on mainnet",
    programInfo !== null && programInfo.executable,
    programInfo
      ? `${programInfo.data.length} bytes`
      : "MISSING — cannot land setup or burns until pnpm deploy:mainnet"
  );

  const launch = new PublicKey(JTO);
  const launchInfo = await connection.getAccountInfo(launch, "confirmed");
  check("JTO mint exists (Existing namespace)", launchInfo !== null);

  const resolved = [];
  for (const leg of LEGS) {
    const pool = leg.pool;
    check(`shipped pool for ${leg.symbol}`, !!pool, pool);
    const reference = await resolveReference(
      reader,
      new PublicKey(leg.mint),
      new PublicKey(pool)
    );
    check(
      `${leg.symbol} live resolve`,
      reference.depthLamports >= 50_000_000_000n,
      `${reference.venue} depth=${(Number(reference.depthLamports) / 1e9).toFixed(
        1
      )} SOL cap=${(Number(reference.capLamports) / 1e9).toFixed(3)} SOL`
    );
    resolved.push({
      targetMint: new PublicKey(leg.mint),
      bps: leg.bps,
      refSeed: reference.seed,
    });
  }

  const vault = deriveVault(DEFAULT_BURNER_PROGRAM, launch, resolved);
  console.log(`      derived vault ${vault.toBase58()}`);
  check("vault PDA derived", PublicKey.isOnCurve(vault.toBytes()) === false);

  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  check(
    "this test vault is not already funded on mainnet",
    vaultInfo === null || vaultInfo.lamports === 0,
    vaultInfo ? `${vaultInfo.lamports} lamports` : "uninitialized (expected)"
  );

  if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nExisting-token off-chain path works against live mainnet state.");
  if (!programInfo) {
    console.log("On-chain setup/burn blocked: program is not deployed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
