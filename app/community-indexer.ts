/**
 * Finalized on-chain projection for the Community Vaults leaderboard.
 *
 * The indexer trusts only successful top-level calls to the deployed burner
 * and the burner's own sol_log_64 records. Every row is keyed by transaction,
 * instruction, and leg, so retries and overlapping cron scans are idempotent.
 */

export const BURNER_PROGRAM =
  "burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5";
const SPLIT_DISCRIMINATOR = Uint8Array.from([
  157, 45, 186, 225, 142, 17, 2, 105,
]);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SIGNATURE_PAGE = 100;
const MAX_INCREMENTAL_PAGES = 5;
const RPC_RESPONSE_CAP = 12_000_000;

type CommunityEnv = Pick<Env, "SOLANA_RPC_URL" | "COMMUNITY_DB">;

type SignatureRow = Readonly<{
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}>;

type CompiledInstruction = Readonly<{
  programIdIndex: number;
  accounts: readonly number[];
  data: string;
}>;

type TransactionResult = Readonly<{
  slot: number;
  blockTime: number | null;
  meta: Readonly<{
    err: unknown;
    logMessages: readonly string[] | null;
    loadedAddresses?: Readonly<{
      writable: readonly string[];
      readonly: readonly string[];
    }>;
  }> | null;
  transaction: Readonly<{
    message: Readonly<{
      accountKeys: readonly string[];
      instructions: readonly CompiledInstruction[];
    }>;
  }>;
}>;

export type IndexedBurnLeg = Readonly<{
  signature: string;
  instructionIndex: number;
  legIndex: number;
  slot: number;
  blockTime: number | null;
  launchMint: string;
  vault: string;
  targetMint: string;
  referencePool: string;
  bps: number;
  solLamports: string;
  burnedAtoms: string;
}>;

function decodeBase58(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const littleEndian = [0];
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new Error("invalid base58");
    let carry = digit;
    for (let index = 0; index < littleEndian.length; index += 1) {
      const next = littleEndian[index] * 58 + carry;
      littleEndian[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      littleEndian.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length - 1 && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  return Uint8Array.from([
    ...new Array<number>(leadingZeroes).fill(0),
    ...littleEndian.reverse(),
  ]);
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error("truncated u16");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("truncated u32");
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) throw new Error("truncated u64");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function decodeSplit(data: string):
  | Readonly<{ total: bigint; weights: readonly number[] }>
  | undefined {
  try {
    const bytes = decodeBase58(data);
    if (
      bytes.length < 20 ||
      !sameBytes(bytes.subarray(0, 8), SPLIT_DISCRIMINATOR)
    ) {
      return undefined;
    }
    const total = readU64(bytes, 8);
    const legCount = readU32(bytes, 16);
    if (legCount < 1 || legCount > 4 || total === 0n) return undefined;
    const weights: number[] = [];
    let cursor = 20;
    for (let leg = 0; leg < legCount; leg += 1) {
      const bps = readU16(bytes, cursor);
      const routeLength = readU32(bytes, cursor + 11);
      cursor += 15;
      if (routeLength > bytes.length - cursor) return undefined;
      cursor += routeLength;
      weights.push(bps);
    }
    if (cursor !== bytes.length) return undefined;
    if (
      weights.some((weight) => weight <= 0) ||
      weights.reduce((sum, weight) => sum + weight, 0) !== 10_000
    ) {
      return undefined;
    }
    return { total, weights };
  } catch {
    return undefined;
  }
}

function splitAmounts(total: bigint, weights: readonly number[]): bigint[] {
  const amounts: bigint[] = [];
  let assigned = 0n;
  const quotient = total / 10_000n;
  const remainder = total % 10_000n;
  for (let index = 0; index < weights.length; index += 1) {
    const amount =
      index + 1 === weights.length
        ? total - assigned
        : quotient * BigInt(weights[index]) +
          (remainder * BigInt(weights[index])) / 10_000n;
    amounts.push(amount);
    assigned += amount;
  }
  return amounts;
}

/** One `(SOL input, token atoms burned)` group per top-level burner call. */
function burnLogGroups(logs: readonly string[]): readonly (readonly bigint[])[] {
  const stack: string[] = [];
  const groups: bigint[][] = [];
  let active: bigint[] | undefined;
  for (const line of logs) {
    const invoke = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/);
    if (invoke) {
      const depth = Number(invoke[2]);
      stack.length = Math.max(0, depth - 1);
      stack.push(invoke[1]);
      if (depth === 1 && invoke[1] === BURNER_PROGRAM) {
        active = [];
        groups.push(active);
      }
      continue;
    }
    if (active && stack.at(-1) === BURNER_PROGRAM) {
      const values = line.match(
        /^Program log: 0x0, 0x0, 0x0, 0x([0-9a-fA-F]+), 0x([0-9a-fA-F]+)$/
      );
      if (values) {
        // The fourth value is independently derived from instruction data;
        // retain only burned atoms here and compare the input below.
        active.push(BigInt(`0x${values[1]}`), BigInt(`0x${values[2]}`));
      }
    }
    const finished = line.match(
      /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed: .+)$/
    );
    if (finished) {
      const wasTopLevelBurn =
        stack.length === 1 && finished[1] === BURNER_PROGRAM;
      if (stack.at(-1) === finished[1]) stack.pop();
      if (wasTopLevelBurn) active = undefined;
    }
  }
  // validate_config and any future read-only top-level instruction produce no
  // burn record. Exclude those groups so log groups align only with decoded
  // split instructions in a transaction containing more than one call.
  return groups.filter((group) => group.length > 0);
}

