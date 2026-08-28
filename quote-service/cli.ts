/**
 * The one-shot CLI is retired. Burns go through server.ts:
 * POST /burn/prepare, caller signs, POST /burn/submit
 * (or one-shot POST /burn in fork-e2e mode).
 */
throw new Error(
  "quote-service CLI is retired; run server.ts (POST /burn/prepare, sign, POST /burn/submit — or one-shot POST /burn in fork-e2e mode)"
);
