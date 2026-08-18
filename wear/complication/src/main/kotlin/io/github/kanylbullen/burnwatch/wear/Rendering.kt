package io.github.kanylbullen.burnwatch.wear

/**
 * Everything a complication shows, as plain strings.
 *
 * This layer holds no Android types on purpose. Every visual bug this project
 * has shipped was in code nobody could run without looking at it, and a watch
 * face is the least observable surface yet — so the decisions live here, where
 * fixtures can check them, and the Android side only maps them onto builders.
 */
data class Rendered(
    val pct: Int,
    /** Fits a small slot: "59%". */
    val short: String,
    /** Two characters of context: "5h" or "7d". */
    val title: String,
    /** The second fact on its own, so a narrow screen can break between them. */
    val detail: String,
    /** One line with room to breathe. */
    val long: String,
    /** Spoken aloud by the accessibility services. */
    val description: String,
)

/**
 * How long a reading may go unrefreshed before it stops being shown.
 *
 * The complication asks for an update every 15 minutes, so this is three
 * missed ticks — the same threshold the Worker uses before calling its own
 * poll silent. It survives one dropped update without flapping, and stops
 * short of presenting an hour-old number as current.
 */
const val STALE_AFTER_S: Long = 45 * 60

/**
 * Turns a fetched state into what the wrist should show, or null when nothing
 * can be shown honestly — no reading, no such window, or a reading old enough
 * that it may already be wrong.
 */
fun render(state: State?, ageS: Long, key: WindowKey): Rendered? {
    if (state == null) return null
    if (ageS < 0 || ageS > STALE_AFTER_S) return null
    val w = state.windows[key] ?: return null

    val pct = w.pct.coerceIn(0, 100)
    val short = "$pct%"

    // The reset is the useful second fact — a full window matters differently
    // with eight minutes left than with three days.
    val resets = "resets in ${humanDuration(w.resetsInS)}"

    // Whether it runs out early is the whole point of burnwatch, so it wins
    // the long slot when it applies.
    val detail = when {
        w.verdict == "runs_out" && w.earlyByS != null ->
            "out ${humanDuration(w.earlyByS)} early"
        w.verdict == "runs_out" -> "runs out early"
        else -> resets
    }
    val long = "$pct% · $detail"

    val description = when {
        w.verdict == "runs_out" && w.earlyByS != null ->
            "$pct percent of the ${key.label} limit used, running out " +
                "${humanDuration(w.earlyByS)} before it resets"
        else -> "$pct percent of the ${key.label} limit used, $resets"
    }

    return Rendered(
        pct = pct,
        short = short,
        title = key.label,
        detail = detail,
        long = long,
        description = description,
    )
}

/**
 * Compact enough for a watch: at most two units, largest first.
 *
 * Seconds are never shown. Nothing on a wrist is decided by them, and "8m"
 * reads at a glance where "7m 43s" has to be parsed.
 */
fun humanDuration(seconds: Long): String {
    if (seconds <= 0) return "now"
    val m = seconds / 60
    if (m < 1) return "under a minute"
    if (m < 60) return "${m}m"

    val h = m / 60
    val remM = m % 60
    if (h < 24) return if (remM == 0L) "${h}h" else "${h}h ${remM}m"

    val d = h / 24
    val remH = h % 24
    return if (remH == 0L) "${d}d" else "${d}d ${remH}h"
}
