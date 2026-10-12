package ai.ash.caps.hostshell;

import android.os.ParcelFileDescriptor;

// A program the host shell service started for Ash (only ever the virtual-screen program), with its three pipes.
interface IHostProcess {
    ParcelFileDescriptor stdin();
    ParcelFileDescriptor stdout();
    ParcelFileDescriptor stderr();
    boolean alive();
    void destroy();
}
