package ai.ash.kernel.host

import ai.ash.kernel.PhoneBadRequest
import ai.ash.kernel.PhonePort
import ai.ash.kernel.PhoneUnavailable
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import android.view.KeyEvent
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * The phone actions the shell host can do with the phone's debug identity (capability vscreen / input / apps). It is the
 * high-privilege executor the hand app no longer holds: a short, fixed set — a virtual screen, a key, launching an app —
 * each a fixed program (`app_process`, `input`, `am`, `dumpsys`), never a command line. The virtual screen is this
 * process's own child (the kernel APK's [ai.ash.kernel.host.vscreen.Main] on the class path), driven over a pipe.
 */
class ShellPhone(private val ctx: Context, private val kernelApk: String, private val log: (String) -> Unit = {}) : PhonePort {
    private val vscreen = Vscreen(kernelApk, log)

    override fun call(method: String, a: JSONObject): JSONObject = when (method) {
        "vscreen.create" -> vscreen.create(a)
        "vscreen.status" -> vscreen.status()
        "vscreen.launch" -> vscreen.launch(resolveApp(a.str("app")))
        "vscreen.see" -> vscreen.see()
        "vscreen.tap" -> vscreen.tap(a.dbl("x"), a.dbl("y"))
        "vscreen.swipe" -> vscreen.swipe(a)
        "vscreen.key" -> vscreen.key(vscreenKeycode(a.str("key")), a.optBoolean("long_press"))
        "vscreen.type" -> vscreen.type(a.str("text"))
        "vscreen.close" -> vscreen.close()
        "input.key" -> inputKey(a.str("key"), a.optBoolean("long_press"))
        "apps.open" -> appsOpen(resolveApp(a.str("app")))
        else -> throw PhoneBadRequest("unknown phone action $method")
    }

    override fun close() = vscreen.close().let { }

    // ---- input.key: inject a key on the real screen (media, volume and other keys all go through `input keyevent`) ----

    private fun inputKey(key: String, longPress: Boolean): JSONObject {
        val code = KEY_NAMES[key.trim().lowercase(Locale.ROOT)] ?: key.trim().toIntOrNull()
            ?: throw PhoneBadRequest("unknown key \"$key\"")
        if (code <= 0 || code > KeyEvent.getMaxKeyCode()) throw PhoneBadRequest("no such key code: $code")
        val argv = ArrayList(listOf("/system/bin/input", "keyevent"))
        if (longPress) argv.add("--longpress")
        argv.add(code.toString())
        val r = run(argv, 10_000)
        if (r.code != 0) throw IllegalStateException("input keyevent failed: ${r.text()}")
        return msg("Key $key sent.")
    }

    // ---- apps.open: launch on the real screen through `am start` (always allowed for the shell user) ----

