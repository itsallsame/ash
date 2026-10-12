// Handing the binder to the app through its provider follows Shizuku (https://github.com/RikkaApps/Shizuku), server/.../
// ShizukuService.java, and scrcpy's ActivityManager/ContentProvider wrappers (https://github.com/Genymobile/scrcpy), both Apache
// License 2.0 (see THIRD_PARTY_NOTICES.md). Changes: one app only, a fixed list of actions, no commands; written for Ash.
package ai.ash.caps.hostshell;

import ai.ash.caps.system.LaunchRoute;

import android.annotation.SuppressLint;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.FileObserver;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.Process;
import android.os.RemoteException;
import android.util.Log;
import android.view.KeyEvent;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * The host shell service: Ash's own code, run as the shell user (uid 2000) by {@code app_process} from Ash's APK. The owner
 * starts it, through wireless debugging, when they pair Ash with the phone (or connect it again after a restart); Ash
 * never turns any of that on itself.
 *
 * <p>It does only what {@link IHostShell} lists — a virtual screen, a key, starting an activity, reading the app in front —
 * and never runs a command it was given. Nothing can find it: it registers nowhere and listens on nothing; it hands its binder
 * to Ash's own provider (which only the shell and the system may call), and refuses every call that is not from Ash's uid.
 *
 * <p>Started as {@code app_process /system/bin --nice-name=ash_hostshell ai.ash.caps.hostshell.Server <package> <uid>}.
 * When Ash is updated it starts the new build of itself and leaves (seen when the APK folder goes away, or at the latest
 * when it is about to hand itself to the new build); when Ash is removed it leaves.
 */
@SuppressLint("PrivateApi,DiscouragedPrivateApi")
public final class Server extends IHostShell.Stub {

    static final String NAME = "ash_hostshell";
    private static final String TAG = "AshHostShell";
    private static final String VSCREEN_MAIN = "ai.ash.caps.vscreen.Main";
    private static final Pattern COMPONENT = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+/[A-Za-z0-9_.$]+");
    private static final Pattern PACKAGE = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+");

