package io.github.kanylbullen.burnwatch.wear

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The verdict as the desktop widget words it: a headline and one line under it. */
data class Forecast(val label: String, val detail: String)

/**
 * A port of the widget's `forecast()`, deliberately word for word.
 *
 * Two surfaces describing the same account in different vocabulary would make
 * them look like two tools that disagree. The wrist says what the desktop says.
 */
fun forecast(w: Window?, tz: String): Forecast {
    if (w == null) return Forecast("—", "WAITING FOR FIRST SAMPLE")

    return when (w.verdict) {
        "speed_up" -> Forecast(
            label = "SPEED UP",
            detail = w.speedUpX?.let { String.format(Locale.UK, "%.1f× CURRENT PACE TO MAX OUT", it) }
                ?: "NO BURN MEASURED YET",
        )

        "runs_out" -> {
            val early = w.earlyByS
            if (early == null || early < 60) {
                Forecast("MAXED OUT", "RESETS ${clockAt(w.resetsAtS, tz)}")
            } else {
                Forecast("${paceDuration(early)} EARLY", "RUNS OUT ${clockAt(w.runsOutAtS, tz)}")
            }
        }

        "on_pace" -> Forecast("ON PACE", "ON TRACK TO FINISH AT RESET")

        else -> Forecast("NO DATA", "—")
    }
}

/**
 * The widget's `dur()`, which is not [humanDuration].
 *
 * They differ because they answer different questions: a complication is read
 * in a glance and wants "4h 12m", while a forecast headline sits beside other
 * shouted text and wants "4H 12M". Sharing one formatter would force one of
 * them to look wrong.
 */
fun paceDuration(seconds: Long?): String {
    if (seconds == null) return "—"
    val s = seconds.coerceAtLeast(0)
    val d = s / 86_400
    val h = (s % 86_400) / 3600
    val m = (s % 3600) / 60

    if (d > 0) return if (h > 0) "${d}D ${h}H" else "${d}D"
    if (h > 0) return if (m > 0) "${h}H ${m}M" else "${h}H"
    return "${m}M"
}

/** "THU 08:08" in the deployment's zone, not the wrist's. */
fun clockAt(epochSeconds: Long?, tz: String): String {
    if (epochSeconds == null || epochSeconds <= 0) return "—"
    val zone = runCatching { ZoneId.of(tz) }.getOrElse { ZoneId.of("UTC") }
    val at = Instant.ofEpochSecond(epochSeconds).atZone(zone)
    return FORMAT.format(at).uppercase(Locale.UK)
}

private val FORMAT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("EEE HH:mm", Locale.UK)
