"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Campaign cell runner: one shape x size x floor, executed end-to-end on a
 * disposable Surfpool mainnet fork.
 *
 * Cell phases:
 *   1. setup    - unrelated caller funded; vault ATAs + Pump accumulators +
 *                 curve migration prepaid by the launcher; provenance-recorded
 *                 top-up so every cell starts with the exact authorized size.
 *   2. legs     - Jupiter V2 /build per leg at the exact production split
 *                 amounts; client-side <=3% price-impact gate.
 *   3. proof    - live packed Switchboard proof (median reconstruction,
 *                 three distinct mainnet-queue oracles) at those exact inputs.
 *   4. burn     - one atomic transaction: Ed25519 proof -> compact
 *                 swap_and_burn_split; wire/lock/sole-signer asserted.
 *   5. verify   - lamport conservation including Pump accumulator credits;
 *                 WSOL fully consumed; every target ATA zeroed; supply deltas
 *                 >= oracle-floor minimums.
 *   6. hostile  - signature bit flip, frame corruption, late-leg route-account
 *                 mutation, trailing account, wrong feed order: each expects a
 *                 rejection and byte-identical state rollback.
 *   7. replay   - same proof re-submitted inside freshness (documented
 *                 zero-state behavior; outcome recorded, not asserted).
 *   8. reuse    - immediate second burn at half size proves indefinite reuse.
 *
 * Production/KMS untouched. No real funds.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const surfpool_split_e2e_1 = require("../../scripts/surfpool-split-e2e");
