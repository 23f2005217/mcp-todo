export interface AppSettings {
  default_quick_add_priority: "low" | "medium" | "high";
  default_upcoming_days: number;
  default_focus_limit: number;
  default_plan_day_limit: number;
}

const APP_SETTINGS_KEY = "app:settings";

const DEFAULT_SETTINGS: AppSettings = {
  default_quick_add_priority: "medium",
  default_upcoming_days: 7,
  default_focus_limit: 3,
  default_plan_day_limit: 10,
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

function normalizeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    default_quick_add_priority: normalizePriority(value?.default_quick_add_priority),
    default_upcoming_days: clampInteger(
      value?.default_upcoming_days,
      1,
      365,
      DEFAULT_SETTINGS.default_upcoming_days
    ),
    default_focus_limit: clampInteger(
      value?.default_focus_limit,
      1,
      25,
      DEFAULT_SETTINGS.default_focus_limit
    ),
    default_plan_day_limit: clampInteger(
      value?.default_plan_day_limit,
      1,
      100,
      DEFAULT_SETTINGS.default_plan_day_limit
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
