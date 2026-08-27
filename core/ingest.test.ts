import { describe, expect, test } from "bun:test";
import { identityOf, parseIngest } from "./ingest";

const H = 3600;
const NOW = 1_755_072_000; // fixed instant; the math must never read the clock

describe("parseIngest", () => {
  test("accepts well-formed readings for both windows", () => {
    const r = parseIngest(
      {
        rate_limits: {
          five_hour: { used_percentage: 12.5, resets_at: NOW + 4 * H },
          seven_day: { used_percentage: 23, resets_at: NOW + 6 * 24 * H },
        },
      },
      NOW,
    );
    expect(r.hadLimits).toBe(true);
    expect(r.rejected).toBe(0);
    expect(r.samples).toHaveLength(2);
    expect(r.samples[0]).toEqual({
      window: "five_hour",
      pct: 12.5,
      resets_at: NOW + 4 * H,
    });
  });

  test("rounds float-noise percentages before storing", () => {
    const r = parseIngest(
      {
        rate_limits: {
          five_hour: { used_percentage: 7.000000000000001, resets_at: NOW + 4 * H },
        },
      },
      NOW,
    );
    expect(r.samples[0].pct).toBe(7);
  });

  test("skips readings with wrong types without counting them rejected", () => {
    // Collectors forward whatever Claude Code handed it; an unusable block is
    // expected before the session's first API response.
    const r = parseIngest(
      {
        rate_limits: {
          five_hour: { used_percentage: "12", resets_at: NOW + 4 * H },
          seven_day: { used_percentage: Number.NaN, resets_at: NOW + 4 * H },
        },
      },
      NOW,
    );
    expect(r.samples).toHaveLength(0);
    expect(r.rejected).toBe(0);
    expect(r.hadLimits).toBe(true);
  });

  test("rejects a reset dated years out, which would hide every real window", () => {
    const r = parseIngest(
      {
        rate_limits: {
          seven_day: { used_percentage: 23, resets_at: NOW + 365 * 24 * H },
        },
      },
      NOW,
    );
    expect(r.samples).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });

  test("rejects percentages outside 0-100", () => {
    const r = parseIngest(
      {
        rate_limits: {
          five_hour: { used_percentage: -5, resets_at: NOW + 4 * H },
          seven_day: { used_percentage: 150, resets_at: NOW + 6 * 24 * H },
        },
      },
      NOW,
    );
    expect(r.samples).toHaveLength(0);
    expect(r.rejected).toBe(2);
  });

  test("tolerates a day of clock skew on the reset date", () => {
    const r = parseIngest(
      {
        rate_limits: {
          five_hour: {
            used_percentage: 10,
            resets_at: NOW + 5 * H + 86_400 - 60,
          },
        },
      },
      NOW,
    );
    expect(r.rejected).toBe(0);
    expect(r.samples).toHaveLength(1);
  });

  test("a payload without rate_limits is not an error, only a reason", () => {
    const r = parseIngest({ session_id: "abc" }, NOW);
    expect(r.hadLimits).toBe(false);
    expect(r.samples).toHaveLength(0);
  });

  test("a non-object body is treated as no rate_limits, not a crash", () => {
    for (const body of [null, "string", 42, []]) {
      const r = parseIngest(body, NOW);
      expect(r.hadLimits).toBe(false);
      expect(r.samples).toHaveLength(0);
      expect(r.rejected).toBe(0);
    }
  });
});

describe("identityOf", () => {
  const body = {
    session_id: "s".repeat(200),
    model: { id: "claude-opus-4", display_name: "Opus" },
  };

  test("caps the host header at 64 characters", () => {
    const who = identityOf("h".repeat(200), body);
    expect(who.host).toHaveLength(64);
  });

  test("caps the session id and model at 128 characters", () => {
    const who = identityOf("desktop", body);
    expect(who.sessionId).toHaveLength(128);
    expect(who.model).toBe("claude-opus-4");
  });

  test("non-string fields are dropped rather than coerced", () => {
    const who = identityOf("desktop", {
      session_id: 12345,
      model: { id: null, display_name: undefined },
    });
    expect(who.sessionId).toBeNull();
    expect(who.model).toBeNull();
  });
});