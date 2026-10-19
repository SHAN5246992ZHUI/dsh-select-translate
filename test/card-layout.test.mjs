/**
 * `companion/card.mjs` —— 卡片布局与命中区。
 *
 * 视觉基准存档在 `docs/card-visual-baseline.md`（0.1.3 前由页内卡片定义），`card.mjs` 必须与它逐条对齐。
 * 这里钉三类事：
 *  1. **基准常量**：谁想改视觉，先改 `docs/card-visual-baseline.md`，这条测试会拦住"只改了一边"；
 *  2. **几何关系**：命中区贴着内容、菜单是覆盖层（展开不改变窗口高度，所以卡片不跳）；
 *  3. **paintCard 的回写值**：按钮净宽是 DIP 且与显示器缩放无关（main.mjs 拿它当 DIP 用）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARD, cardHitTest, cardLayout, clampScroll, headerTooltip, LANG_IDS, LANG_LABELS, langRowAt, paintCard, tooltipRect } from '../companion/card.mjs'
import { normalizeLineBreaks } from '../companion/text.mjs'
import { createFakePainter } from './support/fake-painter.mjs'

/** paintCard 需要的状态（缺省值就是"刚出译文、没悬停、没下拉"）。 */
function cardData(patch = {}) {
  return {
    status: 'done',
    text: '调度器把 goroutine 复用到操作系统线程上。',
    target: 'auto',
    mode: 'auto',
    pinned: false,
    langOpen: false,
    hover: null,
    copied: false,
    maxBodyDip: 400,
    ...patch,
  }
}

test('视觉基准常量与存档对齐（改视觉必须先改存档）', () => {
  assert.deepEqual(
    { width: CARD.width, radius: CARD.radius, headerH: CARD.headerH, footerH: CARD.footerH },
    { width: 380, radius: 12, headerH: 44, footerH: 40 },
  )
  assert.deepEqual(
    { padX: CARD.padX, padY: CARD.padY, bodyFont: CARD.bodyFont, bodyLine: CARD.bodyLine },
    { padX: 18, padY: 15, bodyFont: 15, bodyLine: 25 },
  )
  assert.deepEqual({ shadow: CARD.shadow, edge: CARD.edge, iconBox: CARD.iconBox }, { shadow: 14, edge: 8, iconBox: 28 })
})

test('几何：窗口 = 卡片 + 四周阴影外扩；正文区宽度扣掉左右 padding', () => {
  const layout = cardLayout(CARD.bodyLine)

  assert.equal(layout.windowW, CARD.width + CARD.shadow * 2)
  assert.equal(layout.card.x, CARD.shadow)
  assert.equal(layout.card.y, CARD.shadow)
  assert.equal(layout.card.w, CARD.width)
  assert.equal(layout.card.h, CARD.headerH + CARD.bodyLine + CARD.padY * 2 + CARD.footerH)
  assert.equal(layout.windowH, layout.card.h + CARD.shadow * 2)
  assert.equal(layout.bodyTop, CARD.shadow + CARD.headerH)
  assert.equal(layout.text.w, CARD.width - CARD.padX * 2)
  assert.equal(layout.text.x, CARD.shadow + CARD.padX)
  assert.equal(layout.text.h, CARD.bodyLine)
})

test('头部：语言在最左、关闭在最右，三个图标命中区同为 28×28 且互不重叠', () => {
  const layout = cardLayout(CARD.bodyLine, { langW: 115 })
  const icons = [layout.hitBolt, layout.hitPin, layout.hitClose]

  for (const rect of icons) {
    assert.equal(rect.w, CARD.iconBox)
    assert.equal(rect.h, CARD.iconBox)
    assert.ok(rect.x >= layout.card.x && rect.x + rect.w <= layout.card.x + layout.card.w)
    assert.ok(rect.y >= layout.card.y && rect.y + rect.h <= layout.card.y + CARD.headerH)
  }
  // 语言按钮也在卡片内、页眉高度内
  assert.equal(layout.hitLang.h, CARD.iconBox)
  assert.ok(layout.hitLang.x >= layout.card.x && layout.hitLang.x + layout.hitLang.w <= layout.card.x + layout.card.w)
  assert.ok(layout.hitLang.x < layout.hitBolt.x)
  assert.ok(layout.hitBolt.x < layout.hitPin.x)
  assert.ok(layout.hitPin.x < layout.hitClose.x)
  // 关闭按钮右边缘贴住卡片右边（留 CARD.edge）
  assert.equal(layout.hitClose.x + layout.hitClose.w, layout.card.x + CARD.width - CARD.edge)
})

