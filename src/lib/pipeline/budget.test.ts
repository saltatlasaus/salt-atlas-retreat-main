import { describe, expect, it } from "vitest";
import { costGbp } from "./budget";

describe("pipeline budget", () => {
  it("converts Haiku token usage to GBP", () => {
    expect(costGbp(1_000_000, 0, "claude-haiku-5-5")).toBeCloseTo(0.078, 5);
    expect(costGbp(0, 200_000, "claude-haiku-5-5")).toBeCloseTo(0.078, 5);
  });
  it("if a stronger model is opted into, prices it higher so the daily cap reflects the real spend", () => {
    expect(costGbp(1_000_000, 0, "claude-sonnet-5-5")).toBeGreaterThan(costGbp(1_000_000, 0, "claude-haiku-5-5") * 10);
  });
});
