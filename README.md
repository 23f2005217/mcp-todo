# mcp-todo

A Cloudflare Worker that exposes a **Model Context Protocol (MCP)** server for long-term task, memory, and context management. It is designed to give an AI agent persistent, structured context across conversations while keeping startup payloads small and deterministic.

- **Endpoint:** `https://mcp-todo.linuxgaruda52.workers.dev/mcp`
- **Health check:** `GET /` returns server status and current app settings.

---

## What it does

`mcp-todo` stores tasks, memories, projects, objectives, and relationships in **D1**, caches hot context in **KV**, and indexes task text in **Vectorize** for semantic search. The worker exposes a set of MCP tools that an AI agent can call to:

- Capture tasks and memories with tags, projects, priorities, and lifecycle states.
- Query and mutate state deterministically.
- Retrieve focused startup context on every new conversation.
- Search semantically across stored items.
- Discover and consolidate duplicate or superseded memories.

All retrieval ranking is deterministic (priority + recency); AI is used only for enhancement (embeddings for semantic search, suggested relationships, summaries).

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

### Items

The central table is `todos`. An item can be:

- **`item_kind`**: `task` or `memory`
- **`entity_type`**: `tactical_task`, `strategic_goal`, `recurring_system`, `context_memory`, `archived_history`
- **`lifecycle_state`**: `active`, `dormant`, `stale`, `superseded`, `archived`, `completed`
- **`startup_priority`**: `1` (low) to `3` (high) — controls how eagerly an item appears in startup context.

Items can be pinned, profiled, always-loaded, tagged, assigned to projects/groups, and linked to objectives.

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

- `get_startup_context` — primary conversation bootstrap tool.
- `get_context_summary` — lightweight deterministic summary for a scope/topic.
- `get_focus_context` — current strategic focus.
- `get_active_objectives`, `get_active_projects`

### Consolidation workflow

- `find_consolidation_candidates` — deterministically group memories/tasks that share tags and may be duplicates/supersessions.
- `consolidate_memories` — create a relationship (`duplicate_of`, `supersedes`, `replaces`, `derived_from`) between a keeper and target items, optionally marking targets superseded.

---

## Tiered startup context (`get_startup_context`)

The main entry point for an AI agent bootstrapping a new conversation.

### Modes

| Mode      | Loads by default | Threshold | Notes |
|-----------|------------------|-----------|-------|
| `minimal` | always_load, profile, focus, projects, pinned | `startup_priority >= 10` | Omit objectives, summaries, history |
| `normal`  | all sections above + objectives + summaries | `startup_priority >= 7` | Default mode |
| `full`    | normal + historical background | `startup_priority >= 7` for current, `>= 3` for history |

### Explicit overrides

Every section can be forced on/off independently:

- `include_always_load`
- `include_profile`
- `include_focus`
- `include_objectives`
- `include_projects`
- `include_pinned`
- `include_summaries`
- `include_history`

Overrides take precedence over mode defaults.

### Returned bundle

```jsonc
{
  "mode": "normal",
  "source": "d1" | "kv_cache",
  "current_focus": { /* active objective/project/focus */ },
  "always_load": [ /* pinned/always-load items */ ],
  "profile_context": [ /* profile items */ ],
  "active_objectives": [ /* strategic goals */ ],
  "active_projects": [ /* projects with active work */ ],
  "pinned_context": [ /* pinned items */ ],
  "recent_summaries": [ /* lightweight summaries for requested topics */ ],
  "historical_background": [ /* superseded/archived items, full mode or include_history only */ ],
  "context_version": 123,
  "last_consolidated": "2026-07-01T...",
  "generated_at": "2026-07-01T..."
}
```

The bundle is cached in KV under `context:startup` and invalidated on writes.

---

## Lightweight summaries (`get_context_summary`)

Deterministic rollup for a scope/topic, cached in KV under `context:summary:<scope>`.

```jsonc
{
  "scope": "work",
  "total": 12,
  "active_count": 5,
  "pinned_count": 2,
  "top_item": { "id": 42, "title": "Top priority item" },
  "version": 7,
  "last_consolidated": "2026-07-01T...",
  "generated_at": "2026-07-01T..."
}
```

Summaries are deliberately small: counts, one high-priority top item, and versioning metadata. No verbose bucket breakdowns.

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
- **Deterministic ranking:** startup and summary retrieval order by `startup_priority` DESC, then recency. No LLM is involved in ranking.
- **Superseded/historical items** are available in startup context only when explicitly requested (`full` mode or `include_history=true`).
- **Context invalidation:** writes clear the active focus cache and invalidate startup/summary caches as appropriate.

---

## Deployment status

Last deployed: `2026-07-01`
Current production version: `9d09fb45-ac34-49ff-9c12-3ac737497830`
