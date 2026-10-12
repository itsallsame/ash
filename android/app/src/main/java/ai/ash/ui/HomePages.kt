package ai.ash.ui

import android.app.Activity
import android.view.View
import android.widget.FrameLayout

/** 「她的主页」 (stub: to be filled in). */
class HomePages(private val activity: Activity, private val port: HumanPort) : ChatHooks.Home {
    override val view: View = FrameLayout(activity).apply { visibility = View.GONE }
    override fun open() {}
    override fun back() = false
}
