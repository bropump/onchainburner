/**
 * Network configuration — environment-driven, never code-driven.
 *
 * Switching the frontend between the demo fork and mainnet changes these
 * values (via Vite env vars at build time) and nothing else. In mainnet mode
 * the demo-only controls are absent and the burn service URL must point at
 * the production quote service.
 */
export const NETWORK: "demo" | "mainnet" =
  import.meta.env.PROD === true || import.meta.env.VITE_NETWORK === "mainnet"
    ? "mainnet"
    : "demo";

/**
 * On mainnet this is same-origin `/rpc`, served by the Worker in
 * `app/worker.ts`, which forwards to the real endpoint using a server-side
 * secret. A keyed RPC URL must NEVER be put in VITE_RPC_URL: Vite inlines
 * VITE_* into the bundle at build time, so it would be readable by every
 * visitor. VITE_RPC_URL remains for local development, where it points at a
 * fork and carries no secret.
 */
export const RPC_URL: string =
  NETWORK === "mainnet"
    ? // web3.js rejects a relative endpoint ("Endpoint URL must start with
      // `http:` or `https:`"), so the same-origin proxy is made absolute at
      // runtime rather than written as "/rpc".
      `${globalThis.location?.origin ?? ""}/rpc`
    : String(import.meta.env.VITE_RPC_URL ?? "") || "http://127.0.0.1:8899";

/** The quote-service endpoint. Demo: local stand-in. Mainnet: the real one. */
export const BURN_SERVICE_URL: string = (
  NETWORK === "mainnet"
    ? "/api"
    : String(import.meta.env.VITE_BURN_SERVICE_URL ?? "") ||
      "http://127.0.0.1:8787"
).replace(/\/+$/, "");

export const REOWN_PROJECT_ID: string =
  String(import.meta.env.VITE_REOWN_PROJECT_ID ?? "") ||
  "781abed065a7f978fdf79e46071aad20";

/**
 * Public address of the app-wide mainnet ALT used only to compress launch
 * setup. This is not an RPC credential and is safe to compile into the app.
 * An empty value makes the planner use its guarded no-ALT path; it will never
 * send an immutable Pump fee share without validate_config in the same tx.
 */
export const SETUP_LOOKUP_TABLE_ADDRESS: string | null =
  String(import.meta.env.VITE_SETUP_LOOKUP_TABLE ?? "").trim() || null;

/**
 * Production is a compile-time hard stop for every demo key and service
 * action. Development keeps the fork loop available, but selecting mainnet
 * disables it even while running Vite's dev server.
 */
export const IS_DEMO = import.meta.env.DEV === true && NETWORK === "demo";
