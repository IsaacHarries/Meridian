/**
 * One-time importer for historical work-hours data exported from external
 * sources (e.g. years of Word-doc time logs converted to JSON).
 *
 * Expected file shape:
 *
 *   {
 *     "days": [
 *       {
 *         "date": "2024-04-15",       // YYYY-MM-DD, local calendar day
 *         "start": "08:30",           // required
 *         "end":   "17:00",           // required
 *         "lunchStart": "12:00",      // optional pair — splits the day in two
 *         "lunchEnd":   "13:00",
 *         "breakStart": "15:00",      // optional second pair (any other pause)
 *         "breakEnd":   "15:15"
 *       }
 *     ]
 *   }
 *
 * Times accept 24-hour `HH:MM` or 12-hour `H:MM AM/PM` to match what's
 * naturally written in a notes doc. Lunch and break can appear in any
 * order; segments are derived from `start → end` minus the union of
 * pauses, so a day with both lunch and break ends up as three segments.
 */

export interface ImportDay {
  date: string;
  start: string;
  end: string;
  lunchStart?: string;
  lunchEnd?: string;
  breakStart?: string;
  breakEnd?: string;
}

export interface ImportFile {
  days: ImportDay[];
}

export interface ParsedDay {
  /** Local-day key (`YYYY-MM-DD`) — keys into the store's `segmentsByDay`. */
  dayKey: string;
  /** Closed segments produced from `start → end` minus pauses. */
  segments: { startMs: number; endMs: number }[];
}

export interface ImportError {
  /** 1-based index in the source `days` array, for an actionable error message. */
  dayIndex: number;
  /** The `date` field from the offending entry, when it was readable. */
  date: string | null;
  message: string;
}

export interface ImportParseResult {
  days: ParsedDay[];
  errors: ImportError[];
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON string. Returns the days that converted
 * cleanly and a list of human-readable errors for any that didn't — never
 * throws; callers decide whether partial success is acceptable.
 */
export function parseImportJson(raw: string): ImportParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return {
      days: [],
      errors: [
        {
          dayIndex: 0,
          date: null,
          message: `Not valid JSON: ${(err as Error).message}`,
        },
      ],
    };
  }

  if (!doc || typeof doc !== "object" || !Array.isArray((doc as ImportFile).days)) {
    return {
      days: [],
      errors: [
        {
          dayIndex: 0,
          date: null,
          message: 'Expected an object with a "days" array at the root.',
        },
      ],
    };
  }

  const out: ParsedDay[] = [];
  const errors: ImportError[] = [];

  (doc as ImportFile).days.forEach((entry, i) => {
    const result = parseEntry(entry, i + 1);
    if (result.error) errors.push(result.error);
    if (result.parsed) out.push(result.parsed);
  });

  return { days: out, errors };
}

// ── Per-entry validation ────────────────────────────────────────────────────

