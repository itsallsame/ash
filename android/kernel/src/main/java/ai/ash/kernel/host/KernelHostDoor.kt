package ai.ash.kernel.host

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process

/**
 * Where the shell host (uid 2000), launched through wireless debugging, gets the kernel bridge ([KernelBridge]). The
 * manifest guards it with INTERACT_ACROSS_USERS_FULL (only the shell and the system hold it), and the call is taken only
 * from the shell or root: no ordinary app can reach the bridge.
 */
class KernelHostDoor : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val uid = Binder.getCallingUid()
        if (uid != Process.SHELL_UID && uid != 0) throw SecurityException("only the phone's shell may call this")
        if (method != "bridge") return null
        val ctx = context ?: return null
        return Bundle().apply { putBinder("bridge", KernelBridge.get(ctx)) }
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
