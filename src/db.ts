import { advanceRecurringDueDate } from "./due.js";

export type ItemKind = "task" | "memory";
export type EntityType =
  | "strategic_goal"
  | "tactical_task"
  | "recurring_system"
  | "context_memory"
  | "archived_history";
export type LifecycleState = "active" | "superseded" | "archived" | "completed" | "stale" | "dormant";
export type RelationshipType = "supersedes" | "blocks" | "depends_on" | "supports" | "derived_from" | "duplicate_of" | "replaces";
export type PriorityLevel = 1 | 2 | 3;
export type RecurrenceKind = "daily" | "weekly" | "monthly" | "weekdays";

export interface Task {
  id: number;
  title: string;
  description: string | null;
  raw_input: string | null;
  item_kind: ItemKind;
  entity_type: EntityType;
  lifecycle_state: LifecycleState;
  objective_id: number | null;
  completed: number;
  priority: number;
  startup_priority: number;
  due_at: string | null;
  due_text: string | null;
  snoozed_until: string | null;
  ignored_at: string | null;
  archived_at: string | null;
  pinned: number;
  recurrence_kind: RecurrenceKind | null;
  recurrence_interval: number | null;
  recurrence_until: string | null;
  project_id: number | null;
  group_id: number | null;
  completed_at: string | null;
  last_completed_at: string | null;
  last_completed_due_at: string | null;
  last_active_at: string | null;
  stale_after_at: string | null;
  last_touched_at: string | null;
  last_meaningful_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  active_objective_id: number | null;
  focus_version: number;
  focus_updated_at: string | null;
}

export interface Group {
  id: number;
  name: string;
  slug: string;
  description: string | null;
}

export interface Tag {
  id: number;
  name: string;
  slug: string;
}

export interface EnrichedTask extends Task {
  project: Project | null;
  group: Group | null;
  tags: Tag[];
}

export interface ItemListQuery {
  ids?: number[];
  kinds?: ItemKind[];
  entity_types?: EntityType[];
  lifecycle_states?: LifecycleState[];
  completed?: boolean;
  archived?: boolean;
  pinned?: boolean;
  priority?: PriorityLevel[];
  startup_priority_min?: number;
  startup_priority_max?: number;
  q?: string;
  due_before?: string;
  due_after?: string;
  project_slugs?: string[];
  group_slugs?: string[];
  tags?: string[];
  stale_only?: boolean;
  limit?: number;
  offset?: number;
  sort?:
    | "updated_at"
    | "-updated_at"
    | "created_at"
    | "-created_at"
    | "due_at"
    | "-due_at"
    | "priority"
    | "-priority"
    | "title"
    | "-title";
}

