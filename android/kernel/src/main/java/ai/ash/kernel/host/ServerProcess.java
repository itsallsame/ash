// The pipe hand-over follows RemoteProcessHolder of Shizuku-API (https://github.com/RikkaApps/Shizuku-API), MIT License,
// Copyright (c) 2021 RikkaW (see THIRD_PARTY_NOTICES.md). Changes: pipes made up front, owner-only calls, no waitFor.
package ai.ash.kernel.host;

import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.ParcelFileDescriptor;
import android.os.RemoteException;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * A program the service started for Ash, inside the service: its three streams are copied to pipes whose other ends Ash
 * holds, and the program is ended when Ash's [owner] binder dies (Ash's process went away).
 */
final class ServerProcess extends ai.ash.caps.hostshell.IHostProcess.Stub {

    private final Process process;
    private final int callerUid;
    private final ParcelFileDescriptor stdin;
    private final ParcelFileDescriptor stdout;
    private final ParcelFileDescriptor stderr;

    ServerProcess(Process process, IBinder owner, int callerUid) throws IOException {
        this.process = process;
        this.callerUid = callerUid;
        ParcelFileDescriptor[] in = ParcelFileDescriptor.createPipe();
        ParcelFileDescriptor[] out = ParcelFileDescriptor.createPipe();
        ParcelFileDescriptor[] err = ParcelFileDescriptor.createPipe();
        stdin = in[1];
        stdout = out[0];
        stderr = err[0];
        pump(new ParcelFileDescriptor.AutoCloseInputStream(in[0]), process.getOutputStream(), "host-in");
        pump(process.getInputStream(), new ParcelFileDescriptor.AutoCloseOutputStream(out[1]), "host-out");
        pump(process.getErrorStream(), new ParcelFileDescriptor.AutoCloseOutputStream(err[1]), "host-err");
        try {
            owner.linkToDeath(this::destroy, 0);
        } catch (RemoteException e) {
            destroy();
        }
    }

    @Override
    public boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
        if (code >= FIRST_CALL_TRANSACTION && code <= LAST_CALL_TRANSACTION && Binder.getCallingUid() != callerUid) {
            throw new SecurityException("only Ash may use this");
        }
        return super.onTransact(code, data, reply, flags);
    }

    @Override
    public ParcelFileDescriptor stdin() {
        return stdin;
    }

    @Override
    public ParcelFileDescriptor stdout() {
        return stdout;
    }

    @Override
    public ParcelFileDescriptor stderr() {
        return stderr;
    }

    @Override
    public boolean alive() {
        try {
            process.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }

    @Override
    public void destroy() {
        process.destroy();
    }

    private static void pump(InputStream from, OutputStream to, String name) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[8192];
            try {
                int n;
                while ((n = from.read(buf)) >= 0) {
                    to.write(buf, 0, n);
                    to.flush();
                }
            } catch (IOException ignored) {
                // either side closed
            } finally {
                try { from.close(); } catch (IOException ignored) { }
                try { to.close(); } catch (IOException ignored) { }
            }
        }, name);
        t.setDaemon(true);
        t.start();
    }
}
