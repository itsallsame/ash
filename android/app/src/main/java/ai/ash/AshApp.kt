package ai.ash

import android.app.Application
import android.os.Build
import android.webkit.WebView
import ai.ash.host.Notifications

class AshApp : Application() {
    override fun onCreate() {
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
