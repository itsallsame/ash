# 她的状态（vitals）· 交接说明

设计稿：「Ash 设计」画布的「她的状态」页（整页 / 各种情况 / 告警详情 / 桌面小组件 / 说明）。
这个目录把设计稿变成能直接用的东西：文案表、颜色和尺寸、图表的几何（网页 + 原生）、小组件卡片的 A2UI、逐屏标注、可打开的参考页。
规则和主 App 一样（`design/app/HANDOFF.md` §0）：数值只来自令牌，组件只用现成的，布局按标注，做完逐屏对照亮色 / 暗色。

## 0. 目录

| 路径 | 是什么 |
|---|---|
| `copy.json` | **界面上的全部文字**：状态灯叫法、每种情况她说的那句话、6 条运行底线、每个告警（标题 / 说明 / 为什么 / 你能做什么 / 重启确认）、此刻的分档、今天、小组件。代码按 id 查这张表，不在页面里写死中文 |
| `vitals.css` | 新 class：状态灯 `.lamp*`、`.vt-*`（状态头签、此刻格、今天、趋势柱）、读数条 `.gauge`、小组件 `.wg*`。依赖 `ash-tokens.css` |
| `icon.svg` | 应用图标（108 格，暖深棕底 + 薄荷色心电线） |
| `chart/chart.mjs` | **图表几何的唯一来源**：纵轴规则、折线点、柱、上限虚线、高亮段；`chartSvg()` 给网页直接出 SVG |
| `chart/AshChart.kt` | 同一套几何的原生画法（画成位图给小组件）。手写，**没在本机编译过** |
| `chart/vectors.json` | 7 组测试向量（输入 → 图元），网页和原生都拿它对数；`node chart/make-vectors.mjs` 重新生成 |
| `card/card.mjs` | 小组件卡片（A2UI）：一张卡 2×2 / 4×2 / 4×4 三个尺寸；`stableMax()` 纵轴防跳 |
| `card/examples/{ok,warn,err}.json` | 三种状态下 `vitals.card` 应返回的完整 a2ui（已用 `card.ts` 的 `validateCard` 检查通过，含层级预算；`Chart` 是按 §8 临时加进检查器后通过的） |
| `reference/*.html` | 设计稿导出，浏览器直接打开（头像引用 `packages/web/avatars/`）；`ash.css` 是画布用的那份（`you` 已是 `#CC4B2E`） |
| `redlines/*.json` + `INDEX.md` | 40 屏逐元素标注：16 个手机屏 + 24 个小组件（3 尺寸 × 4 状态 × 亮暗），单位 dp，颜色写令牌名；小图里每根柱、每条线也量了（`fill` / `stroke` 是令牌名） |

## 1. 落在哪里

- **应用**：一个一方应用 `packages/apps/vitals/`，和 `health` 同一结构（`app.json` + `src/server.mjs` + `ui/*.html` + `icon.svg`）。
  - `app.json` 草稿：`id: "vitals"`、`name: "她的状态"`、`icon: "icon.svg"`、`surfaces: [{id: "home", title: "状态"}, {id: "alert", title: "告警"}]`、`cards: [{id: "status", title: "她的状态", size: "4x2", tool: "vitals.card", refresh_min: 15}]`。
  - `needs` 要的词：`service:health status / recent`、`service:cost usage.get`、`service:history activity.page`、`service:admin status`，以及 §9 里要新加的两个。
- **页面在沙箱 WebView 里**（应用自己的源 + CSP），引不到主页面的 `ash-ui.css`。打包时要把 `packages/web/ash-tokens.css` + `ash-ui.css` 需要的部分 + `vitals.css` 内联进页面。主题跟 `hostContext.theme` 走（`health/ui/shared.html` 已有现成写法）。不要用 health 那套自带的颜色变量。
- **小组件**：就是这个应用的 card（「Ash 卡片」里能选到「她的状态」）。手机端照常用 `CardWidgetProvider` / `CardViews`，只需要加 §8 的 `Chart`。

## 2. 三个决定

1. **中文名「她的状态」。** 和「她的主页」「她的手和眼」一套：外面是你在看她，页面里她说「我」。
2. **状态灯三档：正常 / 留意 / 有问题 = ok / warn / err。** 灯芯 `*-fill`，光晕 `*-soft`，文字 `ok/warn/err`。另有：刚到（her，第一分钟）、暂停 / 过期（灰）。只有「有问题」的大灯外圈慢慢涨落（2.4s），系统减少动画时不动。
3. **小组件每个数配一张小图。** 4×2 = 负载 / CPU / 内存 / 今天花；2×2 = CPU + 今天花；4×4 = CPU 和负载叠在一张大图里，加内存、近 7 天花费，最底下一行是今天的数，有告警时那一行换成告警。

