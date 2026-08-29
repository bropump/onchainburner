CREATE TABLE IF NOT EXISTS burn_legs (
  signature TEXT NOT NULL,
  instruction_index INTEGER NOT NULL,
  leg_index INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  block_time INTEGER,
  launch_mint TEXT NOT NULL,
  vault TEXT NOT NULL,
  target_mint TEXT NOT NULL,
  bps INTEGER NOT NULL,
  sol_lamports TEXT NOT NULL,
  burned_atoms TEXT NOT NULL,
  PRIMARY KEY (signature, instruction_index, leg_index)
);

CREATE INDEX IF NOT EXISTS burn_legs_target_time
  ON burn_legs (target_mint, block_time DESC);
CREATE INDEX IF NOT EXISTS burn_legs_launch_time
  ON burn_legs (launch_mint, block_time DESC);
CREATE INDEX IF NOT EXISTS burn_legs_slot
  ON burn_legs (slot DESC);

CREATE TABLE IF NOT EXISTS token_mints (
  mint TEXT PRIMARY KEY,
  decimals INTEGER NOT NULL,
  current_supply_atoms TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS index_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO index_state (key, value)
VALUES
  ('latest_signature', ''),
  ('backfill_before', ''),
  ('backfill_complete', '0'),
  ('last_indexed_at', '0'),
  ('last_indexed_slot', '0');
