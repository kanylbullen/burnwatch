package io.github.kanylbullen.burnwatch.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wrist and the desktop describe the same account, so they have to use the
 * same words. These expectations are transcribed from the widget's `forecast()`
 * rather than invented here — if the two ever drift, this is where it shows.
 */
class ForecastTest {

    private fun window(
        verdict: String,
        speedUpX: Double? = null,
        runsOutAtS: Long? = null,
        earlyByS: Long? = null,
        resetsAtS: Long = 1_787_001_000,
        ratePctPerH: Double = 0.0,
        requiredPctPerH: Double = 0.0,
    ) = Window(
        pct = 50,
        resetsInS = 600,
        resetsAtS = resetsAtS,
        verdict = verdict,
        speedUpX = speedUpX,
        runsOutAtS = runsOutAtS,
        earlyByS = earlyByS,
        ratePctPerH = ratePctPerH,
        requiredPctPerH = requiredPctPerH,
    )

    @Test
    fun `speeding up quotes the multiplier`() {
        val f = forecast(window("speed_up", speedUpX = 2.4), "Europe/Stockholm")
        assertEquals("SPEED UP", f.label)
        assertEquals("2.4× CURRENT PACE TO MAX OUT", f.detail)
    }

    @Test
    fun `speeding up with nothing measured says so`() {
        val f = forecast(window("speed_up", speedUpX = null), "Europe/Stockholm")
        assertEquals("SPEED UP", f.label)
        assertEquals("NO BURN MEASURED YET", f.detail)
    }

    @Test
    fun `running out early leads with how early`() {
        val f = forecast(
            window("runs_out", runsOutAtS = 1_787_001_000, earlyByS = 9_000),
            "Europe/Stockholm",
        )
        assertEquals("2H 30M EARLY", f.label)
        assertEquals("RUNS OUT MON 23:10", f.detail)
    }

    @Test
    fun `a margin under a minute is maxed out, not early`() {
        // "0M EARLY" is noise, and the widget draws the same line here.
        val f = forecast(window("runs_out", earlyByS = 30), "Europe/Stockholm")
        assertEquals("MAXED OUT", f.label)
        assertEquals("RESETS MON 23:10", f.detail)
    }

    @Test
    fun `on pace needs no numbers`() {
        val f = forecast(window("on_pace"), "Europe/Stockholm")
        assertEquals("ON PACE", f.label)
        assertEquals("ON TRACK TO FINISH AT RESET", f.detail)
    }

    @Test
    fun `an absent window is waiting, not broken`() {
        val f = forecast(null, "Europe/Stockholm")
        assertEquals("—", f.label)
        assertEquals("WAITING FOR FIRST SAMPLE", f.detail)
    }

    @Test
    fun `an unknown verdict admits it`() {
        assertEquals("NO DATA", forecast(window("unknown"), "Europe/Stockholm").label)
    }

    @Test
    fun `clock times use the deployment zone, not the wrist`() {
        assertEquals("MON 23:10", clockAt(1_787_001_000, "Europe/Stockholm"))
        assertEquals("MON 21:10", clockAt(1_787_001_000, "UTC"))

        // A zone the payload got wrong must not take the screen down with it.
        assertEquals("MON 21:10", clockAt(1_787_001_000, "Not/AZone"))
        assertEquals("—", clockAt(null, "UTC"))
    }

    @Test
    fun `pace durations shout, unlike the complication's`() {
        assertEquals("2H 30M", paceDuration(9_000))
        assertEquals("3D 1H", paceDuration(262_800))
        assertEquals("0M", paceDuration(30))
        assertEquals("—", paceDuration(null))
    }

    @Test
    fun `the client list reads like the widget's`() {
        val state = checkNotNull(parseState(fixture()))
        val page = hostsPage(state)

        assertEquals("3 CHATS ACTIVE", page.sessions)
        assertEquals("POLL OK 0M AGO", page.poll)
        assertEquals(false, page.pollWarn)

        // Active machines are just a name; quiet ones carry how long they have
        // been quiet, so idle never reads as broken.
        assertEquals("laptop", page.hosts[0].text)
        assertEquals(true, page.hosts[0].active)
        assertEquals("server  1D 5H AGO", page.hosts[2].text)
        assertEquals(false, page.hosts[2].active)
    }

    @Test
    fun `one chat is singular, and a silent poll warns`() {
        val one = State(now = 100, tz = "UTC", windows = emptyMap(), activeSessions = 1)
        assertEquals("1 CHAT ACTIVE", hostsPage(one).sessions)

        val silent = one.copy(poll = Poll(lastSeenS = 10_800, stale = true))
        assertEquals("POLL SILENT 3H", hostsPage(silent).poll)
        assertEquals(true, hostsPage(silent).pollWarn)

        // Never having run is a different fault from having stopped.
        assertEquals("POLL HAS NEVER RUN", hostsPage(one).poll)
        assertEquals(true, hostsPage(one).pollWarn)
        assertEquals("0 CHATS ACTIVE", hostsPage(null).sessions)
    }

    @Test
    fun `the pace line is the widget's, word for word`() {
        // The speed_up fixture's figures: 0.21 %/h measured, 1.64 %/h needed.
        val p = pace(window("speed_up", ratePctPerH = 0.21, requiredPctPerH = 1.64))
        assertEquals(Forecast("5.0%/DAY", "39%/DAY FINISHES AT RESET"), p)

        // Nothing left to spend leaves no pace to finish at.
        assertEquals(
            "NOTHING LEFT BEFORE RESET",
            pace(window("runs_out", ratePctPerH = 30.0, requiredPctPerH = 0.0)).detail,
        )
        assertEquals(Forecast("—", "—"), pace(null))
    }

    @Test
    fun `there are always three pages in the same order`() {
        val state = parseState(fixture())

        val fresh = pages(state, ageS = 0)
        assertEquals(3, fresh.size)
        assertEquals(WindowKey.SEVEN_DAY, (fresh[0] as WindowPage).key)
        assertEquals(0.40f, (fresh[0] as WindowPage).fraction)
        val pace = fresh[1] as PacePage
        assertEquals("SPEED UP", pace.rows[0].forecast.label)
        assertEquals(Forecast("13%/DAY", "20%/DAY FINISHES AT RESET"), pace.rows[1].forecast)
        assertEquals("3 CHATS ACTIVE", (fresh[2] as HostsPage).sessions)

        // Stale keeps all three pages and empties them, rather than collapsing
        // the deck under the reader's thumb.
        val stale = pages(state, ageS = STALE_AFTER_S + 1)
        assertEquals(3, stale.size)
        assertEquals(null, (stale[0] as WindowPage).rendered)
        assertEquals("WAITING FOR FIRST SAMPLE", (stale[1] as PacePage).rows[0].forecast.detail)
        assertEquals(Forecast("—", "—"), (stale[1] as PacePage).rows[1].forecast)
        assertTrue((stale[2] as HostsPage).hosts.isEmpty())
    }

    private fun fixture(): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream("state-live.json"))
            .bufferedReader().use { it.readText() }
}
