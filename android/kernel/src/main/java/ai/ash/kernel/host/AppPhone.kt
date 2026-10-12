package ai.ash.kernel.host

import ai.ash.kernel.PhoneBadRequest
import ai.ash.kernel.PhonePort
import ai.ash.kernel.PhoneUnavailable
import android.content.Context
import android.media.AudioManager
import android.os.SystemClock
import android.view.KeyEvent
import org.json.JSONObject
import java.util.Locale

/**
 * The phone actions the kernel package can do on its own identity, without the debug identity (capability `input`
 * only): media and volume keys through [AudioManager], which need no permission. Injecting other keys, the virtual
 * screen and launching an app in the background all need the shell host; until it is paired those words are not listed,
 * and if one is reached anyway it answers unavailable.
 */
class AppPhone(private val ctx: Context) : PhonePort {
    override fun call(method: String, a: JSONObject): JSONObject = when (method) {
        "input.key" -> inputKey(a.optString("key").trim())
        else -> throw PhoneUnavailable("$method needs the phone's debug identity (「后台也能动手」), which is not connected")
    }

    private fun inputKey(key: String): JSONObject {
        if (key.isEmpty()) throw PhoneBadRequest("key is required")
        val k = key.lowercase(Locale.ROOT)
        val num = key.toIntOrNull()
        val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val media = MEDIA_KEYS[k] ?: num?.takeIf { it in MEDIA_KEYS.values }
        if (media != null) {
            val t = SystemClock.uptimeMillis()
            audio.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, media, 0))
            audio.dispatchMediaKeyEvent(KeyEvent(t, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, media, 0))
            val idle = !audio.isMusicActive && media != KeyEvent.KEYCODE_MEDIA_PLAY && media != KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            return msg("Media key $k sent${if (idle) " (nothing is playing right now)" else ""}.")
        }
        val vol = VOLUME_KEYS[k] ?: num?.takeIf { it in VOLUME_KEYS.values }
        if (vol != null) {
            val dir = when (vol) {
                KeyEvent.KEYCODE_VOLUME_UP -> AudioManager.ADJUST_RAISE
                KeyEvent.KEYCODE_VOLUME_DOWN -> AudioManager.ADJUST_LOWER
                else -> AudioManager.ADJUST_TOGGLE_MUTE
            }
            try {
                audio.adjustSuggestedStreamVolume(dir, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)
            } catch (e: SecurityException) {
                throw IllegalStateException("Android refused the volume change (Do Not Disturb policy): ${e.message}")
            }
            val m = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
            return msg("Volume key $k sent (media volume now $m/${audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)}).")
        }
        throw PhoneUnavailable("injecting \"$key\" needs the phone's debug identity (「后台也能动手」), which is not connected")
    }

    private fun msg(text: String) = JSONObject().put("message", text)

    private companion object {
        val MEDIA_KEYS = mapOf(
            "play_pause" to KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, "play" to KeyEvent.KEYCODE_MEDIA_PLAY, "pause" to KeyEvent.KEYCODE_MEDIA_PAUSE,
            "next" to KeyEvent.KEYCODE_MEDIA_NEXT, "previous" to KeyEvent.KEYCODE_MEDIA_PREVIOUS, "stop" to KeyEvent.KEYCODE_MEDIA_STOP,
            "rewind" to KeyEvent.KEYCODE_MEDIA_REWIND, "fast_forward" to KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
        )
        val VOLUME_KEYS = mapOf(
            "volume_up" to KeyEvent.KEYCODE_VOLUME_UP, "volume_down" to KeyEvent.KEYCODE_VOLUME_DOWN, "volume_mute" to KeyEvent.KEYCODE_VOLUME_MUTE,
        )
    }
}
