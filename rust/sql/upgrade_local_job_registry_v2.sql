-- OFFLINE one-time upgrade. Stop the canonical Rust daemon first and back up
-- relay.sqlite with SQLite's backup API, including any WAL contents.
-- This intentionally removes historical PR identity without runtime fallback.
BEGIN IMMEDIATE;
DROP INDEX IF EXISTS source_registry_repo_pr;
ALTER TABLE source_registry DROP COLUMN pr_number;
CREATE INDEX source_registry_repo ON source_registry(repository);
UPDATE job_snapshot
  SET json=json_remove(json,'$.prNumber','$.externalPrNumber')
  WHERE json_type(json,'$.prNumber') IS NOT NULL
     OR json_type(json,'$.externalPrNumber') IS NOT NULL;
UPDATE migration_metadata SET value='local-git-id-v2' WHERE key='schema';
COMMIT;
