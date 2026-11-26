/**
 * Builds `core/fixtures/hub.json`: inputs and the outputs core/compute.ts and
 * core/ingest.ts produce for them.
 *
 *   bun run hub:fixtures
 *
 * The desktop hub (hub/, Rust) reimplements both, because it has to keep
 * computing and publishing while its window is hidden, and a webview's
 * scripts are throttled then. Its tests replay these cases and must match
 * every number exactly, so the forecast on the desk can never disagree with
 * the one the Worker or the daemon would have served.
 *
 * Cases are hand-written scenarios plus a seeded random sweep; the seed is
 * fixed, so the file only changes when the TypeScript does.
 */

import { computeWindow, localMidnight, type Sample } from "./compute";
import { DEFAULTS, WINDOW_LENGTH } from "./defaults";
import { identityOf, parseIngest } from "./ingest";

const H = 3600;
const WEEK = WINDOW_LENGTH.seven_day;
const NOW = 1_755_072_000;

/** mulberry32: small, seedable, and the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES = [
  "Europe/Stockholm",
  "UTC",
  "America/New_York",
  "Asia/Kolkata",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "America/St_Johns",
];

type Opts = Parameters<typeof computeWindow>[1];

function ramp(from: number, to: number, hours: number, resetsAt: number, now = NOW): Sample[] {
  const out: Sample[] = [];
  const steps = hours * 6;
  for (let i = 0; i <= steps; i++) {
    out.push({
      ts: now - hours * H + (i * hours * H) / steps,
      pct: from + ((to - from) * i) / steps,
      resets_at: resetsAt,
    });
  }
  return out;
}

const base = (now = NOW, timeZone = "Europe/Stockholm"): Opts => ({
  now,
  timeZone,
  lookbackS: DEFAULTS.lookback.seven_day,
  windowLengthS: WEEK,
  onPaceLow: DEFAULTS.onPaceLow,
  onPaceHigh: DEFAULTS.onPaceHigh,
});

function computeCases() {
  const cases: { name: string; samples: Sample[]; opts: Opts }[] = [];
  const add = (name: string, samples: Sample[], opts = base()) => cases.push({ name, samples, opts });

  add("empty", []);
  add("reference device", ramp(18, 23, 24, NOW + 47 * H));
  add("burning hot", ramp(40, 80, 12, NOW + 47 * H));
  add("flat", ramp(30, 30, 24, NOW + 47 * H));
  add("exhausted", ramp(90, 100, 6, NOW + 20 * H));
  add("past reset", ramp(10, 50, 10, NOW - 60));
  add("lagging old window", [
    ...ramp(60, 70, 10, NOW + 30 * H),
    { ts: NOW - 30, pct: 95, resets_at: NOW - 3 * 24 * H },
  ]);
  add("lagging dip", [
    ...ramp(40, 50, 10, NOW + 30 * H),
    { ts: NOW - 60, pct: 41, resets_at: NOW + 30 * H },
  ]);
  add("sparse anchor", [
    { ts: NOW - 60 * H, pct: 10, resets_at: NOW + 50 * H },
    { ts: NOW - 1 * H, pct: 20, resets_at: NOW + 50 * H },
  ]);
  add("seconds old", [
    { ts: NOW - 20, pct: 0, resets_at: NOW + WEEK - 30 },
    { ts: NOW - 5, pct: 1, resets_at: NOW + WEEK - 30 },
  ]);
  add("opened after midnight", ramp(0, 5, 3, NOW + WEEK - 3 * H));
  add("on pace", ramp(50, 50 + (50 / 47) * 24 * 0.95, 24, NOW + 47 * H));

  // Spans either side of MIN_SPAN_S, and short fresh series, which the random
  // sweep below almost never produces: its samples are hours apart.
  for (const span of [60, 299, 300, 301, 600, 1800, 3600, 3 * 3600]) {
    add(`span ${span}s`, [
      { ts: NOW - span, pct: 10, resets_at: NOW + 40 * H },
      { ts: NOW - 1, pct: 12, resets_at: NOW + 40 * H },
    ]);
  }
  // Pace ratios either side of the on-pace band.
  for (const ratio of [0.5, 0.89, 0.9, 0.95, 1.0, 1.01, 2]) {
    const required = 50 / 40; // points per hour to land on 100% in 40h
    add(`ratio ${ratio}`, ramp(50 - required * ratio * 24, 50, 24, NOW + 40 * H));
  }

  // A window that opened exactly at local midnight, the boundary of the
  // "opened today" rule.
  {
    const midnight = localMidnight(NOW, "Europe/Stockholm");
    add("window opens at midnight", [
      { ts: midnight + 60, pct: 1, resets_at: midnight + WEEK },
      { ts: NOW - 60, pct: 4, resets_at: midnight + WEEK },
    ]);
    add("window opens a second before midnight", [
      { ts: midnight - 1, pct: 1, resets_at: midnight - 1 + WEEK },
      { ts: NOW - 60, pct: 4, resets_at: midnight - 1 + WEEK },
    ]);
  }

  const fresh = rng(13);
  for (let i = 0; i < 60; i++) {
    const tz = ZONES[i % ZONES.length]!;
    const now = NOW + Math.floor(fresh() * 30 * 24 * H);
    const resetsAt = now + Math.floor(fresh() * WEEK) + 60;
    const samples: Sample[] = [];
    let ts = now - Math.floor(fresh() * 2 * H);
    let pct = fresh() * 90;
    for (let k = 0; k < 2 + Math.floor(fresh() * 6); k++) {
      samples.push({ ts, pct: Math.round(pct * 100) / 100, resets_at: resetsAt });
      ts += Math.floor(fresh() * 20 * 60);
      pct = Math.min(100, pct + fresh() * 3);
      if (ts > now) break;
    }
    add(`fresh ${i}`, samples, base(now, tz));
  }

  const r = rng(7);
  for (let i = 0; i < 300; i++) {
    const tz = ZONES[Math.floor(r() * ZONES.length)]!;
    const now = NOW + Math.floor(r() * 400 * 24 * H);
    const resetsAt = now + Math.floor(r() * WEEK) + (r() < 0.05 ? -H : 1);
    const n = Math.floor(r() * 40);
    const samples: Sample[] = [];
    let pct = r() * 60;
    let ts = now - Math.floor(r() * 9 * 24 * H);
    for (let k = 0; k < n; k++) {
      ts += Math.floor(r() * 12 * H);
      if (ts > now) break;
      pct = Math.min(100, Math.max(0, pct + (r() - 0.15) * 8));
      samples.push({
        ts,
        pct: Math.round(pct * 100) / 100,
        // Occasionally a reading from the previous window.
        resets_at: r() < 0.1 ? resetsAt - WEEK : resetsAt,
      });
    }
    add(`random ${i}`, samples, base(now, tz));
  }

  return cases.map((c) => ({ ...c, expect: computeWindow(c.samples, c.opts) }));
}

function midnightCases() {
  const r = rng(11);
  const out: { ts: number; tz: string; expect: number }[] = [];
  for (let i = 0; i < 200; i++) {
    const tz = ZONES[i % ZONES.length]!;
    const ts = NOW + Math.floor(r() * 3 * 365 * 24 * H);
    out.push({ ts, tz, expect: localMidnight(ts, tz) });
  }
  return out;
}

function ingestCases() {
  const now = NOW;
  const ok = { used_percentage: 23.000000000000004, resets_at: now + 47 * H };
  const bodies: [string, unknown][] = [
    ["valid", { session_id: "s1", model: { id: "claude-x" }, rate_limits: { seven_day: ok } }],
    ["no limits", { session_id: "s1" }],
    ["not an object", [1, 2]],
    ["null", null],
    ["limits not object", { rate_limits: "x" }],
    ["five hour ignored", { rate_limits: { five_hour: ok, seven_day: ok } }],
    ["pct out of range", { rate_limits: { seven_day: { used_percentage: 101, resets_at: now + H } } }],
    ["negative pct", { rate_limits: { seven_day: { used_percentage: -1, resets_at: now + H } } }],
    ["reset too far", { rate_limits: { seven_day: { used_percentage: 5, resets_at: now + WEEK + 86400 + 1 } } }],
    ["reset too old", { rate_limits: { seven_day: { used_percentage: 5, resets_at: now - WEEK - 1 } } }],
    ["string pct", { rate_limits: { seven_day: { used_percentage: "5", resets_at: now + H } } }],
    ["edge pct", { rate_limits: { seven_day: { used_percentage: 100, resets_at: now + WEEK + 86400 } } }],
    ["rounding", { rate_limits: { seven_day: { used_percentage: 7.125, resets_at: now + H } } }],
    ["display name model", { session_id: "x".repeat(300), model: { display_name: "Opus" }, rate_limits: {} }],
    ["non-string ids", { session_id: 5, model: { id: 7 } }],
  ];
  return bodies.map(([name, body]) => ({
    name,
    body,
    host: name === "valid" ? "h".repeat(100) : "laptop",
    now,
    expect: { parsed: parseIngest(body, now), identity: identityOf(name === "valid" ? "h".repeat(100) : "laptop", (body ?? {}) as never) },
  }));
}

export function buildFixtures() {
  return {
    description:
      "Inputs and expected outputs from core/compute.ts and core/ingest.ts, for the Rust hub. Generated by core/hub-fixtures.ts; do not edit by hand.",
    compute: computeCases(),
    local_midnight: midnightCases(),
    ingest: ingestCases(),
  };
}

if (import.meta.main) {
  const { renameSync, rmSync, writeFileSync } = await import("node:fs");
  const out = `${import.meta.dir}/fixtures/hub.json`;
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(buildFixtures()) + "\n");
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
}
