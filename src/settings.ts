export interface AppSettings {
  default_quick_add_priority: "low" | "medium" | "high";
  default_capture_kind: "task" | "memory";
  default_upcoming_days: number;
  default_snooze_hours: number;
}

const APP_SETTINGS_KEY = "app:settings";

const DEFAULT_SETTINGS: AppSettings = {
  default_quick_add_priority: "medium",
  default_capture_kind: "task",
  default_upcoming_days: 7,
  default_snooze_hours: 24,
};

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function normalizePriority(value: unknown): AppSettings["default_quick_add_priority"] {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : DEFAULT_SETTINGS.default_quick_add_priority;
}

function normalizeKind(value: unknown): AppSettings["default_capture_kind"] {
  return value === "memory" || value === "task"
    ? value
    : DEFAULT_SETTINGS.default_capture_kind;
}

function normalizeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    default_quick_add_priority: normalizePriority(value?.default_quick_add_priority),
    default_capture_kind: normalizeKind(value?.default_capture_kind),
    default_upcoming_days: clampInteger(
      value?.default_upcoming_days,
      1,
      365,
      DEFAULT_SETTINGS.default_upcoming_days
    ),
    default_snooze_hours: clampInteger(
      value?.default_snooze_hours,
      1,
      24 * 30,
      DEFAULT_SETTINGS.default_snooze_hours
    ),
  };
}

export async function getAppSettings(kv: KVNamespace): Promise<AppSettings> {
  const stored = await kv.get<Partial<AppSettings>>(APP_SETTINGS_KEY, "json");
  return normalizeSettings(stored);
}

export async function updateAppSettings(
  kv: KVNamespace,
  changes: Partial<AppSettings>
): Promise<AppSettings> {
  const current = await getAppSettings(kv);
  const next = normalizeSettings({ ...current, ...changes });
  await kv.put(APP_SETTINGS_KEY, JSON.stringify(next));
  return next;
}
