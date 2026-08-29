/**
 * Browser caller-paid contract proof, no network: mocks the keyless
 * prepare/submit endpoints and drives the real makeService client.
 *
 *   - prepare returns an UNSIGNED transaction whose only required signer is
 *     the connected wallet; the client verifies digest, signer layout, and
 *     that it is exactly ComputeBudget + burner before signing;
 *   - submit receives the FULLY SIGNED transaction bytes (keyless: nothing
 *     about them is secret) and nothing else besides the requestId;
 *   - a prepared transaction whose program is not the burner is refused
 *     before the wallet is ever asked to sign.
 */
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PROGRAM } from "../src/chain/constants";
import { makeService, ServiceError } from "../src/chain/service";
import { walletFromKeypair } from "../src/chain/wallet";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function preparedTransaction(caller: Keypair, safe = true) {
  const burn = new TransactionInstruction({
    programId: safe ? PROGRAM : SystemProgram.programId,
    keys: [{ pubkey: caller.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from([1]),
  });
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: caller.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        burn,
      ],
    }).compileToV0Message()
  );
}

async function main() {
  const caller = Keypair.generate();
  const wallet = walletFromKeypair(caller);
  let submitBody: Record<string, unknown> | undefined;
  let metadataFinalizeBody: Record<string, unknown> | undefined;
  const metadataFinalize: { calls: number } = { calls: 0 };
  let safe = true;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/burn/prepare")) {
      const request = JSON.parse(String(init?.body)) as { requestId: string };
      const transaction = preparedTransaction(caller, safe);
      const message = transaction.message.serialize();
      return Response.json({
        preparationId: request.requestId,
        requestId: request.requestId,
        vault: Keypair.generate().publicKey.toBase58(),
        callerPublicKey: caller.publicKey.toBase58(),
        transactionBase64: Buffer.from(transaction.serialize()).toString(
          "base64"
        ),
        messageSha256: createHash("sha256").update(message).digest("hex"),
        lastValidBlockHeight: 1000,
        simulatedUnits: 123456,
        minimumOutputs: ["42"],
      });
    }
    if (url.endsWith("/burn/submit")) {
      submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        requestId: submitBody.requestId,
        submissionId: "relay-id",
        messageSha256: "digest",
        transactionBytes: 800,
      });
    }
    if (url.endsWith("/metadata/image/prepare")) {
      return Response.json({
        imageBase64: Buffer.from("prepared-webp").toString("base64"),
        imageContentType: "image/webp",
        originalImageBytes: 8,
        imageBytes: 13,
      });
    }
    if (url.endsWith("/metadata/finalize")) {
      metadataFinalize.calls += 1;
      metadataFinalizeBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({
        uri: "https://gateway.irys.xyz/metadata",
        imageUri: "https://gateway.irys.xyz/image",
        deliveryImageUri: "https://images.example/image",
        originalImageBytes: 13,
        imageBytes: 12,
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const service = makeService("https://gateway.example", true);
  const request = {
    launchMint: Keypair.generate().publicKey.toBase58(),
    legs: [{ mint: Keypair.generate().publicKey.toBase58(), bps: 10_000 }],
    amountInLamports: "100000000",
  };
  const receipt = await service.burn(request, wallet);
  check(
    receipt.status === "submitted",
    "caller-paid receipt was not submitted"
  );
  check(submitBody !== undefined, "submit endpoint was not called");
  check(
    Object.keys(submitBody).sort().join(",") ===
      "requestId,signedTransactionBase64",
    "browser sent a field other than requestId + signed transaction"
  );
  const submitted = VersionedTransaction.deserialize(
    Buffer.from(String(submitBody.signedTransactionBase64), "base64")
  );
  check(
    submitted.message.header.numRequiredSignatures === 1 &&
      submitted.signatures.length === 1 &&
      submitted.signatures[0].some((byte) => byte !== 0),
    "browser did not return one fully caller-signed transaction"
  );

  const preparedImage = await service.prepareMetadataImage(
    new Uint8Array(Buffer.from("raw-image")),
    "image/png"
  );
  check(
    Number(metadataFinalize.calls) === 0,
    "early image preparation created permanent metadata"
  );
  await service.uploadMetadata({
    name: "Final Name",
    symbol: "FINAL",
    description: "the description at confirmation time",
    image: preparedImage.image,
    imageContentType: preparedImage.imageContentType,
  });
  check(
    Number(metadataFinalize.calls) === 1,
    "confirmation did not finalize metadata"
  );
  check(
    metadataFinalizeBody?.description ===
      "the description at confirmation time",
    "final metadata did not use the confirmation-time fields"
  );
  check(
    typeof metadataFinalizeBody?.requestId === "string" &&
      /^[0-9a-f]{64}$/.test(String(metadataFinalizeBody.requestId)),
    "final metadata did not carry a stable content-derived request id"
  );

  safe = false;
  let rejected = false;
  try {
    await service.burn({ ...request }, wallet);
  } catch (error) {
    rejected =
      error instanceof ServiceError &&
      error.message.includes("ComputeBudget + burner");
  }
  check(rejected, "browser accepted a non-burner prepared transaction");
  console.log("PASS: browser keyless caller-paid contract and tamper guard");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
