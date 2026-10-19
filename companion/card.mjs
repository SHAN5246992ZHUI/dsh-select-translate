/**
 * 原生卡片的布局、绘制与命中（GDI+ 自绘）。
 *
 * ⚠️ 本文件的视觉基准是 `docs/card-visual-baseline.md`（M1 终稿页内卡片的存档；页面脚本 0.1.3 起已下线）。
 * 所有几何常量、颜色、字号都与它逐条对齐；图标不是"另画一个"，而是把
 * M1 那些 SVG path 的坐标**按 16 单位画布 1:1 换算**过来，保证形状一致。
 *
 * 两条与 M1 一致、但容易写错的规则：
 *  1. 命中区**贴着内容**。按钮的可点范围就是"padding + 内容 + padding"，
 *     右边不许多出一截——否则一排按钮看起来就是"间距过大"。
 *  2. 下拉菜单是**覆盖层**，展开不改变窗口高度（卡片最小高度本来就容得下菜单）。
 *
 * 唯一无法 1:1 的是 CSS 的 `box-shadow`（GDI+ 没有模糊原语）：这里用多层
 * 递减透明度的圆角矩形叠出近似的柔光阴影（见 paintShadow）。
 *
 * 所有尺寸都用 DIP 写，绘制时统一乘 `s`（显示器缩放）→ painter 收物理像素。
 */

import { normalizeLineBreaks } from './text.mjs'

export const CARD = {
  width: 380, // 卡片本宽（不含阴影外扩）—— 用户拖两侧后由 `m.cardW` / 窗口实际宽度覆盖
  minWidth: 300, // 拖窄的下限（再窄正文一行放不下几个字）
  maxWidth: 900, // 拖宽的上限（再宽只是把行拉长，反而难读）
  radius: 12,
  headerH: 44,
  footerH: 40,
  padX: 18,
  padY: 15,
  bodyFont: 15,
  bodyLine: 25, // 15 * 1.65
  titleFont: 13,
  iconBox: 28,
  iconGap: 2,
  iconSize: 15,
  actionFont: 12,
  dividerH: 16,
  edge: 8,
  shadow: 14, // 四周留给阴影的外扩（窗口比卡片大这么多）
  shadowOffsetY: 4,
  // 头部：与 视觉基准 的 .hc-title（padding 0 8px / gap 6px）对齐
  headPadX: 8,
  headGap: 6,
  caretSize: 14,
  // 页脚按钮：与 视觉基准 的 .hc-act（padding 0 10px / gap 6px）+ .hc-foot（gap 4px）对齐
  actionPadX: 10,
  actionGap: 6,
  actionFootGap: 4,
  // 语言下拉：与 视觉基准 的 .hc-langs 对齐（top 40 / left 10 / 宽 128 / 行高 30 / 内边距 4）
  langTop: 40,
  langLeft: 10,
  langWidth: 128,
  langRowH: 30,
  langPad: 4,
  // 命中宽度的初值：真实值由 paintCard 量出来后回写（首帧用这些，不影响窗口尺寸）
  langW: 115,
  copyW: 65,
  retryW: 65,
  /**
   * 正文右侧的细滚动条（**只在滚动 / 流式跟随期间出现**，带淡入淡出）。
   * 与 `docs/card-visual-baseline.md` 的 `.hc-body::-webkit-scrollbar` 对齐：6 宽、圆角 3、`#c9cedb`。
   * 页面那半边已下线（存档里是浏览器原生滚动条 + CSS 收细），这里自绘一条同尺寸的。
   * `holdMs` = 停手后再显示多久；`fadeMs` = 淡入/淡出时长（40ms 一轮询 → 约 3 步）。
   */
  scrollbar: { width: 6, inset: 1, padY: 3, minHeight: 24, radius: 3, color: 0xff_c9_ce_db, holdMs: 700, fadeMs: 120 },
}

const COLOR = {
  bg: 0xff_ff_ff_ff,
  border: 0xff_e5_e9_f0,
  text: 0xff_1f_23_29,
  muted: 0xff_8a_94_a6,
  subtle: 0xff_67_71_83,
  accent: 0xff_4d_6b_fe,
  hover: 0x10_1f_23_29,
  error: 0xff_d8_4a_4a,
  shadow: 0xff_10_1b_32,
}

