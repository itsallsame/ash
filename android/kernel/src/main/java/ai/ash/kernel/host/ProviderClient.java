// The provider-access reflection follows scrcpy (ActivityManager/ContentProvider wrappers,
// https://github.com/Genymobile/scrcpy) and Shizuku (https://github.com/RikkaApps/Shizuku), both Apache-2.0
// (see THIRD_PARTY_NOTICES.md). Changes: one call, written for Ash's kernel host.
package ai.ash.kernel.host;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Calls a content provider in another package, as the shell user (the shell host reaching the kernel package's door). */
@SuppressLint("PrivateApi,DiscouragedPrivateApi")
final class ProviderClient {
    private ProviderClient() {
    }

    /** `provider.call(method, extras)` on the provider of [authority] in [userId]; null when the provider is not there. */
    static Bundle call(String authority, int userId, String method, Bundle extras) {
        IBinder token = new Binder();
        Object am = null;
        try {
            am = activityManager();
            Object provider = providerExternal(am, authority, userId, token);
            if (provider == null) return null;
            return providerCall(provider, authority, method, extras);
        } catch (Throwable t) {
            return null;
        } finally {
            if (am != null) {
                try {
                    am.getClass().getMethod("removeContentProviderExternal", String.class, IBinder.class).invoke(am, authority, token);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static Object activityManager() throws ReflectiveOperationException {
        return Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
    }

    private static Object providerExternal(Object am, String authority, int userId, IBinder token) throws ReflectiveOperationException {
        Object holder;
        try {
            Method m = am.getClass().getMethod("getContentProviderExternal", String.class, int.class, IBinder.class, String.class);
            holder = m.invoke(am, authority, userId, token, "ash_kernel_host");
        } catch (NoSuchMethodException e) {
            Method m = am.getClass().getMethod("getContentProviderExternal", String.class, int.class, IBinder.class);
            holder = m.invoke(am, authority, userId, token);
        }
        if (holder == null) return null;
        Field f = holder.getClass().getDeclaredField("provider");
        f.setAccessible(true);
        return f.get(holder);
    }

    private static Bundle providerCall(Object provider, String authority, String method, Bundle extras) throws ReflectiveOperationException {
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
}