function parseEntry(
  entry: ImportDay | undefined,
  oneBasedIndex: number,
): { parsed?: ParsedDay; error?: ImportError } {
  if (!entry || typeof entry !== "object") {
    return {
      error: {
        dayIndex: oneBasedIndex,
        date: null,
        message: "Entry is not an object.",
      },
    };
  }

  const date = typeof entry.date === "string" ? entry.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      error: {
        dayIndex: oneBasedIndex,
        date: date || null,
        message: 'Missing or invalid "date" — expected "YYYY-MM-DD".',
      },
    };
  }

  const dayBase = parseLocalDate(date);
  if (!dayBase) {
    return {
      error: {
        dayIndex: oneBasedIndex,
        date,
        message: "Date does not represent a real calendar day.",
      },
    };
  }

  const startMs = parseTimeOn(dayBase, entry.start);
  const endMs = parseTimeOn(dayBase, entry.end);
  if (startMs == null) {
    return {
      error: {
        dayIndex: oneBasedIndex,
        date,
        message: 'Missing or invalid "start" time.',
      },
    };
  }
  if (endMs == null) {
    return {
      error: {
        dayIndex: oneBasedIndex,
        date,
        message: 'Missing or invalid "end" time.',
      },
    };
  }
  if (endMs <= startMs) {
    return {
      error: {
        dayIndex: oneBasedIndex,
        date,
        message: '"end" must be after "start".',
      },
    };
  }

  // Optional pauses. We require both halves of a pair when one is present —
  // a half-open lunch is almost certainly a typo, not intended data.
  const pauses: Array<{ start: number; end: number; label: string }> = [];

  const pauseResult = collectPause(
    dayBase,
    entry.lunchStart,
    entry.lunchEnd,
    "lunch",
  );
  if (pauseResult.error) {
    return { error: { dayIndex: oneBasedIndex, date, message: pauseResult.error } };
  }
  if (pauseResult.pause) pauses.push(pauseResult.pause);

  const breakResult = collectPause(
    dayBase,
    entry.breakStart,
    entry.breakEnd,
    "break",
  );
  if (breakResult.error) {
    return { error: { dayIndex: oneBasedIndex, date, message: breakResult.error } };
  }
  if (breakResult.pause) pauses.push(breakResult.pause);

  // Validate pauses fit inside the working span and don't overlap. Earlier
  // first so the user sees the first issue rather than a cascade.
  pauses.sort((a, b) => a.start - b.start);
  for (let i = 0; i < pauses.length; i++) {
    const p = pauses[i];
    if (p.start < startMs || p.end > endMs) {
      return {
        error: {
          dayIndex: oneBasedIndex,
          date,
          message: `${p.label} (${formatPause(p)}) falls outside the working span.`,
        },
      };
    }
    if (p.start >= p.end) {
      return {
        error: {
          dayIndex: oneBasedIndex,
          date,
          message: `${p.label} end is not after its start.`,
        },
      };
    }
    if (i > 0 && p.start < pauses[i - 1].end) {
      return {
        error: {
          dayIndex: oneBasedIndex,
          date,
          message: `${p.label} overlaps with ${pauses[i - 1].label}.`,
        },
      };
    }
  }

  // Segments = working span minus the (sorted, non-overlapping) pauses.
  const segments: { startMs: number; endMs: number }[] = [];
  let cursor = startMs;
  for (const p of pauses) {
    if (p.start > cursor) segments.push({ startMs: cursor, endMs: p.start });
    cursor = p.end;
  }
  if (cursor < endMs) segments.push({ startMs: cursor, endMs });

  return { parsed: { dayKey: date, segments } };
}

function collectPause(
  dayBase: Date,
  startVal: string | undefined,
  endVal: string | undefined,
  label: "lunch" | "break",
): {
  pause?: { start: number; end: number; label: string };
  error?: string;
} {
  const hasStart = typeof startVal === "string" && startVal.trim() !== "";
  const hasEnd = typeof endVal === "string" && endVal.trim() !== "";
  if (!hasStart && !hasEnd) return {}; // pair absent — not an error
  if (hasStart !== hasEnd) {
    return {
      error: `${label} requires both ${label}Start and ${label}End to be provided.`,
    };
  }
  const start = parseTimeOn(dayBase, startVal);
  const end = parseTimeOn(dayBase, endVal);
  if (start == null) return { error: `Invalid ${label}Start time.` };
  if (end == null) return { error: `Invalid ${label}End time.` };
  return { pause: { start, end, label } };
}

// ── Time / date parsing ─────────────────────────────────────────────────────

function parseLocalDate(yyyymmdd: string): Date | null {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const out = new Date(y, m - 1, d, 0, 0, 0, 0);
  // Round-trip check catches "2024-02-31" and similar.
  if (
    out.getFullYear() !== y ||
    out.getMonth() !== m - 1 ||
    out.getDate() !== d
  ) {
    return null;
  }
  return out;
}

/** Apply `HH:MM`, `H:MM`, or `H:MM AM/PM` to the calendar day of `dayBase`.
 *  Returns null on any failure — caller decides whether that's fatal. */
function parseTimeOn(dayBase: Date, raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // 24-hour
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (m24) {
    const h = Number(m24[1]);
    const m = Number(m24[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return new Date(
      dayBase.getFullYear(),
      dayBase.getMonth(),
      dayBase.getDate(),
      h,
      m,
      0,
      0,
    ).getTime();
  }
  // 12-hour
  const m12 = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(trimmed);
  if (m12) {
    let h = Number(m12[1]);
    const m = Number(m12[2]);
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    h = h % 12;
    if (m12[3].toLowerCase() === "p") h += 12;
    return new Date(
      dayBase.getFullYear(),
      dayBase.getMonth(),
      dayBase.getDate(),
      h,
      m,
      0,
      0,
    ).getTime();
  }
  return null;
}

function formatPause(p: { start: number; end: number }): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  return `${fmt(p.start)} – ${fmt(p.end)}`;
}
