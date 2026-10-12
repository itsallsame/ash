package ai.ash.caps.config

import android.app.Activity
import android.content.Intent
import android.provider.Settings
import android.widget.Toast

/** The screen side's owner-facing setup: where the accessibility switch is. */
object ScreenSetup {
    /** Where the owner turns Ash's accessibility service on. */
    fun openAccessibility(a: Activity) {
        Toast.makeText(a, "在列表里找到「Ash」并打开", Toast.LENGTH_LONG).show()
        a.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }
}
