package io.github.kanylbullen.burnwatch.wear

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.util.Log
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/**
 * One provider per window, so both show up by name in the slot picker and you
 * can put the weekly budget in one ring and the five-hour one in another.
 *
 * Three types are offered because a slot advertises which ones it accepts, and
 * a provider that offers only the type a given slot does not take is simply
 * absent from the list — with no way to tell, from the watch, that it was ever
 * installed.
 */
abstract class BurnwatchComplicationService : SuspendingComplicationDataSourceService() {

    abstract val key: WindowKey

    private val repository: Repository by lazy { Repository(this) }

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val reading = repository.read()
        val rendered = render(reading?.state, reading?.ageS ?: 0, key)

        // A watch face is unobservable from here — no logs on screen, no way to
        // ask it what it wanted. This one line is how a slot that draws nothing
        // gets diagnosed.
        Log.i(TAG, "request type=${request.complicationType} window=${key.jsonKey} rendered=$rendered")

        rendered ?: return NoDataComplicationData()
        return complicationData(request.complicationType, rendered)
    }

    /**
     * What the picker shows before you choose it. Without this the provider
     * can be listed as an unusable blank, which reads as broken.
     */
    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        complicationData(
            type,
            Rendered(
                pct = 62,
                short = "62%",
                title = key.label,
                detail = "resets in 3h",
                long = "62% · resets in 3h",
                description = "62 percent of the ${key.label} limit used",
            ),
        )

    private fun complicationData(type: ComplicationType, r: Rendered): ComplicationData? {
        val description = text(r.description)
        return when (type) {
            // Every type carries the icon. A small subdial often draws the image
            // and little else, and a face given no image can render an empty
            // slot that is still tappable — which looks exactly like a bug.
            ComplicationType.RANGED_VALUE ->
                RangedValueComplicationData.Builder(
                    value = r.pct.toFloat(),
                    min = 0f,
                    max = 100f,
                    contentDescription = description,
                )
                    .setText(text(r.short))
                    .setTitle(text(r.title))
                    .setMonochromaticImage(image())
                    .setTapAction(tapAction())
                    .build()

            ComplicationType.SHORT_TEXT ->
                ShortTextComplicationData.Builder(
                    text = text(r.short),
                    contentDescription = description,
                )
                    .setTitle(text(r.title))
                    .setMonochromaticImage(image())
                    .setTapAction(tapAction())
                    .build()

            ComplicationType.LONG_TEXT ->
                LongTextComplicationData.Builder(
                    text = text(r.long),
                    contentDescription = description,
                )
                    .setTitle(text(r.title))
                    .setMonochromaticImage(image())
                    .setTapAction(tapAction())
                    .build()

            // A type we never advertised. Returning null is the documented way
            // to say so; inventing a shape here would render as garbage.
            else -> null
        }
    }

    private fun text(value: String): ComplicationText =
        PlainComplicationText.Builder(value).build()

    /** Monochrome on purpose: the face tints it to match its own dial. */
    private fun image(): MonochromaticImage =
        MonochromaticImage.Builder(
            Icon.createWithResource(this, R.drawable.ic_burnwatch),
        ).build()

    /** Tapping opens the status screen, which is where a failure explains itself. */
    private fun tapAction(): PendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, StatusActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
}

private const val TAG = "burnwatch"

class WeeklyComplicationService : BurnwatchComplicationService() {
    override val key = WindowKey.SEVEN_DAY
}

class FiveHourComplicationService : BurnwatchComplicationService() {
    override val key = WindowKey.FIVE_HOUR
}
