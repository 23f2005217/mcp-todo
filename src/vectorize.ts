import type { EnrichedTask, Task } from "./db.js";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const TASK_NAMESPACE = "tasks";
const EMBEDDING_POOLING = "cls";
const EMBEDDING_BATCH_SIZE = 100;
const VECTORIZE_BATCH_SIZE = 100;

type EmbeddingResponse = Extract<Ai_Cf_Baai_Bge_Base_En_V1_5_Output, { data?: number[][] }>;

export interface VectorSyncResult {
  operation: "upsert" | "delete";
  count?: number;
  ids?: string[];
  mutation_id?: string;
}

type VectorMutationResult = Partial<VectorizeVectorMutation & VectorizeAsyncMutation>;

function taskVectorId(taskId: number): string {
  return `task:${taskId}`;
}

function buildEmbeddingText(
  task: Pick<Task, "title" | "description" | "raw_input" | "item_kind"> & {
    project?: { name: string } | null;
    group?: { name: string } | null;
    tags?: Array<{ name: string }>;
  }
): string {
  const parts = [task.title.trim(), `kind: ${task.item_kind}`];
  if (task.description?.trim()) {
    parts.push(task.description.trim());
  }
  if (task.raw_input?.trim()) {
    parts.push(task.raw_input.trim());
  }
  if (task.project?.name) {
    parts.push(`project: ${task.project.name}`);
  }
  if (task.group?.name) {
    parts.push(`group: ${task.group.name}`);
  }
  if (task.tags && task.tags.length > 0) {
    parts.push(`tags: ${task.tags.map((tag) => tag.name).join(", ")}`);
  }
  return parts.join("\n\n");
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const response = await env.AI.run(EMBEDDING_MODEL, {
      text: batch,
      pooling: EMBEDDING_POOLING,
    }) as EmbeddingResponse;

    if (!response.data || response.data.length !== batch.length) {
      throw new Error("Workers AI embedding response did not return one vector per input text");
    }

    vectors.push(...response.data);
  }

  return vectors;
}

export async function upsertTaskVectors(
  env: Env,
  tasks: Array<Pick<EnrichedTask, "id" | "title" | "description" | "raw_input" | "item_kind" | "project" | "group" | "tags">>
): Promise<VectorSyncResult | null> {
  if (tasks.length === 0) return null;

  const embeddings = await embedTexts(env, tasks.map(buildEmbeddingText));
  let total = 0;
  const ids: string[] = [];

  for (let i = 0; i < tasks.length; i += VECTORIZE_BATCH_SIZE) {
    const taskBatch = tasks.slice(i, i + VECTORIZE_BATCH_SIZE);
    const embeddingBatch = embeddings.slice(i, i + VECTORIZE_BATCH_SIZE);
    const mutation = await env.TASK_VECTORS.upsert(
      taskBatch.map((task, index) => ({
        id: taskVectorId(task.id),
        namespace: TASK_NAMESPACE,
        values: embeddingBatch[index],
        metadata: {
          task_id: task.id,
        },
      }))
    ) as VectorMutationResult;

    if (Array.isArray(mutation.ids)) {
      ids.push(...mutation.ids);
    } else {
      ids.push(...taskBatch.map((task) => taskVectorId(task.id)));
    }

    total += typeof mutation.count === "number" ? mutation.count : taskBatch.length;

    if (typeof mutation.mutationId === "string") {
      return { operation: "upsert", count: total, ids, mutation_id: mutation.mutationId };
    }
  }

  return { operation: "upsert", count: total, ids };
}

export async function deleteTaskVector(env: Env, taskId: number): Promise<VectorSyncResult> {
  const vectorId = taskVectorId(taskId);
  const mutation = await env.TASK_VECTORS.deleteByIds([vectorId]) as VectorMutationResult;
  return {
    operation: "delete",
    count: typeof mutation.count === "number" ? mutation.count : 1,
    ids: Array.isArray(mutation.ids) ? mutation.ids : [vectorId],
    mutation_id: typeof mutation.mutationId === "string" ? mutation.mutationId : undefined,
  };
}

export interface VectorSearchMatch {
  taskId: number;
  score: number;
}

function parseTaskId(vectorId: string): number | null {
  if (!vectorId.startsWith("task:")) return null;
  const parsed = Number.parseInt(vectorId.slice(5), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function semanticSearchTaskIds(
  env: Env,
  query: string,
  limit: number
): Promise<VectorSearchMatch[]> {
  const embeddings = await embedTexts(env, [query]);
  const result = await env.TASK_VECTORS.query(embeddings[0], {
    namespace: TASK_NAMESPACE,
    topK: limit,
    returnValues: false,
  });

  return result.matches.flatMap((match) => {
    const taskId = parseTaskId(match.id);
    return taskId === null ? [] : [{ taskId, score: match.score }];
  });
}

export async function describeTaskIndex(env: Env) {
  return env.TASK_VECTORS.describe();
}
