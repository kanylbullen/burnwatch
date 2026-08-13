/**
 * Burn-rate + forecast math.
 *
 * Input is a time series of `used_percentage` samples for one rate-limit
 * window, all sharing the same `resets_at`. Percentage climbs monotonically
 * inside a window and drops to ~0 when the window rolls over.
 *
 * Gaps in the series are *meaningful*: samples only arrive while Claude Code
 * is running, and usage only accrues while it runs. So a 6-hour gap is 6 hours
 * of genuinely zero burn, not missing data. Every rate below is therefore
 * computed against wall-clock elapsed time, never against sample count.
 */

export type Sample = {
  ts: number; // epoch seconds
  pct: number; // 0-100
  resets_at: number; // epoch seconds
};

export type Verdict = "speed_up" | "on_pace" | "runs_out" | "unknown";

export type WindowState = {
  pct: number;
  resets_at: number;
  resets_in_s: number;
  /** Nominal window length, so clients can place an even-pace reference mark. */
  window_length_s: number;
  /** Observed burn over the lookback, in percentage points per hour. */
  rate_pct_per_h: number;
  /** Burn needed from now to land exactly on 100% at reset. */
  required_pct_per_h: number;
  /** rate / required. <1 means you will not use the whole allowance. */
  pace_ratio: number;
  verdict: Verdict;
  /** Only when verdict === "speed_up": multiplier needed to max out. */
  speed_up_x: number | null;
  /** Only when verdict === "runs_out": epoch seconds the allowance hits 100%. */
  runs_out_at: number | null;
  /** Only when verdict === "runs_out": how long before reset it runs dry. */
  early_by_s: number | null;
  /** Percentage points accrued since local midnight. */
  used_today_pct: number | null;
  samples: number;
  /**
   * Seconds since the percentage last moved. This is an idleness signal, not a
   * health signal — collectors keep reporting through a flat stretch, and those
   * repeats are deduped away. For liveness use `last_contact_s` on the reply.
   */
  last_change_s: number;
};

const H = 3600;

/**
 * Shortest span that can support a rate. Two readings seconds apart at the
 * start of a window would otherwise divide a real delta by almost nothing and
 * forecast an immediate run-out.
 */
const MIN_SPAN_S = 300;

/**
 * Forces the series to climb, by carrying a running maximum forward.
 *
 * Usage inside a window only ever increases, but readings arrive from many
 * machines and a lagging one reports a percentage from minutes ago. Taken at
 * face value that dip drags the current reading backwards, halves the measured
 * burn and can cancel a run-out warning.
 */
function monotonic(samples: Sample[]): Sample[] {
  let high = -Infinity;
  return samples.map((s) => {
    high = Math.max(high, s.pct);
    return high === s.pct ? s : { ...s, pct: high };
  });
}

/** Newest sample at or before `at`. Assumes the series is already monotonic. */
function sampleAt(samples: Sample[], at: number): Sample | null {
  let found: Sample | null = null;
  for (const s of samples) {
    if (s.ts <= at) found = s;
    else break;
  }
  return found;
}

/**
 * Average burn over the lookback window, in points/hour.
 *
 * Measures to `now`, not to the newest sample: the quiet hours after you stop
 * coding are part of your pace, and ending the span at the last sample would
 * report a burst rate that never decays while you are away.
 *
 * When the series does not reach a full lookback back, it measures across
 * whatever span is actually observed. Anchoring instead at the window's 0%
 * start would average a recent burst over days of history and forecast far
 * too slow a burn.
 *
 * The anchor is dated by when its reading was actually taken, never by the
 * start of the lookback. With sparse samples the newest reading at-or-before
 * that boundary can be hours older than the boundary itself, and pretending
 * otherwise divides a delta accumulated over that whole stretch by the
 * lookback alone — inflating the pace and inventing run-out warnings.
 */
function burnRate(samples: Sample[], now: number, lookbackS: number): number {
  if (samples.length === 0) return 0;
  const latest = samples[samples.length - 1];

  const anchor = sampleAt(samples, now - lookbackS) ?? samples[0];
  const elapsed = now - anchor.ts;
  if (elapsed < MIN_SPAN_S) return 0;

  const delta = latest.pct - anchor.pct;
  // The series is monotonic by construction, so this cannot go negative — but
  // stay defensive rather than emit a negative rate if that ever changes.
  if (delta < 0) return 0;
  return (delta / elapsed) * H;
}

