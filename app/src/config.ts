/**
 * Network configuration — environment-driven, never code-driven.
 *
 * Switching the frontend between the demo fork and mainnet changes these
 * values (via Vite env vars at build time) and nothing else. In mainnet mode
 * the demo-only controls are absent and the burn service URL must point at
 * the production quote service.
 */
type ViteEnv = Record<string, string | boolean | undefined>;

const env: ViteEnv =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: ViteEnv }).env) ||
  {};

export const NETWORK: "demo" | "mainnet" =
  env.PROD === true || env.VITE_NETWORK === "mainnet" ? "mainnet" : "demo";

/**
 * A mainnet build never inherits localhost defaults. Cloudflare Pages can
 * override both URLs at build time without changing the static bundle code.
 */
export const RPC_URL: string =
  String(env.VITE_RPC_URL ?? "") ||
  (NETWORK === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "http://127.0.0.1:8899");

/** The quote-service endpoint. Demo: local stand-in. Mainnet: the real one. */
export const BURN_SERVICE_URL: string = (
  String(env.VITE_BURN_SERVICE_URL ?? "") ||
  (NETWORK === "mainnet" ? "/api" : "http://127.0.0.1:8787")
).replace(/\/+$/, "");

export const REOWN_PROJECT_ID: string =
  String(env.VITE_REOWN_PROJECT_ID ?? "") || "781abed065a7f978fdf79e46071aad20";

/**
 * Production is a compile-time hard stop for every demo key and service
 * action. Development keeps the fork loop available, but selecting mainnet
 * disables it even while running Vite's dev server.
 */
export const IS_DEMO = env.DEV === true && NETWORK === "demo";
