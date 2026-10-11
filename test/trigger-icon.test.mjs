/**
 * `card.mjs` 的划词小图标（第二个触发模式）。
 *
 * 视觉基准是 `client.js` 的 `.hc-mini`（24×24 圆、1px 边框、白底、globe 14px、hover 转强调色）。
 * 这里钉的是几何与命中：**圆内才是可点区，方窗口的四角必须穿透**（否则卡片窗口会吞掉
 * 下面应用的点击，就是 §6 第 9 条那个坑的小号版本）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { paintTriggerIcon, TRIGGER, TRIGGER_WINDOW, triggerIconHit, triggerIconLayout } from '../companion/card.mjs'
import { createFakePainter } from './support/fake-painter.mjs'

const COLOR = { bg: 0xff_ff_ff_ff, border: 0xff_e5_e9_f0, subtle: 0xff_67_71_83, accent: 0xff_4d_6b_fe }

test('图标常量与 client.js 的 .hc-mini 对齐：24 圆 / 1px 边框 / 14 glyph / 偏移 12', () => {
  assert.equal(TRIGGER.size, 24)
  assert.equal(TRIGGER.border, 1)
  assert.equal(TRIGGER.glyph, 14)
  assert.equal(TRIGGER.gap, 12)
  assert.equal(TRIGGER_WINDOW, TRIGGER.size + TRIGGER.shadow * 2)
})

test('布局：圆在窗口正中，四周是阴影外扩', () => {
  const layout = triggerIconLayout()
  assert.equal(layout.windowW, TRIGGER_WINDOW)
  assert.equal(layout.windowH, TRIGGER_WINDOW)
  assert.deepEqual(layout.circle, { x: TRIGGER.shadow, y: TRIGGER.shadow, w: 24, h: 24 })
  // 上下左右留的外扩一样宽
  assert.equal(layout.circle.x, layout.windowW - (layout.circle.x + layout.circle.w))
})

test('命中：圆内可点，方窗口的四角与边外必须穿透', () => {
  const layout = triggerIconLayout()
  const c = layout.circle
  const center = { x: c.x + c.w / 2, y: c.y + c.h / 2 }

  assert.equal(triggerIconHit(center.x, center.y), 'client')
  // 圆的四个极值点算命中（含边界）
  assert.equal(triggerIconHit(center.x, c.y), 'client')
  assert.equal(triggerIconHit(center.x, c.y + c.h), 'client')
  assert.equal(triggerIconHit(c.x, center.y), 'client')
  assert.equal(triggerIconHit(c.x + c.w, center.y), 'client')
  // 圆外接矩形的四个角不是圆 → 必须穿透
  assert.equal(triggerIconHit(c.x, c.y), 'transparent')
  assert.equal(triggerIconHit(c.x + c.w, c.y + c.h), 'transparent')
  // 窗口内但圆外的阴影区 / 窗口外
  assert.equal(triggerIconHit(1, 1), 'transparent')
  assert.equal(triggerIconHit(TRIGGER_WINDOW - 1, TRIGGER_WINDOW - 1), 'transparent')
  assert.equal(triggerIconHit(-5, center.y), 'transparent')
})

test('绘制：阴影多层 + 一个白圆 + 一圈边框 + 中间那颗 globe', () => {
  const painter = createFakePainter()
  paintTriggerIcon(painter, TRIGGER_WINDOW, TRIGGER_WINDOW, { iconHover: false }, 1)

  const circles = painter.calls.shape.filter((entry) => entry.op === 'fillCircle')
  // 注意：globe 自己也是用 strokeEllipse 画的，所以边框要按尺寸（24）认，不能只按 op
  const border = painter.calls.shape.filter((entry) => entry.op === 'strokeEllipse' && entry.w === TRIGGER.size)

  // 白圆就一个，尺寸是 24
  const white = circles.filter((entry) => entry.color === COLOR.bg)
  assert.equal(white.length, 1)
  assert.equal(white[0].width, TRIGGER.size)
  // 其余都是阴影层（半透明、比圆大）
  const shadows = circles.filter((entry) => entry.color !== COLOR.bg)
  assert.ok(shadows.length >= 2)
  for (const shadow of shadows) assert.ok(shadow.width > TRIGGER.size)

  assert.equal(border.length, 1)
  assert.equal(border[0].color, COLOR.border)
  assert.equal(border[0].w, TRIGGER.size)
  assert.equal(border[0].h, TRIGGER.size)

  // globe 用的是 16 单位画布的形状：一条外圈 + 一条经线 + 一条赤道线
  assert.ok(painter.calls.shape.some((entry) => entry.op === 'strokeEllipse' && entry.w !== TRIGGER.size))
  assert.ok(painter.calls.shape.some((entry) => entry.op === 'line'))
  assert.equal(painter.calls.text.length, 0, '图标里没有文字')
})

test('绘制：hover 时 globe 转强调色，平时是弱化色', () => {
  const idle = createFakePainter()
  paintTriggerIcon(idle, TRIGGER_WINDOW, TRIGGER_WINDOW, { iconHover: false }, 1)
  const hover = createFakePainter()
  paintTriggerIcon(hover, TRIGGER_WINDOW, TRIGGER_WINDOW, { iconHover: true }, 1)

  // globe 用 strokeEllipse 画圆（一个是外圈 12×12，一个是经线 5.4×12）
  const glyph = (painter) => painter.calls.shape.filter((entry) => entry.op === 'strokeEllipse' && entry.w !== TRIGGER.size)
  assert.equal(glyph(idle).length, 2)
  assert.ok(glyph(idle).every((entry) => entry.color === COLOR.subtle))
  assert.ok(glyph(hover).every((entry) => entry.color === COLOR.accent))
  // 边框颜色不受 hover 影响
  const borderColor = (painter) => painter.calls.shape.find((entry) => entry.op === 'strokeEllipse' && entry.w === TRIGGER.size).color
  assert.equal(borderColor(idle), COLOR.border)
  assert.equal(borderColor(hover), COLOR.border)
})

test('125% 缩放：圆与窗口一起放大（尺寸都是物理像素）', () => {
  const painter = createFakePainter()
  const s = 1.25
  paintTriggerIcon(painter, TRIGGER_WINDOW * s, TRIGGER_WINDOW * s, { iconHover: false }, s)

  const white = painter.calls.shape.find((entry) => entry.op === 'fillCircle' && entry.color === COLOR.bg)
  assert.equal(white.width, TRIGGER.size * s)
  assert.equal(white.x, TRIGGER.shadow * s)
})