    private final String pkg;
    private final int ashUid;
    private final String apk;
    private final long build;
    private final byte[] signer;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** Ash has this service's binder (cleared when Ash's token dies or its uid goes away). */
    private volatile boolean delivered;
    @SuppressWarnings({"FieldCanBeLocal", "unused"}) // FileObserver stops when collected
    private FileObserver apkWatch;

    public static void main(String[] args) {
        Looper.prepareMainLooper();
        try {
            if (args.length != 2) throw new IllegalArgumentException("usage: Server <package> <uid>");
            Server server = new Server(args[0], Integer.parseInt(args[1]));
            server.begin();
        } catch (Throwable t) {
            Log.e(TAG, "cannot start", t);
            System.exit(1);
        }
        Looper.loop();
    }

    private Server(String pkg, int ashUid) throws Exception {
        if (Process.myUid() != Process.SHELL_UID) throw new IllegalStateException("must run as the shell user, not uid " + Process.myUid());
        PackageInfo info = packageInfo(pkg);
        if (info == null) throw new IllegalStateException(pkg + " is not installed");
        if (info.applicationInfo.uid != ashUid) throw new IllegalStateException(pkg + " has uid " + info.applicationInfo.uid + ", not " + ashUid);
        this.pkg = pkg;
        this.ashUid = ashUid;
        this.apk = info.applicationInfo.sourceDir;
        this.build = info.lastUpdateTime;
        this.signer = signer(info);
    }

    private void begin() {
        stopOthers();
        watchApk();
        listenToAsh();
        main.post(this::deliver);
        Log.i(TAG, "started for " + pkg + " (uid " + ashUid + ", apk " + apk + ")");
    }

    // ---- the gate ----

    @Override
    public boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
        if (code >= FIRST_CALL_TRANSACTION && code <= LAST_CALL_TRANSACTION && Binder.getCallingUid() != ashUid) {
            throw new SecurityException("only Ash may use this service");
        }
        return super.onTransact(code, data, reply, flags);
    }

    // ---- the actions ----

    @Override
    public long build() {
        return build;
    }

    @Override
    public IHostProcess openVscreen(IBinder owner) {
        if (owner == null) throw new IllegalArgumentException("owner is required");
        ProcessBuilder pb = new ProcessBuilder("/system/bin/app_process", "/system/bin", "--nice-name=ash_vscreen", VSCREEN_MAIN);
        pb.environment().put("CLASSPATH", apk);
        try {
            return new ServerProcess(pb.start(), owner, ashUid);
        } catch (IOException e) {
            throw new IllegalStateException("cannot start the virtual screen: " + e.getMessage());
        }
    }

    @Override
    public void key(int code, boolean longPress) {
        if (code <= 0 || code > KeyEvent.getMaxKeyCode()) throw new IllegalArgumentException("no such key code: " + code);
        List<String> argv = new ArrayList<>(Arrays.asList("/system/bin/input", "keyevent"));
        if (longPress) argv.add("--longpress");
        argv.add(String.valueOf(code));
        Result r = run(argv, 10_000);
        if (r.code != 0) throw new IllegalStateException("input keyevent failed: " + r.text());
    }

    @Override
    public void start(Intent intent) {
        Result r = run(amStart(intent), 15_000);
        String out = r.text();
        if (r.code != 0 || out.contains("Error:") || out.contains("Exception")) throw new IllegalStateException("am start failed: " + out);
    }

    @Override
    public String frontApp() {
        String front = LaunchRoute.INSTANCE.parseFront(run(Arrays.asList("/system/bin/dumpsys", "activity", "activities"), 6_000).frontLines());
        if (front == null) front = LaunchRoute.INSTANCE.parseFront(run(Arrays.asList("/system/bin/dumpsys", "window"), 6_000).frontLines());
        return front;
    }

    @Override
    public void exit() {
        Log.i(TAG, "asked to stop");
        main.postDelayed(() -> System.exit(0), 100);
    }

    /** `am start` for [intent], as separate arguments (never through a shell). Only the parts an activity start needs. */
    static List<String> amStart(Intent intent) {
        List<String> a = new ArrayList<>(Arrays.asList("/system/bin/am", "start"));
        if (intent.getAction() != null) a.addAll(Arrays.asList("-a", intent.getAction()));
        if (intent.getData() != null) a.addAll(Arrays.asList("-d", intent.getData().toString()));
        if (intent.getType() != null) a.addAll(Arrays.asList("-t", intent.getType()));
        if (intent.getCategories() != null) for (String c : intent.getCategories()) a.addAll(Arrays.asList("-c", c));
        ComponentName component = intent.getComponent();
        if (component != null) {
            String flat = component.flattenToShortString();
            if (!COMPONENT.matcher(component.flattenToString()).matches()) throw new IllegalArgumentException("bad component " + flat);
            a.addAll(Arrays.asList("-n", flat));
        } else if (intent.getPackage() != null) {
            if (!PACKAGE.matcher(intent.getPackage()).matches()) throw new IllegalArgumentException("bad package " + intent.getPackage());
            a.addAll(Arrays.asList("-p", intent.getPackage()));
        }
        Bundle extras = intent.getExtras();
        if (extras != null) {
            for (String k : extras.keySet()) {
                Object v = extras.get(k);
                if (v instanceof String) a.addAll(Arrays.asList("--es", k, (String) v));
                else if (v instanceof Boolean) a.addAll(Arrays.asList("--ez", k, v.toString()));
                else if (v instanceof Integer) a.addAll(Arrays.asList("--ei", k, v.toString()));
            }
        }
        a.addAll(Arrays.asList("-f", String.valueOf(intent.getFlags())));
        return a;
    }

    // ---- handing the binder to Ash ----

    /** Gives Ash this service's binder through Ash's provider; Ash answers with a token of its process, watched for death. */
    private void deliver() {
        if (delivered) return; // a start and Ash's process coming up can both ask at once
        // Ash was updated or removed since this build started (some Android versions remove the old APK folder only later,
        // so its watch may not have fired): follow the APK first.
        PackageInfo now = packageInfo(pkg);
        if (now == null || now.lastUpdateTime != build) { apkChanged(); return; }
        String authority = pkg + ".hostshell";
        IBinder handle = new Binder();
        Object am = null;
        try {
            am = activityManager();
            Object provider = providerExternal(am, authority, ashUid / 100_000, handle);
            if (provider == null) { Log.w(TAG, "Ash's provider is not there"); return; }
            Bundle extras = new Bundle();
            extras.putBinder("binder", this);
            Bundle reply = call(provider, authority, "attach", extras);
            IBinder token = reply == null ? null : reply.getBinder("token");
            if (token == null) { Log.w(TAG, "Ash did not take the service"); return; }
            token.linkToDeath(() -> delivered = false, 0);
            delivered = true;
            Log.i(TAG, "handed to Ash");
        } catch (Throwable t) {
            Log.w(TAG, "cannot hand the service to Ash", t);
        } finally {
            if (am != null) {
                try {
                    am.getClass().getMethod("removeContentProviderExternal", String.class, IBinder.class).invoke(am, authority, handle);
                } catch (Throwable ignored) { }
            }
        }
    }

    /** Ash's process came (back): hand it the binder again. Ash's uid going away clears what it had. */
    private void listenToAsh() {
        try {
            ActivityManager am = (ActivityManager) FakeContext.get().getSystemService(Context.ACTIVITY_SERVICE);
            Class<?> listener = Class.forName("android.app.ActivityManager$OnUidImportanceListener");
            Object proxy = Proxy.newProxyInstance(listener.getClassLoader(), new Class<?>[]{listener}, (self, m, a) -> {
                switch (m.getName()) {
                    case "onUidImportance":
                        if ((int) a[0] == ashUid) onAshImportance((int) a[1]);
                        return null;
                    case "hashCode": return System.identityHashCode(self);
                    case "equals": return self == a[0];
                    case "toString": return "AshHostShellListener";
                    default: return null;
                }
            });
            ActivityManager.class.getMethod("addOnUidImportanceListener", listener, int.class)
                    .invoke(am, proxy, ActivityManager.RunningAppProcessInfo.IMPORTANCE_CACHED);
        } catch (Throwable t) {
            Log.w(TAG, "cannot watch Ash's process; the binder is handed over only at start", t);
        }
    }

    private void onAshImportance(int importance) {
        if (importance >= ActivityManager.RunningAppProcessInfo.IMPORTANCE_GONE) delivered = false;
        else if (!delivered) main.post(this::deliver);
    }

    private static Object activityManager() throws ReflectiveOperationException {
        return ActivityManager.class.getMethod("getService").invoke(null);
    }

    /** IActivityManager.getContentProviderExternal(...).provider (the IContentProvider), as scrcpy and Shizuku do. */
    private static Object providerExternal(Object am, String authority, int userId, IBinder token) throws ReflectiveOperationException {
        Object holder;
        try {
            Method m = am.getClass().getMethod("getContentProviderExternal", String.class, int.class, IBinder.class, String.class);
            holder = m.invoke(am, authority, userId, token, TAG);
        } catch (NoSuchMethodException e) {
            Method m = am.getClass().getMethod("getContentProviderExternal", String.class, int.class, IBinder.class);
            holder = m.invoke(am, authority, userId, token);
        }
        if (holder == null) return null;
        Field f = holder.getClass().getDeclaredField("provider");
        f.setAccessible(true);
        return f.get(holder);
    }

    /** IContentProvider.call, whose arguments changed in Android 10, 11 and 12. */
    private static Bundle call(Object provider, String authority, String method, Bundle extras) throws ReflectiveOperationException {
        Class<?> c = provider.getClass();
        if (Build.VERSION.SDK_INT >= 31) {
            Method m = c.getMethod("call", android.content.AttributionSource.class, String.class, String.class, String.class, Bundle.class);
            return (Bundle) m.invoke(provider, FakeContext.get().getAttributionSource(), authority, method, null, extras);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            Method m = c.getMethod("call", String.class, String.class, String.class, String.class, String.class, Bundle.class);
            return (Bundle) m.invoke(provider, FakeContext.PACKAGE_NAME, null, authority, method, null, extras);
        }
        Method m = c.getMethod("call", String.class, String.class, String.class, String.class, Bundle.class);
        return (Bundle) m.invoke(provider, FakeContext.PACKAGE_NAME, authority, method, null, extras);
    }

    // ---- following Ash's APK ----

    /** The APK's folder goes away on an update and on removal. */
    private void watchApk() {
        File dir = new File(apk).getParentFile();
        if (dir == null) return;
        apkWatch = new FileObserver(dir, FileObserver.DELETE | FileObserver.DELETE_SELF | FileObserver.MOVED_FROM) {
            @Override
            public void onEvent(int event, String path) {
                if ((event & FileObserver.DELETE_SELF) != 0 || "base.apk".equals(path)) {
                    stopWatching();
                    main.postDelayed(Server.this::apkChanged, 2_000);
                }
            }
        };
        apkWatch.startWatching();
    }

    /** Ash was removed: leave. Ash was updated: start the new build (same signer only), then leave. */
    private void apkChanged() {
        PackageInfo info = packageInfo(pkg);
        if (info == null) {
            Log.i(TAG, pkg + " was removed: stopping");
            System.exit(0);
        }
        try {
            if (info.applicationInfo.uid != ashUid || !Arrays.equals(signer(info), signer)) {
                Log.w(TAG, pkg + " changed signer or uid: stopping");
                System.exit(0);
            }
            ProcessBuilder pb = new ProcessBuilder(command(info.applicationInfo.sourceDir, pkg, ashUid));
            pb.environment().put("CLASSPATH", info.applicationInfo.sourceDir);
            pb.redirectInput(new File("/dev/null")).redirectOutput(new File("/dev/null")).redirectError(new File("/dev/null"));
            pb.start();
            Log.i(TAG, pkg + " was updated: started the new build");
        } catch (Throwable t) {
            Log.w(TAG, "cannot start the new build", t);
        }
        System.exit(0);
    }

    /** How the service is started (CLASSPATH set to [apk]); the same line Ash sends through wireless debugging. */
    static List<String> command(String apk, String pkg, int uid) {
        return Arrays.asList("/system/bin/setsid", "/system/bin/app_process", "/system/bin", "--nice-name=" + NAME,
                Server.class.getName(), pkg, String.valueOf(uid));
    }

    /** One service at a time: a new one ends the ones before it (same name, same user). */
    private static void stopOthers() {
        File[] procs = new File("/proc").listFiles((d, n) -> n.matches("\\d+"));
        if (procs == null) return;
        int me = Process.myPid();
        for (File p : procs) {
            int pid = Integer.parseInt(p.getName());
            if (pid == me) continue;
            try {
                byte[] cmd = Files.readAllBytes(new File(p, "cmdline").toPath());
                int end = 0;
                while (end < cmd.length && cmd[end] != 0) end++;
                if (NAME.equals(new String(cmd, 0, end, StandardCharsets.UTF_8))) {
                    Process.killProcess(pid);
                    Log.i(TAG, "stopped the earlier service " + pid);
                }
            } catch (Throwable ignored) { }
        }
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo packageInfo(String pkg) {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        try {
            return FakeContext.get().getPackageManager().getPackageInfo(pkg, flags);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static byte[] signer(PackageInfo info) throws Exception {
        android.content.pm.Signature[] s = Build.VERSION.SDK_INT >= 28 && info.signingInfo != null
                ? info.signingInfo.getApkContentsSigners() : info.signatures;
        if (s == null || s.length == 0) throw new IllegalStateException("no signer");
        return MessageDigest.getInstance("SHA-256").digest(s[0].toByteArray());
    }

    // ---- running the fixed programs ----

    private static final class Result {
        final int code;
        final String out;
        final String err;

        Result(int code, String out, String err) {
            this.code = code;
            this.out = out;
            this.err = err;
        }

        String text() {
            String t = (out + "\n" + err).trim();
            return t.length() > 600 ? t.substring(0, 600) : t;
        }

        /** The lines of a dumpsys that say what is in front (the rest can be long). */
        String frontLines() {
            StringBuilder sb = new StringBuilder();
            for (String line : out.split("\n")) {
                if (line.contains("ResumedActivity") || line.contains("mCurrentFocus") || line.contains("mFocusedApp")) sb.append(line).append('\n');
            }
            return sb.toString();
        }
    }

    /** Runs [argv] (a program and its arguments, no shell), up to [timeoutMs]. */
    private static Result run(List<String> argv, long timeoutMs) {
        try {
            java.lang.Process p = new ProcessBuilder(argv).redirectInput(new File("/dev/null")).start();
            StringBuilder out = new StringBuilder();
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            Thread errPump = drain(p.getErrorStream(), err);
            Thread outPump = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        if (out.length() < 4_000_000) out.append(line).append('\n');
                    }
                } catch (IOException ignored) { }
            });
            outPump.setDaemon(true);
            outPump.start();
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                return new Result(-1, "", "timed out");
            }
            outPump.join(1_000);
            errPump.join(500);
            return new Result(p.exitValue(), out.toString(), err.toString("UTF-8"));
        } catch (Exception e) {
            return new Result(-1, "", String.valueOf(e.getMessage()));
        }
    }

    private static Thread drain(InputStream in, ByteArrayOutputStream to) {
        Thread t = new Thread(() -> {
            byte[] b = new byte[4096];
            try {
                int n;
                while ((n = in.read(b)) >= 0) if (to.size() < 64_000) to.write(b, 0, n);
            } catch (IOException ignored) { }
        });
        t.setDaemon(true);
        t.start();
        return t;
    }
}
