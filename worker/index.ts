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
   * Retention, on a schedule rather than on the ingest path.
   *
   * The local daemon used to prune inside every ingest, which put two
   * full-table scans in front of every status-line render on every machine.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const cfg = settings(env);
    await new Store(env.DB).prune(Math.floor(Date.now() / 1000), cfg.retentionS);
  },
};
