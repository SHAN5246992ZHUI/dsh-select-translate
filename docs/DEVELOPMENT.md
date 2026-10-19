# 开发与实现细节

面向想改代码 / 跑测试 / 深挖实现的人。产品介绍见 [README](../README.md)。

---

## 架构：两个半边

```
DSH 宿主进程                                伴生进程（Node，复用 DSH 自带 koffi）
├ 宿主半边                                   ├ 40ms 轮询全局鼠标 → 手势（拖选 / 双击）
│  · /dsh-select-translate/api/* 路由（SSE）  ├ UIA 取词（worker 线程 + 超时隔离）
│  · ctx.llm.stream 出译文                   ├ 原生分层窗口 + GDI+ 自绘卡片 / 小图标
│  · 设置读写 / 伴生进程生命周期               └ 落位翻转、DPI 换算、滚动、拖宽
└（没有客户端半边：不往 DSH 页面注入任何 UI）
```

- **宿主半边**（`index.js` / `settings.mjs`）：挂路由、调 `ctx.llm.stream`、管设置与伴生进程。
- **伴生进程**（`companion/**`）：系统级取词 + 原生卡片。由宿主 spawn，崩溃会退避重启。

> 0.1.3 起页内卡片（原 `client.js`）与「设置 → 划词翻译」页已下线：那两半只能用假数据，
> 拿不到宿主路由令牌，接不了真译文；删掉后插件是纯原生的，没有可配置项。

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半边：路由、`ctx.llm.stream`、伴生进程生命周期 |
| `settings.mjs` | 设置默认值 / 校验 / 落盘 |
| `cordis.patch.yml` | 插件自带的 insert 行（走 bundle 安装时用） |
| `companion/main.mjs` | 编排：手势 → 取词 → 翻译 → 卡片；调试端点 |
| `companion/card.mjs` | 卡片 / 小图标的布局、绘制、命中（GDI+ 自绘） |
| `companion/text.mjs` | 取词文本整理（行分隔符归一化、行内编号插回换行） |
| `companion/translate.mjs` | 宿主 SSE 的客户端：帧切分 / latest-wins / 取消 |
| `companion/native/` | UIA、GDI+、分层窗口、原生输入窗（含上游衍生的取词内核） |
| `test/` | 单元测试 + 脚手架 + 真进程冒烟脚本 |

## 改代码怎么生效

| 改什么 | 怎么生效 |
|---|---|
| `index.js` / `settings.mjs` | **必须重启桌面端**（ESM 缓存；禁用再启用插件也换不掉） |
| `companion/**` | 重启伴生进程即可：`POST /dsh-select-translate/api/system/restart` |

## 测试

```powershell
cd dsh-select-translate
pnpm test            # 等价于 node --test "test/**/*.test.mjs"
```

零依赖：只用内置 `node:test`，不需要 DSH、不需要 koffi、不需要真实 Windows 桌面。当前 **153 个**。

| 测试文件 | 钉住的东西 |
|---|---|
| `gesture.test.mjs` | 拖选 5px / 双击 420ms·6px 阈值、最大位移、`onPress` 时机、取词 latest-wins |
| `text-layout.test.mjs` | 换行：每行容量、行首禁则、CJK 合并成整行绘制、省略号余量、`dryRun` 与真画高度一致 |
| `text-normalize.test.mjs` | 取词文本整理：`\r\n`/`\r` → `\n`、PDF 压成一行时按 `(a)`/`1.`/`①` 插回换行、不误拆小数与正文括号 |
| `card-layout.test.mjs` | 卡片几何、命中区、语言菜单、可拖宽（`cardW` 夹取）、绘制回写值 |
| `hitzone.test.mjs` | `HTCAPTION` 区收不到点击（按钮必须排除）、阴影外扩必须穿透、左右内缘拖宽 |
| `placement.test.mjs` | 越界翻转、夹进工作区、第二块屏负坐标、125% 缩放取整 |
| `trigger-icon.test.mjs` | 小图标几何、方窗口四角穿透、绘制与 hover 配色 |
| `settings.test.mjs` | 设置默认值/非法值回落、坏 JSON、落盘后新实例可读 |
| `host.test.mjs` | 宿主 SSE 帧契约、提示词字节稳定、`abort`、`pickEffort`、`maxTokensFor`、15000 字上限、`normalizeTarget` |
| `context.test.mjs` | UIA worker 超时隔离与自愈、在途请求只保留最新 |

