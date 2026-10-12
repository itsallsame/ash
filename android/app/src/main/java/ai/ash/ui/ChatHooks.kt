package ai.ash.ui

import android.content.Intent
import android.view.View
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the native chat leaves to its neighbours, so each part can be built on its own:
 *  - [Files]: choosing what to attach (camera, gallery, files), drawing an attachment or a file/image card in a message,
 *    opening and saving a file (it reads files through [HumanPort.call] / [HumanPort.stream] as the web page did).
 *  - [Home]: 「她的主页」 — the pages behind the avatar.
 * [HomeActivity] makes them ([ChatFiles], [HomePages]) and hands them to [ChatScreen].
 */
object ChatHooks {
    interface Files {
        /** The 「+」 in the composer: [done] gets the `attachments` array for a `say` body (empty: nothing chosen). */
        fun pick(done: (JSONArray) -> Unit)
        /** A view for one attachment of a message (from the window item's `attachments`), or null to show nothing. */
        fun attachment(item: JSONObject, attachment: JSONObject, mine: Boolean): View?
        /** A view for a `file` or `image` card (`card` of a window item of type `card`), or null. */
        fun card(item: JSONObject, card: JSONObject): View?
        /** Results of activities this part started (pickers, camera, save). True when it was one of its own. */
        fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean
    }

    interface Home {
        /** Opens 「她的主页」 over the chat. */
        fun open()
        /** Back pressed while the home pages are up: true when they took it (closed a layer). */
        fun back(): Boolean
        /** The view to lay over the chat (gone while closed). */
        val view: View
    }
}
