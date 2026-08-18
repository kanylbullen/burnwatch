package io.github.kanylbullen.burnwatch.wear

import org.json.JSONObject

/**
 * The two rate-limit windows Claude Code reports, named as `/api/state` names
 * them. The label is what a complication shows as its title — two characters,
 * because a small slot on a watch face has room for almost nothing.
 */
enum class WindowKey(val jsonKey: String, val label: String) {
    FIVE_HOUR("five_hour", "5h"),
    SEVEN_DAY("seven_day", "7d"),
}

/** The slice of a window that fits on a wrist. The Worker computes far more. */
data class Window(
    val pct: Int,
    val resetsInS: Long,
    /** Epoch seconds of the reset itself, for the clock times on the pace page. */
    val resetsAtS: Long,
    val verdict: String,
    /** How much faster than now you would have to burn to use it all. */
    val speedUpX: Double?,
    /** Epoch seconds when the window is projected to run out, or null. */
    val runsOutAtS: Long?,
    /** How long before the reset it runs out, when it does. */
    val earlyByS: Long?,
)

/** A machine that reports, and how long ago it last did. */
data class Host(val name: String, val lastSeenS: Long?, val active: Boolean)

/** The Worker's own scheduled poll, which is infrastructure, not a seat. */
data class Poll(val lastSeenS: Long, val stale: Boolean)

data class State(
    val now: Long,
    /** The deployment's zone, so clock times match the desktop widget's. */
    val tz: String,
    val windows: Map<WindowKey, Window>,
    val activeSessions: Int = 0,
    val hosts: List<Host> = emptyList(),
    val poll: Poll? = null,
)

/**
 * Parses `/api/state`.
 *
 * A window is absent whenever the Worker has nothing it can stand behind, and
 * that absence is carried through rather than smoothed into a zero: burnwatch
 * would rather show nothing than a number it cannot support, and 0% is a very
 * confident-looking lie.
 */
fun parseState(body: String): State? {
    val root = runCatching { JSONObject(body) }.getOrNull() ?: return null
    if (!root.optBoolean("ok", false)) return null

    val now = root.optLong("now", 0L)
    if (now <= 0L) return null

    val tz = root.optString("tz", "UTC").ifEmpty { "UTC" }
    val sessions = root.optInt("active_sessions", 0)

    // Both shapes are accepted, exactly as the widget accepts them: this feed
    // also drives clients that will not be updated in step with the Worker, and
    // one version behind should still print a host name.
    val hosts = buildList {
        val array = root.optJSONArray("hosts")
        for (i in 0 until (array?.length() ?: 0)) {
            val entry = array?.opt(i)
            when (entry) {
                is String -> add(Host(entry, null, active = true))
                is JSONObject -> add(
                    Host(
                        name = entry.optString("name", "?").ifEmpty { "?" },
                        lastSeenS = if (entry.isNull("last_seen_s")) null else entry.optLong("last_seen_s"),
                        active = entry.optBoolean("active", false),
                    ),
                )
            }
        }
    }

    val poll = root.optJSONObject("poll")?.let {
        Poll(lastSeenS = it.optLong("last_seen_s", 0L), stale = it.optBoolean("stale", false))
    }

    val windowsJson = root.optJSONObject("windows")
        ?: return State(now, tz, emptyMap(), sessions, hosts, poll)
    val windows = mutableMapOf<WindowKey, Window>()

    for (key in WindowKey.entries) {
        if (windowsJson.isNull(key.jsonKey)) continue
        val w = windowsJson.optJSONObject(key.jsonKey) ?: continue
        if (!w.has("pct") || !w.has("resets_in_s")) continue

        // A percentage the payload did not actually carry is worse than no
        // window at all, so an unreadable one drops out instead of defaulting.
        val raw = w.optDouble("pct", Double.NaN)
        if (raw.isNaN() || raw < 0.0 || raw > 100.0) continue

        windows[key] = Window(
            pct = Math.round(raw).toInt(),
            resetsInS = w.optLong("resets_in_s", 0L),
            resetsAtS = w.optLong("resets_at", 0L),
            verdict = w.optString("verdict", "unknown"),
            speedUpX = if (w.isNull("speed_up_x")) null else w.optDouble("speed_up_x"),
            runsOutAtS = if (w.isNull("runs_out_at")) null else w.optLong("runs_out_at"),
            earlyByS = if (w.isNull("early_by_s")) null else w.optLong("early_by_s"),
        )
    }

    return State(now, tz, windows, sessions, hosts, poll)
}
