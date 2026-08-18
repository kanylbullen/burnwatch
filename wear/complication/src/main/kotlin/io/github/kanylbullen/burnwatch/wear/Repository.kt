package io.github.kanylbullen.burnwatch.wear

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** A reading and how old it is, so the renderer can refuse to show a stale one. */
data class Reading(val state: State, val ageS: Long)

/**
 * Fetches `/api/state` and remembers the last good answer.
 *
 * The cache exists because a watch loses its network constantly — a wrist drops
 * off wifi walking to the kitchen — and a complication that blanks on every
 * gap is worse than useless. It is bounded by [STALE_AFTER_S] rather than kept
 * forever, so the failure mode is an empty slot, never a confident wrong number.
 */
class Repository(context: Context) {
    private val prefs =
        context.applicationContext.getSharedPreferences("burnwatch", Context.MODE_PRIVATE)

    /**
     * Returns the freshest reading available, preferring the network and
     * falling back to cache. Null means there is nothing worth showing.
     */
    suspend fun read(nowMs: Long = System.currentTimeMillis()): Reading? {
        val fetched = fetch()
        if (fetched != null) {
            val state = parseState(fetched)
            if (state != null) {
                prefs.edit()
                    .putString(KEY_BODY, fetched)
                    .putLong(KEY_AT, nowMs)
                    .apply()
                return Reading(state, ageS = 0)
            }
        }

        val body = prefs.getString(KEY_BODY, null) ?: return null
        val at = prefs.getLong(KEY_AT, 0L)
        if (at <= 0L) return null

        val state = parseState(body) ?: return null
        return Reading(state, ageS = (nowMs - at) / 1000)
    }

    /** Null on any failure; the caller decides what an absent answer means. */
    private suspend fun fetch(): String? = withContext(Dispatchers.IO) {
        val base = BuildConfig.BURNWATCH_URL
        val token = BuildConfig.BURNWATCH_TOKEN
        if (base.isEmpty() || token.isEmpty()) return@withContext null

        var conn: HttpURLConnection? = null
        try {
            val url = URL("$base/api/state")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                // A complication request has a deadline. Waiting out a long
                // timeout costs the update; failing fast falls back to cache.
                connectTimeout = 8_000
                readTimeout = 8_000
                setRequestProperty("authorization", "Bearer $token")
                setRequestProperty("accept", "application/json")
            }

            // The token is a bearer credential, so plaintext would hand it to
            // any café network. Refuse rather than downgrade.
            if (conn !is HttpsURLConnection) return@withContext null

            if (conn.responseCode != 200) return@withContext null
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private companion object {
        const val KEY_BODY = "last_state_body"
        const val KEY_AT = "last_state_at_ms"
    }
}
