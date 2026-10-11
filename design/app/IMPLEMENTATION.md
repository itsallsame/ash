# 新设计在代码里怎么用（网页 / 原生 / 令牌 / 图标）

设计交接包的规则见 `HANDOFF.md`。这份只讲落到仓库后的用法。

## 令牌

- 唯一来源：`design/app/tokens.json`。改完运行 `npm run gen:tokens`（同时生成网页变量、安卓资源、Kotlin 常量和网页图标模块）。
- `node tools/gen-ash-tokens.mjs --check` / `node tools/gen-ash-icons.mjs --check` 只检查、不写；`tools/gen-ash-tokens.test.mjs` 在 `npm test` 里跑这个检查。
- 生成物不手改：`packages/web/ash-tokens.css`、`android/app/src/main/res/values*/ash_colors.xml`、`values/ash_dimens.xml`、`android/app/src/main/java/ai/ash/ui/design/AshTokens.kt`、`packages/web/js/ash-icons.js`。

## 网页

- 变量：`packages/web/ash-tokens.css`（`:root` 亮色，`prefers-color-scheme: dark` 暗色）。页面里直接写 `var(--surface)`、`var(--you)`、`var(--text-2)` 等令牌名，不写颜色字面量。
- 组件 class：`packages/web/ash-ui.css`（来自 `design/app/ash.css`，去掉了画布展示用的 `.t-light/.t-dark`、设备外框、展示板）。class 名和设计稿、`reference/*.html` 一致：`.tx-*` 字阶、`.btn-primary/secondary/neutral/ink/danger/ghost` + `.btn-sm/.btn-lg/.btn-block`、`.list/.li/.lic/.lt/.lv`、`.group/.group-ttl/.group-foot`、`.tag-*`、`.seg`、`.sw`、`.opt/.resolved/.card-*`、`.pill`、`.sheet/.grabber/.scrim`、`.toast`、`.banner`、`.empty`、`.sk`（骨架）、`.av-*`（头像）、`.b-me/.b-her`（气泡）等。
- **有四个名字和旧页面撞了，加了 `a-` 前缀**，旧页面还在用原名：`.a-card`（设计稿 `.card`）、`.a-btn`（设计稿 `.btn`；修饰类 `.btn-primary` 等不变，写成 `class="a-btn btn-primary"`）、`.a-row` / `.a-row-me` / `.a-row-her`（设计稿 `.row` / `.row.me` / `.row.her`）、`.a-typing`（`.typing`）。旧样式清掉后再统一改回原名。
- 旧颜色变量保留为别名，指向新令牌：`--fg=--text`、`--mute/--muted=--text-2`、`--me/--accent=--you`、`--me-fg=--on-you`、`--card=--surface`、`--chip=--surface-2`、`--seg=--surface-3`。`--bg --line --ok --warn --err` 同名但含义变了：`--ok/--warn/--err` 是**文字色**；圆点、角标、按钮底色用 `--ok-fill/--warn-fill/--err-fill`。新写的代码一律用令牌名，不用别名。
- 图标：`import { icon } from "./ash-icons.js"`，`icon("chev", "i-s")` 返回 `<svg class="i i-s">`（尺寸 `.i-s 18 / .i-xs 16 / .i-l 26`，默认 22，跟随文字色）。图标集 = `design/app/icons/*.svg`，换图标改 svg 后 `npm run gen:tokens`。
- 打包：`tools/gen-ui.mjs` 把 `ash-tokens.css` + `ash-ui.css` 内联到 `index.html` 的 `<!-- ash-style -->` 处（在页面自己的 `<style>` 之前）；改了任何网页文件要 `npm run gen:ui` 并提交生成文件。
- 字体：`ash-ui.css` 给整页 `body` 设了 `font-family:var(--font)`、`color:var(--text)`、等宽数字、抗锯齿；`index.html` 的 `body` 规则只留字号和行高，不再自己写 font-family。可用 `--font`（系统字体）、`--mono`；圆角 `--r-xs … --r-pill`；缓动 `--ease`；阴影 `--shadow-1/-2`。

## 原生

- 组件：`ai.ash.ui.design.AshUi`（按钮、图标按钮、卡片、卡片头、分组列表 + 行、标签、选项、答完的结果行、分段、气泡、进度小胶囊、抽屉底、审批卡、`Spinner`、`AvatarView`、`AshSwitch`）。颜色 `AshUi.p(ctx)`（按系统暗色取 `AshPalette`），数值 `AshTokens.Space/Radius/Size/Type/Motion`；也可用资源 `@color/ash_*`、`@dimen/ash_*`。
- 图标：`R.drawable.ash_ic_<名字>`（50 个，名字同 `design/app/icons/<名字>.svg`），用 `setTint` 着色。
- 页面里不写 `Color.rgb(…)`、`0xFF…`、魔法数字；缺组件先加进 `AshUi`。
- 单测：`AshTokensTest`（`android/app/src/test/java/ai/ash/ui/design/`）检查两套调色板、数值、字阶、动效、图标文件和 `ash_colors.xml` 都和 `tokens.json` 一致。`AshUi` 本身是 View 代码，JVM 单测测不到，要在真机/模拟器上看。

## App 图标

- `design/app/icons/app-icon.svg` → `android/{app,kernel}/src/main/res/mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png`（48–192px 位图，MIUI 要位图，不加 adaptive）；应用内引用的 `drawable/ic_launcher.xml` 同步成同一个图形。通知小图标 `ic_stat_ash` 没动。

## AshUi 相对设计包的改动

设计包里的 `AshUi.kt` 是手写的；落到仓库后只加不换接口，改了这几处：

- **精确行高**：`AshUi.text` 按字阶的行高精确排。用一个 `LineHeightSpan` 把行高定死、上下留白对半分（包括最后一行；34+ 的 `setLineHeight` 量过，换了中文备用字体后行还是偏高，所以不用它）。原来的做法（行距附加量，按拉丁字体算）在系统用另一种字体画中文时行变高、最后一行少一份留白，字在气泡里偏下。直接 `style()` 再自己设文字的地方还是旧做法，要精确行高请用 `AshUi.text`。
- **气泡投影**：`bubbleText` 的气泡有一个小尖角，系统给不出轮廓，所以没有阴影；加了 `AshUi.bubbleOutline(...)` 给气泡一个轮廓，自己拼气泡的地方也用它。
- **头像底**：`AvatarView` 先画 surface-2 的圆角底再画脸（脸是抠图，设计稿里底是显示的）。
- **进度光环**：新增 `AshUi.RingAvatar`（头像带一圈进度光 / 转圈），引导页的下载进度和「准备好了」页的开了几项用它。

