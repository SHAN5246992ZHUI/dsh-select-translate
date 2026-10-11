/**
 * `companion/native/gdi.mjs` 的 `paragraph` / `tokenize` —— 交接文档 §6「文字排版」那四条。
 *
 * 这块代码我修了三轮，所以这里钉得最细。做法是**用假 koffi 驱动真代码**：
 * `createGdi(koffi)` 本来就把 koffi 当参数收，于是不需要改生产代码，
 * `tokenize` / `cjkAdvance` / `paragraph` 就能在普通 Node 里跑。
 *
 * 假度量复刻的是真实 GDI+ 行为（值来自伴生进程 `/measure` 端点实测）：
 *   size = 18.75 → cjk1 = 25.552, cjk8 = 160.712
 *   ⇒ 净推进 = (160.712 − 25.552)/7 = 19.309 = size × 1.0298
 *   ⇒ 前导边距 = 25.552 − 19.309 = 6.244 = size / 3      ← 「布局盒多算一份边距」
 * 所以盒宽 = 净推进 × n + 边距；`paragraph` 里那几行扣边距/补 em 的补偿就是冲它去的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGdi } from '../companion/native/gdi.mjs'
import { createFakeKoffi } from './support/fake-koffi.mjs'
import { advanceWidth } from './support/metrics.mjs'

/** 卡片正文的实测参数：字号 15、行高 25、可用宽 344（380 − 18×2）。 */
const SIZE = 15
const LINE = 25
const BODY_W = 344

/** 建一个真 painter（GDI+ 全部由假 koffi 顶），并把 measure/text 包一层记录。 */
function setup() {
  const koffi = createFakeKoffi()
  const gdi = createGdi(koffi)
  const painter = gdi.painterFromHdc({ fake: true })
  assert.notEqual(painter, null)

  const measures = []
  const draws = []
  const rawMeasure = painter.measure.bind(painter)
  const rawText = painter.text.bind(painter)
  painter.measure = (text, style = {}) => {
    const box = rawMeasure(text, style)
    measures.push({ text, size: style.size ?? 14, bold: style.bold, mono: style.mono, width: box.width })
    return box
  }
  painter.text = (text, x, y, w, h, style = {}) => {
    draws.push({ text, x, y, w, h, size: style.size ?? 14, bold: style.bold, mono: style.mono, color: style.color })
    return rawText(text, x, y, w, h, style)
  }
  return { painter, measures, draws }
}

const paint = (painter, text, options = {}) =>
  painter.paragraph(text, 0, 0, options.width ?? BODY_W, { size: SIZE, lineHeight: LINE, ...options })

test('CJK 每行容量：宽 344 / 字号 15 时，第一行排 22 个字', () => {
  const { painter, draws } = setup()
  const height = paint(painter, '中'.repeat(45))

  // 22 + 22 + 1
  assert.deepEqual(
    draws.map((draw) => draw.text.length),
    [22, 22, 1],
  )
  assert.equal(height, LINE * 3)
  assert.deepEqual(
    draws.map((draw) => draw.y),
    [0, LINE, LINE * 2],
  )
})

test('CJK 逐字成 token，但必须合并成整行再绘制（否则中文字之间像插了空格）', () => {
  const { painter, draws } = setup()
  paint(painter, '中'.repeat(45))

  // 45 个字只出 3 次 DrawString：逐字画会有 45 次。
  assert.equal(draws.length, 3)
  assert.equal(
    draws.reduce((sum, draw) => sum + draw.text.length, 0),
    45,
  )
})

test('绘制矩形比净宽多留一个 em：给紧了 GDI+ 会在行尾冒省略号', () => {
  const { painter, draws } = setup()
  paint(painter, '中'.repeat(45))

  // 这条是"推进量标定"的哨兵：把 cjkAdvance 换成 measure('中'×8)/8（虚增一个边距）后，
  // run.width 每个字都多算一份边距，本断言立刻失败——而**行容量不受影响**，
  // 因为断行是由"真去量整行"决定的（见下一条）。验证过：变异测试只挂这一条。
  for (const draw of draws) {
    const net = advanceWidth(draw.text, SIZE)
    assert.ok(Math.abs(draw.w - (net + SIZE)) < 0.01, `第 ${draws.indexOf(draw) + 1} 行绘制宽度应是净宽+1em`)
    assert.equal(draw.h, LINE)
  }
})

