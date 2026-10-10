package ai.ash.kernel

import android.app.Application

class KernelApp : Application() {
    override fun onCreate() {
        // First, before any token or key is loaded: the agent container runs as this package's Linux user, and a dumpable
        // process's memory is readable to it through /proc. The library's constructor makes this process non-dumpable.
        runCatching { System.loadLibrary("ashnodump") }
        super.onCreate()
    }
}
