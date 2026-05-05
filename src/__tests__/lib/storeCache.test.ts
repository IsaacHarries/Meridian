import { loadCache, replacer, reviver, saveCache } from "@/lib/storeCache";
import { loadStoreCache, saveStoreCache } from "@/lib/tauri/store-cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri commands that storeCache delegates to
vi.mock("@/lib/tauri/store-cache", () => ({
  saveStoreCache: vi.fn().mockResolvedValue(undefined),
  loadStoreCache: vi.fn().mockResolvedValue(null),
  deleteStoreCache: vi.fn().mockResolvedValue(undefined),
  clearAllStoreCaches: vi.fn().mockResolvedValue(undefined),
  getStoreCacheInfo: vi.fn().mockResolvedValue([]),
}));
// ── replacer ──────────────────────────────────────────────────────────────────

describe("replacer", () => {
  it("serialises a Set to { __set: [...] }", () => {
    const result = replacer("key", new Set([1, 2, 3]));
    expect(result).toEqual({ __set: [1, 2, 3] });
  });

  it("serialises a Map to { __map: [[k,v]...] }", () => {
    const result = replacer("key", new Map([["a", 1], ["b", 2]]));
    expect(result).toEqual({ __map: [["a", 1], ["b", 2]] });
  });

  it("passes through primitives unchanged", () => {
    expect(replacer("k", 42)).toBe(42);
    expect(replacer("k", "hello")).toBe("hello");
    expect(replacer("k", true)).toBe(true);
    expect(replacer("k", null)).toBe(null);
  });

  it("passes through plain arrays unchanged", () => {
    const arr = [1, 2, 3];
    expect(replacer("k", arr)).toBe(arr);
  });

  it("passes through plain objects unchanged", () => {
    const obj = { a: 1 };
    expect(replacer("k", obj)).toBe(obj);
  });
});

// ── reviver ───────────────────────────────────────────────────────────────────

describe("reviver", () => {
  it("reconstructs a Set from { __set: [...] }", () => {
    const result = reviver("key", { __set: [1, 2, 3] });
    expect(result).toBeInstanceOf(Set);
    expect(result).toEqual(new Set([1, 2, 3]));
  });

  it("reconstructs a Map from { __map: [[k,v]...] }", () => {
    const result = reviver("key", { __map: [["a", 1], ["b", 2]] });
    expect(result).toBeInstanceOf(Map);
    expect(result).toEqual(new Map([["a", 1], ["b", 2]]));
  });

  it("passes through plain objects unchanged", () => {
    const obj = { x: 1 };
    expect(reviver("k", obj)).toBe(obj);
  });

  it("passes through primitives unchanged", () => {
    expect(reviver("k", 42)).toBe(42);
    expect(reviver("k", "hi")).toBe("hi");
  });

  it("passes through arrays unchanged", () => {
    const arr = [1, 2];
    expect(reviver("k", arr)).toBe(arr);
  });
});

// ── Set + Map round-trip ──────────────────────────────────────────────────────

describe("Set/Map JSON round-trip", () => {
  it("Set survives JSON.stringify with replacer then JSON.parse with reviver", () => {
    const original = new Set(["a", "b", "c"]);
    const json = JSON.stringify(original, replacer);
    const restored = JSON.parse(json, reviver);
    expect(restored).toBeInstanceOf(Set);
    expect(restored).toEqual(original);
  });

  it("Map survives JSON.stringify with replacer then JSON.parse with reviver", () => {
    const original = new Map([["x", 10], ["y", 20]]);
    const json = JSON.stringify(original, replacer);
    const restored = JSON.parse(json, reviver);
    expect(restored).toBeInstanceOf(Map);
    expect(restored).toEqual(original);
  });

  it("nested Set inside object round-trips correctly", () => {
    const original = { ids: new Set([1, 2]), name: "test" };
    const json = JSON.stringify(original, replacer);
    const restored = JSON.parse(json, reviver);
    expect(restored.ids).toBeInstanceOf(Set);
    expect(restored.ids).toEqual(new Set([1, 2]));
    expect(restored.name).toBe("test");
  });
});

// ── loadCache ─────────────────────────────────────────────────────────────────

describe("loadCache", () => {
  beforeEach(() => {
    vi.mocked(loadStoreCache).mockResolvedValue(null);
  });

  it("returns null when Tauri returns null", async () => {
    vi.mocked(loadStoreCache).mockResolvedValue(null);
    expect(await loadCache("test-key")).toBeNull();
  });

  it("returns null when Tauri returns empty string", async () => {
    vi.mocked(loadStoreCache).mockResolvedValue("");
    expect(await loadCache("test-key")).toBeNull();
  });

  it("returns parsed object when Tauri returns valid JSON", async () => {
    vi.mocked(loadStoreCache).mockResolvedValue(JSON.stringify({ count: 5 }));
    const result = await loadCache<{ count: number }>("test-key");
    expect(result).toEqual({ count: 5 });
  });

  it("returns null without throwing when Tauri returns malformed JSON", async () => {
    vi.mocked(loadStoreCache).mockResolvedValue("{ not valid json }}}");
    await expect(loadCache("test-key")).resolves.toBeNull();
  });

  it("passes correct key to Tauri", async () => {
    await loadCache("my-store");
    expect(loadStoreCache).toHaveBeenCalledWith("my-store");
  });
});

// ── saveCache ─────────────────────────────────────────────────────────────────

describe("saveCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(saveStoreCache).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("does NOT call Tauri immediately", () => {
    saveCache("key", { x: 1 });
    expect(saveStoreCache).not.toHaveBeenCalled();
  });

  it("calls Tauri after the debounce delay", async () => {
    saveCache("key", { x: 1 }, 200);
    expect(saveStoreCache).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(saveStoreCache).toHaveBeenCalledTimes(1);
  });

  it("multiple rapid calls produce only ONE Tauri call", async () => {
    saveCache("key", { x: 1 }, 300);
    saveCache("key", { x: 2 }, 300);
    saveCache("key", { x: 3 }, 300);
    await vi.advanceTimersByTimeAsync(300);
    expect(saveStoreCache).toHaveBeenCalledTimes(1);
  });

  it("serialises the final value (last write wins)", async () => {
    saveCache("key", { x: 1 }, 300);
    saveCache("key", { x: 99 }, 300);
    await vi.advanceTimersByTimeAsync(300);
    const [, json] = vi.mocked(saveStoreCache).mock.calls[0];
    expect(JSON.parse(json)).toEqual({ x: 99 });
  });

  it("uses Set/Map replacer when serialising", async () => {
    saveCache("key", { ids: new Set([1, 2]) }, 100);
    await vi.advanceTimersByTimeAsync(100);
    const [, json] = vi.mocked(saveStoreCache).mock.calls[0];
    const parsed = JSON.parse(json);
    expect(parsed.ids).toEqual({ __set: [1, 2] });
  });
});
