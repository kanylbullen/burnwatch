import { expect, test } from "bun:test";
import { computeWindow, localMidnight, type Sample } from "./compute";

const H = 3600;
const WEEK = 7 * 24 * H;
const NOW = 1_755_072_000; // fixed instant; the math must never read the clock

const opts = {
  now: NOW,
  timeZone: "Europe/Stockholm",
  lookbackS: 24 * H,
  windowLengthS: WEEK,
  onPaceLow: 0.9,
  onPaceHigh: 1.0,
};

/** Even burn from `fromPct` to `toPct` across the last `hours`, one sample/10min. */
function ramp(
  fromPct: number,
  toPct: number,
  hours: number,
  resetsAt: number,
): Sample[] {
  const out: Sample[] = [];
  const steps = hours * 6;
  for (let i = 0; i <= steps; i++) {
    out.push({
      ts: NOW - hours * H + (i * hours * H) / steps,
      pct: fromPct + ((toPct - fromPct) * i) / steps,
      resets_at: resetsAt,
    });
  }
  return out;
}

test("reproduces the reference device: 23% weekly, 47h left, +5%/day -> ~7.5x", () => {
  const resetsAt = NOW + 47 * H;
  const s = computeWindow(ramp(18, 23, 24, resetsAt), opts)!;

  expect(s.pct).toBe(23);
  expect(s.resets_in_s).toBe(47 * H);
  expect(s.used_today_pct).not.toBeNull();

  // 77 points remaining over 47h = 1.638 %/h required.
  expect(s.required_pct_per_h).toBeCloseTo(77 / 47, 3);
  // 5 points over 24h = 0.2083 %/h observed.
  expect(s.rate_pct_per_h).toBeCloseTo(5 / 24, 3);

  expect(s.verdict).toBe("speed_up");
  // The device rounded "+5%" for display, so 7.5x is the rounded form of 7.86x.
  expect(s.speed_up_x!).toBeGreaterThan(7);
  expect(s.speed_up_x!).toBeLessThan(8.5);
});

test("burning hot forecasts a run-out before reset", () => {
  const resetsAt = NOW + 47 * H;
  // 40 points in 12h = 3.33 %/h; 20 points left lasts ~6h.
  const s = computeWindow(ramp(40, 80, 12, resetsAt), opts)!;

  expect(s.verdict).toBe("runs_out");
  expect(s.runs_out_at).not.toBeNull();
  expect((s.runs_out_at! - NOW) / H).toBeCloseTo(20 / (40 / 12), 1);
  expect(s.early_by_s!).toBeGreaterThan(0);
  expect(s.early_by_s!).toBe(resetsAt - s.runs_out_at!);
});

test("idle gaps count as real zero-burn time, not missing data", () => {
  const resetsAt = NOW + 47 * H;
  // Heavy burn 24h ago, then nothing at all for 20h.
  const s = computeWindow(
    [
      { ts: NOW - 24 * H, pct: 10, resets_at: resetsAt },
      { ts: NOW - 20 * H, pct: 30, resets_at: resetsAt },
    ],
    opts,
  )!;

  // 20 points across the full 24h lookback, NOT across the 4h of activity.
  expect(s.rate_pct_per_h).toBeCloseTo(20 / 24, 3);
  expect(s.last_change_s).toBe(20 * H);
});

test("a window rollover does not leak into the current window", () => {
  const oldReset = NOW - 10 * H;
  const newReset = NOW + WEEK - 10 * H;
  const s = computeWindow(
    [
      { ts: NOW - 30 * H, pct: 95, resets_at: oldReset }, // previous week
      { ts: NOW - 9 * H, pct: 1, resets_at: newReset },
      { ts: NOW - 1 * H, pct: 4, resets_at: newReset },
    ],
    opts,
  )!;

  expect(s.pct).toBe(4);
  expect(s.samples).toBe(2); // the 95% sample belongs to a dead window
  expect(s.rate_pct_per_h).toBeGreaterThan(0);
  expect(s.used_today_pct).toBeGreaterThanOrEqual(0);
});

test("no measurable burn yields speed_up without a bogus multiplier", () => {
  const resetsAt = NOW + 47 * H;
  const s = computeWindow(
    [{ ts: NOW - 2 * H, pct: 12, resets_at: resetsAt }],
    opts,
  )!;

  expect(s.rate_pct_per_h).toBe(0);
  expect(s.verdict).toBe("speed_up");
  expect(s.speed_up_x).toBeNull(); // dividing by a zero pace is not a number to show
});

test("an exhausted window reports as already run out", () => {
  const resetsAt = NOW + 5 * H;
  const s = computeWindow(ramp(90, 100, 6, resetsAt), opts)!;

  expect(s.verdict).toBe("runs_out");
  expect(s.runs_out_at).toBe(NOW);
  expect(s.early_by_s).toBe(5 * H);
});

