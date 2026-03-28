-- 0004: enhance todos table (priority, completed_at, description already exists)
-- Add priority column (1=low, 2=medium, 3=high) and completed_at timestamp
-- Recreate table since ALTER has limits in SQLite
PRAGMA defer_foreign_keys = true;

ALTER TABLE todos ADD COLUMN priority INTEGER DEFAULT 1;
ALTER TABLE todos ADD COLUMN completed_at TEXT;

PRAGMA defer_foreign_keys = false;