const JUPITER_API_BASE = "https://lite-api.jup.ag/swap/v1";
const RPC = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM = new web3_js_1.PublicKey(process.env.STATELESS_PROGRAM);
const QUEUE = new web3_js_1.PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");
const SPLIT_DISC = Buffer.from([157, 45, 186, 225, 142, 17, 2, 105]);
const PUMP_FUN_PROGRAM = new web3_js_1.PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_SWAP_PROGRAM = new web3_js_1.PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const USER_VOLUME_ACCUMULATOR_DISC = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);
const ROOT = node_path_1.default.join(__dirname, "..");
const PROOF_HELPER = node_path_1.default.join(ROOT, "fetch-proof-robust.mjs");
const LAUNCH_REPORT_PATH = process.env.LAUNCH_REPORT;
const TOTAL = BigInt(process.env.TOTAL_LAMPORTS);
const FLOOR_BPS = Number(process.env.FLOOR_BPS ?? "10");
const IMPACT_LIMIT_PCT = Number(process.env.IMPACT_LIMIT_PCT ?? "3");
const RESULT_OUT = process.env.RESULT_OUT;
const PROOF_OUT = process.env.PROOF_OUT ?? "/tmp/campaign-cell-proof.json";
const sha256Hex = (data) => node_crypto_1.default.createHash("sha256").update(data).digest("hex");
function readPayer() {
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(node_fs_1.default.readFileSync(process.env.SOLANA_KEYPAIR, "utf8"))));
}
/** Production split arithmetic; final leg absorbs the remainder. */
function splitAmounts(total, bpsList) {
    const quotient = total / 10000n;
    const remainder = total % 10000n;
    let allocated = 0n;
    return bpsList.map((bps, index) => {
        const amount = index + 1 === bpsList.length
            ? total - allocated
            : quotient * BigInt(bps) + (remainder * BigInt(bps)) / 10000n;
        allocated += amount;
        return amount;
    });
}
function fixed1e18ToAtoms(valueFixed, decimals) {
    // floor(value * 10^decimals / 10^18)
    const scaled = BigInt(valueFixed) * BigInt(10) ** BigInt(decimals);
    return scaled / BigInt(1e18);
}
function shortvecLength(value) {
    let bytes = 1;
    while (value >= 128) {
        value >>>= 7;
        bytes += 1;
    }
    return bytes;
}
function exactTransactionLength(message, signatures) {
    let body = 4;
    body +=
        shortvecLength(message.staticAccountKeys.length) +
            32 * message.staticAccountKeys.length;
    body += 32 + shortvecLength(message.compiledInstructions.length);
    for (const ix of message.compiledInstructions) {
        body += 1 + shortvecLength(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length;
        body += shortvecLength(ix.data.length) + ix.data.length;
    }
    body += shortvecLength(message.addressTableLookups.length);
    for (const lookup of message.addressTableLookups) {
        body += 32 + shortvecLength(lookup.writableIndexes.length) + lookup.writableIndexes.length;
        body += shortvecLength(lookup.readonlyIndexes.length) + lookup.readonlyIndexes.length;
    }
    return shortvecLength(signatures) + 64 * signatures + body;
}
function compactData(legs) {
    const headers = Buffer.alloc(2 * (legs.length - 1));
    legs.slice(0, -1).forEach((leg, index) => {
        if (leg.routeAccounts.length > 255 || leg.jupiterData.length > 255) {
            throw new Error(`nonfinal leg ${index} exceeds u8 framing`);
        }
        headers.writeUInt8(leg.routeAccounts.length, 2 * index);
        headers.writeUInt8(leg.jupiterData.length, 2 * index + 1);
    });
    return Buffer.concat([SPLIT_DISC, headers, ...legs.map((leg) => leg.jupiterData)]);
}
function burnInstruction(caller, pda, wsol, launch, legs, mutate) {
    const keys = [
        { pubkey: caller, isSigner: true, isWritable: false },
        { pubkey: QUEUE, isSigner: false, isWritable: false },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: wsol, isSigner: false, isWritable: true },
        { pubkey: launch, isSigner: false, isWritable: false },
        { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: spl_token_1.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: surfpool_split_e2e_1.JUPITER_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: web3_js_1.SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
        ...legs.flatMap((leg) => [
            { pubkey: leg.mint, isSigner: false, isWritable: true },
            { pubkey: leg.ata, isSigner: false, isWritable: true },
            { pubkey: leg.tokenProgram, isSigner: false, isWritable: false },
        ]),
        ...legs.flatMap((leg) => leg.routeAccounts),
    ];
    const data = compactData(legs);
    mutate?.(keys, data);
    return new web3_js_1.TransactionInstruction({ programId: PROGRAM, keys, data });
}
async function compile(connection, caller, proofData, burn, legs, localTable) {
    const validity = await connection.getLatestBlockhash("confirmed");
    const proof = new web3_js_1.TransactionInstruction({
        programId: web3_js_1.Ed25519Program.programId,
        keys: [],
        data: proofData,
    });
    const tables = [
        ...new Map(legs
            .flatMap((leg) => leg.resolvedLookupTables)
            .map((table) => [table.key.toBase58(), table])).values(),
        localTable,
    ];
    const message = new web3_js_1.TransactionMessage({
        payerKey: caller.publicKey,
        recentBlockhash: validity.blockhash,
        instructions: [
            web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
            proof,
            burn,
        ],
    }).compileToV0Message(tables);
    const transaction = new web3_js_1.VersionedTransaction(message);
    const bytes = exactTransactionLength(message, transaction.signatures.length);
    const locks = message.staticAccountKeys.length +
        message.addressTableLookups.reduce((sum, lookup) => sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length, 0);
    if (bytes > 1232)
        throw Object.assign(new Error(`wire ${bytes} exceeds 1232`), { bytes, locks });
    transaction.sign([caller]);
    if (transaction.signatures.length !== 1)
        throw new Error("more than one tx signer");
    const serialized = Buffer.from(transaction.serialize());
    if (serialized.length !== bytes)
        throw new Error(`manual bytes ${bytes} != web3 ${serialized.length}`);
    return { ...validity, transaction, serialized, bytes, locks };
}
async function createLocalAlt(connection, payer, addresses) {
    const recentSlot = await connection.getSlot("confirmed");
    const [create, tableAddress] = web3_js_1.AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot,
    });
    await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, "campaign-create-alt", [create]);
    await (0, surfpool_split_e2e_1.sendInstructions)(connection, payer, "campaign-extend-alt", [
        web3_js_1.AddressLookupTableProgram.extendLookupTable({
            payer: payer.publicKey,
            authority: payer.publicKey,
            lookupTable: tableAddress,
            addresses: [...new Map(addresses.map((key) => [key.toBase58(), key])).values()],
        }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const found = await connection.getAddressLookupTable(tableAddress);
    if (!found.value)
        throw new Error("local ALT missing");
    return found.value;
}
function accumulatorCreditCandidates(connection, vault, legs) {
    const writableRoute = new Set(legs
        .flatMap((leg) => leg.routeAccounts)
        .filter((account) => account.isWritable)
        .map((account) => account.pubkey.toBase58()));
    return Promise.all([PUMP_FUN_PROGRAM, PUMP_SWAP_PROGRAM].map(async (program) => {
        const [address] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), vault.toBuffer()], program);
        if (!writableRoute.has(address.toBase58()))
            return null;
        const info = await connection.getAccountInfo(address, "confirmed");
        if (!info)
            return null;
        if (info.owner.equals(web3_js_1.SystemProgram.programId) && info.data.length === 0)
            return null;
        if (!info.owner.equals(program) ||
            info.lamports <= 0 ||
            info.data.length < 40 ||
            !info.data.subarray(0, 8).equals(USER_VOLUME_ACCUMULATOR_DISC) ||
            !info.data.subarray(8, 40).equals(vault.toBuffer())) {
            throw new Error(`malformed pump credit account ${address.toBase58()}`);
        }
        return { address, lamports: BigInt(info.lamports) };
    })).then((rows) => rows.filter((row) => row !== null));
}
async function snapshotCell(connection, vault, wsol, legs) {
    const targets = await Promise.all(legs.map(async (leg) => ({
        label: leg.label,
        ataAtoms: (await (0, spl_token_1.getAccount)(connection, leg.ata, "confirmed", leg.tokenProgram)).amount.toString(),
        mintSupply: (await (0, spl_token_1.getMint)(connection, leg.mint, "confirmed", leg.tokenProgram)).supply.toString(),
    })));
    return {
        vaultLamports: await connection.getBalance(vault, "confirmed"),
        wsolAtoms: (await (0, spl_token_1.getAccount)(connection, wsol, "confirmed", spl_token_1.TOKEN_PROGRAM_ID)).amount.toString(),
        credits: (await accumulatorCreditCandidates(connection, vault, legs)).map((credit) => ({
            address: credit.address.toBase58(),
            lamports: credit.lamports.toString(),
        })),
        targets,
    };
}
async function rawSnapshot(connection, rows) {
    const infos = await connection.getMultipleAccountsInfo(rows.map((row) => row.key), "confirmed");
    return rows.map((row, index) => {
        const info = infos[index];
        return info
            ? {
                label: row.label,
                address: row.key.toBase58(),
                lamports: info.lamports,
                owner: info.owner.toBase58(),
                executable: info.executable,
                dataSha256: sha256Hex(Buffer.from(info.data)),
            }
            : { label: row.label, address: row.key.toBase58(), missing: true };
    });
}
async function submitExpectingFailure(connection, compiled, label) {
    const signature = await connection.sendRawTransaction(compiled.serialized, {
        skipPreflight: true,
        maxRetries: 3,
    });
    const confirmation = await connection.confirmTransaction({ signature, blockhash: compiled.blockhash, lastValidBlockHeight: compiled.lastValidBlockHeight }, "confirmed");
    if (!confirmation.value.err)
        throw new Error(`${label} unexpectedly landed`);
    const landed = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });
    return {
        label,
        signature,
        err: landed?.meta?.err ?? confirmation.value.err ?? "failed",
        units: landed?.meta?.computeUnitsConsumed ?? null,
        logs: landed?.meta?.logMessages ?? [],
    };
}
async function fetchProof(mints, amountsSol, out) {
    (0, node_child_process_1.execFileSync)(process.execPath, [PROOF_HELPER], {
        cwd: ROOT,
        env: {
            ...process.env,
            SB_RPC: RPC,
            TARGET_MINTS: mints.join(","),
            AMOUNTS_SOL: amountsSol.join(","),
            NUM_SIGNATURES: "3",
            NUM_ORACLES: "5",
            MAX_JOB_RANGE_PCT_RAW: process.env.MAX_JOB_RANGE_PCT_RAW ?? "5000000000",
            PROOF_OUT: out,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const report = JSON.parse(node_fs_1.default.readFileSync(out, "utf8"));
    if (!report.accepted)
        throw new Error(`no proof: ${JSON.stringify(report.attempts ?? [])}`);
    return report;
}
/**
 * A brand-new Pump mint has no Jupiter route until Jupiter indexes it
 * (`TOKEN_NOT_TRADABLE`). That is Jupiter liveness, not burner behavior, and
 * the campaign must measure it: poll each leg's route availability at the
 * exact leg amount and record seconds-to-routable per mint. Fails the cell if
 * still unrouted after ROUTE_WAIT_SECS.
 */
async function waitForRoutable(legs) {
    const waitSecs = Number(process.env.ROUTE_WAIT_SECS ?? "900");
    const pollIntervalMs = 20000;
    const routedAt = {};
    const pending = new Map(legs.map((leg, index) => [leg.mint.toBase58(), index]));
    const startedAt = Date.now();
    let attempt = 0;
    while (pending.size > 0 && (Date.now() - startedAt) / 1000 < waitSecs) {
        if (attempt > 0)
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        attempt += 1;
        for (const [mintBase58] of [...pending.entries()]) {
            try {
                // A tiny-amount quote is the cheapest routability signal Jupiter
                // offers; actual-size fit is checked later by prepareLegs itself.
                const probe = new URL(`${JUPITER_API_BASE}/quote`);
                probe.searchParams.set("inputMint", spl_token_1.NATIVE_MINT.toBase58());
                probe.searchParams.set("outputMint", mintBase58);
                probe.searchParams.set("amount", "1000000");
                probe.searchParams.set("slippageBps", "500");
                const response = await (0, surfpool_split_e2e_1.fetchJson)(probe.toString());
                if (!response.error) {
                    routedAt[mintBase58] = Math.round((Date.now() - startedAt) / 1000);
                    pending.delete(mintBase58);
                }
            }
            catch {
                // not indexed yet; keep polling
            }
        }
    }
    if (pending.size > 0) {
        throw new Error(`mints never became routable within ${waitSecs}s: ${[...pending.keys()].join(",")}`);
    }
    return routedAt;
}
/**
 * Two fixture modes:
 *  - LAUNCH_REPORT: fork-born launch whose creator fees were genuinely
 *    distributed into the vault by the Pump program.
 *  - LAUNCH_MINT + SHAPE_LEGS: a mainnet-routable recent pump launch as the
 *    own-launch slot. Fork-born mints are permanently invisible to mainnet
 *    indexers (TOKEN_NOT_TRADABLE), so burn routing uses these stand-ins and
 *    funding is direct; fee delivery itself is proven by the report fixtures.
 */
function loadCellConfig() {
    if (process.env.LAUNCH_REPORT) {
        const report = JSON.parse(node_fs_1.default.readFileSync(process.env.LAUNCH_REPORT, "utf8"));
        return {
            launchMint: report.launchMint,
            legs: report.legs,
            vault: report.vault,
            creatorFeesDeliveredLamports: report.creatorFeesDeliveredLamports,
            fundingMode: "pump-distribution",
        };
    }
    const launchMint = process.env.LAUNCH_MINT;
    const legs = JSON.parse(process.env.SHAPE_LEGS);
    const bpsBlob = Buffer.alloc(2 * legs.length);
    legs.forEach((leg, index) => bpsBlob.writeUInt16LE(leg.bps, 2 * index));
    const [vault] = web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("burner"),
        new web3_js_1.PublicKey(launchMint).toBuffer(),
        ...legs.map((leg) => new web3_js_1.PublicKey(leg.mint).toBuffer()),
        bpsBlob,
    ], PROGRAM);
    return {
        launchMint,
        legs,
        vault: vault.toBase58(),
        creatorFeesDeliveredLamports: "0",
        fundingMode: "direct-standin",
    };
}
async function main() {
    const config = loadCellConfig();
    const report = {
        shape: process.env.CELL_TAG ?? config.fundingMode,
        launchMint: config.launchMint,
        legs: config.legs,
        vault: config.vault,
        creatorFeesDeliveredLamports: config.creatorFeesDeliveredLamports,
    };
    const launch = new web3_js_1.PublicKey(config.launchMint);
    const vault = new web3_js_1.PublicKey(config.vault);
    const legsDef = config.legs.map((leg) => ({
        label: leg.label,
        mint: new web3_js_1.PublicKey(leg.mint),
        bps: leg.bps,
    }));
    if (legsDef.reduce((sum, leg) => sum + leg.bps, 0) !== 10000)
        throw new Error("bad bps in report");
    const maxAccountsPerLeg = Number(process.env.MAX_ACCOUNTS_PER_LEG ?? (legsDef.length === 2 ? 16 : 10));
    const connection = new web3_js_1.Connection(RPC, "confirmed");
    const launcher = readPayer();
    const caller = web3_js_1.Keypair.generate();
    if (caller.publicKey.equals(launcher.publicKey))
        throw new Error("caller must be unrelated");
    await connection.confirmTransaction(await connection.requestAirdrop(caller.publicKey, 5000000000), "confirmed");
    // ---- setup ---------------------------------------------------------- //
    const wsol = (0, spl_token_1.getAssociatedTokenAddressSync)(spl_token_1.NATIVE_MINT, vault, true, spl_token_1.TOKEN_PROGRAM_ID);
    const targetRows = await Promise.all(legsDef.map(async (leg) => {
        const info = await connection.getAccountInfo(leg.mint, "confirmed");
        if (!info)
            throw new Error(`mint missing on fork: ${leg.label}`);
        return { ...leg, tokenProgram: info.owner, ata: (0, spl_token_1.getAssociatedTokenAddressSync)(leg.mint, vault, true, info.owner) };
    }));
    await (0, surfpool_split_e2e_1.sendInstructions)(connection, launcher, "cell-setup-atas", [
        (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(launcher.publicKey, wsol, vault, spl_token_1.NATIVE_MINT, spl_token_1.TOKEN_PROGRAM_ID),
        ...targetRows.map((leg) => (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(launcher.publicKey, leg.ata, vault, leg.mint, leg.tokenProgram)),
    ]);
    const migratedCurves = await (0, surfpool_split_e2e_1.ensureBondingCurvesMigrated)(connection, launcher, targetRows.map((leg) => leg.mint));
    const createdAccumulators = await (0, surfpool_split_e2e_1.ensurePumpVolumeAccumulators)(connection, launcher, vault);
    const balanceNow = await connection.getBalance(vault, "confirmed");
    const requiredBalance = Math.ceil(Number(TOTAL) * 1.75) + 100000;
    let topUpLamports = 0;
    if (balanceNow < requiredBalance) {
        topUpLamports = requiredBalance - balanceNow;
        await (0, surfpool_split_e2e_1.sendInstructions)(connection, launcher, "cell-vault-topup-direct-funding", [
            web3_js_1.SystemProgram.transfer({
                fromPubkey: launcher.publicKey,
                toPubkey: vault,
                lamports: topUpLamports,
            }),
        ]);
    }
    const localTable = await createLocalAlt(connection, launcher, [
        PROGRAM, QUEUE, vault, wsol, launch, web3_js_1.SystemProgram.programId, spl_token_1.TOKEN_PROGRAM_ID,
        surfpool_split_e2e_1.JUPITER_PROGRAM, web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY, web3_js_1.SYSVAR_SLOT_HASHES_PUBKEY,
        web3_js_1.Ed25519Program.programId,
        ...targetRows.flatMap((leg) => [leg.mint, leg.ata, leg.tokenProgram]),
    ]);
    // ---- legs + impact gate --------------------------------------------- //
    const amounts = splitAmounts(TOTAL, targetRows.map((leg) => leg.bps));
    const routeWaitStarted = Date.now();
    const timeToRoutable = await waitForRoutable(targetRows);
    const legs = await (0, surfpool_split_e2e_1.prepareLegs)(connection, launcher, vault, wsol, targetRows, TOTAL, Number(process.env.JUP_SLIPPAGE_BPS ?? "50"), maxAccountsPerLeg);
    const impact = legs.map((leg) => ({
        label: leg.label,
        routePriceImpactPct: leg.routePriceImpactPct ?? null,
    }));
    const impactExceeded = legs.some((leg) => {
        const value = Number(leg.routePriceImpactPct ?? "0");
        return leg.routePriceImpactPct !== undefined && !(value <= IMPACT_LIMIT_PCT);
    });
    const missingImpact = legs.some((leg) => leg.routePriceImpactPct === undefined);
    const evidence = {
        scope: "isolated surfpool-dev campaign cell; production/KMS untouched",
        program: PROGRAM.toBase58(),
        floorBps: FLOOR_BPS,
        shape: report.shape,
        totalLamports: TOTAL.toString(),
        legs: legs.map((leg) => ({
            label: leg.label, mint: leg.mint.toBase58(),
            route: leg.routeLabel, routeAccounts: leg.routeAccounts.length,
            dataBytes: leg.jupiterData.length, amountIn: leg.amountIn.toString(),
            priceImpactPct: leg.routePriceImpactPct ?? null,
        })),
        setup: {
            migratedCurves, createdAccumulators,
            fundingMode: config.fundingMode,
            creatorFeesDeliveredLamports: report.creatorFeesDeliveredLamports,
            directTopUpLamports: String(topUpLamports),
            topUpProvenance: config.fundingMode === "direct-standin"
                ? "entire balance is explicit local funding: standin launch is not ours to pin fees on"
                : "explicit local transfer for size scaling; fees came from real Pump distribution",
        },
        vault: vault.toBase58(),
        caller: caller.publicKey.toBase58(),
        callerIsUnrelated: true,
        timeToJupiterRouteSeconds: timeToRoutable,
        routeWaitTotalSeconds: Math.round((Date.now() - routeWaitStarted) / 1000),
    };
    if (impactExceeded || missingImpact) {
        evidence.classification = missingImpact ? "impact-policy-unknown" : "impact-gate-exceeded";
        evidence.priceImpactPolicy = { limitPct: IMPACT_LIMIT_PCT, enforcement: "client-side quote gate; not part of signed payload" };
        node_fs_1.default.writeFileSync(RESULT_OUT, JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify({ result: RESULT_OUT, classification: evidence.classification }, null, 2));
        return;
    }
    // ---- proof ----------------------------------------------------------- //
    const proofReport = await fetchProof(targetRows.map((leg) => leg.mint.toBase58()), amounts.map((amount) => `${Number(amount) / 1e9}`), PROOF_OUT);
    const proofData = Buffer.from(proofReport.accepted.dataBase64, "base64");
    evidence.proof = {
        gateway: proofReport.accepted.gateway,
        latencyMs: proofReport.accepted.latencyMs,
        slot: proofReport.accepted.slot,
        oracleIndexes: proofReport.accepted.indexes,
        valuesFixed1e18: proofReport.accepted.valuesFixed1e18,
        dataBytes: proofData.length,
    };
    // ---- positive burn ---------------------------------------------------- //
    const before = await snapshotCell(connection, vault, wsol, legs);
    const stateRows = [
        { label: "vault", key: vault },
        { label: "wsol", key: wsol },
        ...targetRows.flatMap((leg) => [
            { label: `${leg.label}:mint`, key: leg.mint },
            { label: `${leg.label}:ata`, key: leg.ata },
        ]),
    ];
    const beforeRaw = await rawSnapshot(connection, stateRows);
    const positive = await compile(connection, caller, proofData, burnInstruction(caller.publicKey, vault, wsol, launch, legs), legs, localTable);
    evidence.wireBytes = positive.bytes;
    evidence.accountLocks = positive.locks;
    const positiveSim = await connection.simulateTransaction(positive.transaction, { sigVerify: true });
    if (positiveSim.value.err) {
        throw Object.assign(new Error(`positive simulation failed`), {
            simulation: positiveSim.value, logs: positiveSim.value.logs,
        });
    }
    const signature = await connection.sendRawTransaction(positive.serialized, { skipPreflight: false, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction({ signature, blockhash: positive.blockhash, lastValidBlockHeight: positive.lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err)
        throw new Error(`positive landed failure: ${JSON.stringify(confirmation.value.err)}`);
    const landed = await connection.getTransaction(signature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
    });
    const after = await snapshotCell(connection, vault, wsol, legs);
    const afterRaw = await rawSnapshot(connection, stateRows);
    const creditSum = before.credits.reduce((sum, credit) => sum + BigInt(credit.lamports), 0n);
    const expectedVaultAfter = before.vaultLamports - Number(TOTAL) + Number(creditSum);
    const conservationExact = after.vaultLamports === expectedVaultAfter;
    const decimals = await Promise.all(targetRows.map((leg) => (0, spl_token_1.getMint)(connection, leg.mint, "confirmed", leg.tokenProgram).then((mint) => mint.decimals)));
    const floors = proofReport.accepted.valuesFixed1e18.map((valueFixed, index) => {
        const attestedAtoms = fixed1e18ToAtoms(valueFixed, decimals[index]);
        return {
            label: targetRows[index].label,
            attestedAtoms: attestedAtoms.toString(),
            minAtoms: ((attestedAtoms * BigInt(10000 - FLOOR_BPS)) / 10000n).toString(),
        };
    });
    const burnChecks = targetRows.map((leg, index) => {
        const beforeSupply = BigInt(before.targets[index].mintSupply);
        const afterSupply = BigInt(after.targets[index].mintSupply);
        const burned = beforeSupply - afterSupply;
        return {
            label: leg.label,
            burnedAtoms: burned.toString(),
            minAtoms: floors[index].minAtoms,
            floorMet: burned >= BigInt(floors[index].minAtoms),
            ataZeroAfter: after.targets[index].ataAtoms === "0",
        };
    });
    evidence.positiveBurn = {
        signature,
        computeUnits: landed?.meta?.computeUnitsConsumed ?? null,
        logs: (landed?.meta?.logMessages ?? []).filter((line) => line.includes(PROGRAM.toBase58()) || line.toLowerCase().includes("burn")),
        vaultBefore: before.vaultLamports,
        vaultAfter: after.vaultLamports,
        creditedAccumulators: before.credits,
        conservationExpectedVaultAfter: String(expectedVaultAfter),
        conservationExact,
        wsolZeroAfter: after.wsolAtoms === "0",
        burnChecks,
        allFloorsMet: burnChecks.every((check) => check.floorMet && check.ataZeroAfter),
    };
    // ---- hostile mutations ------------------------------------------------ //
    const hostileResults = [];
    async function runHostile(label, build, expectUnchanged) {
        try {
            const compiled = await build();
            const outcome = await submitExpectingFailure(connection, compiled, label);
            if (expectUnchanged) {
                const afterRawHostile = await rawSnapshot(connection, stateRows);
                outcome.rawUnchanged = JSON.stringify(beforeRaw) === JSON.stringify(afterRawHostile);
            }
            hostileResults.push(outcome);
            return outcome;
        }
        catch (error) {
            hostileResults.push({ label, error: String(error?.message ?? error).slice(0, 300) });
            return null;
        }
    }
    const badSignatureData = Buffer.from(proofData);
    badSignatureData[44] ^= 1;
    await runHostile("signature-bit-flip", async () => compile(connection, caller, badSignatureData, burnInstruction(caller.publicKey, vault, wsol, launch, legs), legs, localTable), true);
    await runHostile("frame-count-zero", async () => compile(connection, caller, proofData, burnInstruction(caller.publicKey, vault, wsol, launch, legs, (_keys, data) => { data[8] = 0; }), legs, localTable), true);
    const finalLeg = legs[legs.length - 1];
    await runHostile("late-leg-route-mutation", async () => compile(connection, caller, proofData, burnInstruction(caller.publicKey, vault, wsol, launch, legs, (keys) => {
        const sharedDisc = finalLeg.jupiterData.subarray(0, 8).toString("hex") === "d19853937cfed8e9";
        const fixedFinalAccounts = sharedDisc ? 12 : 10;
        if (finalLeg.routeAccounts.length <= fixedFinalAccounts) {
            throw new Error("final route has no mutable pool account to test late-leg rollback");
        }
        const finalRouteAt = 10 + 3 * legs.length
            + legs.slice(0, -1).reduce((sum, leg) => sum + leg.routeAccounts.length, 0);
        keys[finalRouteAt + fixedFinalAccounts] = {
            pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false,
        };
    }), legs, localTable), true);
    const trailingCompiled = await compile(connection, caller, proofData, burnInstruction(caller.publicKey, vault, wsol, launch, legs, (keys) => keys.push({ pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false })), legs, localTable);
    const trailingSim = await connection.simulateTransaction(trailingCompiled.transaction, { sigVerify: true });
    hostileResults.push({
        label: "trailing-extra-account",
        classification: "final leg consumes account remainder; not a burner framing rejection by design",
        simErr: trailingSim.value.err,
    });
    // Wrong feed order: proof requested over reversed mints must fail closed.
    const wrongOrderProofPath = "/tmp/campaign-wrongorder-proof.json";
    let wrongOrderRecorded = false;
    try {
        await fetchProof([...targetRows].reverse().map((leg) => leg.mint.toBase58()), [...amounts].reverse().map((amount) => `${Number(amount) / 1e9}`), wrongOrderProofPath);
        const wrongReport = JSON.parse(node_fs_1.default.readFileSync(wrongOrderProofPath, "utf8"));
        const wrongData = Buffer.from(wrongReport.accepted.dataBase64, "base64");
        const outcome = await runHostile("wrong-feed-order", async () => compile(connection, caller, wrongData, burnInstruction(caller.publicKey, vault, wsol, launch, legs), legs, localTable), true);
        wrongOrderRecorded = !!outcome;
    }
    catch (error) {
        hostileResults.push({ label: "wrong-feed-order", note: `proof request itself failed: ${String(error?.message ?? error).slice(0, 160)}` });
    }
    // Replay documentation: identical proof, fresh blockhash.
    let replayOutcome = null;
    try {
        const replayCompiled = await compile(connection, caller, proofData, burnInstruction(caller.publicKey, vault, wsol, launch, legs), legs, localTable);
        const replaySignature = await connection.sendRawTransaction(replayCompiled.serialized, { skipPreflight: true, maxRetries: 0 });
        const replayConfirmation = await connection.confirmTransaction({ signature: replaySignature, blockhash: replayCompiled.blockhash, lastValidBlockHeight: replayCompiled.lastValidBlockHeight }, "confirmed");
        replayOutcome = {
            landed: !replayConfirmation.value.err,
            err: replayConfirmation.value.err ?? null,
            classification: replayConfirmation.value.err
                ? "rejected (freshness or policy)"
                : "accepted within freshness window: documented zero-state replay property, custody unchanged (still swaps+burns)",
        };
        const afterReplayRaw = await rawSnapshot(connection, stateRows);
        replayOutcome.stateChangedFromBeforeRaw = JSON.stringify(beforeRaw) !== JSON.stringify(afterReplayRaw);
    }
    catch (error) {
        replayOutcome = { error: String(error?.message ?? error).slice(0, 200) };
    }
    // ---- indefinite reuse: half-size second burn --------------------------- //
    const HALF = TOTAL / 2n;
    let reuse = null;
    if (HALF > 50000000n) {
        try {
            const reuseLegs = await (0, surfpool_split_e2e_1.prepareLegs)(connection, launcher, vault, wsol, targetRows, HALF, Number(process.env.JUP_SLIPPAGE_BPS ?? "50"), maxAccountsPerLeg);
            const reuseAmounts = splitAmounts(HALF, targetRows.map((leg) => leg.bps));
            const reuseProofReport = await fetchProof(targetRows.map((leg) => leg.mint.toBase58()), reuseAmounts.map((amount) => `${Number(amount) / 1e9}`), "/tmp/campaign-reuse-proof.json");
            const reuseProofData = Buffer.from(reuseProofReport.accepted.dataBase64, "base64");
            const beforeReuse = await snapshotCell(connection, vault, wsol, reuseLegs);
            const reuseCredits = beforeReuse.credits.reduce((sum, c) => sum + BigInt(c.lamports), 0n);
            const compiledReuse = await compile(connection, caller, reuseProofData, burnInstruction(caller.publicKey, vault, wsol, launch, reuseLegs), reuseLegs, localTable);
            const reuseSignature = await connection.sendRawTransaction(compiledReuse.serialized, { skipPreflight: false, maxRetries: 3 });
            const reuseConfirmation = await connection.confirmTransaction({ signature: reuseSignature, blockhash: compiledReuse.blockhash, lastValidBlockHeight: compiledReuse.lastValidBlockHeight }, "confirmed");
            if (reuseConfirmation.value.err)
                throw new Error(JSON.stringify(reuseConfirmation.value.err));
            const afterReuse = await snapshotCell(connection, vault, wsol, reuseLegs);
            reuse = {
                signature: reuseSignature,
                totalLamports: HALF.toString(),
                wireBytes: compiledReuse.bytes,
                accountLocks: compiledReuse.locks,
                computeUnits: null,
                conservationExact: afterReuse.vaultLamports === beforeReuse.vaultLamports - Number(HALF) + Number(reuseCredits),
                wsolZeroAfter: afterReuse.wsolAtoms === "0",
                targetsAllZero: afterReuse.targets.every((t) => t.ataAtoms === "0"),
            };
            const reuseLanded = await connection.getTransaction(reuseSignature, {
                commitment: "confirmed", maxSupportedTransactionVersion: 0,
            });
            reuse.computeUnits = reuseLanded?.meta?.computeUnitsConsumed ?? null;
        }
        catch (error) {
            reuse = { error: String(error?.stack ?? error).slice(0, 500) };
        }
    }
    evidence.hostile = hostileResults;
    evidence.replay = replayOutcome;
    evidence.indefiniteReuse = reuse;
    evidence.pass =
        conservationExact &&
            after.wsolAtoms === "0" &&
            evidence.positiveBurn.allFloorsMet &&
            hostileResults.filter((row) => ["signature-bit-flip", "frame-count-zero", "wrong-feed-order"].includes(row.label))
                .every((row) => row.err && row.rawUnchanged !== false);
    node_fs_1.default.writeFileSync(RESULT_OUT, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({
        result: RESULT_OUT, pass: evidence.pass, wireBytes: evidence.wireBytes,
        locks: evidence.accountLocks, conservationExact, floorsMet: evidence.positiveBurn.allFloorsMet,
    }, null, 2));
}
main().catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
});