export function decodeBurnTransaction(
  signature: string,
  transaction: TransactionResult
): IndexedBurnLeg[] {
  if (!transaction.meta || transaction.meta.err !== null) return [];
  const message = transaction.transaction.message;
  const accountKeys = [
    ...message.accountKeys,
    ...(transaction.meta.loadedAddresses?.writable ?? []),
    ...(transaction.meta.loadedAddresses?.readonly ?? []),
  ];
  const calls = message.instructions
    .map((instruction, instructionIndex) => ({ instruction, instructionIndex }))
    .filter(({ instruction }) => accountKeys[instruction.programIdIndex] === BURNER_PROGRAM);
  const logGroups = burnLogGroups(transaction.meta.logMessages ?? []);
  const rows: IndexedBurnLeg[] = [];
  let burnCall = 0;
  for (const { instruction, instructionIndex } of calls) {
    const split = decodeSplit(instruction.data);
    if (!split) continue;
    const logs = logGroups[burnCall++];
    const amounts = splitAmounts(split.total, split.weights);
    if (!logs || logs.length !== split.weights.length * 2) continue;
    if (instruction.accounts.length < 8 + split.weights.length * 7) continue;
    const launchMint = accountKeys[instruction.accounts[4]];
    const vault = accountKeys[instruction.accounts[2]];
    if (!launchMint || !vault) continue;
    const candidate: IndexedBurnLeg[] = [];
    let valid = true;
    for (let legIndex = 0; legIndex < split.weights.length; legIndex += 1) {
      const targetMint = accountKeys[instruction.accounts[8 + legIndex * 7]];
      const referencePool =
        accountKeys[instruction.accounts[11 + legIndex * 7]];
      const loggedInput = logs[legIndex * 2];
      const burnedAtoms = logs[legIndex * 2 + 1];
      if (
        !targetMint ||
        !referencePool ||
        loggedInput !== amounts[legIndex] ||
        burnedAtoms <= 0n
      ) {
        valid = false;
        break;
      }
      candidate.push({
        signature,
        instructionIndex,
        legIndex,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
        launchMint,
        vault,
        targetMint,
        referencePool,
        bps: split.weights[legIndex],
        solLamports: amounts[legIndex].toString(),
        burnedAtoms: burnedAtoms.toString(),
      });
    }
    if (valid) rows.push(...candidate);
  }
  return rows;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`RPC_HTTP_${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > RPC_RESPONSE_CAP) {
    await response.body?.cancel();
    throw new Error("RPC_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > RPC_RESPONSE_CAP) {
      await reader.cancel("response too large");
      throw new Error("RPC_RESPONSE_TOO_LARGE");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function rpc(env: CommunityEnv, body: unknown): Promise<unknown> {
  const response = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("RPC_REDIRECTED");
  }
  return boundedJson(response);
}

async function signaturePage(
  env: CommunityEnv,
  options: Readonly<{ before?: string; until?: string }>
): Promise<SignatureRow[]> {
  const response = (await rpc(env, {
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [
      BURNER_PROGRAM,
      {
        commitment: "finalized",
        limit: SIGNATURE_PAGE,
        ...(options.before ? { before: options.before } : {}),
        ...(options.until ? { until: options.until } : {}),
      },
    ],
  })) as { result?: unknown; error?: unknown };
  if (response.error || !Array.isArray(response.result)) {
    throw new Error("RPC_SIGNATURES_INVALID");
  }
  return response.result.filter(
    (value): value is SignatureRow =>
      !!value &&
      typeof value === "object" &&
      typeof (value as SignatureRow).signature === "string" &&
      Number.isSafeInteger((value as SignatureRow).slot)
  );
}

async function fetchTransactions(
  env: CommunityEnv,
  signatures: readonly SignatureRow[]
): Promise<Map<string, TransactionResult>> {
  const out = new Map<string, TransactionResult>();
  for (let offset = 0; offset < signatures.length; offset += 10) {
    const chunk = signatures.slice(offset, offset + 10);
    const response = (await rpc(
      env,
      chunk.map((row, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "getTransaction",
        params: [
          row.signature,
          {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }))
    )) as readonly { id?: number; result?: unknown; error?: unknown }[];
    if (!Array.isArray(response)) throw new Error("RPC_TRANSACTIONS_INVALID");
    for (const item of response) {
      if (
        !item.error &&
        Number.isInteger(item.id) &&
        item.id! >= 1 &&
        item.id! <= chunk.length &&
        item.result &&
        typeof item.result === "object"
      ) {
        out.set(chunk[item.id! - 1].signature, item.result as TransactionResult);
      }
    }
    // A finalized signature can still be transiently absent from an RPC
    // batch. Advancing the cursor past it would make that burn disappear from
    // rankings forever, so fail this complete cron run before any rows or
    // cursor state are written. The next scheduled run retries idempotently.
    const missing = missingTransactionSignatures(
      chunk.map((row) => row.signature),
      new Set(out.keys())
    );
    if (missing.length) throw new Error("RPC_TRANSACTIONS_INCOMPLETE");
  }
  return out;
}

/** Pure guard kept exported so cursor-safety has a regression fixture. */
export function missingTransactionSignatures(
  expected: readonly string[],
  fetched: ReadonlySet<string>
): string[] {
  return expected.filter((signature) => !fetched.has(signature));
}

async function refreshMintSupplies(
  env: CommunityEnv,
  mints: readonly string[]
): Promise<void> {
  const unique = [...new Set(mints)];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const chunk = unique.slice(offset, offset + 20);
    const response = await rpc(
      env,
      chunk.map((mint, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "getTokenSupply",
        params: [mint, { commitment: "finalized" }],
      }))
    );
    if (!Array.isArray(response)) throw new Error("RPC_SUPPLIES_INVALID");
    const statements: D1PreparedStatement[] = [];
    for (const item of response as readonly {
      id?: number;
      error?: unknown;
      result?: { value?: { amount?: unknown; decimals?: unknown } };
    }[]) {
      const mint = Number.isInteger(item.id) ? chunk[item.id! - 1] : undefined;
      const amount = item.result?.value?.amount;
      const decimals = item.result?.value?.decimals;
      if (
        !item.error &&
        mint &&
        typeof amount === "string" &&
        /^\d+$/.test(amount) &&
        Number.isInteger(decimals) &&
        Number(decimals) >= 0 &&
        Number(decimals) <= 255
      ) {
        statements.push(
          env.COMMUNITY_DB.prepare(
            `INSERT OR REPLACE INTO token_mints
             (mint, decimals, current_supply_atoms, updated_at)
             VALUES (?, ?, ?, ?)`
          ).bind(mint, decimals, amount, Math.floor(Date.now() / 1_000))
        );
      }
    }
    if (statements.length) await env.COMMUNITY_DB.batch(statements);
  }
}

async function state(env: CommunityEnv): Promise<Record<string, string>> {
  const result = await env.COMMUNITY_DB.prepare(
    "SELECT key, value FROM index_state"
  ).all<{ key: string; value: string }>();
  return Object.fromEntries(result.results.map((row) => [row.key, row.value]));
}

async function storeRows(
  env: CommunityEnv,
  rows: readonly IndexedBurnLeg[]
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 50) {
    await env.COMMUNITY_DB.batch(
      rows.slice(offset, offset + 50).map((row) =>
        env.COMMUNITY_DB.prepare(
          `INSERT OR IGNORE INTO burn_legs
           (signature, instruction_index, leg_index, slot, block_time,
            launch_mint, vault, target_mint, reference_pool, bps,
            sol_lamports, burned_atoms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          row.signature,
          row.instructionIndex,
          row.legIndex,
          row.slot,
          row.blockTime,
          row.launchMint,
          row.vault,
          row.targetMint,
          row.referencePool,
          row.bps,
          row.solLamports,
          row.burnedAtoms
        )
      )
    );
  }
}

