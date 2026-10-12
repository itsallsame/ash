package ai.ash.caps.hostshell

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process

/**
 * Where the kernel host (the shell user, launched through wireless debugging) hands this app what it needs: the phone-action
 * whitelist (`call("actions", {actions})`) and the core's local link details (`call("hand", {port, token})`). The manifest
 * guards it with INTERACT_ACROSS_USERS_FULL, which only the shell user and the system hold, and the call is taken only from
 * the shell user or root: no ordinary app can push Ash a binder of its own.
 */
class HostShellDoor : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val uid = Binder.getCallingUid()
        if (uid != Process.SHELL_UID && uid != 0) throw SecurityException("only the phone's shell may call this")
        val ctx = context ?: return null
        // Clear the caller's identity so Ash's own checks run as Ash.
        val id = Binder.clearCallingIdentity()
        try {
            return when (method) {
                "actions" -> HostShell.attach(ctx, extras?.getBinder("actions") ?: return null)
                "hand" -> {
                    val port = extras?.getInt("port") ?: return null
                    val token = extras.getString("token") ?: return null
                    if (port in 1..65535 && token.isNotEmpty()) {
                        ai.ash.link.Link.get(ctx).attach(port, token, extras.getString("version").orEmpty().take(40))
                        Bundle().apply { putBoolean("ok", true) }
                    } else null
                }
                else -> null
            }
        } finally {
            Binder.restoreCallingIdentity(id)
        }
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
