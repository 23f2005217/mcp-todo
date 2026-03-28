// db.ts — D1 helper utilities

export interface Task {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  completed: number;
  priority: number;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
}

export interface Tag {
  id: number;
  name: string;
  slug: string;
  created_at: string;
}

export type PriorityLevel = 1 | 2 | 3;
export const PRIORITY_NAMES: Record<PriorityLevel, string> = { 1: "low", 2: "medium", 3: "high" };
export const PRIORITY_VALUES: Record<string, PriorityLevel> = { low: 1, medium: 2, high: 3 };

function row<T>(r: Record<string, unknown> | null): T | null {
  if (!r) return null;
  return r as unknown as T;
}

function rows<T>(r: Record<string, unknown>[]): T[] {
  return r as unknown as T[];
}

// ── Tasks ──

export async function getTask(db: D1Database, slug: string): Promise<Task | null> {
  return row<Task>(await db.prepare("SELECT * FROM todos WHERE slug = ?").bind(slug).first());
}

export async function getTaskById(db: D1Database, id: number): Promise<Task | null> {
  return row<Task>(await db.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first());
}

export async function getTaskGroups(db: D1Database, taskId: number): Promise<Group[]> {
  return rows<Group>(
    await db.prepare(
      "SELECT g.* FROM groups g JOIN task_groups tg ON tg.group_id = g.id WHERE tg.task_id = ?"
    ).bind(taskId).all().then(r => r.results as Record<string, unknown>[])
  );
}

export async function getTaskTags(db: D1Database, taskId: number): Promise<Tag[]> {
  return rows<Tag>(
    await db.prepare(
      "SELECT t.* FROM tags t JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_id = ?"
    ).bind(taskId).all().then(r => r.results as Record<string, unknown>[])
  );
}

export async function createTask(
  db: D1Database,
  data: { name: string; slug: string; description?: string; priority?: PriorityLevel; due_date?: string }
): Promise<Task> {
  const now = new Date().toISOString();
  const priority = data.priority ?? 1;
  await db.prepare(
    "INSERT INTO todos (name, slug, description, priority, completed, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)"
  ).bind(data.name, data.slug, data.description ?? null, priority, data.due_date ?? null, now, now).run();
  const task = await getTask(db, data.slug);
  if (task) await logAction(db, task.id, "create", { name: task.name });
  return task!;
}

export async function updateTask(
  db: D1Database,
  slug: string,
  changes: Partial<Pick<Task, "name" | "description" | "priority" | "due_date" | "completed">>
): Promise<Task | null> {
  const task = await getTask(db, slug);
  if (!task) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (changes.name !== undefined) { sets.push("name = ?"); params.push(changes.name); }
  if (changes.description !== undefined) { sets.push("description = ?"); params.push(changes.description); }
  if (changes.priority !== undefined) { sets.push("priority = ?"); params.push(changes.priority); }
  if (changes.due_date !== undefined) { sets.push("due_date = ?"); params.push(changes.due_date); }
  if (changes.completed !== undefined) {
    sets.push("completed = ?");
    params.push(changes.completed);
    sets.push("completed_at = ?");
    params.push(changes.completed ? new Date().toISOString() : null);
  }

  if (sets.length === 0) return task;

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(slug);

  await db.prepare(`UPDATE todos SET ${sets.join(", ")} WHERE slug = ?`).bind(...params).run();
  await logAction(db, task.id, "update", changes);
  return getTask(db, slug);
}

export async function deleteTask(db: D1Database, slug: string): Promise<Task | null> {
  const task = await getTask(db, slug);
  if (!task) return null;
  await db.prepare("DELETE FROM todos WHERE slug = ?").bind(slug).run();
  await logAction(db, task.id, "delete", { slug });
  return task;
}

// ── Search / Query ──

export interface TaskQuery {
  q?: string;
  completed?: boolean;
  priority?: PriorityLevel[];
  due_from?: string;
  due_to?: string;
  group_slugs?: string[];
  tag_slugs?: string[];
  sort?: "due_date" | "priority" | "created_at" | "-due_date" | "-priority" | "-created_at";
  page?: number;
  per_page?: number;
}

