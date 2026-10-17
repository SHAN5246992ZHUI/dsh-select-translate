<div align="center">

<h1>划词翻译</h1>

<p><b>在任意 Windows 应用里选中文字 —— 译文就在鼠标旁出现。</b></p>

<p>不切窗口、不复制粘贴、不留记录。</p>

<p>
  <a href="https://www.npmjs.com/package/dsh-select-translate"><img src="https://img.shields.io/npm/v/dsh-select-translate?color=4d6bfe&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/dsh-select-translate"><img src="https://img.shields.io/npm/dw/dsh-select-translate?color=4d6bfe" alt="downloads"></a>
  <a href="https://github.com/SHAN5246992ZHUI/dsh-select-translate/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-select-translate?color=4d6bfe" alt="license"></a>
  <img src="https://img.shields.io/badge/platform-Windows-4d6bfe" alt="platform">
  <a href="https://awesome-dsh-plugin.com/p/SHAN5246992ZHUI/dsh-select-translate/"><img src="https://img.shields.io/badge/DSH-plugin-4d6bfe" alt="DSH plugin"></a>
</p>

<img src="https://raw.githubusercontent.com/SHAN5246992ZHUI/dsh-select-translate/main/docs/card-translation.png" width="460" alt="划词翻译卡片">

</div>

## ✨ 它好在哪

- **即划即译** —— 选中、松手，卡片就出现在鼠标旁，首字实测 **0.3–0.7 秒**。
- **绝不打断你** —— 原生置顶卡片，**不抢焦点**：原文选区不会消失，边看边译、还能继续操作下面的应用。
- **长文也跟得上** —— 单次 **15000 字**。译文边流边显示，卡片自动跟着最新一行；想回看就滚轮，右侧细滚动条随滚动淡入。
- **保留原文结构** —— 分段、编号列表原样保留；PDF 里被文字层压成一整行的题目，也会按 `(a)` `1.` `①` 重新分条。
- **卡片随你调** —— 拖左右边缘即可改宽度，正文自动重排；也能切成**小图标模式**，点一下才翻译。
- **想译成什么就什么** —— 自动 / 中文 / English，或**自定义任意语种**（日本語、한국어、Français…）。
- **零依赖、零构建** —— 不装原生模块、不跑构建脚本，复用 DSH 自带的能力。

## 🚀 安装

**最简单**：DSH 桌面端 → 设置 → 插件市场 → 搜「划词翻译」→ 一键安装。
（本插件已被 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/SHAN5246992ZHUI/dsh-select-translate/) 收录。）

命令行安装：

```powershell
dsh plugin --profile web add dsh-select-translate
```

也可以从源码装：

```powershell
dsh plugin --profile web add github:SHAN5246992ZHUI/dsh-select-translate
```

