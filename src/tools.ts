import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./db.js";
import { PRIORITY_VALUES, PRIORITY_NAMES, type PriorityLevel } from "./db.js";

const prioritySchema = z.enum(["low", "medium", "high"]).describe("Priority level");
const priorityArraySchema = z.array(z.enum(["low", "medium", "high"])).optional();

function toPriority(p?: string): PriorityLevel | undefined {
  if (!p) return undefined;
  return PRIORITY_VALUES[p] as PriorityLevel | undefined;
}

function serializeTask(t: db.Task) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    completed: t.completed === 1,
    priority: PRIORITY_NAMES[t.priority as PriorityLevel] ?? "low",
    priority_level: t.priority,
    due_date: t.due_date,
    completed_at: t.completed_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function serializeEnrichedTask(t: db.EnrichedTask) {
  return {
    ...serializeTask(t),
    groups: t.groups.map(g => ({ name: g.name, slug: g.slug })),
    tags: t.tags.map(tg => ({ name: tg.name, slug: tg.slug })),
  };
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: typeof data === "object" && data !== null && !Array.isArray(data) ? data : { result: data },
  };
}

function err(msg: string) {
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true,
  };
}

export function registerTools(server: McpServer, env: Env) {

  // ── Task CRUD ──

  server.tool(
    "create_task",
    "Create a new todo task",
    {
      name: z.string().describe("Task name"),
      slug: z.string().describe("Unique identifier (URL-safe)"),
      description: z.string().optional().describe("Task description"),
      priority: prioritySchema.optional(),
      due_date: z.string().optional().describe("Due date in ISO 8601 format"),
      groups: z.array(z.string()).optional().describe("Group slugs to assign"),
      tags: z.array(z.string()).optional().describe("Tag slugs to assign"),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const task = await db.createTask(env.DB, {
          name: args.name, slug: args.slug,
          description: args.description,
          priority: toPriority(args.priority),
          due_date: args.due_date,
        });
        if (args.groups) {
          for (const g of args.groups) await db.assignTaskToGroup(env.DB, task.id, g);
        }
        if (args.tags) {
          for (const t of args.tags) await db.addTagToTask(env.DB, task.id, t);
        }
        const enriched = await db.enrichTask(env.DB, task);
        return ok(serializeEnrichedTask(enriched));
      } catch (e: unknown) {
        return err(`Failed to create task: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "get_task",
    "Get a task by slug with groups and tags",
    { slug: z.string() },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const task = await db.getTask(env.DB, args.slug);
      if (!task) return err(`Task '${args.slug}' not found`);
      const enriched = await db.enrichTask(env.DB, task);
      return ok(serializeEnrichedTask(enriched));
    }
  );

  server.tool(
    "update_task",
    "Update an existing task",
    {
      slug: z.string().describe("Task slug to update"),
      name: z.string().optional(),
      description: z.string().optional(),
      priority: prioritySchema.optional(),
      due_date: z.string().optional().describe("New due date (ISO 8601)"),
      completed: z.boolean().optional().describe("Mark as completed/incomplete"),
      add_groups: z.array(z.string()).optional().describe("Group slugs to add"),
      remove_groups: z.array(z.string()).optional().describe("Group slugs to remove"),
      add_tags: z.array(z.string()).optional().describe("Tag slugs to add"),
      remove_tags: z.array(z.string()).optional().describe("Tag slugs to remove"),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const task = await db.updateTask(env.DB, args.slug, {
        name: args.name,
        description: args.description,
        priority: toPriority(args.priority),
        due_date: args.due_date,
        completed: args.completed,
      });
      if (!task) return err(`Task '${args.slug}' not found`);

      if (args.add_groups) for (const g of args.add_groups) await db.assignTaskToGroup(env.DB, task.id, g);
      if (args.remove_groups) for (const g of args.remove_groups) await db.removeTaskFromGroup(env.DB, task.id, g);
      if (args.add_tags) for (const t of args.add_tags) await db.addTagToTask(env.DB, task.id, t);
      if (args.remove_tags) for (const t of args.remove_tags) await db.removeTagFromTask(env.DB, task.id, t);

      const enriched = await db.enrichTask(env.DB, task);
      return ok(serializeEnrichedTask(enriched));
    }
  );

  server.tool(
    "delete_task",
    "Delete a task by slug",
    { slug: z.string() },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      const task = await db.deleteTask(env.DB, args.slug);
      if (!task) return err(`Task '${args.slug}' not found`);
      return ok(serializeTask(task));
    }
  );

  // ── Search & Query ──

  server.tool(
    "search_tasks",
    "Full-text search + filter tasks (FTS5 on name+description)",
    {
      q: z.string().optional().describe("Search query (name/description)"),
      completed: z.boolean().optional(),
      priority: priorityArraySchema,
      due_from: z.string().optional().describe("Due date range start (ISO 8601)"),
      due_to: z.string().optional().describe("Due date range end (ISO 8601)"),
      groups: z.array(z.string()).optional().describe("Filter by group slugs"),
      tags: z.array(z.string()).optional().describe("Filter by tag slugs"),
      sort: z.enum(["due_date", "-due_date", "priority", "-priority", "created_at", "-created_at"]).optional(),
      page: z.number().optional().describe("Page number (0-indexed)"),
      per_page: z.number().optional().describe("Results per page (max 100)"),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const result = await db.searchTasks(env.DB, {
        q: args.q,
        completed: args.completed,
        priority: args.priority?.map(p => PRIORITY_VALUES[p] as PriorityLevel) as PriorityLevel[] | undefined,
        due_from: args.due_from,
        due_to: args.due_to,
        group_slugs: args.groups,
        tag_slugs: args.tags,
        sort: args.sort,
        page: args.page,
        per_page: args.per_page,
      });
      const enriched = await db.enrichTasks(env.DB, result.tasks);
      return ok({
        tasks: enriched.map(serializeEnrichedTask),
        total: result.total,
        page: result.page,
        per_page: result.per_page,
      });
    }
  );

  // ── Smart Queries ──

  server.tool(
    "get_overdue_tasks",
    "Get all tasks that are past their due date and not completed",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => {
      const tasks = await db.getOverdueTasks(env.DB);
      const enriched = await db.enrichTasks(env.DB, tasks);
      return ok({ tasks: enriched.map(serializeEnrichedTask), count: enriched.length });
    }
  );

  server.tool(
    "get_today_tasks",
    "Get tasks due today that are not completed",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => {
      const tasks = await db.getTodayTasks(env.DB);
      const enriched = await db.enrichTasks(env.DB, tasks);
      return ok({ tasks: enriched.map(serializeEnrichedTask), count: enriched.length });
    }
  );

  server.tool(
    "get_upcoming_tasks",
    "Get tasks due within the next N days",
    { days: z.number().optional().describe("Number of days (default 7)") },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const tasks = await db.getUpcomingTasks(env.DB, args.days ?? 7);
      const enriched = await db.enrichTasks(env.DB, tasks);
      return ok({ tasks: enriched.map(serializeEnrichedTask), count: enriched.length });
    }
  );

  server.tool(
    "get_focus_tasks",
    "Get top N tasks to focus on (sorted by priority then due date)",
    { limit: z.number().optional().describe("Number of tasks (default 3)") },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const tasks = await db.getFocusTasks(env.DB, args.limit ?? 3);
      const enriched = await db.enrichTasks(env.DB, tasks);
      return ok({ tasks: enriched.map(serializeEnrichedTask), count: enriched.length });
    }
  );

  server.tool(
    "plan_day",
    "Get a prioritized list of tasks for a specific date",
    {
      date: z.string().describe("Date to plan for (YYYY-MM-DD)"),
      limit: z.number().optional().describe("Max tasks (default 10)"),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      // Get tasks for the date, plus overdue tasks
      const now = new Date().toISOString();
      const dateEnd = args.date + "T23:59:59Z";
      const dateStart = args.date + "T00:00:00Z";

      const result = await db.searchTasks(env.DB, {
        completed: false,
        due_to: dateEnd,
        sort: "priority",
        per_page: args.limit ?? 10,
      });

      // Also get overdue tasks (due before today)
      const overdue = await db.getOverdueTasks(env.DB);
      const dueToday = result.tasks.filter(t => t.due_date && t.due_date >= dateStart && t.due_date <= dateEnd);

      // Combine: overdue first (sorted by due_date), then today's (sorted by priority)
      const combined = [...overdue, ...dueToday];
      // Deduplicate by id
      const seen = new Set<number>();
      const deduped = combined.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
      const limited = deduped.slice(0, args.limit ?? 10);
      const enriched = await db.enrichTasks(env.DB, limited);

      return ok({
        date: args.date,
        overdue_count: overdue.length,
        tasks: enriched.map(serializeEnrichedTask),
        count: enriched.length,
      });
    }
  );

  // ── Bulk Operations ──

  server.tool(
    "bulk_update_tasks",
    "Update multiple tasks at once",
    {
      ids: z.array(z.number()).describe("Task IDs to update"),
      completed: z.boolean().optional(),
      priority: prioritySchema.optional(),
      due_date: z.string().optional().describe("New due date for all (ISO 8601)"),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const count = await db.bulkUpdateTasks(env.DB, args.ids, {
        completed: args.completed,
        priority: toPriority(args.priority),
        due_date: args.due_date,
      });
      return ok({ updated: count });
    }
  );

  server.tool(
    "bulk_delete_tasks",
    "Delete multiple tasks by ID",
    { ids: z.array(z.number()).describe("Task IDs to delete") },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      const count = await db.bulkDeleteTasks(env.DB, args.ids);
      return ok({ deleted: count });
    }
  );

  // ── Groups ──

  server.tool(
    "list_groups",
    "List all groups",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => {
      const groups = await db.listGroups(env.DB);
      return ok({ groups: groups.map(g => ({ name: g.name, slug: g.slug, description: g.description })) });
    }
  );

  server.tool(
    "create_group",
    "Create a new group (project/area)",
    {
      name: z.string(),
      slug: z.string().describe("Unique slug"),
      description: z.string().optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const group = await db.createGroup(env.DB, { name: args.name, slug: args.slug, description: args.description });
        return ok({ name: group.name, slug: group.slug, description: group.description });
      } catch (e: unknown) {
        return err(`Failed to create group: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "delete_group",
    "Delete a group by slug (removes all task associations)",
    { slug: z.string() },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      const deleted = await db.deleteGroup(env.DB, args.slug);
      return deleted ? ok({ deleted: true }) : err(`Group '${args.slug}' not found`);
    }
  );

  // ── Tags ──

  server.tool(
    "list_tags",
    "List all tags",
    {},
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async () => {
      const tags = await db.listTags(env.DB);
      return ok({ tags: tags.map(t => ({ name: t.name, slug: t.slug })) });
    }
  );

  server.tool(
    "create_tag",
    "Create a new tag",
    { name: z.string(), slug: z.string().describe("Unique slug") },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      try {
        const tag = await db.createTag(env.DB, { name: args.name, slug: args.slug });
        return ok({ name: tag.name, slug: tag.slug });
      } catch (e: unknown) {
        return err(`Failed to create tag: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "delete_tag",
    "Delete a tag by slug",
    { slug: z.string() },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    async (args) => {
      const deleted = await db.deleteTag(env.DB, args.slug);
      return deleted ? ok({ deleted: true }) : err(`Tag '${args.slug}' not found`);
    }
  );

  // ── Quick Add ──

  server.tool(
    "quick_add_task",
    "Create a task with minimal input (auto-generates slug from name)",
    {
      name: z.string().describe("Task name"),
      due_date: z.string().optional().describe("Due date (ISO 8601)"),
      priority: prioritySchema.optional(),
    },
    { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const slug = args.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
      const uniqueSlug = `${slug}-${Date.now().toString(36)}`;
      try {
        const task = await db.createTask(env.DB, {
          name: args.name, slug: uniqueSlug,
          priority: toPriority(args.priority),
          due_date: args.due_date,
        });
        const enriched = await db.enrichTask(env.DB, task);
        return ok(serializeEnrichedTask(enriched));
      } catch (e: unknown) {
        return err(`Failed to create task: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ── Activity Log ──

  server.tool(
    "get_task_log",
    "Get activity history for a task",
    {
      slug: z.string().describe("Task slug"),
      limit: z.number().optional().describe("Max entries (default 50)"),
    },
    { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    async (args) => {
      const task = await db.getTask(env.DB, args.slug);
      if (!task) return err(`Task '${args.slug}' not found`);
      const logs = await db.getTaskLogs(env.DB, task.id, args.limit ?? 50);
      return ok({ slug: args.slug, logs });
    }
  );
}