`test/support/` 是脚手架，不匹配 `*.test.mjs`，不会被当测试跑：

- `metrics.mjs`：假字体度量，按真实 `/measure` 实测值校准
- `fake-koffi.mjs`：假 GDI+，**驱动真的 `paragraph`/`tokenize`**
- `fake-painter.mjs`：记录型 painter，驱动真的 `paintCard`
- `echo-worker.mjs`：假 UIA worker（按落点 x 切换 正常 / 超时 / 报错）

### 真进程冒烟检查

```powershell
node test/support/smoke-companion.mjs            # 常规
node test/support/smoke-companion.mjs --long     # 追加 4000 字真翻译 + 逐帧盯窗口不被裁
```

验的是**跑起来的那个伴生进程**：重启它 → 打它的排障端点 → 核对命中区、落位/翻转、真实字体度量、
真译文、并发划词（取消）、长文本滚动、小图标模式全流程、流式跟随、滚动条几何、宿主路由令牌校验。

- 会真的弹卡片（结束前自动 `/hide`）
- **会花一次模型调用**（真翻译那几步），用跑脚本的人自己的额度
- 一边用插件一边跑也可以：脚本等"静默窗口"，等不到就把脆弱几节标 `⚠ 跳过`，并会还原你运行前的 ⚡ 模式
- `--long` 要求宿主已加载新版 `index.js`

## 视觉基准

视觉规格存档在 [`card-visual-baseline.md`](card-visual-baseline.md)：卡片 / 小图标的尺寸、间距、字号、圆角、配色，
以及图标的 16 单位画布几何（原先由页内卡片定义；0.1.3 起那份页面脚本已下线）。

实现是 `companion/card.mjs` 的 `CARD` / `COLOR` / `TRIGGER` 常量；改视觉时与存档、`docs/*.png` 三张成品截图一起对。

两个不能 1:1 的地方：

- **阴影**：CSS `box-shadow` 没有对应原语，GDI+ 用多层递减透明度的圆角矩形近似。
- **分层窗口的命中**：卡片四周给阴影留了 14 DIP 外扩，那圈半透明像素会吞点击 —— `onHitTest` 在卡片矩形外返回 `HTTRANSPARENT`，把点击交还给下面的应用。

## 长文本是怎么扛住的

- **窗口不被裁（两趟绘制）**：`onPaint` 可以返回"我该换的矩形"，窗口层就**丢弃这一帧**、把窗口调到位、重画一帧再上屏。不用 `setTimeout(0)` 异步重排——流式读取会占住事件循环，那个定时器要等下一次网络读取才轮到。
- **显示不拖慢模型（合帧）**：同一时刻只排一帧、永远画最新状态，间隔按上一帧耗时自适应（约 20–120ms）。实测一条 4000 字真译文：宿主（模型）2480ms vs 端到端 2487ms，只落后 7ms。
- **流式跟随**：内容涨到卡片上限后视图钉在底部，新译文出现在最后 1–2 行；翻译结束回到顶部；中途手动上滚暂停跟随。
- **输出上限按长度估算**：`maxTokensFor`（1024–8192，系数 0.8）。固定值会被截断——截断时 `finish` 是 `max-tokens` / `length`。

## 本机接口与令牌

插件在 `127.0.0.1` 上有一个内部 HTTP 口（宿主的 `/dsh-select-translate/api/*` 与伴生进程的随机端口），
用于宿主 ↔ 伴生进程传选区与译文。

- 宿主路由挂在 DSH 的 `/api` 鉴权栅栏之外，所以除 `/ping` 外都要求请求头 `x-dsh-select-translate-token`（每次启动随机生成）。
- **为什么能挡住网页**：带自定义头的跨源请求会先触发 CORS 预检，而本插件从不回 CORS 头，浏览器根本不会把请求发出去。
- **边界**：能扫本机端口、能读文件的本地进程仍然拿得到令牌（运行时文件里有）。这道锁防的是网页与顺手一发的脚本，不是同用户的恶意程序。

排障端点（伴生进程自己的端口，**不走 Web 载体**）：`GET /status`、`POST /simulate`、`POST /probe`、
`POST /diagnose`、`POST /measure`、`POST /scroll`、`POST /hittest`、`POST /where` 等。
端口与令牌在运行时文件 `$DSH_HOME/dsh-select-translate-runtime.json` 里。

