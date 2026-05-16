-- Rollback Migration 003: Remove provenance helper columns, indexes, and RPC.

BEGIN;
DROP FUNCTION IF EXISTS match_thoughts_by_source(TEXT, INT, TEXT, BOOLEAN);
DROP INDEX IF EXISTS idx_thoughts_source_file_hash;
DROP INDEX IF EXISTS idx_thoughts_code_hash;
ALTER TABLE thoughts DROP COLUMN IF EXISTS source_file_hash;
ALTER TABLE thoughts DROP COLUMN IF EXISTS code_hash;
COMMIT;
