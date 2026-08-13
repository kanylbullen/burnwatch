/*
 * burnwatch widget client.
 *
 * Reads the same /api/state payload the ESP32 build will read, so the display
 * logic here doubles as the reference for what that firmware must render.
 */

const CARDS = 4;
const POLL_MS = 10_000;
const ROTATE_MS = 9_000;
/** Past this much silence the reading is history, not a live number. */
const STALE_S = 20 * 60;

const deck = document.getElementById("deck");
const dotsEl = document.getElementById("dots");
const errorEl = document.getElementById("error");

const el = (name) => document.querySelector(`[data-bind="${name}"]`);
const set = (name, value) => {
  const node = el(name);
  if (node) node.textContent = value;
};

/* ---------- formatting ---------- */

const pct = (n) => (n == null ? "—" : `${Math.round(n)}%`);

/** Coarse duration: the two largest units that carry information. */
function dur(s) {
  if (s == null) return "—";
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}D ${h}H`;
  if (h > 0) return `${h}H ${m}M`;
  return `${m}M`;
}

/** "THU 08:08" in the daemon's configured zone, not the viewer's. */
function clockAt(epoch, tz) {
  if (epoch == null) return "—";
  const d = new Date(epoch * 1000);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${day.toUpperCase()} ${time}`;
}

/** "UTC+2" for the daemon's configured zone, at the current instant. */
function utcOffset(timeZone) {
  try {
    const name = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return (name ?? "UTC").replace("GMT", "UTC");
  } catch {
    return "UTC";
  }
}

/**
 * Headline and sub-line for a forecast.
 *
 * The headline carries the number that distinguishes this reading — how early
 * you run dry, or how much faster you would have to go — and the sub-line
 * carries the wall-clock consequence. Putting "RUNS OUT" in both reads as a
 * stutter and wastes the one line with room for a real figure.
 */
function forecast(w, tz) {
  if (!w) return { label: "—", detail: "WAITING FOR FIRST SAMPLE" };

  switch (w.verdict) {
    case "speed_up":
      return {
        label: "SPEED UP",
        detail:
          w.speed_up_x == null
            ? "NO BURN MEASURED YET"
            : `${w.speed_up_x.toFixed(1)}× CURRENT PACE TO MAX OUT`,
      };
    case "runs_out":
      if (!w.early_by_s || w.early_by_s < 60) {
        return {
          label: "MAXED OUT",
          detail: `RESETS ${clockAt(w.resets_at, tz)}`,
        };
      }
      return {
        label: `${dur(w.early_by_s)} EARLY`,
        detail: `RUNS OUT ${clockAt(w.runs_out_at, tz)}`,
      };
    case "on_pace":
      return { label: "ON PACE", detail: "ON TRACK TO FINISH AT RESET" };
    default:
      return { label: "NO DATA", detail: "—" };
  }
}

/* ---------- rendering ---------- */

function paintWindow(prefix, w, tz) {
  const f = forecast(w, tz);
  set(`${prefix}.verdict`, f.label);
  set(`${prefix}.detail`, f.detail);

  const hero = el(`${prefix}.pct`);
  const bar = el(`${prefix}.bar`);
  const empty = !w;
  hero?.classList.toggle("empty", empty);
  el(`${prefix}.verdict`)?.classList.toggle("empty", empty);
  bar?.parentElement?.classList.toggle("empty", empty);

  if (empty) {
    set(`${prefix}.pct`, "NO DATA");
    for (const k of ["reset", "today", "rate"]) set(`${prefix}.${k}`, "—");
    if (bar) bar.style.width = "0%";
    return;
  }

  set(`${prefix}.pct`, pct(w.pct));
  set(`${prefix}.reset`, dur(w.resets_in_s));

  // An explicit em dash, not a skipped update: leaving the previous number in
  // place makes the card contradict itself for a whole day after a reset, when
  // the daemon rightly says it cannot know today's share yet.
  set(
    `${prefix}.today`,
    w.used_today_pct == null ? "—" : `+${Math.round(w.used_today_pct)}%`,
  );
  set(`${prefix}.rate`, `${w.rate_pct_per_h.toFixed(1)}%`);

  if (bar) bar.style.width = `${Math.min(100, Math.max(0, w.pct))}%`;

  // Where an even burn would have you standing right now.
  const tick = el(`${prefix}.tick`);
  if (tick && w.window_length_s > 0) {
    const elapsed = w.window_length_s - w.resets_in_s;
    const even = (elapsed / w.window_length_s) * 100;
    tick.style.left = `${Math.min(100, Math.max(0, even))}%`;
  }
}