## 3. 灯怎么亮（`copy.json` → `levels`、`say`、`priority`）

| 灯 | 条件 | 她说 |
|---|---|---|
| 有问题 | `status.invariants` 里有一条 `ok === false`；或者大脑没在运行 / `status` 读不到 | 越界那条的 `say`；几条同时越界，取 `priority` 里靠前的；大脑没运行用 `err_brain_down` |
| 留意 | 一小时内有过 breach，现在都好了；或者手和眼有必需部位没好（位置和健康不算） | `warn_recovered`（如果最近那条是 `loop.lag`，用 `warn_recovered_lag`）；手和眼的用 `warn_hands` |
| 正常 | 其余 | `ok`；在忙时用 `ok_busy` |
| 刚到 | 第一次装好，`uptime_s < 60`，并且还没有 minute 行 | `new` |
| 暂停 | 主人在幕后点了「暂停 Ash」 | `paused` |

应用网格里，「她的状态」的图标在不是「正常」时，右上角带同色小点（和别的应用的出错角标一样大）。

## 4. 逐屏对照

| 设计稿（reference / redlines 前缀） | 要点 |
|---|---|
| `VitalsHome` 整页（正常） | 从上到下：状态头 → 此刻 → 今天 → 最近告警 → 体检（手和眼、运行）→ 最近 24 小时。正常时整页没有一处红色或琥珀色 |
| `VitalsStates` 留意 / 有问题 / 体检有待办 / 刚装好 | 有告警时「最近告警」排到「此刻」前面；「有问题」状态头下面是主按钮「看看怎么办」，直达那条告警；闲着才算的 3 条底线，她在忙时显示灰色「在忙，不算」 |
| `VitalsAlert` 进行中 / 已恢复 / 确认 | 三个数（现在 / 正常 / 持续）+ 读数条（黑色刻度 = 正常上限）；「为什么」用小头像 + 她的话；按钮从 `actions` 来，第一个是主按钮；`restart_brain` 先弹确认（这一步就是审批）；已恢复的只给「知道了」 |
| `VitalsWidget` 2×2 / 4×2 / 4×4 × 正常 / 留意 / 有问题 / 已过期 | 见 §7、§8 |

## 5. 数据从哪来

| 界面 | 读哪个 |
|---|---|
| 灯、此刻、运行 | `service:health status {window_s: 60}` → `proc.cpu_pct / rss_mb / lag_p99_ms`、`idle`、`invariants[]`；页面开着时每 10 秒读一次 |
| 此刻分档 | `copy.json` → `now.*.bands`（CPU <5 很闲 · <30 有点忙；内存 <300 不多 · <600 有点多；lag <50 很快 · <200 有点慢）；闲着时 CPU ≥5% 标红 |
| 最近告警 | `service:health recent {kind: "event", since: 24 小时前}`，只取 `type = "breach"`，倒序，最多 5 条；该 id 此刻 `ok === false` 的标「进行中」，开始时间用 `invariants[].since` |
| 今天 | 做的事 = `service:history activity.page` 的当天总数（和她的主页同一个数）；想了几次 / 花了 = `service:cost usage.get` → `periods.today.calls`、`cost_usd × 6.74`（`money.js`）；出错 = `recent {kind: "minute"}` 从 0 点起 `err` 加总；断线重连见 §9 |
| 连着几台 / 在忙 | `service:admin status` → `hands_online`；在忙 = `idle === false` 或有进行中的事 |
| 手和眼 | 见 §9（应用页面拿不到 `__ashCheckup()`） |
| 24 小时 / 小组件的图 | `recent {kind: "minute", limit: 1440}`：24 小时按小时合（做事 = msg 加总，CPU = cpu_pct 平均）；小组件取最后 60 行 `cpu_pct / rss_mb / msg`；花费 = `usage.get` 的 `by_day` 最近 7 天 |

## 6. 图怎么画（`chart/chart.mjs`）

