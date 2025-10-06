import { describe, expect, it } from "vitest";
import {
  buildWindowCacheKey,
  clearWindowCacheForSession,
  pruneWindowCache,
  renameSessionInCache,
} from "../../lib/windowCache";

describe("window cache helpers", () => {
  it("builds cache keys using ids when available", () => {
    expect(buildWindowCacheKey("local", "alpha", 0)).toBe("local/alpha/idx:0");
    expect(buildWindowCacheKey("scope", "beta", 2, "@7")).toBe("scope/beta/id:@7");
    expect(buildWindowCacheKey("scope", "beta", 3, "  %12  ")).toBe("scope/beta/id:%12");
  });

  it("prunes keys that no longer match windows", () => {
    const cache = new Map<string, string>([
      ["scope/a/id:1", "one"],
      ["scope/a/idx:0", "zero"],
      ["scope/b/idx:1", "other"],
    ]);

    pruneWindowCache(cache, "scope", "a", [
      { index: 0 },
      { index: 2, id: "%99" },
    ]);

    expect(cache.size).toBe(2);
    expect(cache.get("scope/a/idx:0")).toBe("zero");
    expect(cache.has("scope/a/id:1")).toBe(false);
    expect(cache.get("scope/b/idx:1")).toBe("other");
  });

  it("clears all keys for a given session", () => {
    const cache = new Map<string, string>([
      ["scope/a/idx:0", "zero"],
      ["scope/a/id:11", "one"],
      ["scope/b/idx:1", "other"],
    ]);

    clearWindowCacheForSession(cache, "scope", "a");

    expect(cache.has("scope/a/idx:0")).toBe(false);
    expect(cache.has("scope/a/id:11")).toBe(false);
    expect(cache.get("scope/b/idx:1")).toBe("other");
  });

  it("renames session prefixes without losing values", () => {
    const cache = new Map<string, string>([
      ["scope/a/idx:0", "zero"],
      ["scope/a/id:%5", "five"],
      ["scope/b/idx:1", "other"],
    ]);

    renameSessionInCache(cache, "scope", "a", "alpha");

    expect(cache.get("scope/alpha/idx:0")).toBe("zero");
    expect(cache.get("scope/alpha/id:%5")).toBe("five");
    expect(cache.get("scope/b/idx:1")).toBe("other");
    expect(cache.has("scope/a/idx:0")).toBe(false);
  });
});