test('头部：语言按钮宽度按内容实测（给一大块虚的可点区就会"右边凭空多一截"）', () => {
  const narrow = cardLayout(CARD.bodyLine, { langW: 115 })
  const wide = cardLayout(CARD.bodyLine, { langW: 200 })
  assert.equal(narrow.hitLang.w, 115)
  assert.equal(wide.hitLang.w, 200)

  const zh = cardLayout(CARD.bodyLine, { langW: 100 })
  assert.equal(zh.hitLang.x, CARD.shadow + CARD.edge)
  // 语言按钮与"即划即译"按钮之间不能重叠
  assert.ok(zh.hitLang.x + zh.hitLang.w <= zh.hitBolt.x)
})

test('页脚：复制/重译各自贴着内容，间距 4（与 .hc-foot 一致）', () => {
  const layout = cardLayout(CARD.bodyLine, { copyW: 65, retryW: 65 })

  assert.equal(layout.hitCopy.x, layout.card.x + CARD.edge)
  assert.equal(layout.hitCopy.w, 65)
  assert.equal(layout.hitRetry.x, layout.hitCopy.x + 65 + CARD.actionFootGap)
  assert.equal(layout.hitRetry.w, 65)
  // 垂直居中于页脚
  assert.equal(layout.hitCopy.y, layout.card.y + CARD.headerH + layout.bodyH + Math.round((CARD.footerH - CARD.iconBox) / 2))
})

test('语言下拉：4 行后最小卡片会为菜单长高；够高时仍是纯覆盖层（不跳）', () => {
  const closed = cardLayout(CARD.bodyLine, { langOpen: false, langW: 115 })
  const open = cardLayout(CARD.bodyLine, { langOpen: true, langW: 115 })

  assert.equal(open.langMenu === undefined, false)
  assert.equal(closed.langMenu, undefined)
  // 最小卡片（正文 25）装不下 4 行菜单 → 展开时长高。旧版 3 行时恰好装得下，所以这里改成了"会长高"。
  assert.ok(open.card.h > closed.card.h)
  assert.ok(open.langMenu.y + open.langMenu.h <= open.card.y + open.card.h)
  assert.equal(open.windowW, closed.windowW)

  // 正文本来就够高的卡片：菜单是覆盖层，展开不改变高度
  const tallClosed = cardLayout(400, { langOpen: false })
  const tallOpen = cardLayout(400, { langOpen: true })
  assert.equal(tallOpen.windowH, tallClosed.windowH)
})

test('语言下拉在卡片里放得下（菜单底边不越出卡片），且第 4 行是"自定义…"', () => {
  const layout = cardLayout(CARD.bodyLine, { langOpen: true })
  const menu = layout.langMenu

  assert.equal(menu.h, CARD.langPad * 2 + CARD.langRowH * LANG_IDS.length)
  assert.deepEqual(
    menu.rows.map((row) => row.id),
    ['auto', 'zh', 'en', 'custom'],
  )
  assert.equal(LANG_LABELS.custom, '自定义…')
  assert.ok(menu.y + menu.h <= layout.card.y + layout.card.h)
})

test('头部显示目标语言：自动时显示宿主判定结果，自定义语种直接显示原文', () => {
  const textsOf = (painter) => painter.calls.text.map((call) => call.text)

  const auto = createFakePainter()
  paintCard(auto, 408, 195, cardData({ target: 'auto', resolved: 'zh' }), 1)
  assert.ok(textsOf(auto).includes('自动·中文'))

  const custom = createFakePainter()
  paintCard(custom, 408, 195, cardData({ target: '日本語' }), 1)
  assert.ok(textsOf(custom).includes('日本語'))
})

