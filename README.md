# mcp-todo

A Cloudflare Worker that exposes a **Model Context Protocol (MCP)** server for long-term task, memory, and context management. It is designed to give an AI agent persistent, structured context across conversations while keeping startup payloads small and deterministic.

- **Endpoint:** `https://mcp-todo.linuxgaruda52.workers.dev/mcp`
- **Health check:** `GET /` returns server status and current app settings.

---

## What it does

`mcp-todo` is a deterministic AI memory system. It stores tasks, memories, projects, objectives, and relationships in **D1**, caches hot context in **KV**, and indexes task text in **Vectorize** for semantic search. The worker exposes a small set of MCP tools that an AI agent can call to:

- Capture tasks and memories with tags, projects, groups, priorities, and lifecycle states.
- Query and mutate state deterministically.
- Retrieve focused startup context on every new conversation.
- Progressively load topic summaries, project context, and raw memories only when needed.
- Search semantically across stored items.
- Discover and consolidate duplicate or superseded memories.

**Design principle:** the database decides what to return; the AI only decides what it wants to know next. Retrieval is deterministic. AI is used only for enhancement (embeddings for semantic search, suggested relationships, summaries).

---

## Platform bindings

| Binding     | Service        | Purpose                                           |
|-------------|----------------|---------------------------------------------------|
| `env.DB`    | D1             | Relational store for todos, projects, tags, relationships, events, logs. |
| `env.APP_KV`| KV             | Caches startup context, context summaries, app settings, and active focus. |
| `env.TASK_VECTORS` | Vectorize | Semantic search index over task/memory text.      |
| `env.AI`    | Workers AI     | Generates embeddings for Vectorize (`@cf/baai/bge-base-en-v1.5`). |

Configure them in `wrangler.jsonc`.

---

## Core concepts

### Context hierarchy

Retrieval is organized into layers. An AI should move down the hierarchy only when more detail is required:

```
Startup Context
    ↓
Topic Summary
    ↓
Project Context
    ↓
Raw Memories
```

- **Startup Context** — extremely lightweight: profile, active goals, current focus, active projects, always-load items, and topic summaries.
- **Topic Summary** — the single canonical active item for a topic/group plus a deterministic rollup.
- **Project Context** — project, active objective, active items, recurring systems, and optional history.
- **Raw Memories** — individual items, filtered deterministically by tags, groups, projects, lifecycle state, and startup priority.

### Items

The central table is `todos`. An item can be:

- **`item_kind`**: `task` or `memory`
- **`entity_type`**: `tactical_task`, `strategic_goal`, `recurring_system`, `context_memory`, `archived_history`
- **`lifecycle_state`**: `active`, `dormant`, `stale`, `superseded`, `archived`, `completed`
- **`startup_priority`**: `0` (never load at startup) to `10` (always load). Manual assignment only.

Items can be pinned, tagged, assigned to projects/groups, and linked to objectives.

### Context groups

Groups are deterministic retrieval buckets. Every group has:

- **`group_kind`**: `topic`, `profile`, `project`, or `system`
- **`retrieval_priority`**: controls whether the group is included in startup topic summaries
- **`canonical_item_id`**: the single active item that represents the current state of the topic

Tags remain for organization and search; groups define deterministic retrieval behavior.

### Projects and objectives

- **Projects** group work.
- **Objectives** are `strategic_goal` items linked to a project with an active/superseded status.
- A project can have an `active_objective_id` representing the current north-star.

### Relationships

`item_relationships` links items with types:

- `supersedes`, `replaces`, `derived_from` — mark historical lineage
- `duplicate_of` — exact duplicates
- `blocks`, `depends_on`, `supports` — dependency tracking

These power history-aware retrieval and the consolidation workflow.

### Startup priority philosophy

Priorities are assigned manually, never calculated:

| Priority | Meaning |
|----------|---------|
| 10 | Always load during startup |
| 8 | Usually load |
| 5 | Topic-specific |
| 2 | Historical |
| 0 | Never load during startup |

---

## MCP tools

### App settings

- `get_app_settings` — read global defaults.
- `update_app_settings` — update defaults like priority, snooze hours, upcoming days.

### Capture and manage items

- `quick_add_task` — create a task with defaults.
- `capture_context` — capture a memory or context item quickly.
- `get_item` — load and enrich one item by ID.
- `list_items` — list/filter/paginate items.
- `update_item` — update title, description, state, tags, project, etc.
- `delete_item` / `delete_items` — remove items and their vectors/relationships.
- `set_item_startup_priority` — control how eagerly an item loads at startup.

### Projects and objectives

- `create_project`
- `get_project`
- `list_projects`
- `set_active_objective`
- `get_project_timeline`

### State transitions

- `update_task_state` — complete, snooze, ignore, reactivate, archive, supersede.
- `supersede_items` — mark targets as superseded by a source item.
- `mark_stale_candidates` — find and mark old active items as stale.

### Search

- `semantic_search` — vector search over items, with optional kind filters.
- `find_semantic_conflicts` — find active items similar to a query or item; returns duplicate/supersession candidates.

### Context retrieval

- `load_context` — **one flexible retrieval interface** for the whole hierarchy.
  - `level: "startup"` — lightweight startup bundle.
  - `level: "topic_summary"` — canonical item + deterministic summary for a topic.
  - `level: "project"` — project, objective, active items, recurring systems, optional history.
  - `level: "raw_memories"` — filtered raw items (default, backward-compatible).
