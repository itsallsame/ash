# Ash 主 App 新设计 · 交接说明（给实现的人 / Claude Code）

设计稿：claude.ai 上的「Ash 设计」画布（设计系统 / 对话 / 她的主页 / 应用 / 引导五页；灵动岛页**不改**）。
这份目录把设计稿变成了**可以直接用的东西**：数值、组件代码、图标、逐屏量好的标注、可打开的参考页。实现时不要从图上估数值。

## 0. 先读这个：保真的规则

1. **所有数值只来自令牌**：颜色、字号、间距、圆角、尺寸、动效都在 `design/app/tokens.json`。改设计 → 改这个文件 → `node tools/gen-ash-tokens.mjs`。页面代码里不出现 `Color.rgb(...)`、`#xxxxxx`、魔法数字。
2. **组件只用现成的**：原生用 `ai.ash.ui.design.AshUi`，网页用 `design/app/ash.css` 里的同名 class。缺组件就先加进组件库，再在页面里用。
3. **布局按标注来**：每一屏的每个元素都量好了（`redlines/`），x/y/宽/高/内边距/间距/圆角/字号，颜色写的是令牌名（`surface`、`you`、`her-fill`…）。单位是 dp（设计稿按 390dp 宽画；测试机 1080×2400 是 392.7dp 宽，横向按比例铺满，纵向不缩放）。
4. **做完逐屏对照**：浏览器打开 `reference/<板子>.html`，亮色、暗色都要对；状态（空、载入、离线、错误、答完的卡片）也要对。
5. **灵动岛一律不动**（`docs/island/` 和 `ai.ash.screen.island.*`）。

## 1. 目录

| 路径 | 是什么 |
|---|---|
| `design/app/tokens.json` | 唯一来源：34 个颜色（亮/暗）、字号阶梯、间距、圆角、尺寸、阴影、动效 |
| `tools/gen-ash-tokens.mjs` | 生成下面四个文件（已生成并提交） |
| `packages/web/ash-tokens.css` | 网页的 CSS 变量，`:root` + `prefers-color-scheme: dark` |
| `android/app/src/main/res/values/ash_colors.xml`、`values-night/ash_colors.xml` | 安卓颜色，同名 `ash_*`，系统暗色自动切换 |
| `android/app/src/main/res/values/ash_dimens.xml` | 间距 / 圆角 / 尺寸（dp）、字号（sp） |
| `android/.../ui/design/AshTokens.kt` | 同一套令牌的 Kotlin 常量：`AshTokens.palette(night)`、`Type`、`Space`、`Radius`、`Size`、`Motion` |
| `android/.../ui/design/AshUi.kt` | **原生组件库**（手写，未在本机编译过，请先编译）：按钮、图标按钮、卡片、卡片头、分组列表 + 行、标签、选项、答完的结果行、分段、气泡、进度小胶囊、抽屉底、审批卡组合、转圈、头像（状态光环）、开关 |
| `android/app/src/main/res/drawable/ash_ic_*.xml` | 50 个线条图标（VectorDrawable，24 网格 1.8 线宽，`setTint` 着色） |
| `design/app/icons/*.svg` | 同一套图标的 SVG，`app-icon.svg` 是新的 App 图标 |
| `design/app/ash.css` | 网页组件的参考实现（设计稿就是用它画的；`.t-light/.t-dark` 两个 class 只用于画布展示，实现时用 `ash-tokens.css` 的 `:root`） |
| `design/app/reference/*.html` | 设计稿导出，浏览器直接打开（头像引用 `packages/web/avatars/`） |
| `design/app/redlines/*.json` + `INDEX.md` | 58 屏的逐元素标注（亮暗各一份） |

## 2. 结构上的变化（这几条是这次改版的核心）

