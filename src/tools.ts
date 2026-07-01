import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./db.js";
import { parseDueDate } from "./due.js";
import { getAppSettings, updateAppSettings } from "./settings.js";
import { deleteTaskVector, semanticSearchTaskIds, upsertTaskVectors } from "./vectorize.js";
import {
  getCachedContextSummary,
  setCachedContextSummary,
  getCachedStartupContext,
  setCachedStartupContext,
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

function serializeTaskWithHistory(
  task: db.EnrichedTask,
  relationships: db.RelationshipRecord[] | undefined
) {
  if (!relationships || relationships.length === 0) {
    return baseTaskFields(task);
  }
  return {
    ...baseTaskFields(task),
    historical: true as const,
    superseded_by: relationships.map((relationship) => ({
      source_item_id: relationship.source_item_id,
      relationship_type: relationship.relationship_type,
      created_at: relationship.created_at,
    })),
  };
}

function serializeTasksWithHistory(
  tasks: db.EnrichedTask[],
  superseding: Map<number, db.RelationshipRecord[]>
) {
  return tasks.map((task) => serializeTaskWithHistory(task, superseding.get(task.id)));
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

interface SectionDefaults {
  always_load: boolean;
  profile: boolean;
  focus: boolean;
  objectives: boolean;
  projects: boolean;
  pinned: boolean;
  summaries: boolean;
  history: boolean;
}

function modeDefaults(mode: "minimal" | "normal" | "full"): SectionDefaults {
  if (mode === "minimal") {
    return {
      always_load: true,
      profile: true,
      focus: true,
      objectives: false,
      projects: true,
      pinned: true,
      summaries: false,
      history: false,
    };
  }
  if (mode === "full") {
    return {
      always_load: true,
      profile: true,
      focus: true,
      objectives: true,
      projects: true,
      pinned: true,
      summaries: true,
      history: true,
    };
  }
  return {
    always_load: true,
    profile: true,
    focus: true,
    objectives: true,
    projects: true,
    pinned: true,
    summaries: true,
    history: false,
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
    "Get app-level defaults used by capture and state transitions",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => ok(await getAppSettings(env.APP_KV))
  );

  server.tool(
    "update_app_settings",
    "Update app-level defaults used by capture and state transitions",
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
    "Parse a human due-date string into a normalized ISO timestamp",
    {
      input: z.string().min(1),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => ok(parseDueDate(args.input))
  );

  server.tool(
    "create_item",
    "Create a task or memory item with optional due date, recurrence, project, group, and tags",
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
    "Fast capture for raw task or memory input with hashtags and lightweight metadata hints",
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
    "Capture a memory/context item quickly without forcing task semantics",
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
    "Fetch a single item by id",
    { id: z.number().int().positive() },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const task = await loadTask(env, args.id);
      return task ? ok({ item: serializeTask(task) }) : err(`Item '${args.id}' not found`);
    }
  );

  server.tool(
    "list_items",
    "List items with rich filtering and sorting across tasks and memories",
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

  server.tool(
    "load_context",
    "Load context items deterministically by tags, projects, groups, pinned status, profile associations, and current state",
    {
      tags: z.array(z.string()).optional(),
      project_slugs: z.array(z.string()).optional(),
      group_slugs: z.array(z.string()).optional(),
      profile: z.boolean().optional().describe("Load items tagged/grouped as profile"),
      pinned: z.boolean().optional().describe("Filter by pinned status"),
      current_only: z.boolean().optional().default(true).describe("Exclude superseded/archived/completed items"),
      include_history: z.boolean().optional().describe("Include historical items even when current_only is true"),
      kinds: z.array(itemKindSchema).optional(),
      entity_types: z.array(entityTypeSchema).optional(),
      startup_priority_min: z.number().int().min(1).max(10).optional(),
      startup_priority_max: z.number().int().min(1).max(10).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const tasks = await db.loadContextItems(env.DB, {
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
        return ok({ items: tasks.map(serializeTask), count: tasks.length });
      } catch (error: unknown) {
        return err(`Failed to load context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "update_item",
    "Update item metadata, tags, due date, recurrence, project/group assignment, or archive state",
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
    "Return a deterministic rollup summary of current context for a topic or project",
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

        const projectSlug = args.project_slug?.toLowerCase();
        const items = await db.loadContextItems(env.DB, {
          tags: [effectiveScope],
          project_slugs: projectSlug ? [projectSlug] : undefined,
          current_only: true,
          include_history: false,
          limit: 50,
        });

        const summary = db.buildContextSummary(effectiveScope, items);
        if (useCache) {
          await setCachedContextSummary(env.APP_KV, effectiveScope, summary);
        }
        return ok({ scope: effectiveScope, source: "d1", summary });
      } catch (error: unknown) {
        return err(`Failed to get context summary: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_startup_context",
    "Return a bundled conversation startup loadout: always-load items, profile context, current focus, active objectives, active projects, pinned context, recent summaries, and optional historical background",
    {
      topics: z.array(z.string()).optional().describe("Topic/project slugs to include in recent summaries"),
      mode: z.enum(["minimal", "normal", "full"]).optional().default("normal").describe("Amount of context to load"),
      include_always_load: z.boolean().optional().describe("Override mode default for always_load section"),
      include_profile: z.boolean().optional().describe("Override mode default for profile_context section"),
      include_focus: z.boolean().optional().describe("Override mode default for current_focus section"),
      include_objectives: z.boolean().optional().describe("Override mode default for active_objectives section"),
      include_projects: z.boolean().optional().describe("Override mode default for active_projects section"),
      include_pinned: z.boolean().optional().describe("Override mode default for pinned_context section"),
      include_summaries: z.boolean().optional().describe("Override mode default for recent_summaries section"),
      include_history: z.boolean().optional().describe("Override mode default for historical_background section"),
      use_cache: z.boolean().optional().default(true),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const mode = args.mode ?? "normal";
        const useCache = args.use_cache ?? true;
        if (useCache) {
          const cached = await getCachedStartupContext(env.APP_KV);
          if (cached) {
            return ok({ source: "kv_cache", ...(cached as Record<string, unknown>) });
          }
        }

        const defaults = modeDefaults(mode);
        const sections: SectionDefaults = {
          always_load: args.include_always_load ?? defaults.always_load,
          profile: args.include_profile ?? defaults.profile,
          focus: args.include_focus ?? defaults.focus,
          objectives: args.include_objectives ?? defaults.objectives,
          projects: args.include_projects ?? defaults.projects,
          pinned: args.include_pinned ?? defaults.pinned,
          summaries: args.include_summaries ?? defaults.summaries,
          history: args.include_history ?? defaults.history,
        };

        const relevantThreshold = mode === "minimal" ? 10 : 7;

        const [alwaysLoadItems, profileItems, activeObjectives, active_projects, pinnedItems] = await Promise.all([
          sections.always_load
            ? db.loadContextItems(env.DB, { startup_priority_min: 10, current_only: true, include_history: false, limit: 20 })
            : Promise.resolve([] as db.EnrichedTask[]),
          sections.profile
            ? db.loadProfileItems(env.DB, { startup_priority_min: relevantThreshold, limit: 20 })
            : Promise.resolve([] as db.EnrichedTask[]),
          sections.objectives
            ? db.loadActiveObjectives(env.DB, { limit: 20, startupPriorityMin: relevantThreshold })
            : Promise.resolve([] as db.EnrichedTask[]),
          sections.projects
            ? db.loadActiveProjects(env.DB, 20)
            : Promise.resolve([] as db.Project[]),
          sections.pinned
            ? db.loadPinnedItems(env.DB, { startup_priority_min: relevantThreshold, limit: 20 })
            : Promise.resolve([] as db.EnrichedTask[]),
        ]);

        const always_load = db.dedupeTasksById(alwaysLoadItems);
        const alwaysLoadIds = new Set(always_load.map((item) => item.id));

        const profile_context = db.dedupeTasksById(profileItems).filter(
          (item) => !alwaysLoadIds.has(item.id)
        );
        const profileIds = new Set(profile_context.map((item) => item.id));

        const active_objectives = db.dedupeTasksById(activeObjectives).filter(
          (item) => !alwaysLoadIds.has(item.id) && !profileIds.has(item.id)
        );
        const objectiveIds = new Set(active_objectives.map((item) => item.id));

        const pinned_context = db.dedupeTasksById(pinnedItems).filter(
          (item) => !alwaysLoadIds.has(item.id) && !profileIds.has(item.id) && !objectiveIds.has(item.id)
        );

        const current_focus = sections.focus
          ? serializeFocusContext(await db.getFocusContext(env.DB))
          : null;

        const topics = args.topics ?? [];
        const recent_summaries = sections.summaries
          ? await Promise.all(
              topics.map(async (topic) => {
                const scope = topic.toLowerCase();
                const items = db.dedupeTasksById(
                  await db.loadContextItems(env.DB, {
                    tags: [scope],
                    startup_priority_min: relevantThreshold,
                    current_only: true,
                    include_history: false,
                    limit: 50,
                  })
                );
                return { scope, summary: db.buildContextSummary(scope, items) };
              })
            )
          : [];

        const seenForHistory = new Set([
          ...alwaysLoadIds,
          ...profileIds,
          ...objectiveIds,
          ...pinned_context.map((item) => item.id),
        ]);
        const historical_background = sections.history
          ? db.dedupeTasksById(
              await db.loadContextItems(env.DB, {
                startup_priority_min: 3,
                startup_priority_max: 3,
                include_history: true,
                limit: 20,
              })
            ).filter((item) => !seenForHistory.has(item.id))
          : [];

        const allStartupItems = [
          ...always_load,
          ...profile_context,
          ...active_objectives,
          ...pinned_context,
          ...historical_background,
        ];
        const superseding = await db.getSupersedingRelationships(
          env.DB,
          allStartupItems.map((item) => item.id)
        );

        const generated_at = new Date().toISOString();
        const bundle = {
          mode,
          always_load: serializeTasksWithHistory(always_load, superseding),
          profile_context: serializeTasksWithHistory(profile_context, superseding),
          active_objectives: serializeTasksWithHistory(active_objectives, superseding),
          active_projects,
          pinned_context: serializeTasksWithHistory(pinned_context, superseding),
          current_focus,
          historical_background: serializeTasksWithHistory(historical_background, superseding),
          recent_summaries,
          context_version: db.computeContextVersion(allStartupItems),
          last_consolidated: db.computeLastConsolidated(profile_context),
          generated_at,
        };

        if (useCache) {
          await setCachedStartupContext(env.APP_KV, bundle);
        }

        return ok({ source: "d1", ...bundle });
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
