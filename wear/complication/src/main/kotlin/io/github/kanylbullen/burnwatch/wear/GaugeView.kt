package io.github.kanylbullen.burnwatch.wear

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View

/**
 * The same gauge the desktop widget draws, bent around a round screen.
 *
 * A watch has one shape and burnwatch already speaks in arcs, so the rim is
 * where the number belongs: readable before you have read anything.
 */
class GaugeView(context: Context) : View(context) {

    /**
     * A null fraction draws the track and nothing else. That is the whole point
     * — an unknown window must look unmistakably different from an empty one,
     * not like zero percent.
     */
    data class Ring(
        val fraction: Float?,
        val color: Int,
        val widthDp: Float,
        val insetDp: Float,
    )

    var rings: List<Ring> = emptyList()
        set(value) {
            field = value
            invalidate()
        }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private val bounds = RectF()
    private val density = context.resources.displayMetrics.density

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        for (ring in rings) {
            val stroke = ring.widthDp * density
            paint.strokeWidth = stroke

            // Half the stroke, because an arc is centred on its path and would
            // otherwise be clipped by the bezel it is drawn against.
            val inset = ring.insetDp * density + stroke / 2f
            bounds.set(inset, inset, width - inset, height - inset)

            paint.color = TRACK
            canvas.drawArc(bounds, 0f, 360f, false, paint)

            val fraction = ring.fraction ?: continue
            if (fraction <= 0f) continue

            paint.color = ring.color
            // Noon, clockwise — where a dial starts, and where the eye lands.
            canvas.drawArc(bounds, -90f, 360f * fraction.coerceIn(0f, 1f), false, paint)
        }
    }

    companion object {
        /** The widget's `--accent`, unchanged, so the two read as one product. */
        val ACCENT = Color.parseColor("#ff4b12")

        /** `--accent-soft`, for the ring that is not the headline. */
        val ACCENT_SOFT = Color.parseColor("#ff8a4c")

        private val TRACK = Color.parseColor("#2a2a2e")
    }
}
