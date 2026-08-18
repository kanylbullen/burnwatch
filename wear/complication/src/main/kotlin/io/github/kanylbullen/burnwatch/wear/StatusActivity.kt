package io.github.kanylbullen.burnwatch.wear

import android.app.Activity
import android.content.ComponentName
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Three screens, swiped vertically: the five-hour window, the week, and the
 * verdict.
 *
 * Vertical and not horizontal because on Wear a sideways swipe is the back
 * gesture — a horizontal pager would fight the system for the same movement
 * and lose in a way that feels like a bug.
 *
 * It also answers the question a blank complication cannot: whether the token
 * is wrong, the watch is offline, or nothing has reported yet. On a device with
 * no logs to read, that ambiguity is expensive.
 */
class StatusActivity : Activity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var pager: ViewPager2

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        pager = ViewPager2(this).apply {
            orientation = ViewPager2.ORIENTATION_VERTICAL
            setBackgroundColor(Color.BLACK)
            adapter = PagesAdapter(listOf(MessagePage(getString(R.string.status_loading))), "")
        }

        setContentView(pager)
    }

    override fun onStart() {
        super.onStart()
        scope.launch {
            val (list, footer) = load()
            pager.adapter = PagesAdapter(list, footer)
        }
        refreshComplications()
    }

    /**
     * Opening the app pushes the rings on the face forward too.
     *
     * Without this you wait out the fifteen-minute cycle to see whether a fix
     * worked, which makes every change to the complication cost a quarter of
     * an hour to evaluate.
     */
    private fun refreshComplications() {
        for (service in listOf(
            WeeklyComplicationService::class.java,
            FiveHourComplicationService::class.java,
        )) {
            ComplicationDataSourceUpdateRequester
                .create(this, ComponentName(this, service))
                .requestUpdateAll()
        }
        BurnwatchTileService.refresh(this)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun load(): Pair<List<Page>, String> {
        if (BuildConfig.BURNWATCH_URL.isEmpty() || BuildConfig.BURNWATCH_TOKEN.isEmpty()) {
            return listOf(MessagePage(getString(R.string.status_unconfigured))) to ""
        }

        val reading = Repository(this).read()
            ?: return listOf(
                MessagePage(getString(R.string.status_unreachable, host())),
            ) to ""

        val footer = if (reading.ageS == 0L) {
            getString(R.string.status_fresh)
        } else {
            getString(R.string.status_cached, humanDuration(reading.ageS))
        }

        return pages(reading.state, reading.ageS) to footer
    }

    /** Host only — the path carries nothing worth the width. */
    private fun host(): String =
        BuildConfig.BURNWATCH_URL.substringAfter("://").substringBefore("/")

    /* ---------- views ---------- */

    private inner class PagesAdapter(
        private val items: List<Page>,
        private val footer: String,
    ) : RecyclerView.Adapter<PageHolder>() {

        override fun getItemCount() = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            PageHolder(
                FrameLayout(this@StatusActivity).apply {
                    layoutParams = RecyclerView.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                },
            )

        override fun onBindViewHolder(holder: PageHolder, position: Int) =
            holder.bind(items[position], footer)
    }

    private inner class PageHolder(private val root: FrameLayout) : RecyclerView.ViewHolder(root) {

        fun bind(page: Page, footer: String) {
            root.removeAllViews()

            val gauge = GaugeView(this@StatusActivity)
            root.addView(
                gauge,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )

            // The pace page carries six lines where the others carry four, and
            // a round screen is widest across its middle — so it trades some of
            // the top and bottom margin for the room to fit them all.
            val tight = page is PacePage || page is HostsPage
            val side = (resources.displayMetrics.widthPixels * if (tight) 0.15f else 0.22f).toInt()
            val ends = (resources.displayMetrics.widthPixels * if (tight) 0.07f else 0.22f).toInt()

            val column = LinearLayout(this@StatusActivity).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(side, ends, side, ends)
            }
            root.addView(
                column,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )

            when (page) {
                is WindowPage -> bindWindow(page, gauge, column, footer)
                is PacePage -> bindPace(page, gauge, column, footer)
                is HostsPage -> bindHosts(page, gauge, column, footer)
                is MessagePage -> {
                    gauge.rings = ringsFor(null, null)
                    column.addView(text(page.text, 14f, Color.WHITE))
                }
            }
        }

        private fun bindWindow(page: WindowPage, gauge: GaugeView, column: LinearLayout, footer: String) {
            // Only this window's ring, so the page and the rim say the same
            // thing. Two arcs here would invite reading the wrong one.
            gauge.rings = listOf(
                GaugeView.Ring(page.fraction, colorFor(page.key), widthDp = 7f, insetDp = 4f),
            )

            column.addView(text(page.key.label, 13f, DIM))

            val r = page.rendered
            if (r == null) {
                column.addView(text("—", 40f, DIM))
                column.addView(text(getString(R.string.status_window_absent, page.key.label), 12f, DIM))
            } else {
                column.addView(text(r.short, 40f, colorFor(page.key)))
                column.addView(text(r.detail, 13f, Color.WHITE))
            }

            if (footer.isNotEmpty()) column.addView(text(footer, 11f, DIM, topDp = 10))
        }

        private fun bindPace(page: PacePage, gauge: GaugeView, column: LinearLayout, footer: String) {
            gauge.rings = ringsFor(page.weeklyFraction, page.fiveHourFraction)

            for (row in page.rows) {
                column.addView(text(row.label, 11f, DIM, topDp = 4))
                column.addView(text(row.forecast.label, 15f, GaugeView.ACCENT))
                column.addView(text(row.forecast.detail, 10f, Color.WHITE))
            }

            if (footer.isNotEmpty()) column.addView(text(footer, 10f, DIM, topDp = 8))
        }

        private fun bindHosts(page: HostsPage, gauge: GaugeView, column: LinearLayout, footer: String) {
            gauge.rings = ringsFor(page.weeklyFraction, page.fiveHourFraction)

            column.addView(text(page.sessions, 13f, GaugeView.ACCENT))

            if (page.hosts.isEmpty()) {
                column.addView(text(getString(R.string.status_hosts_none), 11f, DIM, topDp = 6))
            } else {
                for (host in page.hosts) {
                    // Idle machines stay on the list, dimmed. Dropping them
                    // would make a quiet laptop look like a lost one.
                    column.addView(
                        text(host.text, 12f, if (host.active) Color.WHITE else DIM, topDp = 4),
                    )
                }
            }

            column.addView(
                text(page.poll, 10f, if (page.pollWarn) WARN else DIM, topDp = 10),
            )

            if (footer.isNotEmpty()) column.addView(text(footer, 10f, DIM, topDp = 4))
        }

        private fun ringsFor(weekly: Float?, fiveHour: Float?) = listOf(
            GaugeView.Ring(weekly, GaugeView.ACCENT, widthDp = 6f, insetDp = 4f),
            GaugeView.Ring(fiveHour, GaugeView.ACCENT_SOFT, widthDp = 4f, insetDp = 15f),
        )

        private fun colorFor(key: WindowKey) = when (key) {
            WindowKey.SEVEN_DAY -> GaugeView.ACCENT
            WindowKey.FIVE_HOUR -> GaugeView.ACCENT_SOFT
        }

        private fun text(value: String, sizeSp: Float, color: Int, topDp: Int = 0): TextView =
            TextView(this@StatusActivity).apply {
                text = value
                setTextColor(color)
                gravity = Gravity.CENTER
                setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
                setLineSpacing(0f, 1.1f)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply {
                    topMargin = (topDp * resources.displayMetrics.density).toInt()
                }
            }
    }

    private companion object {
        val DIM = Color.parseColor("#8b8b93")

        /** A silent poll is the one failure the screen should not whisper. */
        val WARN = Color.parseColor("#ff2d00")
    }
}
