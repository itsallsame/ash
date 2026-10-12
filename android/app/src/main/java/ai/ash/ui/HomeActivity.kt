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
import android.util.Log
import android.graphics.Typeface
import android.view.Gravity
import android.webkit.MimeTypeMap
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.R
import ai.ash.apps.Ash
import ai.ash.apps.AppsPane
import ai.ash.BuildConfig
import ai.ash.host.HandRuntime
import ai.ash.host.KernelGate
import ai.ash.host.KernelLauncher
import ai.ash.caps.config.Permissions
import ai.ash.human.ChatBridge
import ai.ash.link.Link
import ai.ash.caps.camera.CaptureProvider
import ai.ash.ui.design.AshUi
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/**
 * Opening the app opens Ash: the chat, the packaged UI in a WebView, and nothing else on the screen — there is no tab bar, the
 * bottom is the message box's. The owner's apps ([AppsPane]) open over the chat when the page asks for them (`open_native`
 * `apps`, the 「应用」 button in its top bar); an app opens in a task of its own in the isolated process, never in here. The
 * page also asks to open the checkup ([ConsoleActivity]) and is told how many of its items need attention ([Checkup]).
 * [HomeRoute] decides which of the two an intent asks for. The page has no connection of its own: the frames it sends and
 * receives on the human channel are handed to and from the app's one connection by [ai.ash.human.ChatBridge], unchanged
 * (SPEC-05 §4.1). Native code only does what a page cannot: saving a file, clearing the browser's logins, the camera.
 */
class HomeActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var content: FrameLayout
    private var appsPane: AppsPane? = null
    private var tab = HomeTab.CHAT
    private var resumed = false
    private val ui = Handler(Looper.getMainLooper())
    private val chat get() = Link.get(this).chat
    /** Frames from the page, one at a time and in order, off the main thread (checking a big one takes a moment). */
    private val bridgeWork = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-chat-bridge").apply { isDaemon = true } }
    /** Which page load is live ([PageGate.epoch]): 0 while no verified page of the app is loaded. A message from an older page is ignored. */
    private val gate = PageGate()
    private val pageEpoch get() = gate.epoch
    /** The page attached to the chat bridge by this screen, so that closing it does not drop the page of a newer screen. */
    private var attachedPage: ChatBridge.Page? = null
    /** Where the page is told things the app says on its own ([Checkup]): the reply proxy of the live page, and what it was last told. */
    private var pageReply: androidx.webkit.JavaScriptReplyProxy? = null
    private var told: String? = null
    private var checkupBusy = false
    private val checkupWork = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-checkup-push").apply { isDaemon = true } }
    private val checkupTick = object : Runnable { override fun run() { if (resumed) { pushCheckup(); ui.postDelayed(this, CHECKUP_MS) } } }
    /** The web page's pending <input type=file> request; answered exactly once (null = cancelled). */
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private class SaveFile(val id: String, val name: String, val bytes: ByteArray, val epoch: Long, val reply: androidx.webkit.JavaScriptReplyProxy)
    private var saveFile: SaveFile? = null
    /** Where the system camera is writing the photo or video the chat asked for. */
    private var captureFile: java.io.File? = null

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    /** Which of the two themes this screen was made with: [onConfigurationChanged] comes after the resources already say the new mode, so it cannot be asked of them. */
    private var themedNight = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // A WebView's prefers-color-scheme follows the theme's isLightTheme only, not the system
        // night mode — so the theme is chosen here to make the ash UI follow the system.
        themedNight = night
        setTheme(if (themedNight) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        ai.ash.apps.Ui.systemBars(this)
        // The page holds no session of its own: everything it says goes over the app's connection.
        CookieManager.getInstance().setAcceptCookie(false)
        web = WebView(this)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            val sorry = AshUi.text(this, "这台手机的网页组件太旧，聊天页打不开。请在应用商店里把「Android System WebView」更新到新版，再回来打开 Ash。", ai.ash.ui.design.AshTokens.Type.body)
                .apply { gravity = Gravity.CENTER; setPadding(AshUi.dp(this@HomeActivity, 40), 0, AshUi.dp(this@HomeActivity, 40), 0); setBackgroundColor(AshUi.p(this@HomeActivity).bg) }
            setContentView(sorry)
            return
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            userAgentString = "$userAgentString AshApp/0.2"
        }
        // The page follows the system's dark mode by itself (its own prefers-color-scheme styles): the WebView must not darken it a second time.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        web.setBackgroundColor(AshUi.p(this).bg)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                // Child documents are never replacement main pages or native deep links.
                if (!req.isForMainFrame) return true
                if (u.scheme == "ash" && u.host == "console") {
                    openNative(HomeRoute.Native.Checkup(null))
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
                    assetLoader.shouldInterceptRequest(u)?.let {
                        // The fixed page rereads on update; content-addressed scripts keep the loader's long cache.
                        if (u.lastPathSegment == "index.html")
                            it.responseHeaders = it.responseHeaders.orEmpty() + ("Cache-Control" to "no-cache")
                        return it
                    }
                }
                return forbidden()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                ai.ash.host.AppState.homePageLive = false
                super.onPageStarted(view, url, favicon)
                // The old page's syncs end with it; a message of it that is still on its way is dropped by the epoch.
                // Its `hello` may already have been taken (the two events come from different queues): then this is the same page.
                val started = gate.started(url == UI_ASSET_URL)
                Log.i(CHAT_TAG, "page started: $started (page ${gate.epoch})")
                if (started != PageGate.Started.SAME) { chat.detach(); attachedPage = null }
                if (started == PageGate.Started.OFF) view.stopLoading()
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                ai.ash.host.AppState.homePageLive = url == UI_ASSET_URL && pageEpoch != 0L
                if (ai.ash.host.AppState.homePageLive && focusInput) focusComposer()
            }
        }

        WebViewCompat.addWebMessageListener(web, "AshNative", setOf(UI_ASSET_ORIGIN)) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.toString() != UI_ASSET_ORIGIN) return@addWebMessageListener
            val input = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            // A `hello` may come before the WebView says the page started; everything else needs a live page.
            if (input.optString("type") != "hello" && pageEpoch == 0L) return@addWebMessageListener
            val epoch = pageEpoch
            when (input.optString("type")) {
                "hello" -> {
                    val verdict = gate.hello(input.optString("doc"))
                    Log.i(CHAT_TAG, "page hello: $verdict (page ${gate.epoch}, try ${input.optInt("try")})")
                    reply.postMessage(JSONObject().put("type", "ready").toString())
                    if (verdict != PageGate.Hello.AGAIN) {
                        if (verdict == PageGate.Hello.REPLACE) { chat.detach(); attachedPage = null }
                        // From here on the page is given the human channel's frames and the state of the link.
                        val live = gate.epoch
                        val sink = ChatBridge.Page { text -> ui.post { if (pageEpoch == live) runCatching { reply.postMessage(text) } } }
                        attachedPage = sink
                        chat.attach(sink)
                        // The page is also told how the phone's checkup stands (the home page's 「这台手机」).
                        pageReply = reply; told = null
                        ui.post { pushCheckup() }
                    }
                }
                "open_native" -> ui.post { if (pageEpoch == epoch) HomeRoute.nativeFor(input.optString("page"))?.let { openNative(it) } }
                // The page asks what state the link is in (it is told at `hello`, but may have come late or missed it).
                "link_state" -> chat.resendLink()
                "frame" -> input.optJSONObject("frame")?.let { frame -> bridgeWork.execute { if (pageEpoch == epoch) chat.fromPage(frame) } }
                "file_save" -> handleFileSave(input, reply)
                "browser_logins" -> handleBrowserLogins(input, reply)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                chooseFiles(cb, params)
        }

        // Edge to edge (targetSdk 35): a WebView ignores its own padding, so the frame around it keeps clear of the bars and
        // the keyboard, and the page is laid out in what is left (its composer then sits on top of the keyboard).
        content = FrameLayout(this).apply {
            setBackgroundColor(AshUi.p(this@HomeActivity).bg)
            addView(web, FrameLayout.LayoutParams(-1, -1))
        }
        ai.ash.apps.Ui.insets(content)
        setContentView(content)
        focusInput = intent?.getBooleanExtra(EXTRA_FOCUS_INPUT, false) == true
        // A recreate (dark mode) keeps the tab; otherwise the intent says.
        val saved = HomeTab.of(savedInstanceState?.getString(STATE_TAB))
        showTab(saved ?: HomeRoute.tabFor(intent?.getStringExtra(HomeRoute.EXTRA_TAB), focusInput, fromLauncher(intent), HomeTab.CHAT))
        web.loadUrl(UI_ASSET_URL)
        val firstStart = OnboardingActivity.showOnce(this)
        // After an upgrade the phone may have put Ash's auto-start back off: look again once the link to the kernel is up.
        ui.postDelayed({ if (!isFinishing && !isDestroyed) Permissions.recheckAfterUpgrade(this, firstStart) }, 5_000)
    }

    /** Set by the widget's "跟 Ash 说"; honoured once the page is live. */
    private var focusInput = false

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val focus = intent.getBooleanExtra(EXTRA_FOCUS_INPUT, false)
        if (!::content.isInitialized) return
        showTab(HomeRoute.tabFor(intent.getStringExtra(HomeRoute.EXTRA_TAB), focus, fromLauncher(intent), tab))
        if (focus) {
            focusInput = true
            if (ai.ash.host.AppState.homePageLive) focusComposer()
        }
    }

    private fun fromLauncher(i: Intent?) = HomeRoute.isLauncher(i?.action, i?.categories)

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_TAB, tab.key)
    }

    /** Brings [next] to the front: the chat page, or the apps over it (made the first time it is wanted). */
    private fun showTab(next: HomeTab) {
        tab = next
        if (next == HomeTab.APPS && appsPane == null) {
            appsPane = AppsPane(this, Ash(this, null, inProcess = true)) { showTab(HomeTab.CHAT) }
                .also { content.addView(it.view, FrameLayout.LayoutParams(-1, -1)) }
        }
        web.visibility = if (next == HomeTab.CHAT) View.VISIBLE else View.GONE
        appsPane?.view?.visibility = if (next == HomeTab.APPS) View.VISIBLE else View.GONE
        if (next == HomeTab.APPS && resumed) appsPane?.refresh()
        syncFront()
    }

    /** What the web page asked to open (`open_native`): the apps over the chat, or the checkup page (a part of it, when one is named). */
    private fun openNative(page: HomeRoute.Native) = when (page) {
        is HomeRoute.Native.Apps -> showTab(HomeTab.APPS)
        is HomeRoute.Native.Checkup -> startActivity(Intent(this, ConsoleActivity::class.java).apply { page.part?.let { putExtra(ConsoleActivity.EXTRA_PART, it.id) } })
    }

    /** Tells the page how many items of the checkup need attention (`{type:"checkup", todo, groups}`), when that has changed; read off the main thread. */
    private fun pushCheckup() {
        val reply = pageReply ?: return
        val epoch = pageEpoch
        if (epoch == 0L || checkupBusy) return
        checkupBusy = true
        checkupWork.execute {
            val json = runCatching { Checkup.summary(this).toJson().toString() }.getOrNull()
            ui.post {
                checkupBusy = false
                if (json != null && pageEpoch == epoch && json != told) { told = json; runCatching { reply.postMessage(json) } }
            }
        }
    }

    /** What the rest of Ash goes by to know the owner is looking at the chat: not when the apps tab is in front. */
    private fun syncFront() {
        val front = HomeRoute.chatInFront(resumed, tab)
        if (ai.ash.host.AppState.homeVisible == front) return
        ai.ash.host.AppState.homeVisible = front
        if (resumed) Link.get(this).presence.tell()
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
        resumed = true
        ai.ash.host.AppState.homeVisible = HomeRoute.chatInFront(true, tab)
        HandRuntime.appOpened(this)
        Link.get(this).presence.tell()
        if (tab == HomeTab.APPS) appsPane?.refresh()
        // Back from a system settings page the checkup may have changed: look now, then every few seconds while in front.
        ui.removeCallbacks(checkupTick)
        checkupTick.run()
        // The kernel package: not installed, the guide's first step offers to install it (once); not running, it is started from here (in front, the app may).
        when (KernelGate.action(KernelLauncher.state(this), 0)) {
            KernelGate.Action.INSTALL -> OnboardingActivity.offerKernel(this)
            KernelGate.Action.START -> KernelLauncher.start(this)
            else -> {}
        }
    }

    override fun onPause() {
        resumed = false
        ui.removeCallbacks(checkupTick)
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
        // The system switched between light and dark: the screen is not made again (that would drop what the page has open, the home
        // page's layers); the parts the app draws itself take the other colours, and the page's own prefers-color-scheme follows the system.
        val nowNight = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        if (nowNight == themedNight || !::content.isInitialized) return
        themedNight = nowNight
        val bg = AshUi.p(this).bg
        window.statusBarColor = bg; window.navigationBarColor = bg; window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(bg))
        ai.ash.apps.Ui.systemBars(this)
        content.setBackgroundColor(bg)
        web.setBackgroundColor(bg)
        // The WebView takes the page's prefers-color-scheme from the theme's isLightTheme: the new theme goes over the old one, and the WebView is told the configuration changed.
        theme.applyStyle(if (themedNight) R.style.Ash_Dark else R.style.Ash_Light, true)
        web.dispatchConfigurationChanged(newConfig)
        appsPane?.themeChanged()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (tab == HomeTab.APPS) { if (appsPane?.back() != true) showTab(HomeTab.CHAT); return }
        // The page's home pages come first (`__ashHomeBack` closes the top-most layer of 「她的主页」 and says so; false: none is open), then the file view, then the page history.
        web.evaluateJavascript(BACK_SCRIPT) { closed ->
            if (closed != "true") { if (web.canGoBack()) web.goBack() else moveTaskToBack(true) }
        }
    }

    override fun onDestroy() {
        ai.ash.host.AppState.homePageLive = false
        ui.removeCallbacksAndMessages(null)
        chat.detach(attachedPage)
        appsPane?.close()
        bridgeWork.shutdown()
        checkupWork.shutdown()
        answerFiles(null)
        web.destroy()
        super.onDestroy()
    }

    @Suppress("unused")
    private fun open(u: String) = startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)))

    companion object {
        /** Open with the message box focused (the home-screen widget's "跟 Ash 说"). */
        const val EXTRA_FOCUS_INPUT = "ai.ash.extra.FOCUS_INPUT"
        private const val STATE_TAB = "ai.ash.state.TAB"
        private const val CHAT_TAG = "ash.chat"
        private const val CHECKUP_MS = 5_000L
        private const val BACK_SCRIPT = "(() => { try { if (typeof window.__ashHomeBack === 'function' && window.__ashHomeBack() === true) return true; } catch (e) {} " +
            "const f = document.querySelector('.files-view[open]'); if (!f) return false; f.close(); return true; })()"
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