- `get_startup_context` — convenience alias for `load_context({ level: "startup" })`.
- `get_context_summary` — convenience alias for `load_context({ level: "topic_summary" })`.
- `get_focus_context` — current strategic focus.
- `get_active_objectives`, `get_active_projects`

### Consolidation workflow

- `find_consolidation_candidates` — deterministically group memories/tasks that share tags and may be duplicates/supersessions.
- `consolidate_memories` — create a relationship (`duplicate_of`, `supersedes`, `replaces`, `derived_from`) between a keeper and target items, optionally marking targets superseded.

---

## Startup context (`load_context` / `get_startup_context`)

The main entry point for an AI agent bootstrapping a new conversation.

Startup context is intentionally minimal. It answers:

- Who is this user?
- What are they currently doing?
- What are their active goals?
- What projects are active?
- What topics matter?

It does **not** load every pinned memory.

### Returned bundle

```jsonc
{
  "level": "startup",
  "source": "d1" | "kv_cache",
  "context_version": 123,
  "generated_at": "2026-07-01T...",
  "last_consolidated": "2026-07-01T...",
  "profile": { /* single current profile item */ },
  "active_goals": [ /* active strategic goals */ ],
  "current_focus": { /* project + objective + next tactical step */ },
  "active_projects": [ /* projects with active work */ ],
  "always_load": [ /* items with startup_priority = 10 */ ],
  "topic_summaries": [ /* canonical items for high-priority groups */ ]
}
```

The bundle is cached in KV under `context:startup` and invalidated on writes. The `context_version` changes only when underlying items change, so AI agents can reuse a cached bundle when the version matches.

---

## Topic summaries (`load_context` with `level: "topic_summary"`)

Deterministic rollup for a scope/topic, cached in KV under `context:summary:<scope>`.

```jsonc
{
  "level": "topic_summary",
  "scope": "aws",
  "group": { "slug": "aws", "group_kind": "topic", "retrieval_priority": 8 },
  "canonical_item": { /* single current active representation */ },
  "summary": {
    "scope": "aws",
    "total": 12,
    "active_count": 5,
    "pinned_count": 2,
    "top_item": { "id": 42, "title": "Current AWS strategy" },
    "version": 7,
    "last_consolidated": "2026-07-01T...",
    "generated_at": "2026-07-01T..."
  },
  "source": "d1",
  "generated_at": "2026-07-01T..."
}
```

If no `canonical_item_id` is set on the group, the highest-priority active item in that group/tag is returned as the de-facto canonical. Use `set_group_canonical_item` to assign the canonical item explicitly.

## Project context (`load_context` with `level: "project"`)

Loads a project, its active objective, active work, recurring systems, and optional history.

```jsonc
{
  "level": "project",
  "source": "d1",
  "project": { /* project record */ },
  "active_objective": { /* current strategic goal */ },
  "active_items": [ /* active project items */ ],
  "recurring_systems": [ /* recurring support items */ ],
  "history": [ /* superseded/archived/completed, only if include_history=true */ ],
  "generated_at": "2026-07-01T..."
}
```

---

## Deterministic consolidation workflow

1. Call `find_consolidation_candidates` to get groups of items that share tags. The tool is deterministic and uses existing tags; semantic search can augment discovery separately via `find_semantic_conflicts`.
2. Review the suggested relationship (`duplicate_of`, `supersedes`, `replaces`, `derived_from`) and reason.
3. Call `consolidate_memories` with a `source_item_id` (keeper) and `target_item_ids` to create relationships and optionally mark targets as superseded.

No new storage columns are required; the workflow reuses the existing `item_relationships` table and lifecycle states.

---

## Project structure

```
src/
  index.ts          # Worker fetch handler and MCP server setup
  tools.ts          # All MCP tool registrations
  db.ts             # Data model, queries, mutations, enrichment
  context.ts        # Context retrieval helpers and summary builder
  context-cache.ts  # KV cache helpers
  vectorize.ts      # Vectorize indexing and semantic search
  settings.ts       # App settings defaults and validation
  due.ts            # Due-date parsing
  context.test.ts   # Unit tests for context helpers
  tools.test.ts     # Unit tests for MCP tools
migrations/         # D1 schema migrations
wrangler.jsonc      # Cloudflare bindings and deploy config
```

---

## Development

```bash
# Install dependencies
npm install

# Run TypeScript check
npx tsc --noEmit

# Compile tests
npx tsc -p tsconfig.test.json

# Run tests
node --test dist-test/src/context.test.js dist-test/src/tools.test.js

# Dry-run deploy
npm run deploy -- --dry-run

# Deploy
npm run deploy
```

### Local dev

```bash
npx wrangler dev
```

The MCP server is available at `http://localhost:8787/mcp`.

---

## Important implementation notes

- **D1 is the source of truth.** Vectorize and KV are caches/indexes; failures there are caught and do not block D1 writes.
- **Deterministic retrieval:** the database decides what to return. Ranking uses explicit metadata (`startup_priority`, `retrieval_priority`, `lifecycle_state`, `pinned`, recency). No LLM is involved in retrieval.
- **Canonical current state:** every topic can have one canonical active item. Older versions remain stored via `supersedes`/`replaces`/`derived_from` relationships, but normal retrieval returns only the active version.
- **Superseded/historical items** are returned only when `include_history=true`.
- **Context invalidation:** writes clear the active focus cache and invalidate startup/topic/project caches as appropriate.
- **AI is optional:** it only enhances organization (summaries, embeddings, consolidation suggestions); it never controls correctness or retrieval ordering.

---

## Deployment status

Last deployed: `2026-07-01`
Current production version: `9d09fb45-ac34-49ff-9c12-3ac737497830`