/** 语言下拉的顺序与显示名（与 视觉基准 的 LANGS 一致；`custom` 是"输入自定义语种"那一行）。 */
export const LANG_IDS = ['auto', 'zh', 'en', 'custom']
export const LANG_LABELS = { auto: '自动', zh: '中文', en: 'English', custom: '自定义…' }

/**
 * 头部显示的目标语言文案。
 *  - 预设：中文 / English；
 *  - **自动**：宿主把判定结果随 `start` 帧回传（`data.resolved`），显示成「自动·中文」，
 *    不然用户永远不知道"自动"到底译成什么语言；
 *  - **自定义语种**：`target` 本身就是用户填的语言名，直接显示（截断到 8 字，别把头部撑爆）。
 */
function targetText(data) {
  const target = data.target
  if (target === 'zh') return '中文'
  if (target === 'en') return 'English'
  if (target !== 'auto' && target !== undefined && target !== null) return String(target).slice(0, 8)
  if (data.resolved === 'zh') return '自动·中文'
  if (data.resolved === 'en') return '自动·English'
  return '自动'
}

/**
 * 划词小图标（第二个触发模式用）。逐条对齐 `docs/card-visual-baseline.md` 的 `.hc-mini`：
 * 24×24 圆、1px 边框、白底、`#677183` 的 globe（14px）、hover 转强调色、
 * `0 6px 16px rgba(16,27,50,.18)` 阴影、锚点右下 12px。
 *
 * 两处**有意的**不一致（写在这里，免得以后被当成 bug）：
 *  - **没有 120ms 淡入动画**：GDI+ 没有合成动画，为一个淡入加一套定时器重绘循环不划算；
 *  - 阴影用**分层递减透明度的圆**近似 CSS 的模糊阴影（卡片那套是同一手法，见 paintShadow）。
 */
export const TRIGGER = {
  size: 24, // 圆直径（.hc-mini 的 width/height）
  border: 1, // 1px 边框
  glyph: 14, // 里头的 globe 尺寸（h(Icon,{size:14})）
  gap: 12, // 锚点右下偏移（与卡片的 ANCHOR_GAP 一致）
  shadow: 10, // 四周留给阴影的外扩
  shadowOffsetY: 3, // 阴影下移（CSS 是 0 6px 16px）
  /** 鼠标离锚点超过这么多 DIP 就收起图标（"鼠标移开即消失"）。 */
  dismissDistance: 64,
}

/** 图标窗口尺寸（含阴影外扩）。 */
export const TRIGGER_WINDOW = TRIGGER.size + TRIGGER.shadow * 2

/**
 * 图标窗口的布局。圆在窗口正中（四周那圈是阴影外扩）。
 * @returns `{ windowW, windowH, circle }`（DIP，含阴影外扩）。
 */
export function triggerIconLayout() {
  return {
    windowW: TRIGGER_WINDOW,
    windowH: TRIGGER_WINDOW,
    circle: { x: TRIGGER.shadow, y: TRIGGER.shadow, w: TRIGGER.size, h: TRIGGER.size },
  }
}

/**
 * 图标窗口的命中测试（窗口内 DIP 坐标）。
 * 圆内才是可点区，圆外那圈（含阴影）返回 `transparent` —— 让点击穿透，别吞掉下面的应用。
 * @returns `'client' | 'transparent'`（与 `hitzone.mjs` 的取值同义）。
 */
export function triggerIconHit(dipX, dipY) {
  const circle = triggerIconLayout().circle
  const radius = circle.w / 2
  const dx = dipX - (circle.x + radius)
  const dy = dipY - (circle.y + radius)
  return dx * dx + dy * dy <= radius * radius ? 'client' : 'transparent'
}

