import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./db.js";
import * as ctx from "./context.js";
import { parseDueDate } from "./due.js";
import { getAppSettings, updateAppSettings } from "./settings.js";
import { deleteTaskVector, semanticSearchTaskIds, upsertTaskVectors } from "./vectorize.js";
import {
  getCachedContextSummary,
  setCachedContextSummary,
  getCachedStartupContext,
  setCachedStartupContext,
  getCachedProjectContext,
  setCachedProjectContext,
  invalidateContextCache,
  invalidateAllContextCaches,
} from "./context-cache.js";

// Context cache key namespaces: context:summary:<scope> and context:startup
const ACTIVE_FOCUS_KEY = "focus:active";
const ACTIVE_FOCUS_TTL_SECONDS = 120;

const itemKindSchema = z.enum(["task", "memory"]);
const entityTypeSchema = z.enum([
  "strategic_goal",
  "tactical_task",
  "recurring_system",
  "context_memory",
  "archived_history",
]);
const lifecycleStateSchema = z.enum(["active", "superseded", "archived", "completed", "stale", "dormant"]);
const recurrenceSchema = z.enum(["daily", "weekly", "monthly", "weekdays"]);
const prioritySchema = z.enum(["low", "medium", "high"]);
const sortSchema = z.enum([
  "updated_at",
  "-updated_at",
  "created_at",
  "-created_at",
  "due_at",
  "-due_at",
  "priority",
  "-priority",
  "title",
  "-title",
]);

function ok(data: unknown) {
  const structuredContent: Record<string, unknown> =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { result: data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent,
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function toPriority(value?: string): db.PriorityLevel {
  return db.PRIORITY_VALUES[value ?? "medium"] ?? 2;
}

function baseTaskFields(task: db.EnrichedTask) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    raw_input: task.raw_input,
    item_kind: task.item_kind,
    entity_type: task.entity_type,
    lifecycle_state: task.lifecycle_state,
    objective_id: task.objective_id,
    completed: task.completed === 1,
    priority: db.PRIORITY_NAMES[(task.priority as db.PriorityLevel) ?? 2] ?? "medium",
    priority_level: task.priority,
    startup_priority: task.startup_priority,
    due_at: task.due_at,
    due_text: task.due_text,
    snoozed_until: task.snoozed_until,
    ignored_at: task.ignored_at,
    archived_at: task.archived_at,
    pinned: task.pinned === 1,
    recurrence_kind: task.recurrence_kind,
    recurrence_interval: task.recurrence_interval,
    recurrence_until: task.recurrence_until,
    completed_at: task.completed_at,
    last_completed_at: task.last_completed_at,
    last_completed_due_at: task.last_completed_due_at,
    last_active_at: task.last_active_at,
    stale_after_at: task.stale_after_at,
    last_touched_at: task.last_touched_at,
    last_meaningful_at: task.last_meaningful_at,
    superseded_at: task.superseded_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
    project: task.project,
    group: task.group,
    tags: task.tags,
  };
}

function serializeTask(task: db.EnrichedTask) {
  return baseTaskFields(task);
}


function serializeFocusContext(context: db.FocusContext) {
  return {
    project: context.project,
    objective: context.objective,
    strategic_focus: context.strategic_focus ? serializeTask(context.strategic_focus) : null,
    tactical_next_step: context.tactical_next_step ? serializeTask(context.tactical_next_step) : null,
    blockers: context.blockers.map(serializeTask),
    recurring_systems: context.recurring_systems.map(serializeTask),
    replaced_items: context.replaced_items.map(serializeTask),
    focus_version: context.focus_version,
    generated_at: context.generated_at,
  };
}

function serializeFocusSnapshot(context: ctx.FocusSnapshot) {
  return {
    project: context.project,
    objective_id: context.objective_id,
    strategic_focus: context.strategic_focus ? serializeTask(context.strategic_focus) : null,
    tactical_next_step: context.tactical_next_step ? serializeTask(context.tactical_next_step) : null,
    focus_version: context.focus_version,
    generated_at: context.generated_at,
  };
}

function serializeContextSummary(summary: ctx.ContextSummary) {
  return {
    scope: summary.scope,
    total: summary.total,
    active_count: summary.active_count,
    pinned_count: summary.pinned_count,
    top_item: summary.top_item,
    version: summary.version,
    last_consolidated: summary.last_consolidated,
    generated_at: summary.generated_at,
  };
}

function serializeTopicSummary(bundle: ctx.TopicSummaryBundle) {
  return {
    level: bundle.level,
    scope: bundle.scope,
    group: bundle.group,
    canonical_item: bundle.canonical_item ? serializeTask(bundle.canonical_item) : null,
    summary: serializeContextSummary(bundle.summary),
    source: bundle.source,
    generated_at: bundle.generated_at,
  };
}

function serializeStartupContext(bundle: ctx.StartupContextBundle) {
  return {
    level: bundle.level,
    source: bundle.source,
    context_version: bundle.context_version,
    generated_at: bundle.generated_at,
    last_consolidated: bundle.last_consolidated,
    profile: bundle.profile ? serializeTask(bundle.profile) : null,
    active_goals: bundle.active_goals.map(serializeTask),
    current_focus: serializeFocusSnapshot(bundle.current_focus),
    active_projects: bundle.active_projects,
    always_load: bundle.always_load.map(serializeTask),
    topic_summaries: bundle.topic_summaries.map(serializeTopicSummary),
  };
}

