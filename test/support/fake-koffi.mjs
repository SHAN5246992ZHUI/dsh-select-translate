/**
 * 假 koffi：把 `createGdi(koffi)` 注入成一个可控的 GDI+。
 *
 * `createGdi` 本来就把 koffi 当参数收（那是它唯一的外部依赖），所以这里不需要改
 * 生产代码——只要给一个实现了 `load()` / `struct()` 的假对象，`paragraph` /
 * `tokenize` / `cjkAdvance` 这些**真代码**就能在普通 Node 里跑起来。
 *
 * 所有 `Gdip*` 出参都按 GDI+ 语义填：`_Out_` 指针在 koffi 里就是可写的 JS 对象/
 * 类型化数组，生产代码读的是 `box.Width` 这类属性，这里照填即可。
 */
import { advanceOf, measureHeight, measureWidth } from './metrics.mjs'

/** 从 koffi 风格签名里取出函数名：`'int GdipMeasureString(...)'` → `'GdipMeasureString'`。 */
export function funcName(signature) {
  const match = /([A-Za-z_]\w*)\s*\(/.exec(String(signature))
  return match === null ? '' : match[1]
}

/**
 * @param options.measure - 覆盖度量：`(text, size, style) => 布局盒宽度`。
 * @returns 假 koffi + `log`（记录了建字体、量文本、真正绘制的每一次调用）。
 */
export function createFakeKoffi(options = {}) {
  const measure = options.measure ?? ((text, size, style) => measureWidth(text, size, style))
  const log = { createFont: [], measure: [], draw: [] }

  const stubs = {
    GdiplusStartup: (token) => {
      if (token !== undefined && token !== null) token[0] = 1n
      return 0
    },
    GdiplusShutdown: () => 0,
    GdipCreateFromHDC: (hdc, out) => {
      out[0] = { hdc }
      return 0
    },
    GdipCreateSolidFill: (color, out) => {
      out[0] = { color }
      return 0
    },
    GdipCreatePen1: (color, width, unit, out) => {
      out[0] = { color, width, unit }
      return 0
    },
    GdipCreateFontFamilyFromName: (name, collection, out) => {
      out[0] = { name: String(name) }
      return 0
    },
    GdipCreateFont: (family, size, style, unit, out) => {
      const font = { family, size, bold: style === 1, unit }
      log.createFont.push(font)
      out[0] = font
      return 0
    },
    GdipCreateStringFormat: (attributes, language, out) => {
      out[0] = { attributes, language }
      return 0
    },
    GdipMeasureString: (graphics, text, length, font, rect, format, box, fitted, lines) => {
      const width = measure(String(text), font.size, font)
      box.X = 0
      box.Y = 0
      box.Width = width
      box.Height = measureHeight(font.size)
      if (fitted !== undefined && fitted !== null) fitted[0] = 1
      if (lines !== undefined && lines !== null) lines[0] = 1
      log.measure.push({ text: String(text), size: font.size, width })
      return 0
    },
    GdipDrawString: (graphics, text, length, font, rect, format, brush) => {
      log.draw.push({ text: String(text), font, rect: { ...rect }, brush })
      return 0
    },
    GdipCreatePath: (mode, out) => {
      out[0] = { mode }
      return 0
    },
  }

  const module = {
    func(signature) {
      const name = funcName(signature)
      const stub = stubs[name]
      if (stub === undefined) return () => 0
      return stub
    },
  }

  return {
    log,
    /** 与 koffi 同形的接口。 */
    load: () => module,
    struct: (name, fields) => ({ name, fields }),
    /** 断言用：某段文本被真正画出来的次数。 */
    drawnTexts: () => log.draw.map((entry) => entry.text),
    /** 断言用：净推进量（不含前导边距）。 */
    advanceOf,
  }
}
