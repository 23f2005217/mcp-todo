import {
  EnrichedTask,
  EntityType,
  Group,
  GroupKind,
  ItemKind,
  LifecycleState,
  Project,
  Task,
  enrichTasks,
  getFocusContext,
  getGroupBySlug,
  getProjectBySlug,
  getTaskById,
  getTasksByIds,
  listContextGroups,
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
 * Context hierarchy levels. An AI agent should move down the hierarchy only
 * when more detail is required.
 */
export type ContextLevel = "startup" | "topic_summary" | "project" | "raw_memories";

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
  /** Group kinds to match. */
  group_kinds?: GroupKind[];
  /** Match items whose group slug is "profile" OR that carry the "profile" tag. */
  profile?: boolean;
  /** Filter by pinned status; omit for no pinned filter. */
  pinned?: boolean;
  /** When true (default), exclude superseded/archived/completed items. */
  current_only?: boolean;
  /** When true, include historical items regardless of current_only. */
  include_history?: boolean;
  /** Filter by item_kind values. */
  kinds?: ItemKind[];
  /** Filter by entity_type values. */
  entity_types?: EntityType[];
  /** Filter by lifecycle_state values. */
  lifecycle_states?: LifecycleState[];
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
  const groupKinds = query.group_kinds ?? [];

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

  if (query.lifecycle_states && query.lifecycle_states.length > 0) {
    where.push(`t.lifecycle_state IN (${query.lifecycle_states.map(() => "?").join(", ")})`);
    params.push(...query.lifecycle_states);
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

  if (groupKinds.length > 0) {
    where.push(
      `t.group_id IN (SELECT id FROM groups WHERE group_kind IN (${groupKinds.map(() => "?").join(", ")}))`
    );
    params.push(...groupKinds);
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
export function computeContextVersion(items: { id: number; updated_at: string }[]): number {
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
export function computeLastConsolidated(items: { updated_at: string }[]): string | null {
  if (items.length === 0) return null;
  return items.reduce((latest, item) => (item.updated_at > latest ? item.updated_at : latest), items[0].updated_at);
}

/**
 * Deterministic rollup of a set of context items for a given scope.
 */
export interface ContextSummary {
  scope: string;
  total: number;
  active_count: number;
  pinned_count: number;
  top_item: { id: number; title: string } | null;
  version: number;
  last_consolidated: string | null;
  generated_at: string;
}

export function buildContextSummary(scope: string, items: EnrichedTask[]): ContextSummary {
  let pinned_count = 0;
  let active_count = 0;

  for (const item of items) {
    if (item.pinned === 1) pinned_count++;
    if (item.lifecycle_state === "active") active_count++;
  }

  const top = items[0];

  return {
    scope,
    total: items.length,
    active_count,
    pinned_count,
    top_item: top ? { id: top.id, title: top.title } : null,
    version: computeContextVersion(items),
    last_consolidated: computeLastConsolidated(items),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Topic summary bundle. The canonical_item is the single active representation
 * of a topic. If none is explicitly assigned, the highest-priority active item
 * in the topic is returned as the de-facto canonical.
 */
export interface TopicSummaryBundle {
  level: "topic_summary";
  scope: string;
  group: Group | null;
  canonical_item: EnrichedTask | null;
  summary: ContextSummary;
  source: "d1";
  generated_at: string;
}

/**
 * Load the canonical current state for a topic (group or tag slug).
 * Returns the group's canonical item if set, otherwise the highest-priority
 * active item in that group/tag.
 */
export async function loadTopicSummary(
  db: D1Database,
  scope: string
): Promise<TopicSummaryBundle> {
  const normalizedScope = scope.toLowerCase().trim();
  const group = await getGroupBySlug(db, normalizedScope);

  let canonicalItem: EnrichedTask | null = null;
  if (group?.canonical_item_id) {
    const task = await getTaskById(db, group.canonical_item_id);
    if (task) {
      canonicalItem = await enrichTasks(db, [task]).then((items) => items[0] ?? null);
    }
  }

  if (!canonicalItem) {
    const candidates = await loadContextItems(db, {
      group_slugs: group ? [group.slug] : undefined,
      tags: !group ? [normalizedScope] : undefined,
      current_only: true,
      include_history: false,
      limit: 1,
    });
    canonicalItem = candidates[0] ?? null;
  }

  const summaryItems = await loadContextItems(db, {
    group_slugs: group ? [group.slug] : undefined,
    tags: !group ? [normalizedScope] : undefined,
    current_only: true,
    include_history: false,
    limit: 50,
  });

  return {
    level: "topic_summary",
    scope: normalizedScope,
    group,
    canonical_item: canonicalItem,
    summary: buildContextSummary(normalizedScope, summaryItems),
    source: "d1",
    generated_at: new Date().toISOString(),
  };
}

/**
 * Lightweight focus snapshot. Excludes heavy blockers/recurring detail by default.
 */
export interface FocusSnapshot {
  project: Project | null;
  objective_id: number | null;
  strategic_focus: EnrichedTask | null;
  tactical_next_step: EnrichedTask | null;
  focus_version: number;
  generated_at: string;
}

async function loadFocusSnapshot(db: D1Database, projectSlug?: string): Promise<FocusSnapshot> {
  const context = await getFocusContext(db, projectSlug);
  return {
    project: context.project,
    objective_id: context.objective?.id ?? null,
    strategic_focus: context.strategic_focus,
    tactical_next_step: context.tactical_next_step,
    focus_version: context.focus_version,
    generated_at: context.generated_at,
  };
}

/**
 * Startup context bundle. Extremely lightweight: only what an AI needs to
 * understand who the user is and what they are doing right now.
 */
export interface StartupContextBundle {
  level: "startup";
  source: "d1";
  context_version: number;
  generated_at: string;
  last_consolidated: string | null;
  profile: EnrichedTask | null;
  active_goals: EnrichedTask[];
  current_focus: FocusSnapshot;
  active_projects: Project[];
  always_load: EnrichedTask[];
  topic_summaries: TopicSummaryBundle[];
}

const STARTUP_ALWAYS_LOAD_PRIORITY = 10;
const STARTUP_RELEVANT_PRIORITY = 8;
const STARTUP_TOPIC_MIN_PRIORITY = 5;
const STARTUP_MAX_TOPIC_SUMMARIES = 10;

/**
 * Load an extremely lightweight startup context.
 *
 * Includes:
 *   - Current profile (group=profile, highest startup_priority active item)
 *   - Active goals (strategic_goal, active, high startup_priority)
 *   - Current focus (project + objective + next tactical step)
 *   - Active projects
 *   - Always-load items (startup_priority = 10)
 *   - Topic summaries for groups with retrieval_priority > 0 or canonical item
 *
 * Does NOT include every pinned memory.
 */
export async function loadStartupContext(db: D1Database): Promise<StartupContextBundle> {
  const [profileItems, activeGoals, focus, activeProjects, alwaysLoadItems, topicGroups] = await Promise.all([
    loadProfileItems(db, { startup_priority_min: STARTUP_RELEVANT_PRIORITY, current_only: true, limit: 5 }),
    loadActiveObjectives(db, { startupPriorityMin: STARTUP_RELEVANT_PRIORITY, limit: 10 }),
    loadFocusSnapshot(db),
    loadActiveProjects(db, 10),
    loadContextItems(db, { startup_priority_min: STARTUP_ALWAYS_LOAD_PRIORITY, startup_priority_max: STARTUP_ALWAYS_LOAD_PRIORITY, current_only: true, limit: 10 }),
    listContextGroups(db, { minRetrievalPriority: 1, limit: STARTUP_MAX_TOPIC_SUMMARIES }),
  ]);

  const profile = dedupeTasksById(profileItems)[0] ?? null;
  const active_goals = dedupeTasksById(activeGoals);
  const always_load = dedupeTasksById(alwaysLoadItems);

  // Summarize topics with explicit retrieval priority. This gives the AI a
  // lightweight map of what matters without loading raw memories.
  const topic_summaries = await Promise.all(
    topicGroups
      .filter((group) => group.slug !== "profile")
      .map((group) => loadTopicSummary(db, group.slug))
  );

  const versionInputs = [
    profile,
    ...active_goals,
    ...always_load,
    focus.project as { id: number; updated_at: string } | null,
    ...activeProjects,
    ...topic_summaries.map((t) => t.canonical_item).filter(Boolean) as EnrichedTask[],
  ].filter(Boolean) as { id: number; updated_at: string }[];

  const generated_at = new Date().toISOString();

  return {
    level: "startup",
    source: "d1",
    context_version: computeContextVersion(versionInputs),
    generated_at,
    last_consolidated: computeLastConsolidated(versionInputs),
    profile,
    active_goals,
    current_focus: focus,
    active_projects: activeProjects,
    always_load,
    topic_summaries,
  };
}

/**
 * Project context bundle. Loads the project, its active objective, active work,
 * and optionally historical background.
 */
export interface ProjectContextBundle {
  level: "project";
  source: "d1";
  project: Project;
  active_objective: EnrichedTask | null;
  active_items: EnrichedTask[];
  recurring_systems: EnrichedTask[];
  history: EnrichedTask[];
  generated_at: string;
}

export async function loadProjectContext(
  db: D1Database,
  projectSlug: string,
  options: { include_history?: boolean; limit?: number } = {}
): Promise<ProjectContextBundle> {
  const project = await getProjectBySlug(db, projectSlug);
  if (!project) throw new Error(`Project '${projectSlug}' not found`);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const includeHistory = options.include_history ?? false;

  const [activeObjectiveRows, activeItems, recurring, history] = await Promise.all([
    project.active_objective_id
      ? getTasksByIds(db, [project.active_objective_id]).then((tasks) => enrichTasks(db, tasks))
      : Promise.resolve([] as EnrichedTask[]),
    loadContextItems(db, {
      project_slugs: [projectSlug],
      current_only: true,
      include_history: false,
      limit,
    }),
    loadContextItems(db, {
      project_slugs: [projectSlug],
      entity_types: ["recurring_system"],
      current_only: true,
      limit: 10,
    }),
    includeHistory
      ? loadContextItems(db, {
          project_slugs: [projectSlug],
          current_only: false,
          include_history: true,
          lifecycle_states: ["superseded", "archived", "completed"],
          limit,
        })
      : Promise.resolve([] as EnrichedTask[]),
  ]);

  const active_objective = activeObjectiveRows[0] ?? null;

  return {
    level: "project",
    source: "d1",
    project,
    active_objective,
    active_items: activeItems.filter((item) => item.id !== active_objective?.id),
    recurring_systems: recurring,
    history,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Raw memories bundle. Direct passthrough to loadContextItems for the
 * bottom level of the hierarchy.
 */
export interface RawMemoriesBundle {
  level: "raw_memories";
  source: "d1";
  items: EnrichedTask[];
  count: number;
  generated_at: string;
}

export async function loadRawMemories(
  db: D1Database,
  query: ContextLoadQuery
): Promise<RawMemoriesBundle> {
  const items = await loadContextItems(db, query);
  return {
    level: "raw_memories",
    source: "d1",
    items,
    count: items.length,
    generated_at: new Date().toISOString(),
  };
}
