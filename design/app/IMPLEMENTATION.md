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
- 整页的骨架：`ai.ash.ui.design.AshPage`（顶栏 `navbar`、大标题 `largeTitle`、滚动页 `scroll`、空状态 `empty`、底部抽屉 `Sheet`、应用图标块 `appIcon`、小号按钮的 44dp 点击区 `smallButton`）。原生页不要自己拼这些。
- 网页 ↔ 原生：网页调 `__ashOpenNative("apps" | "checkup" | "checkup/<部位>")` 让原生打开应用网格 / 体检页；原生把体检摘要 `{todo, groups:[{id, todo}]}` 推给网页（`__ashCheckup()` 取最后一份，`ash:checkup` 事件）。`todo` 不含「位置和健康（可选）」那一格，`groups` 里含。分组表在 `ui/Checkup.kt`。
- 单测：`AshTokensTest`（`android/app/src/test/java/ai/ash/ui/design/`）检查两套调色板、数值、字阶、动效、图标文件和 `ash_colors.xml` 都和 `tokens.json` 一致。`AshUi` 本身是 View 代码，JVM 单测测不到，要在真机/模拟器上看。

## App 图标

- `design/app/icons/app-icon.svg` → `android/{app,kernel}/src/main/res/mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png`（48–192px 位图，MIUI 要位图，不加 adaptive）；应用内引用的 `drawable/ic_launcher.xml` 同步成同一个图形。通知小图标 `ic_stat_ash` 没动。

## AshUi 相对设计包的改动

设计包里的 `AshUi.kt` 是手写的；落到仓库后只加不换接口，改了这几处：

- **精确行高**：`AshUi.text` 按字阶的行高精确排。用一个 `LineHeightSpan` 把行高定死、上下留白对半分（包括最后一行；34+ 的 `setLineHeight` 量过，换了中文备用字体后行还是偏高，所以不用它）。原来的做法（行距附加量，按拉丁字体算）在系统用另一种字体画中文时行变高、最后一行少一份留白，字在气泡里偏下。直接 `style()` 再自己设文字的地方还是旧做法，要精确行高请用 `AshUi.text`。
- **气泡投影**：`bubbleText` 的气泡有一个小尖角，系统给不出轮廓，所以没有阴影；加了 `AshUi.bubbleOutline(...)` 给气泡一个轮廓，自己拼气泡的地方也用它。
- **头像底**：`AvatarView` 先画 surface-2 的圆角底再画脸（脸是抠图，设计稿里底是显示的）。
- **进度光环**：新增 `AshUi.RingAvatar`（头像带一圈进度光 / 转圈），引导页的下载进度和「准备好了」页的开了几项用它。

## 她的主页（网页）

- 代码：`packages/web/js/home*.js` + `packages/web/home.css`（`tools/gen-ui.mjs` 内联）。页面壳 `index.html` 不认识它们：它们在 `<body>` 上挂自己的层，监听 `ash:open`（`{page: "home" | "apps", agent?, section?, arg?}`，处理了就 `preventDefault()`）。`section` 取：`waiting upcoming memory promises hands backstage identity files activity`，以及主页再往下的 `settled device connect browser apps app keys model usage advanced`。
- 数据：页面启动时通过 `connectHome(net, homeFeed)` 显式共享同一份连接与有限 current 状态（`home-feed.js`）；没有账本回放或连接猴补。主页的每一页拿到一个 `screen`：`screen.ask(to, word, body)` 以主人身份调一个词，页面或连接换掉后迟到的回答抛 `{code: "stale"}`，不会画到别处。
- 把话放进对话框：`ctx.compose(text)` 发 `ash:compose`（`detail: {text, turn?}`，可取消）；没人处理就直接填 `#t`。
- 原生入口：`globalThis.__ashOpenNative(page)`、`globalThis.__ashCheckup()` / `ash:checkup`（`page` 取 `apps`、`checkup`、`checkup/<部位>`；部位 id 见 `OnboardingPlan.PARTS`），没有原生时「这台手机」格不显示。
- 删除类操作都是两次点击：第一次写后果，第二次执行（`twoTap`）。