/** 画那张小图标（阴影 → 白圆 → 边框 → globe）。 */
export function paintTriggerIcon(painter, width, height, data, s) {
  const layout = triggerIconLayout()
  const circle = {
    x: layout.circle.x * s,
    y: layout.circle.y * s,
    w: layout.circle.w * s,
    h: layout.circle.h * s,
  }

  // 阴影：多层递减透明度的圆近似 `0 6px 16px rgba(16,27,50,.18)`
  const spread = TRIGGER.shadow * s
  const offset = TRIGGER.shadowOffsetY * s
  const steps = 8
  for (let i = steps; i >= 1; i--) {
    const grow = (spread * i) / steps
    const alpha = Math.round(18 * Math.pow(1 - i / (steps + 1), 1.6))
    if (alpha <= 0) continue
    painter.fillCircle(
      circle.x - grow,
      circle.y - grow + offset,
      circle.w + grow * 2,
      (COLOR.shadow & 0x00_ff_ff_ff) | (alpha << 24),
    )
  }

  painter.fillCircle(circle.x, circle.y, circle.w, COLOR.bg)
  painter.strokeEllipse(circle.x, circle.y, circle.w, circle.h, COLOR.border, Math.max(1, Math.round(TRIGGER.border * s)))

  const glyph = TRIGGER.glyph * s
  paintIcon(
    painter,
    'globe',
    circle.x + (circle.w - glyph) / 2,
    circle.y + (circle.h - glyph) / 2,
    glyph,
    data.iconHover === true ? COLOR.accent : COLOR.subtle,
    s,
  )
}

/* ────────────────────────── 布局 ────────────────────────── */

const CJK_ONLY = /^[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]+$/

/**
 * 短标签的宽度（DIP）。
 *
 * `MeasureString` 返回的是**布局盒**，会把前导边距也算进去：实测请求 18.75px 时
 * 单字报 25.55，而"8 字减 1 字再除 7"得到的真实推进只有 19.31。两三字的短标签上
 * 这个误差占比很高，结果就是按钮右边凭空多出一截可点空间。
 * 所以这里先标定出真实推进量与边距，再按标签内容算。
 */
function labelWidth(painter, text, sizePx, s) {
  const one = painter.measure('中', { size: sizePx }).width
  const eight = painter.measure('中'.repeat(8), { size: sizePx }).width
  const advance = (eight - one) / 7
  const bearing = one - advance
  const width = CJK_ONLY.test(text)
    ? text.length * advance
    : Math.max(advance, painter.measure(text, { size: sizePx }).width - bearing)
  return width / s
}

/**
 * 算整张卡片（DIP）。返回的坐标**已经含阴影外扩**，可直接当窗口内坐标用。
 * @param bodyHeight - 正文区高度（不含上下 padding），由绘制时量出。
 * @param m - `{ langOpen, langW, copyW, retryW }`；缺省走 CARD 里的初值。
 */