export async function searchTasks(db: D1Database, query: TaskQuery) {
  const limit = Math.min(query.per_page ?? 20, 100);
  const offset = (query.page ?? 0) * limit;
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.q) {
    // FTS5 search: match against name+description
    where.push("t.id IN (SELECT rowid FROM todos_fts WHERE todos_fts MATCH ?)");
    params.push(query.q);
  }

  if (typeof query.completed === "boolean") {
    where.push("t.completed = ?");
    params.push(query.completed ? 1 : 0);
  }

  if (query.priority && query.priority.length > 0) {
    where.push(`t.priority IN (${query.priority.map(() => "?").join(",")})`);
    params.push(...query.priority);
  }

  if (query.due_from) {
    where.push("t.due_date >= ?");
    params.push(query.due_from);
  }

  if (query.due_to) {
    where.push("t.due_date <= ?");
    params.push(query.due_to);
  }

  if (query.group_slugs && query.group_slugs.length > 0) {
    const placeholders = query.group_slugs.map(() => "?").join(",");
    where.push(`t.id IN (SELECT tg.task_id FROM task_groups tg JOIN groups g ON g.id = tg.group_id WHERE g.slug IN (${placeholders}))`);
    params.push(...query.group_slugs);
  }

  if (query.tag_slugs && query.tag_slugs.length > 0) {
    const placeholders = query.tag_slugs.map(() => "?").join(",");
    where.push(`t.id IN (SELECT tt.task_id FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tg.slug IN (${placeholders}))`);
    params.push(...query.tag_slugs);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  let orderClause = "ORDER BY t.created_at DESC";
  if (query.sort) {
    const desc = query.sort.startsWith("-");
    const col = query.sort.replace("-", "");
    if (["due_date", "priority", "created_at"].includes(col)) {
      orderClause = `ORDER BY t.${col} ${desc ? "DESC" : "ASC"}`;
    }
  }

  const countSql = `SELECT COUNT(*) as total FROM todos t ${whereClause}`;
  const countResult = await db.prepare(countSql).bind(...params).first() as { total: number } | null;
  const total = countResult?.total ?? 0;

  const sql = `SELECT t.* FROM todos t ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
  const tasks = rows<Task>(await db.prepare(sql).bind(...params, limit, offset).all().then(r => r.results as Record<string, unknown>[]));

  return { tasks, total, page: query.page ?? 0, per_page: limit };
}

// ── Bulk Operations ──

export async function bulkUpdateTasks(
  db: D1Database,
  ids: number[],
  changes: { completed?: boolean; priority?: PriorityLevel; due_date?: string }
): Promise<number> {
  if (ids.length === 0) return 0;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (changes.completed !== undefined) {
    sets.push("completed = ?");
    params.push(changes.completed ? 1 : 0);
    sets.push("completed_at = ?");
    params.push(changes.completed ? new Date().toISOString() : null);
  }

  if (changes.priority !== undefined) {
    sets.push("priority = ?");
    params.push(changes.priority);
  }

  if (changes.due_date !== undefined) {
    sets.push("due_date = ?");
    params.push(changes.due_date);
  }

  if (sets.length === 0) return 0;

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());

  const placeholders = ids.map(() => "?").join(",");
  const sql = `UPDATE todos SET ${sets.join(", ")} WHERE id IN (${placeholders})`;
  await db.prepare(sql).bind(...params, ...ids).run();

  for (const id of ids) {
    await logAction(db, id, "bulk_update", changes);
  }

  return ids.length;
}

export async function bulkDeleteTasks(db: D1Database, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`DELETE FROM todos WHERE id IN (${placeholders})`).bind(...ids).run();
  for (const id of ids) {
    await logAction(db, id, "bulk_delete", {});
  }
  return result.meta.changes;
}

// ── Groups ──

export async function getGroup(db: D1Database, slug: string): Promise<Group | null> {
  return row<Group>(await db.prepare("SELECT * FROM groups WHERE slug = ?").bind(slug).first());
}

export async function createGroup(db: D1Database, data: { name: string; slug: string; description?: string }): Promise<Group> {
  await db.prepare("INSERT INTO groups (name, slug, description) VALUES (?, ?, ?)").bind(data.name, data.slug, data.description ?? null).run();
  return (await getGroup(db, data.slug))!;
}

export async function listGroups(db: D1Database): Promise<Group[]> {
  return rows<Group>(await db.prepare("SELECT * FROM groups ORDER BY name").all().then(r => r.results as Record<string, unknown>[]));
}

export async function deleteGroup(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM groups WHERE slug = ?").bind(slug).run();
  return result.meta.changes > 0;
}

export async function assignTaskToGroup(db: D1Database, taskId: number, groupSlug: string): Promise<boolean> {
  const group = await getGroup(db, groupSlug);
  if (!group) return false;
  await db.prepare("INSERT OR IGNORE INTO task_groups (task_id, group_id) VALUES (?, ?)").bind(taskId, group.id).run();
  return true;
}

export async function removeTaskFromGroup(db: D1Database, taskId: number, groupSlug: string): Promise<boolean> {
  const group = await getGroup(db, groupSlug);
  if (!group) return false;
  await db.prepare("DELETE FROM task_groups WHERE task_id = ? AND group_id = ?").bind(taskId, group.id).run();
  return true;
}

// ── Tags ──

export async function getTag(db: D1Database, slug: string): Promise<Tag | null> {
  return row<Tag>(await db.prepare("SELECT * FROM tags WHERE slug = ?").bind(slug).first());
}

export async function createTag(db: D1Database, data: { name: string; slug: string }): Promise<Tag> {
  await db.prepare("INSERT INTO tags (name, slug) VALUES (?, ?)").bind(data.name, data.slug).run();
  return (await getTag(db, data.slug))!;
}

export async function listTags(db: D1Database): Promise<Tag[]> {
  return rows<Tag>(await db.prepare("SELECT * FROM tags ORDER BY name").all().then(r => r.results as Record<string, unknown>[]));
}

export async function deleteTag(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM tags WHERE slug = ?").bind(slug).run();
  return result.meta.changes > 0;
}

export async function addTagToTask(db: D1Database, taskId: number, tagSlug: string): Promise<boolean> {
  const tag = await getTag(db, tagSlug);
  if (!tag) return false;
  await db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)").bind(taskId, tag.id).run();
  return true;
}

export async function removeTagFromTask(db: D1Database, taskId: number, tagSlug: string): Promise<boolean> {
  const tag = await getTag(db, tagSlug);
  if (!tag) return false;
  await db.prepare("DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?").bind(taskId, tag.id).run();
  return true;
}

// ── Smart Queries ──

export async function getOverdueTasks(db: D1Database): Promise<Task[]> {
  const now = new Date().toISOString();
  return rows<Task>(
    await db.prepare("SELECT * FROM todos WHERE due_date < ? AND completed = 0 ORDER BY due_date ASC")
      .bind(now).all().then(r => r.results as Record<string, unknown>[])
  );
}

export async function getTodayTasks(db: D1Database): Promise<Task[]> {
  const today = new Date().toISOString().slice(0, 10);
  return rows<Task>(
    await db.prepare("SELECT * FROM todos WHERE date(due_date) = ? AND completed = 0 ORDER BY priority DESC, due_date ASC")
      .bind(today).all().then(r => r.results as Record<string, unknown>[])
  );
}

export async function getUpcomingTasks(db: D1Database, days: number = 7): Promise<Task[]> {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + days * 86400000).toISOString();
  return rows<Task>(
    await db.prepare("SELECT * FROM todos WHERE due_date BETWEEN ? AND ? AND completed = 0 ORDER BY due_date ASC")
      .bind(now, future).all().then(r => r.results as Record<string, unknown>[])
  );
}

export async function getHighPriorityTasks(db: D1Database): Promise<Task[]> {
  return rows<Task>(
    await db.prepare("SELECT * FROM todos WHERE priority = 3 AND completed = 0 ORDER BY due_date ASC")
      .all().then(r => r.results as Record<string, unknown>[])
  );
}

export async function getFocusTasks(db: D1Database, limit: number = 3): Promise<Task[]> {
  return rows<Task>(
    await db.prepare("SELECT * FROM todos WHERE completed = 0 ORDER BY priority DESC, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC LIMIT ?")
      .bind(limit).all().then(r => r.results as Record<string, unknown>[])
  );
}

// ── Task Logs ──

export async function logAction(db: D1Database, taskId: number, action: string, metadata: Record<string, unknown>): Promise<void> {
  await db.prepare("INSERT INTO task_logs (task_id, action, metadata) VALUES (?, ?, ?)")
    .bind(taskId, action, JSON.stringify(metadata)).run();
}

export async function getTaskLogs(db: D1Database, taskId: number, limit: number = 50): Promise<Record<string, unknown>[]> {
  return await db.prepare("SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(taskId, limit).all().then(r => r.results as Record<string, unknown>[]);
}

// ── Enriched task (with groups + tags) ──

export interface EnrichedTask extends Task {
  groups: Group[];
  tags: Tag[];
}

export async function enrichTask(db: D1Database, task: Task): Promise<EnrichedTask> {
  const [groups, tags] = await Promise.all([getTaskGroups(db, task.id), getTaskTags(db, task.id)]);
  return { ...task, groups, tags };
}

export async function enrichTasks(db: D1Database, tasks: Task[]): Promise<EnrichedTask[]> {
  return Promise.all(tasks.map(t => enrichTask(db, t)));
}