export async function indexFinalizedBurns(env: CommunityEnv): Promise<{
  signatures: number;
  legs: number;
}> {
  const prior = await state(env);
  const latest = prior.latest_signature || undefined;
  const signatures: SignatureRow[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_INCREMENTAL_PAGES; page += 1) {
    const next = await signaturePage(env, { before, until: latest });
    signatures.push(...next);
    if (next.length < SIGNATURE_PAGE) break;
    before = next.at(-1)?.signature;
  }
  // Only the incremental page may advance the head cursor. Historical
  // backfill rows are appended below and must never be mistaken for a newer
  // signature during an otherwise quiet minute.
  const incrementalNewest = signatures[0]?.signature;

  let backfillBefore = prior.backfill_before || undefined;
  let backfillComplete = prior.backfill_complete === "1";
  if (!latest && signatures.length >= SIGNATURE_PAGE) {
    backfillBefore = signatures.at(-1)?.signature;
  } else if (latest && !backfillComplete && backfillBefore) {
    const older = await signaturePage(env, { before: backfillBefore });
    signatures.push(...older);
    backfillBefore = older.at(-1)?.signature;
    backfillComplete = older.length < SIGNATURE_PAGE;
  } else if (!latest && signatures.length < SIGNATURE_PAGE) {
    backfillComplete = true;
  }

  const unique = [
    ...new Map(signatures.map((row) => [row.signature, row])).values(),
  ].filter((row) => row.err === null);
  const transactions = await fetchTransactions(env, unique);
  const legs = unique.flatMap((row) => {
    const transaction = transactions.get(row.signature);
    return transaction ? decodeBurnTransaction(row.signature, transaction) : [];
  });
  await storeRows(env, legs);
  await refreshMintSupplies(
    env,
    legs.map((leg) => leg.targetMint)
  );

  const newestSlot = signatures.reduce(
    (maximum, row) => Math.max(maximum, row.slot),
    Number(prior.last_indexed_slot ?? 0)
  );
  await env.COMMUNITY_DB.batch([
    env.COMMUNITY_DB.prepare(
      "INSERT OR REPLACE INTO index_state (key, value) VALUES ('latest_signature', ?)"
    ).bind(nextLatestSignature(latest, incrementalNewest)),
    env.COMMUNITY_DB.prepare(
      "INSERT OR REPLACE INTO index_state (key, value) VALUES ('backfill_before', ?)"
    ).bind(backfillBefore ?? ""),
    env.COMMUNITY_DB.prepare(
      "INSERT OR REPLACE INTO index_state (key, value) VALUES ('backfill_complete', ?)"
    ).bind(backfillComplete ? "1" : "0"),
    env.COMMUNITY_DB.prepare(
      "INSERT OR REPLACE INTO index_state (key, value) VALUES ('last_indexed_at', ?)"
    ).bind(String(Math.floor(Date.now() / 1_000))),
    env.COMMUNITY_DB.prepare(
      "INSERT OR REPLACE INTO index_state (key, value) VALUES ('last_indexed_slot', ?)"
    ).bind(String(newestSlot)),
  ]);
  return { signatures: unique.length, legs: legs.length };
}

