# dsh-select-translate · 划词翻译

在**任意 Windows 应用**里选中文字，鼠标旁弹出一张**只含译文**的原生置顶卡片：
译文流式出现、跟随最新一行，单次上限 **15000 字**。也可以切成**小图标模式**（先亮图标，点一下才译）。

- 取词走 **UI Automation**（不碰剪贴板）；取不到就安静地不弹 —— 达标线不含 WPS/Office。
- 翻译走宿主自己的 **`ctx.llm.stream`**：一次裸模型调用，**没有 agent 会话、不进侧栏、不落盘**。
- 卡片是 GDI+ 自绘的分层窗口，**不抢焦点**；`Esc` / 点卡片外 / ✕ 都能收起，并**中断在途请求**。
- 长文本：内容超过卡片上限后**视图跟着新译文往上顶**（最后 1–2 行始终是最新的），右侧细滚动条随滚动淡入；
  翻译结束回到译文开头。滚轮可回看已生成的部分。

## 适用范围（重要，先读这段）

| 项 | 说明 |
|---|---|
| 系统 | **仅 Windows**。UIA 取词、GDI+ 原生卡片、`user32`/`kernel32` 都是 Windows 专属；非 Windows 上宿主半边会**主动跳过加载**（不拉伴生进程、不注册路由），**不会影响你的 DSH 能不能启动** |
| 宿主 | DSH 桌面端（实测 `@deepseek-ai/dsh-desktop` 0.2.0-rc.2）。纯 Web 端没有原生窗口，弹不出卡片 |
| 依赖 | **零额外依赖、零构建**：koffi 复用 DSH 自带的（不装原生模块、**不需要授权构建脚本**）；插件是纯 JS，没有 `build`/`prepare` 脚本 |
| 权限 | 需要读任意应用的选区与全局鼠标（UIA + 40ms 轮询），并在本机 `127.0.0.1` 上开一个内部 HTTP 口给伴生进程用 |
| 已知限制 | **以管理员权限运行的应用取不到词**：Windows 的 UIPI 不允许低权限进程读取高权限窗口的 UI Automation，这类窗口里划词**不会弹卡片** —— 属预期行为，不是故障（取词达标线也不含 WPS / Office） |

## 隐私

- 选中的文本只经**宿主**发给**你自己在 DSH 里配置的模型**（`ctx.llm.stream`），不经过任何第三方服务。
- **不落盘**：原文与译文都不写文件、不进会话日志、不进侧栏；伴生进程只在内存里留最近一次取词结果（重启即失）。
- 唯一写盘的是两个小文件：设置 `$DSH_HOME/dsh-select-translate.json`（只存触发模式 `auto` / `icon`）
  和运行时文件 `$DSH_HOME/dsh-select-translate-runtime.json`（伴生进程的随机端口 + 下面那个令牌，给本机排障工具用）。
- 剪贴板只在**你点卡片上的「复制」**时被写入；取词过程完全不碰剪贴板。

## 本地接口与令牌

插件在本机 `127.0.0.1` 上有一个内部 HTTP 口（宿主的 `/dsh-select-translate/api/*` 与伴生进程的随机端口），
用于宿主 ↔ 伴生进程之间传选区与译文。宿主的那些路由**挂在 DSH 的 `/api` 鉴权栅栏之外**，
所以除 `/ping` 外都要求请求头 `x-dsh-select-translate-token`（每次启动随机生成）：

- **为什么能挡住网页**：带自定义头的跨源请求会先触发 CORS 预检，而本插件从不回 CORS 头，
  浏览器因此**根本不会把这个请求发出去**。这是防止任意网页偷打本机端口、花掉你的额度。
- **边界说清楚**：能扫本机端口、能读文件的**本地进程**仍然拿得到令牌（运行时文件里有）。
  这道锁防的是网页与顺手一发的脚本，不是同用户的恶意程序。

## 安装

```sh
# 推荐：在 DSH 里「设置 → 插件市场」搜「划词翻译」，一键安装
# 或用命令行（等价于市场做的事）：
dsh plugin --profile web add dsh-select-translate                         # 走 npm（已发布）
dsh plugin --profile web add github:SHAN5246992ZHUI/dsh-select-translate  # 走 GitHub 源码
```

