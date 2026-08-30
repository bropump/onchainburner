/**
 * Curated fast-path candidates for shipped presets. Most are historical
 * burn-proven pools from the 2026-08-26 fork campaign; newer entries record
 * the explicitly selected pool that was live-authenticated when the preset
 * shipped. A table entry is never trusted by itself: `resolveSelection`
 * re-authenticates the exact account (owner, layout, pair, vaults, fee and
 * depth) on every fresh session, then the setup transaction runs the on-chain
 * Mode A validation again. Only an unknown mint pays for full GPA enumeration.
 */

export type KnownReference = {
  symbol: string;
  /** "pump" = the Pump venue (curve / canonical PumpSwap pool), derived. */
  pool: string | "pump";
  venue: string;
  pickedAt: string;
  reason: string;
};

export const KNOWN_REFERENCES: Record<string, KnownReference> = {
  EBmJhqzjyfd3SUrTjUu8Gzi8zMQWDXmyuDhg2a7cCjxW: {
    symbol: "$COOK",
    pool: "pump",
    venue: "Pump curve",
    pickedAt: "2026-08-30",
    reason:
      "the canonical Pump venue is derived from the mint and authenticated live; using the derived fast path avoids an unnecessary all-venue market scan",
  },
  "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump": {
    symbol: "ANSEM",
    pool: "pump",
    venue: "PumpSwap",
    pickedAt: "2026-08-30",
    reason:
      "the canonical protocol-owned PumpSwap pool is derived from the mint and authenticated live",
  },
  "9Pfync3ejPC9eHqVzq3nYQJAhyhjqpnB9UsaSfLxpump": {
    symbol: "KET",
    pool: "pump",
    venue: "PumpSwap",
    pickedAt: "2026-08-30",
    reason:
      "the canonical protocol-owned PumpSwap pool is derived from the mint and authenticated live",
  },
  GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump: {
    symbol: "CHILLHOUSE",
    pool: "pump",
    venue: "PumpSwap",
    pickedAt: "2026-08-30",
    reason:
      "the canonical protocol-owned PumpSwap pool is derived from the mint and authenticated live",
  },
  "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump": {
    symbol: "PNUT",
    pool: "4AZRPNEfCJ7iw28rJu5aUyeQhYcvdcNm8cswyL51AY9i",
    venue: "Raydium v4",
    pickedAt: "2026-08-29",
    reason:
      "the main SOL/PNUT Raydium v4 pool authenticates live at ~16,168 SOL with 99.6845% of LP burned (~16,117 SOL permanently non-withdrawable)",
  },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: {
    symbol: "JUP",
    pool: "C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg",
    venue: "Meteora DLMM",
    pickedAt: "2026-08-29",
    reason:
      "the main established SOL/JUP concentrated pool: deepest supported DLMM at ~4,949 SOL and live since 2024-01-31, versus the thin ~48 SOL DLMM Jupiter chooses for a 1 SOL probe",
  },
  METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL: {
    symbol: "MET",
    pool: "AsSyvUnbfaZJPRrNh3kUuvZTeHKoMVWEoHz86f4Q5D9x",
    venue: "Meteora DLMM",
    pickedAt: "2026-08-29",
    reason:
      "the main established SOL/MET concentrated pool: deepest supported DLMM at ~2,175 SOL, from MET's original 2025-10-23 launch-day pool cohort, and burn-proven",
  },
  "43VWkd99HjqkhFTZbWBpMpRhjG469nWa7x7uEsgSH7We": {
    symbol: "STNK",
    pool: "EyktEFod1gAgsuM1hXmEpqkitFFk9XczkqLPx2vKiceg",
    venue: "Raydium CP",
    pickedAt: "2026-08-29",
    reason:
      "the canonical SOL/STNK Raydium CP authenticates live at ~1,447 SOL with 99.98% of LP in verified Burn & Earn custody",
  },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: {
    symbol: "JTO",
    pool: "JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo",
    venue: "Raydium CLMM",
    pickedAt: "2026-08-26",
    reason:
      "JTO's main SOL market (~142 SOL deep, the deepest of 25 found) and burn-proven today; position-based depth, so the margin over the 50 SOL gate is the protection",
  },
  CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump: {
    symbol: "NEIRO",
    pool: "HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV",
    venue: "Raydium v4",
    pickedAt: "2026-08-26",
    reason:
      "burn-proven; 1,362.6 of 1,363.7 SOL cannot be withdrawn (99.92% of LP burned) — clears the 50 SOL gate on locked depth alone",
  },
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: {
    symbol: "$PUMP",
    pool: "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh",
    venue: "Meteora DLMM",
    pickedAt: "2026-08-28",
    reason:
      "deepest SOL-quoted market the program can price: 11,617 SOL vs 4,476 for the Raydium CLMM it replaced (2026-08-28 enumeration, 89 candidates). NO $PUMP pool has locked depth clearing the 50 SOL gate -- every candidate is transient-positions -- so durability cannot be the tiebreak here and depth is what remains: 232x the gate rather than 89x. Existing $PUMP vaults stay bound to 45ssPkUQ...; this only changes new ones. Do NOT point this at the Pump venue: $PUMP graduated, has no live bonding curve, and the service answers 422 (tried 2026-08-28, hung the UI). Orca is deeper still on SOL but the program cannot read Whirlpool layouts.",
  },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: {
    symbol: "BONK",
    pool: "GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN",
    venue: "Raydium CLMM",
    pickedAt: "2026-08-26",
    reason:
      "burn-proven BONK/SOL market from today's campaign; position-based depth — verified live against the 50 SOL gate before every setup",
  },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: {
    symbol: "WIF",
    pool: "EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx",
    venue: "Raydium v4",
    pickedAt: "2026-08-26",
    reason:
      "burn-proven, and the pool Jupiter routes through: 28,242 SOL deep with 99.65% of LP burned/locked",
  },
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump": {
    symbol: "FARTCOIN",
    pool: "Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw",
    venue: "Raydium v4",
    pickedAt: "2026-08-26",
    reason:
      "burn-proven, and the pool Jupiter routes through: 43,444 SOL deep with 99.77% of LP burned/locked",
  },
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": {
    symbol: "POPCAT",
    pool: "FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxRF2x9RwLLMo",
    venue: "Raydium v4",
    pickedAt: "2026-08-26",
    reason:
      "burn-proven POPCAT/SOL v4 market from today's campaign; LP-lock share and depth verified live before every setup",
  },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": {
    symbol: "RAY",
    pool: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
    venue: "Raydium v4",
    pickedAt: "2026-08-26",
    reason:
      "burn-proven canonical SOL/RAY v4 market from today's campaign; LP-lock share and depth verified live before every setup",
  },
};
