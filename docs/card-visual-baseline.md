# 卡片视觉基准（存档）

> **0.1.3 起插件改成纯原生**：页内卡片（原 `client.js`）和「设置 → 划词翻译」页已下线，`client.js`
> 不再随包分发。这份文件保留它当年的 CSS / 几何 / 图标规格，作为**原生卡片改视觉时的对照基准**。
>
> 现在真正的实现是 `companion/card.mjs` 的 `CARD` / `COLOR` / `TRIGGER` 常量；改视觉时与本文、
> `docs/card-translation.png`、`docs/streaming-follow.png`、`docs/icon-mode.png` 三张成品截图一起对。

## 卡片

| 项 | 值 |
|---|---|
| 宽度 | 380 DIP（拖两侧可调 300–900） |
| 圆角 / 边框 | 12 / 1px `#e5e9f0` |
| 头部 | 高 44，内边距 左 10 / 右 8 |
| 正文 | 15px / 行高 1.65（原生按 25 DIP 行高）；内边距 15 18 |
| 页脚 | 高 40，内边距 0 8；按钮间距 4，按钮内边距 0 10、高 28 |
| 图标盒 | 28×28，圆角 8 |
| 语言下拉 | top 40 / left 10 / 最小宽 128 / 行高 30 / 内边距 4 / 圆角 10 |
| 强调色 | `#4d6bfe` |
| 正文色 / 次要 / 弱 | `#1f2329` / `#677183` / `#8a94a6` |
| 细滚动条 | 6 宽、圆角 3、`#c9cedb`（原生自绘，`CARD.scrollbar`） |
| 阴影 | `0 16px 40px rgba(16,27,50,.16), 0 2px 8px rgba(16,27,50,.06)`（原生化成 14 DIP 外扩的多层近似） |

原 `client.js` 的卡片 CSS（`.hc-badge` 是页内演示徽章、`.hc-set` 是设置页，均未用于原生）：

```css
.hc-root { pointer-events: none; }

.hc-card {
  position: fixed; display: flex; flex-direction: column; overflow: hidden;
  width: 380px; max-width: calc(100vw - 16px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #ffffff));
  color: var(--dsw-alias-label-primary, #1f2329);
  --hc-muted: var(--dsw-alias-label-tertiary, #8a94a6);
  --hc-subtle: var(--dsw-alias-label-secondary, #677183);
  --hc-accent: #4d6bfe;
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(16, 27, 50, .16), 0 2px 8px rgba(16, 27, 50, .06);
  pointer-events: auto;
  font-size: 14px; line-height: 1.6;
  animation: hc-in .14s ease-out;
}
@keyframes hc-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

.hc-head {
  display: flex; align-items: center; gap: 2px; flex: 0 0 auto;
  height: 44px; padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e9f0);
}
.hc-title {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px; border: 0; border-radius: 8px;
  background: transparent; color: var(--hc-subtle);
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
}
.hc-title:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); color: var(--dsw-alias-label-primary, #1f2329); }
.hc-title .hc-sub { color: var(--hc-muted); font-weight: 400; }
.hc-spacer { flex: 1 1 auto; }
.hc-div { width: 1px; height: 16px; margin: 0 4px; background: var(--dsw-alias-border-l1, #e5e9f0); }

.hc-icon {
  display: inline-grid; place-items: center; flex: 0 0 auto;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--hc-muted); cursor: pointer;
  transition: color .12s, background .12s;
}
.hc-icon:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); color: var(--hc-subtle); }
.hc-icon[data-on="true"] { color: var(--hc-accent); background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); }

.hc-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 15px 18px;
  font-size: 15px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
  user-select: text;
  scrollbar-width: thin;
  scrollbar-color: var(--hc-scroll, #c9cedb) transparent;
}
.hc-body::-webkit-scrollbar { width: 6px; height: 6px; }
.hc-body::-webkit-scrollbar-track { background: transparent; }
.hc-body::-webkit-scrollbar-thumb { background: var(--hc-scroll, #c9cedb); border-radius: 3px; }
.hc-body::-webkit-scrollbar-thumb:hover { background: var(--hc-muted, #8a94a6); }
.hc-body.is-empty { color: var(--dsw-alias-label-secondary, #677183); font-size: 14px; }
.hc-caret {
  display: inline-block; width: 2px; height: 1em; margin-left: 2px;
  vertical-align: -2px; background: var(--hc-accent, #4d6bfe);
  animation: hc-blink 1s steps(2, start) infinite;
}
@keyframes hc-blink { 50% { opacity: 0; } }

.hc-foot {
  display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
  height: 40px; padding: 0 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e9f0);
}
.hc-act {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, #677183);
  font: inherit; font-size: 12px; cursor: pointer;
}
.hc-act:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); color: var(--dsw-alias-label-primary, #1f2329); }
.hc-act:disabled { opacity: .45; cursor: default; }

.hc-langs {
  position: absolute; top: 40px; left: 10px; z-index: 1;
  min-width: 128px; padding: 4px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #ffffff));
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0); border-radius: 10px;
  box-shadow: 0 12px 28px rgba(16, 27, 50, .16);
}
.hc-lang {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; height: 30px; padding: 0 8px; border: 0; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; text-align: left;
}
.hc-lang:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); }
.hc-lang[data-on="true"] { color: var(--hc-accent, #4d6bfe); }
```

