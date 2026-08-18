package io.github.kanylbullen.burnwatch.wear

import android.content.Context
import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders
import androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.LayoutElement
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.CircularProgressIndicator
import androidx.wear.protolayout.material.ProgressIndicatorColors
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.EdgeContentLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The tile, which exists because a watch face may refuse to draw anything.
 *
 * A complication lives at the mercy of whoever designed the dial: it can be
 * bound, enabled and fed correct data and still render nothing, with no way to
 * tell from the wrist. A tile is our own surface. It is one swipe from the
 * watch face, it always draws, and no face can opt out of it.
 */
class BurnwatchTileService : TileService() {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> =
        CallbackToFutureAdapter.getFuture { completer ->
            scope.launch {
                val result = runCatching {
                    val reading = Repository(this@BurnwatchTileService).read()
                    val rendered = WindowKey.entries.associateWith {
                        render(reading?.state, reading?.ageS ?: 0, it)
                    }

                    TileBuilders.Tile.Builder()
                        .setResourcesVersion(RESOURCES_VERSION)
                        // Matches the complication's cycle and the Worker's
                        // poll; asking more often would only redraw the same
                        // number at the cost of the battery.
                        .setFreshnessIntervalMillis(15 * 60 * 1000L)
                        .setTileTimeline(
                            TimelineBuilders.Timeline.fromLayoutElement(
                                layout(requestParams.deviceConfiguration, rendered),
                            ),
                        )
                        .build()
                }
                result.fold(completer::set, completer::setException)
            }
            "burnwatch-tile"
        }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        CallbackToFutureAdapter.getFuture { completer ->
            completer.set(
                ResourceBuilders.Resources.Builder()
                    .setVersion(RESOURCES_VERSION)
                    .build(),
            )
            "burnwatch-tile-resources"
        }

    /**
     * The week takes the rim and the headline, because it is the budget that
     * decides your week; the five-hour window rides underneath it.
     */
    private fun layout(
        device: DeviceParameters,
        rendered: Map<WindowKey, Rendered?>,
    ): LayoutElement {
        val weekly = rendered[WindowKey.SEVEN_DAY]
        val fiveHour = rendered[WindowKey.FIVE_HOUR]

        val progress = CircularProgressIndicator.Builder()
            .setProgress(weekly?.let { it.pct / 100f } ?: 0f)
            .setCircularProgressIndicatorColors(
                ProgressIndicatorColors(ACCENT, TRACK),
            )
            .build()

        val card = EdgeContentLayout.Builder(device)
            .setEdgeContent(progress)
            .setPrimaryLabelTextContent(
                Text.Builder(this, "7d")
                    .setTypography(Typography.TYPOGRAPHY_CAPTION2)
                    .setColor(ColorBuilders.argb(DIM))
                    .build(),
            )
            .setContent(
                Text.Builder(this, weekly?.short ?: "—")
                    .setTypography(Typography.TYPOGRAPHY_DISPLAY2)
                    .setColor(ColorBuilders.argb(ACCENT))
                    .build(),
            )
            .setSecondaryLabelTextContent(
                Text.Builder(this, fiveHour?.let { "5h  ${it.short}" } ?: "5h  —")
                    .setTypography(Typography.TYPOGRAPHY_CAPTION2)
                    .setColor(ColorBuilders.argb(ACCENT_SOFT))
                    .build(),
            )
            .build()

        // The whole face of the tile opens the app, because the four pages are
        // where a number that looks wrong gets explained.
        return LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.expand())
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setClickable(
                        ModifiersBuilders.Clickable.Builder()
                            .setId("open")
                            .setOnClick(
                                ActionBuilders.LaunchAction.Builder()
                                    .setAndroidActivity(
                                        ActionBuilders.AndroidActivity.Builder()
                                            .setPackageName(packageName)
                                            .setClassName(StatusActivity::class.java.name)
                                            .build(),
                                    )
                                    .build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .addContent(card)
            .build()
    }

    companion object {
        /** No images are shipped, so this never has to change. */
        private const val RESOURCES_VERSION = "1"

        private const val ACCENT = 0xffff4b12.toInt()
        private const val ACCENT_SOFT = 0xffff8a4c.toInt()
        private const val TRACK = 0xff2a2a2e.toInt()
        private const val DIM = 0xff8b8b93.toInt()

        /** Nudges the tile when the app has just fetched something newer. */
        fun refresh(context: Context) {
            TileService.getUpdater(context).requestUpdate(BurnwatchTileService::class.java)
        }
    }
}