export function cardLayout(bodyHeight, m = {}) {
  const langOpen = m.langOpen === true
  const langW = m.langW ?? CARD.langW
  const copyW = m.copyW ?? CARD.copyW
  const retryW = m.retryW ?? CARD.retryW

  // 正文只受"文字多少"影响；下拉是覆盖层。3 行时最小卡片 139 刚好装下菜单（不改变高度）；
  // 4 行（多了"自定义…"）就装不下了，所以**只有菜单展开且卡片太矮时**才长高，高度由 paintCard 两趟重排。
  const bodyH = Math.max(CARD.bodyLine, bodyHeight) + CARD.padY * 2
  const menuBottom = CARD.langTop + CARD.langPad * 2 + CARD.langRowH * LANG_IDS.length
  const minBodyForMenu = Math.max(0, menuBottom - CARD.headerH - CARD.footerH)
  const finalBodyH = langOpen ? Math.max(bodyH, minBodyForMenu) : bodyH
  // 卡片宽度：默认 380，用户拖两侧后由 `m.cardW` 传入（夹在 [minWidth, maxWidth]）
  const cardW = Math.max(CARD.minWidth, Math.min(CARD.maxWidth, Math.round(m.cardW ?? CARD.width)))
  const cardH = CARD.headerH + finalBodyH + CARD.footerH
  const left = CARD.shadow
  const top = CARD.shadow
  const right = left + cardW - CARD.edge
  const icon = CARD.iconBox
  const step = icon + CARD.iconGap
  const divGap = 7 // 分隔线两侧各留这么宽
  const closeX = right - icon
  const dividerX = closeX - divGap
  const pinX = dividerX - divGap - icon
  const boltX = pinX - step

  const footY = top + CARD.headerH + finalBodyH + Math.round((CARD.footerH - icon) / 2)
  const langX = left + CARD.langLeft
  const langY = top + CARD.langTop
  const rows = LANG_IDS.map((id, index) => ({
    id,
    y: langY + CARD.langPad + index * CARD.langRowH,
    h: CARD.langRowH,
  }))
  const menuH = CARD.langPad * 2 + CARD.langRowH * LANG_IDS.length

  return {
    windowW: cardW + CARD.shadow * 2,
    windowH: cardH + CARD.shadow * 2,
    card: { x: left, y: top, w: cardW, h: cardH },
    bodyTop: top + CARD.headerH,
    bodyH: finalBodyH,
    footTop: top + CARD.headerH + finalBodyH,
    text: {
      x: left + CARD.padX,
      y: top + CARD.headerH + CARD.padY,
      w: cardW - CARD.padX * 2,
      h: finalBodyH - CARD.padY * 2,
    },
    // 头部命中区。顺序（自右向左）：关闭 │ 分隔线 │ 钉住　即划即译 ｜ 语言
    hitClose: { x: closeX, y: top + (CARD.headerH - icon) / 2, w: icon, h: icon },
    hitPin: { x: pinX, y: top + (CARD.headerH - icon) / 2, w: icon, h: icon },
    hitBolt: { x: boltX, y: top + (CARD.headerH - icon) / 2, w: icon, h: icon },
    dividerX,
    // 语言按钮：宽度**按内容实测**（不能给一大块虚的可点区）
    hitLang: { x: left + CARD.edge, y: top + (CARD.headerH - icon) / 2, w: langW, h: icon },
    // 页脚：复制 / 重译，各自贴着自己内容，间距 4（与 .hc-foot 一致）
    hitCopy: { x: left + CARD.edge, y: footY, w: copyW, h: icon },
    hitRetry: { x: left + CARD.edge + copyW + CARD.actionFootGap, y: footY, w: retryW, h: icon },
    langMenu: langOpen ? { x: langX, y: langY, w: CARD.langWidth, h: menuH, rows } : undefined,
  }
}

/**
 * 把滚动偏移夹进 `[0, 内容高 − 视口高]`（DIP）。
 *
 * 视觉基准里没有滚动条，所以这里只负责"别滚出内容之外"这个数学；是否显示滚动条是另一个决定。
 * 内容比视口矮时上限为 0 —— 也就滚不动。
 * **两个高度必须是真实有限数字**（拿不到就锁死为 0），免得脏输入变成"能滚到不存在的内容上"。
 */
export function clampScroll(next, contentHeight, viewportHeight) {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(viewportHeight)) return 0
  const limit = Math.max(0, contentHeight - viewportHeight)
  const value = Number.isFinite(next) ? next : 0
  return Math.min(Math.max(0, value), limit)
}

/** 下拉菜单里命中了哪一项；没命中返回 null。 */
export function langRowAt(x, y, layout) {
  const menu = layout.langMenu
  if (menu === undefined) return null
  if (x < menu.x || x > menu.x + menu.w || y < menu.y || y > menu.y + menu.h) return null
  for (const row of menu.rows) {
    if (y >= row.y && y <= row.y + row.h) return row.id
  }
  return null
}

function inRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

/** 命中测试（窗口内 DIP 坐标）。返回动作名或 null。 */
export function cardHitTest(x, y, layout) {
  if (inRect(x, y, layout.hitClose)) return 'close'
  if (inRect(x, y, layout.hitPin)) return 'pin'
  if (inRect(x, y, layout.hitBolt)) return 'bolt'
  if (inRect(x, y, layout.hitLang)) return 'lang'
  if (inRect(x, y, layout.hitCopy)) return 'copy'
  if (inRect(x, y, layout.hitRetry)) return 'retry'
  return null
}

/* ────────────────────────── 图标（16 单位画布，与 视觉基准 的 SVG 同源） ────────────────────────── */

