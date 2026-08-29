#!/usr/bin/env -S npx tsx
/** Create the reusable app-wide ALT that compresses Pump launch setup. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  SETUP_LOOKUP_TABLE_ADDRESSES,
  SETUP_LOOKUP_TABLE_KEYS,
} from "../app/src/chain/setupLookupTable";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const ALT_META_BYTES = 56;

type Options = {
  dryRun: boolean;
  allowNonMainnet: boolean;
  promptKeypair: boolean;
  keypairPath?: string;
  rpcUrl?: string;
};

function help(): never {
  process.stdout.write(`Usage: pnpm create:setup-lut [options]

Creates and verifies the reusable launch-setup address lookup table.

Options:
  --keypair <path>       JSON keypair (defaults to Solana CLI config)
  --prompt-keypair       Read a base58 or 64-byte JSON secret without echoing
  --rpc <url>            RPC URL (defaults to Solana CLI config, then mainnet)
  --dry-run              Derive and measure only; send nothing
  --allow-non-mainnet    Explicitly permit a non-mainnet cluster
  --help                 Show this help
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    allowNonMainnet: false,
    promptKeypair: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") help();
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--prompt-keypair") options.promptKeypair = true;
    else if (arg === "--allow-non-mainnet") options.allowNonMainnet = true;
    else if (arg === "--keypair" || arg === "--rpc") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--keypair") options.keypairPath = value;
      else options.rpcUrl = value;
    } else if (arg !== "--dry-run") {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (options.promptKeypair && options.keypairPath) {
    throw new Error("use either --prompt-keypair or --keypair, not both");
  }
  return options;
}

async function cliDefaults(): Promise<{
  keypairPath?: string;
  rpcUrl?: string;
}> {
  try {
    const text = await readFile(
      resolve(homedir(), ".config/solana/cli/config.yml"),
      "utf8"
    );
    const pick = (name: string) =>
      text
        .match(new RegExp(`^${name}:\\s*["']?([^\\r\\n"']+)`, "m"))?.[1]
        ?.trim();
    return { keypairPath: pick("keypair_path"), rpcUrl: pick("json_rpc_url") };
  } catch {
    return {};
  }
}

async function loadKeypair(path: string): Promise<Keypair> {
  const raw: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (
    !Array.isArray(raw) ||
    raw.length !== 64 ||
    raw.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
  ) {
    throw new Error("keypair file must contain exactly 64 JSON byte values");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function decodeBase58(value: string): Uint8Array {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("secret is not valid base58");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  bytes.reverse();
  for (let index = 0; index < value.length && value[index] === "1"; index++) {
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function keypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    const raw: unknown = JSON.parse(trimmed);
    if (
      !Array.isArray(raw) ||
      raw.length !== 64 ||
      raw.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
    ) {
      throw new Error("secret must be a base58 key or exactly 64 JSON bytes");
    }
    bytes = Uint8Array.from(raw);
  } else {
    bytes = decodeBase58(trimmed);
    if (bytes.length !== 64) {
      throw new Error("base58 secret must decode to exactly 64 bytes");
    }
  }
  return Keypair.fromSecretKey(bytes);
}

async function promptForKeypair(): Promise<Keypair> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("--prompt-keypair requires an interactive terminal");
  }
  process.stderr.write("Paying key (base58 or 64-byte JSON; hidden): ");
  const secret = await new Promise<string>((resolveSecret, rejectSecret) => {
    let input = "";
    const stdin = process.stdin;
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(input);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          input = input.slice(0, -1);
        } else {
          input += character;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
  return keypairFromSecret(secret);
}

async function send(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const validity = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: validity.blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: false,
    }
  );
  const result = await connection.confirmTransaction(
    { signature, ...validity },
    "confirmed"
  );
  if (result.value.err) throw new Error("lookup-table transaction failed");
  return signature;
}

async function waitForExactTable(
  connection: Connection,
  table: PublicKey
): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const [slot, response] = await Promise.all([
      connection.getSlot("confirmed"),
      connection.getAddressLookupTable(table, { commitment: "confirmed" }),
    ]);
    const value = response.value;
    if (value && value.state.lastExtendedSlot < slot) {
      const actual = value.state.addresses.map((key) => key.toBase58());
      const exact =
        actual.length === SETUP_LOOKUP_TABLE_ADDRESSES.length &&
        actual.every(
          (address, index) => address === SETUP_LOOKUP_TABLE_ADDRESSES[index]
        );
      if (!exact)
        throw new Error("created lookup table content did not verify");
      const info = await connection.getAccountInfo(table, "confirmed");
      if (!info) throw new Error("created lookup table account disappeared");
      return info.lamports;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("lookup table did not activate within 30 seconds");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const defaults = await cliDefaults();
  const keypairPath = options.keypairPath ?? defaults.keypairPath;
  if (!options.promptKeypair && !keypairPath) {
    throw new Error("no --keypair and no keypair_path in Solana CLI config");
  }
  const payer = options.promptKeypair
    ? await promptForKeypair()
    : await loadKeypair(keypairPath!);
  const rpcUrl =
    options.rpcUrl ?? defaults.rpcUrl ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !options.allowNonMainnet) {
    throw new Error(
      "refusing non-mainnet RPC; pass --allow-non-mainnet explicitly"
    );
  }
  const recentSlot = await connection.getSlot("finalized");
  const [createInstruction, table] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });
  const rentEstimate = await connection.getMinimumBalanceForRentExemption(
    ALT_META_BYTES + 32 * SETUP_LOOKUP_TABLE_KEYS.length,
    "confirmed"
  );

  process.stdout.write(`Payer: ${payer.publicKey.toBase58()}\n`);
  process.stdout.write(`LUT: ${table.toBase58()}\n`);
  process.stdout.write(`Rent: ${rentEstimate} lamports\n`);

  if (options.dryRun) {
    process.stdout.write("Create signature: dry-run\n");
    process.stdout.write("Extend signature: dry-run\n");
    return;
  }

  const createSignature = await send(connection, payer, [createInstruction]);
  process.stdout.write(`Create signature: ${createSignature}\n`);
  const extendInstruction = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: table,
    addresses: SETUP_LOOKUP_TABLE_KEYS,
  });
  const extendSignature = await send(connection, payer, [extendInstruction]);
  process.stdout.write(`Extend signature: ${extendSignature}\n`);
  const actualRent = await waitForExactTable(connection, table);
  if (actualRent !== rentEstimate) {
    throw new Error("lookup table rent did not match the verified account");
  }
}

main().catch((error) => {
  // Never include CLI options, file contents, or the RPC URL in diagnostics.
  const message = String((error as Error).message ?? error)
    .replace(/https?:\/\/\S+/g, "[rpc]")
    .slice(0, 300);
  process.stderr.write(`setup LUT failed: ${message}\n`);
  process.exitCode = 1;
});
