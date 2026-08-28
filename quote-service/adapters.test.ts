/**
 * Regression coverage for `SolanaRpcGateway.getMint`'s Token-2022 TLV
 * handling.
 *
 * The bug this pins down (found live 2026-08-26, owner blocked mid-test):
 * Pump.fun `create_v2` launch mints are Token-2022 mints carrying
 * MetadataPointer + TokenMetadata and TWO ZEROED TRAILING BYTES after the
 * last TLV entry. Token-2022 itself accepts that shape — over-allocation is
 * legal and the program stops at the first Uninitialized sentinel — but
 * `@solana/spl-token` 0.4.x's `getExtensionTypes` walks
 * `while (index < len)` and reads a 4-byte header unchecked, throwing
 * RangeError on the 2-byte tail. `getMint`'s fail-closed catch then
 * reported a LIVE mint as `initialized: false`, which callers surfaced as
 * "INVALID_MINT: mint is absent or uninitialized" and refused every burn
 * whose vault named the mint. The fixture below reproduces the exact live
 * layout (357 bytes: 82 base + padding + account type + TLV 18/64 + 19/117
 * + 2 zero bytes) of mint CafqBLzSBjHywKSvQktC7h6vXFufYw8pmkTh6P83Pz3e.
 */
import { expect } from "chai";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SolanaRpcGateway } from "./adapters";

const MINT = new PublicKey("CafqBLzSBjHywKSvQktC7h6vXFufYw8pmkTh6P83Pz3e");

/** Base 82-byte SPL mint layout: no authorities, initialized, 6 decimals. */
function baseMint(): Buffer {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(0, 0); // mint_authority: None
  data.writeBigUInt64LE(1_000_000_000_000_000n, 36); // supply
  data[44] = 6; // decimals
  data[45] = 1; // is_initialized
  data.writeUInt32LE(0, 46); // freeze_authority: None
  return data;
}

/**
 * A Token-2022 mint in the live Pump `create_v2` shape: MetadataPointer
 * (type 18, 64 bytes) + TokenMetadata (type 19, `metadataLen` bytes),
 * followed by `trailingBytes` of zeroed slack.
 */
function pumpShapedMint(trailingBytes: number, metadataLen = 117): Buffer {
  const tlv = Buffer.alloc(4 + 64 + 4 + metadataLen + trailingBytes);
  tlv.writeUInt16LE(18, 0); // MetadataPointer
  tlv.writeUInt16LE(64, 2);
  tlv.fill(7, 4, 68); // authority + metadata address (content irrelevant)
  tlv.writeUInt16LE(19, 68); // TokenMetadata
  tlv.writeUInt16LE(metadataLen, 70);
  tlv.fill(3, 72, 72 + metadataLen);
  // 82-byte base, zero padding to 165, account-type byte Mint(1) at 165.
  const head = Buffer.alloc(166);
  baseMint().copy(head, 0);
  head[165] = 1;
  return Buffer.concat([head, tlv]);
}

function gatewayFor(owner: PublicKey, data: Buffer): SolanaRpcGateway {
  const fakeConnection = {
    async getAccountInfo() {
      return { owner, data, lamports: 5_000_000, executable: false };
    },
  } as unknown as Connection;
  return new SolanaRpcGateway(fakeConnection);
}

describe("SolanaRpcGateway.getMint Token-2022 TLV handling", () => {
  it("parses a Pump create_v2 mint with 2 trailing zero bytes (live 357-byte shape)", async () => {
    const data = pumpShapedMint(2);
    expect(data.length).to.equal(357); // byte-identical to the live layout
    const snapshot = await gatewayFor(TOKEN_2022_PROGRAM_ID, data).getMint(
      MINT
    );
    expect(snapshot).to.not.equal(null);
    // The regression: this came back initialized:false (RangeError swallowed
    // by the fail-closed catch), so the service refused a live mint as
    // "absent or uninitialized".
    expect(snapshot!.initialized).to.equal(true);
    expect(snapshot!.extensionTypes).to.deep.equal([18, 19]);
    expect(snapshot!.mintAuthority).to.equal(null);
    expect(snapshot!.freezeAuthority).to.equal(null);
  });

  it("parses an exact-size shape (no trailing slack) identically", async () => {
    // metadataLen 120 keeps the total off 355 (the MULTISIG_SIZE collision
    // below) so this genuinely tests the no-slack path.
    const snapshot = await gatewayFor(
      TOKEN_2022_PROGRAM_ID,
      pumpShapedMint(0, 120)
    ).getMint(MINT);
    expect(snapshot!.initialized).to.equal(true);
    expect(snapshot!.extensionTypes).to.deep.equal([18, 19]);
  });

  it("documents WHY Pump pads: a 355-byte mint collides with MULTISIG_SIZE and fails closed", async () => {
    // spl-token's unpackMint refuses ANY account of exactly 355 bytes
    // (MULTISIG_SIZE), so a metadata TLV ending at 355 total is unusable by
    // the client library no matter what. Pump's create_v2 pads such mints
    // by 2 zero bytes — which is precisely the trailing slack the first
    // test covers. The unpadded shape stays fail-closed here.
    const data = pumpShapedMint(0, 117);
    expect(data.length).to.equal(355);
    const snapshot = await gatewayFor(TOKEN_2022_PROGRAM_ID, data).getMint(
      MINT
    );
    expect(snapshot!.initialized).to.equal(false);
  });

  it("stops at the Uninitialized sentinel in a longer zeroed tail", async () => {
    const snapshot = await gatewayFor(
      TOKEN_2022_PROGRAM_ID,
      pumpShapedMint(64)
    ).getMint(MINT);
    expect(snapshot!.initialized).to.equal(true);
    expect(snapshot!.extensionTypes).to.deep.equal([18, 19]);
  });

  it("still fails closed on a mint whose base layout cannot be parsed", async () => {
    const snapshot = await gatewayFor(
      TOKEN_2022_PROGRAM_ID,
      Buffer.alloc(40) // shorter than the 82-byte base layout
    ).getMint(MINT);
    expect(snapshot).to.not.equal(null);
    expect(snapshot!.initialized).to.equal(false);
  });
});
