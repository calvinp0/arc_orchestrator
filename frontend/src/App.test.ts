import { describe, expect, it } from "vitest";
import { shouldUseCompactLayout } from "./lib/layout";

describe("shouldUseCompactLayout", () => {
  it("returns true when width is below threshold", () => {
    expect(shouldUseCompactLayout(1024, 1200)).toBe(true);
  });

  it("returns true when height is below threshold", () => {
    expect(shouldUseCompactLayout(1400, 820)).toBe(true);
  });

  it("returns false when both dimensions exceed thresholds", () => {
    expect(shouldUseCompactLayout(1600, 1000)).toBe(false);
  });

  it("treats boundary values as compact", () => {
    expect(shouldUseCompactLayout(1280, 950)).toBe(true);
    expect(shouldUseCompactLayout(1500, 900)).toBe(true);
  });
});