test('langRowAt：三行各自命中，行外/菜单外/未展开都是 null', () => {
  const layout = cardLayout(CARD.bodyLine, { langOpen: true })
  const menu = layout.langMenu

  assert.equal(langRowAt(menu.x + 5, menu.y + CARD.langPad + 1, layout), 'auto')
  assert.equal(langRowAt(menu.x + 5, menu.y + CARD.langPad + CARD.langRowH + 1, layout), 'zh')
  assert.equal(langRowAt(menu.x + 5, menu.y + CARD.langPad + CARD.langRowH * 2 + 1, layout), 'en')
  assert.equal(langRowAt(menu.x + 5, menu.y + CARD.langPad + CARD.langRowH * 3 + 1, layout), 'custom')
  // 内边距那一条不算任何行
  assert.equal(langRowAt(menu.x + 5, menu.y + 1, layout), null)
  // 菜单之外
  assert.equal(langRowAt(menu.x - 5, menu.y + 20, layout), null)
  // 没展开
  assert.equal(langRowAt(menu.x + 5, menu.y + 20, cardLayout(CARD.bodyLine)), null)
})

test('命中测试：六个按钮各自命中，按钮之间的空档与卡片外是 null', () => {
  const layout = cardLayout(CARD.bodyLine, { langW: 115, copyW: 65, retryW: 65 })
  const center = (rect) => [rect.x + rect.w / 2, rect.y + rect.h / 2]
  const cases = [
    ['close', layout.hitClose],
    ['pin', layout.hitPin],
    ['bolt', layout.hitBolt],
    ['lang', layout.hitLang],
    ['copy', layout.hitCopy],
    ['retry', layout.hitRetry],
  ]
  for (const [zone, rect] of cases) {
    const [x, y] = center(rect)
    assert.equal(cardHitTest(x, y, layout), zone)
  }
  // 钉住与分隔线之间的空档
  assert.equal(cardHitTest(layout.dividerX - 3, layout.hitPin.y + 10, layout), null)
  // 卡片外（阴影外扩那一圈）
  assert.equal(cardHitTest(layout.card.x - 5, layout.card.y + 10, layout), null)
  // 正文中间
  assert.equal(cardHitTest(layout.text.x + 10, layout.text.y + 10, layout), null)
})

test('LANG_IDS / LANG_LABELS：前三个与视觉基准存档的 LANGS 一致，第 4 个是原生卡片独有的"自定义…"', () => {
  assert.deepEqual(LANG_IDS.slice(0, 3), ['auto', 'zh', 'en'])
  assert.deepEqual(LANG_LABELS, { auto: '自动', zh: '中文', en: 'English', custom: '自定义…' })
})

/* ────────────────────────── paintCard ────────────────────────── */

test('paintCard 回写按钮净宽：随文字变长而变宽；且与显示器缩放无关（DIP）', () => {
  const painter = createFakePainter()
  const base = paintCard(painter, 408, 195, cardData(), 1)
  const copied = paintCard(painter, 408, 195, cardData({ copied: true }), 1)

  // "已复制" 比 "复制" 长 → 按钮必须更宽
  assert.ok(copied.copyW > base.copyW)
  // 两个两字按钮宽度接近（字形不同，允许几个像素差）
  assert.ok(Math.abs(base.retryW - base.copyW) < 5)
  // 每个按钮至少含 图标 + 左右 padding
  assert.ok(base.copyW > CARD.actionPadX * 2 + CARD.iconSize)
  // 语言按钮至少含 图标 + 标题 + 目标语言 + 箭头
  assert.ok(base.langW > CARD.headPadX * 2 + CARD.iconSize + CARD.caretSize)

  const scaled = paintCard(createFakePainter(), 408 * 1.25, 195 * 1.25, cardData(), 1.25)
  assert.ok(Math.abs(scaled.copyW - base.copyW) < 0.01)
  assert.ok(Math.abs(scaled.retryW - base.retryW) < 0.01)
  assert.ok(Math.abs(scaled.langW - base.langW) < 0.01)
})

test('paintCard 目标语言越长，语言按钮越宽', () => {
  const zh = paintCard(createFakePainter(), 408, 195, cardData({ target: 'zh' }), 1)
  const en = paintCard(createFakePainter(), 408, 195, cardData({ target: 'en' }), 1)
  assert.ok(en.langW > zh.langW)
})

