/**
 * 记录型假 painter：驱动 `card.mjs` 的 `paintCard`（真代码）。
 *
 * `paintCard` 只通过 painter 接口碰系统，所以这里给一个"什么都画、但把每次调用都记下来"
 * 的实现，就能断言布局与命中相关的**可观察行为**：正文区拿到的绘制矩形、裁剪矩形、
 * 按钮宽度回写值、错误态颜色等。
 *
 * 注意 `paragraph` 在这里是**测试替身**（简单贪心断行），不是被测对象——
 * 真正的换行实现由 `test/text-layout.test.mjs` 用假 koffi 驱动 `gdi.mjs` 来测。
 */
import { advanceOf, measureHeight, measureWidth } from './metrics.mjs'

/** 测试替身用的极简贪心断行（只用来给出"文本越长越高"的稳定行为）。 */
function wrapLines(text, width, size, style) {
  let total = 0
  for (const line of String(text).split('\n')) {
    let advance = 0
    let count = 1
    for (const char of line) {
      advance += advanceOf(char, size, style)
      if (advance > width) {
        count += 1
        advance = advanceOf(char, size, style)
      }
    }
    total += count
  }
  return total
}

/** @returns 假 painter + `calls`（逐类记录）。 */
export function createFakePainter() {
  const calls = { measure: [], paragraph: [], text: [], shape: [], clip: [] }

  return {
    calls,
    measure(text, style = {}) {
      const size = style.size ?? 14
      calls.measure.push({ text, ...style })
      return { width: measureWidth(text, size, style), height: measureHeight(size) }
    },
    paragraph(text, x, y, w, options = {}) {
      const size = options.size ?? 14
      const lineHeight = options.lineHeight ?? Math.round(size * 1.55)
      const maxHeight = options.maxHeight ?? Infinity
      calls.paragraph.push({ text, x, y, w, ...options })
      const lines = Math.max(1, wrapLines(text, w, size, options))
      return Math.min(maxHeight, lines * lineHeight)
    },
    text(text, x, y, w, h, style = {}) {
      calls.text.push({ text, x, y, w, h, ...style })
    },
    fillRoundRect(x, y, w, h, r, color) {
      calls.shape.push({ op: 'fillRoundRect', x, y, w, h, r, color })
    },
    strokeRoundRect(x, y, w, h, r, color, width) {
      calls.shape.push({ op: 'strokeRoundRect', x, y, w, h, r, color, width })
    },
    fillRect(x, y, w, h, color) {
      calls.shape.push({ op: 'fillRect', x, y, w, h, color })
    },
    line(x1, y1, x2, y2, color, width) {
      calls.shape.push({ op: 'line', x1, y1, x2, y2, color, width })
    },
    strokeEllipse(x, y, w, h, color, width) {
      calls.shape.push({ op: 'strokeEllipse', x, y, w, h, color, width })
    },
    fillCircle(x, y, size, color) {
      calls.shape.push({ op: 'fillCircle', x, y, width: size, color })
    },
    fillPolygon(points, color) {
      calls.shape.push({ op: 'fillPolygon', points, color })
    },
    setClip(x, y, w, h) {
      calls.clip.push({ op: 'setClip', x, y, w, h })
    },
    resetClip() {
      calls.clip.push({ op: 'resetClip' })
    },
  }
}