## 划词小图标

24×24 圆 / 1px `#e5e9f0` / 白底 / globe 14 / hover 转 `#4d6bfe` / 锚点右下 12 DIP。
原生窗口是方的：**圆外（含四角）必须 `HTTRANSPARENT` 穿透**，否则会吞掉下面应用的点击。

```css
.hc-mini {
  position: fixed; display: grid; place-items: center;
  width: 24px; height: 24px; padding: 0;
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0); border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #ffffff));
  color: var(--dsw-alias-label-secondary, #677183);
  box-shadow: 0 6px 16px rgba(16, 27, 50, .18);
  pointer-events: auto; cursor: pointer;
  animation: hc-in .12s ease-out;
}
.hc-mini:hover { color: var(--dsw-alias-brand-primary, #4d6bfe); border-color: currentColor; }
```

> 原生小图标没有 120ms 淡入（GDI+ 没有合成动画），属有意的差异。

## 图标

统一 16×16 画布，`stroke: currentColor`、`stroke-width: 1.5`、`linecap/linejoin: round`。
原生 `card.mjs` 的 `ICONS` 按 `size / 16` 换算（椭圆写 `[left, top, width, height]`）。

| 名称 | 几何 |
|---|---|
| globe | `circle(8,8,r6)` + `M2 8h12` + `M8 2c1.7 2 1.7 10 0 12M8 2c-1.7 2-1.7 10 0 12` |
| caret | `m4.5 6.5 3.5 3.5 3.5-3.5` |
| close | `M4.5 4.5l7 7M11.5 4.5l-7 7` |
| copy | `rect(5.5,5.5,8,8,rx2)` + `M10.5 5.5v-1a2 2 0 0 0-2-2h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1` |
| retry | `M13 8a5 5 0 1 1-1.6-3.68` + `M13.5 3v3h-3` |
| check | `m3.5 8.5 3 3 6-7` |
| bolt | `M9.5 1.5 3.6 9h4.1l-1.2 5.5L13 7H8.9z` |
| pin | `M6.5 1.5h3` + `M5.6 3.5h4.8v3.2l1.5 2H4.1l1.5-2z` + `M8 8.7V14.3` |

## 两处原生不能 1:1 的地方

- **阴影**：CSS `box-shadow` 没有对应原语，GDI+ 用多层递减透明度的圆角矩形近似。
- **命中**：分层窗口四周给阴影留了 14 DIP 外扩，那圈半透明像素会吞点击 —— `onHitTest` 在卡片矩形外返回 `HTTRANSPARENT`，把点击交还给下面的应用。

## 为什么删掉页内卡片

页内卡片只能用假数据：它跑在 DSH 渲染进程里，拿不到宿主路由的令牌，接不了 `ctx.llm.stream`；
而「设置 → 划词翻译」页也没有任何真实配置项。0.1.3 起两半一起下线，插件只保留
**宿主路由 + 原生伴生进程**，触发方式与目标语言都在卡片头部调整。
