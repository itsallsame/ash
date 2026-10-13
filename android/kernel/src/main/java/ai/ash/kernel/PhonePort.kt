package ai.ash.kernel

import org.json.JSONObject

/**
 * The phone actions the kernel host serves to the core over the host interface (capability groups vscreen / input /
 * apps of `ash-host/1`). The host does the Android work and returns the method's result object; the core turns that into
 * the word's reply. One port per host: the shell host ([ai.ash.kernel.host.ShellPhone]) can do all of it, the kernel
 * package on its own ([ai.ash.kernel.host.AppPhone]) only media and volume keys.
 */
interface PhonePort {
    /** @throws PhoneBadRequest for bad input, [PhoneUnavailable] when this host cannot do it (e.g. an injected key without the debug identity). */
    fun call(method: String, args: JSONObject): JSONObject
    /** Tear down anything held (the virtual screen) when the core goes or the host stops. */
    fun close() {}
}

/** Bad input to a phone action (becomes bad_request). */
class PhoneBadRequest(message: String) : Exception(message)
/** A phone action that was tried and failed (becomes failed, with what went wrong). */
class PhoneFailed(message: String) : Exception(message)
/** A phone action this host cannot do right now (becomes unavailable): the word is listed but needs the debug identity. */
class PhoneUnavailable(message: String) : Exception(message)