function paint(state) {
  const tz = state.tz ?? "UTC";
  const week = state.windows?.seven_day ?? null;
  const five = state.windows?.five_hour ?? null;

  paintWindow("week", week, tz);
  paintWindow("five", five, tz);

  const n = state.active_sessions ?? 0;
  set("sessions", `${n} CHAT${n === 1 ? "" : "S"} ACTIVE`);

  const contact = state.last_contact_s;
  set(
    "contact",
    contact == null ? "NEVER" : contact < 60 ? "LIVE" : `${dur(contact)} AGO`,
  );
  set("samples", week ? String(week.samples) : "0");
  // The offset rather than the city: it fits at widget sizes where a name like
  // "Stockholm" gets ellipsised, and it is what you actually need in order to
  // read the wall-clock times on the forecast card.
  set("tz", utcOffset(tz));

  const hosts = el("hosts");
  if (hosts) {
    const list = state.hosts ?? [];
    hosts.innerHTML = "";
    if (list.length === 0) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = "NONE REPORTING";
      hosts.append(li);
    } else {
      // Quiet hosts stay listed, dimmed, with their age. A machine that simply
      // is not being used right now should not read as a machine that broke.
      //
      // Both shapes are accepted: this feed also drives firmware that will not
      // be reflashed in step with the daemon, and a client one version behind
      // should print a host name rather than "[object Object]".
      for (const h of list) {
        const name = typeof h === "string" ? h : (h?.name ?? "?");
        const active = typeof h === "string" ? true : Boolean(h?.active);
        const age = typeof h === "string" ? null : h?.last_seen_s;

        const li = document.createElement("li");
        li.className = active ? "" : "idle";
        li.textContent =
          active || age == null ? name : `${name}  ${dur(age)} AGO`;
        hosts.append(li);
      }
    }
  }

  document.body.dataset.stale =
    contact != null && contact > STALE_S ? "1" : "0";
}

/* ---------- paging ---------- */

let page = 0;

function go(next) {
  page = (next + CARDS) % CARDS;
  deck.style.transform = `translateX(-${page * 100}%)`;
  document.documentElement.dataset.page = String(page);
  [...dotsEl.children].forEach((d, i) => d.classList.toggle("on", i === page));
}

const params = new URLSearchParams(location.search);

for (let i = 0; i < CARDS; i++) dotsEl.append(document.createElement("b"));
go(Number(params.get("page") ?? 0) || 0);

// `?norotate=1` pins one card, for comparing a design against a reference
// shot or driving the ESP32 layout without the deck sliding underneath.
const autoRotate = !params.has("norotate");
let rotate = autoRotate ? setInterval(() => go(page + 1), ROTATE_MS) : 0;
/** Any manual paging hands control back to the user for a full cycle. */
function nudge(delta) {
  clearInterval(rotate);
  go(page + delta);
  if (autoRotate) rotate = setInterval(() => go(page + 1), ROTATE_MS);
}

addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") nudge(1);
  else if (e.key === "ArrowLeft") nudge(-1);
});
addEventListener("wheel", (e) => nudge(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1), {
  passive: true,
});

/*
 * The widget is frameless, so the whole face has to double as its title bar.
 * A press that stays put is a page turn; a press that travels starts a window
 * drag. Marking the body as a static drag region instead would swallow every
 * click and leave no way to page.
 */
const tauriWindow = globalThis.__TAURI__?.window?.getCurrentWindow?.();
const DRAG_THRESHOLD_PX = 4;

addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;

  const onMove = (m) => {
    if (dragging) return;
    if (Math.hypot(m.clientX - startX, m.clientY - startY) > DRAG_THRESHOLD_PX) {
      dragging = true;
      cleanup();
      tauriWindow?.startDragging();
    }
  };
  const onUp = () => {
    cleanup();
    if (!dragging) nudge(1);
  };
  const cleanup = () => {
    removeEventListener("mousemove", onMove);
    removeEventListener("mouseup", onUp);
  };

  addEventListener("mousemove", onMove);
  addEventListener("mouseup", onUp);
});

/* ---------- polling ---------- */

/*
 * Two ways in, one codebase. Served by the daemon it is same-origin and the
 * token rides in the page URL; inside the Tauri shell the same files are
 * bundled locally and the host injects the daemon's address and credential.
 */
const injected = globalThis.__BURNWATCH__ ?? null;
const base = injected?.url?.replace(/\/+$/, "") ?? "";
const token = injected?.token ?? params.get("token") ?? "";
const endpoint = `${base}/api/state${
  token ? `?token=${encodeURIComponent(token)}` : ""
}`;

async function tick() {
  try {
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    paint(await res.json());
    errorEl.hidden = true;
  } catch (err) {
    // Name the address that failed. "Failed to fetch" alone cannot distinguish
    // a blocked request from one aimed at the wrong place, and the shell
    // injects that address at runtime — so without it, diagnosing means
    // rebuilding just to find out where the widget was even pointing.
    const where = base === "" ? "own origin (no config injected)" : base;
    errorEl.hidden = false;
    errorEl.textContent = `CANNOT REACH ${where} — ${String(err.message ?? err)}`;
    document.body.dataset.stale = "1";
  }
}

tick();
setInterval(tick, POLL_MS);
