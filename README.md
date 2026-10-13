# ash

ash 是运行在 Android 手机上的常驻个人 Agent。ash core 管理消息、设备、权限、定时和界面；[DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 运行 Agent。当前生产入口使用 `ash-api/2`，两者在同一 Core 进程中通过公开扩展点连接，DSH 发布包不作修改。

当前代码包含：

- 单一 `agent:main` 的对话、状态、后台流程、记忆文件与活动记录；
- 手机感官、通知、审批、定时唤醒与本地暂停；
- 浏览器界面、网关配对与笔记本设备能力；
- DSH 的五个 ash 工具（`ash_describe`、`ash_send`、`ash_say`、`ash_react`、`ash_show`）及受控的原生读写/搜索工具。

这些是代码能力清单，不代表真机回归和最终体验验收已经完成。进度以项目验收记录为准。

## 运行结构

```text
Android App（Kotlin）
  ├─ 前台服务、系统感官、通知、闹钟、Keystore、设备能力
  ├─ APK 静态资源中的 WebView 界面 ── 本机原生桥 ──┐
  └─ 宿主 HTTP 桥 127.0.0.1:4710 ────────────────┤
                                                   ▼
ash core（Node，单进程）
  ├─ ash-api/2：账本、成员、消息路由、关口、时钟、投递、后台流程
  ├─ 本机边缘 API 127.0.0.1:4700
  ├─ DSH 绑定 ── 原样的 DSH core
  └─ 网关出站连接 ── 配对浏览器 / 笔记本设备
```

Android WebView 从 APK 加载静态界面，通过原生桥访问 Core；远程浏览器通过网关使用同一界面。设备能力经过成员与审批链路，不直接展开成一批 Agent 工具。详细结构见 [架构说明](docs/ARCHITECTURE.md)。

| 目录 | 内容 |
|---|---|
| `packages/sdk` | `ash-api/2` 类型、word 目录与客户端 |
| `packages/core` | 世界层、成员、后台流程、边缘 API 和界面 |
| `packages/dsh-binding` | DSH 会话、工具、上下文与审批绑定 |
| `packages/ash-skills` | 人格模板、首次见面与其他技能 |
| `packages/android-compat` | Android 上运行原样 DSH 的适配 |
| `payload/` | DSH、运行时和 Core 的锁定输入与组装 |
| `android/` | Android 宿主（Gradle/Kotlin） |
| `tools/` | 构建、验证和回归脚本 |

无障碍读屏、操作与灵动岛编译在主 APK 内，安装 Ash 后直接在系统无障碍设置开启「Ash」，无需安装屏幕助手。屏幕模块在同一应用的独立进程运行，后台权限与主应用统一设置。更新主应用后，如系统关闭无障碍，需要重新开启。位置/健康感知与应用展示仍是可选组件。

## 已安装电脑连接器：连接当前项目

在需要连接的项目目录打开终端：

```sh
ash-device connect codex
```

按提示确认后，手机「电脑」里可以读取该项目的已保存会话。需要单个会话发送时，在同一目录运行 `ash-device connect codex --control`，选择会话并确认。

需要整个项目协作时，运行 `"$HOME/.ash-device/current/bin/ash-device" connect codex --collaborate`，一次确认读取、新建、发送/追加及主动发送材料的范围。材料默认允许 24 小时；续期运行同一命令，可用 `--expires-in-minutes` 指定 1 至 10080 分钟。确认会替换此前的读取、控制和材料范围，请核对项目。使用 `--project PATH` 可以明确指定项目目录。上述命令需要已完成安装、配对；普通用户从零完整接入仍待集中验收。

需要让 Codex 使用共享连接时，保存工作并正常退出 Codex，再运行 `"$HOME/.ash-device/current/bin/ash-device" codex-shared --start`；首次缺失配置会请求一次确认并由软件准备，已有配置不会覆盖。打开桌面后的连接仍需核实。

## 本地构建与验证

需要 Node 22+、npm、`ar`/`tar`/`zip`、`patchelf`、Android SDK 与 JDK 17+。构建 payload 还需要 `payload/manifest.json` 指定的外部软件包可获取。

```bash
npm ci
npm run typecheck
npm test
npm run test:ui:e2e
npm run build:payload
cd android && ./gradlew :app:assembleDebug
```

`npm test` 中依赖已安装 DSH 的场景，设置 `ASH_TEST_DSH_ROOT` 指向发布包根目录后运行；未设置时这些场景会明确跳过。浏览器 E2E 需先安装 Playwright Chromium。APK 输出为 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 来源与许可

ash 分叉自 [woaiys3/deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app)（MIT，v1.16.1 基线）。整体按 [MIT 许可](LICENSE)；虚拟屏模块源自 [Operit](https://github.com/AAswordman/Operit)，按 LGPL-3.0 分发。第三方软件包许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
