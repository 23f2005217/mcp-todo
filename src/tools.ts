import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./db.js";
import { parseDueDate } from "./due.js";
import { getAppSettings, updateAppSettings } from "./settings.js";
import { deleteTaskVector, semanticSearchTaskIds, upsertTaskVectors } from "./vectorize.js";

const ACTIVE_FOCUS_KEY = "focus:active";
const ACTIVE_FOCUS_TTL_SECONDS = 120;

const itemKindSchema = z.enum(["task", "memory"]);
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
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent:
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? data
        : { result: data },
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function toPriority(value?: string): db.PriorityLevel {
  return db.PRIORITY_VALUES[value ?? "medium"] ?? 2;
}

function serializeTask(task: db.EnrichedTask) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    raw_input: task.raw_input,
    item_kind: task.item_kind,
    completed: task.completed === 1,
    priority: db.PRIORITY_NAMES[(task.priority as db.PriorityLevel) ?? 2] ?? "medium",
    priority_level: task.priority,
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
    created_at: task.created_at,
    updated_at: task.updated_at,
    project: task.project,
    group: task.group,
    tags: task.tags,
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
  if (!task || task.completed || task.item_kind !== "task" || task.archived_at) return null;

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
  if (task.completed === 1 || task.archived_at) {
    try {
      await deleteTaskVector(env, task.id);
    } catch {
      // D1 remains source of truth if vector sync fails.
    }
    return;
  }

  await upsertTaskVectors(env, [task]);
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
    async (args) => ok(await updateAppSettings(env.APP_KV, args))
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
      priority: prioritySchema.optional(),
      due: z.string().optional().describe("Human due date text or ISO timestamp"),
      project_slug: z.string().optional(),
      project_name: z.string().optional(),
      group_slug: z.string().optional(),
      group_name: z.string().optional(),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
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
          priority: toPriority(args.priority ?? settings.default_quick_add_priority),
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
          due_at: parsedDue.due_at,
          due_text: parsedDue.normalized,
          project: parsed.projectSlug ? { slug: parsed.projectSlug, name: parsed.projectSlug } : null,
          group: parsed.groupSlug ? { slug: parsed.groupSlug, name: parsed.groupSlug } : null,
          tags: normalizeTags(parsed.tags),
        });

        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, task);
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
        });
        await syncVectorForTask(env, task);
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
      completed: z.boolean().optional(),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      priority: z.array(prioritySchema).optional(),
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
          completed: args.completed,
          archived: args.archived,
          pinned: args.pinned,
          priority: args.priority?.map((value) => toPriority(value)),
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
    "update_item",
    "Update item metadata, tags, due date, recurrence, project/group assignment, or archive state",
    {
      id: z.number().int().positive(),
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      raw_input: z.string().nullable().optional(),
      item_kind: itemKindSchema.optional(),
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
          recurrence_kind: args.recurrence_kind === undefined ? undefined : args.recurrence_kind,
          recurrence_interval: args.recurrence_interval === undefined ? undefined : args.recurrence_interval,
          recurrence_until: args.recurrence_until === undefined ? undefined : args.recurrence_until,
          clear_recurrence: args.clear_recurrence,
        });

        if (!task) return err(`Item '${args.id}' not found`);
        await clearActiveFocus(env.APP_KV);
        await syncVectorForTask(env, task);
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
        return ok({ deleted, ids: args.ids });
      } catch (error: unknown) {
        return err(`Failed to delete items: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    "get_focus_task",
    "Return the single best task to focus next",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => {
      try {
        const cached = await getCachedFocusTask(env);
        if (cached) return ok({ item: serializeTask(cached), source: "kv_cache" });

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
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const matches = await semanticSearchTaskIds(env, args.query, 5);
        const hydrated = await db.enrichTasks(
          env.DB,
          await db.getTasksByIds(env.DB, matches.map((match) => match.taskId))
        );
        const byId = new Map(hydrated.map((task) => [task.id, task]));
        const filtered = matches.flatMap((match) => {
          const task = byId.get(match.taskId);
          if (!task) return [];
          if (args.kinds && !args.kinds.includes(task.item_kind)) return [];
          return [{ score: match.score, item: serializeTask(task) }];
        });
        return ok({ query: args.query, matches: filtered, count: filtered.length });
      } catch (error: unknown) {
        return err(`Failed to semantic-search items: ${error instanceof Error ? error.message : String(error)}`);
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
    async (args) => ok({ project: await db.upsertProject(env.DB, args) })
  );

  server.tool(
    "delete_project",
    "Delete a project by slug",
    { slug: z.string().min(1) },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => ok({ deleted: await db.deleteProject(env.DB, args.slug.toLowerCase()) })
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
    async (args) => ok({ group: await db.upsertGroup(env.DB, args) })
  );

  server.tool(
    "delete_group",
    "Delete a group by slug",
    { slug: z.string().min(1) },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => ok({ deleted: await db.deleteGroup(env.DB, args.slug.toLowerCase()) })
  );

  server.tool(
    "list_tags",
    "List all tags",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => ok({ tags: await db.listTags(env.DB) })
  );
}
