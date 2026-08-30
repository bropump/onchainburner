ALTER TABLE burn_legs
ADD COLUMN reference_pool TEXT NOT NULL DEFAULT '';

-- The existing finalized rows predate reference indexing. Their only
-- address-bound target is NEIRO; $PUMP uses a Pump-venue zero reference.
UPDATE burn_legs
SET reference_pool = 'HvAqakZgurMR2br1eGWPU6EeFcxzmeW8n6Mn7ejEf3DV'
WHERE target_mint = 'CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump';
