// The whitelist of phone actions moved from the hand app's hostshell Server (same IHostShell/IHostProcess AIDL, so the
// binder transacts with the hand app unchanged). Adapted from that Server; the virtual-screen program still lives in the
// hand APK (launched here with its apk on the class path). See THIRD_PARTY_NOTICES.md for the pairing/provider origins.
package ai.ash.kernel.host;

import ai.ash.caps.hostshell.IHostProcess;
import ai.ash.caps.hostshell.IHostShell;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;
import android.util.Log;
import android.view.KeyEvent;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * What Ash may do with the kernel's host layer, as the hand app calls it ([IHostShell], pushed to the hand app's door).
 * It is the high-privilege executor the app no longer holds: a short, fixed list — a virtual screen, a key, starting an
 * activity, the app in front — each a fixed program, never a command line. Only the hand app's uid may call it.
 */
final class PhoneActions extends IHostShell.Stub {
    private static final String TAG = "ash.kernel.host";
    private static final String VSCREEN_MAIN = "ai.ash.caps.vscreen.Main";
    private static final Pattern COMPONENT = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+/[A-Za-z0-9_.$]+");
    private static final Pattern PACKAGE = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+");
    private static final Pattern FRONT = Pattern.compile("\\bu\\d+ ([A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+)/");

    private final int handUid;
    private final String handApk;
    private final long handBuild;

    PhoneActions(int handUid, String handApk, long handBuild) {
        this.handUid = handUid;
        this.handApk = handApk;
        this.handBuild = handBuild;
    }

    @Override
    public boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
        if (code >= FIRST_CALL_TRANSACTION && code <= LAST_CALL_TRANSACTION && Binder.getCallingUid() != handUid) {
            throw new SecurityException("only Ash may use the kernel host actions");
        }
        return super.onTransact(code, data, reply, flags);
    }

    @Override
    public long build() {
        return handBuild;
    }

    @Override
    public IHostProcess openVscreen(IBinder owner) {
        if (owner == null) throw new IllegalArgumentException("owner is required");
        ProcessBuilder pb = new ProcessBuilder("/system/bin/app_process", "/system/bin", "--nice-name=ash_vscreen", VSCREEN_MAIN);
        pb.environment().put("CLASSPATH", handApk);
        try {
            return new ServerProcess(pb.start(), owner, handUid);
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
        String front = parseFront(run(Arrays.asList("/system/bin/dumpsys", "activity", "activities"), 6_000));
        if (front == null) front = parseFront(run(Arrays.asList("/system/bin/dumpsys", "window"), 6_000));
        return front;
    }

    @Override
    public void exit() {
        Log.i(TAG, "host actions asked to stop");
        // The shell host process owns these: leaving ends supervision too, so just drop this binder's work.
    }

    private static String parseFront(Result r) {
        for (String line : r.out.split("\n")) {
            if (line.contains("ResumedActivity") || line.contains("mCurrentFocus") || line.contains("mFocusedApp")) {
                java.util.regex.Matcher m = FRONT.matcher(line);
                if (m.find()) return m.group(1);
            }
        }
        return null;
    }

    static List<String> amStart(Intent intent) {
        List<String> a = new ArrayList<>(Arrays.asList("/system/bin/am", "start"));
        if (intent.getAction() != null) a.addAll(Arrays.asList("-a", intent.getAction()));
        if (intent.getData() != null) a.addAll(Arrays.asList("-d", intent.getData().toString()));
        if (intent.getType() != null) a.addAll(Arrays.asList("-t", intent.getType()));
        if (intent.getCategories() != null) for (String c : intent.getCategories()) a.addAll(Arrays.asList("-c", c));
        ComponentName component = intent.getComponent();
        if (component != null) {
            if (!COMPONENT.matcher(component.flattenToString()).matches()) throw new IllegalArgumentException("bad component");
            a.addAll(Arrays.asList("-n", component.flattenToShortString()));
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

    private static final class Result {
        final int code;
        final String out;
        final String err;

        Result(int code, String out, String err) { this.code = code; this.out = out; this.err = err; }

        String text() {
            String t = (out + "\n" + err).trim();
            return t.length() > 600 ? t.substring(0, 600) : t;
        }
    }

    private static Result run(List<String> argv, long timeoutMs) {
        try {
            Process p = new ProcessBuilder(argv).redirectInput(new File("/dev/null")).start();
            StringBuilder out = new StringBuilder();
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            Thread errPump = drain(p.getErrorStream(), err);
            Thread outPump = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) if (out.length() < 4_000_000) out.append(line).append('\n');
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
