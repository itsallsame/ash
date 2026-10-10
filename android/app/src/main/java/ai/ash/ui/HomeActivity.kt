package ai.ash.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.view.Gravity
import android.webkit.MimeTypeMap
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import ai.ash.R
import ai.ash.BuildConfig
import ai.ash.host.HandRuntime
import ai.ash.host.KernelLauncher
import ai.ash.caps.config.Permissions
import ai.ash.link.Link
import ai.ash.caps.camera.CaptureProvider
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/**
 * Opening the app opens Ash: the packaged UI in a WebView. The page has no connection of its own: the frames it sends and
 * receives on the human channel are handed to and from the app's one connection by [ai.ash.human.ChatBridge], unchanged
 * (SPEC-05 §4.1). Native code only does what a page cannot: saving a file, clearing the browser's logins, the camera.
 */
class HomeActivity : Activity() {
    private lateinit var web: WebView
    private val ui = Handler(Looper.getMainLooper())
    private val chat get() = Link.get(this).chat
    /** Frames from the page, one at a time and in order, off the main thread (checking a big one takes a moment). */
    private val bridgeWork = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-chat-bridge").apply { isDaemon = true } }
    private var pageCount = 0L
    /** Which page load is live: 0 while no verified page of the app is loaded. A message from an older page is ignored. */
    @Volatile private var pageEpoch = 0L
    /** The web page's pending <input type=file> request; answered exactly once (null = cancelled). */
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private class SaveFile(val id: String, val name: String, val bytes: ByteArray, val epoch: Long, val reply: androidx.webkit.JavaScriptReplyProxy)
    private var saveFile: SaveFile? = null
    /** Where the system camera is writing the photo or video the chat asked for. */
    private var captureFile: java.io.File? = null

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // A WebView's prefers-color-scheme follows the theme's isLightTheme only, not the system
        // night mode — so the theme is chosen here to make the ash UI follow the system.
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        // The page holds no session of its own: everything it says goes over the app's connection.
        CookieManager.getInstance().setAcceptCookie(false)
        if (BuildConfig.ISOLATED_PROBE) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply { text = "当前 WebView 不支持 Ash 安全通信"; textSize = 15f; gravity = Gravity.CENTER })
            return
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            userAgentString = "$userAgentString AshApp/0.2"
        }
        web.setBackgroundColor(if (night) 0xFF141415.toInt() else 0xFFF7F7F5.toInt())
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                // Child documents are never replacement main pages or native deep links.
                if (!req.isForMainFrame) return true
                if (u.scheme == "ash" && u.host == "console") {
                    startActivity(Intent(this@HomeActivity, ConsoleActivity::class.java))
                    return true
                }
                if (u.scheme == "ash" && u.host == "permission") {
                    Permissions.all.find { it.key == u.pathSegments.singleOrNull() }?.open(this@HomeActivity)
                    return true
                }
                if (u.toString() == UI_ASSET_URL) return false
                if ((u.scheme == "http" || u.scheme == "https") && u.host != "127.0.0.1" && u.host != "localhost")
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }

            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.scheme == "https" && u.host == "appassets.androidplatform.net" && u.port == -1 &&
                    u.encodedPath?.startsWith("/assets/ash-ui/") == true && u.encodedPath?.contains("..") != true &&
                    u.query == null && u.fragment == null) {
                    assetLoader.shouldInterceptRequest(u)?.let { return it }
                }
                return forbidden()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                ai.ash.host.AppState.homePageLive = false
                super.onPageStarted(view, url, favicon)
                // The old page's syncs end with it; a message of it that is still on its way is dropped by the epoch.
                chat.detach()
                pageEpoch = if (url == UI_ASSET_URL) ++pageCount else 0L
                if (pageEpoch == 0L) view.stopLoading()
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                ai.ash.host.AppState.homePageLive = url == UI_ASSET_URL && pageEpoch != 0L
                if (ai.ash.host.AppState.homePageLive && focusInput) focusComposer()
            }
        }

        WebViewCompat.addWebMessageListener(web, "AshNative", setOf(UI_ASSET_ORIGIN)) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.toString() != UI_ASSET_ORIGIN || pageEpoch == 0L) return@addWebMessageListener
            val input = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            val epoch = pageEpoch
            when (input.optString("type")) {
                "hello" -> {
                    reply.postMessage(JSONObject().put("type", "ready").toString())
                    // From here on the page is given the human channel's frames and the state of the link.
                    chat.attach { text -> ui.post { if (pageEpoch == epoch) runCatching { reply.postMessage(text) } } }
                }
                "frame" -> input.optJSONObject("frame")?.let { frame -> bridgeWork.execute { if (pageEpoch == epoch) chat.fromPage(frame) } }
                "file_save" -> handleFileSave(input, reply)
                "browser_logins" -> handleBrowserLogins(input, reply)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                chooseFiles(cb, params)
        }

        setContentView(web)
        focusInput = intent?.getBooleanExtra(EXTRA_FOCUS_INPUT, false) == true
        web.loadUrl(UI_ASSET_URL)
        val firstStart = OnboardingActivity.showOnce(this)
        // After an upgrade the phone may have put Ash's auto-start back off: look again once the helper has connected.
        ui.postDelayed({ if (!isFinishing && !isDestroyed) Permissions.recheckAfterUpgrade(this, firstStart) }, 5_000)
    }

    /** Set by the widget's "跟 Ash 说"; honoured once the page is live. */
    private var focusInput = false

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_FOCUS_INPUT, false)) {
            focusInput = true
            if (ai.ash.host.AppState.homePageLive) focusComposer()
        }
    }

    private fun focusComposer() {
        focusInput = false
        // Give the page a moment to lay out after coming to the front, then focus the message box and raise the keyboard.
        ui.postDelayed({
            if (isFinishing || isDestroyed) return@postDelayed
            web.requestFocus()
            web.evaluateJavascript("(() => { const t = document.getElementById('t'); if (!t) return false; t.focus(); return true; })()") { focused ->
                if (focused == "true") getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.showSoftInput(web, 0)
            }
        }, 300)
    }

    override fun onResume() {
        super.onResume()
        ai.ash.host.AppState.homeVisible = true
        HandRuntime.appOpened(this)
        Link.get(this).presence.tell()
        // In front, the app may start the kernel service; do it when the kernel has not handed over a connection.
        if (!KernelLauncher.connected(this)) KernelLauncher.start(this)
    }

    override fun onPause() {
        ai.ash.host.AppState.homeVisible = false
        HandRuntime.appLeft()
        Link.get(this).presence.tell()
        super.onPause()
    }

    private fun handleBrowserLogins(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id) || input.optString("operation") != "clear") return
        val epoch = pageEpoch
        Thread {
            val ok = ai.ash.caps.browser.BrowserSession.clearLogins(applicationContext)
            runOnUiThread { if (pageEpoch == epoch) reply.postMessage(JSONObject().put("type", "browser_logins_result").put("id", id).put("ok", ok).toString()) }
        }.start()
    }

    /**
     * The page has the file's bytes (it read them through the human channel) and asks for a place to put them:
     * `{type:"file_save", id, name, mime?, b64}`; the system file picker chooses it. Answered with `file_save_result`.
     */
    private fun handleFileSave(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id)) return
        fun rejected() { ui.post { runCatching { reply.postMessage(JSONObject().put("type", "file_save_result").put("id", id).put("ok", false).toString()) } } }
        val epoch = pageEpoch
        val name = input.optString("name").substringAfterLast('/').filter { it.code >= 32 && it.code != 127 }.take(200)
        val b64 = input.optString("b64")
        if (saveFile != null || name.isEmpty() || b64.length > MAX_SAVE_B64) { rejected(); return }
        bridgeWork.execute {
            val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()
            ui.post {
                if (bytes == null || bytes.size > MAX_SAVE_BYTES || saveFile != null || pageEpoch != epoch) return@post rejected()
                saveFile = SaveFile(id, name, bytes, epoch, reply)
                val mime = input.optString("mime").takeIf { it.matches(Regex("[a-z0-9.+-]+/[a-z0-9.+*-]+")) }
                    ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
                try {
                    startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(mime).putExtra(Intent.EXTRA_TITLE, name), REQ_SAVE_FILE)
                } catch (_: Exception) { saveFile = null; rejected() }
            }
        }
    }

    private fun finishFileSave(resultCode: Int, uri: Uri?) {
        val pending = saveFile ?: return
        saveFile = null
        fun respond(ok: Boolean, cancelled: Boolean = false) { runOnUiThread {
            if (pageEpoch == pending.epoch) runCatching { pending.reply.postMessage(JSONObject().put("type", "file_save_result")
                .put("id", pending.id).put("ok", ok).put("cancelled", cancelled).toString()) }
        } }
        if (resultCode != RESULT_OK || uri == null) { respond(false, true); return }
        bridgeWork.execute {
            val ok = runCatching { contentResolver.openOutputStream(uri, "w")?.use { it.write(pending.bytes) } ?: error("destination unavailable") }.isSuccess
            respond(ok)
        }
    }

    private fun forbidden() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /**
     * Answers the web UI's attachment menu: the camera for 拍照 / 录像 (images or videos only, with capture), the
     * photo picker for 从相册选 (images and videos), the system file picker otherwise (several files at once).
     */
    private fun chooseFiles(cb: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        answerFiles(null) // a request still open (should not happen) is cancelled, not dropped
        fileCallback = cb
        // createIntent() only uses the first accept type; "image/*,.pdf" must offer both.
        val mimes = params.acceptTypes.orEmpty().flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.substring(1)) ?: "*/*" else it }.distinct()
        val images = mimes.isNotEmpty() && mimes.all { it.startsWith("image/") }
        val videos = mimes.isNotEmpty() && mimes.all { it.startsWith("video/") }
        if (params.isCaptureEnabled && (images || videos) && capture(videos)) return true
        if (mimes.isNotEmpty() && mimes.all { it.startsWith("image/") || it.startsWith("video/") } && Build.VERSION.SDK_INT >= 33) {
            val gallery = Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                if (images) type = "image/*" else if (videos) type = "video/*"
                if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, minOf(32, MediaStore.getPickImagesMaxLimit()))
            }
            try { startActivityForResult(gallery, REQ_FILES); return true } catch (e: ActivityNotFoundException) { /* the system picker below */ }
        }
        val pick = try { params.createIntent() } catch (e: Throwable) { null }
            ?: Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        if (mimes.size > 1 && "*/*" !in mimes) {
            pick.type = "*/*"
            pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        } else if (pick.type.isNullOrEmpty() || "*/*" in mimes || pick.type?.startsWith(".") == true) pick.type = "*/*"
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try {
            startActivityForResult(Intent.createChooser(pick, "选择文件"), REQ_FILES)
        } catch (e: ActivityNotFoundException) {
            answerFiles(null)
        }
        return true
    }

    /** The system camera writes one photo or video into Ash's capture folder; the chat then sends it as a chosen file. */
    private fun capture(video: Boolean): Boolean {
        val file = CaptureProvider.newFile(this, if (video) "video" else "photo", if (video) "mp4" else "jpg")
        val uri = CaptureProvider.uriFor(this, file)
        val intent = Intent(if (video) MediaStore.ACTION_VIDEO_CAPTURE else MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.clipData = ClipData.newRawUri(if (video) "video" else "photo", uri)
        // The chat sends files up to 20 MiB.
        if (video) intent.putExtra(MediaStore.EXTRA_SIZE_LIMIT, 19L * 1024 * 1024)
        return try {
            startActivityForResult(intent, REQ_CAPTURE)
            captureFile = file
            true
        } catch (e: ActivityNotFoundException) {
            file.delete(); false
        } catch (e: SecurityException) {
            file.delete(); false
        }
    }

    private fun finishCapture(resultCode: Int, data: Intent?) {
        val file = captureFile
        captureFile = null
        if (resultCode == RESULT_OK && file != null && file.length() == 0L) {
            // A camera app that ignored the output file may still hand back a small photo.
            @Suppress("DEPRECATION") val thumb = data?.extras?.get("data") as? android.graphics.Bitmap
            if (thumb != null) runCatching { file.outputStream().use { thumb.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, it) } }
        }
        val elsewhere = data?.data?.takeIf { it.authority != "$packageName.capture" }
        val uri = when {
            resultCode != RESULT_OK -> null
            file != null && file.length() > 0 -> CaptureProvider.uriFor(this, file)
            else -> elsewhere // a camera app that saved the video its own way
        }
        if (uri == null || uri == elsewhere) file?.delete()
        answerFiles(uri?.let { arrayOf(it) })
    }

    private fun answerFiles(uris: Array<Uri>?) {
        val cb = fileCallback ?: return
        fileCallback = null
        try { cb.onReceiveValue(uris) } catch (_: Throwable) {}
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_SAVE_FILE) { finishFileSave(resultCode, data?.data); return }
        if (requestCode == REQ_CAPTURE) { finishCapture(resultCode, data); return }
        if (requestCode != REQ_FILES) return super.onActivityResult(requestCode, resultCode, data)
        val uris = LinkedHashSet<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            // Several files come as ClipData; a single one may come as data (or both, on some pickers).
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) } }
            data.data?.let { uris.add(it) }
        }
        answerFiles(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if ((newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) != (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)) recreate()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(() => { const f = document.querySelector('.files-view[open]'); if (!f) return false; f.close(); return true; })()") { closed ->
            if (closed != "true") { if (web.canGoBack()) web.goBack() else moveTaskToBack(true) }
        }
    }

    override fun onDestroy() {
        ai.ash.host.AppState.homePageLive = false
        ui.removeCallbacksAndMessages(null)
        chat.detach()
        bridgeWork.shutdown()
        answerFiles(null)
        web.destroy()
        super.onDestroy()
    }

    @Suppress("unused")
    private fun open(u: String) = startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)))

    companion object {
        /** Open with the message box focused (the home-screen widget's "跟 Ash 说"). */
        const val EXTRA_FOCUS_INPUT = "ai.ash.extra.FOCUS_INPUT"
        private const val UI_ASSET_ORIGIN = "https://appassets.androidplatform.net"
        private const val UI_ASSET_URL = "$UI_ASSET_ORIGIN/assets/ash-ui/index.html"
        private const val REQ_FILES = 7101
        private const val REQ_SAVE_FILE = 7102
        private const val REQ_CAPTURE = 7104
        /** The chat sends files up to 20 MiB; a saved file is held to the same. */
        private const val MAX_SAVE_BYTES = 20 * 1024 * 1024
        private const val MAX_SAVE_B64 = MAX_SAVE_BYTES / 3 * 4 + 8
    }
}