test('paintCard 正文高度：一行文本就是最小高度，长文本被 maxBodyDip 夹住', () => {
  const one = paintCard(createFakePainter(), 408, 195, cardData({ text: '短' }), 1)
  assert.equal(one.bodyHeight, CARD.bodyLine)

  const long = paintCard(createFakePainter(), 408, 8000, cardData({ text: '中'.repeat(2000) }), 1)
  assert.equal(long.bodyHeight, 400)

  const empty = paintCard(createFakePainter(), 408, 195, cardData({ text: '', status: 'running' }), 1)
  assert.equal(empty.bodyHeight, CARD.bodyLine)
})

test('paintCard 的正文区被裁剪，且画完复位（否则会盖到页脚上）', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 408, 300, cardData({ text: '中'.repeat(400) }), 1)
  const layout = cardLayout(measured.bodyHeight)

  const clip = painter.calls.clip.filter((entry) => entry.op === 'setClip')
  assert.equal(clip.length, 1)
  assert.deepEqual(clip[0], { op: 'setClip', x: layout.card.x, y: layout.bodyTop, w: layout.card.w, h: layout.bodyH })
  assert.equal(painter.calls.clip.filter((entry) => entry.op === 'resetClip').length, 1)
})

test('paintCard 错误态用错误色，正常态用正文色', () => {
  const ok = createFakePainter()
  paintCard(ok, 408, 300, cardData(), 1)
  const error = createFakePainter()
  paintCard(error, 408, 300, cardData({ status: 'error' }), 1)

  const bodyOf = (painter) => painter.calls.paragraph.filter((entry) => entry.dryRun !== true).at(-1)
  assert.equal(bodyOf(ok).color, 0xff1f2329)
  assert.equal(bodyOf(error).color, 0xffd84a4a)
})

test('paintCard 空译文时显示"翻译中…"占位（running），且用的是弱化色', () => {
  const painter = createFakePainter()
  paintCard(painter, 408, 195, cardData({ text: '', status: 'running' }), 1)

  const drawn = painter.calls.paragraph.filter((entry) => entry.dryRun !== true)
  assert.equal(drawn.length, 1)
  assert.equal(drawn[0].text, '翻译中…')
  assert.equal(drawn[0].color, 0xff8a94a6)
})

test('paintCard 展开下拉时把菜单画在最后：窗口尺寸不变，而且菜单面板覆盖在正文之上', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 408, 300, cardData({ langOpen: true, text: '中'.repeat(400) }), 1)
  const layout = cardLayout(measured.bodyHeight, { langOpen: true, langW: measured.langW, copyW: measured.copyW, retryW: measured.retryW })
  const menu = layout.langMenu

  const menuPanel = painter.calls.shape.find((entry) => Math.abs(entry.r - 10) < 0.01 && entry.op === 'fillRoundRect')
  assert.equal(menuPanel === undefined, false)
  assert.equal(Math.round(menuPanel.x), Math.round(menu.x))
  assert.equal(Math.round(menuPanel.w), Math.round(menu.w))
  // 菜单行文本（自动/中文/English）都画出来了
  const labels = painter.calls.text.map((entry) => entry.text)
  for (const label of Object.values(LANG_LABELS)) assert.ok(labels.includes(label))
})

/* ────────────────────────── 长译文滚动 ────────────────────────── */

test('clampScroll：夹进 [0, 内容高 − 视口高]；内容比视口矮时滚不动', () => {
  assert.equal(clampScroll(50, 200, 100), 50)
  assert.equal(clampScroll(-10, 200, 100), 0)
  assert.equal(clampScroll(999, 200, 100), 100)
  assert.equal(clampScroll(10, 80, 100), 0)
  assert.equal(clampScroll(10, 100, 100), 0)
  // 脏输入不产生 NaN
  assert.equal(clampScroll(Number.NaN, 200, 100), 0)
  assert.equal(clampScroll(10, undefined, 100), 0)
  assert.equal(clampScroll(10, 200, undefined), 0)
})

