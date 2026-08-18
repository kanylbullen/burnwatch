package io.github.kanylbullen.burnwatch.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wrist cannot be inspected, so it is checked here instead.
 *
 * `state-live.json` is a real `/api/state` response, captured from the running
 * deployment with only the host names replaced. Handwritten fixtures agree with
 * whatever the author assumed; this one disagrees when the Worker's shape moves.
 */
class RenderingTest {

    private fun fixture(name: String): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream(name)) {
            "missing fixture $name"
        }.bufferedReader().use { it.readText() }

    @Test
    fun `parses a real response`() {
        val state = checkNotNull(parseState(fixture("state-live.json")))

        assertEquals(1787000501L, state.now)
        assertEquals(59, state.windows[WindowKey.FIVE_HOUR]?.pct)
        assertEquals(40, state.windows[WindowKey.SEVEN_DAY]?.pct)
        assertNull(state.windows[WindowKey.SEVEN_DAY]?.runsOutAtS)
    }

    @Test
    fun `renders both windows from the real response`() {
        val state = checkNotNull(parseState(fixture("state-live.json")))

        val weekly = checkNotNull(render(state, ageS = 0, key = WindowKey.SEVEN_DAY))
        assertEquals(40, weekly.pct)
        assertEquals("40%", weekly.short)
        assertEquals("7d", weekly.title)
        assertEquals("40% · resets in 3d", weekly.long)

        // The status screen breaks between these two, so they have to stand
        // alone — a duration split across a line reads as two numbers.
        assertEquals("resets in 3d", weekly.detail)

        val fiveHour = checkNotNull(render(state, ageS = 0, key = WindowKey.FIVE_HOUR))
        assertEquals("59%", fiveHour.short)
        assertEquals("59% · resets in 8m", fiveHour.long)
    }

    @Test
    fun `a window the worker could not compute renders as nothing`() {
        val body = """{"ok":true,"now":100,"windows":{"five_hour":null,"seven_day":null}}"""
        val state = checkNotNull(parseState(body))

        assertTrue(state.windows.isEmpty())
        assertNull(render(state, ageS = 0, key = WindowKey.FIVE_HOUR))
    }

    @Test
    fun `a reading past the stale threshold is withheld`() {
        val state = checkNotNull(parseState(fixture("state-live.json")))

        // One missed update must not blank the ring; three means the number
        // on screen may already be wrong, and a wrong number is the one thing
        // this project refuses to show.
        assertTrue(render(state, ageS = 15 * 60, key = WindowKey.SEVEN_DAY) != null)
        assertTrue(render(state, ageS = STALE_AFTER_S, key = WindowKey.SEVEN_DAY) != null)
        assertNull(render(state, ageS = STALE_AFTER_S + 1, key = WindowKey.SEVEN_DAY))
    }

    @Test
    fun `a clock that jumped backwards is not treated as fresh`() {
        val state = checkNotNull(parseState(fixture("state-live.json")))
        assertNull(render(state, ageS = -1, key = WindowKey.SEVEN_DAY))
    }

    @Test
    fun `running out early is what the long slot says`() {
        val body = """
            {"ok":true,"now":100,"windows":{"seven_day":{
              "pct":88,"resets_in_s":7200,"verdict":"runs_out",
              "runs_out_at":1000,"early_by_s":9000}}}
        """.trimIndent()
        val state = checkNotNull(parseState(body))

        val r = checkNotNull(render(state, ageS = 0, key = WindowKey.SEVEN_DAY))
        assertEquals("88% · out 2h 30m early", r.long)
        assertEquals("out 2h 30m early", r.detail)
        assertTrue(r.description.contains("running out"))
    }

    @Test
    fun `runs out without a margin still says so`() {
        val body = """
            {"ok":true,"now":100,"windows":{"seven_day":{
              "pct":91,"resets_in_s":600,"verdict":"runs_out",
              "runs_out_at":null,"early_by_s":null}}}
        """.trimIndent()
        val state = checkNotNull(parseState(body))

        assertEquals("91% · runs out early", render(state, 0, WindowKey.SEVEN_DAY)?.long)
    }

    @Test
    fun `refuses a response the worker did not vouch for`() {
        assertNull(parseState("""{"ok":false,"error":"unauthorized"}"""))
        assertNull(parseState("not json at all"))
        assertNull(parseState(""))
        assertNull(parseState("""{"ok":true}"""))
    }

    @Test
    fun `an impossible percentage drops the window rather than clamping it`() {
        val body = """
            {"ok":true,"now":100,"windows":{
              "five_hour":{"pct":140,"resets_in_s":60,"verdict":"unknown"},
              "seven_day":{"pct":12,"resets_in_s":60,"verdict":"on_pace"}}}
        """.trimIndent()
        val state = checkNotNull(parseState(body))

        assertNull(state.windows[WindowKey.FIVE_HOUR])
        assertEquals(12, state.windows[WindowKey.SEVEN_DAY]?.pct)
    }

    @Test
    fun `durations stay short enough for a watch`() {
        assertEquals("now", humanDuration(0))
        assertEquals("under a minute", humanDuration(30))
        assertEquals("8m", humanDuration(499))
        assertEquals("1h", humanDuration(3600))
        assertEquals("4h 12m", humanDuration(15_120))
        assertEquals("1d", humanDuration(86_400))
        assertEquals("3d 4h", humanDuration(273_600))

        // Truncated, never rounded up: 3d 0h 58m is three days and no hours.
        // A countdown that overstates the time left is the one direction that
        // costs you something.
        assertEquals("3d", humanDuration(262_699))
    }
}
