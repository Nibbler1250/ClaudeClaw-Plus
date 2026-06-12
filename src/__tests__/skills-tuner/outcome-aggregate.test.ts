import { describe, it, expect } from "bun:test";
import { median, trimmedMean, nonzeroRate } from "../../skills-tuner/core/aggregate.js";

describe("aggregate — outlier robustness", () => {
  it("median ignores a single huge outlier", () => {
    // a debug/migration session spikes cost; median is unmoved
    expect(median([1, 2, 3, 4, 1000])).toBe(3);
  });

  it("median averages the middle two for even length", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("median of empty is 0", () => {
    expect(median([])).toBe(0);
  });

  it("trimmedMean drops extremes", () => {
    // 0 and 1000 trimmed at 10% each → mean of the rest
    const xs = [0, 5, 6, 7, 8, 9, 10, 11, 12, 1000];
    const tm = trimmedMean(xs, 0.1);
    expect(tm).toBeLessThan(50);
    expect(tm).toBeGreaterThan(5);
  });

  it("trimmedMean falls back to median when trim would empty", () => {
    expect(trimmedMean([42], 0.4)).toBe(42);
  });

  it("nonzeroRate computes error rate", () => {
    expect(nonzeroRate([0, 0, 1, 1])).toBe(0.5);
    expect(nonzeroRate([])).toBe(0);
  });
});
