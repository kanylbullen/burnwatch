/**
 * Shared ingest parsing and validation.
 *
 * The Worker and the Bun daemon accept the same payload from the same
 * collectors, so they must also agree on what they accept. These rules used to
 * live twice — and had already drifted: the daemon truncated nothing and
 * checked no bounds, so one misbehaving client on the LAN could poison its
 * feed in exactly the way the Worker's validation prevents. One implementation
 * here means the two ingests cannot disagree again.
 *
 * Everything here is attacker-controlled the moment a write token leaks, and
 * an absurd reset date is not merely untidy: the current window is whichever
 * reaches furthest into the future, so one reading dated years out hides every
 * real one until somebody deletes the row by hand.
 */

import { WINDOW_KEYS, WINDOW_LENGTH, type WindowKey } from "./defaults";

/** Shape of the slice of Claude Code's status-line JSON that we care about. */
export type StatusLinePayload = {
  session_id?: unknown;
  model?: { id?: unknown; display_name?: unknown };
  rate_limits?: Partial<
    Record<WindowKey, { used_percentage?: unknown; resets_at?: unknown }>
  >;
};

/** Who a reading came from, after the caps both stores apply. */
export type Identity = {
  host: string;
  sessionId: string | null;
  model: string | null;
};

/** A reading that passed validation, ready for a store. */
export type ValidSample = {
  window: WindowKey;
  pct: number;
  resets_at: number;
};

export type ParsedIngest = {
  samples: ValidSample[];
  /** Readings dropped for being out of bounds, counted rather than silenced. */
  rejected: number;
  /** False when the payload carried no rate_limits block at all. */
  hadLimits: boolean;
};

const MAX_HOST_LEN = 64;
const MAX_ID_LEN = 128;
/** A reset belongs inside its own window, give or take a day of clock skew. */
const SKEW_S = 86400;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Caps and normalises the caller-supplied identity fields. Strings are
 * truncated before they reach a store, so neither ingest can be talked into
 * writing an unbounded value into a fixed-width row.
 */
export function identityOf(hostHeader: string, body: StatusLinePayload): Identity {
  const host = hostHeader.slice(0, MAX_HOST_LEN);
  const sessionId = asString(body.session_id).slice(0, MAX_ID_LEN) || null;
  const model =
    (asString(body.model?.id) || asString(body.model?.display_name)).slice(
      0,
      MAX_ID_LEN,
    ) || null;
  return { host, sessionId, model };
}

/**
 * Validates the rate-limit block and returns the readings worth storing.
 *
 * A reading whose types are wrong is skipped: the collector forwards whatever
 * Claude Code handed it, and a payload without usable numbers is expected
 * before a session's first API response. A reading whose *values* are out of
 * bounds — a percentage outside 0-100, a reset date outside its own window —
 * is counted in `rejected`, so the caller can answer with what it dropped
 * rather than dropping it in silence.
 *
 * A non-object body is treated as a payload without rate_limits rather than an
 * error: collectors only ever send objects, and the response already says
 * `reason: "no rate_limits in payload"` for the cases that matter.
 */
export function parseIngest(body: unknown, now: number): ParsedIngest {
  const empty: ParsedIngest = { samples: [], rejected: 0, hadLimits: false };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return empty;
  }

  const limits = (body as StatusLinePayload).rate_limits;
  if (!limits || typeof limits !== "object") return empty;

  const samples: ValidSample[] = [];
  let rejected = 0;

  for (const key of WINDOW_KEYS) {
    const w = limits[key];
    if (!w || typeof w !== "object") continue;

    const used = w.used_percentage;
    const reset = w.resets_at;
    if (
      typeof used !== "number" ||
      typeof reset !== "number" ||
      !Number.isFinite(used) ||
      !Number.isFinite(reset)
    ) {
      continue;
    }

    // Anything further out than the window plus a day of skew is not a reading
    // this endpoint can have produced.
    const earliest = now - WINDOW_LENGTH[key];
    const latest = now + WINDOW_LENGTH[key] + SKEW_S;
    if (reset < earliest || reset > latest) {
      rejected++;
      continue;
    }
    if (used < 0 || used > 100) {
      rejected++;
      continue;
    }

    samples.push({
      window: key,
      // Upstream sends values like 7.000000000000001; round before storing so
      // the dedupe check compares clean numbers and the feed reads sanely.
      pct: Math.round(used * 100) / 100,
      resets_at: reset,
    });
  }

  return { samples, rejected, hadLimits: true };
}