包同时发布在 npm：[`dsh-select-translate`](https://www.npmjs.com/package/dsh-select-translate)（MIT、**零依赖、零构建**）。
市场的安装优先级是 **npm 包 → Release tarball → 整仓源码**，所以有 npm 版本时它优先走 npm ——
预构建安装可以跳过 `allowBuilds` 构建授权那一步。

装完**重启 DSH**（宿主半边不会热加载）。卸载：市场里点卸载，或 `dsh plugin remove dsh-select-translate`。

<details>
<summary>开发时怎么装（本地目录 + profile patch 层，M1 起就在用）</summary>

M1 没有走 `plugin_manager install_bundle`（当时被 pnpm 供应链策略挡住了，见下），而是直接挂在
**profile 的用户 patch 层**：

```
%DSH_HOME%\profiles\desktop\cordis.patch.yml   ← 末尾新增 insert: dsh-select-translate
%DSH_HOME%\profiles\desktop\node_modules\dsh-select-translate  ← 指向本目录的 junction
```

装了之后**热生效**，不用重启桌面端。

### 为什么当时没走 plugin_manager

`install_bundle` 会在 profile 目录跑 pnpm，而 pnpm 校验整份 lockfile 时报：

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] dshmarket@1.66.15 was published within the minimumReleaseAge cutoff
```

这是**既有环境问题，与本插件无关**（`dshmarket` 发布不到 24 小时）。
三条出路：① 等满 24h；② 按提示放宽 `profiles/desktop/pnpm-workspace.yaml` 的策略；③ 继续用 patch 层。

⚠️ 用 patch 层时，`node_modules\dsh-select-translate` 这个 junction 不在 lockfile 记录里，
将来跑一次 `pnpm install` 可能被清掉；被清掉后插件会加载失败，重新建 junction 即可。
⚠️ **自测"市场安装"之前要先卸掉这个 junction 版本**，否则同一个插件会有两条 loader 条目。

</details>

## 怎么卸载

删掉 `profiles/desktop/cordis.patch.yml` 末尾那段 `- insert: ... dsh-select-translate`，或把 `id: dsh-select-translate`
那行改成 `disabled: true`。改动同样热生效。
（改动前的原文件备份在 `cordis.patch.yml.profile-backup`。）

## 怎么改代码

- 改 `client.js` → **hot reload**：`client-hmr` 每 500ms 轮询文件，一变就重建并让页面 remount，**不用刷新**。
  没生效就手动刷新页面。
- 改 `index.js` / `settings.mjs`（宿主半边）→ 需要**重启桌面端**。
- 改 `companion/**` → 重启伴生进程即可：`POST /dsh-select-translate/api/system/restart`。

## 两个触发模式

| 模式 | 行为 |
|---|---|
| **即划即译**（默认） | 划词停手 → 直接出卡片、流式译文 |
| **小图标** | 划词停手 → 鼠标旁只亮一个 **24px 小圆图标**（与页内 `.hc-mini` 同款）→ **点它才翻译**；鼠标移开 / `Esc` / 点别处就收起 |

切换：卡片头部那个 **⚡**（亮 = 即划即译；暗 = 小图标模式）。**切换会持久化**到
`$DSH_HOME/dsh-select-translate.json`（`{"mode":"auto|icon"}`），重启后保持。
在图标模式下想切回来：划词 → 点小图标 → 卡片出现 → 点 ⚡。

> 取词发生在**亮图标之前**（不是点击时）：所以拖动窗口/滚动条这类"没选出文字"的手势不会弹图标，
> 点击时也不必再读一次选区。这一条与 `设计文档.md` §4.3 的写法不同，是有意的（见交接文档 §5）。

## 自检

```powershell
curl.exe -i http://127.0.0.1:19387/dsh-select-translate/api/ping    # 期望 200（路由刻意挂在 /api 栅栏之外）
curl.exe -i http://127.0.0.1:19387/api/dsh-select-translate/ping    # 期望 401（对照：/api 被 Connection 鉴权栅栏占着）
```

## 怎么跑测试

```powershell
cd dsh-select-translate
pnpm test            # 等价于 node --test "test/**/*.test.mjs"
```

**零依赖**：只用内置 `node:test`，不需要 DSH、不需要 koffi、不需要真实窗口或 Windows 桌面。
当前共 **139 个**测试。

| 测试文件 | 钉住的东西 |
|---|---|
| `test/gesture.test.mjs` | 拖选 5px / 双击 420ms·6px 阈值、最大位移判定、`onPress` 时机、取词 latest-wins 串行队列 |
| `test/text-layout.test.mjs` | **换行**（交接文档 §6 第 11–15 条）：每行容量、行首禁则、CJK 合并成整行绘制、省略号余量、`dryRun` 与真画高度一致 |
| `test/card-layout.test.mjs` | 卡片几何、命中区、下拉是覆盖层（展开不改变窗口高度）、按钮净宽是 DIP 且与缩放无关 |
| `test/hitzone.test.mjs` | `HTCAPTION` 区收不到点击（按钮必须排除）、阴影外扩那圈必须穿透 |
| `test/placement.test.mjs` | 越界翻转、夹进工作区、第二块屏负坐标、125% 缩放的取整；**小图标复用同一套落位** |
| `test/trigger-icon.test.mjs` | 小图标几何（圆在窗口正中）、**方窗口四角必须穿透**、阴影/白圆/边框/globe 的绘制与 hover 配色 |
| `test/settings.test.mjs` | 设置默认值/非法值回落、坏 JSON 当没设置、落盘后新实例能读到、写不进去也不抛错 |
| `test/host.test.mjs` | 宿主 SSE 帧契约（伴生进程照它解析）、`SYSTEM_PROMPT` 字节稳定、abort、`pickEffort` 选 `off`、`maxTokensFor`、15000 字上限、`modelLimits` |
| `test/context.test.mjs` | UIA worker 超时隔离与自愈、在途请求只保留最新一次 |

`test/support/` 是脚手架，**不匹配 `*.test.mjs`**，所以不会被当测试执行：

- `metrics.mjs`：假字体度量，按伴生进程 `/measure` 的**实测值**校准
  （size 18.75 → 单字盒宽 25.552 / 8 字 160.712 ⇒ 净推进 19.309、前导边距 = size/3）
- `fake-koffi.mjs`：假 GDI+，**驱动真的 `paragraph`/`tokenize`** 跑换行逻辑
- `fake-painter.mjs`：记录型 painter，驱动真的 `paintCard`
- `echo-worker.mjs`：假 UIA worker（按落点 x 切换 正常/超时/报错）

> 为了能单测，`index.js` 导出了 `SYSTEM_PROMPT` / `targetLabel` / `pickEffort` / `handleTranslate`；
> `main.mjs` 把命中区与落位抽成了 `companion/hitzone.mjs` 与 `companion/placement.mjs`（纯函数）。
> 这些改动不影响插件加载。

### 真进程冒烟检查（改过 `companion/**` 之后跑，不必重启 DSH）

```powershell
node test/support/smoke-companion.mjs            # 常规 48 项
node test/support/smoke-companion.mjs --long     # 再追加 9 项：4000 字真翻译 + 逐帧盯窗口不被裁/跟随
```

单元测试验的是纯逻辑，这个脚本验的是**跑起来的那个伴生进程**：重启它 → 打它自己的排障端点
→ 核对命中区、落位/翻转、真实字体度量、真译文、并发划词（取消）、长文本滚动、
**小图标模式全流程**、**流式跟随与窗口不被裁**、**滚动条几何**、**宿主路由的令牌校验**。
会真的弹卡片（结束前自动 `/hide`）。前置：DSH 桌面端在跑。失败时以非 0 退出码结束，可当门禁用。

> **测试不进安装包**：`package.json` 的 `files` 白名单只含运行时代码，`npm pack` 打出来是 21 个文件，
> `test/**` 不在其中 —— 跑测试的人是"克隆仓库读源码的人"，普通用户一键安装不会下到测试。
>
> **它会花一次模型调用**（真翻译那几步），用的是**跑脚本的人自己的额度**；所以别在演示时跑。
> 脚本自身不做任何截屏、不收集数据，网络访问全部是 `127.0.0.1`（宿主与伴生进程的本地端点）。

> **一边用插件一边跑也可以**：脚本会先等一个"静默窗口"（连续 2 秒没有真实手势/外部划词/模式切换），
> 等不到就把依赖卡片状态的几节标 `⚠ 跳过` 并说明原因 —— 而不是误报一串失败。
> 它还会**记住并还原你运行前的 ⚡ 模式**（不会把你的选择覆盖成 auto）。
>
> `--long` 那几步要求**宿主已加载新版 `index.js`**：改过宿主半边就必须重启桌面端
> （禁用再启用插件也换不掉 ESM 缓存），否则会看到旧的字数上限报错。
> 「小图标模式」那一节若提示宿主还没有 `/settings` 路由，说明 `index.js` 还没重新加载；
> 它会自动退回"只验伴生进程侧"，不误报。

## 怎么看到卡片

1. **设置 → 划词翻译 → 「预览卡片」**（最省事）
2. 或在页面里**划选任意文字**：停手约 0.28 秒后，卡片出现在鼠标旁（`Esc` 关闭）

## 卡片上的两个开关

| 图标 | 含义 | 行为 |
|---|---|---|
| ⚡ | **即划即译**（默认开） | 开：划完停手即出译文。关：**改走小图标模式**（划词只亮 24px 小圆图标，点它才翻译）。开启时图标为强调色；这个开关在**系统级卡片与页内卡片上都可用**，系统级那半边的选择会持久化到 `$DSH_HOME/dsh-select-translate.json`（页内那半边仍存 localStorage） |
| 📌 | **钉住**（默认关） | 关：点别处即关。开：点别处不关、保留最新译文；**再划词时窗口原地不动，只换译文内容** |

> ⚡ 与 📌 在系统级卡片上由**伴生进程**处理（`companion/main.mjs`）；页内卡片是独立实现，两态存 localStorage。

## 为什么卡片用 portal 挂到 `document.body`

卡片最初渲染在 `shell.overlay` 里，被应用内其它窗口遮住过。原因是 `.overlayLayer` 自身
带 `z-index`，构成一个**层叠上下文**——内部 z-index 再高也压不过层外的元素。

现在用 `ReactDOM.createPortal` 把卡片挂到 `document.body` 下的直挂层
（`z-index: 2147483000`、`pointer-events:none`，卡片本体自己收回 `auto`）。
那一层是内联样式写死的，不依赖宿主 CSS 的加载顺序。

> 仍然压不过浏览器 **top-layer**（原生 `<dialog>` / `popover`）。如果将来发现某个原生弹层能盖住卡片，那是这一类。

## 系统级卡片怎么关 / 怎么取消

系统级（原生置顶）卡片和页内卡片是两套实现，交互上这几条是对齐的：

| 操作 | 行为 |
|---|---|
| **单击卡片外部** | 立刻关闭（未钉住时）。判据是"按下点是落在**卡片本体**里"——卡片窗口比本体大一圈阴影，用窗口矩形判会永远关不掉 |
| **`Esc`** | 关闭。卡片是 `WS_EX_NOACTIVATE`，**收不到键盘消息**，只能靠 40ms 轮询 `VK_ESCAPE` + 按下边沿检测。⚠️ 代价：这一下 `Esc` 也会照常传给下面的应用（没有键盘钩子就拦不住） |
| 卡片右上 **✕** | 关闭 |
| 未钉住时再划一次词 | 关掉旧的、在弹出的新位置显示新的；钉住时**原地**换内容 |
| 关闭卡片 / 新一次划词 / 点「重译」 | 都会 **abort 掉在途的模型请求**（不 abort 的话模型会跑完——用户看不到，但照常计费） |
| **滚轮**（鼠标停在卡片上） | 翻长译文。正文超过卡片上限（工作区高 60%）时能滚，没超过时滚不动 |

## 长文本

- 原文上限 **15000 字**：`companion/main.mjs` 与 `index.js` 各拦一道，**两处常量必须一致**（超过则卡片提示拒绝）。
- 输出上限按原文长度动态估算（`index.js` 的 `maxTokensFor`：下限 1024、上限 8192，系数 0.8）。
  固定值一定会出问题：**被输出上限截断时 `lastTranslate.finish` 会是 `max-tokens` 或 `length`**
  （实测 3000 字输入配 1800 上限就截断了，输出到 3723 字还没收尾）。
- 正文超过卡片上限（工作区高 60%）后用**滚轮**看（`onWheel` + 正文区裁剪）。
  右侧有一条**细滚动条**（6 宽 / 圆角 3 / `#c9cedb`）：**只在滚动或流式跟随时出现**，
  停手 0.7s 后约 0.12s 淡出（`CARD.scrollbar` 的 `holdMs`/`fadeMs`，由 40ms 轮询推进透明度）。
  页内卡片是 `client.js` 用 CSS 收细的原生滚动条，原生卡片是 `card.mjs` 自绘的同尺寸一条
  （§7 纪律：先改基准再同步）。
- **长文本也跟得上模型（合帧）**：每个 SSE delta 都同步重绘会把事件循环占满，而单帧重绘随文本变长而变贵
  （实测 1500 字 **14.8ms** / 4000 字 **19.8ms** / 8000 字 **27.8ms**，最贵 53ms）——
  于是"显示"反而成了瓶颈。现在**最多每 ~20–120ms 画一帧、永远画最新状态**，间隔按上一帧耗时自适应
  （画得贵就等久一点：显示降级，而不是把流式读取堵死）。
  实测一条 4000 字真译文：**宿主（模型）2480ms vs 我们（含显示）2487ms → 只落后 7ms**，
  期间合帧省掉 **655** 次重绘。诊断字段：`/status` 的 `paints` / `paintSkips` / `paintMs`，
  以及 `lastTranslate.hostMs`（宿主侧的模型耗时，用来和我们的 `totalMs` 对照）。
- **流式生成时视图跟随最新**：内容涨到卡片上限后，已生成的译文自动向上顶，
  **新译文始终出现在窗口最后 1–2 行**；翻译结束后**停止跟随并回到顶部**（停下来时的常态是"从译文开头读"）。
  流式中途**手动往上滚**会暂停跟随（回看已生成的部分，不被每帧拽回底部），滚回底部即恢复。
- **流式生成期间窗口不会被裁**：`onPaint` 可以返回"我该换这个尺寸"，`window.mjs` 就**丢弃这一帧、
  把窗口调到位、重画一帧再上屏**。`/status` 的 `state.resizes` 是"这样被丢弃重画的帧数"，
  等于旧实现下"底部/页脚被裁掉"的帧数（实测一次长文本流式期间 24 次）。
  ⚠️ 以前这里用 `setTimeout(0)` 异步重排，而流式读取会一直占住事件循环 → 定时器要等下一次网络读取
  才轮到 → 整个翻译过程底部都缺着，翻译一结束才补上。

## 视觉基准（重要）

`client.js`（页内卡片）是 **M1 终稿、已冻结**，它是"这张卡片长什么样"的唯一定义。

系统级那条路走 `companion/card.mjs`（GDI+ 自绘，因为要在任意应用之上置顶），
**它必须与 `client.js` 对齐**：

| 项 | 对齐方式 |
|---|---|
| 尺寸/间距/字号/圆角/配色 | 常量逐条抄 `CARD` 与 `COLOR`，与 `client.js` 的 CSS 一一对应 |
| 图标形状 | `card.mjs` 的 `ICONS` 是 16×16 坐标，**直接由 `client.js` 里 SVG 的 path 数值换算**；不另画 |
| 阴影 | CSS 的 `box-shadow` 无法 1:1：GDI+ 没有模糊原语，用多层递减透明度的圆角矩形近似 |
| `演示` 徽章 | 只属于页内假数据 Demo；原生卡片显示真实译文，**不出现**该徽章 |

> **改视觉先改 `client.js`，再同步到 `card.mjs`**，不要只改一边。

原生卡片四周给阴影留了 14 DIP 外扩，那圈半透明像素本来会吞掉点击；
`onHitTest` 在卡片矩形之外返回 `HTTRANSPARENT`，把点击交给下面的应用。

## 文件

| 文件 | 作用 |
|---|---|
| `client.js` | 客户端半边（手写，无需构建）：卡片 + 选区侦测 + 假流式 + 设置页 |
| `index.js` | 宿主半边：M1 只有一条自检路由；M2 在这里接 `ctx.llm.stream` 与伴生进程 |
| `package.json` | bundle 声明（`dsh.bundle.patch` + `dsh.client.platform: web`） |
| `cordis.patch.yml` | 插件自带的 insert 行（走 bundle 安装时用；M1 实际用的是 profile 那份） |
| `LICENSE` | 本项目许可（MIT） |
| `THIRD-PARTY-NOTICES.md` | **取词内核的上游声明与改动说明（必须随插件分发，不得删除）** |

## 来源、许可与致谢

**取词内核衍生自 [dsh-selection-tools](https://github.com/fyisgod/dsh-selection-tools)**
（作者 [@fyisgod](https://github.com/fyisgod)，MIT，`Copyright (c) 2026 dsh-selection-tools contributors`），
基于 commit `3f292d92`（v0.8.2）：

| 本仓库文件 | 与上游的关系 |
|---|---|
| `companion/win32.mjs`、`companion/gesture.mjs`、`companion/native/uia.mjs`、`companion/native/uia-worker.mjs` | **逐字节相同**（只在文件顶部加了许可头） |
| `companion/context.mjs` | 同源，少量改动（worker 统计增加 `lastError` 排障） |
| `companion/native/gdi.mjs` | 同源，较多改动（中文逐字间距、行尾省略号、行首禁则） |
| `companion/native/window.mjs` | 同源，较多改动（两趟绘制、阴影穿透、光标形状） |

其余文件（`index.js`、`settings.mjs`、`client.js`、`companion/main.mjs`、`card.mjs`、`hitzone.mjs`、
`input.mjs`、`placement.mjs`、`translate.mjs`、`test/**`）为本项目独立实现 —— 与上游最长连续逐字相同片段
只有 3–5 行（`client.js` 为 0 行）。

> MIT 要求版权与许可声明**随本软件的所有副本一起提供**，所以上游的 MIT 原文与逐文件改动说明
> 完整放在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；本项目自身同样以 MIT 发布，见 [`LICENSE`](LICENSE)。
> 感谢 @fyisgod 把 Windows 取词内核开源出来 —— 这个插件能跑起来靠的就是它。
