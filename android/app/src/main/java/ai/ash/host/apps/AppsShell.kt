package ai.ash.host.apps

import ai.ash.apps.MainActivity
import android.app.Activity
import android.content.Intent

/** The apps shell 「Ash 应用」: the owner's apps, each in its own page and task (see ai.ash.apps). */
object AppsShell {
    fun open(a: Activity) {
        a.startActivity(Intent(a, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