    private fun appsOpen(app: Resolved): JSONObject {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setComponent(app.component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        start(intent)
        val front = frontApp()
        val opened = front == null || front == app.pkg
        val where = if (front == null) "" else if (opened) " (in front)" else " (but $front is in front, not ${app.pkg})"
        return JSONObject().put("package", app.pkg).put("opened", opened)
            .put("message", "Opened ${app.label} (${app.pkg})$where.")
    }


    // ---- apps resolution (a package name or a launcher label) -------------------------------------------------------

    class Resolved(val label: String, val pkg: String, val component: ComponentName)

    private fun resolveApp(query: String): Resolved {
        val q = query.trim()
        if (q.isEmpty()) throw PhoneBadRequest("app is required (a package name or an app label)")
        val pm = ctx.packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val all = ArrayList<Resolved>()
        val seen = HashSet<String>()
        for (ri in pm.queryIntentActivities(main, 0)) {
            val ai = ri.activityInfo ?: continue
            if (!seen.add(ai.packageName)) continue
            val label = try { ri.loadLabel(pm).toString().trim() } catch (e: Throwable) { ai.packageName }
            all.add(Resolved(label, ai.packageName, ComponentName(ai.packageName, ai.name)))
        }
        all.firstOrNull { it.pkg == q }?.let { return it }
        if (isInstalled(q)) throw PhoneBadRequest("$q is installed but has no launcher activity")
        val nq = norm(q)
        val tiers = listOf<(Resolved) -> Boolean>(
            { norm(it.label) == nq }, { norm(it.label).startsWith(nq) }, { norm(it.label).contains(nq) },
            { it.pkg.lowercase(Locale.ROOT).contains(nq) },
        )
        for ((i, t) in tiers.withIndex()) {
            val hits = all.filter(t)
            if (hits.size == 1 || (hits.size > 1 && i == 0)) return hits.first()
            if (hits.size > 1) {
                val list = hits.take(10).joinToString("; ") { "${it.label} (${it.pkg})" }
                throw PhoneBadRequest("\"$q\" matches several apps: $list${if (hits.size > 10) "; …" else ""}. Use the package name.")
            }
        }
        throw PhoneBadRequest("no launchable app matches \"$q\" (apps.list shows what is installed)")
    }

    private fun isInstalled(pkg: String): Boolean =
        try { ctx.packageManager.getApplicationInfo(pkg, 0); true } catch (e: Throwable) { false }

    private fun norm(s: String) = s.lowercase(Locale.ROOT).replace(Regex("\\s+"), "")

    // ---- running a fixed program ------------------------------------------------------------------------------------

    private fun start(intent: Intent) {
        val r = run(amStart(intent), 15_000)
        val out = r.text()
        if (r.code != 0 || out.contains("Error:") || out.contains("Exception")) throw IllegalStateException("am start failed: $out")
    }

    private fun frontApp(): String? =
        frontOf(run(listOf("/system/bin/dumpsys", "activity", "activities"), 6_000).out)
            ?: frontOf(run(listOf("/system/bin/dumpsys", "window"), 6_000).out)

    private fun amStart(intent: Intent): List<String> {
        val a = ArrayList(listOf("/system/bin/am", "start"))
        intent.action?.let { a.addAll(listOf("-a", it)) }
        intent.data?.let { a.addAll(listOf("-d", it.toString())) }
        intent.type?.let { a.addAll(listOf("-t", it)) }
        intent.categories?.forEach { a.addAll(listOf("-c", it)) }
        val component = intent.component
        if (component != null) {
            if (!COMPONENT.matches(component.flattenToString())) throw PhoneBadRequest("bad component")
            a.addAll(listOf("-n", component.flattenToShortString()))
        } else intent.`package`?.let { a.addAll(listOf("-p", it)) }
        a.addAll(listOf("-f", intent.flags.toString()))
        return a
    }

    private class Result(val code: Int, val out: String, val err: String) {
        fun text(): String = (out + "\n" + err).trim().let { if (it.length > 600) it.substring(0, 600) else it }
    }

    private fun run(argv: List<String>, timeoutMs: Long): Result {
        return try {
            val p = ProcessBuilder(argv).redirectInput(File("/dev/null")).start()
            val out = StringBuilder()
            val err = ByteArrayOutputStream()
            val errPump = drain(p.errorStream, err)
            val outPump = Thread {
                try {
                    BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8)).use { r ->
                        var line = r.readLine()
                        while (line != null) { if (out.length < 4_000_000) out.append(line).append('\n'); line = r.readLine() }
                    }
                } catch (e: Throwable) {}
            }.apply { isDaemon = true; start() }
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) { p.destroyForcibly(); return Result(-1, "", "timed out") }
            outPump.join(1_000); errPump.join(500)
            Result(p.exitValue(), out.toString(), err.toString("UTF-8"))
        } catch (e: Exception) {
            Result(-1, "", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun drain(input: InputStream, to: ByteArrayOutputStream): Thread = Thread {
        val b = ByteArray(4096)
        try { var n = input.read(b); while (n >= 0) { if (to.size() < 64_000) to.write(b, 0, n); n = input.read(b) } } catch (e: Throwable) {}
    }.apply { isDaemon = true; start() }

    // ---- the virtual screen: a child app_process (the kernel APK's Main), driven by JSON lines over its pipe ---------

    private inner class Vscreen(private val apk: String, private val log: (String) -> Unit) {
        private val lock = Any()
        @Volatile private var proc: Process? = null
        @Volatile private var out: java.io.OutputStream? = null
        @Volatile private var dead = true
        private val pending = java.util.concurrent.ConcurrentHashMap<Int, java.util.concurrent.LinkedBlockingQueue<JSONObject>>()
        private val seq = java.util.concurrent.atomic.AtomicInteger()
        private val errTail = StringBuilder()

        fun running(): Boolean = !dead && proc != null

        fun create(a: JSONObject): JSONObject {
            val short = a.optInt("short_edge", 720).coerceIn(288, 1440)
            val long = short * 16 / 9
            val land = a.optString("orientation").lowercase(Locale.ROOT) == "landscape"
            val req = JSONObject().put("width", if (land) long else short).put("height", if (land) short else long)
            val dpi = a.optInt("dpi", 0)
            if (dpi > 0) req.put("dpi", dpi.coerceIn(120, 640))
            val r = send("create", req, 20_000)
            val reused = r.optBoolean("reused")
            return JSONObject().put("displayId", r.optInt("displayId")).put("width", r.optInt("width"))
                .put("height", r.optInt("height")).put("dpi", r.optInt("dpi")).put("reused", reused)
                .put("message", "Virtual screen ${if (reused) "already exists" else "created"}: display ${r.optInt("displayId")}, " +
                    "${r.optInt("width")}x${r.optInt("height")} px, ${r.optInt("dpi")} dpi. Next: vscreen.launch an app, then vscreen.see.")
        }

        fun status(): JSONObject {
            if (!running()) return JSONObject().put("running", false).put("displayId", -1)
            val r = send("status", JSONObject(), 5_000, start = false)
            r.remove("ok"); r.remove("id"); r.remove("build")
            if (!r.has("running")) r.put("running", true)
            return r
        }

        fun launch(app: Resolved): JSONObject {
            needScreen()
            val r = send("launch", JSONObject().put("component", app.component.flattenToShortString()).put("pkg", app.pkg), 20_000)
            val warn = r.optString("warning").let { if (it.isEmpty()) "" else " ($it)" }
            return JSONObject().put("package", app.pkg).put("component", r.optString("component"))
                .put("message", "Launched ${app.label} (${app.pkg}) on the virtual screen$warn.")
        }

        fun see(): JSONObject {
            needScreen()
            val r = send("see", JSONObject().put("maxSide", 1280).put("quality", 80), 15_000)
            return JSONObject().put("jpeg", r.optString("jpeg")).put("displayId", r.optInt("displayId"))
                .put("screenW", r.optInt("screenW")).put("screenH", r.optInt("screenH"))
                .put("imageW", r.optInt("imageW")).put("imageH", r.optInt("imageH"))
        }

        fun tap(x: Double, y: Double): JSONObject {
            needScreen(); send("tap", JSONObject().put("x", x).put("y", y), 10_000); return msg("Tapped.")
        }

        fun swipe(a: JSONObject): JSONObject {
            needScreen()
            val dur = a.optInt("duration_ms", 300).coerceIn(10, 10_000)
            val req = JSONObject().put("x1", a.dbl("x1")).put("y1", a.dbl("y1")).put("x2", a.dbl("x2")).put("y2", a.dbl("y2")).put("durationMs", dur)
            send("swipe", req, dur + 10_000L); return msg("Swiped.")
        }

        fun key(code: Int, longPress: Boolean): JSONObject {
            needScreen(); send("key", JSONObject().put("keycode", code).put("longPress", longPress), 10_000); return msg("Key sent.")
        }

        fun type(text: String): JSONObject {
            if (text.isEmpty()) throw PhoneBadRequest("text is required")
            needScreen()
            if (text.all { it in ' '..'~' }) { send("text", JSONObject().put("text", text), 20_000); return msg("Typed ${text.length} characters.") }
            try {
                val cb = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cb.setPrimaryClip(ClipData.newPlainText("ash", text))
            } catch (e: Throwable) { throw IllegalStateException("could not put the text on the clipboard: ${e.message}") }
            send("key", JSONObject().put("keycode", 279), 10_000)
            return msg("Pasted ${text.length} characters (through the clipboard).")
        }

        fun close(): JSONObject {
            if (!running()) return msg("No virtual screen was open.")
            val r = runCatching { send("close", JSONObject(), 8_000, start = false) }.getOrNull()
            stop()
            return msg(if (r?.optBoolean("ok") == true) "Virtual screen closed." else "Virtual screen closed.")
        }

        private fun needScreen() {
            if (!running()) throw PhoneBadRequest("no virtual screen: call vscreen.create first")
            val st = send("status", JSONObject(), 5_000, start = false)
            if (st.optInt("displayId", -1) < 0) throw PhoneBadRequest("no virtual screen: call vscreen.create first")
        }

        private fun send(op: String, args: JSONObject, timeoutMs: Long, start: Boolean = true): JSONObject {
            if (dead) { if (!start) throw IllegalStateException("virtual screen server not running"); ensureStarted() }
            val id = seq.incrementAndGet()
            val q = java.util.concurrent.LinkedBlockingQueue<JSONObject>(1)
            pending[id] = q
            try {
                val line = JSONObject(args.toString()).put("id", id).put("op", op).toString() + "\n"
                synchronized(lock) { (out ?: throw IllegalStateException("virtual screen server not running")).apply { write(line.toByteArray(StandardCharsets.UTF_8)); flush() } }
                val reply = q.poll(timeoutMs, TimeUnit.MILLISECONDS)
                    ?: throw IllegalStateException("the virtual screen server did not answer $op within ${timeoutMs}ms")
                if (!reply.optBoolean("ok")) throw IllegalStateException(reply.optString("error", "virtual screen error") + tail())
                return reply
            } catch (e: IllegalStateException) {
                throw e
            } catch (e: Throwable) {
                markDead("write failed: ${e.message}")
                throw IllegalStateException("virtual screen server connection lost: ${e.message}${tail()}")
            } finally {
                pending.remove(id)
            }
        }

        private fun ensureStarted() {
            synchronized(lock) {
                if (!dead && proc != null) return
                proc?.destroy()
                synchronized(errTail) { errTail.setLength(0) }
                val pb = ProcessBuilder("/system/bin/app_process", "/system/bin", "--nice-name=ash_vscreen", VSCREEN_MAIN)
                pb.environment()["CLASSPATH"] = apk
                val p = pb.start()
                val ready = java.util.concurrent.CountDownLatch(1)
                proc = p; out = p.outputStream; dead = false
                Thread({ readReplies(p, ready) }, "vscreen-out").apply { isDaemon = true; start() }
                Thread({ drainVscreenErr(p) }, "vscreen-err").apply { isDaemon = true; start() }
                if (!ready.await(12_000, TimeUnit.MILLISECONDS) || dead) {
                    val why = tail(); markDead("start timeout"); p.destroy()
                    throw IllegalStateException("the virtual screen server did not start$why")
                }
                log("vscreen server started")
            }
        }

        private fun readReplies(p: Process, ready: java.util.concurrent.CountDownLatch) {
            try {
                val r = p.inputStream.bufferedReader(StandardCharsets.UTF_8)
                while (true) {
                    val line = r.readLine() ?: break
                    if (!line.startsWith(PREFIX)) { appendErr(line); continue }
                    val o = try { JSONObject(line.substring(PREFIX.length)) } catch (e: Throwable) { continue }
                    if (o.optString("event") == "ready") { ready.countDown(); continue }
                    pending[o.optInt("id", -1)]?.offer(o)
                }
            } catch (e: Throwable) { log("vscreen reply reader: ${e.message}") }
            if (proc === p) markDead("server exited")
            ready.countDown()
        }

        private fun drainVscreenErr(p: Process) {
            try { val r = p.errorStream.bufferedReader(StandardCharsets.UTF_8); while (true) appendErr(r.readLine() ?: break) } catch (e: Throwable) {}
        }

        private fun appendErr(line: String) = synchronized(errTail) {
            errTail.append(line).append('\n'); if (errTail.length > 3000) errTail.delete(0, errTail.length - 2000)
        }

        private fun tail(): String = synchronized(errTail) {
            val t = errTail.toString().trim(); if (t.isEmpty()) "" else " (server log: ${t.takeLast(600).replace('\n', ' ')})"
        }

        private fun stop() {
            synchronized(lock) {
                val p = proc; proc = null
                try { out?.close() } catch (e: Throwable) {}
                out = null; dead = true
                if (p != null) Thread({ try { Thread.sleep(1500) } catch (e: Throwable) {}; if (p.isAlive) p.destroy() }, "vscreen-reap").apply { isDaemon = true; start() }
            }
        }

        private fun markDead(why: String) {
            if (dead) return
            dead = true
            log("vscreen server gone: $why")
            val err = JSONObject().put("ok", false).put("error", "virtual screen server: $why${tail()}")
            for (q in pending.values) q.offer(err)
        }
    }

    private fun msg(text: String) = JSONObject().put("message", text)

    private fun JSONObject.str(key: String): String {
        val v = opt(key)
        if (v !is String || v.isEmpty()) throw PhoneBadRequest("$key must be a non-empty string")
        return v
    }

    private fun JSONObject.dbl(key: String): Double {
        val v = opt(key)
        if (v !is Number) throw PhoneBadRequest("$key must be a number")
        return v.toDouble()
    }

    private fun vscreenKeycode(key: String): Int =
        VSCREEN_KEYS[key.trim().lowercase(Locale.ROOT)] ?: key.trim().toIntOrNull()
            ?: throw PhoneBadRequest("unknown key \"$key\"; use a name or a keycode number")

    companion object {
        private const val TAG = "ash.kernel.host"
        private const val VSCREEN_MAIN = "ai.ash.kernel.host.vscreen.Main"
        private const val PREFIX = "@@ash-vscreen "
        private val COMPONENT = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+/[A-Za-z0-9_.\$]+")

        /** Key names for `input.key` on the real screen (the same names the word has always taken), plus any keycode number. */
        private val KEY_NAMES: Map<String, Int> = mapOf(
            "play_pause" to KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, "play" to KeyEvent.KEYCODE_MEDIA_PLAY, "pause" to KeyEvent.KEYCODE_MEDIA_PAUSE,
            "next" to KeyEvent.KEYCODE_MEDIA_NEXT, "previous" to KeyEvent.KEYCODE_MEDIA_PREVIOUS, "stop" to KeyEvent.KEYCODE_MEDIA_STOP,
            "rewind" to KeyEvent.KEYCODE_MEDIA_REWIND, "fast_forward" to KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
            "volume_up" to KeyEvent.KEYCODE_VOLUME_UP, "volume_down" to KeyEvent.KEYCODE_VOLUME_DOWN, "volume_mute" to KeyEvent.KEYCODE_VOLUME_MUTE,
            "back" to 4, "home" to 3, "recents" to 187, "menu" to 82, "enter" to 66, "power" to 26, "wakeup" to 224, "sleep" to 223,
            "notifications" to 83, "search" to 84, "camera" to 27, "brightness_up" to 221, "brightness_down" to 220,
            "screenshot" to 120, "assist" to 219, "tab" to 61, "escape" to 111, "delete" to 67,
            "dpad_up" to 19, "dpad_down" to 20, "dpad_left" to 21, "dpad_right" to 22, "dpad_center" to 23,
        )

        /** Key names for `vscreen.key` (sent into the virtual display), plus any keycode number. */
        private val VSCREEN_KEYS: Map<String, Int> = mapOf(
            "back" to 4, "home" to 3, "enter" to 66, "menu" to 82, "app_switch" to 187, "tab" to 61, "escape" to 111,
            "delete" to 67, "forward_delete" to 112, "search" to 84, "space" to 62,
            "dpad_up" to 19, "dpad_down" to 20, "dpad_left" to 21, "dpad_right" to 22, "dpad_center" to 23,
            "page_up" to 92, "page_down" to 93, "move_home" to 122, "move_end" to 123, "paste" to 279,
        )

        /**
         * The package in front, from `dumpsys activity` / `dumpsys window` text: the resumed activity first, the focused
         * window or app after it. Lines look like `topResumedActivity=ActivityRecord{1a2 u0 com.x.y/.Main t5}` and
         * `mCurrentFocus=Window{3b4 u0 com.x.y/com.x.y.Main}`.
         */
        fun frontOf(dump: String): String? {
            val component = Regex("""\bu\d+ ([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/""")
            val lines = dump.lineSequence().toList()
            for (key in listOf("topResumedActivity", "mResumedActivity", "ResumedActivity", "mCurrentFocus", "mFocusedApp")) {
                for (line in lines) {
                    if (!line.contains(key)) continue
                    component.find(line)?.let { return it.groupValues[1] }
                }
            }
            return null
        }

        /** The kernel APK's own path (for the virtual-screen Main's class path): the shell host runs from it. */
        fun kernelApk(ctx: Context, pkg: String): String = ctx.packageManager.getApplicationInfo(pkg, 0).sourceDir
    }
}
