# 第三方组件与许可声明（Third-Party Notices）

本插件的**取词内核**衍生自下面这个 MIT 项目。

> MIT 许可要求：「上述版权声明与本许可声明应包含在本软件的所有副本或实质性部分中。」
> 因此**本文件必须随插件一起分发，不得删除**。它也随 npm 包发布（见 `package.json` 的 `files`）。

---

## 1. dsh-selection-tools

| 项 | 值 |
|---|---|
| 项目 | `dsh-selection-tools`（作者 [@fyisgod](https://github.com/fyisgod)） |
| 仓库 | https://github.com/fyisgod/dsh-selection-tools |
| 采用的版本 | commit `3f292d92c5686c2650cc22b6936cba18bb96d425`（package version `0.8.2`） |
| 许可 | MIT |
| 上游版权行 | `Copyright (c) 2026 dsh-selection-tools contributors` |

### 1.1 本项目中衍生自它的文件（7 个）

| 本仓库文件 | 与上游的关系 | 我们做的改动 |
|---|---|---|
| `companion/win32.mjs` | **逐字节相同** | 无（仅在本文件顶部加许可头） |
| `companion/gesture.mjs` | **逐字节相同** | 无（顶部加许可头；另外修掉两处指向上游 `companion/policy.mjs` 的过期注释——那个文件本项目没有） |
| `companion/native/uia.mjs` | **逐字节相同** | 无（仅顶部加许可头） |
| `companion/native/uia-worker.mjs` | **逐字节相同** | 无（仅顶部加许可头） |
| `companion/context.mjs` | 同源，少量改动 | worker 统计里增加 `lastError`：UIA 初始化失败原来会被静默吞成"读不到选区"，现在留一份给 `/status` 排障 |
| `companion/native/gdi.mjs` | 同源，较多改动 | 文本渲染三处：① 连续同格式 token 合成一次 `DrawString`（中文逐字 `DrawString` 会被重复计入字形边距，看起来像字间插了空格）；② 绘制矩形多给一个 em（否则行尾会冒出省略号"…"）；③ 新增行首禁则 `NO_LINE_START`（句末标点不挤到行首） |
| `companion/native/window.mjs` | 同源，较多改动 | ① **两趟绘制**：`onPaint` 可返回"该换的矩形"，第一帧丢弃不上屏、调好窗口再画第二帧（长文本流式增长时窗口比内容矮会把底部裁掉）；② 阴影外圈返回 `HTTRANSPARENT` 穿透（不然那圈半透明像素会吞点击）；③ 光标形状（`sizeAll` / `arrow`）与 `hitZone` 状态；④ **可缩放**：`maxSize` 与 `WM_ENTERSIZEMOVE` + `onSizing` 回调（拖两侧改卡片宽度） |

### 1.2 本项目中**不是**衍生自它的部分

其余文件为本项目独立实现：

`index.js`、`settings.mjs`、`client.js`、`companion/main.mjs`、`companion/card.mjs`、
`companion/hitzone.mjs`、`companion/input.mjs`、`companion/placement.mjs`、`companion/translate.mjs`、`test/**`。

判定依据（逐行与块级比对）：这些文件与上游**最长连续逐字相同片段只有 3–5 行**
（`client.js` 为 **0 行**），且都是 `}` / `})()` 这类格式巧合，不存在整段沿用。

### 1.3 上游许可原文（MIT）

```
MIT License

Copyright (c) 2026 dsh-selection-tools contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 本项目自身的许可

除 1.1 列出的衍生文件外，本插件其余代码同样以 **MIT** 发布，见 `LICENSE`。
两者兼容：MIT 允许再许可与再分发，唯一条件是保留上面的版权与许可声明——本文件即为此而存在。

## 3. 维护须知

- **不要删除本文件**，也不要在 `package.json` 的 `files` 里把它排除掉。
- 以后再从上游同步代码时，请在 1.1 表格里更新「与上游的关系 / 我们做的改动」两列。
- 上游若是升级到新的 commit，请同时更新 1 的「采用的版本」。
