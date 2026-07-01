import { describe, it } from "node:test";
import assert from "node:assert";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

interface CapturedTool {
  name: string;
  description: string;
  paramsShape: unknown;
  options: { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createMockDb(results: Record<string, unknown>[] = []): {
  db: D1Database;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];

  const createStatement = (sql: string, bound: unknown[] = []): D1PreparedStatement => {
    return {
      bind(...values: unknown[]): D1PreparedStatement {
        return createStatement(sql, [...bound, ...values]);
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        queries.push({ sql, params: bound });
        return { results: results as T[], success: true, meta: {} } as D1Result<T>;
      },
      async first<T = unknown>(): Promise<T | null> {
        queries.push({ sql, params: bound });
        return (results[0] as T) ?? null;
      },
      async run(): Promise<D1Result> {
        queries.push({ sql, params: bound });
        return { success: true, meta: { changes: 0, last_row_id: 0 } } as D1Result;
      },
      async raw<T = unknown>(): Promise<T[]> {
        queries.push({ sql, params: bound });
        return [] as T[];
      },
    } as unknown as D1PreparedStatement;
  };

  const db = {
    prepare(query: string): D1PreparedStatement {
      return createStatement(query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return Promise.all(statements.map((statement) => statement.all<T>()));
    },
    async exec(query: string): Promise<D1ExecResult> {
      return { count: 0, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    withSession(): D1Database {
      return db;
    },
  } as unknown as D1Database;

  return { db, queries };
}

function createMockKv(initial: Map<string, string> = new Map()): {
  kv: KVNamespace;
  stored: Map<string, { value: string; options?: KVNamespacePutOptions }>;
} {
  const stored = new Map<string, { value: string; options?: KVNamespacePutOptions }>();
  for (const [key, value] of initial) {
    stored.set(key, { value });
  }
  const kv = {
    async get<T = unknown>(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<T | null> {
      const record = stored.get(key);
      if (!record) return null;
      if (type === "json") {
        return JSON.parse(record.value) as T;
      }
      return record.value as unknown as T;
    },
    async put(key: string, value: string | ReadableStream | ArrayBuffer | ArrayBufferView, options?: KVNamespacePutOptions): Promise<void> {
      stored.set(key, { value: String(value), options });
    },
    async delete(key: string): Promise<void> {
      stored.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor: string }> {
      return { keys: [], list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
  return { kv, stored };
}

function createMockServer(): {
  server: McpServer;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool(
      name: string,
      description: string,
      paramsShape: unknown,
      options: { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean },
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      tools.set(name, { name, description, paramsShape, options, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

function okResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}

async function invokeTool(
  tools: Map<string, CapturedTool>,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} not registered`);
  const result = await tool.handler(args);
  assert.ok(result && typeof result === "object", "expected tool result object");
  return result as Record<string, unknown>;
}

function resultData(result: Record<string, unknown>): unknown {
  return result.structuredContent;
}

describe("get_context_summary tool", () => {
  it("is registered as read-only", () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);
    const tool = tools.get("get_context_summary");
    assert.ok(tool);
    assert.strictEqual(tool.options.readOnlyHint, true);
    assert.strictEqual(tool.options.openWorldHint, false);
    assert.strictEqual(tool.options.destructiveHint, false);
  });

  it("returns cached summary when KV cache hit occurs", async () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv(new Map([["context:summary:work", JSON.stringify({ total: 42 })]]));
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_context_summary", { scope: "work" });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.scope, "work");
    assert.strictEqual(data.source, "kv_cache");
    assert.deepStrictEqual(data.summary, { total: 42 });
  });

  it("builds deterministic summary from D1 and writes KV cache", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv, stored } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_context_summary", { scope: "Health" });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.scope, "health");
    assert.strictEqual(data.source, "d1");
    const summary = data.summary as Record<string, unknown>;
    assert.strictEqual(summary.total, 0);
    assert.strictEqual(summary.scope, "health");

    const loadQuery = queries.find((q) => q.sql.includes("FROM todos t"));
    assert.ok(loadQuery);
    assert.ok(loadQuery.params.includes("health"));

    const cached = stored.get("context:summary:health");
    assert.ok(cached);
    assert.strictEqual(JSON.parse(cached.value).total, 0);
  });

  it("uses topic as scope alias when scope is omitted", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_context_summary", { topic: "Home" });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.scope, "home");
    const loadQuery = queries.find((q) => q.sql.includes("FROM todos t"));
    assert.ok(loadQuery?.params.includes("home"));
  });

  it("falls back to project_slug when scope and topic are omitted", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_context_summary", { project_slug: "My-Project" });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.scope, "my-project");
    const loadQuery = queries.find((q) => q.sql.includes("FROM todos t"));
    assert.ok(loadQuery?.params.includes("my-project"));
  });

  it("adds project_slugs filter when project_slug is provided", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    await invokeTool(tools, "get_context_summary", { scope: "work", project_slug: "acme" });
    const loadQuery = queries.find((q) => q.sql.includes("FROM todos t"));
    assert.ok(loadQuery);
    assert.ok(loadQuery.params.includes("work"));
    assert.ok(loadQuery.params.includes("acme"));
    assert.ok(loadQuery.sql.includes("projects WHERE slug"));
  });

  it("skips cache when use_cache is false", async () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv, stored } = createMockKv(new Map([["context:summary:work", JSON.stringify({ total: 99 })]]));
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_context_summary", { scope: "work", use_cache: false });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.source, "d1");
    assert.strictEqual((data.summary as Record<string, unknown>).total, 0);
    // With use_cache=false the existing cached value is left untouched; only behavior verified above.
  });

  it("returns error when no scope is provided", async () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_context_summary", {});
    assert.strictEqual(result.isError, true);
  });
});

describe("get_startup_context tool", () => {
  it("is registered as read-only", () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);
    const tool = tools.get("get_startup_context");
    assert.ok(tool);
    assert.strictEqual(tool.options.readOnlyHint, true);
    assert.strictEqual(tool.options.openWorldHint, false);
    assert.strictEqual(tool.options.destructiveHint, false);
  });

  it("returns cached bundle when KV cache hit occurs", async () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv(new Map([["context:startup", JSON.stringify({ active_projects: [{ slug: "cached" }] })]]));
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_startup_context", {});
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.source, "kv_cache");
    assert.deepStrictEqual(data.active_projects, [{ slug: "cached" }]);
  });

  it("builds bundle from D1 helpers and caches it", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv, stored } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_startup_context", {});
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.source, "d1");
    assert.strictEqual(data.mode, "normal");
    assert.ok(data.current_focus && typeof data.current_focus === "object");
    assert.ok(Array.isArray(data.always_load));
    assert.ok(Array.isArray(data.profile_context));
    assert.ok(Array.isArray(data.active_objectives));
    assert.ok(Array.isArray(data.active_projects));
    assert.ok(Array.isArray(data.pinned_context));
    assert.ok(Array.isArray(data.historical_background));
    assert.ok(Array.isArray(data.recent_summaries));
    assert.ok(typeof data.context_version === "number");
    assert.ok(typeof data.last_consolidated === "object");
    assert.ok(typeof data.generated_at === "string");

    const projectQuery = queries.find((q) => q.sql.includes("FROM projects p") && q.sql.includes("EXISTS"));
    assert.ok(projectQuery);
    assert.strictEqual(projectQuery.params.at(-1), 20);

    const cached = stored.get("context:startup");
    assert.ok(cached);
    const cachedBundle = JSON.parse(cached.value) as Record<string, unknown>;
    assert.ok(Array.isArray(cachedBundle.always_load));
    assert.strictEqual(cachedBundle.generated_at, data.generated_at);
  });

  it("queries historical background when include_history is true", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    await invokeTool(tools, "get_startup_context", { include_history: true });
    const historicalQuery = queries.find(
      (q) =>
        q.sql.includes("t.startup_priority >= ?") &&
        q.sql.includes("t.startup_priority <= ?") &&
        q.params.includes(3)
    );
    assert.ok(historicalQuery);
  });

  it("generates recent summaries for provided topics", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_startup_context", { topics: ["Work", "Health"] });
    const data = resultData(result) as Record<string, unknown>;
    const summaries = data.recent_summaries as Array<{ scope: string; summary: Record<string, unknown> }>;
    assert.strictEqual(summaries.length, 2);
    assert.strictEqual(summaries[0].scope, "work");
    assert.strictEqual(summaries[1].scope, "health");
    assert.strictEqual(summaries[0].summary.total, 0);

    const topicQueries = queries.filter(
      (q) => q.sql.includes("FROM todos t") && (q.params.includes("work") || q.params.includes("health"))
    );
    assert.strictEqual(topicQueries.length, 2);
    assert.ok(topicQueries.some((q) => q.params.includes("work")));
    assert.ok(topicQueries.some((q) => q.params.includes("health")));
  });

  it("skips cache when use_cache is false", async () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv, stored } = createMockKv(new Map([["context:startup", JSON.stringify({ source: "cached" })]]));
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_startup_context", { use_cache: false });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.source, "d1");
    // With use_cache=false the existing cached value is left untouched; only behavior verified above.
  });

  it("minimal mode omits objectives, summaries, and history by default", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "get_startup_context", { mode: "minimal", topics: ["Work"] });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.mode, "minimal");
    assert.ok(data.current_focus && typeof data.current_focus === "object");
    assert.deepStrictEqual(data.active_objectives, []);
    assert.deepStrictEqual(data.recent_summaries, []);
    assert.deepStrictEqual(data.historical_background, []);
    assert.ok(Array.isArray(data.always_load));
    assert.ok(Array.isArray(data.profile_context));
    assert.ok(Array.isArray(data.active_projects));
    assert.ok(Array.isArray(data.pinned_context));

    const objectiveQuery = queries.find(
      (q) => q.sql.includes("entity_type IN (?)") && q.params.includes("strategic_goal")
    );
    assert.ok(!objectiveQuery);
  });
});

describe("find_consolidation_candidates tool", () => {
  it("is registered as read-only", () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);
    const tool = tools.get("find_consolidation_candidates");
    assert.ok(tool);
    assert.strictEqual(tool.options.readOnlyHint, true);
    assert.strictEqual(tool.options.destructiveHint, false);
  });

  it("returns candidate groups based on shared tags", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb([
      { id: 1, title: "A", lifecycle_state: "active", updated_at: "2026-01-01T00:00:00Z", tag_name: "idea", tag_slug: "idea" },
      { id: 2, title: "B", lifecycle_state: "active", updated_at: "2026-01-02T00:00:00Z", tag_name: "idea", tag_slug: "idea" },
    ]);
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "find_consolidation_candidates", {});
    const data = resultData(result) as Record<string, unknown>;
    const candidates = data.candidates as Array<Record<string, unknown>>;
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].group_key, "idea");
    assert.deepStrictEqual(candidates[0].shared_tags, ["idea"]);
    assert.ok(Array.isArray(candidates[0].items));
    assert.strictEqual((candidates[0].items as Array<Record<string, unknown>>).length, 2);

    const candidateQuery = queries.find((q) => q.sql.includes("FROM todos t") && q.sql.includes("JOIN task_tags"));
    assert.ok(candidateQuery);
    assert.ok(candidateQuery.params.includes("memory"));
  });
});

describe("consolidate_memories tool", () => {
  it("is registered as destructive", () => {
    const { server, tools } = createMockServer();
    const { db } = createMockDb();
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);
    const tool = tools.get("consolidate_memories");
    assert.ok(tool);
    assert.strictEqual(tool.options.readOnlyHint, false);
    assert.strictEqual(tool.options.destructiveHint, true);
  });

  it("creates relationships and marks targets superseded", async () => {
    const { server, tools } = createMockServer();
    const { db, queries } = createMockDb([
      {
        id: 1,
        title: "Keeper",
        description: null,
        raw_input: null,
        item_kind: "memory",
        entity_type: "context_memory",
        lifecycle_state: "active",
        completed: 0,
        pinned: 0,
        project_id: null,
        group_id: null,
        objective_id: null,
        due_date: null,
        due_text: null,
        recurrence_kind: null,
        recurrence_interval: null,
        recurrence_until: null,
        archived_at: null,
        superseded_at: null,
        ignored_at: null,
        snoozed_until: null,
        last_active_at: null,
        last_touched_at: null,
        startup_priority: 5,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    const { kv } = createMockKv();
    registerTools(server, { DB: db, APP_KV: kv } as Env);

    const result = await invokeTool(tools, "consolidate_memories", {
      source_item_id: 1,
      target_item_ids: [2, 3],
      relationship_type: "supersedes",
      reason: "Consolidating duplicates",
    });
    const data = resultData(result) as Record<string, unknown>;
    assert.strictEqual(data.created_relationships, 2);

    const relationshipQuery = queries.find(
      (q) => q.sql.includes("INSERT OR IGNORE INTO item_relationships") && q.params.includes("supersedes")
    );
    assert.ok(relationshipQuery);

    const supersedeUpdate = queries.find(
      (q) => q.sql.includes("UPDATE todos") && q.sql.includes("lifecycle_state = 'superseded'")
    );
    assert.ok(supersedeUpdate);
  });
});
