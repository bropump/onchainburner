-- The only historical $PUMP burn predates reference indexing and was bound
-- to this Meteora DLMM. Future rows record the transaction's reference
-- account directly in the indexer.
UPDATE burn_legs
SET reference_pool = 'HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh'
WHERE target_mint = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'
  AND reference_pool = '';