/** Cursor rule isolated for the quiet-incremental + active-backfill case. */
export function nextLatestSignature(
  priorLatest: string | undefined,
  incrementalNewest: string | undefined
): string {
  return incrementalNewest ?? priorLatest ?? "";
}

type CommunitySqlRow = Readonly<{
  target_mint: string;
  sol_lamports: string;
  burn_count: number;
  vault_count: number;
  launch_count: number;
  last_burn_at: number | null;
  decimals: number | null;
  current_supply_atoms: string | null;
}>;

type LaunchSqlRow = Readonly<{
  launch_mint: string;
  sol_lamports: string;
  burn_count: number;
  vault_count: number;
  target_count: number;
  last_burn_at: number | null;
}>;

type VaultBurnSqlRow = Readonly<{
  signature: string;
  instruction_index: number;
  leg_index: number;
  slot: number;
  launch_mint: string;
  target_mint: string;
  reference_pool: string;
  bps: number;
  sol_lamports: string;
  burned_atoms: string;
  block_time: number | null;
}>;

type LaunchBurnSqlRow = Readonly<{
  signature: string;
  instruction_index: number;
  leg_index: number;
  slot: number;
  vault: string;
  target_mint: string;
  reference_pool: string;
  bps: number;
  sol_lamports: string;
  block_time: number | null;
}>;

