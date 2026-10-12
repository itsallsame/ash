# The SPAKE2 step of wireless-debugging pairing (adb_pairing.c), on BoringSSL's own implementation: the one adbd uses.
LOCAL_PATH := $(call my-dir)
include $(CLEAR_VARS)
LOCAL_MODULE := ashadb
LOCAL_SRC_FILES := adb_pairing.c
LOCAL_STATIC_LIBRARIES := crypto_static
LOCAL_CFLAGS := -Os -ffunction-sections -fdata-sections -fvisibility=hidden -Werror=format
LOCAL_LDFLAGS := -Wl,-z,max-page-size=16384 -Wl,--gc-sections -Wl,--exclude-libs,ALL
include $(BUILD_SHARED_LIBRARY)

$(call import-module,prefab/boringssl)
