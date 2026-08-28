#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { Connection, PublicKey } = require("@solana/web3.js");

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAM_STATE = 2;
const PROGRAMDATA_STATE = 3;
const PROGRAMDATA_METADATA_BYTES = 45;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const connection = new Connection(required("DEPLOY_RPC_URL"), "finalized");
  const programId = new PublicKey(required("PINOCCHIO_PROGRAM_ID"));
  const expectedAuthorityInput = required("EXPECTED_UPGRADE_AUTHORITY");
  const artifactPath = resolve(
    process.env.PINOCCHIO_ARTIFACT ??
      "programs/burner/target/deploy/pinocchio_parity.so"
  );
  const artifact = readFileSync(artifactPath);
  if (artifact.length === 0) throw new Error(`artifact is empty: ${artifactPath}`);

  const program = await connection.getAccountInfo(programId, "finalized");
  if (!program?.executable) throw new Error(`${programId} is not executable`);
  if (!program.owner.equals(LOADER)) {
    throw new Error(`${programId} is owned by ${program.owner}, expected ${LOADER}`);
  }
  if (program.data.length < 36 || program.data.readUInt32LE(0) !== PROGRAM_STATE) {
    throw new Error(`${programId} is not upgradeable-loader Program state`);
  }

  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const programData = await connection.getAccountInfo(programDataAddress, "finalized");
  if (!programData || !programData.owner.equals(LOADER)) {
    throw new Error(`invalid ProgramData account ${programDataAddress}`);
  }
  if (
    programData.data.length < PROGRAMDATA_METADATA_BYTES ||
    programData.data.readUInt32LE(0) !== PROGRAMDATA_STATE
  ) {
    throw new Error(`${programDataAddress} is not ProgramData state`);
  }

  const deployed = programData.data.subarray(PROGRAMDATA_METADATA_BYTES);
  const prefixMatches =
    deployed.length >= artifact.length &&
    deployed.subarray(0, artifact.length).equals(artifact);
  const paddingIsZero = deployed.subarray(artifact.length).every((byte) => byte === 0);
  if (!prefixMatches || !paddingIsZero) {
    throw new Error(
      `deployment drift: local ${sha256(artifact)} (${artifact.length} bytes) does not match ProgramData`
    );
  }

  const upgradeAuthority =
    programData.data[12] === 1
      ? new PublicKey(programData.data.subarray(13, 45)).toBase58()
      : null;
  const expectedAuthority =
    expectedAuthorityInput.toLowerCase() === "none"
      ? null
      : new PublicKey(expectedAuthorityInput).toBase58();
  if (upgradeAuthority !== expectedAuthority) {
    throw new Error(
      `upgrade authority is ${upgradeAuthority ?? "none"}, expected ${expectedAuthority ?? "none"}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        programId: programId.toBase58(),
        programDataAddress: programDataAddress.toBase58(),
        artifact: artifactPath,
        artifactBytes: artifact.length,
        allocatedProgramBytes: deployed.length,
        sha256: sha256(artifact),
        upgradeAuthority,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`Pinocchio deployment verification failed: ${error.message}`);
  process.exitCode = 1;
});