/**
 * 每个图标都用 16×16 的坐标系描述，与 `docs/card-visual-baseline.md` 里 SVG 的 path 数据一一对应。
 * 椭圆一律写 [left, top, width, height]。画的时候整体乘 `size / 16`，形状与存档一致。
 */
const ICONS = {
  globe: {
    ellipses: [[2, 2, 12, 12], [5.3, 2, 5.4, 12]],
    lines: [[[2, 8], [14, 8]]],
  },
  caret: { lines: [[[4.5, 6.5], [8, 10], [11.5, 6.5]]] },
  close: { lines: [[[4.5, 4.5], [11.5, 11.5]], [[11.5, 4.5], [4.5, 11.5]]] },
  copy: {
    // 后面的卡片：只留左上那一段（用前面那张卡的底色遮掉右下）
    roundRects: [
      { x: 3.5, y: 2.5, w: 7, h: 7, r: 2, stroke: true },
      { x: 5.5, y: 5.5, w: 8, h: 8, r: 2, fill: true },
      { x: 5.5, y: 5.5, w: 8, h: 8, r: 2, stroke: true },
    ],
  },
  retry: {
    ellipses: [[3, 3, 10, 10]],
    lines: [[[13.5, 3], [13.5, 6], [10.5, 6]]],
  },
  check: { lines: [[[3.5, 8.5], [6.5, 11.5], [12.5, 4.5]]] },
  bolt: { polygons: [[[9.5, 1.5], [3.6, 9], [7.7, 9], [6.5, 14.5], [13, 7], [8.9, 7]]] },
  pin: {
    lines: [[[6.5, 1.5], [9.5, 1.5]], [[8, 8.7], [8, 14.3]]],
    polygons: [[[5.6, 3.5], [10.4, 3.5], [10.4, 6.7], [11.9, 8.7], [4.1, 8.7], [5.6, 6.7]]],
  },
}

function paintIcon(painter, id, boxX, boxY, size, color, s) {
  const icon = ICONS[id]
  if (icon === undefined) return
  const k = size / 16
  const w = Math.max(1, 1.5 * s) // 与 视觉基准 的 strokeWidth: 1.5 对齐，不取整
  const x = (u) => boxX + u * k
  const y = (v) => boxY + v * k

  for (const [left, top, rw, rh] of icon.ellipses ?? []) {
    painter.strokeEllipse(x(left), y(top), rw * k, rh * k, color, w)
  }
  for (const rect of icon.roundRects ?? []) {
    if (rect.fill === true) painter.fillRoundRect(x(rect.x), y(rect.y), rect.w * k, rect.h * k, rect.r * k, COLOR.bg)
    if (rect.stroke === true) painter.strokeRoundRect(x(rect.x), y(rect.y), rect.w * k, rect.h * k, rect.r * k, color, w)
  }
  for (const line of icon.lines ?? []) {
    for (let i = 1; i < line.length; i++) {
      painter.line(x(line[i - 1][0]), y(line[i - 1][1]), x(line[i][0]), y(line[i][1]), color, w)
    }
  }
  for (const polygon of icon.polygons ?? []) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]
      const b = polygon[(i + 1) % polygon.length]
      painter.line(x(a[0]), y(a[1]), x(b[0]), y(b[1]), color, w)
    }
  }
}

/* ────────────────────────── 阴影 ────────────────────────── */

/**
 * 近似 M1 的 `box-shadow: 0 16px 40px rgba(16,27,50,.16)`。
 * GDI+ 没有模糊原语，所以叠 N 层逐层外扩、透明度递减的圆角矩形来凑柔光。
 */
function paintShadow(painter, rect, radius, s) {
  const spread = CARD.shadow * s
  const offset = CARD.shadowOffsetY * s
  const steps = 10
  for (let i = steps; i >= 1; i--) {
    const grow = (spread * i) / steps
    const alpha = Math.round(16 * Math.pow(1 - i / (steps + 1), 1.6))
    if (alpha <= 0) continue
    painter.fillRoundRect(
      rect.x - grow,
      rect.y - grow + offset,
      rect.w + grow * 2,
      rect.h + grow * 2,
      radius + grow,
      (COLOR.shadow & 0x00_ff_ff_ff) | (alpha << 24),
    )
  }
}

/* ────────────────────────── 绘制 ────────────────────────── */

