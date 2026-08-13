-- The encrypted debug-exchange (prod->preview session copy) is retired: the flow is now a
-- hand-carried viewer export zip pushed through the standard collector upload API. Drop its
-- state tables. debug_export_passkey_challenges survives under an honest name: despite its
-- legacy home it stores the fresh-passkey ceremony challenges webauthn.ts mints for EVERY
-- sensitive approval, including read grants.
ALTER TABLE debug_export_passkey_challenges RENAME TO passkey_freshness_challenges;
DROP INDEX IF EXISTS debug_export_passkey_expiry;
CREATE INDEX passkey_freshness_expiry ON passkey_freshness_challenges (expires_at);
DROP TABLE IF EXISTS debug_export_devices;
DROP TABLE IF EXISTS debug_export_replays;
DROP TABLE IF EXISTS debug_export_objects;
DROP TABLE IF EXISTS debug_export_jobs;
DROP TABLE IF EXISTS debug_import_objects;
DROP TABLE IF EXISTS debug_import_jobs;
DROP TABLE IF EXISTS debug_exchange_audit;
