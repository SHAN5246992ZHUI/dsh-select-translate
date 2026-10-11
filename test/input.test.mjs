/**
 * `companion/input.mjs` —— 点是否落在卡片内、按键按下边沿。
 *
 * 前者决定"点别处即关"能不能生效（卡片窗口比卡片本体大一圈阴影，用窗口矩形判就永远关不掉）；
 * 后者决定按住 Esc 会不会一秒触发 25 次。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARD, cardLayout } from '../companion/card.mjs'
import { createEdgeDetector, pointInCardRect } from '../companion/input.mjs'

const LAYOUT = cardLayout(CARD.bodyLine)
const ORIGIN = { x: 1000, y: 500 }
/** 屏幕物理坐标 = 窗口原点 + 卡片内 DIP 坐标（scale=1）。 */
const at = (dipX, dipY) => [ORIGIN.x + dipX, ORIGIN.y + dipY]

test('卡片本体之内（含边界）算"在卡片上"', () => {
  const box = LAYOUT.card
  assert.equal(pointInCardRect(...at(box.x + 10, box.y + 10), ORIGIN, 1, LAYOUT), true)
  assert.equal(pointInCardRect(...at(box.x, box.y), ORIGIN, 1, LAYOUT), true)
  assert.equal(pointInCardRect(...at(box.x + box.w, box.y + box.h), ORIGIN, 1, LAYOUT), true)
  assert.equal(pointInCardRect(...at(box.x + box.w / 2, box.y + box.h / 2), ORIGIN, 1, LAYOUT), true)
})

test('阴影外扩那圈不算"在卡片上"——否则点在阴影上会被当成点卡片，卡片关不掉', () => {
  const box = LAYOUT.card
  // 窗口比卡片本体大 CARD.shadow 一圈
  assert.equal(LAYOUT.windowW, CARD.width + CARD.shadow * 2)
  assert.equal(pointInCardRect(...at(box.x - 1, box.y + 10), ORIGIN, 1, LAYOUT), false)
  assert.equal(pointInCardRect(...at(box.x + 10, box.y - 1), ORIGIN, 1, LAYOUT), false)
  assert.equal(pointInCardRect(...at(box.x + box.w + 1, box.y + 10), ORIGIN, 1, LAYOUT), false)
  assert.equal(pointInCardRect(...at(box.x + 10, box.y + box.h + 1), ORIGIN, 1, LAYOUT), false)
  // 窗口左上角那一点（纯阴影区）
  assert.equal(pointInCardRect(ORIGIN.x, ORIGIN.y, ORIGIN, 1, LAYOUT), false)
})

test('125% 缩放：物理坐标先除以该屏缩放再比', () => {
  const s = 1.25
  const origin = { x: 0, y: 0 }
  const box = LAYOUT.card
  assert.equal(pointInCardRect(box.x * s, box.y * s, origin, s, LAYOUT), true)
  assert.equal(pointInCardRect(box.x * s - 0.5, box.y * s, origin, s, LAYOUT), false)
  assert.equal(pointInCardRect((box.x + box.w) * s, (box.y + box.h) * s, origin, s, LAYOUT), true)
  assert.equal(pointInCardRect((box.x + box.w) * s + 1, (box.y + box.h) * s, origin, s, LAYOUT), false)
})

test('缩放值不合法时按 1 处理（不返回 NaN 判定）', () => {
  const origin = { x: 0, y: 0 }
  const box = LAYOUT.card
  for (const bad of [0, -1, Number.NaN, undefined]) {
    assert.equal(pointInCardRect(box.x + 5, box.y + 5, origin, bad, LAYOUT), true)
  }
})

test('按下边沿：按住只算一次，松开后再按才算第二次', () => {
  const isEdge = createEdgeDetector()
  assert.equal(isEdge(true), true)
  assert.equal(isEdge(true), false)
  assert.equal(isEdge(true), false)
  assert.equal(isEdge(false), false)
  assert.equal(isEdge(false), false)
  assert.equal(isEdge(true), true)
  assert.equal(isEdge(false), false)
  assert.equal(isEdge(true), true)
})

test('按下边沿：从没按过时返回 false', () => {
  const isEdge = createEdgeDetector()
  assert.equal(isEdge(false), false)
  assert.equal(isEdge(false), false)
})
