import {
  EnrichedTask,
  EntityType,
  ItemKind,
  Project,
  Task,
  enrichTasks,
} from "./db.js";

function rows<T>(value: Record<string, unknown>[]): T[] {
  return value as T[];
}

function normalizeSlugs(values?: string[]): string[] {
  return Array.from(
    new Set(values?.map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [])
  );
}

/**
 * Input shape for the flexible load_context query. All fields are optional;
 * current_only defaults to true so helpers return actionable items by default.
 */
export interface ContextLoadQuery {
  /** Tag slugs to match (AND with other filters). */
  tags?: string[];
  /** Project slugs to match. */
  project_slugs?: string[];
  /** Group slugs to match. */
  group_slugs?: string[];
  /** Match items whose group slug is "profile" OR that carry the "profile" tag. */
  profile?: boolean;
  /** Filter by pinned status; omit for no pinned filter. */
  pinned?: boolean;
  /** When true (default), exclude superseded/archived/completed and archived/completed items. */
  current_only?: boolean;
  /** When true, include historical items regardless of current_only. */
  include_history?: boolean;
  /** Filter by item_kind values. */
  kinds?: ItemKind[];
  /** Filter by entity_type values. */
  entity_types?: EntityType[];
  /** Minimum startup_priority value (inclusive). */
  startup_priority_min?: number;
  /** Maximum startup_priority value (inclusive). */
  startup_priority_max?: number;
  /** Maximum number of results (default 50, max 100). */
  limit?: number;
}

/**
 * Deterministic D1 SQL context loader. Combines all supplied filters with AND,
 * with the exception of `profile`, which matches group="profile" OR tag="profile"
 * within the result set.
 *
 * Sorting is stable: startup_priority DESC, pinned DESC, priority DESC, updated_at DESC, id ASC.
 */
export async function loadContextItems(
  db: D1Database,
  query: ContextLoadQuery
): Promise<EnrichedTask[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const currentOnly = query.current_only ?? true;
  const includeHistory = query.include_history ?? false;

  const tags = normalizeSlugs(query.tags);
  const projectSlugs = normalizeSlugs(query.project_slugs);
  const groupSlugs = normalizeSlugs(query.group_slugs);

  const where: string[] = [];
  const params: unknown[] = [];

  if (!includeHistory && currentOnly) {
    where.push("t.lifecycle_state NOT IN ('superseded', 'archived', 'completed')");
    where.push("t.archived_at IS NULL");
    where.push("t.completed = 0");
  }

  if (query.kinds && query.kinds.length > 0) {
    where.push(`t.item_kind IN (${query.kinds.map(() => "?").join(", ")})`);
    params.push(...query.kinds);
  }

  if (query.entity_types && query.entity_types.length > 0) {
    where.push(`t.entity_type IN (${query.entity_types.map(() => "?").join(", ")})`);
    params.push(...query.entity_types);
  }

  if (typeof query.pinned === "boolean") {
    where.push("t.pinned = ?");
    params.push(query.pinned ? 1 : 0);
  }

  if (typeof query.startup_priority_min === "number") {
    where.push("t.startup_priority >= ?");
    params.push(Math.trunc(query.startup_priority_min));
  }

  if (typeof query.startup_priority_max === "number") {
    where.push("t.startup_priority <= ?");
    params.push(Math.trunc(query.startup_priority_max));
  }

  if (projectSlugs.length > 0) {
    where.push(
      `t.project_id IN (SELECT id FROM projects WHERE slug IN (${projectSlugs.map(() => "?").join(", ")}))`
    );
    params.push(...projectSlugs);
  }

  if (groupSlugs.length > 0) {
    where.push(
      `t.group_id IN (SELECT id FROM groups WHERE slug IN (${groupSlugs.map(() => "?").join(", ")}))`
    );
    params.push(...groupSlugs);
  }

  if (tags.length > 0) {
    where.push(
      `EXISTS (\n        SELECT 1 FROM task_tags tt\n        JOIN tags tag ON tag.id = tt.tag_id\n        WHERE tt.task_id = t.id AND tag.slug IN (${tags.map(() => "?").join(", ")})\n      )`
    );
    params.push(...tags);
  }

  if (query.profile) {
    where.push(
      `(g.slug = ? OR EXISTS (\n        SELECT 1 FROM task_tags tt\n        JOIN tags tag ON tag.id = tt.tag_id\n        WHERE tt.task_id = t.id AND tag.slug = ?\n      ))`
    );
    params.push("profile", "profile");
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT t.*
    FROM todos t
    LEFT JOIN groups g ON g.id = t.group_id
    ${whereClause}
    ORDER BY t.startup_priority DESC, t.pinned DESC, t.priority DESC, t.updated_at DESC, t.id ASC
    LIMIT ?
  `.trim();
  params.push(limit);

  const result = await db.prepare(sql).bind(...params).all();
  const tasks = rows<Task>(result.results as Record<string, unknown>[]);
  return enrichTasks(db, tasks);
}

/** Load pinned items with optional additional context filters. */
export function loadPinnedItems(
  db: D1Database,
  filters?: Omit<ContextLoadQuery, "pinned">
): Promise<EnrichedTask[]> {
  return loadContextItems(db, { ...filters, pinned: true });
}

/** Load profile items (group slug "profile" or tag slug "profile"). */
export function loadProfileItems(
  db: D1Database,
  filters?: Omit<ContextLoadQuery, "profile">
): Promise<EnrichedTask[]> {
  return loadContextItems(db, { ...filters, profile: true });
}

/** Load active strategic objectives/goals, optionally scoped to specific projects and/or limited. */
export function loadActiveObjectives(
  db: D1Database,
  options?:
    | string[]
    | { projectSlugs?: string[]; limit?: number; startupPriorityMin?: number; startupPriorityMax?: number }
): Promise<EnrichedTask[]> {
  const projectSlugs = Array.isArray(options) ? options : options?.projectSlugs;
  const limit = Array.isArray(options) ? 50 : options?.limit ?? 50;
  return loadContextItems(db, {
    entity_types: ["strategic_goal"],
    project_slugs: projectSlugs,
    startup_priority_min: Array.isArray(options) ? undefined : options?.startupPriorityMin,
    startup_priority_max: Array.isArray(options) ? undefined : options?.startupPriorityMax,
    current_only: true,
    limit,
  });
}

/**
 * Load projects that currently have at least one active, non-archived, non-completed item.
 * Results are ordered by most recently updated focus, then project name.
 */
export async function loadActiveProjects(db: D1Database, limit = 50): Promise<Project[]> {
  const result = await db
    .prepare(
      `
      SELECT p.id, p.name, p.slug, p.description, p.active_objective_id, p.focus_version, p.focus_updated_at
      FROM projects p
      WHERE EXISTS (
        SELECT 1 FROM todos t
        WHERE t.project_id = p.id
          AND t.lifecycle_state NOT IN ('superseded', 'archived', 'completed')
          AND t.archived_at IS NULL
          AND t.completed = 0
      )
      ORDER BY p.focus_updated_at DESC, p.name ASC
      LIMIT ?
      `
    )
    .bind(limit)
    .all();
  return rows<Project>(result.results as Record<string, unknown>[]);
}

/** Return a copy of tasks with duplicates removed, preserving first-seen order. */
export function dedupeTasksById(tasks: EnrichedTask[]): EnrichedTask[] {
  const seen = new Set<number>();
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

/**
 * Compute a deterministic version number from a set of context items.
 * Changing any item's id or updated_at changes the version.
 */
export function computeContextVersion(items: EnrichedTask[]): number {
  let hash = 5381;
  const sorted = [...items].sort((a, b) => a.id - b.id);
  for (const item of sorted) {
    const str = `${item.id}:${item.updated_at}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
  }
  return hash >>> 0;
}