function serializeProjectContext(bundle: ctx.ProjectContextBundle) {
  return {
    level: bundle.level,
    source: bundle.source,
    project: bundle.project,
    active_objective: bundle.active_objective ? serializeTask(bundle.active_objective) : null,
    active_items: bundle.active_items.map(serializeTask),
    recurring_systems: bundle.recurring_systems.map(serializeTask),
    history: bundle.history.map(serializeTask),
    generated_at: bundle.generated_at,
  };
}

function serializeRawMemories(bundle: ctx.RawMemoriesBundle) {
  return {
    level: bundle.level,
    source: bundle.source,
    items: bundle.items.map(serializeTask),
    count: bundle.count,
    generated_at: bundle.generated_at,
  };
}

function normalizeTags(tags?: string[]) {
  return Array.from(new Set(tags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? []));
}

function toFtsQuery(value?: string) {
  if (!value) return undefined;
  const terms = value.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;
  if (terms.length === 1) return terms[0];
  return terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
}

function parseQuickInput(
  input: string,
  defaultKind: db.ItemKind
): {
  title: string;
  tags: string[];
  projectSlug?: string;
  groupSlug?: string;
  dueText?: string;
  itemKind: db.ItemKind;
} {
  const compact = input.trim().replace(/\s+/g, " ");
  const tags = Array.from(compact.matchAll(/(?:^|\s)#([a-z0-9_-]+)/gi)).map((match) =>
    match[1].toLowerCase()
  );
  const projectMatch = compact.match(/(?:^|\s)\+([a-z0-9_-]+)/i);
  const groupMatch = compact.match(/(?:^|\s)@([a-z0-9_-]+)/i);
  const dueMatch = compact.match(/\bdue:(.+)$/i);
  const inferredKind = /^(note|memory|context|remember):/i.test(compact) ? "memory" : defaultKind;
  const title = compact
    .replace(/(?:^|\s)#[a-z0-9_-]+/gi, " ")
    .replace(/(?:^|\s)\+[a-z0-9_-]+/gi, " ")
    .replace(/(?:^|\s)@[a-z0-9_-]+/gi, " ")
    .replace(/\bdue:.+$/i, " ")
    .replace(/^(note|memory|context|remember):/i, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: title || compact.slice(0, 160),
    tags,
    projectSlug: projectMatch?.[1]?.toLowerCase(),
    groupSlug: groupMatch?.[1]?.toLowerCase(),
    dueText: dueMatch?.[1]?.trim(),
    itemKind: inferredKind,
  };
}

async function clearActiveFocus(kv: KVNamespace) {
  await kv.delete(ACTIVE_FOCUS_KEY);
}

async function setActiveFocus(kv: KVNamespace, taskId: number) {
  await kv.put(
    ACTIVE_FOCUS_KEY,
    JSON.stringify({ task_id: taskId, cached_at: new Date().toISOString() }),
    { expirationTtl: ACTIVE_FOCUS_TTL_SECONDS }
  );
}

async function getCachedFocusTask(env: Env): Promise<db.EnrichedTask | null> {
  const cached = await env.APP_KV.get<{ task_id?: number }>(ACTIVE_FOCUS_KEY, "json");
  if (!cached?.task_id) return null;

  const task = await db.getTaskById(env.DB, cached.task_id);
  if (
    !task ||
    task.completed ||
    task.item_kind !== "task" ||
    task.entity_type !== "tactical_task" ||
    task.lifecycle_state !== "active" ||
    task.archived_at
  ) return null;

  const now = new Date().toISOString();
  if (task.snoozed_until && task.snoozed_until > now) return null;
  if (task.ignored_at) {
    const cooldownBoundary = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    if (task.ignored_at > cooldownBoundary) return null;
  }

  return db.enrichTask(env.DB, task);
}

async function loadTask(env: Env, id: number) {
  const task = await db.getTaskById(env.DB, id);
  return task ? db.enrichTask(env.DB, task) : null;
}

async function syncVectorForTask(env: Env, task: db.EnrichedTask) {
  if (
    task.completed === 1 ||
    task.archived_at ||
    task.lifecycle_state === "completed" ||
    task.lifecycle_state === "archived" ||
    task.lifecycle_state === "superseded"
  ) {
    try {
      await deleteTaskVector(env, task.id);
    } catch {
      // D1 remains source of truth if vector sync fails.
    }
    return;
  }

  try {
    await upsertTaskVectors(env, [task]);
  } catch {
    // D1 remains source of truth if vector sync fails.
  }
}

export function registerTools(server: McpServer, env: Env) {
  server.tool(
    "get_app_settings",
    "Read current app defaults (capture kind, priority, snooze hours, upcoming days). Use to understand defaults before creating items or to check current configuration.",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => ok(await getAppSettings(env.APP_KV))
  );

  server.tool(
    "update_app_settings",
    "Change app-wide defaults (capture kind, priority, snooze hours, upcoming days). Use when the user wants to change default behavior for future captures or snoozes.",
    {
      default_quick_add_priority: prioritySchema.optional(),
      default_capture_kind: itemKindSchema.optional(),
      default_upcoming_days: z.number().int().min(1).max(365).optional(),
      default_snooze_hours: z.number().int().min(1).max(24 * 30).optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const settings = await updateAppSettings(env.APP_KV, args);
      await invalidateContextCache(env.APP_KV);
      return ok(settings);
    }
  );

  server.tool(
    "parse_due_date",
    "Parse a human due date string (e.g. 'tomorrow', 'next friday', 'in 3 days') into an ISO timestamp. Use when you need to validate or preview what a due date resolves to before creating or updating an item.",
    {
      input: z.string().min(1),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => ok(parseDueDate(args.input))
  );

  server.tool(
    "create_item",
    "Create a new task or memory with full metadata (title, description, priority, due date, project, group, tags, recurrence, startup priority). Prefer quick_capture for simple inputs. Always run find_semantic_conflicts first to avoid duplicates.",
    {
      title: z.string().min(1),
      description: z.string().optional(),
      raw_input: z.string().optional(),
      item_kind: itemKindSchema.default("task"),
      entity_type: entityTypeSchema.optional(),
      lifecycle_state: lifecycleStateSchema.optional(),
      objective_id: z.number().int().positive().optional(),
      priority: prioritySchema.optional(),
      due: z.string().optional().describe("Human due date text or ISO timestamp"),
      project_slug: z.string().optional(),
      project_name: z.string().optional(),
      group_slug: z.string().optional(),
      group_name: z.string().optional(),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      startup_priority: z.number().int().min(1).max(10).optional().describe("Startup priority: 10 always load, 7 load if relevant, 3 historical/background, 1 ignore unless requested"),
      recurrence_kind: recurrenceSchema.optional(),
      recurrence_interval: z.number().int().min(1).max(365).optional(),
      recurrence_until: z.string().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const settings = await getAppSettings(env.APP_KV);
        const parsedDue = parseDueDate(args.due);
        const task = await db.createTask(env.DB, {
          title: args.title,
          description: args.description,
          raw_input: args.raw_input,
          item_kind: args.item_kind,
          entity_type: args.entity_type,
          lifecycle_state: args.lifecycle_state,
          objective_id: args.objective_id ?? null,
          priority: toPriority(args.priority ?? settings.default_quick_add_priority),
          startup_priority: args.startup_priority,
          due_at: parsedDue.due_at,
          due_text: parsedDue.normalized,
          project: args.project_slug || args.project_name
            ? { slug: args.project_slug, name: args.project_name }
            : null,
          group: args.group_slug || args.group_name
            ? { slug: args.group_slug, name: args.group_name }
            : null,
          tags: normalizeTags(args.tags),
          pinned: args.pinned,
          recurrence_kind: args.recurrence_kind ?? null,
          recurrence_interval: args.recurrence_interval ?? null,
          recurrence_until: args.recurrence_until ?? null,
        });
        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to create item: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "quick_capture",
    "Fastest way to capture a task from natural language. Parses hashtags (#tag), project (+project), group (@group), and due dates (due:...) automatically. Use instead of create_item for simple quick-adds. Do NOT use for memories—use capture_context instead.",
    {
      input: z.string().min(1),
      item_kind: itemKindSchema.optional(),
      due: z.string().optional(),
      priority: prioritySchema.optional(),
      startup_priority: z.number().int().min(1).max(10).optional().describe("Startup priority: 10 always load, 7 load if relevant, 3 historical/background, 1 ignore unless requested"),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const settings = await getAppSettings(env.APP_KV);
        const parsed = parseQuickInput(args.input, args.item_kind ?? settings.default_capture_kind);
        const dueInput = args.due ?? parsed.dueText;
        const parsedDue = parseDueDate(dueInput);

        const task = await db.createTask(env.DB, {
          title: parsed.title,
          description: args.input.trim(),
          raw_input: args.input.trim(),
          item_kind: parsed.itemKind,
          priority: toPriority(args.priority ?? settings.default_quick_add_priority),
          startup_priority: args.startup_priority,
          due_at: parsedDue.due_at,
          due_text: parsedDue.normalized,
          project: parsed.projectSlug ? { slug: parsed.projectSlug, name: parsed.projectSlug } : null,
          group: parsed.groupSlug ? { slug: parsed.groupSlug, name: parsed.groupSlug } : null,
          tags: normalizeTags(parsed.tags),
        });

        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to capture item: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "capture_context",
    "Capture a memory or context note. Use only when no suitable existing memory exists—prefer update_item for existing items. Use before capture to check for duplicates with find_semantic_conflicts. Use capture_context instead of quick_capture for non-actionable knowledge.",
    {
      input: z.string().min(1),
      tags: z.array(z.string()).optional(),
      project_slug: z.string().optional(),
      group_slug: z.string().optional(),
      pinned: z.boolean().optional(),
      startup_priority: z.number().int().min(1).max(10).optional().describe("Startup priority: 10 always load, 7 load if relevant, 3 historical/background, 1 ignore unless requested"),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const parsed = parseQuickInput(args.input, "memory");
        const task = await db.createTask(env.DB, {
          title: parsed.title,
          description: args.input.trim(),
          raw_input: args.input.trim(),
          item_kind: "memory",
          priority: 1,
          project: args.project_slug || parsed.projectSlug
            ? { slug: args.project_slug ?? parsed.projectSlug, name: args.project_slug ?? parsed.projectSlug }
            : null,
          group: args.group_slug || parsed.groupSlug
            ? { slug: args.group_slug ?? parsed.groupSlug, name: args.group_slug ?? parsed.groupSlug }
            : null,
          tags: normalizeTags([...(args.tags ?? []), ...parsed.tags]),
          pinned: args.pinned,
          startup_priority: args.startup_priority,
        });
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to capture context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_item",
    "Fetch a single item by its numeric id. Use when you already know the item id (e.g. from a previous tool result). Do NOT use for discovery—use list_items, semantic_search, or context loading tools instead.",
    { id: z.number().int().positive() },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const task = await loadTask(env, args.id);
      return task ? ok({ item: serializeTask(task) }) : err(`Item '${args.id}' not found`);
    }
  );

  server.tool(
    "list_items",
    "List and filter items by kind, status, project, group, tags, due date, priority, or text search. Use for targeted queries when semantic_search is too broad. Prefer context loading tools (get_startup_context, get_context_summary, get_focus_context) for general context gathering.",
    {
      ids: z.array(z.number().int().positive()).optional(),
      kinds: z.array(itemKindSchema).optional(),
      entity_types: z.array(entityTypeSchema).optional(),
      lifecycle_states: z.array(lifecycleStateSchema).optional(),
      completed: z.boolean().optional(),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      priority: z.array(prioritySchema).optional(),
      startup_priority_min: z.number().int().min(1).max(10).optional(),
      startup_priority_max: z.number().int().min(1).max(10).optional(),
      q: z.string().optional().describe("FTS query over title, description, raw input"),
      due_before: z.string().optional(),
      due_after: z.string().optional(),
      project_slugs: z.array(z.string()).optional(),
      group_slugs: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      stale_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      sort: sortSchema.optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const tasks = await db.listItems(env.DB, {
          ids: args.ids,
          kinds: args.kinds,
          entity_types: args.entity_types,
          lifecycle_states: args.lifecycle_states,
          completed: args.completed,
          archived: args.archived,
          pinned: args.pinned,
          priority: args.priority?.map((value) => toPriority(value)),
          startup_priority_min: args.startup_priority_min,
          startup_priority_max: args.startup_priority_max,
          q: toFtsQuery(args.q),
          due_before: args.due_before,
          due_after: args.due_after,
          project_slugs: args.project_slugs?.map((slug) => slug.toLowerCase()),
          group_slugs: args.group_slugs?.map((slug) => slug.toLowerCase()),
          tags: args.tags?.map((tag) => tag.toLowerCase()),
          stale_only: args.stale_only,
          limit: args.limit,
          offset: args.offset,
          sort: args.sort,
        });
        const enriched = await db.enrichTasks(env.DB, tasks);
        return ok({ items: enriched.map(serializeTask), count: enriched.length });
      } catch (error: unknown) {
        return err(`Failed to list items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  const contextLevelSchema = z.enum(["startup", "topic_summary", "project", "raw_memories"]);

  server.tool(
    "load_context",
    "Load context at a specific hierarchy level. Always follow this retrieval order: startup → topic_summary → project → raw_memories. Use startup for general conversations, topic_summary for topic-specific questions (e.g. 'my AWS setup'), project for project-specific work. Use raw_memories ONLY as a last resort when higher-level summaries cannot answer the request. Prefer get_startup_context, get_context_summary, and get_focus_context for most use cases.",
    {
      level: contextLevelSchema.optional().default("raw_memories").describe("Hierarchy level to load"),
      topic: z.string().optional().describe("Topic/group slug for level=topic_summary"),
      project_slug: z.string().optional().describe("Project slug for level=project"),
      include_history: z.boolean().optional().describe("Include historical items for level=project or raw_memories"),
      tags: z.array(z.string()).optional().describe("Tag slugs for level=raw_memories"),
      project_slugs: z.array(z.string()).optional().describe("Project slugs for level=raw_memories"),
      group_slugs: z.array(z.string()).optional().describe("Group slugs for level=raw_memories"),
      profile: z.boolean().optional().describe("Load profile items (raw_memories level)"),
      pinned: z.boolean().optional().describe("Filter by pinned status (raw_memories level)"),
      current_only: z.boolean().optional().default(true).describe("Exclude superseded/archived/completed items (raw_memories level)"),
      kinds: z.array(itemKindSchema).optional(),
      entity_types: z.array(entityTypeSchema).optional(),
      startup_priority_min: z.number().int().min(0).max(10).optional(),
      startup_priority_max: z.number().int().min(0).max(10).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      use_cache: z.boolean().optional().default(true).describe("Read/write KV cache for startup/topic/project levels"),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const level = args.level ?? "raw_memories";
        const useCache = args.use_cache ?? true;

        if (level === "startup") {
          if (useCache) {
            const cached = await getCachedStartupContext(env.APP_KV);
            if (cached) {
              return ok({ source: "kv_cache", ...(cached as Record<string, unknown>) });
            }
          }
          const bundle = await ctx.loadStartupContext(env.DB);
          const serialized = serializeStartupContext(bundle);
          if (useCache) {
            await setCachedStartupContext(env.APP_KV, serialized);
          }
          return ok(serialized);
        }

        if (level === "topic_summary") {
          const scope = args.topic?.toLowerCase();
          if (!scope) {
            return err("Provide topic for level=topic_summary");
          }
          if (useCache) {
            const cached = await getCachedContextSummary(env.APP_KV, scope);
            if (cached) {
              return ok({ scope, source: "kv_cache", summary: cached });
            }
          }
          const bundle = await ctx.loadTopicSummary(env.DB, scope);
          const serialized = serializeTopicSummary(bundle);
          if (useCache) {
            await setCachedContextSummary(env.APP_KV, scope, serialized);
          }
          return ok(serialized);
        }

        if (level === "project") {
          const slug = args.project_slug?.toLowerCase();
          if (!slug) {
            return err("Provide project_slug for level=project");
          }
          if (useCache) {
            const cached = await getCachedProjectContext(env.APP_KV, slug);
            if (cached) {
              return ok({ source: "kv_cache", ...(cached as Record<string, unknown>) });
            }
          }
          const bundle = await ctx.loadProjectContext(env.DB, slug, {
            include_history: args.include_history,
            limit: args.limit,
          });
          const serialized = serializeProjectContext(bundle);
          if (useCache) {
            await setCachedProjectContext(env.APP_KV, slug, serialized);
          }
          return ok(serialized);
        }

        const tasks = await ctx.loadContextItems(env.DB, {
          tags: args.tags?.map((tag) => tag.toLowerCase()),
          project_slugs: args.project_slugs?.map((slug) => slug.toLowerCase()),
          group_slugs: args.group_slugs?.map((slug) => slug.toLowerCase()),
          profile: args.profile,
          pinned: args.pinned,
          current_only: args.current_only,
          include_history: args.include_history,
          kinds: args.kinds,
          entity_types: args.entity_types,
          startup_priority_min: args.startup_priority_min,
          startup_priority_max: args.startup_priority_max,
          limit: args.limit,
        });
        return ok(serializeRawMemories({
          level: "raw_memories",
          source: "d1",
          items: tasks,
          count: tasks.length,
          generated_at: new Date().toISOString(),
        }));
      } catch (error: unknown) {
        return err(`Failed to load context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "update_item",
    "Update any field on an existing item (title, description, priority, due date, project, group, tags, lifecycle state, recurrence, etc.). Preferred over creating a new item whenever existing information changes. Always prefer updating over creating duplicates.",
    {
      id: z.number().int().positive(),
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      raw_input: z.string().nullable().optional(),
      item_kind: itemKindSchema.optional(),
      entity_type: entityTypeSchema.optional(),
      lifecycle_state: lifecycleStateSchema.optional(),
      objective_id: z.number().int().positive().nullable().optional(),
      clear_objective: z.boolean().optional(),
      priority: prioritySchema.optional(),
      due: z.string().optional(),
      clear_due: z.boolean().optional(),
      project_slug: z.string().optional(),
      project_name: z.string().optional(),
      clear_project: z.boolean().optional(),
      group_slug: z.string().optional(),
      group_name: z.string().optional(),
      clear_group: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      startup_priority: z.number().int().min(1).max(10).nullable().optional().describe("Startup priority: 10 always load, 7 load if relevant, 3 historical/background, 1 ignore unless requested"),
      recurrence_kind: recurrenceSchema.nullable().optional(),
      recurrence_interval: z.number().int().min(1).max(365).nullable().optional(),
      recurrence_until: z.string().nullable().optional(),
      clear_recurrence: z.boolean().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const parsedDue = args.clear_due ? { due_at: null, normalized: null } : parseDueDate(args.due);
        const task = await db.updateTask(env.DB, args.id, {
          title: args.title,
          description: args.description === null ? null : args.description,
          raw_input: args.raw_input === null ? null : args.raw_input,
          item_kind: args.item_kind,
          entity_type: args.entity_type,
          lifecycle_state: args.lifecycle_state,
          objective_id: args.objective_id === undefined ? undefined : args.objective_id,
          clear_objective: args.clear_objective || args.objective_id === null,
          priority: args.priority ? toPriority(args.priority) : undefined,
          due_at: args.due !== undefined ? parsedDue.due_at : undefined,
          due_text: args.due !== undefined ? parsedDue.normalized : undefined,
          clear_due: args.clear_due,
          project: args.project_slug || args.project_name ? { slug: args.project_slug, name: args.project_name } : undefined,
          clear_project: args.clear_project,
          group: args.group_slug || args.group_name ? { slug: args.group_slug, name: args.group_name } : undefined,
          clear_group: args.clear_group,
          tags: args.tags ? normalizeTags(args.tags) : undefined,
          pinned: args.pinned,
          archived: args.archived,
          startup_priority: args.startup_priority === null ? null : args.startup_priority,
          recurrence_kind: args.recurrence_kind === undefined ? undefined : args.recurrence_kind,
          recurrence_interval: args.recurrence_interval === undefined ? undefined : args.recurrence_interval,
          recurrence_until: args.recurrence_until === undefined ? undefined : args.recurrence_until,
          clear_recurrence: args.clear_recurrence,
        });

        if (!task) return err(`Item '${args.id}' not found`);
        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to update item: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_item_startup_priority",
    "Set how important an item is for startup context loading. Scale: 10 = always load (critical), 8 = frequently needed, 5 = topic-specific (loads when relevant topic is active), 2 = historical/background (rarely needed), 0 = never auto-load. Use to control what appears in get_startup_context without loading raw memories.",
    {
      id: z.number().int().positive(),
      startup_priority: z.number().int().min(0).max(10),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const task = await db.updateTask(env.DB, args.id, {
          startup_priority: args.startup_priority,
        });
        if (!task) return err(`Item '${args.id}' not found`);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to set startup priority: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_item_pinned",
    "Pin or unpin an item so it appears in focused context loads",
    {
      id: z.number().int().positive(),
      pinned: z.boolean(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const task = await db.updateTask(env.DB, args.id, { pinned: args.pinned });
        if (!task) return err(`Item '${args.id}' not found`);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to set pinned: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_item_lifecycle_state",
    "Transition an item to active, superseded, archived, completed, stale, or dormant",
    {
      id: z.number().int().positive(),
      lifecycle_state: lifecycleStateSchema,
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const task = await db.updateTask(env.DB, args.id, {
          lifecycle_state: args.lifecycle_state,
          archived: args.lifecycle_state === "archived",
        });
        if (!task) return err(`Item '${args.id}' not found`);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to set lifecycle state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_item_group",
    "Assign or remove an item from a context group (topic/profile bucket)",
    {
      id: z.number().int().positive(),
      group_slug: z.string().optional(),
      group_name: z.string().optional(),
      clear_group: z.boolean().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const task = await db.updateTask(env.DB, args.id, {
          group: args.clear_group
            ? null
            : args.group_slug || args.group_name
              ? { slug: args.group_slug, name: args.group_name }
              : undefined,
          clear_group: args.clear_group,
        });
        if (!task) return err(`Item '${args.id}' not found`);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to set group: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_item_project",
    "Assign or remove an item from a project",
    {
      id: z.number().int().positive(),
      project_slug: z.string().optional(),
      project_name: z.string().optional(),
      clear_project: z.boolean().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const task = await db.updateTask(env.DB, args.id, {
          project: args.clear_project
            ? null
            : args.project_slug || args.project_name
              ? { slug: args.project_slug, name: args.project_name }
              : undefined,
          clear_project: args.clear_project,
        });
        if (!task) return err(`Item '${args.id}' not found`);
        await syncVectorForTask(env, task);
        await invalidateContextCache(env.APP_KV);
        return ok({ item: serializeTask(task) });
      } catch (error: unknown) {
        return err(`Failed to set project: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "delete_item",
    "Delete a single item by id",
    { id: z.number().int().positive() },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      try {
        const deleted = await db.deleteTask(env.DB, args.id);
        if (!deleted) return err(`Item '${args.id}' not found`);
        await clearActiveFocus(env.APP_KV);
        try {
          await deleteTaskVector(env, args.id);
        } catch {
          // D1 delete already succeeded.
        }
        await invalidateContextCache(env.APP_KV);
        return ok({ deleted: true, id: args.id });
      } catch (error: unknown) {
        return err(`Failed to delete item: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "delete_items",
    "Delete multiple items by id",
    {
      ids: z.array(z.number().int().positive()).min(1),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      try {
        const deleted = await db.deleteTasks(env.DB, args.ids);
        await clearActiveFocus(env.APP_KV);
        for (const id of args.ids) {
          try {
            await deleteTaskVector(env, id);
          } catch {
            // Keep deleting remaining vectors.
          }
        }
        await invalidateContextCache(env.APP_KV);
        return ok({ deleted, ids: args.ids });
      } catch (error: unknown) {
        return err(`Failed to delete items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_focus_task",
    "Return the active tactical next step from the current objective, kept for compatibility",
    {
      project_slug: z.string().optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const cached = args.project_slug ? null : await getCachedFocusTask(env);
        if (cached) return ok({ item: serializeTask(cached), source: "kv_cache" });

        const context = await db.getFocusContext(env.DB, args.project_slug?.toLowerCase());
        if (context.tactical_next_step) {
          await setActiveFocus(env.APP_KV, context.tactical_next_step.id);
          return ok({
            item: serializeTask(context.tactical_next_step),
            strategic_focus: context.strategic_focus ? serializeTask(context.strategic_focus) : null,
            source: "focus_context",
          });
        }

        const task = await db.getFocusTask(env.DB);
        if (!task) return ok({ item: null });

        const enriched = await db.enrichTask(env.DB, task);
        await setActiveFocus(env.APP_KV, enriched.id);
        return ok({ item: serializeTask(enriched), source: "d1" });
      } catch (error: unknown) {
        return err(`Failed to select focus task: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_focus_context",
    "Return layered focus: strategic objective, active tactical next step, blockers, recurring systems, and replaced items",
    {
      project_slug: z.string().optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const context = await db.getFocusContext(env.DB, args.project_slug?.toLowerCase());
        return ok(serializeFocusContext(context));
      } catch (error: unknown) {
        return err(`Failed to get focus context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_active_objective",
    "Set the one canonical active strategic objective for a project, creating it when title is supplied",
    {
      project_slug: z.string().min(1),
      item_id: z.number().int().positive().optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const result = await db.setActiveObjective(env.DB, {
          project_slug: args.project_slug.toLowerCase(),
          item_id: args.item_id,
          title: args.title,
          description: args.description,
        });
        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, result.item);
        await invalidateContextCache(env.APP_KV);
        return ok({
          project: result.project,
          objective: result.objective,
          item: serializeTask(result.item),
        });
      } catch (error: unknown) {
        return err(`Failed to set active objective: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "supersede_items",
    "Mark old items as superseded by a newer item and add supersedes relationships",
    {
      source_item_id: z.number().int().positive(),
      target_item_ids: z.array(z.number().int().positive()).min(1),
      reason: z.string().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const result = await db.supersedeItems(env.DB, args.source_item_id, args.target_item_ids, args.reason);
        await clearActiveFocus(env.APP_KV);
        for (const item of result.superseded) {
          try {
            await deleteTaskVector(env, item.id);
          } catch {
            // D1 remains source of truth.
          }
        }
        await syncVectorForTask(env, result.source);
        await invalidateContextCache(env.APP_KV);
        return ok({
          source: serializeTask(result.source),
          superseded: result.superseded.map(serializeTask),
        });
      } catch (error: unknown) {
        return err(`Failed to supersede items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_stale_tasks",
    "Return stale active tasks that have not been updated recently",
    {
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const tasks = await db.getStaleTasks(env.DB, args.limit ?? 25);
        const enriched = await db.enrichTasks(env.DB, tasks);
        return ok({ items: enriched.map(serializeTask), count: enriched.length });
      } catch (error: unknown) {
        return err(`Failed to get stale tasks: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "mark_stale_candidates",
    "Mark untouched active tactical tasks as stale so they stop competing for focus",
    {
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const items = await db.markStaleCandidates(env.DB, args.limit ?? 25);
        await clearActiveFocus(env.APP_KV);
        for (const item of items) {
          await syncVectorForTask(env, item);
        }
        await invalidateContextCache(env.APP_KV);
        return ok({ items: items.map(serializeTask), count: items.length });
      } catch (error: unknown) {
        return err(`Failed to mark stale candidates: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "update_task_state",
    "Idempotently complete, snooze, or ignore a task item",
    {
      id: z.number().int().positive(),
      action: z.enum(["complete", "snooze", "ignore"]),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const settings = await getAppSettings(env.APP_KV);
        const result = await db.updateTaskState(env.DB, args.id, args.action, settings.default_snooze_hours);
        await clearActiveFocus(env.APP_KV);
        if (result.deleted_vector) {
          try {
            await deleteTaskVector(env, result.task.id);
          } catch {
            // D1 remains source of truth.
          }
        } else {
          await syncVectorForTask(env, result.task);
        }
        await invalidateContextCache(env.APP_KV);
        return ok({ changed: result.changed, item: serializeTask(result.task) });
      } catch (error: unknown) {
        return err(`Failed to update task state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "semantic_search",
    "Search semantically across tasks and memories and hydrate matching items from D1",
    {
      query: z.string().min(1),
      kinds: z.array(itemKindSchema).optional(),
      entity_types: z.array(entityTypeSchema).optional(),
      lifecycle_states: z.array(lifecycleStateSchema).optional(),
      include_obsolete: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const defaultStates = args.include_obsolete
          ? undefined
          : args.lifecycle_states ?? ["active", "dormant"];
        const filter = args.include_obsolete
          ? undefined
          : {
            lifecycle_state: { $in: defaultStates },
            entity_type: {
              $in: args.entity_types ?? ["strategic_goal", "tactical_task", "context_memory"],
            },
            archived: false,
          };
        let matches;
        try {
          matches = await semanticSearchTaskIds(env, args.query, args.limit ?? 10, filter);
        } catch {
          matches = await semanticSearchTaskIds(env, args.query, args.limit ?? 10);
        }
        const hydrated = await db.enrichTasks(
          env.DB,
          await db.getTasksByIds(env.DB, matches.map((match) => match.taskId))
        );
        const byId = new Map(hydrated.map((task) => [task.id, task]));
        const filtered = matches.flatMap((match) => {
          const task = byId.get(match.taskId);
          if (!task) return [];
          if (args.kinds && !args.kinds.includes(task.item_kind)) return [];
          if (args.entity_types && !args.entity_types.includes(task.entity_type)) return [];
          if (defaultStates && !defaultStates.includes(task.lifecycle_state)) return [];
          if (!args.include_obsolete && (task.archived_at || task.completed === 1 || task.lifecycle_state === "superseded")) return [];
          return [{ score: match.score, item: serializeTask(task) }];
        });
        return ok({ query: args.query, matches: filtered, count: filtered.length });
      } catch (error: unknown) {
        return err(`Failed to semantic-search items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "find_semantic_conflicts",
    "Find active items semantically similar to a query or item and return likely duplicate/supersession candidates",
    {
      query: z.string().optional(),
      item_id: z.number().int().positive().optional(),
      project_slug: z.string().optional(),
      threshold: z.number().min(0).max(1).default(0.78),
      limit: z.number().int().min(1).max(50).optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        let query = args.query;
        if (!query && args.item_id) {
          const item = await loadTask(env, args.item_id);
          if (!item) return err(`Item '${args.item_id}' not found`);
          query = [item.title, item.description, item.raw_input].filter(Boolean).join("\n");
        }
        if (!query) return err("Provide query or item_id");

        const matches = await semanticSearchTaskIds(env, query, args.limit ?? 10);
        const hydrated = await db.enrichTasks(env.DB, await db.getTasksByIds(env.DB, matches.map((match) => match.taskId)));
        const byId = new Map(hydrated.map((task) => [task.id, task]));
        const conflicts = matches.flatMap((match) => {
          const item = byId.get(match.taskId);
          if (!item) return [];
          if (args.item_id && item.id === args.item_id) return [];
          if (match.score < args.threshold) return [];
          if (args.project_slug && item.project?.slug !== args.project_slug.toLowerCase()) return [];
          if (item.lifecycle_state !== "active" || item.archived_at || item.completed === 1) return [];
          return [{
            score: match.score,
            suggested_action: item.updated_at < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() ? "supersede_or_merge" : "merge_or_link",
            item: serializeTask(item),
          }];
        });
        return ok({ query, conflicts, count: conflicts.length });
      } catch (error: unknown) {
        return err(`Failed to find semantic conflicts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "find_consolidation_candidates",
    "Deterministically find groups of context items (especially memories) that share tags and may be duplicates, supersessions, or replacements",
    {
      item_kind: z.enum(["memory", "task"]).optional().default("memory"),
      tag: z.string().optional(),
      min_group_size: z.number().int().min(2).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const candidates = await db.findConsolidationCandidates(env.DB, {
          item_kind: args.item_kind,
          tag_slug: args.tag,
          min_group_size: args.min_group_size,
          limit: args.limit,
        });
        return ok({ candidates, count: candidates.length });
      } catch (error: unknown) {
        return err(`Failed to find consolidation candidates: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "consolidate_memories",
    "Link a keeper item to related items with a relationship and optionally mark the targets as superseded",
    {
      source_item_id: z.number().int().positive(),
      target_item_ids: z.array(z.number().int().positive()).min(1),
      relationship_type: z.enum(["duplicate_of", "supersedes", "replaces", "derived_from"]),
      reason: z.string().optional(),
      mark_superseded: z.boolean().optional().default(true),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      try {
        const result = await db.consolidateItems(
          env.DB,
          args.source_item_id,
          args.target_item_ids,
          args.relationship_type,
          args.reason,
          args.mark_superseded
        );
        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, result.source);
        for (const target of result.targets) {
          await syncVectorForTask(env, target);
        }
        await invalidateContextCache(env.APP_KV);
        return ok({
          source: serializeTask(result.source),
          targets: result.targets.map(serializeTask),
          created_relationships: result.created_relationships,
        });
      } catch (error: unknown) {
        return err(`Failed to consolidate memories: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_project_timeline",
    "Return objective/focus/history events for a project",
    {
      project_slug: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        return ok({
          project_slug: args.project_slug.toLowerCase(),
          timeline: await db.getProjectTimeline(env.DB, args.project_slug.toLowerCase(), args.limit ?? 50),
        });
      } catch (error: unknown) {
        return err(`Failed to get project timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "list_projects",
    "List all projects",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => ok({ projects: await db.listProjects(env.DB) })
  );

  server.tool(
    "upsert_project",
    "Create or ensure a project exists",
    {
      name: z.string().min(1),
      slug: z.string().optional(),
      description: z.string().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const project = await db.upsertProject(env.DB, args);
      await invalidateContextCache(env.APP_KV);
      return ok({ project });
    }
  );

  server.tool(
    "delete_project",
    "Delete a project by slug",
    { slug: z.string().min(1) },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      const deleted = await db.deleteProject(env.DB, args.slug.toLowerCase());
      await invalidateContextCache(env.APP_KV);
      return ok({ deleted });
    }
  );

  server.tool(
    "list_groups",
    "List all groups",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => ok({ groups: await db.listGroups(env.DB) })
  );

  server.tool(
    "upsert_group",
    "Create or ensure a group exists",
    {
      name: z.string().min(1),
      slug: z.string().optional(),
      description: z.string().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const group = await db.upsertGroup(env.DB, args);
      await invalidateContextCache(env.APP_KV);
      return ok({ group });
    }
  );

  server.tool(
    "update_group_metadata",
    "Update a context group's deterministic retrieval metadata: kind, priority, description, and summary mode",
    {
      slug: z.string().min(1),
      group_kind: z.enum(["topic", "profile", "project", "system"]).optional(),
      retrieval_priority: z.number().int().min(0).max(100).optional(),
      description: z.string().optional(),
      summary_mode: z.enum(["auto", "manual"]).optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const group = await db.updateGroupMetadata(env.DB, args.slug.toLowerCase(), {
          group_kind: args.group_kind,
          retrieval_priority: args.retrieval_priority,
          description: args.description,
          summary_mode: args.summary_mode,
        });
        if (!group) return err(`Group '${args.slug}' not found`);
        await invalidateContextCache(env.APP_KV);
        return ok({ group });
      } catch (error: unknown) {
        return err(`Failed to update group metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "set_group_canonical_item",
    "Set the canonical active item that represents the current state of a topic/group. Pass null to clear.",
    {
      group_slug: z.string().min(1),
      item_id: z.number().int().positive().nullable(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const group = await db.setGroupCanonicalItem(env.DB, args.group_slug.toLowerCase(), args.item_id);
        await invalidateContextCache(env.APP_KV, [args.group_slug.toLowerCase()]);
        return ok({ group });
      } catch (error: unknown) {
        return err(`Failed to set group canonical item: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "delete_group",
    "Delete a group by slug",
    { slug: z.string().min(1) },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      const deleted = await db.deleteGroup(env.DB, args.slug.toLowerCase());
      await invalidateContextCache(env.APP_KV);
      return ok({ deleted });
    }
  );

  server.tool(
    "list_tags",
    "List all tags",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => ok({ tags: await db.listTags(env.DB) })
  );

  server.tool(
    "get_context_summary",
    "Return the canonical current state and deterministic summary for a topic (group or tag slug).",
    {
      scope: z.string().min(1).optional().describe("Topic or project slug (e.g. work, health, my-project)"),
      topic: z.string().optional().describe("Alias for scope; lowercased tag/topic slug"),
      project_slug: z.string().optional().describe("Project slug; if provided, summary is project-scoped"),
      use_cache: z.boolean().optional().default(true).describe("Whether to read/write KV cache"),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const effectiveScope = (args.scope ?? args.topic ?? args.project_slug ?? "").toLowerCase();
        if (!effectiveScope) {
          return err("Provide scope, topic, or project_slug");
        }

        const useCache = args.use_cache ?? true;
        if (useCache) {
          const cached = await getCachedContextSummary(env.APP_KV, effectiveScope);
          if (cached) {
            return ok({ scope: effectiveScope, source: "kv_cache", summary: cached });
          }
        }

        const bundle = await ctx.loadTopicSummary(env.DB, effectiveScope);
        const serialized = serializeTopicSummary(bundle);
        if (useCache) {
          await setCachedContextSummary(env.APP_KV, effectiveScope, serialized);
        }
        return ok(serialized);
      } catch (error: unknown) {
        return err(`Failed to get context summary: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_startup_context",
    "Return an extremely lightweight startup context: profile, active goals, current focus, active projects, always-load items, and topic summaries.",
    {
      use_cache: z.boolean().optional().default(true),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const useCache = args.use_cache ?? true;
        if (useCache) {
          const cached = await getCachedStartupContext(env.APP_KV);
          if (cached) {
            return ok({ source: "kv_cache", ...(cached as Record<string, unknown>) });
          }
        }

        const bundle = await ctx.loadStartupContext(env.DB);
        const serialized = serializeStartupContext(bundle);
        if (useCache) {
          await setCachedStartupContext(env.APP_KV, serialized);
        }
        return ok(serialized);
      } catch (error: unknown) {
        return err(`Failed to get startup context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}

export {
  getCachedContextSummary,
  setCachedContextSummary,
  getCachedStartupContext,
  setCachedStartupContext,
  invalidateContextCache,
  invalidateAllContextCaches,
} from "./context-cache.js";
