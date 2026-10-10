package ai.ash.host.screen

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * The keep-alive flow opens this when it is done in the system's settings (the keep-alive switches): it joins
 * Ash's task, which comes back to the front as the owner left it, and closes at once, so the page the flow was started
 * from is in front again with its result. Ash's launcher entry would not do: HomeActivity is singleTask, and starting
 * it closes every page above it. It shows nothing and does nothing else; it is not exported.
 */
class ReturnActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Ash had no task left (the system cleared it): open Ash itself rather than leave the owner on nothing.
        if (isTaskRoot) packageManager.getLaunchIntentForPackage(packageName)?.let { runCatching { startActivity(it) } }
        finish()
        overridePendingTransition(0, 0)
    }
}