> 装完**重启 DSH**（宿主半边不会热加载）。已发布到 npm：[`dsh-select-translate`](https://www.npmjs.com/package/dsh-select-translate)。
> 卸载：市场里点卸载，或 `dsh plugin remove dsh-select-translate`。

## 🖱 怎么用

| 操作 | 效果 |
|---|---|
| **划词** | 鼠标旁弹出卡片，译文流式出现 |
| 拖卡片**左右边缘** | 改卡片宽度（300–900），正文自动重排 |
| **滚轮** | 翻长译文 |
| `Esc` / 点卡片外 / ✕ | 关闭，并**中断在途请求** |
| 头部 **⚡** | 即划即译 ↔ 小图标模式（选择会记住） |
| 头部 **📌** | 钉住：点外面不关；再划词时原地换内容 |
| 头部 **翻译 ⌄** | 目标语言：自动 / 中文 / English / 自定义… |
| 页脚 **复制 / 重译** | 复制译文 / 用同一段原文再译一次 |

选「自动」时，卡片头部会显示判定结果（例如 `自动·中文`），不用猜。

## 🖼 两种触发方式

| 模式 | 行为 |
|---|---|
| **即划即译**（默认） | 划词停手就直接出卡片和译文 |
| **小图标** | 划词停手只亮一个 24px 小圆图标，**点它才翻译**；移开鼠标 / `Esc` / 点别处即收起 |

<img src="https://raw.githubusercontent.com/SHAN5246992ZHUI/dsh-select-translate/main/docs/icon-mode.png" width="520" alt="小图标模式">

## 📏 长文本

超过卡片高度后，视图跟着新译文往上顶——**最新一行永远在窗口里**，翻译结束回到开头；中途往上滚会暂停跟随，滚回底部恢复。

<img src="https://raw.githubusercontent.com/SHAN5246992ZHUI/dsh-select-translate/main/docs/streaming-follow.png" width="320" alt="流式跟随">

## 🔒 隐私

- 选中的文字只经 **DSH 宿主**发给**你自己配置的模型**，不经过任何第三方服务。
- **不落盘**：原文和译文都不写文件、不进会话日志、不进侧栏。伴生进程只在内存里留最近一次取词结果，重启即失。
- **取词完全不碰剪贴板**；剪贴板只在**你点「复制」**时被写入。
- 写盘只有两个小文件：触发模式设置 `$DSH_HOME/dsh-select-translate.json`，以及给本机排障工具用的运行时文件。
- 本机内部 HTTP 口需要随机令牌；带自定义头的跨源请求会被 CORS 预检挡在浏览器侧。

## ⚠️ 适用范围与已知限制

- **仅 Windows**。非 Windows 上插件会主动跳过加载，不会影响 DSH 启动。
- 需要 **DSH 桌面端**（纯 Web 端没有原生窗口）。
- **以管理员权限运行的应用取不到词**（Windows UIPI 限制），这是预期行为，不是故障。
- 取词走 UI Automation，**WPS / Office 不在支持范围**——取不到就安静地不弹。
- 单次原文上限 **15000 字**。

## ❓ 常见问题

<details>
<summary><b>会消耗我的模型额度吗？</b></summary>

会。每次划词都是一次真实的模型调用，走你自己在 DSH 里配置的模型。关卡片、再划词、点「重译」都会取消在途请求，避免白跑。
</details>

<details>
<summary><b>用的是哪个翻译模型？</b></summary>

跟着 DSH 当前的默认模型座走，可以在 DSH 设置里换成别的模型。
</details>

<details>
<summary><b>为什么在有些窗口里划词没反应？</b></summary>

目标应用没有向 UI Automation 暴露文本，或者它是以管理员权限运行的。WPS / Office 属于已知不支持的范围。
</details>

<details>
<summary><b>卡片为什么不抢焦点，还能不能打字？</b></summary>

卡片是原生分层窗口且刻意不激活，所以不会打断你。需要输入时（自定义语种）会另开一个小输入框，支持中文输入法。
</details>

<details>
<summary><b>页内卡片和系统级卡片有什么区别？</b></summary>

系统级卡片是真正置顶在所有应用之上的原生窗口；页内卡片是 DSH 页面里的预览/兜底路径。两者交互对齐。
</details>

## 🛠 开发

想改代码、跑测试、看实现细节，见 **[docs/DEVELOPMENT.md](https://github.com/SHAN5246992ZHUI/dsh-select-translate/blob/main/docs/DEVELOPMENT.md)**。

- 纯 JS，无构建步骤
- 单测 **153 个**（零依赖，`pnpm test`）
- 真进程冒烟检查覆盖取词、落位、真译文、长文本、小图标模式

## 📄 许可与致谢

本项目以 **MIT** 发布，见 [LICENSE](https://github.com/SHAN5246992ZHUI/dsh-select-translate/blob/main/LICENSE)。

取词内核衍生自 [dsh-selection-tools](https://github.com/fyisgod/dsh-selection-tools)（作者 [@fyisgod](https://github.com/fyisgod)，MIT）。
上游的许可原文与逐文件改动说明在 [THIRD-PARTY-NOTICES.md](https://github.com/SHAN5246992ZHUI/dsh-select-translate/blob/main/THIRD-PARTY-NOTICES.md)——

**感谢 @fyisgod 把这套 Windows 取词内核开源出来，这个插件能跑起来靠的就是它。**