- **折线**：x 均分铺满；y 上下各留 2dp；线宽 1.6（4×4 大图 2）；`fill` 时线下同色 16%；最后一个点画实心圆 r 2.4。
- **柱**：等宽，间距 `gap`（4×2 负载 1、花费 3；4×4 大图 1.2）；最矮 2dp；圆角 2。4×2、2×2 里负载 60 个点太细，每 3 分钟并成一根（取最大）。
- **纵轴**：CPU 和负载 = max(下限, 最大值 × 1.25)，下限 CPU 15%、负载 20 条/分（小组件 4×4 大图里负载再 ×1.6，柱压在线下面）；内存 = max(400, 最大值 × 1.25)，从 0 起。
- **纵轴不乱跳（小组件）**：`card.mjs` 的 `stableMax()`：变大立刻跟；变小到一半以下并且持续 30 分钟才缩。每个图的 `{max, lowSince}` 由应用存着。
- **颜色**：平时 CPU / 内存 / 负载 `her-fill`；花费柱 `surface-3`，今天那根 `you-mark`。正在越界：那条图从开始越界的点起 `err-fill`，内存跟着涨的那段 `warn-fill`，数字跟着变色，并画正常上限虚线（`text-3`，1dp，2/3 虚线），**虚线只在出事时画**。一小时内已经过去的那段用 `warn-fill`。哪条图高亮：自己那项在告警窗口里超过了自己的上限（CPU > 5% 且闲着、负载 > 30 条/分）就高亮那一段。

## 7. 小组件

- **外框**沿用「Ash 卡片」：卡片根节点自己带背景（`surface`），手机就不画外框标题，并给内边距 14、圆角 22（`CardPlan.plan` 已有这条规则）。
- **尺寸**：`a2ui.sizes` = 150×150 / 330×150 / 330×330，手机挑能放下的最大那个（`WidgetPlan.pick`）。结构和每个数见 `card/card.mjs` 和 `card/examples/`。
- **颜色**全部是 `tokens.json` 的 `{light, dark}`（`card.mjs` 的 `tok()`），跟系统暗色走，不依赖手机上 `red` / `teal` 这些名字映射到哪。
- **时间写钟点**（「14:02」「14:02 起」），不写「x 分钟前」：小组件不会实时重画。
- **刷新**：灯一变就推；图和数最多 15 分钟推一次（`refresh_min: 15`）；60 分钟没推就算过期。
- **过期不清空**（要改手机端）：现在 `CardView.Expired` 会换成一行「已过期」。改成照常画上一次的卡，所有颜色换成 `text-3`（柱子的 `surface-3` 不变），小图去掉高亮和虚线（`AshChart.stale()`），右上角时间换成「已过期 · 最后 12:31」（`copy.json` → `widget.stale_tag`），2×2 底下写 `stale_22`。灯在这时是灰色实心点（外框统一变灰得到）；画布里画的空心圈不强求。这条对所有 Ash 卡片都适用。
- **点哪里都打开「她的状态」**（`openApp: {app: "vitals"}`）。

## 8. 新卡片部件 `Chart`（Ash 扩展）

`card.ts` 现在把 `Chart` 列为画不了（`IMPOSSIBLE.Chart`）。但手机端本来就把 Image 画成位图放进小组件，图表也可以由手机按真实尺寸画成位图。所以：

```jsonc
{ "id": "cpu", "component": "Chart",
  "series": [                                   // 1–4 组，按顺序画（先柱后线）
    { "type": "line" | "bars",
      "values": [2, 1.4, …],                    // 1–240 个有限数，<0 当 0；所有组合计 ≤ 600
      "color": CardColor,                       // 线 / 柱的颜色（必填）
      "fill": true,                             // 线：线下同色 16%
      "width": 1.6,                             // 线宽 dp，0.5–4
      "dot": true,                              // 线：最后一点画圆点（默认 true）
      "max": 47.5, "floor": 15,                 // 纵轴：给了 max 用 max，否则 max(floor, 最大值 × 1.25)
      "highlight": { "from": 54, "to": 57, "color": CardColor },   // 线：一段换色；没有 to = 到最后
      "colors": { "3": CardColor },             // 柱：指定某几根的颜色
      "lastColor": CardColor,                   // 柱：最后一根的颜色
      "limit": 5, "limitColor": CardColor }     // 上限虚线（按这组的纵轴）
  ],
  "gap": 2,                                     // 柱间距 dp
  "style": { "width": "fill", "height": 30 } }  // 高度必填（dp）
```

