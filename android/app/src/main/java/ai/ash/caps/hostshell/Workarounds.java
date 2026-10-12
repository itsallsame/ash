// Adapted from scrcpy (https://github.com/Genymobile/scrcpy), server/.../Workarounds.java, Apache License 2.0
// (see THIRD_PARTY_NOTICES.md). Changes: only the ActivityThread set-up and the system context are kept.
package ai.ash.caps.hostshell;

import android.annotation.SuppressLint;
import android.content.Context;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** A process started by {@code app_process} has no ActivityThread: make one, so that the system context can be had. */
@SuppressLint("PrivateApi,DiscouragedPrivateApi")
final class Workarounds {

    private static final Class<?> ACTIVITY_THREAD_CLASS;
    private static final Object ACTIVITY_THREAD;

    static {
        try {
            // ActivityThread activityThread = new ActivityThread();
            ACTIVITY_THREAD_CLASS = Class.forName("android.app.ActivityThread");
            Constructor<?> constructor = ACTIVITY_THREAD_CLASS.getDeclaredConstructor();
            constructor.setAccessible(true);
            ACTIVITY_THREAD = constructor.newInstance();

            // ActivityThread.sCurrentActivityThread = activityThread;
            Field current = ACTIVITY_THREAD_CLASS.getDeclaredField("sCurrentActivityThread");
            current.setAccessible(true);
            current.set(null, ACTIVITY_THREAD);

            // activityThread.mSystemThread = true;
            Field systemThread = ACTIVITY_THREAD_CLASS.getDeclaredField("mSystemThread");
            systemThread.setAccessible(true);
            systemThread.setBoolean(ACTIVITY_THREAD, true);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private Workarounds() {
    }

    static Context getSystemContext() {
        try {
            Method method = ACTIVITY_THREAD_CLASS.getDeclaredMethod("getSystemContext");
            return (Context) method.invoke(ACTIVITY_THREAD);
        } catch (Throwable throwable) {
            return null;
        }
    }
}
