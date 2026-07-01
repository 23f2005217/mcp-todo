import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildContextSummary,
  ContextLoadQuery,
  loadActiveObjectives,
  loadActiveProjects,
  loadContextItems,
  loadPinnedItems,
  loadProfileItems,
} from "./context.js";

interface CapturedQuery {
  sql: string;
  params: unknown[];
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

function lastQuery(q: CapturedQuery[]): CapturedQuery {
  assert.ok(q.length > 0, "expected at least one query");
  return q[q.length - 1];
}

describe("loadContextItems", () => {
  it("applies current_only filters and default limit by default", async () => {
    const { db, queries } = createMockDb();
    await loadContextItems(db, {});
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /lifecycle_state NOT IN \('superseded', 'archived', 'completed'\)/);
    assert.match(sql, /archived_at IS NULL/);
    assert.match(sql, /completed = 0/);
    assert.match(sql, /ORDER BY t\.startup_priority DESC, t\.pinned DESC, t\.priority DESC, t\.updated_at DESC, t\.id ASC/);
    assert.strictEqual(params[params.length - 1], 50);
  });

  it("supports profile matching via group or tag slug", async () => {
    const { db, queries } = createMockDb();
    await loadContextItems(db, { profile: true });
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /\(g\.slug = \? OR EXISTS/);
    assert.ok(params.includes("profile"));
  });

  it("combines tag, project, group, kind, entity_type, and pinned filters", async () => {
    const { db, queries } = createMockDb();
    const query: ContextLoadQuery = {
      tags: ["context", "Feature"],
      project_slugs: ["work"],
      group_slugs: ["team"],
      kinds: ["task"],
      entity_types: ["tactical_task"],
      pinned: true,
      limit: 10,
    };
    await loadContextItems(db, query);
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /tag\.slug IN \(\?, \?\)/);
    assert.match(sql, /projects WHERE slug IN \(\?\)/);
    assert.match(sql, /groups WHERE slug IN \(\?\)/);
    assert.match(sql, /t\.item_kind IN \(\?\)/);
    assert.match(sql, /t\.entity_type IN \(\?\)/);
    assert.match(sql, /t\.pinned = \?/);
    assert.deepStrictEqual(params, [
      "task",
      "tactical_task",
      1,
      "work",
      "team",
      "context",
      "feature",
      10,
    ]);
  });

  it("skips current_only filter when include_history is true", async () => {
    const { db, queries } = createMockDb();
    await loadContextItems(db, { include_history: true });
    const { sql } = lastQuery(queries);
    assert.doesNotMatch(sql, /lifecycle_state NOT IN/);
    assert.doesNotMatch(sql, /archived_at IS NULL/);
    assert.doesNotMatch(sql, /completed = 0/);
  });

  it("skips current_only filter when current_only is false", async () => {
    const { db, queries } = createMockDb();
    await loadContextItems(db, { current_only: false });
    const { sql } = lastQuery(queries);
    assert.doesNotMatch(sql, /lifecycle_state NOT IN/);
  });

  it("filters by startup_priority range", async () => {
    const { db, queries } = createMockDb();
    await loadContextItems(db, { startup_priority_min: 7, startup_priority_max: 10 });
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /t\.startup_priority >= \?/);
    assert.match(sql, /t\.startup_priority <= \?/);
    assert.ok(params.includes(7));
    assert.ok(params.includes(10));
  });

  it("clamps limit between 1 and 100", async () => {
    const { db: dbLow, queries: qLow } = createMockDb();
    await loadContextItems(dbLow, { limit: 0 });
    assert.strictEqual(lastQuery(qLow).params.at(-1), 1);

    const { db: dbHigh, queries: qHigh } = createMockDb();
    await loadContextItems(dbHigh, { limit: 500 });
    assert.strictEqual(lastQuery(qHigh).params.at(-1), 100);
  });
});

describe("loadPinnedItems", () => {
  it("sets pinned=true and preserves other filters", async () => {
    const { db, queries } = createMockDb();
    await loadPinnedItems(db, { project_slugs: ["work"], limit: 5 });
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /t\.pinned = \?/);
    assert.ok(params.includes("work"));
    assert.strictEqual(params.at(-1), 5);
  });
});

