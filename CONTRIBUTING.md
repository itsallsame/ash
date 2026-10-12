# Contributing

- Issues and pull requests are welcome. Describe the device (model, Android version, ROM) for anything phone-specific, and attach the logs from **诊断 → 分享日志**.
- Before a pull request: `npm test` and, for Android changes, `cd android && ./gradlew assembleDebug`.
- Keep DSH unmodified: Android adaptations go into `packages/android-compat`, the container's DSH patch (`tools/container-sources.mjs`) or DSH's public extension points — never into files under `@deepseek-ai/`.
- The SDK (`packages/sdk`) holds the contracts and is versioned (`packages/sdk/src/versions.ts`): additions are fine, semantic changes bump the version constant.
- **Every build that is handed to anyone (a release, a test build for another phone) raises `versionCode` in both `android/app/build.gradle.kts` and `android/kernel/build.gradle.kts` by at least one and keeps their `versionName` the same.** Android refuses to install an update with a lower or equal `versionCode`, and the app and the kernel package are shipped as a pair. Raise the floors in `android/app/src/test/java/ai/ash/VersionsTest.kt` in the same commit.
- Remote debugging of the pages (`chrome://inspect`) is on in debug builds only (`ai.ash.WebDebugging`); a release build never turns it on.
- **Before a build goes to anyone, run `node tools/release-gate.mjs` on the test phone and keep its budgets** (`tools/release-budgets.json`: CPU of the app, the web view and the kernel at rest, in the background and with the screen off; frames; no breach written by `service:health`). Passing tests is not enough: what the build does when nobody is using it is the point. The hub keeps the same numbers for anyone to read: `service:health` `status` and `recent`.
