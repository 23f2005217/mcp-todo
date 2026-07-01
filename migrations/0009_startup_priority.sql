ALTER TABLE todos ADD COLUMN startup_priority INTEGER NOT NULL DEFAULT 7;

CREATE INDEX IF NOT EXISTS idx_todos_startup_priority ON todos(startup_priority);
