package ai.ash.caps.hostshell

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process

/**
 * Where the host shell service hands Ash its binder (`call("attach", {binder})`). The manifest guards it with
 * INTERACT_ACROSS_USERS_FULL, which only the shell user and the system hold, and the call is taken only from the shell user
 * (or root): no app can hand Ash a service of its own.
 */
class HostShellDoor : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val uid = Binder.getCallingUid()
        if (uid != Process.SHELL_UID && uid != 0) throw SecurityException("only the phone's shell may call this")
        if (method != "attach") return null
        val binder = extras?.getBinder("binder") ?: return null
        val ctx = context ?: return null
        // The answer is Ash's token; clear the caller's identity so Ash's own checks run as Ash.
        val id = Binder.clearCallingIdentity()
        try { return HostShell.attach(ctx, binder) } finally { Binder.restoreCallingIdentity(id) }
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