## 开发时怎么装

M1 起用的是 **profile 用户 patch 层**，而不是 `plugin_manager install_bundle`：

```
%DSH_HOME%\profiles\desktop\cordis.patch.yml   ← 末尾新增 insert: dsh-select-translate
%DSH_HOME%\profiles\desktop\node_modules\dsh-select-translate  ← 指向本目录的 junction
```

装了之后热生效，不用重启桌面端。注意：

- junction 不在 lockfile 记录里，跑 `pnpm install` 可能被清掉；被清掉后重新建 junction 即可。
- **自测"市场安装"之前先卸掉 junction 版本**，否则同一个插件会有两条 loader 条目。

卸载：删掉 patch 里那段 `- insert: … dsh-select-translate`，或把 `id:` 那行改成 `disabled: true`。

## 生效与自检

```powershell
# 路由是否在（期望 200）
curl.exe -i http://127.0.0.1:19387/dsh-select-translate/api/ping
# 对照：/api 前缀被宿主鉴权栅栏占着（期望 401）
curl.exe -i http://127.0.0.1:19387/api/dsh-select-translate/ping
```

> ⚠️ Web 端口以实际为准（桌面端可能是别的端口，运行时文件里的 `origin` 才是权威值）。

## 实现里踩过的坑（改这块之前值得看）

1. **绝不 `import '@deepseek-ai/*'`**：宿主与磁盘回退包是两份拷贝，`Service` 身份会跨副本失效。
2. 宿主半边改代码必须**重启桌面端**（ESM 缓存，禁用再启用也换不掉）。
3. `WM_NCHITTEST` 返回 `HTCAPTION` 的区域**永远收不到 `WM_LBUTTONDOWN`** → 按钮必须从标题栏区排除。
4. 类光标是 `null`，`DefWindowProc` 不会复位 → 所有情况都要显式 `SetCursor`。
5. 分层窗口四周阴影外扩的那圈半透明像素**会吞点击** → 卡片矩形之外返回 `HTTRANSPARENT`。
6. `MeasureString` 返回的是"布局盒"，多算一份前导边距；真实推进量要用 `(measure('中'×8) − measure('中')) / 7` 标定。
7. CJK 在 tokenize 里逐字成 token（为了逐字断行），但**绘制时必须合并成整行**，否则中文看着像字间插了空格。
8. 换行边界要**真去量整行**，不能靠逐 token 累加（相邻字形边距会重复计入）。
9. **UIA 的行分隔符是 `\r`**，而排版只认 `\n`；PDF 文字层甚至会把整段交成一行（连空格都丢）→ `companion/text.mjs` 做归一化并按行内编号插回换行。
10. 卡片是 `WS_EX_NOACTIVATE`，**收不到键盘消息**：`Esc` 靠 40ms 轮询边沿检测；"输入自定义语种"必须另开一个可激活窗口。
11. 真流式的节奏由模型决定，**可能一口气返回**——要稳定验证流式中间态，用 `POST /simulate {fake:true, …}` 的假流式。
12. 长文本测试的输入必须**多样**：同一句话重复会让模型复读、撞输出上限，导致"没被截断"的检查假失败。

## 来源与许可

取词内核衍生自 [dsh-selection-tools](https://github.com/fyisgod/dsh-selection-tools)（MIT，`Copyright (c) 2026 dsh-selection-tools contributors`），基于 commit `3f292d92`（v0.8.2）：

| 本仓库文件 | 与上游的关系 |
|---|---|
| `companion/win32.mjs`、`companion/gesture.mjs`、`companion/native/uia.mjs`、`companion/native/uia-worker.mjs` | 逐字节相同（只在文件顶部加了许可头） |
| `companion/context.mjs` | 同源，少量改动（worker 统计增加 `lastError` 排障） |
| `companion/native/gdi.mjs` | 同源，较多改动（中文逐字间距、行尾省略号、行首禁则） |
| `companion/native/window.mjs` | 同源，较多改动（两趟绘制、阴影穿透、光标形状、可缩放） |

其余文件为本项目独立实现。上游 MIT 原文与逐文件改动说明见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)，
本项目以 MIT 发布，见 [LICENSE](../LICENSE)。