test("a window past its reset is not served as a live reading", () => {
  // The 5-hour window expires nightly while nobody is coding. It used to keep
  // publishing the dead window's percentage with resets_in_s clamped to 0.
  const s = computeWindow(
    [
      { ts: NOW - 3 * H, pct: 41, resets_at: NOW - 1 * H },
      { ts: NOW - 90 * 60, pct: 41, resets_at: NOW - 1 * H },
    ],
    opts,
  );
  expect(s).toBeNull();
});

test("an expired window cannot manufacture MAXED OUT at a middling percentage", () => {
  // With resets_in_s clamped to zero the required pace divided by nothing,
  // giving verdict=runs_out and early_by_s=0, which the widget prints as
  // "MAXED OUT" beside a reset time already in the past.
  const s = computeWindow(ramp(30, 42, 2, NOW - 60), opts);
  expect(s).toBeNull();
});

test("a lagging machine's old window does not resurrect it", () => {
  const live = NOW + 47 * H;
  const dead = NOW - 10 * H;
  const s = computeWindow(
    [
      { ts: NOW - 2 * H, pct: 38, resets_at: live },
      { ts: NOW - 1 * H, pct: 40, resets_at: live },
      // Arrives newest, but names a window that ended hours ago.
      { ts: NOW - 60, pct: 95, resets_at: dead },
    ],
    opts,
  )!;

  expect(s.resets_at).toBe(live);
  expect(s.pct).toBe(40);
  expect(s.samples).toBe(2);
});

test("a lagging reading inside the window cannot drag the percentage backwards", () => {
  const resetsAt = NOW + 47 * H;
  const s = computeWindow(
    [
      { ts: NOW - 2 * H, pct: 30, resets_at: resetsAt },
      { ts: NOW - 1 * H, pct: 50, resets_at: resetsAt },
      { ts: NOW - 30 * 60, pct: 45, resets_at: resetsAt }, // stale peer
    ],
    opts,
  )!;

  expect(s.pct).toBe(50);
  // 20 points across the 2h observed span, not 15 as the dip would imply.
  expect(s.rate_pct_per_h).toBeCloseTo(10, 3);
});

test("a sparse series is dated by its real anchor, not by the lookback edge", () => {
  const resetsAt = NOW + 47 * H;
  const s = computeWindow(
    [
      { ts: NOW - 40 * H, pct: 10, resets_at: resetsAt },
      { ts: NOW - 5 * 60, pct: 30, resets_at: resetsAt },
    ],
    opts,
  )!;

  // 20 points across the 40h that actually elapsed. Dating the anchor at the
  // 24h lookback edge instead would report 0.83 %/h — 1.7x too fast.
  expect(s.rate_pct_per_h).toBeCloseTo(20 / 40, 3);
});

test("a window seconds old does not produce an unbounded rate", () => {
  const s = computeWindow(
    [
      { ts: NOW - 60, pct: 0, resets_at: NOW + 5 * H },
      { ts: NOW - 10, pct: 5, resets_at: NOW + 5 * H },
    ],
    { ...opts, lookbackS: 1 * H },
  )!;

  // 5 points in 50 seconds is 360 %/h, which would forecast an instant run-out.
  expect(s.rate_pct_per_h).toBe(0);
  expect(s.verdict).toBe("speed_up");
});

test("used_today is null when the series does not reach back to midnight", () => {
  // NOW is 10:00 in Stockholm, so midnight is NOW-10h. This weekly window
  // opened days ago and the only reading is two hours old, so how much of it
  // was spent today is simply unknown.
  const s = computeWindow(
    [{ ts: NOW - 2 * H, pct: 56, resets_at: NOW + 47 * H }],
    opts,
  )!;

  expect(s.used_today_pct).toBeNull();
});

test("used_today is the whole reading when the window opened after midnight", () => {
  // A 5-hour window resetting in 1h opened at NOW-4h, which is after local
  // midnight — so everything in it was necessarily spent today.
  const s = computeWindow(ramp(0, 12, 3, NOW + 1 * H), {
    ...opts,
    lookbackS: 1 * H,
    windowLengthS: 5 * H,
  })!;

  expect(s.used_today_pct).toBeCloseTo(12, 3);
});

test("local midnight respects the configured zone, not the server's UTC clock", () => {
  // 2025-08-13T08:00:00Z is 10:00 in Stockholm (CEST, UTC+2).
  const t = Date.UTC(2025, 7, 13, 8, 0, 0) / 1000;
  const mid = localMidnight(t, "Europe/Stockholm");
  expect(t - mid).toBe(10 * H);
  expect(t - localMidnight(t, "UTC")).toBe(8 * H);
});
