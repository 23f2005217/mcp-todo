const CONTEXT_SUMMARY_PREFIX = "context:summary:";
const STARTUP_KEY = "context:startup";

const DEFAULT_SUMMARY_TTL_SECONDS = 300;
const DEFAULT_STARTUP_TTL_SECONDS = 60;

function summaryKey(scope: string): string {
  return `${CONTEXT_SUMMARY_PREFIX}${scope.toLowerCase()}`;
}

function putOptions(ttlSeconds?: number): { expirationTtl: number } | undefined {
  const ttl = ttlSeconds ?? 0;
  return ttl > 0 ? { expirationTtl: ttl } : undefined;
}

export async function getCachedContextSummary(
  kv: KVNamespace,
  scope: string
): Promise<unknown | null> {
  return kv.get<unknown>(summaryKey(scope), "json");
}

export async function setCachedContextSummary(
  kv: KVNamespace,
  scope: string,
  summary: unknown,
  ttlSeconds?: number
): Promise<void> {
  await kv.put(
    summaryKey(scope),
    JSON.stringify(summary),
    putOptions(ttlSeconds ?? DEFAULT_SUMMARY_TTL_SECONDS)
  );
}

export async function getCachedStartupContext(kv: KVNamespace): Promise<unknown | null> {
  return kv.get<unknown>(STARTUP_KEY, "json");
}

export async function setCachedStartupContext(
  kv: KVNamespace,
  bundle: unknown,
  ttlSeconds?: number
): Promise<void> {
  await kv.put(STARTUP_KEY, JSON.stringify(bundle), putOptions(ttlSeconds ?? DEFAULT_STARTUP_TTL_SECONDS));
}

export async function invalidateContextCache(
  kv: KVNamespace,
  scopes?: string[]
): Promise<void> {
  const keys: string[] = [STARTUP_KEY];
  if (scopes) {
    for (const scope of scopes) {
      keys.push(summaryKey(scope));
    }
  }
  await Promise.all(keys.map((key) => kv.delete(key)));
}

export async function invalidateAllContextCaches(kv: KVNamespace): Promise<void> {
  await kv.delete(STARTUP_KEY);
}
