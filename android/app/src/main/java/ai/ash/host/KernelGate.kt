package ai.ash.host

/** Where the kernel package stands, as the guide and the diagnostics see it. */
enum class KernelState { NOT_INSTALLED, NOT_RUNNING, BOUND }

/**
 * What the hand app does about each [KernelState] (SPEC-05 §4, §9 step 1): install the package when it is missing,
 * start its service when it does not run (a few tries, then the owner decides), carry on once the kernel host has
 * bound the app.
 */
object KernelGate {
    enum class Action {
        /** Not installed: the owner is guided to install it. */
        INSTALL,
        /** Installed but not running: start its foreground service. */
        START,
        /** Started [MAX_STARTS] times and still not bound: stop trying by itself, show 「内核未运行」 and let the owner retry. */
        WAIT,
        /** Bound: nothing to do, the guide goes on. */
        PROCEED,
    }

    const val MAX_STARTS = 3

    fun state(installed: Boolean, bound: Boolean): KernelState = when {
        !installed -> KernelState.NOT_INSTALLED
        bound -> KernelState.BOUND
        else -> KernelState.NOT_RUNNING
    }

    /** [startsTried]: how many times the service has been started since the kernel was last seen not running. */
    fun action(state: KernelState, startsTried: Int): Action = when (state) {
        KernelState.NOT_INSTALLED -> Action.INSTALL
        KernelState.BOUND -> Action.PROCEED
        KernelState.NOT_RUNNING -> if (startsTried < MAX_STARTS) Action.START else Action.WAIT
    }
}