type VaultConfigLeg = Readonly<{
  mint: string;
  bps: number;
  referencePool: string;
}>;

type VaultConfigRow = Readonly<{
  launch_mint: string;
  vault: string;
  signature: string;
  instruction_index: number;
  leg_index: number;
  slot: number;
  target_mint: string;
  reference_pool: string;
  bps: number;
}>;

function latestVaultConfigs(rows: readonly VaultConfigRow[]) {
  const latestCalls = new Map<
    string,
    { call: string; slot: number; instructionIndex: number; signature: string }
  >();
  for (const row of rows) {
    const key = `${row.launch_mint}:${row.vault}`;
    const current = latestCalls.get(key);
    if (
      !current ||
      row.slot > current.slot ||
      (row.slot === current.slot &&
        (row.instruction_index > current.instructionIndex ||
          (row.instruction_index === current.instructionIndex &&
            row.signature > current.signature)))
    ) {
      latestCalls.set(key, {
        call: `${row.signature}:${row.instruction_index}`,
        slot: row.slot,
        instructionIndex: row.instruction_index,
        signature: row.signature,
      });
    }
  }

  const configs = new Map<
    string,
    { launchMint: string; vault: string; legs: VaultConfigLeg[] }
  >();
  for (const row of rows) {
    const key = `${row.launch_mint}:${row.vault}`;
    if (
      latestCalls.get(key)?.call !==
      `${row.signature}:${row.instruction_index}`
    ) {
      continue;
    }
    const config = configs.get(key) ?? {
      launchMint: row.launch_mint,
      vault: row.vault,
      legs: [],
    };
    config.legs[row.leg_index] = {
      mint: row.target_mint,
      bps: row.bps,
      referencePool: row.reference_pool,
    };
    configs.set(key, config);
  }
  return configs;
}

