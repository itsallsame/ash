# Contributing

- Issues and pull requests are welcome. Describe the device (model, Android version, ROM) for anything phone-specific, and attach the logs from **诊断 → 分享日志**.
- Before a pull request: `npm test` and, for Android changes, `cd android && ./gradlew assembleDebug`.
- Keep DSH unmodified: Android adaptations go into `packages/android-compat`, the container's DSH patch (`tools/container-sources.mjs`) or DSH's public extension points — never into files under `@deepseek-ai/`.
- The SDK (`packages/sdk`) holds the contracts and is versioned (`packages/sdk/src/versions.ts`): additions are fine, semantic changes bump the version constant.
