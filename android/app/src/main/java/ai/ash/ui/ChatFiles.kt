package ai.ash.ui

import android.app.Activity
import android.content.Intent
import android.view.View
import org.json.JSONArray
import org.json.JSONObject

/** Attachments and files in the chat (stub: to be filled in). */
class ChatFiles(private val activity: Activity, private val port: HumanPort) : ChatHooks.Files {
    override fun pick(done: (JSONArray) -> Unit) = done(JSONArray())
    override fun attachment(item: JSONObject, attachment: JSONObject, mine: Boolean): View? = null
    override fun card(item: JSONObject, card: JSONObject): View? = null
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) = false
}
