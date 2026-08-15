import { computeWindow, type WindowState } from "../core/compute";
import {
  DEFAULTS,
  WINDOW_KEYS,
  WINDOW_LENGTH,
  num,
  type WindowKey,
} from "../core/defaults";
import { Store } from "./store";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Shared secret, set with `wrangler secret put BURNWATCH_TOKEN`. */
  BURNWATCH_TOKEN?: string;
  /**
   * Optional Claude API token, from `claude setup-token`. Its only use here is
   * to read the rate-limit headers off a one-token request, which closes the
   * gap the status-line collectors cannot: IDE sessions, phones, and any
   * machine that never runs a collector.
   */
  ANTHROPIC_TOKEN?: string;
  BURNWATCH_TZ?: string;
  BURNWATCH_LOOKBACK_5H?: string;
  BURNWATCH_LOOKBACK_7D?: string;
  BURNWATCH_RETENTION_S?: string;
  BURNWATCH_ACTIVE_SESSION_S?: string;
};

/** Shape of the slice of Claude Code's status-line JSON that we care about. */
type StatusLinePayload = {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  rate_limits?: Partial<
    Record<WindowKey, { used_percentage?: number; resets_at?: number }>
  >;
};

function settings(env: Env) {
  return {
    timeZone: env.BURNWATCH_TZ || DEFAULTS.timeZone,
    lookback: {
      five_hour: num(env.BURNWATCH_LOOKBACK_5H, DEFAULTS.lookback.five_hour),
      seven_day: num(env.BURNWATCH_LOOKBACK_7D, DEFAULTS.lookback.seven_day),
    } as Record<WindowKey, number>,
    retentionS: num(env.BURNWATCH_RETENTION_S, DEFAULTS.retentionS),
    activeSessionS: num(
      env.BURNWATCH_ACTIVE_SESSION_S,
      DEFAULTS.activeSessionS,
    ),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, content-type, x-burnwatch-host",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });

/**
 * Constant-time-ish comparison of the presented credential.
 *
 * Unlike the LAN daemon this endpoint is reachable from the internet, so an
 * empty token is refused outright rather than treated as "auth disabled": a
 * misconfigured deploy must fail closed, not publish the feed to everyone.
 */
function authorized(req: Request, url: URL, env: Env): boolean {
  const expected = env.BURNWATCH_TOKEN ?? "";
  if (expected === "") return false;

  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ")
    ? header.slice(7)
    : (url.searchParams.get("token") ?? "");

  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function ingest(
  req: Request,
  env: Env,
  body: StatusLinePayload,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const store = new Store(env.DB);
  const host = (req.headers.get("x-burnwatch-host") ?? "").slice(0, 64);
  const sessionId = body.session_id ?? null;
  const model = body.model?.id ?? body.model?.display_name ?? null;

  const statements = [store.beatStatement(host, sessionId, now, model)];

  const limits = body.rate_limits;
  for (const key of WINDOW_KEYS) {
    const w = limits?.[key];
    if (
      !w ||
      typeof w.used_percentage !== "number" ||
      typeof w.resets_at !== "number"
    ) {
      continue;
    }
    statements.push(
      store.insertStatement({
        ts: now,
        window: key,
        // Upstream sends values like 7.000000000000001; round before storing so
        // the dedupe check compares clean numbers and the feed reads sanely.
        pct: Math.round(w.used_percentage * 100) / 100,
        resets_at: w.resets_at,
        host,
        session_id: sessionId,
        model,
      }),
    );
  }

  const results = await env.DB.batch(statements);
  // The heartbeat always writes; only the sample statements count as recorded.
  const recorded = results
    .slice(1)
    .reduce((n, r) => n + (r.meta?.changes ?? 0), 0);

  return json({
    ok: true,
    recorded,
    ...(limits ? {} : { reason: "no rate_limits in payload" }),
  });
}

async function state(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const cfg = settings(env);
  const store = new Store(env.DB);

  const windows: Record<string, WindowState | null> = {};
  await Promise.all(
    WINDOW_KEYS.map(async (key) => {
      // Read a generous slice so the lookback always has an anchor to reach
      // back to, even when the series is sparse.
      const since = now - WINDOW_LENGTH[key] - cfg.lookback[key];
      windows[key] = computeWindow(await store.read(key, since), {
        now,
        timeZone: cfg.timeZone,
        lookbackS: cfg.lookback[key],
        windowLengthS: WINDOW_LENGTH[key],
        onPaceLow: DEFAULTS.onPaceLow,
        onPaceHigh: DEFAULTS.onPaceHigh,
      });
    }),
  );

  const act = await store.activity(now, cfg.activeSessionS);
  return json({
    ok: true,
    now,
    tz: cfg.timeZone,
    active_sessions: act.sessions,
    hosts: act.hosts,
    last_contact_s: act.last_contact_s,
    windows,
  });
}

/** Must match the prune entry in wrangler.jsonc's `triggers.crons`. */
const PRUNE_CRON = "17 4 * * *";

/**
 * Reads the account's rate limits from the response headers of a deliberately
 * tiny inference request.
 *
 * The obvious endpoint, /api/oauth/usage, needs a `user:profile` scope that a
 * `claude setup-token` credential does not carry — only the rotating,
 * machine-local session token does, which cannot live in a Worker. These
 * headers come back on any ordinary request, so a long-lived setup-token is
 * enough.
 *
 * The reading is account-wide, so one poll covers every device including the
 * ones the status-line collectors can never reach. It costs a single output
 * token, which does mean the meter nudges the thing it measures.
 *
 * Technique borrowed from Niclas Vestlund's VibePulse (MIT).
 */
async function poll(env: Env, now: number): Promise<void> {
  // Every exit below says why. A poller that fails silently is the same defect
  // this project spent its whole review removing: something that looks healthy
  // while reporting nothing, with no way to tell the two apart. Observability
  // is enabled in wrangler.jsonc, so these lines are retained and queryable.
  if (!env.ANTHROPIC_TOKEN) {
    console.log("poll: skipped, ANTHROPIC_TOKEN not set");
    return;
  }

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ANTHROPIC_TOKEN}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });
  } catch (err) {
    console.error("poll: request failed", String(err));
    return; // Network trouble; the next tick tries again.
  }

  if (!res.ok) {
    console.error(
      "poll: HTTP",
      res.status,
      (await res.text().catch(() => "")).slice(0, 200),
    );
    // Headers may still carry the limits on some errors, so carry on rather
    // than return: a 429 still tells you exactly how full the window is.
  }

  const store = new Store(env.DB);
  const statements: D1PreparedStatement[] = [];

  // Utilization arrives as a fraction of the allowance, not a percentage.
  const windows: [WindowKey, string][] = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ];
  for (const [key, prefix] of windows) {
    const util = res.headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
    const reset = res.headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
    if (util === null || reset === null) continue;

    const pct = Number(util) * 100;
    const resetsAt = Number(reset);
    if (!Number.isFinite(pct) || !Number.isFinite(resetsAt)) continue;

    statements.push(
      store.insertStatement({
        ts: now,
        window: key,
        pct: Math.round(pct * 100) / 100,
        resets_at: resetsAt,
        host: "cloudflare",
        // Left empty so a poll is not counted as one of your open chats.
        session_id: null,
        model: null,
      }),
    );
  }

  if (statements.length === 0) {
    console.error(
      "poll: no rate-limit headers on the response;",
      "seen:",
      [...res.headers.keys()].filter((h) => h.includes("ratelimit")).join(",") ||
        "none",
    );
    return;
  }

  // The heartbeat is written only on a successful reading, so a broken poller
  // never shows up as a live host.
  statements.unshift(store.beatStatement("cloudflare", null, now, null));
  await env.DB.batch(statements);
  console.log(`poll: recorded ${statements.length - 1} window(s)`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return json({ ok: true });
    if (url.pathname === "/healthz") return json({ ok: true });

    if (!authorized(req, url, env)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (url.pathname === "/ingest" && req.method === "POST") {
      let body: StatusLinePayload;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      return ingest(req, env, body);
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      return state(env);
    }

    // Anything else is the widget, served straight from the assets binding.
    return env.ASSETS.fetch(req);
  },

  /**
   * Two jobs on two schedules: poll often, prune nightly.
   *
   * Retention runs here rather than on the ingest path, where the local daemon
   * used to put two full-table scans in front of every status-line render on
   * every machine.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (event.cron === PRUNE_CRON) {
      await new Store(env.DB).prune(now, settings(env).retentionS);
      return;
    }
    await poll(env, now);
  },
};
