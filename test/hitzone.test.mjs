/**
 * `companion/hitzone.mjs` —— 窗口命中区。
 *
 * 两条都是实测踩出来的（交接文档 §6 第 7、9 条）：
 *  - `HTCAPTION` 区域永远收不到 `WM_LBUTTONDOWN` → 按钮必须从标题栏区排除；
 *  - 卡片四周的阴影外扩是半透明像素，会吞点击 → 卡片之外必须返回 `transparent`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARD, cardLayout } from '../companion/card.mjs'
import { hitZone } from '../companion/hitzone.mjs'

const data = (patch = {}) => ({ bodyHeight: CARD.bodyLine, langOpen: false, langW: 115, copyW: 65, retryW: 65, ...patch })
const center = (rect) => [rect.x + rect.w / 2, rect.y + rect.h / 2]

test('卡片之外（阴影外扩那一圈）返回 transparent，把点击交还给下面的应用', () => {
  const layout = cardLayout(CARD.bodyLine)
  const card = layout.card

  assert.equal(hitZone(card.x - 5, card.y + 10, data()), 'transparent')
  assert.equal(hitZone(card.x + card.w + 5, card.y + 10, data()), 'transparent')
  assert.equal(hitZone(card.x + 10, card.y - 5, data()), 'transparent')
  assert.equal(hitZone(card.x + 10, card.y + card.h + 5, data()), 'transparent')
  // 窗口左上角那个角（阴影区）也不行
  assert.equal(hitZone(0, 0, data()), 'transparent')
})

test('六个按钮都返回 hand（客户区，要能收到点击）', () => {
  const layout = cardLayout(CARD.bodyLine, { langW: 115, copyW: 65, retryW: 65 })
  const cases = [layout.hitClose, layout.hitPin, layout.hitBolt, layout.hitLang, layout.hitCopy, layout.hitRetry]
  for (const rect of cases) {
    const [x, y] = center(rect)
    assert.equal(hitZone(x, y, data()), 'hand')
  }
})

test('头部空白返回 caption：能按住拖动，但按钮区绝不落进 caption', () => {
  const layout = cardLayout(CARD.bodyLine, { langW: 115 })
  // 图标盒上方的 8px 留白（headerH 44 / iconBox 28 → 上下各 8）
  assert.equal(hitZone(layout.card.x + 200, layout.card.y + 2, data()), 'caption')
  // 语言按钮与即划即译按钮之间的空档
  assert.equal(hitZone(layout.hitLang.x + layout.hitLang.w + 2, layout.hitLang.y + 10, data()), 'caption')
  // 按钮中心依然是 hand（顺序不能反）
  assert.equal(hitZone(...center(layout.hitBolt), data()), 'hand')
})

test('正文区返回 client', () => {
  const layout = cardLayout(CARD.bodyLine)
  assert.equal(hitZone(layout.text.x + 20, layout.text.y + 10, data()), 'client')
})

test('下拉展开时整块算 client：否则点不到菜单行（菜单是覆盖层）', () => {
  const layout = cardLayout(CARD.bodyLine, { langW: 115 })
  const open = data({ langOpen: true })
  assert.equal(hitZone(layout.card.x + 200, layout.card.y + 2, open), 'client')
  assert.equal(hitZone(...center(layout.hitClose), open), 'client')
  // 卡片之外仍然穿透
  assert.equal(hitZone(layout.card.x - 5, layout.card.y + 10, open), 'transparent')
})

test('命中区跟着 data.bodyHeight 走（卡片被译文撑高后，页脚按钮下移）', () => {
  const small = cardLayout(CARD.bodyLine)
  const tall = cardLayout(100)
  const smallFoot = center(small.hitCopy)
  const tallFoot = center(tall.hitCopy)

  assert.notDeepEqual(smallFoot, tallFoot)
  assert.equal(hitZone(...tallFoot, data({ bodyHeight: 100 })), 'hand')
  // 同一坐标在小卡片上已经跑到卡片之外了
  assert.equal(hitZone(...tallFoot, data()), 'transparent')
})

test('边界：卡片左上角算卡片内（caption），右下角算 client', () => {
  const layout = cardLayout(CARD.bodyLine)
  const card = layout.card
  assert.equal(hitZone(card.x, card.y, data()), 'caption')
  assert.equal(hitZone(card.x + card.w, card.y + card.h, data()), 'client')
})

test('约定：入参是 DIP 坐标（调用方先除以 data.scale），传物理坐标不该命中按钮', () => {
  const layout = cardLayout(CARD.bodyLine, { langW: 115 })
  const [x, y] = center(layout.hitClose)
  assert.equal(hitZone(x, y, data()), 'hand')
  // main.mjs 的写法是 hitZone(x / data.scale, y / data.scale, data)
  assert.equal(hitZone(x * 1.25, y * 1.25, data()), 'transparent')
  assert.equal(hitZone((x * 1.25) / 1.25, (y * 1.25) / 1.25, data()), 'hand')
})
