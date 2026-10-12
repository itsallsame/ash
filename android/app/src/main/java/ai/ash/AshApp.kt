package ai.ash

import android.app.Application
import android.os.Build
import android.webkit.WebView
import ai.ash.caps.config.ConfigWatch
import ai.ash.host.Notifications

class AshApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // The app pages (ai.ash.apps.AppActivity) run in the ":app" process, whose WebView keeps its data in a
        // directory of its own; nothing else of Ash starts there. The suffix must be set before anything touches
        // WebView in that process, or it shares the main process's directory and the process dies.
        val appProcess = Build.VERSION.SDK_INT >= 28 && getProcessName().endsWith(":app")
        if (appProcess) runCatching { WebView.setDataDirectorySuffix("app") }
        // Remote debugging of the pages (chrome://inspect) is a debug-build tool; it is per process, so it is set here, before any process makes a WebView.
        WebView.setWebContentsDebuggingEnabled(WebDebugging.enabled(BuildConfig.DEBUG, BuildConfig.ISOLATED_PROBE))
        if (appProcess) return
        Notifications.createChannels(this)
        ConfigWatch.install(this)
        ai.ash.caps.config.CheckupWatch.install(this)
        ai.ash.host.BackgroundLaunch.install(this)
        ai.ash.host.HandRuntime.start(this)
    }
}
