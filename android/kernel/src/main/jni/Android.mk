# The app process marks itself non-dumpable (see packages/core/native/nodump.c): the agent container runs as the same
# Linux user and must not read this process's memory, which holds the owner's and the phone's tokens.
LOCAL_PATH := $(call my-dir)
include $(CLEAR_VARS)
LOCAL_MODULE := ashnodump
LOCAL_SRC_FILES := ../../../../../packages/core/native/nodump.c
LOCAL_LDFLAGS := -Wl,-z,max-page-size=16384
include $(BUILD_SHARED_LIBRARY)

# The SPAKE2 step of wireless-debugging pairing (adb_pairing.c), on BoringSSL: the one adbd uses. See app's copy and THIRD_PARTY_NOTICES.md.
include $(CLEAR_VARS)
LOCAL_MODULE := ashadb
LOCAL_SRC_FILES := adb_pairing.c
LOCAL_STATIC_LIBRARIES := crypto_static
LOCAL_CFLAGS := -Os -ffunction-sections -fdata-sections -fvisibility=hidden -Werror=format
LOCAL_LDFLAGS := -Wl,-z,max-page-size=16384 -Wl,--gc-sections -Wl,--exclude-libs,ALL
LOCAL_LDLIBS := -llog
include $(BUILD_SHARED_LIBRARY)

$(call import-module,prefab/boringssl)