function validPubkey(value: string): boolean {
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

export function aggregateVaultBurnRows(rows: readonly VaultBurnSqlRow[]) {
  const calls = new Set<string>();
  const launches = new Set<string>();
  const targets = new Map<
    string,
    { solLamports: bigint; burnedAtoms: bigint; burnCalls: Set<string>; lastBurnAt: number | null }
  >();
  let solLamports = 0n;
  let lastBurnAt: number | null = null;
  for (const row of rows) {
    const call = `${row.signature}:${row.instruction_index}`;
    calls.add(call);
    launches.add(row.launch_mint);
    const sol = BigInt(row.sol_lamports);
    const burned = BigInt(row.burned_atoms);
    solLamports += sol;
    if (row.block_time !== null && (lastBurnAt === null || row.block_time > lastBurnAt)) {
      lastBurnAt = row.block_time;
    }
    const target = targets.get(row.target_mint) ?? {
      solLamports: 0n,
      burnedAtoms: 0n,
      burnCalls: new Set<string>(),
      lastBurnAt: null,
    };
    target.solLamports += sol;
    target.burnedAtoms += burned;
    target.burnCalls.add(call);
    if (
      row.block_time !== null &&
      (target.lastBurnAt === null || row.block_time > target.lastBurnAt)
    ) {
      target.lastBurnAt = row.block_time;
    }
    targets.set(row.target_mint, target);
  }
  return {
    solLamports: solLamports.toString(),
    burnCount: calls.size,
    launchMints: [...launches].sort(),
    lastBurnAt,
    targets: [...targets.entries()]
      .map(([mint, target]) => ({
        mint,
        solLamports: target.solLamports.toString(),
        burnedAtoms: target.burnedAtoms.toString(),
        burnCount: target.burnCalls.size,
        lastBurnAt: target.lastBurnAt,
      }))
      .sort((left, right) => {
        const l = BigInt(left.solLamports);
        const r = BigInt(right.solLamports);
        return l === r ? left.mint.localeCompare(right.mint) : l > r ? -1 : 1;
      }),
  };
}

/** Exact per-vault totals; token atoms are summed in JS BigInt, never SQLite REAL. */
export async function communityVaultSummary(
  env: CommunityEnv,
  vault: string
): Promise<Response> {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase58(vault);
  } catch {
    return Response.json({ code: "INVALID_VAULT" }, { status: 400 });
  }
  if (decoded.length !== 32) {
    return Response.json({ code: "INVALID_VAULT" }, { status: 400 });
  }
  const rows: VaultBurnSqlRow[] = [];
  let offset = 0;
  while (true) {
    const page = await env.COMMUNITY_DB.prepare(
      `SELECT signature, instruction_index, leg_index, slot, launch_mint,
              target_mint, reference_pool, bps, sol_lamports, burned_atoms,
              block_time
       FROM burn_legs
       WHERE vault = ?
       ORDER BY slot ASC, instruction_index ASC, leg_index ASC
       LIMIT 1000 OFFSET ?`
    )
      .bind(vault, offset)
      .all<VaultBurnSqlRow>();
    rows.push(...page.results);
    if (page.results.length < 1000) break;
    offset += page.results.length;
  }
  const summary = aggregateVaultBurnRows(rows);
  const config = [...latestVaultConfigs(rows.map((row) => ({ ...row, vault }))).values()][0];
  const indexState = await state(env);
  return Response.json(
    {
      program: BURNER_PROGRAM,
      finalized: true,
      vault,
      totals: {
        solLamports: summary.solLamports,
        burnCount: summary.burnCount,
        targetCount: summary.targets.length,
        lastBurnAt: summary.lastBurnAt,
      },
      launchMints: summary.launchMints,
      config: config ?? null,
      targets: summary.targets,
      index: {
        updatedAt: Number(indexState.last_indexed_at ?? 0),
        slot: Number(indexState.last_indexed_slot ?? 0),
        backfillComplete: indexState.backfill_complete === "1",
      },
    },
    {
      headers: {
        "cache-control": "public, max-age=10, stale-while-revalidate=20",
      },
    }
  );
}