test('paintCard：长译文的 contentHeight 远高于卡片上限，bodyHeight 被夹住（5000 字场景）', () => {
  const measured = paintCard(createFakePainter(), 408, 3000, cardData({ text: '中'.repeat(2000) }), 1)

  assert.equal(measured.bodyHeight, 400, 'bodyHeight 受 maxBodyDip 夹取')
  assert.ok(measured.contentHeight > 400, 'contentHeight 是"文字全排下来"的真实高度')
  assert.equal(measured.scroll, 0, '默认不滚')
})

test('paintCard 滚动：绘制起点上移 scroll，maxHeight 同步加上 scroll（"什么时候停"的绝对判据不变）', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 408, 3000, cardData({ text: '中'.repeat(2000), scroll: 100 }), 1)
  const draw = painter.calls.paragraph.at(-1)
  const layout = cardLayout(measured.bodyHeight)

  assert.equal(measured.scroll, 100)
  assert.equal(draw.y, layout.text.y - 100)
  assert.equal(draw.maxHeight, layout.text.h + 100)
  // 绝对停止线没变：起点上移多少，maxHeight 就补多少
  assert.equal(draw.y + draw.maxHeight, layout.text.y + layout.text.h)
})

test('paintCard 滚动越界会被夹回：最多滚到"内容底"', () => {
  const measured = paintCard(createFakePainter(), 408, 3000, cardData({ text: '中'.repeat(2000), scroll: 99999 }), 1)
  assert.equal(measured.scroll, measured.contentHeight - measured.bodyHeight)
})

/* ────────────────────────── 流式跟随（长译文自动向上顶） ────────────────────────── */

test('流式跟随：running + follow 时视图钉在内容底部（新译文出现在最后 1–2 行）', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 408, 3000, cardData({ status: 'running', text: '中'.repeat(2000), scroll: 0, follow: true }), 1)

  // 内容远高于视口：跟随就该滚到底
  assert.equal(measured.scroll, measured.contentHeight - measured.bodyHeight)
  assert.ok(measured.scroll > 0)
  // 绘制起点确实被顶上去（已生成的部分向上移）
  const draw = painter.calls.paragraph.at(-1)
  assert.equal(draw.y, cardLayout(measured.bodyHeight).text.y - measured.scroll)
})

test('流式跟随：用户手动往上滚过（follow=false）就不许再把他拽回底部', () => {
  const measured = paintCard(createFakePainter(), 408, 3000, cardData({ status: 'running', text: '中'.repeat(2000), scroll: 120, follow: false }), 1)
  assert.equal(measured.scroll, 120)
})

test('流式跟随：翻译结束后不再跟随（停在调用方给的位置，而调用方会回到顶部）', () => {
  const done = paintCard(createFakePainter(), 408, 3000, cardData({ status: 'done', text: '中'.repeat(2000), scroll: 0, follow: false }), 1)
  assert.equal(done.scroll, 0)

  // 就算 follow 还是 true，只要不在 running 就不跟随
  const stale = paintCard(createFakePainter(), 408, 3000, cardData({ status: 'done', text: '中'.repeat(2000), scroll: 40, follow: true }), 1)
  assert.equal(stale.scroll, 40)
})

test('流式跟随：内容还装得下时不滚（scroll 恒为 0）', () => {
  const measured = paintCard(createFakePainter(), 408, 195, cardData({ status: 'running', text: '短', scroll: 0, follow: true }), 1)
  assert.equal(measured.scroll, 0)
  assert.ok(measured.contentHeight <= measured.bodyHeight)
})

/* ────────────────────────── 右侧细滚动条 ────────────────────────── */

const SCROLLBAR_COLOR = 0xff_c9_ce_db

test('滚动条常量与视觉基准存档的 ::-webkit-scrollbar 对齐（6 宽 / 圆角 3 / #c9cedb）', () => {
  assert.deepEqual(CARD.scrollbar, {
    width: 6,
    inset: 1,
    padY: 3,
    minHeight: 24,
    radius: 3,
    color: SCROLLBAR_COLOR,
    holdMs: 700, // 停手后再显示 0.7s
    fadeMs: 120, // 淡入淡出 0.12s（40ms 一轮询 → 约 3 步，不拖沓）
  })
})

