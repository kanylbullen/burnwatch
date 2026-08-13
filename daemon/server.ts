import { normalize } from "node:path/posix";
import { computeWindow, type WindowState } from "../core/compute";
import { config, WINDOW_KEYS, type WindowKey } from "./config";
import { Store } from "./store";

const store = new Store();

/** Shape of the slice of Claude Code's status-line JSON that we care about. */
type StatusLinePayload = {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  rate_limits?: Partial<
    Record<WindowKey, { used_percentage?: number; resets_at?: number }>
  >;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, x-burnwatch-host",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });

/**
 * Confines a request path to the widget directory. Static files are served
 * before the token check, so a traversal here would hand out arbitrary files
 * to anyone who can reach the port.
 */
function resolveStatic(path: string): string {
  const clean = normalize(path).replace(/\\/g, "/");
  return clean.startsWith("/") && !clean.includes("..") ? clean : "/index.html";
}

function authorized(req: Request, url: URL): boolean {
  if (config.token === "") return true;
  const header = req.headers.get("authorization") ?? "";
  // The query form exists so the widget window can be pointed at a single URL
  // and have the page and its API calls share one origin and one credential.
  const given = header.startsWith("Bearer ")
    ? header.slice(7)
    : (url.searchParams.get("token") ?? "");
  // Length-independent comparison keeps the check from leaking the token size.
  if (given.length !== config.token.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ config.token.charCodeAt(i);
  }
  return diff === 0;
}

function ingest(req: Request, body: StatusLinePayload): Response {
  const now = Math.floor(Date.now() / 1000);
  const host = (req.headers.get("x-burnwatch-host") ?? "").slice(0, 64);
  const sessionId = body.session_id ?? null;
  const model = body.model?.id ?? body.model?.display_name ?? null;

  store.beat(host, sessionId, now, model);

  const limits = body.rate_limits;
  if (!limits) {
    // Expected before the session's first API response, and for non-subscribers.
    return json({ ok: true, recorded: 0, reason: "no rate_limits in payload" });
  }

  let recorded = 0;
  for (const key of WINDOW_KEYS) {
    const w = limits[key];
    if (!w || typeof w.used_percentage !== "number" || typeof w.resets_at !== "number") {
      continue;
    }
    const wrote = store.insert({
      ts: now,
      window: key,
      // Upstream sends values like 7.000000000000001; round before storing so
      // the dedupe check compares clean numbers and the feed reads sanely.
      pct: Math.round(w.used_percentage * 100) / 100,
      resets_at: w.resets_at,
      host,
      session_id: sessionId,
      model,
    });
    if (wrote) recorded++;
  }

  store.prune(now);
  return json({ ok: true, recorded });
}

function state(): Response {
  const now = Math.floor(Date.now() / 1000);
  const windows: Record<string, WindowState | null> = {};

  for (const key of WINDOW_KEYS) {
    // Read a generous slice so the lookback always has an anchor to reach back to.
    const since = now - config.windowLength[key] - config.lookback[key];
    windows[key] = computeWindow(store.read(key, since), {
      now,
      timeZone: config.timeZone,
      lookbackS: config.lookback[key],
      windowLengthS: config.windowLength[key],
      onPaceLow: config.onPaceLow,
      onPaceHigh: config.onPaceHigh,
    });
  }

  const act = store.activity(now);
  return json({
    ok: true,
    now,
    tz: config.timeZone,
    active_sessions: act.sessions,
    hosts: act.hosts,
    last_contact_s: act.last_contact_s,
    windows,
  });
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 30,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return json({ ok: true });
    if (url.pathname === "/healthz") return json({ ok: true });
    // Browsers request this unprompted; answering keeps a 401 out of the console.
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    // The widget's own markup, so it can be opened in a browser during design
    // work and reuses exactly the payload the Tauri shell and the ESP32 read.
    // Served before the token check: it is inert presentation carrying no
    // usage data, and a stylesheet fetched by a relative href cannot present
    // the credential that only the page URL carries.
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${import.meta.dir}/../widget/src${resolveStatic(path)}`);
      if (await file.exists()) {
        return new Response(file, {
          // Without this the browser caches heuristically, and a long-open
          // widget window keeps running old JS against a newer API. These
          // files are a few KB on a LAN, so always revalidating is free.
          headers: { "cache-control": "no-cache" },
        });
      }
    }

    if (!authorized(req, url)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (url.pathname === "/ingest" && req.method === "POST") {
      let body: StatusLinePayload;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      return ingest(req, body);
    }

    if (url.pathname === "/api/state" && req.method === "GET") return state();

    return json({ ok: false, error: "not found" }, 404);
  },
});

const auth = config.token === "" ? "NO TOKEN (bind to loopback only)" : "token required";
console.log(`burnwatch daemon on http://${config.host}:${server.port}  [${auth}]`);
console.log(`  db ${config.dbPath}  tz ${config.timeZone}`);
