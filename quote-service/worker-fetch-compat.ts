/**
 * workerd rejects `cache` values that browsers accept.
 *
 * The Irys SDK talks to its node through Axios, and Axios's fetch adapter
 * sets `cache: "default"` on the Request it builds. workerd throws
 * `TypeError: Unsupported cache mode: default` when that Request is
 * constructed, so EVERY Irys call fails — getBalance, getPrice, upload.
 *
 * That failure is worse than it looks. `metadataUploadFromEnvironment` calls
 * `irys.getBalance()` during startup and rethrows, so an unpatched Worker
 * fails to initialize and returns 503 for the WHOLE api, not just uploads.
 * Verified in workerd before this shim existed, and verified fixed after:
 * with the shim a random keypair reports balance 0 and a real 1 KiB price
 * quote from the live Irys node.
 *
 * Why a separate module rather than statements at the top of `irys-client`:
 * ES module imports are hoisted, so anything written above `import { Uploader }
 * from "@irys/upload"` still runs AFTER Axios has captured the globals. Only a
 * side-effect module imported *before* it is guaranteed to run first. Patching
 * `fetch` alone is not enough either — the throw happens in the `Request`
 * constructor, before fetch is ever called — so both are wrapped.
 *
 * The patch is feature-detected, so importing this on Node (the retained
 * `node-main` entry) leaves undici's own `cache` handling untouched.
 */

/** True when the runtime refuses a spec-legal `cache` value, i.e. workerd. */
function rejectsCacheOption(): boolean {
  try {
    new Request("https://example.invalid/", { cache: "default" });
    return false;
  } catch {
    return true;
  }
}

function withoutCache(init: RequestInit): RequestInit {
  // `cache` is deleted rather than overwritten: workerd rejects the property's
  // presence with an unsupported value, and there is no value that means
  // "browser default" to it.
  const { cache: _discarded, ...rest } = init as RequestInit & {
    cache?: unknown;
  };
  return rest;
}

if (rejectsCacheOption()) {
  const RealRequest = globalThis.Request;
  class CompatRequest extends RealRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init && "cache" in init ? withoutCache(init) : init);
    }
  }
  globalThis.Request = CompatRequest as unknown as typeof Request;

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(
      input,
      init && "cache" in init ? withoutCache(init) : init
    )) as typeof fetch;
}

export const workerFetchCompatInstalled = true;