## Stable conversation rendering

`WindowView` owns stable conversation entities whose DOM remains a set of adjacent siblings, preserving the existing flex layout. `update(items, outbox, options, changedIds)` reconciles an ordered projected range; `null` changed IDs requests a range check, and `framePainter` merges explicit IDs within a frame. Neighbor context (`options.previous` / `options.next`) preserves time lines and grouped bubbles across range boundaries. Receipt, reaction and group changes reuse a message's Markdown and attachments. Pending local items and failure cards have separate stable keys.

History window items may include `type: "failed"` retry facts and aggregated reactions (`emoji`, `count`); these remain bounded display facts. An explicit `options.intro` takes precedence over the loaded-range heuristic. If the preceding item is a failure, `options.previousDisplay.ts` supplies the preceding timed item's timestamp, since failure cards do not advance time-line context.

`ScrollPosition` is the sole owner of reading compensation: it captures a visible Markdown block, restores it after writes and delayed height changes, and follows the bottom only when already there. It supports mounted-ID jumps and returning to the bottom; network paging/around lookup belongs to the data source. Selected or focused entities defer replacement/eviction until the interaction ends. `pinnedIds()` lets the caller protect corresponding data. A changed `options.epoch` resets old source entities even when selected; `dispose()` releases observers, listeners and attachment resources.

`options.atLatest` distinguishes the history tail from the bottom of an older loaded range. Compensation scroll events do not initiate paging or interrupt idle restoration. A jump whose initial empty bodies leave too little scrolling room keeps its requested target anchor until slices can align it; active user scrolling releases that request. Initial viewport filling stops at the data budget even while Markdown bodies are still being built.

`ConversationTimeline` consumes hydrated `history.window` entities rather than retaining a replay of the ledger. `ConversationStore` is the single canonical loaded range (at most 60 items, about 256 KiB of UTF-8 DTOs and expanded source). A legitimate oversized item is shown alone; active native selection, input drafts and the reading anchor can pause paging when the budget cannot safely release them. Bidirectional cursors and `around_id` locate older content without loading the intervening history. Reading older content keeps its position while live arrivals update the return-to-latest affordance.

`history.current` supplies current presence, progress, paged pending asks and accurate totals independently of the visible history range. Home activity uses bounded summary/step pages; today's totals query a date range, and child-agent totals/current state use explicit agent filters. A shared finite `AnswerIntents` table preserves uncertain-answer retry identity across the chat and home pages. Accepted outbox items use bounded `history.confirm` reads, so eviction cannot cause a confirmed message to be resent.

Full source text has a separate 2 MiB / 400-entry cache keyed by hash. Expansion choices are a 400-message-ID memory LRU; neither sources nor choices are persisted. Source availability and presentation admission are distinct: when a body is released, revisiting it first shows the preview even if its source remains cached. After scrolling stops for 150 ms, one nearby previously expanded message is restored at a time. Continued scrolling pauses its slices; leaving the nearby area or canonical range cancels them. Explicit expansion remains available immediately. Complete approval originals and externalized custom answers are read as selectable plain text only when their disclosures open, count against the loaded-range budget, and release on close or disposal. Inline attachments read only the requested loaded message's original record.


### Markdown frame work

`WindowView` gives every mounted rich message one shared `MarkdownQueue`, with a 4 ms script budget between frame boundaries. The safe renderer builds the same complete DOM: tables pause between rows, lists between items, and other blocks remain intact. Table borders keep the existing collapsed layout. Parser work counts against that budget, but an individual parser call or block can exceed it; the budget is a scheduling target, not a wall-clock guarantee.