/**
 * 画一整张卡片。
 * @param painter - gdi.mjs 的 painterFromHdc 产物。
 * @param width/height - 窗口物理像素（含阴影外扩）。
 * @param data - `{ status, text, target, mode, pinned, langOpen, hover, copied, maxBodyDip, scroll, follow }`。
 *   `mode` 为 `'icon'` 时 ⚡ 不高亮（即划即译关掉，改走小图标模式）。
 *   `follow` 为 `false` 时流式期间不跟随底部（用户手动往上滚过）。
 * @param s - 显示器缩放。
 * @returns `{ bodyHeight, contentHeight, scroll, langW, copyW, retryW }` ——
 *   实测尺寸与夹取后的滚动量，调用方据此重排/命中/决定还能不能滚。
 */
export function paintCard(painter, width, height, data, s) {
  const running = data.status === 'running'
  // 归一化放在绘制入口：译文、错误文案、假流式都走这里，一处覆盖全部来源。
  const text = normalizeLineBreaks(data.text)
  const shown = text === '' ? (running ? '翻译中…' : '') : text
  const bodySize = text === '' ? 14 * s : CARD.bodyFont * s
  const bodyLine = text === '' ? 25 * s : CARD.bodyLine * s

  // 卡片宽度按**窗口实际宽度**反推：用户拖两侧改宽后正文要跟着重排。
  const cardW = Math.max(CARD.minWidth, Math.min(CARD.maxWidth, Math.round(width / s) - CARD.shadow * 2))

  // 先量：正文该多高，窗口就该多高
  const probeWidth = (cardW - CARD.padX * 2) * s
  const measured = shown === ''
    ? bodyLine
    : painter.paragraph(shown, 0, 0, probeWidth, { size: bodySize, lineHeight: bodyLine, maxHeight: Infinity, dryRun: true })
  // contentHeight 是"文字全排下来要多高"（可能远高于卡片上限），bodyHeight 是实际卡片高度。
  // 两者之差就是可滚动的量；滚动由调用方经 data.scroll 传进来。
  const contentHeight = measured / s
  const bodyHeight = Math.max(CARD.bodyLine, Math.min(data.maxBodyDip ?? 400, contentHeight))
  const maxScroll = Math.max(0, contentHeight - bodyHeight)
  /**
   * **流式跟随**：生成过程中把视图钉在内容底部，新译文始终出现在窗口最后 1–2 行
   * （已经生成的部分自动向上顶）。`data.follow === false` 表示用户手动往上滚过 ——
   * 那时要停住，别把他的阅读位置每帧拽回底部。
   * 翻译结束（`status !== 'running'`）后不再跟随，调用方会把视图回到顶部。
   */
  const follow = data.status === 'running' && data.follow !== false
  const scroll = follow ? maxScroll : clampScroll(data.scroll, contentHeight, bodyHeight)

  // 头部"语言"按钮宽度：padding + 图标 + 间距 + 标题 + 间距 + 目标语言 + 间距 + 箭头 + padding
  const titleSize = CARD.titleFont * s
  const label = targetText(data)
  const titleW = labelWidth(painter, '翻译', titleSize, s)
  const labelW = labelWidth(painter, label, titleSize, s)
  const langW = CARD.headPadX * 2 + CARD.iconSize + CARD.headGap * 3 + titleW + labelW + CARD.caretSize

  // 页脚按钮宽度：padding + 图标 + 间距 + 文字 + padding（各自贴着自己的内容）
  const copyCaption = data.copied === true ? '已复制' : '复制'
  const actionSize = CARD.actionFont * s
  const copyTextW = labelWidth(painter, copyCaption, actionSize, s)
  const retryTextW = labelWidth(painter, '重译', actionSize, s)
  const footerW = (textW) => CARD.actionPadX * 2 + CARD.iconSize + CARD.actionGap + textW
  const copyW = footerW(copyTextW)
  const retryW = footerW(retryTextW)

  const layout = cardLayout(bodyHeight, { cardW, langOpen: data.langOpen, langW, copyW, retryW })
  const hover = data.hover ?? null
  const icon = CARD.iconSize * s
  const card = { x: layout.card.x * s, y: layout.card.y * s, w: layout.card.w * s, h: layout.card.h * s }
  const radius = CARD.radius * s

  // 阴影 → 卡片 → 边框
  paintShadow(painter, card, radius, s)
  painter.fillRoundRect(card.x, card.y, card.w, card.h, radius, COLOR.bg)
  painter.strokeRoundRect(card.x, card.y, card.w, card.h, radius, COLOR.border, Math.max(1, Math.round(s)))

  // 头部 / 页脚的两条分隔线
  const hairline = Math.max(1, Math.round(0.5 * s))
  painter.fillRect(card.x, layout.bodyTop * s - hairline, card.w, hairline, COLOR.border)
  painter.fillRect(card.x, layout.footTop * s, card.w, hairline, COLOR.border)

  // ── 头部 ──
  const headTop = layout.hitLang.y * s
  const headH = CARD.iconBox * s
  let cursor = layout.hitLang.x * s + CARD.headPadX * s
  const centerY = (boxH) => headTop + (headH - boxH) / 2

  paintIcon(painter, 'globe', cursor, centerY(icon), icon, COLOR.subtle, s)
  cursor += icon + CARD.headGap * s
  // 推进量用"紧宽度"（titleW），绘制矩形给足 MeasureString 的布局盒——否则 GDI+ 会加省略号
  const titleM = painter.measure('翻译', { size: titleSize })
  painter.text('翻译', cursor, centerY(titleM.height), titleM.width + 2, titleM.height + 2, { size: titleSize, color: COLOR.subtle })
  cursor += titleW * s + CARD.headGap * s
  const labelM = painter.measure(label, { size: titleSize })
  painter.text(label, cursor, centerY(labelM.height), labelM.width + 2, labelM.height + 2, { size: titleSize, color: COLOR.muted })
  cursor += labelW * s + CARD.headGap * s
  paintIcon(painter, 'caret', cursor, centerY(CARD.caretSize * s), CARD.caretSize * s, COLOR.muted, s)

  const paintHeaderIcon = (id, rect, on) => {
    if (hover === id || on) {
      painter.fillRoundRect(rect.x * s, rect.y * s, rect.w * s, rect.h * s, 8 * s, COLOR.hover)
    }
    paintIcon(
      painter,
      id,
      (rect.x + (CARD.iconBox - CARD.iconSize) / 2) * s,
      (rect.y + (CARD.iconBox - CARD.iconSize) / 2) * s,
      icon,
      on ? COLOR.accent : COLOR.muted,
      s,
    )
  }
  // ⚡ 高亮 = 即划即译模式；关掉 = 小图标模式（不再是"什么都不做"）
  paintHeaderIcon('bolt', layout.hitBolt, data.mode !== 'icon')
  paintHeaderIcon('pin', layout.hitPin, data.pinned === true)
  painter.fillRect(
    layout.dividerX * s,
    (layout.card.y + CARD.headerH / 2 - CARD.dividerH / 2) * s,
    Math.max(1, Math.round(s)),
    CARD.dividerH * s,
    COLOR.border,
  )
  paintHeaderIcon('close', layout.hitClose, false)

  // ── 正文（只有译文）──
  const area = layout.text
  if (text === '') {
    painter.paragraph(running ? '翻译中…' : '', area.x * s, area.y * s, area.w * s, {
      size: 14 * s,
      lineHeight: 25 * s,
      color: COLOR.muted,
      maxHeight: area.h * s,
    })
  } else {
    painter.setClip(card.x, layout.bodyTop * s, card.w, layout.bodyH * s)
    // 滚动：把起点上移 scroll，maxHeight 同步加上 scroll —— 于是"什么时候停"的判据
    // （y + maxHeight）在绝对坐标上完全不变，滚出去的部分交给上面的 setClip 裁掉。
    painter.paragraph(text, area.x * s, area.y * s - scroll * s, area.w * s, {
      size: CARD.bodyFont * s,
      lineHeight: CARD.bodyLine * s,
      color: data.status === 'error' ? COLOR.error : COLOR.text,
      maxHeight: area.h * s + scroll * s,
    })
    painter.resetClip()
  }

  // ── 右侧细滚动条（只在滚动/跟随时淡入；不参与命中，滚轮照旧）──
  const barAlpha = Math.max(0, Math.min(1, Number(data.scrollBarAlpha ?? 1)))
  if (maxScroll > 0 && barAlpha > 0.02) {
    const bar = CARD.scrollbar
    const trackY = layout.bodyTop + bar.padY
    const trackH = Math.max(1, layout.bodyH - bar.padY * 2)
    // 拇指高度按"视口 / 内容"占比，太短时给个下限（免得小到看不见）
    const thumbH = Math.max(bar.minHeight, (trackH * bodyHeight) / contentHeight)
    const thumbY = trackY + (trackH - thumbH) * (scroll / maxScroll)
    // 用颜色自带的 alpha 做淡入淡出（0 = 全透明，等于不画）
    const baseAlpha = (bar.color >>> 24) & 0xff
    const faded = ((bar.color & 0x00_ff_ff_ff) | (Math.round(baseAlpha * barAlpha) << 24)) >>> 0
    painter.fillRoundRect(
      (layout.card.x + layout.card.w - bar.inset - bar.width) * s,
      thumbY * s,
      bar.width * s,
      thumbH * s,
      bar.radius * s,
      faded,
    )
  }

  // ── 页脚 ──
  const paintFooterAction = (id, rect, caption, textW) => {
    if (hover === id) painter.fillRoundRect(rect.x * s, rect.y * s, rect.w * s, rect.h * s, 8 * s, COLOR.hover)
    const done = id === 'copy' && data.copied === true
    paintIcon(
      painter,
      done ? 'check' : id,
      (rect.x + CARD.actionPadX) * s,
      (rect.y + (rect.h - CARD.iconSize) / 2) * s,
      icon,
      done ? COLOR.accent : COLOR.subtle,
      s,
    )
    // 文字按**实测高度**垂直居中；绘制矩形给足布局盒（贴紧宽度会触发省略号），
    // 而按钮宽度 textW 是紧的——两者分开，右边才不会多出一截可点空间
    const box = painter.measure(caption, { size: actionSize })
    painter.text(
      caption,
      (rect.x + CARD.actionPadX + CARD.iconSize + CARD.actionGap) * s,
      rect.y * s + (rect.h * s - box.height) / 2,
      box.width + 2,
      box.height + 2,
      { size: actionSize, color: done ? COLOR.accent : COLOR.subtle },
    )
  }
  paintFooterAction('copy', layout.hitCopy, copyCaption, copyTextW)
  paintFooterAction('retry', layout.hitRetry, '重译', retryTextW)

  // ── 语言下拉（覆盖层，画在最后；不改窗口高度）──
  const menu = layout.langMenu
  if (menu !== undefined) {
    const panel = { x: menu.x * s, y: menu.y * s, w: menu.w * s, h: menu.h * s }
    paintShadow(painter, panel, 10 * s, s)
    painter.fillRoundRect(panel.x, panel.y, panel.w, panel.h, 10 * s, COLOR.bg)
    painter.strokeRoundRect(panel.x, panel.y, panel.w, panel.h, 10 * s, COLOR.border, Math.max(1, Math.round(s)))
    for (const row of menu.rows) {
      const rect = { x: panel.x + CARD.langPad * s, y: row.y * s, w: panel.w - CARD.langPad * 2 * s, h: row.h * s }
      const on = data.target === row.id
      if (hover === `lang:${row.id}`) painter.fillRoundRect(rect.x, rect.y, rect.w, rect.h, 7 * s, COLOR.hover)
      const size = 13 * s
      const box = painter.measure(LANG_LABELS[row.id], { size })
      painter.text(LANG_LABELS[row.id], rect.x + 8 * s, rect.y + (rect.h - box.height) / 2, rect.w - 16 * s, box.height + 2, {
        size,
        color: on ? COLOR.accent : COLOR.text,
      })
      if (on) paintIcon(painter, 'check', rect.x + rect.w - 8 * s - 14 * s, rect.y + (rect.h - 14 * s) / 2, 14 * s, COLOR.accent, s)
    }
  }

  return { bodyHeight, contentHeight, scroll, langW, copyW, retryW, cardW }
}
