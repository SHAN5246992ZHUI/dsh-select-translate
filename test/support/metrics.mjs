/**
 * 假字体度量：为了让排版代码能在**没有 GDI+** 的环境里被单测。
 *
 * 这里刻意复刻 GDI+ `MeasureString` 那个反直觉的真实行为（交接文档 §6 第 11 条）：
 * 它返回的是**布局盒**，会把一份前导边距也算进去。
 *
 * 实测（`/measure` 端点，size = 18.75）：
 *   单字盒宽 25.55  ← advance(18.75×1.0299=19.31) + bearing(6.25)
 *   净推进   19.31  ← (盒宽('中'×8) − 盒宽('中')) / 7
 *
 * 也就是 **盒宽 = 净推进 × n + 边距**，边距 ≈ size/3。
 * 复刻它才有意义：`paragraph` 里那几行"扣边距/补 em"的补偿就是为它写的；
 * 用"盒宽 = 净推进 × n"的简化模型测，那些补偿分支永远不会被走到。
 */
export const FONT_METRICS = {
  /** 相对 size 的净推进量。 */
  cjkAdvance: 1.0299,
  asciiAdvance: 0.55,
  spaceAdvance: 0.28,
  /** 相对 size 的前导边距（MeasureString 的布局盒比净推进多的那一份）。 */
  bearing: 1 / 3,
  /** 盒高 ≈ size × 1.4。 */
  lineFactor: 1.4,
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 单个字形的净推进量。 */
export function advanceOf(char, size, style = {}) {
  const mono = style.mono === true
  if (char === ' ') return size * FONT_METRICS.spaceAdvance
  if (mono) return size * 0.6
  return size * (CJK.test(char) ? FONT_METRICS.cjkAdvance : FONT_METRICS.asciiAdvance)
}

/** 一行文本的**布局盒**宽度（= 净推进量之和 + 一份前导边距）。 */
export function measureWidth(text, size, style = {}) {
  let advance = 0
  for (const char of String(text)) {
    if (char === '\n') continue
    advance += advanceOf(char, size, style)
  }
  return advance + size * FONT_METRICS.bearing
}

/** 布局盒高度。 */
export function measureHeight(size) {
  return size * FONT_METRICS.lineFactor
}

/** 纯净推进量（不含边距）——断言用。 */
export function advanceWidth(text, size, style = {}) {
  return measureWidth(text, size, style) - size * FONT_METRICS.bearing
}