- **检查**（`card.ts`）：`CARD_COMPONENTS` 加 `"Chart"`，`FIELDS.Chart = ["series", "gap"]`，删掉 `IMPOSSIBLE.Chart`；按上面的范围校验，颜色用现有的 `color()`；`levels()` 里 Chart 算 1 层。
- **画**（`CardViews`）：Chart → 一个 ImageView，`AshChart.render(chart, 宽dp, 高dp, density)`（`chart/AshChart.kt`）；按暗色挑颜色；计入 `bitmapBytes` 预算（一张 64×30dp 在 xxhdpi 下约 70 KB）；系统切暗色时重画。
- **网页**（应用页面）：`chartSvg(component, w, h)`，同一份几何。
- **单测**：网页和原生都跑 `chart/vectors.json`。

**为什么不让应用自己画好 PNG 发过来**：一张 PNG 不跟着暗色切换；应用不知道小组件实际多大、屏幕密度多少，图会糊或被拉伸。**为什么不用 `Icon {svgPath}`**：路径会被填满、缩进正方形，画不了细线。

## 9. 数据和接口缺口（开发补，或者先这样）

1. **「反应快不快」没有真正的响应时间**，只有大脑的 `lag_p99_ms`。第一版就用它（说的是「我手上的事卡不卡」，不包括等模型回话）。
2. **今天断线重连几次算不出来**：minute 行里没有 link。在 minute 行加 `link_opens` 就能加总。在补上以前，这一格显示「—」。
3. **已恢复告警的「持续了多久」没有**：事件只记开始，同一条 10 分钟才记一次。建议恢复时记一条 `{type: "ok", id, since}`。
4. **应用页面拿不到体检**：沙箱页面没有 `__ashCheckup()` / `__ashOpenNative()`。需要两样：
   - 一个能读体检摘要 `{todo, groups}` 的词（比如手机把摘要推给 `service:admin`）；
   - 一个能从应用打开原生体检页的办法（比如 host 支持 `ui/open-link` 打开 `ash://checkup/<部位>`）。
5. **重启大脑**：应用要能调用幕后「大脑 · 重启」用的那个动作（确认在应用里做）。
6. **英文 note**：界面不用，按 id 查 `copy.json`；不认识的 id 用 `unknown`。
7. **App 本身的 CPU / 内存 / 耗电**：第二阶段，在「此刻」下面加一行「手机上的 Ash」，同样三格。

## 10. 以后：更「动」的小组件（这次不做）

主人想要的是「动态仪表盘」的感觉。小组件在两次更新之间是一张静止的画面（Android 的限制）。下面这些是在限制之内能做的，留给下一版：

- **会自己走的数字**：用 `Timer`（Chronometer）写「已经平稳运行 2:14:37」，出事时写「空转了 06:12」，每秒自己跳，不用推更新。
- **会呼吸的灯**：给卡片加一个会动的灯，用不定进度条换上自己的动画图（薄荷色在忙时呼吸，红色出事时快一点）。系统减少动画时用静态的。
- **大图自动轮播**：4×4 的大图区用 `ViewFlipper`，每 5 秒滑到下一张（CPU → 负载 → 内存 → 花费），滑动由桌面自己播。
- **亮屏时每分钟更新**：亮屏时改成 1 分钟推一次，曲线每分钟前进一格；灭屏停（要量一下耗电，看是否在 `release-budgets.json` 里）。
- **Android 16 的 RemoteCompose**（2026 年 I/O 宣布）：系统直接运行带动画的绘图文档，可能做到真正连续动的图。目前只有 Android 16+，Glance 的支持当时还没正式发布，MIUI / ColorOS 的桌面认不认没有资料。值得先在测试机上试一下。
- 真正实时、连续滚动的曲线，放在应用页面里和灵动岛上做，不受这个限制。

## 11. 验收

- [ ] 每一屏亮色 / 暗色都和 `reference/` 对上（位置、尺寸、颜色名、字号、圆角）；小组件三个尺寸 × 四个状态都对上
- [ ] 页面和卡片里没有写死的中文（都来自 `copy.json`），没有写死的颜色（都是令牌；应用图标除外）
- [ ] 界面上不出现 invariant id、英文 note、top 的 key
- [ ] `chart/vectors.json` 网页和原生两边都过
- [ ] `card/examples/*.json` 过 `validateCard`（加了 Chart 之后）
- [ ] 「重启大脑」点了一定先确认；「去修」直达体检页对应部位
- [ ] 减少动画时，大灯外圈不动
- [ ] 小组件过期时不清空，整张变灰，右上角写「已过期 · 最后 hh:mm」
