import { describe, expect, test } from "vitest";

import {
  formatResetIn,
  parseRateLimitsFromJsonLines,
  parseRateLimitsFromText,
} from "../../src/core/status.js";

describe("status parsing", () => {
  test("extracts 5-hour and weekly percentages from Codex JSONL token_count events", () => {
    const output = [
      "{\"type\":\"thread.started\"}",
      JSON.stringify({
        type: "token_count",
        info: null,
        rate_limits: {
          primary: {
            used_percent: 68,
            window_minutes: 300,
            resets_at: 1_775_000_840,
          },
          secondary: {
            used_percent: 41,
            window_minutes: 10_080,
            resets_at: 1_775_598_000,
          },
          plan_type: "plus",
        },
      }),
    ].join("\n");

    const parsed = parseRateLimitsFromJsonLines(output, new Date("2026-04-01T00:00:00.000Z"));

    expect(parsed.fiveHourUsedPct).toBe(68);
    expect(parsed.weeklyUsedPct).toBe(41);
    expect(parsed.resetIn).toBeTruthy();
    expect(parsed.rawLimitSource).toContain("token_count");
  });

  test("falls back to text parsing when structured JSON is unavailable", () => {
    const parsed = parseRateLimitsFromText(
      "Usage: 5h window 12% used, weekly 77% used, resets in 52m",
    );

    expect(parsed.fiveHourUsedPct).toBe(12);
    expect(parsed.weeklyUsedPct).toBe(77);
    expect(parsed.resetIn).toBe("52m");
  });

  test("formats short reset windows for human readable output", () => {
    const now = new Date("2026-04-01T00:00:00.000Z");
    const later = Math.floor(new Date("2026-04-01T00:14:00.000Z").getTime() / 1000);

    expect(formatResetIn(later, now)).toBe("14m");
  });
});
