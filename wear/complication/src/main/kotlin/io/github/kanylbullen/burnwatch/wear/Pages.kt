package io.github.kanylbullen.burnwatch.wear

/**
 * The screens, decided here rather than in the view.
 *
 * The week gets the whole face, a second page carries the verdict — the only
 * part of burnwatch that tells you to do something rather than just what
 * happened — and a third says who is reporting.
 */
sealed interface Page

data class WindowPage(
    val key: WindowKey,
    /** Null when the window has nothing that can honestly be shown. */
    val rendered: Rendered?,
) : Page {
    val fraction: Float? get() = rendered?.let { it.pct / 100f }
}

data class PaceRow(val label: String, val forecast: Forecast)

/**
 * The verdict and the pace behind it, plus the fill — the rim keeps showing
 * the number so this page can spend all its words on what to do about it.
 */
data class PacePage(
    val rows: List<PaceRow>,
    val weeklyFraction: Float?,
) : Page

data class HostLine(val text: String, val active: Boolean)

/**
 * Who is actually reporting, and whether the Worker's own poll is still awake.
 *
 * The poll is listed apart from the machines because it is infrastructure
 * rather than somewhere you sit — beside your laptops it is noise, but its
 * silence is the one thing about it worth saying.
 */
data class HostsPage(
    val sessions: String,
    val hosts: List<HostLine>,
    val poll: String,
    val pollWarn: Boolean,
    /** The rim keeps the fill on every page, so it never reads as broken. */
    val weeklyFraction: Float? = null,
) : Page

/**
 * A whole screen given over to one sentence, for the states where there are no
 * numbers to page through — no deployment compiled in, or nothing reachable.
 * The text is passed in already resolved, so this file stays free of resources.
 */
data class MessagePage(val text: String) : Page

/**
 * Always three pages, in the same order, whatever the data says.
 *
 * A page that disappears when its window goes quiet would move the others
 * under your thumb, so an empty window keeps its place and says it is empty.
 */
fun pages(state: State?, ageS: Long): List<Page> {
    val usable = state?.takeIf { ageS in 0..STALE_AFTER_S }

    val weekly = WindowPage(WindowKey.SEVEN_DAY, render(state, ageS, WindowKey.SEVEN_DAY))
    val window = usable?.windows?.get(WindowKey.SEVEN_DAY)

    val pacePage = PacePage(
        rows = listOf(
            PaceRow(WindowKey.SEVEN_DAY.label, forecast(window, usable?.tz ?: "UTC")),
            PaceRow("pace", pace(window)),
        ),
        weeklyFraction = weekly.fraction,
    )

    return listOf(weekly, pacePage, hostsPage(usable).copy(weeklyFraction = weekly.fraction))
}

/** The client list, worded as the desktop widget words it. */
fun hostsPage(state: State?): HostsPage {
    val sessions = state?.activeSessions ?: 0
    val poll = state?.poll

    return HostsPage(
        sessions = "$sessions CHAT${if (sessions == 1) "" else "S"} ACTIVE",
        hosts = state?.hosts.orEmpty().map { host ->
            // A quiet machine stays listed with its age. One that simply is not
            // being used right now must not read as one that broke.
            HostLine(
                text = if (host.active || host.lastSeenS == null) {
                    host.name
                } else {
                    "${host.name}  ${paceDuration(host.lastSeenS)} AGO"
                },
                active = host.active,
            )
        },
        poll = when {
            poll == null -> "POLL HAS NEVER RUN"
            poll.stale -> "POLL SILENT ${paceDuration(poll.lastSeenS)}"
            else -> "POLL OK ${paceDuration(poll.lastSeenS)} AGO"
        },
        pollWarn = poll == null || poll.stale,
    )
}
