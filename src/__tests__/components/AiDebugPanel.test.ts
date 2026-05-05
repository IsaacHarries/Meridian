import { describe, expect, it } from "vitest";
import {
  combineDateTime,
  filterEventsByTimeRange,
  type TimeRangeFilter,
} from "@/components/AiDebugPanel";
import type { AiTrafficEvent } from "@/stores/aiDebugStore";

function makeEvent(startedAt: number): AiTrafficEvent {
  return {
    runId: "r",
    startedAt,
    latencyMs: 0,
    provider: "p",
    model: "m",
    workflow: "w",
    messages: [],
    response: "",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

const EMPTY: TimeRangeFilter = { fromDate: "", fromTime: "", toDate: "", toTime: "" };

describe("combineDateTime", () => {
  it("returns null for empty date (caller treats that side as unbounded)", () => {
    expect(combineDateTime("", "", "00:00")).toBe(null);
    expect(combineDateTime("", "12:30", "00:00")).toBe(null);
  });

  it("returns null for malformed input", () => {
    expect(combineDateTime("not-a-date", "", "00:00")).toBe(null);
  });

  it("uses the fallback time when time is blank", () => {
    const ms = combineDateTime("2026-05-04", "", "00:00")!;
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May (0-indexed)
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("uses the supplied time when one is given", () => {
    const ms = combineDateTime("2026-05-04", "13:45", "00:00")!;
    const d = new Date(ms);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(45);
  });

  it("supports the end-of-day fallback for upper-bound usage", () => {
    const ms = combineDateTime("2026-05-04", "", "23:59:59.999")!;
    const d = new Date(ms);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });

  it("interprets the date in the local timezone (not UTC)", () => {
    // The user's "May 4 at midnight" should be local midnight, regardless
    // of UTC offset. If we accidentally constructed via new Date(iso),
    // the date would shift in non-UTC timezones.
    const ms = combineDateTime("2026-05-04", "00:00", "00:00")!;
    const d = new Date(ms);
    expect(d.getDate()).toBe(4);
  });
});

describe("filterEventsByTimeRange", () => {
  // Three sample events on May 4, 2026 at 09:00, 12:00, and 18:00 local.
  const t0900 = new Date(2026, 4, 4, 9, 0, 0).getTime();
  const t1200 = new Date(2026, 4, 4, 12, 0, 0).getTime();
  const t1800 = new Date(2026, 4, 4, 18, 0, 0).getTime();
  const events = [makeEvent(t0900), makeEvent(t1200), makeEvent(t1800)];

  it("returns the input unchanged when no filter is active", () => {
    expect(filterEventsByTimeRange(events, EMPTY)).toBe(events);
  });

  it("date-only From filter covers the whole From day onward", () => {
    const filter: TimeRangeFilter = { ...EMPTY, fromDate: "2026-05-04" };
    expect(filterEventsByTimeRange(events, filter)).toHaveLength(3);
  });

  it("date+time From filter excludes earlier events on the same day", () => {
    const filter: TimeRangeFilter = { ...EMPTY, fromDate: "2026-05-04", fromTime: "10:00" };
    const out = filterEventsByTimeRange(events, filter);
    expect(out.map((e) => e.startedAt)).toEqual([t1200, t1800]);
  });

  it("date-only To filter covers up to end-of-day on the To date", () => {
    const filter: TimeRangeFilter = { ...EMPTY, toDate: "2026-05-04" };
    expect(filterEventsByTimeRange(events, filter)).toHaveLength(3);
  });

  it("date+time To filter excludes later events on the same day", () => {
    const filter: TimeRangeFilter = { ...EMPTY, toDate: "2026-05-04", toTime: "13:00" };
    const out = filterEventsByTimeRange(events, filter);
    expect(out.map((e) => e.startedAt)).toEqual([t0900, t1200]);
  });

  it("combined From + To filter restricts to the intersection", () => {
    const filter: TimeRangeFilter = {
      fromDate: "2026-05-04", fromTime: "10:00",
      toDate: "2026-05-04",   toTime: "15:00",
    };
    const out = filterEventsByTimeRange(events, filter);
    expect(out.map((e) => e.startedAt)).toEqual([t1200]);
  });

  it("returns empty when the range excludes every event", () => {
    const filter: TimeRangeFilter = {
      fromDate: "2026-05-05", fromTime: "",
      toDate: "2026-05-05",   toTime: "",
    };
    expect(filterEventsByTimeRange(events, filter)).toHaveLength(0);
  });

  it("ignores fromTime when fromDate is blank (unbounded lower)", () => {
    const filter: TimeRangeFilter = { ...EMPTY, fromTime: "10:00" };
    expect(filterEventsByTimeRange(events, filter)).toBe(events);
  });
});
