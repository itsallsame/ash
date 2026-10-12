# 第三方组件与开源许可声明 · Third-Party Notices

本仓库**整体**采用 **MIT** 许可（见 [`LICENSE`](LICENSE)）。

但**虚拟屏（vscreen）功能**包含来自 **Operit** 的代码，**该部分按 LGPL-3.0 分发**。
同一个仓库里同时存在两种许可，**请分别遵守**——尤其当你要复用/修改虚拟屏相关文件时。

---

## 1. Operit — LGPL-3.0（虚拟屏 vscreen）

| 项 | 内容 |
|---|---|
| 项目 | **Operit** — Android 上能力强大的 AI Agent |
| 仓库 | <https://github.com/AAswordman/Operit> |
| 作者 | [AAswordman](https://github.com/AAswordman) |
| 许可证 | **GNU Lesser General Public License v3.0（LGPL-3.0）** |
| 许可证全文 | [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)（LGPL-3.0 以 GPL-3.0 为基础，故同时提供 [`licenses/gpl-3.0.txt`](licenses/gpl-3.0.txt)） |

### 1.1 本项目中源自 Operit 的部分

虚拟屏功能的实现**移植/对齐自 Operit 的 shower（虚拟屏）模块**。原先取自 Operit、带 LGPL 头的 `FakeContext.java`、`Workarounds.java`
已按 scrcpy（Apache-2.0）重写，移到 `android/app/src/main/java/ai/ash/caps/hostshell/`（见第 2 节），不再含 Operit 代码。

| 文件 | 与本项目的关系 |
|---|---|
| `android/app/src/main/java/ai/ash/caps/vscreen/Main.java` | 虚拟屏服务端。其**核心机制移植/对齐 Operit**：`MediaCodec` H.264 编码器 Surface + `setVideoSink` 推流、SPS/PPS（csd-0/csd-1）缓存重放、`DisplayManager.createVirtualDisplay()` 建屏、`InputManager` 反射定向注入、`ActivityOptions.setLaunchDisplayId` 启动到指定虚拟屏、idleWatcher 保活 |
| `plugins/dsh-tool-vscreen/` | 本项目自研的 DSH 插件封装（通过 HTTP 调用上述服务端；接口与工具 schema 为本项目设计） |

> **保险起见的口径**：本声明**按最保守方式把整个虚拟屏模块
> （`android/app/src/main/java/ai/ash/caps/vscreen/`）视为 LGPL-3.0 覆盖范围**。
> 这样无论后续维护者把哪些文件判定为"衍生作品"，都不会出现许可缺口。

### 1.2 如果你要继续修改这些文件

- **修改后的这些文件（及其衍生）必须继续以 LGPL-3.0 分发**，并保留原始版权与许可声明（LGPL-3.0 §2、§4）；
- 不得对本模块附加任何"禁止修改 / 禁止为调试而反向工程"的限制（LGPL-3.0 §4）；
- 本项目**不要求**你对仓库其余（MIT 部分）做任何开源——两部分的许可彼此独立。

### 1.3 本项目已履行的 LGPL-3.0 义务

| 义务（条款） | 履行方式 |
|---|---|
| 显著声明"使用了该 Library 且该 Library 及其使用受 LGPL-3.0 约束"（§4a） | 本文件 + `README.md` 的「致谢与开源许可」章节 |
| 随作品附带 GPL-3.0 与 LGPL-3.0 全文副本（§4b） | [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)、[`licenses/gpl-3.0.txt`](licenses/gpl-3.0.txt) |
| 提供可重新链接/重新编译的对应源码（§4d） | **本仓库即为完整对应源码**（含 `android-app/`、`plugins/`、构建脚本 `android-app/build.sh`），任何人可获取、修改、自行编译与重新链接 |
| 允许为调试修改而反向工程（§4） | 本项目未附加任何禁止条款 |

> 若发现归属有遗漏或希望调整声明方式，欢迎提 [Issue](https://github.com/woaiys3/deepseek-harness-android-app/issues) 或直接联系作者。

---

## 2. 「后台也能动手」（手机的调试身份）用到的开源代码

`android/app/src/main/java/ai/ash/caps/hostshell/` 与 `android/app/src/main/jni/`：Ash 和手机的无线调试配对、以调试身份拉起白名单服务。
下列代码经改写后并入，各文件头写明了来源与改动。Apache-2.0 全文见 [`licenses/apache-2.0.txt`](licenses/apache-2.0.txt)。

| 来源 | 许可证 | 用到的部分 |
|---|---|---|
| **Shizuku** <https://github.com/RikkaApps/Shizuku> | Apache-2.0 | adb 客户端与配对（`adb/AdbKey.kt`、`adb/AdbClient.kt`、`adb/AdbMdns.kt`、`adb/AdbWire.kt`、`jni/adb_pairing.c`），以及服务把 binder 交给 App 的做法（`Server.java`）。未使用 Shizuku 的名称、图标、包名或权限名 |
| **Shizuku-API** <https://github.com/RikkaApps/Shizuku-API>，Copyright (c) 2021 RikkaW | MIT（全文见下） | 进程管道的交接方式（`ServerProcess.java`） |
| **scrcpy** <https://github.com/Genymobile/scrcpy>，Copyright (C) 2018 Genymobile, (C) 2018-2026 Romain Vimont | Apache-2.0 | `FakeContext.java`、`Workarounds.java`（app_process 里的 Context） |
| **BoringSSL** <https://boringssl.googlesource.com/boringssl>（经 `io.github.vvb2060.ndk:boringssl:20251124` 预编译包，静态链接进 `libashadb.so`） | Apache-2.0 | 配对用的 SPAKE2、HKDF、AES-GCM |
| **okhttp-tls** <https://github.com/square/okhttp>（`com.squareup.okhttp3:okhttp-tls:4.12.0`） | Apache-2.0 | 为配对证书生成自签名证书 |

Shizuku-API 的 MIT 许可：

```
Copyright (c) 2021 RikkaW

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 3. payload：运行时与 npm 依赖

| 项 | 说明 |
|---|---|
| `runtime/` | Termux 的 aarch64 软件包（Node.js、Python、Git、ripgrep、Bash、curl、pnpm、OpenSSL、ICU 等），版本与哈希锁定在 `payload/manifest.json`，只做了可重定位处理（RUNPATH、shebang），各自原许可 |
| `dsh/` | 来自 npm 的 `@deepseek-ai/dsh` 及其依赖闭包，**原样分发**，版权与许可归各自作者所有；本仓库不重新授权它们 |

---

## 4. 智能体容器（`assets/container/ash-container.tgz`）

App 里随附一个 Linux 容器，智能体在其中运行。它由 `tools/build-container-rootfs.mjs` 从锁定的来源组装（版本与 sha256 写在脚本里），各组件**原样分发**、保留各自许可：

| 组件 | 来源 | 许可证 |
|---|---|---|
| PRoot 5.1.107.96（`proot/bin/proot`、`proot/libexec/loader`） | Termux 的 `proot` 软件包，上游 <https://github.com/termux/proot>（源自 <https://proot-me.github.io/>） | **GPL-2.0**，全文见 [`licenses/gpl-2.0.txt`](licenses/gpl-2.0.txt)。对应版本的源码可从上游仓库与 Termux 软件包源（<https://github.com/termux/termux-packages>，`packages/proot`）获得 |
| talloc 2.5.0（`proot/lib/libtalloc.so.2`） | Termux 的 `libtalloc` 软件包，上游 <https://talloc.samba.org/> | **LGPL-3.0**，全文见 [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)；以独立动态库形式分发，可被替换 |
| libandroid-shmem 0.7（`proot/lib/libandroid-shmem.so`） | Termux 的 `libandroid-shmem` 软件包 | BSD 式许可（版权声明见该包的 `share/doc/libandroid-shmem/copyright`） |
| Ubuntu Base 24.04 arm64（`ubuntu/`） | <https://cdimage.ubuntu.com/ubuntu-base/> | 各软件包各自的许可，见容器内 `/usr/share/doc/*/copyright` 与 `/usr/share/common-licenses/` |
| Node.js（`ubuntu/opt/node`） | <https://nodejs.org/> | MIT 及其依赖各自的许可（见 `ubuntu/opt/node/LICENSE`） |
| DSH（`ubuntu/opt/dsh`） | npm 上的 `@deepseek-ai/dsh` 及其依赖 | MIT 及各依赖各自的许可，原样分发 |

---

## 5. 摘要

| 范围 | 许可证 |
|---|---|
| 本仓库其余全部内容（ash core、SDK、DSH 绑定、Android 宿主、构建脚本、文档） | **MIT** |
| `android/app/src/main/java/ai/ash/caps/vscreen/`（虚拟屏） | **LGPL-3.0**（源自 Operit） |
| `android/app/src/main/java/ai/ash/caps/hostshell/`、`android/app/src/main/jni/` 中改写自 Shizuku、scrcpy 的文件（见第 2 节） | **Apache-2.0**（`ServerProcess.java` 的交接方式源自 Shizuku-API，MIT） |
| `libashadb.so` 中静态链接的 BoringSSL；依赖 okhttp-tls | **Apache-2.0** |
| payload：DSH（`@deepseek-ai/*`）及其 npm 依赖 | 各自原许可，原样分发，本仓库不重新授权 |
| payload：Termux 软件包（node、python、git、ripgrep、bash、curl、pnpm、openssl 等） | 各自原许可（见 payload 内 `runtime/share/LICENSES` 与各包说明）；版本与哈希锁定在 `payload/manifest.json` |
| 智能体容器：PRoot | **GPL-2.0** |
| 智能体容器：talloc | **LGPL-3.0** |
| 智能体容器：Ubuntu Base、Node.js、DSH 及其余组件 | 各自原许可，原样分发 |