/** Finalized activity for one launch namespace, grouped into clickable vaults. */
export async function communityLaunchSummary(
  env: CommunityEnv,
  launchMint: string
): Promise<Response> {
  if (!validPubkey(launchMint)) {
    return Response.json({ code: "INVALID_LAUNCH" }, { status: 400 });
  }
  const rows: LaunchBurnSqlRow[] = [];
  let offset = 0;
  while (true) {
    const page = await env.COMMUNITY_DB.prepare(
      `SELECT signature, instruction_index, leg_index, slot, vault,
              target_mint, reference_pool, bps, sol_lamports, block_time
       FROM burn_legs
       WHERE launch_mint = ?
       ORDER BY slot ASC, instruction_index ASC, leg_index ASC
       LIMIT 1000 OFFSET ?`
    )
      .bind(launchMint, offset)
      .all<LaunchBurnSqlRow>();
    rows.push(...page.results);
    if (page.results.length < 1000) break;
    offset += page.results.length;
  }

  const configs = latestVaultConfigs(
    rows.map((row) => ({ ...row, launch_mint: launchMint }))
  );

  const calls = new Set<string>();
  const vaults = new Map<
    string,
    {
      solLamports: bigint;
      calls: Set<string>;
      targets: Set<string>;
      lastBurnAt: number | null;
    }
  >();
  let totalSolLamports = 0n;
  let lastBurnAt: number | null = null;
  for (const row of rows) {
    const call = `${row.signature}:${row.instruction_index}`;
    const sol = BigInt(row.sol_lamports);
    calls.add(call);
    totalSolLamports += sol;
    if (row.block_time !== null && (lastBurnAt === null || row.block_time > lastBurnAt)) {
      lastBurnAt = row.block_time;
    }
    const vault = vaults.get(row.vault) ?? {
      solLamports: 0n,
      calls: new Set<string>(),
      targets: new Set<string>(),
      lastBurnAt: null,
    };
    vault.solLamports += sol;
    vault.calls.add(call);
    vault.targets.add(row.target_mint);
    if (
      row.block_time !== null &&
      (vault.lastBurnAt === null || row.block_time > vault.lastBurnAt)
    ) {
      vault.lastBurnAt = row.block_time;
    }
    vaults.set(row.vault, vault);
  }
  const indexState = await state(env);
  return Response.json(
    {
      program: BURNER_PROGRAM,
      finalized: true,
      launchMint,
      totals: {
        solLamports: totalSolLamports.toString(),
        burnCount: calls.size,
        vaultCount: vaults.size,
        targetCount: new Set(rows.map((row) => row.target_mint)).size,
        lastBurnAt,
      },
      vaults: [...vaults.entries()]
        .map(([vault, value]) => ({
          vault,
          solLamports: value.solLamports.toString(),
          burnCount: value.calls.size,
          targetCount: value.targets.size,
          lastBurnAt: value.lastBurnAt,
          config: configs.get(`${launchMint}:${vault}`) ?? null,
        }))
        .sort((left, right) => {
          const l = BigInt(left.solLamports);
          const r = BigInt(right.solLamports);
          return l === r ? left.vault.localeCompare(right.vault) : l > r ? -1 : 1;
        }),
      index: {
        updatedAt: Number(indexState.last_indexed_at ?? 0),
        slot: Number(indexState.last_indexed_slot ?? 0),
        backfillComplete: indexState.backfill_complete === "1",
      },
    },
    {
      headers: {
        "cache-control": "public, max-age=10, stale-while-revalidate=20",
      },
    }
  );
}

async function exactBurnedAtoms(
  env: CommunityEnv,
  mint: string
): Promise<string> {
  let offset = 0;
  let sum = 0n;
  while (true) {
    const page = await env.COMMUNITY_DB.prepare(
      "SELECT burned_atoms FROM burn_legs WHERE target_mint = ? LIMIT 1000 OFFSET ?"
    )
      .bind(mint, offset)
      .all<{ burned_atoms: string }>();
    for (const row of page.results) sum += BigInt(row.burned_atoms);
    if (page.results.length < 1000) break;
    offset += page.results.length;
  }
  return sum.toString();
}