export interface ObjectiveRecord {
  id: number;
  project_id: number;
  item_id: number;
  status: "active" | "completed" | "superseded" | "dormant";
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationshipRecord {
  id: number;
  source_item_id: number;
  target_item_id: number;
  relationship_type: RelationshipType;
  confidence: number;
  metadata: string | null;
  created_at: string;
}

export interface FocusContext {
  project: Project | null;
  objective: ObjectiveRecord | null;
  strategic_focus: EnrichedTask | null;
  tactical_next_step: EnrichedTask | null;
  blockers: EnrichedTask[];
  recurring_systems: EnrichedTask[];
  replaced_items: EnrichedTask[];
  focus_version: number;
  generated_at: string;
}

export const PRIORITY_NAMES: Record<PriorityLevel, string> = {
  1: "low",
  2: "medium",
  3: "high",
};

export const PRIORITY_VALUES: Record<string, PriorityLevel> = {
  low: 1,
  medium: 2,
  high: 3,
};

const STALE_AFTER_DAYS = 21;
const ACTIVE_WINDOW_HOURS = 48;
const UPCOMING_WINDOW_DAYS = 7;
const IGNORE_COOLDOWN_HOURS = 48;

function inferEntityType(input: {
  item_kind: ItemKind;
  recurrence_kind?: RecurrenceKind | null;
  archived_at?: string | null;
}): EntityType {
  if (input.archived_at) return "archived_history";
  if (input.item_kind === "memory") return "context_memory";
  if (input.recurrence_kind) return "recurring_system";
  return "tactical_task";
}

function row<T>(value: Record<string, unknown> | null): T | null {
  return value as T | null;
}

function rows<T>(value: Record<string, unknown>[]): T[] {
  return value as T[];
}

function isoOffset(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function isoOffsetDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function uniqueNormalizedValues(values?: string[]): string[] {
  return Array.from(
    new Set(values?.map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [])
  );
}

async function ensureEntity(
  db: D1Database,
  table: "projects" | "groups",
  input: { name: string; slug?: string; description?: string | null }
): Promise<Project | Group> {
  const slug = (input.slug ?? input.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  await db
    .prepare(`INSERT OR IGNORE INTO ${table} (name, slug, description) VALUES (?, ?, ?)`)
    .bind(input.name.trim(), slug, input.description ?? null)
    .run();

  if (input.description !== undefined) {
    await db
      .prepare(`UPDATE ${table} SET name = ?, description = ? WHERE slug = ?`)
      .bind(input.name.trim(), input.description, slug)
      .run();
  } else {
    await db
      .prepare(`UPDATE ${table} SET name = ? WHERE slug = ?`)
      .bind(input.name.trim(), slug)
      .run();
  }

  const record = await db
      .prepare(
        table === "projects"
          ? "SELECT id, name, slug, description, active_objective_id, focus_version, focus_updated_at FROM projects WHERE slug = ?"
          : "SELECT id, name, slug, description FROM groups WHERE slug = ?"
      )
    .bind(slug)
    .first();

  if (!record) {
    throw new Error(`Failed to ensure ${table.slice(0, -1)} '${slug}'`);
  }

  return record as unknown as Project | Group;
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  return rows<Project>(
    await db
      .prepare("SELECT id, name, slug, description, active_objective_id, focus_version, focus_updated_at FROM projects ORDER BY name ASC")
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

export async function listGroups(db: D1Database): Promise<Group[]> {
  return rows<Group>(
    await db
      .prepare("SELECT id, name, slug, description FROM groups ORDER BY name ASC")
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

export async function upsertProject(
  db: D1Database,
  input: { name: string; slug?: string; description?: string | null }
): Promise<Project> {
  return ensureEntity(db, "projects", input) as Promise<Project>;
}

export async function upsertGroup(
  db: D1Database,
  input: { name: string; slug?: string; description?: string | null }
): Promise<Group> {
  return ensureEntity(db, "groups", input) as Promise<Group>;
}

export async function deleteProject(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM projects WHERE slug = ?").bind(slug).run();
  return result.meta.changes > 0;
}

export async function deleteGroup(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM groups WHERE slug = ?").bind(slug).run();
  return result.meta.changes > 0;
}

export async function listTags(db: D1Database): Promise<Tag[]> {
  return rows<Tag>(
    await db
      .prepare("SELECT id, name, slug FROM tags ORDER BY name ASC")
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

export async function ensureTags(db: D1Database, tags: string[]): Promise<Tag[]> {
  const normalized = uniqueNormalizedValues(tags).map((name) => ({
    name,
    slug: name.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  }));

  for (const tag of normalized) {
    if (!tag.slug) continue;
    await db
      .prepare("INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)")
      .bind(tag.name, tag.slug)
      .run();
  }

  if (normalized.length === 0) return [];

  const placeholders = normalized.map(() => "?").join(", ");
  return rows<Tag>(
    await db
      .prepare(`SELECT id, name, slug FROM tags WHERE slug IN (${placeholders}) ORDER BY name ASC`)
      .bind(...normalized.map((tag) => tag.slug))
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

async function setTaskTags(db: D1Database, taskId: number, tags: string[]) {
  await db.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(taskId).run();
  const records = await ensureTags(db, tags);
  for (const tag of records) {
    await db
      .prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)")
      .bind(taskId, tag.id)
      .run();
  }
}

export async function getTaskById(db: D1Database, id: number): Promise<Task | null> {
  return row<Task>(await db.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first());
}

export async function getTasksByIds(db: D1Database, ids: number[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return rows<Task>(
    await db
      .prepare(`SELECT * FROM todos WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

/**
 * Load relationships where the given items are the target of a supersession,
 * replacement, or derivation. Returns a map from target item id to the
 * relationship records that mark it as historical.
 */
export async function getSupersedingRelationships(
  db: D1Database,
  itemIds: number[]
): Promise<Map<number, RelationshipRecord[]>> {
  if (itemIds.length === 0) return new Map();
  const placeholders = itemIds.map(() => "?").join(", ");
  const records = await db
    .prepare(
      `SELECT *
       FROM item_relationships
       WHERE target_item_id IN (${placeholders})
         AND relationship_type IN ('supersedes', 'replaces', 'derived_from')
       ORDER BY created_at DESC`
    )
    .bind(...itemIds)
    .all()
    .then((result) => result.results as Record<string, unknown>[]);

  const byTarget = new Map<number, RelationshipRecord[]>();
  for (const record of records) {
    const targetId = Number(record.target_item_id);
    const current = byTarget.get(targetId) ?? [];
    current.push(record as unknown as RelationshipRecord);
    byTarget.set(targetId, current);
  }
  return byTarget;
}

async function getTaskTagsMap(db: D1Database, taskIds: number[]): Promise<Map<number, Tag[]>> {
  if (taskIds.length === 0) return new Map();
  const placeholders = taskIds.map(() => "?").join(", ");
  const tagRows = await db
    .prepare(
      `SELECT tt.task_id, t.id, t.name, t.slug
       FROM task_tags tt
       JOIN tags t ON t.id = tt.tag_id
       WHERE tt.task_id IN (${placeholders})`
    )
    .bind(...taskIds)
    .all()
    .then((result) => result.results as Array<Record<string, unknown> & { task_id: number }>);

  const tagsByTaskId = new Map<number, Tag[]>();
  for (const tagRow of tagRows) {
    const taskId = Number(tagRow.task_id);
    const current = tagsByTaskId.get(taskId) ?? [];
    current.push({
      id: Number(tagRow.id),
      name: String(tagRow.name),
      slug: String(tagRow.slug),
    });
    tagsByTaskId.set(taskId, current);
  }

  return tagsByTaskId;
}

async function getProjectsMap(db: D1Database, projectIds: number[]): Promise<Map<number, Project>> {
  if (projectIds.length === 0) return new Map();
  const placeholders = projectIds.map(() => "?").join(", ");
  const records = await db
    .prepare(`SELECT id, name, slug, description, active_objective_id, focus_version, focus_updated_at FROM projects WHERE id IN (${placeholders})`)
    .bind(...projectIds)
    .all()
    .then((result) => result.results as Record<string, unknown>[]);

  return new Map(records.map((record) => [Number(record.id), record as unknown as Project]));
}

async function getGroupsMap(db: D1Database, groupIds: number[]): Promise<Map<number, Group>> {
  if (groupIds.length === 0) return new Map();
  const placeholders = groupIds.map(() => "?").join(", ");
  const records = await db
    .prepare(`SELECT id, name, slug, description FROM groups WHERE id IN (${placeholders})`)
    .bind(...groupIds)
    .all()
    .then((result) => result.results as Record<string, unknown>[]);

  return new Map(records.map((record) => [Number(record.id), record as unknown as Group]));
}

export async function enrichTasks(db: D1Database, tasks: Task[]): Promise<EnrichedTask[]> {
  if (tasks.length === 0) return [];

  const [tagsByTaskId, projectById, groupById] = await Promise.all([
    getTaskTagsMap(db, tasks.map((task) => task.id)),
    getProjectsMap(
      db,
      Array.from(new Set(tasks.map((task) => task.project_id).filter((id): id is number => typeof id === "number")))
    ),
    getGroupsMap(
      db,
      Array.from(new Set(tasks.map((task) => task.group_id).filter((id): id is number => typeof id === "number")))
    ),
  ]);

  return tasks.map((task) => ({
    ...task,
    project: task.project_id ? projectById.get(task.project_id) ?? null : null,
    group: task.group_id ? groupById.get(task.group_id) ?? null : null,
    tags: (tagsByTaskId.get(task.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export async function enrichTask(db: D1Database, task: Task): Promise<EnrichedTask> {
  const [enriched] = await enrichTasks(db, [task]);
  return enriched;
}

async function resolveProjectId(
  db: D1Database,
  project:
    | { slug?: string; name?: string; description?: string | null }
    | null
    | undefined
): Promise<number | null> {
  if (!project) return null;
  if (project.slug) {
    const record = await db
      .prepare("SELECT id FROM projects WHERE slug = ?")
      .bind(project.slug.trim().toLowerCase())
      .first();
    if (record) return Number(record.id);
    if (!project.name) {
      throw new Error(`Project '${project.slug}' not found`);
    }
  }
  if (project.name) {
    const created = await upsertProject(db, { ...project, name: project.name });
    return created.id;
  }
  return null;
}

async function resolveGroupId(
  db: D1Database,
  group:
    | { slug?: string; name?: string; description?: string | null }
    | null
    | undefined
): Promise<number | null> {
  if (!group) return null;
  if (group.slug) {
    const record = await db
      .prepare("SELECT id FROM groups WHERE slug = ?")
      .bind(group.slug.trim().toLowerCase())
      .first();
    if (record) return Number(record.id);
    if (!group.name) {
      throw new Error(`Group '${group.slug}' not found`);
    }
  }
  if (group.name) {
    const created = await upsertGroup(db, { ...group, name: group.name });
    return created.id;
  }
  return null;
}

export async function createTask(
  db: D1Database,
  input: {
    title: string;
    description?: string | null;
    raw_input?: string | null;
    item_kind: ItemKind;
    entity_type?: EntityType;
    lifecycle_state?: LifecycleState;
    objective_id?: number | null;
    priority: PriorityLevel;
    startup_priority?: number;
    due_at?: string | null;
    due_text?: string | null;
    project?: { slug?: string; name?: string; description?: string | null } | null;
    group?: { slug?: string; name?: string; description?: string | null } | null;
    tags?: string[];
    pinned?: boolean;
    recurrence_kind?: RecurrenceKind | null;
    recurrence_interval?: number | null;
    recurrence_until?: string | null;
  }
): Promise<EnrichedTask> {
  const now = new Date().toISOString();
  const entityType = input.entity_type ?? inferEntityType(input);
  const lifecycleState = input.lifecycle_state ?? "active";
  const [projectId, groupId] = await Promise.all([
    resolveProjectId(db, input.project),
    resolveGroupId(db, input.group),
  ]);

  const inserted = await db
    .prepare(
      `INSERT INTO todos (
        title,
        description,
        raw_input,
        item_kind,
        entity_type,
        lifecycle_state,
        objective_id,
        completed,
        priority,
        startup_priority,
        due_at,
        due_text,
        snoozed_until,
        ignored_at,
        archived_at,
        pinned,
        recurrence_kind,
        recurrence_interval,
        recurrence_until,
        project_id,
        group_id,
        completed_at,
        last_completed_at,
        last_completed_due_at,
        last_active_at,
        stale_after_at,
        last_touched_at,
        last_meaningful_at,
        superseded_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, datetime(?, '+21 days'), ?, ?, NULL, ?, ?)`
    )
    .bind(
      input.title.trim(),
      input.description ?? null,
      input.raw_input ?? null,
      input.item_kind,
      entityType,
      lifecycleState,
      input.objective_id ?? null,
      input.priority,
      input.startup_priority ?? 7,
      input.due_at ?? null,
      input.due_text ?? null,
      input.pinned ? 1 : 0,
      input.recurrence_kind ?? null,
      input.recurrence_interval ?? null,
      input.recurrence_until ?? null,
      projectId,
      groupId,
      now,
      now,
      now,
      now,
      now,
      now
    )
    .run();

  const taskId = Number(inserted.meta.last_row_id);
  await setTaskTags(db, taskId, input.tags ?? []);
  await logAction(db, taskId, "create", {
    item_kind: input.item_kind,
    entity_type: entityType,
    lifecycle_state: lifecycleState,
    objective_id: input.objective_id ?? null,
    priority: input.priority,
    due_at: input.due_at ?? null,
  });

  const task = await getTaskById(db, taskId);
  if (!task) throw new Error("Task insert completed but could not be reloaded");
  return enrichTask(db, task);
}

export async function updateTask(
  db: D1Database,
  id: number,
  changes: {
    title?: string;
    description?: string | null;
    raw_input?: string | null;
    item_kind?: ItemKind;
    entity_type?: EntityType;
    lifecycle_state?: LifecycleState;
    objective_id?: number | null;
    clear_objective?: boolean;
    priority?: PriorityLevel;
    startup_priority?: number | null;
    due_at?: string | null;
    due_text?: string | null;
    clear_due?: boolean;
    project?: { slug?: string; name?: string; description?: string | null } | null;
    clear_project?: boolean;
    group?: { slug?: string; name?: string; description?: string | null } | null;
    clear_group?: boolean;
    tags?: string[];
    pinned?: boolean;
    archived?: boolean;
    recurrence_kind?: RecurrenceKind | null;
    recurrence_interval?: number | null;
    recurrence_until?: string | null;
    clear_recurrence?: boolean;
  }
): Promise<EnrichedTask | null> {
  const task = await getTaskById(db, id);
  if (!task) return null;

  const projectId = changes.clear_project
    ? null
    : changes.project !== undefined
      ? await resolveProjectId(db, changes.project)
      : undefined;
  const groupId = changes.clear_group
    ? null
    : changes.group !== undefined
      ? await resolveGroupId(db, changes.group)
      : undefined;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (changes.title !== undefined) {
    sets.push("title = ?");
    params.push(changes.title.trim());
  }
  if (changes.description !== undefined) {
    sets.push("description = ?");
    params.push(changes.description);
  }
  if (changes.raw_input !== undefined) {
    sets.push("raw_input = ?");
    params.push(changes.raw_input);
  }
  if (changes.item_kind !== undefined) {
    sets.push("item_kind = ?");
    params.push(changes.item_kind);
  }
  if (changes.entity_type !== undefined) {
    sets.push("entity_type = ?");
    params.push(changes.entity_type);
  }
  if (changes.lifecycle_state !== undefined) {
    sets.push("lifecycle_state = ?");
    params.push(changes.lifecycle_state);
    if (changes.lifecycle_state === "superseded") {
      sets.push("superseded_at = COALESCE(superseded_at, ?)");
      params.push(new Date().toISOString());
    }
  }
  if (changes.clear_objective) {
    sets.push("objective_id = NULL");
  } else if (changes.objective_id !== undefined) {
    sets.push("objective_id = ?");
    params.push(changes.objective_id);
  }
  if (changes.priority !== undefined) {
    sets.push("priority = ?");
    params.push(changes.priority);
  }
  if (changes.startup_priority !== undefined) {
    sets.push("startup_priority = ?");
    params.push(
      changes.startup_priority === null
        ? 7
        : Math.min(Math.max(Math.trunc(changes.startup_priority), 1), 10)
    );
  }
  if (changes.clear_due) {
    sets.push("due_at = NULL");
    sets.push("due_text = NULL");
  } else {
    if (changes.due_at !== undefined) {
      sets.push("due_at = ?");
      params.push(changes.due_at);
    }
    if (changes.due_text !== undefined) {
      sets.push("due_text = ?");
      params.push(changes.due_text);
    }
  }
  if (projectId !== undefined) {
    sets.push("project_id = ?");
    params.push(projectId);
  }
  if (groupId !== undefined) {
    sets.push("group_id = ?");
    params.push(groupId);
  }
  if (changes.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(changes.pinned ? 1 : 0);
  }
  if (changes.archived !== undefined) {
    sets.push("archived_at = ?");
    params.push(changes.archived ? task.archived_at ?? new Date().toISOString() : null);
    sets.push("lifecycle_state = ?");
    params.push(changes.archived ? "archived" : "active");
  }
  if (changes.clear_recurrence) {
    sets.push("recurrence_kind = NULL");
    sets.push("recurrence_interval = NULL");
    sets.push("recurrence_until = NULL");
    sets.push("last_completed_due_at = NULL");
  } else {
    if (changes.recurrence_kind !== undefined) {
      sets.push("recurrence_kind = ?");
      params.push(changes.recurrence_kind);
    }
    if (changes.recurrence_interval !== undefined) {
      sets.push("recurrence_interval = ?");
      params.push(changes.recurrence_interval);
    }
    if (changes.recurrence_until !== undefined) {
      sets.push("recurrence_until = ?");
      params.push(changes.recurrence_until);
    }
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    sets.push("last_touched_at = ?");
    params.push(new Date().toISOString());
    params.push(new Date().toISOString());
    params.push(id);
    await db.prepare(`UPDATE todos SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  }

  if (changes.tags !== undefined) {
    await setTaskTags(db, id, changes.tags);
  }

  await logAction(db, id, "update", {
    keys: Object.keys(changes),
  });

  const refreshed = await getTaskById(db, id);
  return refreshed ? enrichTask(db, refreshed) : null;
}

export async function deleteTask(db: D1Database, id: number): Promise<boolean> {
  await db.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(id).run();
  await db.prepare("DELETE FROM task_logs WHERE task_id = ?").bind(id).run();
  await db.prepare("DELETE FROM item_relationships WHERE source_item_id = ? OR target_item_id = ?").bind(id, id).run();
  const result = await db.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

export async function deleteTasks(db: D1Database, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  await db.prepare(`DELETE FROM task_tags WHERE task_id IN (${placeholders})`).bind(...ids).run();
  await db.prepare(`DELETE FROM task_logs WHERE task_id IN (${placeholders})`).bind(...ids).run();
  await db.prepare(`DELETE FROM item_relationships WHERE source_item_id IN (${placeholders})`).bind(...ids).run();
  await db.prepare(`DELETE FROM item_relationships WHERE target_item_id IN (${placeholders})`).bind(...ids).run();
  const result = await db.prepare(`DELETE FROM todos WHERE id IN (${placeholders})`).bind(...ids).run();
  return result.meta.changes;
}

export async function listItems(db: D1Database, query: ItemListQuery): Promise<Task[]> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.ids && query.ids.length > 0) {
    where.push(`t.id IN (${query.ids.map(() => "?").join(", ")})`);
    params.push(...query.ids);
  }
  if (query.q) {
    where.push("t.id IN (SELECT rowid FROM todos_fts WHERE todos_fts MATCH ?)");
    params.push(query.q);
  }
  if (query.kinds && query.kinds.length > 0) {
    where.push(`t.item_kind IN (${query.kinds.map(() => "?").join(", ")})`);
    params.push(...query.kinds);
  }
  if (query.entity_types && query.entity_types.length > 0) {
    where.push(`t.entity_type IN (${query.entity_types.map(() => "?").join(", ")})`);
    params.push(...query.entity_types);
  }
  if (query.lifecycle_states && query.lifecycle_states.length > 0) {
    where.push(`t.lifecycle_state IN (${query.lifecycle_states.map(() => "?").join(", ")})`);
    params.push(...query.lifecycle_states);
  }
  if (typeof query.completed === "boolean") {
    where.push("t.completed = ?");
    params.push(query.completed ? 1 : 0);
  }
  if (typeof query.archived === "boolean") {
    where.push(query.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL");
  }
  if (typeof query.pinned === "boolean") {
    where.push("t.pinned = ?");
    params.push(query.pinned ? 1 : 0);
  }
  if (query.priority && query.priority.length > 0) {
    where.push(`t.priority IN (${query.priority.map(() => "?").join(", ")})`);
    params.push(...query.priority);
  }
  if (typeof query.startup_priority_min === "number") {
    where.push("t.startup_priority >= ?");
    params.push(Math.trunc(query.startup_priority_min));
  }
  if (typeof query.startup_priority_max === "number") {
    where.push("t.startup_priority <= ?");
    params.push(Math.trunc(query.startup_priority_max));
  }
  if (query.due_before) {
    where.push("t.due_at <= ?");
    params.push(query.due_before);
  }
  if (query.due_after) {
    where.push("t.due_at >= ?");
    params.push(query.due_after);
  }
  if (query.project_slugs && query.project_slugs.length > 0) {
    where.push(
      `t.project_id IN (SELECT id FROM projects WHERE slug IN (${query.project_slugs.map(() => "?").join(", ")}))`
    );
    params.push(...query.project_slugs.map((slug) => slug.toLowerCase()));
  }
  if (query.group_slugs && query.group_slugs.length > 0) {
    where.push(
      `t.group_id IN (SELECT id FROM groups WHERE slug IN (${query.group_slugs.map(() => "?").join(", ")}))`
    );
    params.push(...query.group_slugs.map((slug) => slug.toLowerCase()));
  }
  if (query.tags && query.tags.length > 0) {
    where.push(
      `t.id IN (
        SELECT tt.task_id
        FROM task_tags tt
        JOIN tags tag ON tag.id = tt.tag_id
        WHERE tag.slug IN (${query.tags.map(() => "?").join(", ")})
      )`
    );
    params.push(...query.tags.map((tag) => tag.toLowerCase()));
  }
  if (query.stale_only) {
    where.push("(t.lifecycle_state = 'stale' OR COALESCE(t.last_touched_at, t.updated_at) < ?)");
    params.push(isoOffsetDays(-STALE_AFTER_DAYS));
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sort = query.sort ?? "-updated_at";
  const desc = sort.startsWith("-");
  const column = sort.replace("-", "");
  const orderable = new Set(["updated_at", "created_at", "due_at", "priority", "title"]);
  const orderBy = orderable.has(column) ? column : "updated_at";
  const orderClause =
    orderBy === "title"
      ? `ORDER BY t.title ${desc ? "DESC" : "ASC"}`
      : orderBy === "priority"
        ? `ORDER BY t.priority ${desc ? "DESC" : "ASC"}, t.updated_at DESC`
        : orderBy === "due_at"
          ? `ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at ${desc ? "DESC" : "ASC"}`
          : `ORDER BY t.${orderBy} ${desc ? "DESC" : "ASC"}`;

  return rows<Task>(
    await db
      .prepare(`SELECT t.* FROM todos t ${whereClause} ${orderClause} LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

export async function getFocusTask(db: D1Database): Promise<Task | null> {
  const now = new Date().toISOString();
  const upcomingCutoff = isoOffsetDays(UPCOMING_WINDOW_DAYS);
  const staleCutoff = isoOffsetDays(-STALE_AFTER_DAYS);
  const activeCutoff = isoOffset(-ACTIVE_WINDOW_HOURS);
  const ignoreCooldown = isoOffset(-IGNORE_COOLDOWN_HOURS);

  return row<Task>(
    await db
      .prepare(
        `SELECT *
         FROM todos
         WHERE item_kind = 'task'
           AND entity_type = 'tactical_task'
           AND lifecycle_state = 'active'
           AND archived_at IS NULL
           AND completed = 0
           AND (snoozed_until IS NULL OR snoozed_until <= ?)
           AND (ignored_at IS NULL OR ignored_at <= ?)
         ORDER BY
           CASE
             WHEN due_at IS NOT NULL AND due_at < ? THEN 3
             WHEN due_at IS NOT NULL AND date(due_at) = date(?) THEN 2
             WHEN due_at IS NOT NULL AND due_at <= ? THEN 1
             ELSE 0
           END DESC,
           CASE WHEN COALESCE(last_touched_at, updated_at) <= ? THEN 1 ELSE 0 END ASC,
           CASE WHEN last_active_at IS NOT NULL AND last_active_at >= ? THEN 1 ELSE 0 END DESC,
           pinned DESC,
           priority DESC,
           CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC,
           due_at ASC,
           updated_at ASC,
           id ASC
         LIMIT 1`
      )
      .bind(now, ignoreCooldown, now, now, upcomingCutoff, staleCutoff, activeCutoff)
      .first()
  );
}

export async function getStaleTasks(db: D1Database, limit = 25): Promise<Task[]> {
  return listItems(db, {
    kinds: ["task"],
    entity_types: ["tactical_task"],
    completed: false,
    archived: false,
    lifecycle_states: ["active", "stale"],
    stale_only: true,
    sort: "updated_at",
    limit,
  });
}

export async function getProjectBySlug(db: D1Database, slug: string): Promise<Project | null> {
  return row<Project>(
    await db
      .prepare("SELECT id, name, slug, description, active_objective_id, focus_version, focus_updated_at FROM projects WHERE slug = ?")
      .bind(slug.toLowerCase())
      .first()
  );
}

async function touchProjectFocus(db: D1Database, projectId: number): Promise<void> {
  await db
    .prepare("UPDATE projects SET focus_version = focus_version + 1, focus_updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), projectId)
    .run();
}

export async function setActiveObjective(
  db: D1Database,
  input: { project_slug: string; item_id?: number; title?: string; description?: string | null }
): Promise<{ project: Project; objective: ObjectiveRecord; item: EnrichedTask }> {
  const project = await getProjectBySlug(db, input.project_slug);
  if (!project) throw new Error(`Project '${input.project_slug}' not found`);

  let item = input.item_id ? await getTaskById(db, input.item_id) : null;
  if (!item) {
    if (!input.title) throw new Error("Provide item_id or title");
    const created = await createTask(db, {
      title: input.title,
      description: input.description,
      item_kind: "task",
      entity_type: "strategic_goal",
      lifecycle_state: "active",
      priority: 3,
      pinned: true,
      project: { slug: project.slug, name: project.name },
    });
    item = created;
  }

  if (item.project_id !== project.id) {
    throw new Error(`Item '${item.id}' is not in project '${project.slug}'`);
  }

  const now = new Date().toISOString();
  await db
    .prepare("UPDATE objectives SET status = 'superseded', ended_at = ?, updated_at = ? WHERE project_id = ? AND status = 'active'")
    .bind(now, now, project.id)
    .run();
  await db
    .prepare("UPDATE todos SET entity_type = 'strategic_goal', lifecycle_state = 'active', pinned = 1, updated_at = ?, last_touched_at = ? WHERE id = ?")
    .bind(now, now, item.id)
    .run();

  const inserted = await db
    .prepare("INSERT INTO objectives (project_id, item_id, status, started_at, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
    .bind(project.id, item.id, now, now, now)
    .run();
  const objectiveId = Number(inserted.meta.last_row_id);
  await db.prepare("UPDATE projects SET active_objective_id = ? WHERE id = ?").bind(item.id, project.id).run();
  await touchProjectFocus(db, project.id);
  await logEvent(db, item.id, project.id, "active_objective_set", { project_slug: project.slug });

  const objective = await db.prepare("SELECT * FROM objectives WHERE id = ?").bind(objectiveId).first();
  const refreshedProject = await getProjectBySlug(db, project.slug);
  const refreshedItem = await getTaskById(db, item.id);
  if (!objective || !refreshedProject || !refreshedItem) throw new Error("Active objective was saved but could not be reloaded");
  return { project: refreshedProject, objective: objective as unknown as ObjectiveRecord, item: await enrichTask(db, refreshedItem) };
}

export async function supersedeItems(
  db: D1Database,
  sourceItemId: number,
  targetItemIds: number[],
  reason?: string | null
): Promise<{ source: EnrichedTask; superseded: EnrichedTask[] }> {
  const source = await getTaskById(db, sourceItemId);
  if (!source) throw new Error(`Source item '${sourceItemId}' not found`);
  const now = new Date().toISOString();
  const superseded: Task[] = [];

  for (const targetId of Array.from(new Set(targetItemIds))) {
    if (targetId === sourceItemId) continue;
    const target = await getTaskById(db, targetId);
    if (!target) continue;
    await db
      .prepare(
        `INSERT OR IGNORE INTO item_relationships
         (source_item_id, target_item_id, relationship_type, confidence, metadata)
         VALUES (?, ?, 'supersedes', 1.0, ?)`
      )
      .bind(sourceItemId, targetId, JSON.stringify({ reason: reason ?? null }))
      .run();
    await db
      .prepare(
        `UPDATE todos
         SET lifecycle_state = 'superseded',
             superseded_at = COALESCE(superseded_at, ?),
             updated_at = ?,
             last_touched_at = ?
         WHERE id = ?`
      )
      .bind(now, now, now, targetId)
      .run();
    await logEvent(db, targetId, target.project_id, "superseded", { by: sourceItemId, reason: reason ?? null });
    superseded.push({ ...target, lifecycle_state: "superseded", superseded_at: target.superseded_at ?? now });
  }

  if (source.project_id) await touchProjectFocus(db, source.project_id);
  const refreshedSource = await getTaskById(db, sourceItemId);
  if (!refreshedSource) throw new Error(`Source item '${sourceItemId}' disappeared`);
  return { source: await enrichTask(db, refreshedSource), superseded: await enrichTasks(db, superseded) };
}

export async function getFocusContext(db: D1Database, projectSlug?: string): Promise<FocusContext> {
  const now = new Date().toISOString();
  const project = projectSlug
    ? await getProjectBySlug(db, projectSlug)
    : row<Project>(
        await db
          .prepare(
            `SELECT id, name, slug, description, active_objective_id, focus_version, focus_updated_at
             FROM projects
             WHERE active_objective_id IS NOT NULL
             ORDER BY focus_updated_at DESC, id ASC
             LIMIT 1`
          )
          .first()
      );

  const strategic = project?.active_objective_id
    ? await getTaskById(db, project.active_objective_id)
    : row<Task>(
        await db
          .prepare(
            `SELECT * FROM todos
             WHERE entity_type = 'strategic_goal'
               AND lifecycle_state = 'active'
               AND archived_at IS NULL
             ORDER BY pinned DESC, updated_at DESC
             LIMIT 1`
          )
          .first()
      );

  const objective = strategic
    ? row<ObjectiveRecord>(
        await db
          .prepare("SELECT * FROM objectives WHERE item_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1")
          .bind(strategic.id)
          .first()
      )
    : null;

  const projectId = project?.id ?? strategic?.project_id ?? null;
  const tactical = strategic
    ? row<Task>(
        await db
          .prepare(
            `SELECT *
             FROM todos
             WHERE entity_type = 'tactical_task'
               AND lifecycle_state = 'active'
               AND completed = 0
               AND archived_at IS NULL
               AND (objective_id = ? OR (? IS NOT NULL AND project_id = ?))
               AND (snoozed_until IS NULL OR snoozed_until <= ?)
             ORDER BY
               CASE WHEN objective_id = ? THEN 1 ELSE 0 END DESC,
               pinned DESC,
               CASE WHEN due_at IS NOT NULL AND due_at <= ? THEN 1 ELSE 0 END DESC,
               priority DESC,
               COALESCE(last_touched_at, updated_at) DESC,
               id ASC
             LIMIT 1`
          )
          .bind(strategic.id, projectId, projectId, now, strategic.id, now)
          .first()
      )
    : null;

  const blockers = tactical
    ? await getTasksByIds(
        db,
        rows<{ source_item_id: number }>(
          await db
            .prepare("SELECT source_item_id FROM item_relationships WHERE target_item_id = ? AND relationship_type = 'blocks'")
            .bind(tactical.id)
            .all()
            .then((result) => result.results as Record<string, unknown>[])
        ).map((record) => Number(record.source_item_id))
      )
    : [];

  const recurring = projectId
    ? await listItems(db, {
        entity_types: ["recurring_system"],
        lifecycle_states: ["active"],
        completed: false,
        archived: false,
        project_slugs: project ? [project.slug] : undefined,
        limit: 10,
        sort: "due_at",
      })
    : [];

  const replaced = strategic
    ? await getTasksByIds(
        db,
        rows<{ target_item_id: number }>(
          await db
            .prepare("SELECT target_item_id FROM item_relationships WHERE source_item_id = ? AND relationship_type = 'supersedes'")
            .bind(strategic.id)
            .all()
            .then((result) => result.results as Record<string, unknown>[])
        ).map((record) => Number(record.target_item_id))
      )
    : [];

  const explanation = {
    active_objective_id: strategic?.id ?? null,
    tactical_next_step_id: tactical?.id ?? null,
    recurring_systems_are_support_layer: true,
  };
  if (projectId) {
    await db
      .prepare(
        `INSERT INTO focus_snapshots
         (project_id, objective_id, strategic_focus_id, tactical_next_step_id, focus_version, explanation_json, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(projectId, objective?.id ?? null, strategic?.id ?? null, tactical?.id ?? null, project?.focus_version ?? 0, JSON.stringify(explanation), now)
      .run();
  }

  return {
    project,
    objective,
    strategic_focus: strategic ? await enrichTask(db, strategic) : null,
    tactical_next_step: tactical ? await enrichTask(db, tactical) : null,
    blockers: await enrichTasks(db, blockers),
    recurring_systems: await enrichTasks(db, recurring),
    replaced_items: await enrichTasks(db, replaced),
    focus_version: project?.focus_version ?? 0,
    generated_at: now,
  };
}

export async function markStaleCandidates(db: D1Database, limit = 25): Promise<EnrichedTask[]> {
  const candidates = await listItems(db, {
    entity_types: ["tactical_task"],
    lifecycle_states: ["active"],
    completed: false,
    archived: false,
    stale_only: true,
    limit,
    sort: "updated_at",
  });
  const now = new Date().toISOString();
  for (const task of candidates) {
    if (task.pinned || task.objective_id) continue;
    await db
      .prepare("UPDATE todos SET lifecycle_state = 'stale', updated_at = ?, last_touched_at = ? WHERE id = ?")
      .bind(now, now, task.id)
      .run();
    await logEvent(db, task.id, task.project_id, "stale_marked", { reason: "untouched beyond stale window" });
  }
  return enrichTasks(db, candidates.filter((task) => !task.pinned && !task.objective_id));
}

export async function getProjectTimeline(db: D1Database, projectSlug: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  const project = await getProjectBySlug(db, projectSlug);
  if (!project) throw new Error(`Project '${projectSlug}' not found`);
  return rows<Record<string, unknown>>(
    await db
      .prepare(
        `SELECT 'event' AS row_type, event_type AS label, item_id, metadata_json AS metadata, created_at
         FROM item_events
         WHERE project_id = ?
         UNION ALL
         SELECT 'focus_snapshot' AS row_type, 'focus_generated' AS label, tactical_next_step_id AS item_id, explanation_json AS metadata, generated_at AS created_at
         FROM focus_snapshots
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(project.id, project.id, limit)
      .all()
      .then((result) => result.results as Record<string, unknown>[])
  );
}

export async function updateTaskState(
  db: D1Database,
  id: number,
  action: "complete" | "snooze" | "ignore",
  snoozeHours: number
): Promise<{ task: EnrichedTask; changed: boolean; deleted_vector: boolean }> {
  const task = await getTaskById(db, id);
  if (!task) {
    throw new Error(`Task '${id}' not found`);
  }

  const now = new Date().toISOString();
  let changed = false;
  let deletedVector = false;

  if (action === "complete") {
    if (task.item_kind !== "task") {
      throw new Error("Only task items can be completed");
    }

    if (task.recurrence_kind) {
      if (task.last_completed_due_at !== task.due_at || (task.due_at === null && task.last_completed_at === null)) {
        const nextDue = advanceRecurringDueDate(
          task.due_at,
          task.recurrence_kind,
          task.recurrence_interval,
          task.recurrence_until
        );

        await db
          .prepare(
            `UPDATE todos
             SET completed = ?,
                 completed_at = ?,
                 last_completed_at = ?,
                 last_completed_due_at = ?,
                 due_at = ?,
                 lifecycle_state = ?,
                 snoozed_until = NULL,
                 ignored_at = NULL,
                 last_active_at = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .bind(nextDue ? 0 : 1, now, now, task.due_at, nextDue, nextDue ? "active" : "completed", now, now, id)
          .run();
        await logAction(db, id, "complete", { recurring: true, next_due_at: nextDue });
        changed = true;
        deletedVector = !nextDue;
      }
    } else if (!task.completed) {
      await db
        .prepare(
          `UPDATE todos
           SET completed = 1,
               completed_at = COALESCE(completed_at, ?),
               last_completed_at = ?,
               lifecycle_state = 'completed',
               snoozed_until = NULL,
               ignored_at = NULL,
               last_active_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(now, now, now, now, id)
        .run();
      await logAction(db, id, "complete", { recurring: false });
      changed = true;
      deletedVector = true;
    }
  }

  if (action === "snooze") {
    if (!task.snoozed_until || task.snoozed_until <= now) {
      const snoozedUntil = isoOffset(snoozeHours);
      await db
        .prepare(
          `UPDATE todos
           SET snoozed_until = ?,
               ignored_at = NULL,
               last_active_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(snoozedUntil, now, now, id)
        .run();
      await logAction(db, id, "snooze", { until: snoozedUntil });
      changed = true;
    }
  }

  if (action === "ignore") {
    const ignoreCooldown = isoOffset(-IGNORE_COOLDOWN_HOURS);
    if (!task.ignored_at || task.ignored_at <= ignoreCooldown) {
      await db
        .prepare(
          `UPDATE todos
           SET ignored_at = ?,
               snoozed_until = NULL,
               last_active_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(now, now, now, id)
        .run();
      await logAction(db, id, "ignore", { at: now });
      changed = true;
    }
  }

  const refreshed = await getTaskById(db, id);
  if (!refreshed) throw new Error(`Task '${id}' disappeared after update`);
  return { task: await enrichTask(db, refreshed), changed, deleted_vector: deletedVector };
}

export async function logAction(
  db: D1Database,
  taskId: number,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db
    .prepare("INSERT INTO task_logs (task_id, action, metadata) VALUES (?, ?, ?)")
    .bind(taskId, action, JSON.stringify(metadata))
    .run();
}

export async function logEvent(
  db: D1Database,
  itemId: number | null,
  projectId: number | null,
  eventType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db
    .prepare("INSERT INTO item_events (item_id, project_id, event_type, metadata_json) VALUES (?, ?, ?, ?)")
    .bind(itemId, projectId, eventType, JSON.stringify(metadata))
    .run();
}

// Context retrieval helpers are implemented in ./context.ts
export {
  ContextLoadQuery,
  ContextSummary,
  buildContextSummary,
  computeContextVersion,
  computeLastConsolidated,
  dedupeTasksById,
  loadContextItems,
  loadPinnedItems,
  loadProfileItems,
  loadActiveObjectives,
  loadActiveProjects,
} from "./context.js";
