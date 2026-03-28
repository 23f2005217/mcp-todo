export interface ParsedDueDate {
  due_at: string | null;
  normalized: string | null;
  matched: boolean;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function atUtc(date: Date, hours: number, minutes = 0): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hours,
    minutes,
    0,
    0
  ));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function nextWeekday(base: Date, weekday: number): Date {
  const current = base.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(base, delta);
}

export function parseDueDate(input?: string | null, now = new Date()): ParsedDueDate {
  const raw = input?.trim();
  if (!raw) return { due_at: null, normalized: null, matched: false };

  const lower = raw.toLowerCase();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return {
      due_at: `${raw}T09:00:00.000Z`,
      normalized: raw,
      matched: true,
    };
  }

  const parsedTimestamp = Date.parse(raw);
  if (Number.isFinite(parsedTimestamp)) {
    return {
      due_at: new Date(parsedTimestamp).toISOString(),
      normalized: raw,
      matched: true,
    };
  }

  if (lower === "today") {
    return { due_at: atUtc(now, 17).toISOString(), normalized: "today", matched: true };
  }

  if (lower === "tonight") {
    return { due_at: atUtc(now, 20).toISOString(), normalized: "tonight", matched: true };
  }

  if (lower === "tomorrow") {
    return { due_at: atUtc(addDays(now, 1), 9).toISOString(), normalized: "tomorrow", matched: true };
  }

  if (lower === "this week") {
    const endOfWeek = addDays(now, Math.max(1, 5 - now.getUTCDay()));
    return { due_at: atUtc(endOfWeek, 17).toISOString(), normalized: "this week", matched: true };
  }

  if (lower === "next week") {
    return { due_at: atUtc(addDays(now, 7), 9).toISOString(), normalized: "next week", matched: true };
  }

  const weekday = WEEKDAYS[lower];
  if (weekday !== undefined) {
    return {
      due_at: atUtc(nextWeekday(now, weekday), 9).toISOString(),
      normalized: lower,
      matched: true,
    };
  }

  return { due_at: null, normalized: raw, matched: false };
}

export function advanceRecurringDueDate(
  dueAt: string | null,
  recurrenceKind: string | null,
  recurrenceInterval: number | null,
  recurrenceUntil: string | null,
  now = new Date()
): string | null {
  if (!recurrenceKind) return null;

  const interval = Math.max(1, recurrenceInterval ?? 1);
  const base = dueAt ? new Date(dueAt) : now;
  let next = new Date(base);

  if (recurrenceKind === "daily") {
    next = addDays(base, interval);
  } else if (recurrenceKind === "weekly") {
    next = addDays(base, interval * 7);
  } else if (recurrenceKind === "monthly") {
    next = new Date(Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth() + interval,
      base.getUTCDate(),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    ));
  } else if (recurrenceKind === "weekdays") {
    next = addDays(base, 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
      next = addDays(next, 1);
    }
  } else {
    return null;
  }

  const nextIso = next.toISOString();
  if (recurrenceUntil && nextIso > recurrenceUntil) {
    return null;
  }

  return nextIso;
}