export async function communityLeaderboard(env: CommunityEnv): Promise<Response> {
  const [communitiesResult, launchesResult, primaryVaultConfigs, indexState] = await Promise.all([
    env.COMMUNITY_DB.prepare(
      `SELECT b.target_mint,
              CAST(SUM(CAST(b.sol_lamports AS INTEGER)) AS TEXT) AS sol_lamports,
              COUNT(DISTINCT b.signature || ':' || b.instruction_index) AS burn_count,
              COUNT(DISTINCT b.vault) AS vault_count,
              COUNT(DISTINCT b.launch_mint) AS launch_count,
              MAX(b.block_time) AS last_burn_at,
              m.decimals,
              m.current_supply_atoms
       FROM burn_legs b
       LEFT JOIN token_mints m ON m.mint = b.target_mint
       GROUP BY b.target_mint, m.decimals, m.current_supply_atoms
       ORDER BY SUM(CAST(sol_lamports AS INTEGER)) DESC, target_mint ASC
       LIMIT 250`
    ).all<CommunitySqlRow>(),
    env.COMMUNITY_DB.prepare(
      `SELECT launch_mint,
              CAST(SUM(CAST(sol_lamports AS INTEGER)) AS TEXT) AS sol_lamports,
              COUNT(DISTINCT signature || ':' || instruction_index) AS burn_count,
              COUNT(DISTINCT vault) AS vault_count,
              COUNT(DISTINCT target_mint) AS target_count,
              MAX(block_time) AS last_burn_at
       FROM burn_legs
       GROUP BY launch_mint
       ORDER BY SUM(CAST(sol_lamports AS INTEGER)) DESC, launch_mint ASC
       LIMIT 100`
    ).all<LaunchSqlRow>(),
    env.COMMUNITY_DB.prepare(
      `WITH vault_totals AS (
         SELECT launch_mint, vault,
                SUM(CAST(sol_lamports AS INTEGER)) AS total_sol
         FROM burn_legs
         GROUP BY launch_mint, vault
       ), ranked_vaults AS (
         SELECT launch_mint, vault,
                ROW_NUMBER() OVER (
                  PARTITION BY launch_mint
                  ORDER BY total_sol DESC, vault ASC
                ) AS vault_rank
         FROM vault_totals
       ), latest_calls AS (
         SELECT b.launch_mint, b.vault, b.signature, b.instruction_index,
                b.slot,
                ROW_NUMBER() OVER (
                  PARTITION BY b.launch_mint, b.vault
                  ORDER BY b.slot DESC, b.instruction_index DESC,
                           b.signature DESC
                ) AS call_rank
         FROM burn_legs b
         INNER JOIN ranked_vaults v
           ON v.launch_mint = b.launch_mint AND v.vault = b.vault
         WHERE v.vault_rank = 1
         GROUP BY b.launch_mint, b.vault, b.signature,
                  b.instruction_index, b.slot
       )
       SELECT b.launch_mint, b.vault, b.signature, b.instruction_index,
              b.leg_index, b.slot, b.target_mint, b.reference_pool, b.bps
       FROM burn_legs b
       INNER JOIN latest_calls c
         ON c.launch_mint = b.launch_mint
        AND c.vault = b.vault
        AND c.signature = b.signature
        AND c.instruction_index = b.instruction_index
       WHERE c.call_rank = 1
       ORDER BY b.launch_mint ASC, b.leg_index ASC`
    ).all<VaultConfigRow>(),
    state(env),
  ]);
  const configs = latestVaultConfigs(primaryVaultConfigs.results);
  const communities = await Promise.all(
    communitiesResult.results.map(async (row) => ({
      mint: row.target_mint,
      solLamports: row.sol_lamports,
      burnedAtoms: await exactBurnedAtoms(env, row.target_mint),
      burnCount: row.burn_count,
      vaultCount: row.vault_count,
      launchCount: row.launch_count,
      lastBurnAt: row.last_burn_at,
      decimals: row.decimals,
      currentSupplyAtoms: row.current_supply_atoms,
    }))
  );
  const totalSolLamports = communities
    .reduce((sum, row) => sum + BigInt(row.solLamports), 0n)
    .toString();
  const totalBurnsResult = await env.COMMUNITY_DB.prepare(
    `SELECT COUNT(*) AS burn_count
     FROM (
       SELECT signature, instruction_index
       FROM burn_legs
       GROUP BY signature, instruction_index
     )`
  ).first<{ burn_count: number }>();
  const totalBurns = totalBurnsResult?.burn_count ?? 0;
  return Response.json(
    {
      program: BURNER_PROGRAM,
      finalized: true,
      totals: {
        solLamports: totalSolLamports,
        burnCount: totalBurns,
        communityCount: communities.length,
        launchCount: launchesResult.results.length,
      },
      communities,
      launches: launchesResult.results.map((row) => ({
        mint: row.launch_mint,
        solLamports: row.sol_lamports,
        burnCount: row.burn_count,
        vaultCount: row.vault_count,
        targetCount: row.target_count,
        lastBurnAt: row.last_burn_at,
        config:
          [...configs.values()].find(
            (config) => config.launchMint === row.launch_mint
          ) ?? null,
      })),
      index: {
        updatedAt: Number(indexState.last_indexed_at ?? 0),
        slot: Number(indexState.last_indexed_slot ?? 0),
        backfillComplete: indexState.backfill_complete === "1",
      },
    },
    {
      headers: {
        "cache-control": "public, max-age=20, stale-while-revalidate=40",
      },
    }
  );
}
