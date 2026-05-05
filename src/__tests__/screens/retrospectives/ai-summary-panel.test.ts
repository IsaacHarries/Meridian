import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "@/screens/retrospectives/ai-summary-panel";

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-05-04T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps under a minute old", () => {
    const iso = new Date(NOW - 30_000).toISOString();
    expect(formatRelativeTime(iso)).toBe("just now");
  });

  it("returns minutes for under an hour", () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatRelativeTime(new Date(NOW - 59 * 60_000).toISOString())).toBe("59m ago");
  });

  it("returns hours for under a day", () => {
    expect(formatRelativeTime(new Date(NOW - 60 * 60_000).toISOString())).toBe("1h ago");
    expect(formatRelativeTime(new Date(NOW - 23 * 60 * 60_000).toISOString())).toBe("23h ago");
  });

  it("returns days for under a month", () => {
    expect(formatRelativeTime(new Date(NOW - 24 * 60 * 60_000).toISOString())).toBe("1d ago");
    expect(formatRelativeTime(new Date(NOW - 29 * 24 * 60 * 60_000).toISOString())).toBe("29d ago");
  });

  it("falls back to a calendar date for >=30 days", () => {
    const iso = new Date(NOW - 60 * 24 * 60 * 60_000).toISOString();
    // Locale-dependent — just assert it doesn't return "Xd ago" and includes a digit.
    const out = formatRelativeTime(iso);
    expect(out).not.toMatch(/d ago$/);
    expect(out).toMatch(/\d/);
  });

  it("returns empty string for an unparseable input", () => {
    expect(formatRelativeTime("not a date")).toBe("");
  });
});