test('换行边界要真去量整行：累加已溢出、整行实测仍放得下的那个字要留在上一行', () => {
  const { painter, draws } = setup()
  // 22 个字累加 = 339.87 > 339（触发断行判定），但整行实测 344.87 − 6 = 338.87 ≤ 339 → 放得下。
  // 少了"真去量整行 + 补回边距"这一步，第一行会只有 21 个字。
  paint(painter, '中'.repeat(30), { width: 339 })

  assert.equal(draws[0].text.length, 22)
  assert.equal(draws[1].text.length, 8)
})

test('行首禁则：句末标点不被挤到下一行行首，宁可悬挂出去', () => {
  const { painter, draws } = setup()
  paint(painter, '中'.repeat(10) + '，尾', { width: 160 })

  assert.equal(draws.length, 2)
  assert.equal(draws[0].text, '中'.repeat(10) + '，')
  assert.equal(draws[1].text, '尾')
  const NO_LINE_START = /^[，。、；：？！）】》」』”’…—·,.?!:;)\]}>]+$/
  for (const draw of draws) assert.equal(NO_LINE_START.test(draw.text), false)
})

test('显式换行 \\n 强制断行，且空行也占一行高', () => {
  const { painter, draws } = setup()
  const height = paint(painter, 'ab\ncd', { width: 1000 })

  assert.deepEqual(
    draws.map((draw) => [draw.text, draw.y]),
    [
      ['ab', 0],
      ['cd', LINE],
    ],
  )
  assert.equal(height, LINE * 2)
})

test('dryRun 只量不画，且高度与真画完全一致（不然卡片会跳）', () => {
  const { painter, draws } = setup()
  const text = '流式译文和 CJK 混排 mixed content 一起换行。'.repeat(4)

  const dry = paint(painter, text, { dryRun: true, maxHeight: Infinity })
  assert.equal(draws.length, 0)

  const wet = paint(painter, text)
  assert.equal(draws.length > 0, true)
  assert.equal(dry, wet)
})

test('maxHeight 截断：画满就停，返回已画高度（内部滚动靠它）', () => {
  const { painter, draws } = setup()
  const height = paint(painter, '中'.repeat(100), { maxHeight: 50 })

  assert.equal(height, 50)
  assert.equal(draws.length, 2)
})

test('空文本返回一行高（调用方另有"翻译中…"占位，不走这里）', () => {
  const { painter, draws } = setup()
  assert.equal(paint(painter, ''), LINE)
  assert.equal(draws.length, 0)
})

test('空格自成 token，ASCII 词与空格合成一次绘制', () => {
  const { painter, draws } = setup()
  paint(painter, 'The quick brown fox', { width: 1000 })

  assert.equal(draws.length, 1)
  assert.equal(draws[0].text, 'The quick brown fox')
})

test('粗体 **…** 与行内代码 `…` 各自成套，代码字号 = max(11, size−1)', () => {
  const { painter, draws, measures } = setup()
  paint(painter, '**粗**`code`', { width: 1000 })

  assert.equal(draws.length, 2)
  assert.equal(draws[0].text, '粗')
  assert.equal(draws[0].bold, true)
  assert.equal(draws[1].text, 'code')
  assert.equal(draws[1].mono, true)
  assert.equal(draws[1].size, SIZE - 1)
  assert.equal(
    measures.some((entry) => entry.mono === true && entry.size === SIZE - 1),
    true,
  )
})

test('行内代码字号下限 11（小字号时不缩到看不见）', () => {
  const { painter, draws } = setup()
  painter.paragraph('`code`', 0, 0, 1000, { size: 11, lineHeight: 20 })

  assert.equal(draws.length, 1)
  assert.equal(draws[0].size, 11)
})

test('长英文段落不会因为"每个 token 重复计一次边距"而提前断行', () => {
  const { painter, draws } = setup()
  const words = Array.from({ length: 40 }, (_, index) => 'word' + index).join(' ')
  paint(painter, words)

  // 逐 token 累加会虚增（每个 token 多一份边距）；真去量整行才是判据。
  // 所以这里只要求"所有行都真的放得下"：每行净宽 + 边距 − 0.4em ≤ 可用宽。
  for (const draw of draws) {
    assert.ok(advanceWidth(draw.text, SIZE) + SIZE / 3 - SIZE * 0.4 <= BODY_W + 0.01)
  }
  assert.ok(draws.length > 1)
})