test('滚动条按 scrollBarAlpha 淡入淡出：0 不画、0.5 半透明、缺省全不透明', () => {
  const text = '中'.repeat(2000)
  const alphaOf = (painter) => {
    const bar = painter.calls.shape.find((entry) => (entry.color & 0x00_ff_ff_ff) === (SCROLLBAR_COLOR & 0x00_ff_ff_ff))
    return bar === undefined ? null : (bar.color >>> 24) & 0xff
  }

  const off = createFakePainter()
  paintCard(off, 408, 3000, cardData({ text, scroll: 100, scrollBarAlpha: 0 }), 1)
  assert.equal(alphaOf(off), null, 'alpha=0 时不该画滚动条')

  const half = createFakePainter()
  paintCard(half, 408, 3000, cardData({ text, scroll: 100, scrollBarAlpha: 0.5 }), 1)
  assert.equal(alphaOf(half), 128)

  const full = createFakePainter()
  paintCard(full, 408, 3000, cardData({ text, scroll: 100 }), 1)
  assert.equal(alphaOf(full), 255, '没传 alpha 时按全不透明（兼容）')

  const tiny = createFakePainter()
  paintCard(tiny, 408, 3000, cardData({ text, scroll: 100, scrollBarAlpha: 0.01 }), 1)
  assert.equal(alphaOf(tiny), null, '低于阈值等于不画，省一帧')
})

test('内容装得下时没有滚动条', () => {
  const painter = createFakePainter()
  paintCard(painter, 408, 195, cardData({ text: '短' }), 1)
  assert.equal(painter.calls.shape.filter((entry) => entry.color === SCROLLBAR_COLOR).length, 0)
})

test('内容高于视口时画一条细滚动条：贴右缘、在正文右侧、不超出卡片', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 408, 3000, cardData({ text: '中'.repeat(2000), scroll: 0, follow: false }), 1)
  const layout = cardLayout(measured.bodyHeight)
  const bars = painter.calls.shape.filter((entry) => entry.color === SCROLLBAR_COLOR)

  assert.equal(bars.length, 1)
  const bar = bars[0]
  assert.equal(bar.op, 'fillRoundRect')
  assert.equal(bar.w, CARD.scrollbar.width)
  assert.equal(bar.r, CARD.scrollbar.radius)
  // 贴卡片右缘、且整体在正文区右侧（不压字）
  assert.equal(bar.x, layout.card.x + layout.card.w - CARD.scrollbar.inset - CARD.scrollbar.width)
  assert.ok(bar.x >= layout.text.x + layout.text.w)
  // 竖向不越出正文区
  assert.ok(bar.y >= layout.bodyTop && bar.y + bar.h <= layout.bodyTop + layout.bodyH)
  // 拇指高度在 [下限, 轨道高] 之间
  assert.ok(bar.h >= CARD.scrollbar.minHeight && bar.h <= layout.bodyH - CARD.scrollbar.padY * 2)
})

test('滚动条位置跟着 scroll：顶部时贴轨道上端，到底时贴轨道下端', () => {
  const text = '中'.repeat(2000)
  const top = createFakePainter()
  const topMeasured = paintCard(top, 408, 3000, cardData({ text, scroll: 0, follow: false }), 1)
  const bottom = createFakePainter()
  const bottomMeasured = paintCard(bottom, 408, 3000, cardData({ text, scroll: 99999, follow: false }), 1)
  const layout = cardLayout(topMeasured.bodyHeight)
  const trackTop = layout.bodyTop + CARD.scrollbar.padY
  const trackBottom = layout.bodyTop + layout.bodyH - CARD.scrollbar.padY

  const topBar = top.calls.shape.find((entry) => entry.color === SCROLLBAR_COLOR)
  const bottomBar = bottom.calls.shape.find((entry) => entry.color === SCROLLBAR_COLOR)
  assert.equal(topBar.y, trackTop)
  assert.equal(Math.round(bottomBar.y + bottomBar.h), Math.round(trackBottom))
  assert.equal(bottomMeasured.scroll, bottomMeasured.contentHeight - bottomMeasured.bodyHeight)
})