/** Start of the local day containing `ts`, as epoch seconds. */
export function localMidnight(ts: number, timeZone: string): number {
  const d = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  // Seconds elapsed in the local day, subtracted from the instant itself.
  const secsIntoDay = (g("hour") % 24) * H + g("minute") * 60 + g("second");
  return ts - secsIntoDay;
}

export type ComputeOpts = {
  now: number;
  timeZone: string;
  /** How far back to measure current pace. */
  lookbackS: number;
  /** Window length, used to infer where the current window started. */
  windowLengthS: number;
  /** Below this pace ratio the verdict is "speed_up" rather than "on_pace". */
  onPaceLow: number;
  /** Above this ratio it is "runs_out". */
  onPaceHigh: number;
};

export function computeWindow(
  all: Sample[],
  opts: ComputeOpts,
): WindowState | null {
  if (all.length === 0) return null;

  const { now, lookbackS } = opts;
  const sorted = [...all].sort((a, b) => a.ts - b.ts);

  // The current window is the one reaching furthest into the future, not the
  // one named by the newest sample: a lagging machine can deliver an old
  // window's `resets_at` with a fresh timestamp, and taking that at face value
  // would resurrect a dead window and discard the real history.
  const currentResetsAt = Math.max(...sorted.map((s) => s.resets_at));

  // Past its reset the window no longer exists, and no reading has arrived for
  // its successor. Publishing the old percentage here is what made the widget
  // show a stale figure with "0M TO RESET" all night, and — once the required
  // pace divided by a zero remainder — announce MAXED OUT at any percentage.
  // Having no reading is the truth, and the clients already render it.
  if (currentResetsAt <= now) return null;

  const samples = monotonic(
    sorted.filter((s) => s.resets_at === currentResetsAt),
  );
  const latest = samples[samples.length - 1];
  const windowStart = currentResetsAt - opts.windowLengthS;

  const resetsInS = currentResetsAt - now;
  const remainingPct = Math.max(0, 100 - latest.pct);

  const rate = burnRate(samples, now, lookbackS);
  const requiredRate = resetsInS > 0 ? (remainingPct / resetsInS) * H : Infinity;

  const paceRatio = requiredRate > 0 && Number.isFinite(requiredRate)
    ? rate / requiredRate
    : rate > 0
    ? Infinity
    : 0;

  let verdict: Verdict;
  let speedUpX: number | null = null;
  let runsOutAt: number | null = null;
  let earlyByS: number | null = null;

  if (remainingPct <= 0) {
    verdict = "runs_out";
    runsOutAt = now;
    earlyByS = resetsInS;
  } else if (rate <= 0) {
    verdict = "speed_up";
    speedUpX = null; // Cannot scale a zero pace into a finite multiplier.
  } else if (paceRatio > opts.onPaceHigh) {
    verdict = "runs_out";
    const hoursTo100 = remainingPct / rate;
    runsOutAt = Math.round(now + hoursTo100 * H);
    earlyByS = Math.max(0, latest.resets_at - runsOutAt);
  } else if (paceRatio < opts.onPaceLow) {
    verdict = "speed_up";
    speedUpX = requiredRate / rate;
  } else {
    verdict = "on_pace";
  }

  // Today's accrual.
  //
  // The old code read a missing sample at midnight as "the window stood at 0%",
  // which is only true when the window opened today. Whenever the series simply
  // did not reach that far back — a fresh install, a restart, a gap — it
  // reported the entire window total as today's, and the widget claimed
  // "+60% USED TODAY" for something closer to 4%.
  const midnight = localMidnight(now, opts.timeZone);
  let usedToday: number | null;
  if (windowStart >= midnight) {
    // The window opened after midnight, so everything in it was spent today.
    usedToday = latest.pct;
  } else {
    const atMidnight = sampleAt(samples, midnight);
    usedToday =
      atMidnight === null ? null : Math.max(0, latest.pct - atMidnight.pct);
  }

  return {
    pct: latest.pct,
    resets_at: latest.resets_at,
    resets_in_s: resetsInS,
    window_length_s: opts.windowLengthS,
    rate_pct_per_h: round(rate, 4),
    required_pct_per_h: Number.isFinite(requiredRate)
      ? round(requiredRate, 4)
      : 0,
    pace_ratio: Number.isFinite(paceRatio) ? round(paceRatio, 4) : 0,
    verdict,
    speed_up_x: speedUpX === null ? null : round(speedUpX, 2),
    runs_out_at: runsOutAt,
    early_by_s: earlyByS,
    used_today_pct: usedToday === null ? null : round(usedToday, 2),
    samples: samples.length,
    last_change_s: Math.max(0, now - latest.ts),
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
