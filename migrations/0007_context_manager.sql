ALTER TABLE todos ADD COLUMN raw_input TEXT;
ALTER TABLE todos ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE todos ADD COLUMN due_text TEXT;
ALTER TABLE todos ADD COLUMN archived_at TEXT;
ALTER TABLE todos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN recurrence_kind TEXT;
ALTER TABLE todos ADD COLUMN recurrence_interval INTEGER;
ALTER TABLE todos ADD COLUMN recurrence_until TEXT;
ALTER TABLE todos ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN last_completed_at TEXT;
ALTER TABLE todos ADD COLUMN last_completed_due_at TEXT;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

UPDATE todos
SET group_id = (
  SELECT tg.group_id
  FROM task_groups tg
  WHERE tg.task_id = todos.id
  ORDER BY tg.group_id ASC
  LIMIT 1
)
WHERE group_id IS NULL;

DROP TRIGGER IF EXISTS todos_fts_insert;
DROP TRIGGER IF EXISTS todos_fts_delete;
DROP TRIGGER IF EXISTS todos_fts_update;
DROP TABLE IF EXISTS todos_fts;

CREATE VIRTUAL TABLE todos_fts USING fts5(
  title,
  description,
  raw_input,
  content='todos',
  content_rowid='id'
);

INSERT INTO todos_fts(rowid, title, description, raw_input)
SELECT id, title, COALESCE(description, ''), COALESCE(raw_input, '')
FROM todos;

CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, title, description, raw_input)
  VALUES (new.id, new.title, COALESCE(new.description, ''), COALESCE(new.raw_input, ''));
END;

CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description, raw_input)
  VALUES ('delete', old.id, old.title, COALESCE(old.description, ''), COALESCE(old.raw_input, ''));
END;

CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description, raw_input)
  VALUES ('delete', old.id, old.title, COALESCE(old.description, ''), COALESCE(old.raw_input, ''));
  INSERT INTO todos_fts(rowid, title, description, raw_input)
  VALUES (new.id, new.title, COALESCE(new.description, ''), COALESCE(new.raw_input, ''));
END;

CREATE INDEX IF NOT EXISTS idx_todos_item_kind ON todos(item_kind);
CREATE INDEX IF NOT EXISTS idx_todos_archived_at ON todos(archived_at);
CREATE INDEX IF NOT EXISTS idx_todos_pinned ON todos(pinned);
CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_group_id ON todos(group_id);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
