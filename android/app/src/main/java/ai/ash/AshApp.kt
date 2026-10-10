package ai.ash

import android.app.Application
import android.os.Build
import android.webkit.WebView
import ai.ash.host.Notifications

class AshApp : Application() {
    override fun onCreate() {
        // First, before any token is loaded: the agent container runs as this app's Linux user, and a dumpable
        // process's memory is readable to it through /proc. The library's constructor makes this process non-dumpable.
        runCatching { System.loadLibrary("ashnodump") }
        super.onCreate()
        // The app pages (ai.ash.apps.AppActivity) run in the ":app" process, whose WebView keeps its data in a
        // directory of its own; nothing else of Ash starts there.
        if (Build.VERSION.SDK_INT >= 28 && getProcessName().endsWith(":app")) {
            runCatching { WebView.setDataDirectorySuffix("app") }
            return
        }
        Notifications.createChannels(this)
        ai.ash.host.HandRuntime.start(this)
    }
}