test('流式跟随时滚动条也在底部（跟随与滚动条一致）', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 408, 3000, cardData({ status: 'running', text: '中'.repeat(2000), scroll: 0, follow: true }), 1)
  const layout = cardLayout(measured.bodyHeight)
  const bar = painter.calls.shape.find((entry) => entry.color === SCROLLBAR_COLOR)

  assert.ok(measured.scroll > 0)
  assert.equal(Math.round(bar.y + bar.h), Math.round(layout.bodyTop + layout.bodyH - CARD.scrollbar.padY))
})

test('paintCard 短文本传了 scroll 也滚不动（上限为 0）', () => {
  const measured = paintCard(createFakePainter(), 408, 195, cardData({ text: '短', scroll: 500 }), 1)
  assert.equal(measured.scroll, 0)
  assert.equal(measured.bodyHeight, CARD.bodyLine)
  assert.equal(measured.contentHeight, CARD.bodyLine)
})

test('⚡ 的高亮判据是 mode：auto 亮、icon 不亮（关掉 = 走小图标模式，不再是"什么都不做"）', () => {
  const auto = createFakePainter()
  paintCard(auto, 408, 195, cardData({ mode: 'auto' }), 1)
  const icon = createFakePainter()
  paintCard(icon, 408, 195, cardData({ mode: 'icon' }), 1)

  const accentLines = (painter) => painter.calls.shape.filter((entry) => entry.op === 'line' && entry.color === 0xff_4d_6b_fe).length
  const hoverFills = (painter) => painter.calls.shape.filter((entry) => entry.op === 'fillRoundRect' && entry.color === 0x10_1f_23_29).length

  assert.ok(accentLines(auto) > 0, 'auto 模式下 ⚡ 用强调色')
  assert.equal(accentLines(icon), 0, 'icon 模式下 ⚡ 不该有强调色')
  assert.ok(hoverFills(auto) > hoverFills(icon), 'auto 模式下 ⚡ 底部有高亮底')
  // 老状态对象没有 mode 时按 auto 处理（兼容）
  const legacy = createFakePainter()
  paintCard(legacy, 408, 195, cardData({ mode: undefined }), 1)
  assert.ok(accentLines(legacy) > 0)
})

test('渲染前把 \\r\\n / \\r 归一化成 \\n：UIA 的行分隔符不能把分段挤成一行', () => {
  // 归一化函数本身：三种行分隔符统一成 \n，非字符串当空串
  assert.equal(normalizeLineBreaks('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'].join('\n'))
  assert.equal(normalizeLineBreaks(undefined), '')

  // 走一遍真 paintCard：正文必须拿到归一化后的文本（`\r` 在排版里不是换行，只会被画成同一行）
  const painter = createFakePainter()
  paintCard(painter, 408, 300, cardData({ text: '第一段。\r\n第二段。\r第三段。' }), 1)
  const body = painter.calls.paragraph.at(-1)
  assert.equal(body.text.includes('\r'), false)
  assert.equal(body.text, ['第一段。', '第二段。', '第三段。'].join('\n'))

  // 分段文本应当比挤成一行更高 —— 证明换行真的参与排版，而不是被当普通字符
  const oneLine = paintCard(createFakePainter(), 408, 300, cardData({ text: '第一段。第二段。第三段。' }), 1)
  const broken = paintCard(createFakePainter(), 408, 300, cardData({ text: '第一段。\r第二段。\r第三段。' }), 1)
  assert.ok(broken.contentHeight > oneLine.contentHeight)
})

test('卡片宽度可拖：cardW 影响窗口宽、正文宽与右缘按钮位置，并夹在 [minWidth, maxWidth]', () => {
  const dflt = cardLayout(CARD.bodyLine)
  const wide = cardLayout(CARD.bodyLine, { cardW: 600 })

  assert.equal(dflt.card.w, CARD.width)
  assert.equal(wide.windowW, 600 + CARD.shadow * 2)
  assert.equal(wide.text.w, 600 - CARD.padX * 2)
  assert.equal(wide.hitClose.x, wide.card.x + 600 - CARD.edge - CARD.iconBox)
  assert.equal(wide.bodyH, dflt.bodyH) // 宽度不改变高度（高度只由内容多少决定）
  // 上下限夹取
  assert.equal(cardLayout(CARD.bodyLine, { cardW: 10 }).card.w, CARD.minWidth)
  assert.equal(cardLayout(CARD.bodyLine, { cardW: 99999 }).card.w, CARD.maxWidth)
})

