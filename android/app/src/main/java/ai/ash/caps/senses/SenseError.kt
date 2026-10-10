package ai.ash.caps.senses

import ai.ash.caps.CapResult

/**
 * Why a tool could not answer. [code] is one of the unified error codes (`ERROR_CODES`): forbidden (a permission is not
 * granted), bad_request (the arguments are wrong), unavailable (location off, no fix, no data yet, a source missing or
 * unreadable, recording not on), timeout; the message says exactly which. [reason] is a finer tag the app's own code
 * tells apart (not_recording, no_fix, source_unavailable); it never leaves the app. Never answered with made-up data instead.
 */
class SenseError(val code: String, message: String, val reason: String = "") : Exception(message) {
    fun result(): CapResult = CapResult.error(code, message ?: code)

    companion object {
        fun badArgs(message: String) = SenseError("bad_request", message)
    }
}