Expanded text shows a quiet “正在展开…” line until its DOM is complete. Clicking the expand button releases that button's focus before requesting a body replacement; ordinary text selection and input drafts remain protected. `settled(id)` lets the caller await a row's current work, and `cancelExpansion(id)` stops unfinished work. The caller then withdraws presentation admission and repaints its preview; a bounded cached source may remain for a later restoration. Eviction, source reset and disposal cancel jobs and release their tokens. Metadata-only updates preserve both the body and any work in progress.

The data source owns the independent expansion-choice LRU, full-text cache and idle restoration policy. It decides which nearby row to fetch after scrolling settles, then waits for `settled(id)` before restoring the next one. Rendering does not introduce another prefetch/restoration scheduler, worker, persistent token cache or partial-body eviction.

For restored cached full text, `options.shouldBuild(id)` can pause parser/DOM work while scrolling. The queue reads the latest predicate between slices, retains the preview until the first DOM slice, and continues ordinary inline/preview jobs while restored text is paused. Returning `true` resumes the existing job; lifetime cancellation releases the tokens and resolves `settled(id)`. The data source still owns idle timing and near-viewport eligibility.

### Browser protocol checks

`gen:ui` compiles the browser transport's frame validators with Ajv standalone from `packages/sdk/schema/link/`. Opening the page executes these generated checks directly; it does not initialize the schema compiler. Protocol constants, sender roles, validation results and first-error text follow the same SDK schemas. Fixture comparisons cover all frame types with runtime code generation disabled. Node clients and the native transport keep their existing SDK paths; no frame checks are skipped.

After changing SDK frame definitions, run `npm run gen:link-schema` to update the schema files, then `npm run gen:ui` to rebuild the browser checks and pages. The SDK and browser fixture tests verify that the generated schemas and validators remain in sync.

Both pages load generated scripts with `defer`, allowing HTML parsing and script compilation to run separately. `gen:ui` uses one build helper and shared page entry for two targets. The browser bundle includes its connection client and generated frame checks; the smaller native bundle excludes that browser-only import and uses NativePort. `staticWeb` serves browser `UI_JS` from `/app.<sha256>.js` with an ETag and immutable one-year caching. The APK bundle is written into `android/app/src/main/assets/ash-ui/`; its `index.html` loads the relative script followed by the separate, deferred `native-bootstrap.<sha256>.js`. Classic defer order registers `__ashNativeBoot` before the AshNative hello/ready handshake. The page receives neither an endpoint nor an owner credential. Generation removes obsolete hashed scripts; new content always has a new URL.

Browser auto-boot runs in a timer task after bundle evaluation, separating module initialization from the shell's DOM and connection setup. Native boot remains triggered by the existing ready message.

The APK CSP permits only same-origin scripts (`script-src 'self'`); inline scripts and runtime code compilation are forbidden. Generation refuses inline script contents, event attributes and JavaScript links. Network connections remain forbidden (`connect-src 'none'`), and the existing frame, worker and navigation policies are unchanged. HomeActivity uses the existing `/assets/` WebViewAssetLoader and restricted `/assets/ash-ui/` route. Both servers set `no-cache` only on the fixed HTML path, so updates reread it while scripts retain long caching. Parity tests rebuild each target against its current sources and compare its corresponding bytes, shared module inputs/imports, common HTML/styles, CSP and defer order. Browser integration tests load the actual APK assets and restrictive CSP, exercise immediate and delayed native ready, read real SQLite history through NativePort, answer a card and receive a live update.
Conversation bubble shadows use an equal-radius pseudo-element while the bubble retains its asymmetric corners and the existing shadow token. The pseudo-element ignores pointer events and adds no text or DOM children. This avoids per-tile blur scratch textures on older Android WebView; cards keep their existing shadows.

An explicit message jump remains a reading anchor while incremental bodies grow, including near the history tail. A replacement preview/body resolves the pending target by its stable row key. Actual user scrolling or returning to latest releases that reading intent.