test('paintCard 按窗口实际宽度排版：拖宽后正文跟着重排', () => {
  const painter = createFakePainter()
  const measured = paintCard(painter, 600 + CARD.shadow * 2, 300, cardData(), 1)
  assert.equal(measured.cardW, 600)
  assert.equal(painter.calls.paragraph.at(-1).w, 600 - CARD.padX * 2)

  // 窗口比下限还窄 → 按下限排版并回写真实宽度，免得和窗口尺寸来回抖
  const narrow = paintCard(createFakePainter(), 120, 300, cardData(), 1)
  assert.equal(narrow.cardW, CARD.minWidth)
})

test('头部悬浮提示：文案写"点击后的动作"，语言下拉展开时不显示', () => {
  assert.deepEqual(headerTooltip({ hover: 'bolt', mode: 'auto' }), { id: 'bolt', text: '关闭即划即译' })
  assert.deepEqual(headerTooltip({ hover: 'bolt', mode: 'icon' }), { id: 'bolt', text: '即划即译' })
  assert.deepEqual(headerTooltip({ hover: 'pin', pinned: false }), { id: 'pin', text: '置顶' })
  assert.deepEqual(headerTooltip({ hover: 'pin', pinned: true }), { id: 'pin', text: '取消置顶' })
  // 其它 hover 区域不弹；语言下拉展开时也不弹（菜单是覆盖层，会打架）
  assert.equal(headerTooltip({ hover: 'close', mode: 'auto' }), null)
  assert.equal(headerTooltip({ hover: 'bolt', mode: 'auto', langOpen: true }), null)
})

test('悬浮提示框：贴在按钮正下方、水平居中、夹在卡片内', () => {
  const layout = cardLayout(CARD.bodyLine)
  const t = CARD.tooltip
  for (const [id, hit] of [['bolt', layout.hitBolt], ['pin', layout.hitPin]]) {
    const rect = tooltipRect(layout, id, 76) // 「关闭即划即译」的近似净宽
    assert.equal(rect.y, hit.y + hit.h + t.gap)
    assert.equal(rect.h, t.height)
    assert.equal(rect.w, 76 + t.padX * 2)
    // 必须完整落在卡片内（否则会画出卡片/窗口）
    assert.ok(rect.x >= layout.card.x + CARD.edge)
    assert.ok(rect.x + rect.w <= layout.card.x + layout.card.w - CARD.edge)
    // 未触边时水平居中（允许 1 DIP 的取整误差）
    const centerDelta = Math.abs(rect.x + rect.w / 2 - (hit.x + hit.w / 2))
    const clamped = rect.x === layout.card.x + CARD.edge || rect.x + rect.w === layout.card.x + layout.card.w - CARD.edge
    assert.ok(clamped || centerDelta <= 0.5)
  }
})

test('绘制：悬停 ⚡/📌 会画出提示文字，其它区域/下拉展开时不画', () => {
  const textsOf = (data) => {
    const painter = createFakePainter()
    const layout = cardLayout(CARD.bodyLine, { cardW: data.cardW })
    paintCard(painter, layout.windowW, layout.windowH, cardData(data), 1)
    return painter.calls.text.map((call) => call.text)
  }
  assert.ok(textsOf({ hover: 'bolt', mode: 'auto' }).includes('关闭即划即译'))
  assert.ok(textsOf({ hover: 'bolt', mode: 'icon' }).includes('即划即译'))
  assert.ok(textsOf({ hover: 'pin', pinned: false }).includes('置顶'))
  assert.ok(textsOf({ hover: 'pin', pinned: true }).includes('取消置顶'))
  // 悬停别处 / 下拉展开时没有提示
  const elsewhere = textsOf({ hover: 'close' })
  assert.equal(elsewhere.includes('置顶'), false)
  assert.equal(elsewhere.includes('关闭即划即译'), false)
  const menuOpen = textsOf({ hover: 'bolt', mode: 'auto', langOpen: true })
  assert.equal(menuOpen.includes('关闭即划即译'), false)
})
