package ai.ash.link

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * The kernel host binds this service and calls [IHand.attach] with the port and token of the kernel's link server
 * (SPEC-04 §5). Only a package signed like this app holds `ai.ash.permission.HAND`, so only the kernel host can.
 * The binding is only a hand-over of connection details; all data goes over the WebSocket. Staying bound also keeps
 * the app's process at the kernel's priority.
 */
class HandService : Service() {
    private val binder = object : IHand.Stub() {
        override fun attach(port: Int, token: String?, kernelVersion: String?) {
            if (token.isNullOrEmpty() || port !in 1..65535) return
            Link.get(this@HandService).attach(port, token, kernelVersion.orEmpty().take(40))
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder
}
