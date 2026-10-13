package ai.ash.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import ai.ash.material.MaterialNativeScope
import ai.ash.material.MaterialNativeScreenObserver
import ai.ash.material.MaterialNativeSelectionBridge
import ai.ash.material.MaterialNativeBatchPicker
import ai.ash.material.MaterialNativeHttpImportPort
import ai.ash.material.NativeSelection
import ai.ash.material.materialNativeSelectIntent
import ai.ash.material.materialPickerResultError
import ai.ash.material.materialImageSelectionError
import ai.ash.material.materialNativeIngressPath
import ai.ash.R
import ai.ash.BuildConfig
import ai.ash.host.CoreEndpoint
import ai.ash.host.CoreProcess
import ai.ash.host.CoreService
import ai.ash.host.Paths
import ai.ash.host.Permissions
import ai.ash.host.Secrets
import ai.ash.host.media.CaptureProvider
import ai.ash.ui.transport.CoreCancellation
import ai.ash.ui.transport.CoreUiRequest
import ai.ash.ui.transport.FixedCoreClient
import ai.ash.ui.transport.ownerBearerFromPrivateUiUrl
import ai.ash.ui.transport.workspaceContentRoute
import ai.ash.ui.transport.workspaceReadRoute
import ai.ash.ui.transport.FILE_CSP
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Opening the app opens Ash: the packaged UI in a WebView; native code talks to core. While
 * the core is installing or starting, a native status screen shows what is happening.
 */
class HomeActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var cover: LinearLayout
    private lateinit var status: TextView
    private lateinit var action: Button
    private val ui = Handler(Looper.getMainLooper())
    private var loaded = false
    @Volatile private var pageEpoch = 0L
    private val sharedText = SharedTextInbox()
    private var shareReply: androidx.webkit.JavaScriptReplyProxy? = null
    private var shareReplyEpoch = 0L
    private var coreUi: FixedCoreClient? = null
    private val requests = ConcurrentHashMap<String, CoreCancellation>()
    @Volatile private var materialScope: MaterialNativeScope? = null
    @Volatile private var materialBridge: MaterialNativeSelectionBridge? = null
    @Volatile private var materialBearer: String? = null
    @Volatile private var materialNativeProof: String? = null
    private val materialExecutor = java.util.concurrent.Executors.newFixedThreadPool(2)
    private data class MaterialPickerPending(val epoch: Long, val requestCode: Int, val maxFiles: Int, val failed: (String) -> Unit, val done: (List<NativeSelection>?) -> Unit)
    private var materialPickerPending: MaterialPickerPending? = null
    private var nextMaterialPickerCode = REQ_MATERIAL_FIRST
    /** The web page's pending <input type=file> request; answered exactly once (null = cancelled). */
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private data class SaveFile(val id: String, val path: String, val epoch: Long, val reply: androidx.webkit.JavaScriptReplyProxy)
    private var saveFile: SaveFile? = null
    private data class SaveResult(val id: String, val epoch: Long, val screenToken: String, val body: ByteArray, val reply: androidx.webkit.JavaScriptReplyProxy, var snapshot: ResultFileSnapshot? = null, var finishing: Boolean = false)
    private var saveResult: SaveResult? = null
    /** Where the system camera is writing the photo or video the chat asked for. */
    private var captureFile: java.io.File? = null

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // A WebView's prefers-color-scheme follows the theme's isLightTheme only, not the system
        // night mode — so the theme is chosen here to make the ash UI follow the system.
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        CoreService.start(this)

        // Browser cookies are not port-scoped. This WebView never receives the core owner token.
        CookieManager.getInstance().setAcceptCookie(false)
        if (BuildConfig.ISOLATED_PROBE) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
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
                // Files are sandboxed child documents, never replacement main pages or native deep links.
                if (!req.isForMainFrame) return workspaceContentRoute(u.toString()) == null
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
                val fileRoute = workspaceContentRoute(u.toString())
                if (!req.isForMainFrame && req.method == "GET" && fileRoute != null) {
                    val epoch = pageEpoch
                    return runCatching {
                        val result = coreUi?.execute(epoch, CoreUiRequest("GET", fileRoute)) ?: return@runCatching forbidden()
                        val mime = result.contentType.substringBefore(';')
                        WebResourceResponse(mime, if (mime.startsWith("text/")) "UTF-8" else null,
                            result.status, if (result.status == 200) "OK" else "Unavailable",
                            mapOf("Content-Security-Policy" to FILE_CSP, "X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-store", "Referrer-Policy" to "no-referrer"),
                            ByteArrayInputStream(result.body))
                    }.getOrElse { forbidden() }
                }
                if (u.scheme == "https" && u.host == "appassets.androidplatform.net" && u.port == -1 &&
                    u.encodedPath?.startsWith("/assets/ash-ui/") == true && u.encodedPath?.contains("..") != true &&
                    u.query == null && u.fragment == null) {
                    assetLoader.shouldInterceptRequest(u)?.let { return it }
                }
                return forbidden()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                shareReply = null
                shareReplyEpoch = 0L
                ai.ash.host.AppState.homePageLive = false
                super.onPageStarted(view, url, favicon)
                invalidateMaterials()
                requests.values.forEach { it.cancel() }
                requests.clear()
                pageEpoch = 0L
                saveResult?.snapshot?.bytes?.fill(0); saveResult = null
                coreUi?.invalidate()
                pageEpoch = if (url == UI_ASSET_URL) coreUi?.beginPage(true) ?: 0L else 0L
                if (pageEpoch == 0L) { loaded = false; cover.visibility = View.VISIBLE; view.stopLoading() }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                ai.ash.host.AppState.homePageLive = url == UI_ASSET_URL && pageEpoch != 0L
                if (ai.ash.host.AppState.homePageLive && focusInput) focusComposer()
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) {
                    loaded = false
                    cover.visibility = View.VISIBLE
                }
            }
        }

        val bridgeSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (bridgeSupported) {
            WebViewCompat.addWebMessageListener(web, "AshNative", setOf(UI_ASSET_ORIGIN)) { _, message, origin, mainFrame, reply ->
                if (!mainFrame || origin.toString() != UI_ASSET_ORIGIN || pageEpoch == 0L) return@addWebMessageListener
                val input = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
                when (input.optString("type")) {
                    "hello" -> {
                        shareReply = reply
                        shareReplyEpoch = pageEpoch
                        reply.postMessage(JSONObject().put("type", "ready")
                            .put("endpoint", "http://127.0.0.1:${BuildConfig.CORE_PORT}").toString())
                        deliverSharedText()
                    }
                    "share_text_ack" -> sharedText.acknowledge(input.optString("id"))
                    "cancel" -> requests.remove(input.optString("id"))?.cancel()
                    "request" -> handleNativeRequest(input, reply)
                    "material_select", "material_cancel", "material_picker_close" -> handleMaterialMessage(origin.toString(), mainFrame, message.data ?: "", reply)
                    "file_save" -> handleFileSave(input, reply)
                    "result_file_save" -> handleResultFileSave(input, reply)
                    "gateway_config" -> handleGatewaySetting(input, reply)
                    "browser_logins" -> handleBrowserLogins(input, reply)
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                chooseFiles(cb, params)
        }

        val fg = if (night) Color.rgb(236, 236, 238) else Color.rgb(28, 28, 30)
        status = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(48, 24, 48, 24) }
        action = Button(this).apply { text = "诊断"; setOnClickListener { startActivity(Intent(this@HomeActivity, ConsoleActivity::class.java)) } }
        cover = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(if (night) 0xFF141415.toInt() else 0xFFF7F7F5.toInt())
            addView(TextView(context).apply { text = "Ash"; textSize = 28f; setTextColor(fg); gravity = Gravity.CENTER })
            addView(ProgressBar(context).apply { isIndeterminate = true })
            addView(status)
            addView(action, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(-1, -1))
            addView(cover, FrameLayout.LayoutParams(-1, -1))
        })
        if (!bridgeSupported) { status.text = "当前 WebView 不支持 Ash 安全通信"; return }
        focusInput = intent?.getBooleanExtra(EXTRA_FOCUS_INPUT, false) == true
        if (savedInstanceState != null) {
            sharedText.restore(savedInstanceState.getString("ash.share.id"), savedInstanceState.getString("ash.share.text"))
        } else {
            receiveSharedText(intent)
        }
        poll()
        OnboardingActivity.showOnce(this)
    }

    private fun poll() {
        if (isFinishing || isDestroyed) return
        val p = Paths(this)
        val st = CoreService.state
        status.text = when {
            st == "installing" -> "正在安装运行环境… ${CoreService.installProgress.takeIf { it >= 0 }?.let { "$it%" } ?: ""}\n（首次安装或升级后需要一两分钟）"
            st == "preparing" -> "正在准备 Ash 的工作环境… ${CoreService.installProgress.takeIf { it >= 0 }?.let { "$it%" } ?: ""}\n（首次安装或升级后需要一两分钟）"
            st == "stopped" -> "Ash 已停止"
            st.startsWith("error") -> "出错了：${st.removePrefix("error: ")}"
            else -> "正在启动…"
        }
        action.visibility = if (st == "stopped" || st.startsWith("error")) View.VISIBLE else View.GONE
        if (!loaded && p.uiUrl.exists() && (!BuildConfig.ISOLATED_PROBE || st == "running")) {
            Thread {
                val ok = CoreProcess(this).portOpen(1000)
                if (ok) ui.post { load(p.uiUrl.readText().trim()) }
            }.start()
        }
        ui.postDelayed({ poll() }, 1000)
    }

    /** Set by the widget's "跟 Ash 说"; honoured once the page is live. */
    private var focusInput = false

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveSharedText(intent)
        if (intent.getBooleanExtra(EXTRA_FOCUS_INPUT, false)) {
            focusInput = true
            if (ai.ash.host.AppState.homePageLive) focusComposer()
        }
    }

    private fun receiveSharedText(incoming: Intent?) {
        if (incoming?.action != Intent.ACTION_SEND && incoming?.action != Intent.ACTION_SEND_MULTIPLE) return
        // Never read ClipData, EXTRA_STREAM or a content URI from an external share.
        val text = runCatching { incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() }.getOrNull()
        val rejection = sharedText.receive(incoming.action, incoming.type, text)
        incoming.removeExtra(Intent.EXTRA_TEXT)
        incoming.clipData = null
        incoming.action = Intent.ACTION_MAIN
        if (rejection != null) {
            val message = when (rejection) {
                SharedTextInbox.Rejection.UNSUPPORTED -> "请分享含链接的文字"
                SharedTextInbox.Rejection.TOO_LARGE -> "分享内容太长"
                SharedTextInbox.Rejection.BUSY -> "请先处理当前分享"
            }
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
            return
        }
        deliverSharedText()
    }

    private fun deliverSharedText() {
        val draft = sharedText.pending ?: return
        val reply = shareReply ?: return
        if (shareReplyEpoch == 0L || shareReplyEpoch != pageEpoch) return
        // A page reload retains the same id until the page has safely taken over the draft.
        runCatching { reply.postMessage(JSONObject().put("type", "share_text")
            .put("id", draft.id).put("text", draft.text).toString()) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        sharedText.pending?.let { outState.putString("ash.share.id", it.id); outState.putString("ash.share.text", it.text) }
        super.onSaveInstanceState(outState)
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
        CoreService.start(this, CoreService.ACTION_APP_OPEN)
    }

    override fun onPause() {
        ai.ash.host.AppState.homeVisible = false
        CoreService.start(this, CoreService.ACTION_APP_LEFT)
        super.onPause()
    }

    private fun load(url: String) {
        if (loaded) return
        if (!CoreEndpoint.acceptsUiUrl(url, BuildConfig.CORE_PORT)) {
            status.text = "核心地址不匹配"
            cover.visibility = View.VISIBLE
            return
        }
        val token = try { ownerBearerFromPrivateUiUrl(url, BuildConfig.CORE_PORT) }
            catch (_: Exception) { status.text = "核心凭据不可用"; return }
        val nativeProof = java.security.MessageDigest.getInstance("SHA-256")
            .digest("${Secrets(this).hostToken}:home".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        invalidateMaterials()
        materialBearer = token
        materialNativeProof = nativeProof
        coreUi = FixedCoreClient(BuildConfig.CORE_PORT, bearer = { token }, nativeUiToken = nativeProof)
        loaded = true
        web.loadUrl(UI_ASSET_URL)
        ui.postDelayed({ cover.visibility = View.GONE }, 400)
    }

    private fun handleNativeRequest(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val client = coreUi ?: return
        val epoch = pageEpoch
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id) || requests.containsKey(id)) return
        val path = input.optString("path")
        // The generic page proxy must not inherit native source-ingress authority.
        val nativeIngress = materialNativeIngressPath(path)
        if (nativeIngress) { reply.postMessage(JSONObject().put("type", "error").put("id", id).toString()); return }
        val method = input.optString("method")
        // Which requests are allowed is the core's decision; the page can only reach the core's own address.
        if (path.length > 1024 || method !in setOf("GET", "POST", "PUT", "DELETE")) return
        val headersJson = input.optJSONObject("headers") ?: JSONObject()
        val headers = headersJson.keys().asSequence().associateWith { headersJson.optString(it) }
        val rawBody = input.opt("body")
        if (rawBody != JSONObject.NULL && rawBody != null && rawBody !is String) return
        if (rawBody is String && rawBody.length > 28 * 1024 * 1024) return
        val request = CoreUiRequest(method, path, headers, (rawBody as? String)?.toByteArray(Charsets.UTF_8))
        val cancellation = CoreCancellation()
        requests[id] = cancellation
        val live = path.startsWith("/api/stream?") && path.contains("follow=true")
        val materialObserver = if (live) MaterialNativeScreenObserver(
            registration = { control -> observeMaterialScreen(epoch, control) },
            scopeChanged = { observed -> ui.post { if (pageEpoch == epoch && materialScope?.authScope?.let { it != observed } == true) invalidateMaterials() } },
        ) else null
        fun respond(message: JSONObject) {
            ui.post { if (pageEpoch == epoch && !cancellation.cancelled) runCatching { reply.postMessage(message.put("id", id).toString()) } }
        }
        if (live) respond(JSONObject().put("type", "started"))
        Thread {
            try {
                val result = client.execute(epoch, request, cancellation) { chunk ->
                    materialObserver?.accept(chunk)
                    respond(JSONObject().put("type", "chunk").put("body", Base64.encodeToString(chunk, Base64.NO_WRAP)))
                }
                respond(JSONObject().put("type", "done").put("status", result.status)
                    .put("content_type", result.contentType)
                    .put("body", Base64.encodeToString(result.body, Base64.NO_WRAP)))
            } catch (_: Exception) { respond(JSONObject().put("type", "error")) }
            finally { requests.remove(id, cancellation) }
        }.start()
    }

    private fun invalidateMaterials() {
        materialBridge?.close(); materialBridge = null; materialScope = null
        materialPickerPending?.let { pending -> materialPickerPending = null; runCatching { pending.done(null) } }
    }

    /** Core-authenticated SSE registration is the only native screen binding source. */
    private fun observeMaterialScreen(epoch: Long, control: JSONObject) {
        val token = materialBearer ?: return
        val credential = java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        val captured = MaterialNativeScope(epoch, control.getString("screen"), control.getString("token"), control.getString("auth_scope"), credential)
        ui.post {
            if (pageEpoch != epoch || isDestroyed || materialBearer != token) return@post
            if (materialScope == captured) return@post
            invalidateMaterials(); materialScope = captured
            materialBridge = createMaterialBridge(captured)
        }
    }

    private fun createMaterialBridge(captured: MaterialNativeScope): MaterialNativeSelectionBridge {
        fun current(candidate: MaterialNativeScope) {
            check(!isDestroyed && pageEpoch == candidate.pageEpoch && materialScope == candidate)
            val bearer = materialBearer ?: error("native owner unavailable")
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bearer.toByteArray())
                .joinToString("") { "%02x".format(it.toInt() and 255) }
            check(digest == candidate.credentialGeneration)
        }
        val proof = materialNativeProof ?: error("native host unavailable")
        val port = MaterialNativeHttpImportPort(BuildConfig.CORE_PORT,
            bearer = { materialBearer ?: error("native owner unavailable") }, nativeUiProof = proof, current = ::current)
        return MaterialNativeSelectionBridge(scope = { materialScope ?: error("native screen unavailable") }, current = ::current,
            picker = object : MaterialNativeBatchPicker {
                override fun select(maxFiles: Int, failed: (String) -> Unit, done: (List<NativeSelection>?) -> Unit) {
                    current(captured)
                    check(materialPickerPending == null)
                    check(nextMaterialPickerCode <= REQ_MATERIAL_LAST)
                    val requestCode = nextMaterialPickerCode++
                    materialPickerPending = MaterialPickerPending(captured.pageEpoch, requestCode, maxFiles, failed, done)
                    try {
                        startActivityForResult(materialNativeSelectIntent(maxFiles), requestCode)
                    } catch (error: Exception) { materialPickerPending = null; throw error }
                }
                override fun cancel() { materialPickerPending?.let { pending -> materialPickerPending = null; runCatching { pending.done(null) } } }
            }, port = port, execute = { materialExecutor.execute(it) }, post = { ui.post(it) })
    }

    private fun handleMaterialMessage(origin: String, mainFrame: Boolean, raw: String, reply: androidx.webkit.JavaScriptReplyProxy) {
        val captured = materialScope
        if (captured == null || captured.pageEpoch != pageEpoch) {
            val input = runCatching { JSONObject(raw) }.getOrNull() ?: return
            val id = input.optString("id")
            if (id.length !in 1..256) return
            reply.postMessage(JSONObject().put("type", "${input.optString("type")}_result").put("id", id).put("ok", false)
                .put("error", JSONObject().put("code", "offline").put("message", "Material native screen unavailable")).toString())
            return
        }
        val bridge = materialBridge ?: createMaterialBridge(captured).also { materialBridge = it }
        bridge.receive(origin, mainFrame, pageEpoch, raw) { response -> reply.postMessage(response) }
        if (runCatching { JSONObject(raw).optString("type") }.getOrNull() == "material_picker_close") materialBridge = null
    }

    private fun finishMaterialPicker(resultCode: Int, data: Intent?) {
        val pending = materialPickerPending ?: return
        materialPickerPending = null
        if (resultCode == RESULT_CANCELED) { pending.done(null); return }
        if (pending.epoch != pageEpoch) { pending.failed("permission_denied"); return }
        if (resultCode != RESULT_OK || data == null) { pending.failed("offline"); return }
        val uris = linkedSetOf<Uri>()
        data.clipData?.let { clip -> for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri) }
        data.data?.let { uris.add(it) }
        materialPickerResultError(pending.maxFiles, uris.size, uris.all { it.scheme == "content" })?.let {
            pending.failed(it); return
        }
        try { materialExecutor.execute {
            val opened = mutableListOf<NativeSelection>()
            try {
                for (uri in uris) {
                    check(pending.epoch == pageEpoch && materialScope != null && !isDestroyed)
                    var name = "材料"; var size: Long? = null
                    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn)
                            if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn)
                        }
                    }
                    val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                    if (pending.maxFiles == 1) {
                        materialImageSelectionError(mime, size)?.let { code ->
                            opened.forEach { runCatching { it.input.close() } }
                            pending.failed(code); return@execute
                        }
                    }
                    val stream = contentResolver.openInputStream(uri) ?: error("native selection unavailable")
                    opened.add(NativeSelection(name, mime, size, stream))
                    check(pending.epoch == pageEpoch && materialScope != null && !isDestroyed)
                }
                pending.done(opened)
            } catch (_: Exception) { opened.forEach { runCatching { it.input.close() } }; runCatching { pending.failed("offline") } }
        } } catch (_: Exception) { pending.failed("offline") }
    }

    private fun handleBrowserLogins(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id) || input.optString("operation") != "clear") return
        val epoch = pageEpoch
        Thread {
            val ok = ai.ash.host.browser.BrowserSession.clearLogins(applicationContext)
            runOnUiThread { if (pageEpoch == epoch) reply.postMessage(JSONObject().put("type", "browser_logins_result").put("id", id).put("ok", ok).toString()) }
        }.start()
    }

    private fun resultFileRequest(pending: SaveResult, operation: String): ai.ash.ui.transport.CoreUiReply {
        check(pageEpoch == pending.epoch && !isDestroyed)
        val result = coreUi?.execute(pending.epoch, CoreUiRequest("POST", "/api/collaboration/result-files/native/$operation",
            mapOf("content-type" to "application/json", "ash-screen" to pending.screenToken), pending.body)) ?: error("core unavailable")
        check(result.status == 200 && pageEpoch == pending.epoch && !isDestroyed)
        check(JSONObject(result.body.toString(Charsets.UTF_8)).getBoolean("ok")); return result
    }
    private fun resultFileReply(pending: SaveResult, ok: Boolean, cancelled: Boolean = false) {
        ui.post { if (pageEpoch == pending.epoch && !isDestroyed) runCatching { pending.reply.postMessage(JSONObject().put("type", "result_file_save_result")
            .put("id", pending.id).put("ok", ok).put("cancelled", cancelled).toString()) } }
    }
    private fun handleResultFileSave(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id"); if (!Regex("[1-9][0-9]{0,11}").matches(id)) return
        val pending = runCatching {
            require(input.keys().asSequence().toSet() == setOf("type", "id", "screen_token", "save_id", "asset_version", "sha256"))
            require(saveResult == null && saveFile == null)
            val token = input.getString("screen_token"); require(token.isNotBlank() && token.length <= 256 && token.none { it.isISOControl() })
            val saveId = input.getString("save_id"); require(Regex("[a-f0-9-]{36}").matches(saveId))
            val version = input.get("asset_version"); require(version is Int && version > 0)
            val sha = input.getString("sha256"); require(Regex("[a-f0-9]{64}").matches(sha))
            SaveResult(id, pageEpoch, token, JSONObject().put("save_id", saveId).put("asset_version", version).put("sha256", sha).toString().toByteArray(), reply)
        }.getOrNull()
        if (pending == null) { reply.postMessage(JSONObject().put("type", "result_file_save_result").put("id", id).put("ok", false).toString()); return }
        saveResult = pending
        materialExecutor.execute {
            val snapshot = runCatching { parseResultFileSnapshot(resultFileRequest(pending, "snapshot").body) }.getOrNull()
            ui.post {
                if (saveResult !== pending || pageEpoch != pending.epoch || isDestroyed) { snapshot?.bytes?.fill(0); return@post }
                if (snapshot == null) { saveResult = null; resultFileReply(pending, false); return@post }
                pending.snapshot = snapshot
                try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(snapshot.mediaType).putExtra(Intent.EXTRA_TITLE, snapshot.name), REQ_SAVE_RESULT) }
                catch (_: Exception) { saveResult = null; snapshot.bytes.fill(0); resultFileReply(pending, false) }
            }
        }
    }
    private fun finishResultFileSave(resultCode: Int, uri: Uri?) {
        val pending = saveResult ?: return; if (pending.finishing) return; pending.finishing = true
        val snapshot = pending.snapshot ?: return
        if (resultCode != RESULT_OK || uri == null || uri.scheme != "content") { saveResult = null; snapshot.bytes.fill(0); resultFileReply(pending, false, true); return }
        materialExecutor.execute {
            val ok = runCatching {
                resultFileRequest(pending, "check")
                contentResolver.openOutputStream(uri, "wt")?.use { target ->
                    var offset = 0
                    while (offset < snapshot.bytes.size) { check(pageEpoch == pending.epoch && !isDestroyed); val count = minOf(40960, snapshot.bytes.size-offset); target.write(snapshot.bytes, offset, count); offset += count }
                    target.flush()
                } ?: error("destination unavailable")
                resultFileRequest(pending, "check")
            }.isSuccess
            snapshot.bytes.fill(0); ui.post { if (saveResult === pending) saveResult = null }; resultFileReply(pending, ok)
        }
    }

    private fun handleFileSave(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id)) return
        fun rejected() { reply.postMessage(JSONObject().put("type", "file_save_result").put("id", id).put("ok", false).toString()) }
        if (saveFile != null || saveResult != null) { rejected(); return }
        val path = input.optString("path")
        val route = runCatching { workspaceReadRoute(input.optString("workspace"), path) }.getOrNull() ?: run { rejected(); return }
        saveFile = SaveFile(id, route, pageEpoch, reply)
        val name = path.substringAfterLast('/')
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        try {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE, name), REQ_SAVE_FILE)
        } catch (_: Exception) { saveFile = null; rejected() }
    }

    private fun finishFileSave(resultCode: Int, uri: Uri?) {
        val pending = saveFile ?: return
        saveFile = null
        fun respond(ok: Boolean, cancelled: Boolean = false) { runOnUiThread {
            if (pageEpoch == pending.epoch) runCatching { pending.reply.postMessage(JSONObject().put("type", "file_save_result")
                .put("id", pending.id).put("ok", ok).put("cancelled", cancelled).toString()) }
        } }
        if (resultCode != RESULT_OK || uri == null) { respond(false, true); return }
        Thread {
            val ok = runCatching {
                val result = coreUi?.execute(pending.epoch, CoreUiRequest("GET", pending.path)) ?: error("core unavailable")
                check(result.status == 200)
                contentResolver.openOutputStream(uri, "w")?.use { it.write(result.body) } ?: error("destination unavailable")
            }.isSuccess
            respond(ok)
        }.start()
    }

    private fun handleGatewaySetting(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id)) return
        val epoch = pageEpoch
        val paths = Paths(this)
        val result = when (input.optString("operation")) {
            "status" -> JSONObject().put("ok", true)
            "save" -> {
                val rawUrl = input.opt("url") as? String
                val rawSecret = input.opt("secret") as? String
                val url = rawUrl?.trim()
                val secret = rawSecret?.trim()
                val normalized = if (url.isNullOrEmpty()) "" else normalizeGatewayUrl(url)
                val saved = if (url == null || secret == null || secret.length > 1024 || normalized == null) false else runCatching {
                    paths.state.mkdirs()
                    if (normalized.isEmpty()) {
                        if (paths.gateway.exists()) check(paths.gateway.delete())
                        if (paths.gatewayBootstrap.exists()) check(paths.gatewayBootstrap.delete())
                    } else {
                        if (secret.isNotEmpty()) paths.gatewayBootstrap.writeText(secret)
                        else if (paths.gatewayBootstrap.exists()) check(paths.gatewayBootstrap.delete())
                        paths.gateway.writeText(JSONObject().put("url", normalized).toString())
                    }
                    CoreService.start(this, CoreService.ACTION_RESTART)
                    true
                }.getOrDefault(false)
                JSONObject().put("ok", saved)
            }
            else -> return
        }
        val configuredUrl = runCatching { JSONObject(paths.gateway.readText()).optString("url") }.getOrDefault("")
        result.put("type", "gateway_config_result").put("id", id)
            .put("configured", configuredUrl.isNotEmpty()).put("url", configuredUrl)
        if (pageEpoch == epoch) reply.postMessage(result.toString())
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
        if (requestCode in REQ_MATERIAL_FIRST..REQ_MATERIAL_LAST) {
            if (materialPickerPending?.requestCode == requestCode) finishMaterialPicker(resultCode, data)
            return
        }
        if (requestCode == REQ_SAVE_RESULT) { finishResultFileSave(resultCode, data?.data); return }
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
        invalidateMaterials()
        materialBearer = null; materialNativeProof = null
        materialExecutor.shutdownNow()
        ui.removeCallbacksAndMessages(null)
        requests.values.forEach { it.cancel() }
        requests.clear()
        pageEpoch = 0L
        saveResult?.snapshot?.bytes?.fill(0); saveResult = null
        coreUi?.invalidate()
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
        private const val REQ_SAVE_RESULT = 7103
        private const val REQ_CAPTURE = 7104
        private const val REQ_MATERIAL_FIRST = 7200
        private const val REQ_MATERIAL_LAST = 64999
    }
}