describe("loadProfileItems", () => {
  it("sets profile=true and preserves other filters", async () => {
    const { db, queries } = createMockDb();
    await loadProfileItems(db, { pinned: true, limit: 7 });
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /\(g\.slug = \? OR EXISTS/);
    assert.match(sql, /t\.pinned = \?/);
    assert.strictEqual(params.at(-1), 7);
  });
});

describe("loadActiveObjectives", () => {
  it("filters to strategic_goal entity type and optional project slugs", async () => {
    const { db, queries } = createMockDb();
    await loadActiveObjectives(db, ["work", "home"]);
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /t\.entity_type IN \(\?\)/);
    assert.match(sql, /projects WHERE slug IN \(\?, \?\)/);
    assert.ok(params.includes("strategic_goal"));
    assert.ok(params.includes("work"));
    assert.ok(params.includes("home"));
  });

  it("supports options object with project slugs and limit", async () => {
    const { db, queries } = createMockDb();
    await loadActiveObjectives(db, { projectSlugs: ["work"], limit: 20 });
    const { sql, params } = lastQuery(queries);
    assert.match(sql, /t\.entity_type IN \(\?\)/);
    assert.match(sql, /projects WHERE slug IN \(\?\)/);
    assert.ok(params.includes("strategic_goal"));
    assert.ok(params.includes("work"));
    assert.strictEqual(params.at(-1), 20);
  });

  it("uses default limit when options object omits limit", async () => {
    const { db, queries } = createMockDb();
    await loadActiveObjectives(db, { projectSlugs: ["work"] });
    assert.strictEqual(lastQuery(queries).params.at(-1), 50);
  });
});

describe("loadActiveProjects", () => {
  it("queries projects with at least one active item", async () => {
    const { db, queries } = createMockDb();
    await loadActiveProjects(db);
    const { sql } = lastQuery(queries);
    assert.match(sql, /SELECT p\.id, p\.name, p\.slug, p\.description/);
    assert.match(sql, /EXISTS \(/);
    assert.match(sql, /t\.lifecycle_state NOT IN \('superseded', 'archived', 'completed'\)/);
    assert.match(sql, /ORDER BY p\.focus_updated_at DESC, p\.name ASC/);
    assert.match(sql, /LIMIT \?/);
  });

  it("applies a custom limit", async () => {
    const { db, queries } = createMockDb();
    await loadActiveProjects(db, 20);
    assert.strictEqual(lastQuery(queries).params.at(-1), 20);
  });
});

describe("buildContextSummary", () => {
  it("returns zeroed summary for empty items", () => {
    const summary = buildContextSummary("work", []);
    assert.strictEqual(summary.scope, "work");
    assert.strictEqual(summary.total, 0);
    assert.strictEqual(summary.active_count, 0);
    assert.strictEqual(summary.pinned_count, 0);
    assert.strictEqual(summary.top_item, null);
    assert.ok(typeof summary.generated_at === "string");
  });

  it("counts totals and active/pinned items", () => {
    const items = [
      { id: 1, title: "A", item_kind: "task", entity_type: "tactical_task", lifecycle_state: "active", pinned: 0 },
      { id: 2, title: "B", item_kind: "task", entity_type: "strategic_goal", lifecycle_state: "active", pinned: 1 },
      { id: 3, title: "C", item_kind: "memory", entity_type: "context_memory", lifecycle_state: "dormant", pinned: 0 },
    ] as unknown as import("./db.js").EnrichedTask[];
    const summary = buildContextSummary("health", items);
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.pinned_count, 1);
    assert.strictEqual(summary.active_count, 2);
    assert.deepStrictEqual(summary.top_item, { id: 1, title: "A" });
  });

  it("selects single top item from sorted input", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      title: `Task ${i + 1}`,
      item_kind: "task",
      entity_type: "tactical_task",
      lifecycle_state: "active",
      pinned: 0,
    })) as unknown as import("./db.js").EnrichedTask[];
    const summary = buildContextSummary("overflow", items);
    assert.deepStrictEqual(summary.top_item, { id: 1, title: "Task 1" });
  });
});
