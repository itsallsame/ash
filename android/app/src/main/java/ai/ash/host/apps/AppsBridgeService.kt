package ai.ash.host.apps

import ai.ash.apps.AppIds
import ai.ash.apps.IAppsBridge
import ai.ash.human.HumanSend
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Binder
import android.os.IBinder
import android.os.Process

/**
 * The apps shell's way to Ash (the shell's pages run in the ":app" process, which has no connection to the kernel). Not
 * exported. One binding per open app: the shell binds with `ash-bridge://<app id>` (see [intent]) and that app is the only one
 * the binding may call; a bare intent is the list screen's. See [AppsBridge].
 */
class AppsBridgeService : Service() {
    override fun onBind(intent: Intent): IBinder? {
        val data = intent.data
        val app = when {
            data == null -> null
            data.scheme == SCHEME -> data.host?.takeIf { AppIds.valid(it) } ?: return null
            else -> return null
        }
        val ctx = applicationContext
        val bridge = AppsBridge(app, Process.myUid(), { Binder.getCallingUid() }) { request -> HumanSend.send(ctx, request) }
        return object : IAppsBridge.Stub() {
            override fun call(to: String?, word: String?, bodyJson: String?): String = bridge.call(to, word, bodyJson)
        }
    }

    companion object {
        private const val SCHEME = "ash-bridge"

        /** The intent that binds the bridge for [app] (null: the list screen). */
        fun intent(ctx: Context, app: String?): Intent =
            Intent(ctx, AppsBridgeService::class.java).also { if (app != null) it.data = Uri.parse("$SCHEME://$app") }
    }
}