1. **没有底部页签。** 底部只留给输入框。`HomeActivity` 去掉「对话 / 应用」页签栏；对话就是主屏。
2. **对话页顶栏只有两样**：左边她（头像 + 名字 + 状态，点了进「她的主页」），右上角「应用」图标（进应用页）。原来的「文件」「☰」去掉——文件和设置都在她的主页里。
3. **「她的主页」取代设置抽屉 + 人物页 + 诊断入口。** 从上到下：她此刻（大头像 + 状态 + 三个数）/ 等你的 / 接下来 / 她记得你 / 你们的约定 / 她的手和眼 / 她是谁 / 她的文件 / 幕后（密钥、模型、花费、高级、暂停）。每块点进去是二级页（`HomePages`）。
4. **应用页是图标网格**；每个应用有自己的详情页（原「设置 · 应用」那串卡片的内容）。打开应用的外框不变（返回 / 图标+名字 / 更多）。
5. **引导是一次一件事**：她说为什么、给你看开了会得到什么、两个按钮（去打开 / 先不用）。要紧的先问，可选的（位置、健康）放后面。
6. **原生诊断页 = 主页里的「她的手和眼」**，长一个样。

功能和流程本身不变（审批规则、她什么时候说话、每个开关做什么），变的是入口位置、长相和文案。

## 3. 逐屏对照

| 设计稿（reference / redlines 前缀） | 现在的代码 | 要点 |
|---|---|---|
| `Chat` 日常对话 / 卡片 / 已处理 / 长内容 | `packages/web/index.html`、`js/presence.js`、`conversation.js`、`cards.js`、`composer.js`、`progress.js` | 顶栏见 §2；她的气泡卡面色 + 暖阴影，你的气泡蜜桃色；Ash 的消息不带头像，只有子 agent 署名；卡片头「Ash 问你 / 需要你确认 / 没做成 / 需要授权」；选项选中后实心珊瑚带勾、其它 40%；审批答完收成一行结果；失败 = 一张卡 +「重试」；进度从输入框上方的长条改成居中的小胶囊；输入框左侧小头像 = 跟谁说（@） |
| `ChatStates` 首次见面 / 空 / 载入 / 离线 / 跟谁说 / 附件 | 同上 + `agent-picker.js`、`attach-menu.js` | 载入用骨架气泡，不写字；离线：头像 55% + 灰点 + 顶栏下横幅；**去掉「未发送的文字和附件暂存在此浏览器…」那行**，改成气泡下「等连上就发」 |
| `Home` 她的主页（整页长图） | 新页。数据都已存在：`settings.js`（费用、密钥、设备、应用、免打扰、主动联系、审批档位）、`sheet-*.js`（身份、记忆、活动、计划、审批）、`files.js` | 三个数：今天做的事（活动当天轮数）/ 等你（待审批 + 待回答）/ 今天花的；「她的手和眼」四格：这台手机（体检要处理的项数）、电脑、浏览器登录、应用 |
| `HomePages` 等你的 / 她做过的事 / 接下来 / 她记得你 / 你们的约定 / 她的手和眼 / 幕后 / 她是谁 | 对应 `sheet-approvals.js`、`sheet-activity.js`、`sheet-upcoming.js`、`sheet-memory.js`、`settings.js`（免打扰 + 审批 + 主动联系 合成「约定」）、`ConsoleActivity.kt`、`sheet-identity.js` | 记忆按 USER.md / MEMORY.md 的二级标题分组，一条一行；约定里珊瑚色的词点了就改（时间选择 / 分段 / 文本）；删除都是两次点击，第二次写后果 |
| `Apps` 网格 / 应用详情 / 打开 / 还不能用 / 空 | `apps/AppsPane.kt`、`apps/AppActivity.kt`、`settings-apps.js` | 网格 4 列、图标 62dp 圆角 19；停用 = 图标 35% + 名字后「· 停用」；出错 = 红色角标；等批准的放在网格上面一条横幅 |
| `Setup` 你好 / 大脑 / 一次一件 / 要你亲手开的 / 准备好了 | `ui/OnboardingActivity.kt`、`OnboardingPlan.kt` | 原来 5 步里的每一项拆成一屏；顶部小圆点表示进度；「要你亲手开的」画出系统设置里那一行；结束页的环 = 开了几项 |

