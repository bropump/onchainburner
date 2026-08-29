// MUST stay the first import: it patches Request/fetch before Axios, inside
// the Irys SDK, captures them. See worker-fetch-compat.ts — without it every
// Irys call throws "Unsupported cache mode: default" on workerd.
import "./worker-fetch-compat";
// Static imports are deliberate. Wrangler must bundle and validate the Irys
// implementation instead of leaving a bare dynamic package import in the
// emitted Worker.
// @ts-ignore -- declarations vary between Irys SDK patch releases.
import { Uploader } from "@irys/upload";
// @ts-ignore -- declarations vary between Irys SDK patch releases.
import { Solana } from "@irys/upload-solana";

/**
 * `rpcUrl` is the vault's own paid endpoint. Without it the Solana token
 * adapter funds uploads through the SDK's default public RPC, which rate
 * limits under any real load — the upload then fails at payment time, after
 * the image has already been compressed. `mainnet()` is the builder's default
 * and is stated anyway so a future default change cannot silently move
 * uploads to devnet, where the receipts would not be permanent.
 */
export async function createIrysUploader(
  wallet: string | Uint8Array,
  rpcUrl?: string
) {
  const builder = Uploader(Solana).withWallet(wallet).mainnet();
  return rpcUrl ? builder.withRpc(rpcUrl) : builder;
}
