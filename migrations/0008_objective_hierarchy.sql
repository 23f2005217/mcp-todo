ALTER TABLE todos ADD COLUMN entity_type TEXT;
ALTER TABLE todos ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE todos ADD COLUMN objective_id INTEGER REFERENCES todos(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN stale_after_at TEXT;
ALTER TABLE todos ADD COLUMN last_touched_at TEXT;
ALTER TABLE todos ADD COLUMN last_meaningful_at TEXT;
ALTER TABLE todos ADD COLUMN superseded_at TEXT;

UPDATE todos
SET entity_type = CASE
  WHEN archived_at IS NOT NULL THEN 'archived_history'
  WHEN item_kind = 'memory' THEN 'context_memory'
  WHEN recurrence_kind IS NOT NULL THEN 'recurring_system'
  ELSE 'tactical_task'
END
WHERE entity_type IS NULL;

UPDATE todos
SET lifecycle_state = CASE
  WHEN archived_at IS NOT NULL THEN 'archived'
  WHEN completed = 1 THEN 'completed'
  ELSE 'active'
END;

UPDATE todos
SET last_touched_at = COALESCE(last_active_at, updated_at, created_at),
    last_meaningful_at = COALESCE(last_active_at, updated_at, created_at),
    stale_after_at = datetime(COALESCE(last_active_at, updated_at, created_at), '+21 days')
WHERE last_touched_at IS NULL;

ALTER TABLE projects ADD COLUMN active_objective_id INTEGER REFERENCES todos(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN focus_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN focus_updated_at TEXT;

CREATE TABLE IF NOT EXISTS objectives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES todos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS item_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER NOT NULL,
  target_item_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_item_id) REFERENCES todos(id) ON DELETE CASCADE,
  FOREIGN KEY (target_item_id) REFERENCES todos(id) ON DELETE CASCADE,
  UNIQUE(source_item_id, target_item_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS focus_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  objective_id INTEGER,
  strategic_focus_id INTEGER,
  tactical_next_step_id INTEGER,
  focus_version INTEGER NOT NULL DEFAULT 0,
  explanation_json TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE SET NULL,
  FOREIGN KEY (strategic_focus_id) REFERENCES todos(id) ON DELETE SET NULL,
  FOREIGN KEY (tactical_next_step_id) REFERENCES todos(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  project_id INTEGER,
  event_type TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES todos(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_todos_entity_type ON todos(entity_type);
CREATE INDEX IF NOT EXISTS idx_todos_lifecycle_state ON todos(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_todos_objective_id ON todos(objective_id);
CREATE INDEX IF NOT EXISTS idx_todos_stale_after_at ON todos(stale_after_at);
CREATE INDEX IF NOT EXISTS idx_projects_active_objective_id ON projects(active_objective_id);
CREATE INDEX IF NOT EXISTS idx_objectives_project_status ON objectives(project_id, status);
CREATE INDEX IF NOT EXISTS idx_objectives_item_id ON objectives(item_id);
CREATE INDEX IF NOT EXISTS idx_item_relationships_source ON item_relationships(source_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relationships_target ON item_relationships(target_item_id);
CREATE INDEX IF NOT EXISTS idx_item_relationships_type ON item_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_focus_snapshots_project_version ON focus_snapshots(project_id, focus_version);
CREATE INDEX IF NOT EXISTS idx_item_events_item_id ON item_events(item_id);