/** Latest updated_at among items, or null if empty. */
export function computeLastConsolidated(items: EnrichedTask[]): string | null {
  if (items.length === 0) return null;
  return items.reduce((latest, item) => (item.updated_at > latest ? item.updated_at : latest), items[0].updated_at);
}

/**
 * Deterministic rollup of a set of context items for a given scope.
 */
export interface ContextSummary {
  scope: string;
  total: number;
  by_kind: Record<string, number>;
  by_entity_type: Record<string, number>;
  by_lifecycle_state: Record<string, number>;
  pinned_count: number;
  active_count: number;
  top_items: Array<{ id: number; title: string }>;
  version: number;
  last_consolidated: string | null;
  generated_at: string;
}

export function buildContextSummary(scope: string, items: EnrichedTask[]): ContextSummary {
  const by_kind: Record<string, number> = {};
  const by_entity_type: Record<string, number> = {};
  const by_lifecycle_state: Record<string, number> = {};
  let pinned_count = 0;
  let active_count = 0;

  for (const item of items) {
    by_kind[item.item_kind] = (by_kind[item.item_kind] ?? 0) + 1;
    by_entity_type[item.entity_type] = (by_entity_type[item.entity_type] ?? 0) + 1;
    by_lifecycle_state[item.lifecycle_state] = (by_lifecycle_state[item.lifecycle_state] ?? 0) + 1;
    if (item.pinned === 1) pinned_count++;
    if (item.lifecycle_state === "active") active_count++;
  }

  return {
    scope,
    total: items.length,
    by_kind,
    by_entity_type,
    by_lifecycle_state,
    pinned_count,
    active_count,
    top_items: items.slice(0, 5).map((item) => ({ id: item.id, title: item.title })),
    version: computeContextVersion(items),
    last_consolidated: computeLastConsolidated(items),
    generated_at: new Date().toISOString(),
  };
}
