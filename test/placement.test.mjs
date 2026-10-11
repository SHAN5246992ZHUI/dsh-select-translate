/**
 * `companion/placement.mjs` —— 卡片落位：右下偏移 12 → 越界翻转 → 夹进工作区。
 *
 * 对应方案 §3「跟随鼠标、越界自动翻转、跨显示器按该屏 DPI 换算」。
 * 这里的数值都是手算的，故意写死：翻转判据里有两个"看着像笔误"的表达式，
 * 悄悄化简就会改变落位，必须被拦下来。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARD, TRIGGER, TRIGGER_WINDOW } from '../companion/card.mjs'
import { ANCHOR_GAP, clampWindowToWork, computePlacement } from '../companion/placement.mjs'

/** 单屏 2560×1600、125% 缩放，任务栏占底部 40px。 */
const WORK = { left: 0, top: 0, right: 2560, bottom: 1560 }
/** 最小卡片的窗口尺寸（含阴影外扩）：卡高 139 + 28。 */
const MIN_H = CARD.headerH + CARD.bodyLine + CARD.padY * 2 + CARD.footerH
const WINDOW_W = CARD.width + CARD.shadow * 2
const WINDOW_H = MIN_H + CARD.shadow * 2

test('默认：落在锚点右下 12 处，且锚点算的是"卡片本体"的角（要减掉阴影外扩）', () => {
  assert.equal(ANCHOR_GAP, 12)
  const { x, y } = computePlacement({ anchor: { x: 400, y: 300 }, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.deepEqual({ x, y }, { x: 400 + 12 - CARD.shadow, y: 300 + 12 - CARD.shadow })
})

test('贴右边缘：翻到锚点左侧，且整窗不越出工作区', () => {
  const { x, y } = computePlacement({ anchor: { x: 2500, y: 300 }, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.equal(x, 2500 - 12 - WINDOW_W + CARD.shadow)
  assert.equal(y, 300 + 12 - CARD.shadow)
  assert.ok(x + WINDOW_W <= WORK.right - CARD.edge)
})

test('贴下边缘：翻到锚点上方', () => {
  const { x, y } = computePlacement({ anchor: { x: 400, y: 1500 }, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.equal(x, 400 + 12 - CARD.shadow)
  assert.equal(y, 1500 - 12 - WINDOW_H + CARD.shadow)
  assert.ok(y + WINDOW_H <= WORK.bottom - CARD.edge)
})

test('锚点极其靠右下：翻转之后仍要夹回工作区内（不能跑到屏外）', () => {
  const { x, y } = computePlacement({ anchor: { x: 2559, y: 1599 }, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.equal(x, WORK.right - CARD.edge - WINDOW_W)
  assert.equal(y, WORK.bottom - CARD.edge - WINDOW_H)
})

test('125% 缩放：间隔与阴影都按取整后的物理像素算', () => {
  const s = 1.25
  const windowW = Math.round(WINDOW_W * s)
  const windowH = Math.round(WINDOW_H * s)
  const { x, y } = computePlacement({ anchor: { x: 400, y: 300 }, work: WORK, s, windowW, windowH })
  assert.equal(x, 400 + Math.round(ANCHOR_GAP * s) - Math.round(CARD.shadow * s))
  assert.equal(y, 300 + Math.round(ANCHOR_GAP * s) - Math.round(CARD.shadow * s))
})

test('第二块屏在左边（负坐标）：按该屏工作区落位，不炸', () => {
  const work = { left: -1920, top: -200, right: 0, bottom: 880 }
  const { x, y } = computePlacement({ anchor: { x: -1800, y: 100 }, work, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.equal(x, -1800 + 12 - CARD.shadow)
  assert.equal(y, 100 + 12 - CARD.shadow)
})

test('工作区比卡片还小时：退回左上角内缩，而不是算出负坐标', () => {
  const work = { left: 0, top: 0, right: 300, bottom: 100 } // 两边都装不下
  const { x, y } = computePlacement({ anchor: { x: 1580, y: 1180 }, work, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.deepEqual({ x, y }, { x: CARD.edge, y: CARD.edge })
})

test('翻转阈值是严格大于：锚点 x=2146 不翻，2147 才翻', () => {
  // 右侧判据：x + shadow×2 + CARD.width > work.right − edge
  //           (2146+12−14) + 28 + 380 = 2552 → 不大于 2552 → 不翻
  //           (2147+12−14) + 28 + 380 = 2553 →  大于 2552 → 翻
  const noFlip = computePlacement({ anchor: { x: 2146, y: 300 }, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.equal(noFlip.x, 2146 + ANCHOR_GAP - CARD.shadow)

  const flip = computePlacement({ anchor: { x: 2147, y: 300 }, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.equal(flip.x, 2147 - ANCHOR_GAP - WINDOW_W + CARD.shadow)
})

/* ────────────────────────── 划词小图标复用同一套落位 ────────────────────────── */

const ICON_METRICS = { gap: TRIGGER.gap, shadow: TRIGGER.shadow, bodyWidth: TRIGGER.size }
const iconPlace = (anchor) =>
  computePlacement({ anchor, work: WORK, s: 1, windowW: TRIGGER_WINDOW, windowH: TRIGGER_WINDOW, metrics: ICON_METRICS })

test('小图标：用自己的 gap / shadow 落位（锚点右下 12、阴影外扩 10）', () => {
  const { x, y } = iconPlace({ x: 400, y: 300 })
  assert.deepEqual({ x, y }, { x: 400 + TRIGGER.gap - TRIGGER.shadow, y: 300 + TRIGGER.gap - TRIGGER.shadow })
})

test('小图标：贴右边缘同样翻转、并整窗夹回工作区', () => {
  const { x } = iconPlace({ x: 2540, y: 300 })
  assert.equal(x, 2540 - TRIGGER.gap - TRIGGER_WINDOW + TRIGGER.shadow)
  assert.ok(x + TRIGGER_WINDOW <= WORK.right - CARD.edge)
})

test('小图标比卡片小得多：同一个"贴右"锚点下，卡片翻到很左、图标还留在锚点旁', () => {
  const anchor = { x: 2540, y: 300 }
  const icon = iconPlace(anchor)
  const card = computePlacement({ anchor, work: WORK, s: 1, windowW: WINDOW_W, windowH: WINDOW_H })
  assert.ok(icon.x > card.x, `图标应留在锚点附近（${icon.x}），卡片则被推得更左（${card.x}）`)
})

/* ────────────────────────── 内容长高时只夹取、不重定位 ────────────────────────── */

test('clampWindowToWork：没越界就一个像素都不动（尊重用户拖动过的位置）', () => {
  const keep = clampWindowToWork({ x: 400, y: 300, windowW: 510, windowH: 959, work: WORK })
  assert.deepEqual(keep, { x: 400, y: 300 })
})

test('clampWindowToWork：长高的窗口越出下/右边缘时收回来，不动左上角的方向', () => {
  // 窗口底部越出工作区 → 顶边往上收
  const tall = clampWindowToWork({ x: 400, y: 1000, windowW: 510, windowH: 959, work: WORK })
  assert.equal(tall.x, 400)
  assert.equal(tall.y, WORK.bottom - CARD.edge - 959)
  assert.ok(tall.y < 1000)
  // 右边越出 → 左边往左收
  const wide = clampWindowToWork({ x: 2400, y: 300, windowW: 510, windowH: 959, work: WORK })
  assert.equal(wide.x, WORK.right - CARD.edge - 510)
  // 负坐标（第二块屏在左边）也一样能夹
  const negative = clampWindowToWork({ x: -4000, y: -4000, windowW: 510, windowH: 959, work: WORK })
  assert.deepEqual(negative, { x: CARD.edge, y: CARD.edge })
})

test('clampWindowToWork：工作区比窗口还小时退回内缩，不产生负坐标', () => {
  const work = { left: 0, top: 0, right: 300, bottom: 100 }
  const { x, y } = clampWindowToWork({ x: 50, y: 50, windowW: 510, windowH: 959, work })
  assert.deepEqual({ x, y }, { x: CARD.edge, y: CARD.edge })
})