「她的手和眼 · 体检」把权限按「身体」分组（替代权限名清单）：

| 部位 | 包含（`OnboardingPlan` / `ConfigStatus` 的项） |
|---|---|
| 大脑 | 内核包、内核连接、内核不受电池优化限制、内核自启动 |
| 闹钟 | 精确闹钟 |
| 叫你 | 通知、提醒的铃声和振动（「测试」按钮在这一格的详情里） |
| 在后台醒着 | 不受电池优化限制、Ash 自启动与后台运行、在最近任务里锁定 |
| 眼睛和手 | 无障碍（屏幕）、悬浮窗、Shizuku、无障碍自动恢复 |
| 照片和文件 | 照片视频和文件、所有文件访问、修改系统设置、使用情况访问 |
| 位置和健康（可选） | 位置、后台位置、运动与健身、健康数据 |

一格里只要有一项没开就显示琥珀色「去修」，点进去是这一格的明细（每项一句为什么 +「去开启」）。

## 4. 原生实现提示

- **主题**：`AshUi.p(ctx)` 按系统暗色取 `AshPalette`；资源方式用 `@color/ash_*` 也行（`values-night` 已生成）。页面背景 `bg`，状态栏图标：亮色深、暗色浅（沿用 `Ui.systemBars`）。
- **字重**：650 在 API 28+ 用 `Typeface.create(DEFAULT, 600, false)`；26–27 回落粗体。数字统一 `fontFeatureSettings = "tnum"`（`AshUi.style` 已做）。
- **阴影**：亮色卡片 1dp elevation + 暖色阴影（API 28+ `outlineSpotShadowColor = 0x33784628`）；暗色不用阴影。
- **动效**：曲线 `PathInterpolator(0.32f, 0.72f, 0f, 1f)`（和岛同一条）；抽屉 360ms、消息出现 240ms（上移 6dp + 淡入）、卡片答完收起 300ms；呼吸 1.8s、光环 2.4s、转圈 0.9s。系统动画缩放为 0 时全部不跑（`AshUi.motionOn`）。
- **头像**：`AshUi.AvatarView`，状态 → 表情图片沿用岛的对应表（在想 thinking、在做事 focused、等你 listening、完成 success、离线 resting、平时 default）。
- **列表**：`AshUi.group(...)` 里的分隔线从图标右边开始（54dp），无图标列表从 14dp 开始。
- **触控**：可点的东西不小于 44dp（小号按钮 34dp 时外面留够点击区）。

## 5. 文案

以设计稿「设计系统 · 文案」为准（`reference/Copy.html`）：她自称「我」、叫主人「你」；按钮动词开头、写清后果（允许这一次 / 以后都允许 / 不允许、去开启、去授权、重试、收回全部权限、确认删除）；出错 = 发生了什么 + 为什么（人话）+ 你能做什么。界面上不出现内部 id、英文代号（JEV、DSH、turn、gate…）、工具名、关闭码、路径；「内核」对用户叫「大脑」。

## 6. 验收

- [ ] 测试机（1080×2400，MIUI）和一台 ColorOS 上，每一屏亮色 / 暗色都和 `reference/` 对上（位置、尺寸、颜色名、字号、圆角）
- [ ] 页面代码里没有写死的颜色和尺寸（`grep -rn "Color.rgb\|0xFF" android/app/src/main/java/ai/ash/ui android/app/src/main/java/ai/ash/apps` 只剩令牌文件）
- [ ] 系统切换暗色时，原生页和网页一起切
- [ ] 系统「移除动画」时没有循环动画
- [ ] 所有可点区域 ≥ 44dp；正文对比度 ≥ 4.5:1
- [ ] 灵动岛没有任何变化

## 7. 设计稿里没有细画的（用组件库自行组合，风格一致即可）

文件浏览器内部、中转站搭建流程的各步、子 agent 的主页（用同一模板，头像换字母头像）、引导第 4 步「位置和健康」（同「一次一件」模板）、应用打开后的出错页（同空状态结构 +「重新加载」）。
