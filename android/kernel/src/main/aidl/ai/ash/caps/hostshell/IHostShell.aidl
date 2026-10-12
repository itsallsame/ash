package ai.ash.caps.hostshell;

import ai.ash.caps.hostshell.IHostProcess;
import android.content.Intent;

// The host shell service (Server.java, the phone's debug identity) as Ash sees it. Only these few actions exist: there is
// no way to run an arbitrary command through it. Every call is refused unless it comes from Ash's own uid.
interface IHostShell {
    // When the APK the service runs from was installed (PackageInfo.lastUpdateTime): Ash takes only a service of its own build.
    long build();
    // Starts Ash's virtual-screen program (ai.ash.caps.vscreen.Main) and hands over its pipes; it ends when `owner` dies.
    IHostProcess openVscreen(IBinder owner);
    // `input keyevent [--longpress] <code>`.
    void key(int code, boolean longPress);
    // `am start` with the intent's action, data, type, categories, component or package, flags and simple extras.
    void start(in Intent intent);
    // The package of the app in front, or null when the system does not say.
    String frontApp();
    // Stops the service (Ash's 「撤销」).
    void exit();
}
