PRAGMA defer_foreign_keys = true;

DROP TABLE IF EXISTS todos_fts;
DROP INDEX IF EXISTS idx_todos_due_date;
DROP INDEX IF EXISTS idx_todos_priority;
DROP INDEX IF EXISTS idx_todos_completed;
DROP INDEX IF EXISTS idx_todos_created_at;
DROP INDEX IF EXISTS idx_task_tags_task_id;
DROP INDEX IF EXISTS idx_task_tags_tag_id;
DROP INDEX IF EXISTS idx_task_logs_task_id;
DROP INDEX IF EXISTS idx_task_logs_created_at;
DROP INDEX IF EXISTS idx_task_groups_task_id;
DROP INDEX IF EXISTS idx_task_groups_group_id;

ALTER TABLE task_tags RENAME TO task_tags_legacy;
ALTER TABLE task_logs RENAME TO task_logs_legacy;
ALTER TABLE task_groups RENAME TO task_groups_legacy;
ALTER TABLE todos RENAME TO todos_legacy;

CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 2,
  due_at TEXT,
  snoozed_until TEXT,
  ignored_at TEXT,
  completed_at TEXT,
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO todos (
  id,
  title,
  description,
  completed,
  priority,
  due_at,
  snoozed_until,
  ignored_at,
  completed_at,
  last_active_at,
  created_at,
  updated_at
)
SELECT
  id,
  COALESCE(name, 'Untitled task'),
  description,
  COALESCE(completed, 0),
  COALESCE(priority, 2),
  due_date,
  NULL,
  NULL,
  completed_at,
  COALESCE(updated_at, created_at, CURRENT_TIMESTAMP),
  COALESCE(created_at, CURRENT_TIMESTAMP),
  COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
FROM todos_legacy;

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (task_id, tag_id),
  FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_groups (
  task_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  PRIMARY KEY (task_id, group_id),
  FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

INSERT INTO task_tags (task_id, tag_id)
SELECT task_id, tag_id
FROM task_tags_legacy;

INSERT INTO task_logs (id, task_id, action, metadata, created_at)
SELECT id, task_id, action, metadata, created_at
FROM task_logs_legacy;

INSERT INTO task_groups (task_id, group_id)
SELECT task_id, group_id
FROM task_groups_legacy;

CREATE VIRTUAL TABLE todos_fts USING fts5(
  title,
  description,
  content='todos',
  content_rowid='id'
);

INSERT INTO todos_fts(rowid, title, description)
SELECT id, title, COALESCE(description, '')
FROM todos;

CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, title, description)
  VALUES (new.id, new.title, COALESCE(new.description, ''));
END;

CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description)
  VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
END;

CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description)
  VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
  INSERT INTO todos_fts(rowid, title, description)
  VALUES (new.id, new.title, COALESCE(new.description, ''));
END;

CREATE INDEX idx_todos_due_at ON todos(due_at);
CREATE INDEX idx_todos_priority ON todos(priority);
CREATE INDEX idx_todos_completed ON todos(completed);
CREATE INDEX idx_todos_updated_at ON todos(updated_at);
CREATE INDEX idx_todos_last_active_at ON todos(last_active_at);
CREATE INDEX idx_todos_snoozed_until ON todos(snoozed_until);
CREATE INDEX idx_todos_ignored_at ON todos(ignored_at);
CREATE INDEX idx_task_tags_task_id ON task_tags(task_id);
CREATE INDEX idx_task_tags_tag_id ON task_tags(tag_id);
CREATE INDEX idx_task_logs_task_id ON task_logs(task_id);
CREATE INDEX idx_task_logs_created_at ON task_logs(created_at);
CREATE INDEX idx_task_groups_task_id ON task_groups(task_id);
CREATE INDEX idx_task_groups_group_id ON task_groups(group_id);

DROP TABLE task_tags_legacy;
DROP TABLE task_logs_legacy;
DROP TABLE task_groups_legacy;
DROP TABLE todos_legacy;

PRAGMA defer_foreign_keys = false;
