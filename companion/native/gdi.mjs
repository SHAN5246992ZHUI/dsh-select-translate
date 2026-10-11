/**
 * SPDX-License-Identifier: MIT
 * 本文件衍生自 dsh-selection-tools（MIT · Copyright (c) 2026 dsh-selection-tools contributors）
 *   https://github.com/fyisgod/dsh-selection-tools @ 3f292d92（v0.8.2）
 * 上游声明原文与逐文件改动说明：本插件根目录 THIRD-PARTY-NOTICES.md
 * 改动：文本渲染（token 合并 / 行尾省略号 / 行首禁则），见 NOTICES 1.1。
 */
/**
 * GDI+ 扁平 API 绑定 + 绘图助手。
 *
 * 浮层是一个**原生 Win32 窗口**：不依赖 Edge / 任何浏览器、不额外起进程，
 * 任何 Windows 上都能用。GDI+ 的 Gdip* 扁平 API 足够画圆角卡片、字体、换行文本。
 *
 * 单位：字体用 UnitPixel(2)，所有坐标与字号都是**物理像素**，调用方按显示器缩放换算。
 */

/** 颜色工具：'#rrggbb' + alpha → GDI+ 的 ARGB。 */
export function rgb(hex, alpha = 255) {
  const value = hex.replace('#', '')
  return (((alpha & 0xff) << 24) | (Number.parseInt(value.slice(0, 2), 16) << 16) | (Number.parseInt(value.slice(2, 4), 16) << 8) | Number.parseInt(value.slice(4, 6), 16)) >>> 0
}

/**
 * 建立 GDI+ 与绘图助手。
 * @param koffi - koffi 模块（与 win32.mjs 共用同一实例，避免结构体重名）。
 */
export function createGdi(koffi) {
  const gdiplus = koffi.load('gdiplus.dll')
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')

  const RECT = koffi.struct('DST_GDI_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const RectF = koffi.struct('DST_RectF', { X: 'float', Y: 'float', Width: 'float', Height: 'float' })
  const StartupInput = koffi.struct('DST_GdiplusStartupInput', {
    GdiplusVersion: 'uint32',
    DebugEventCallback: 'void *',
    SuppressBackgroundThread: 'int',
    SuppressExternalCodecs: 'int',
  })

  const gdip = {
    GdiplusStartup: gdiplus.func('int GdiplusStartup(_Out_ uintptr_t *token, DST_GdiplusStartupInput *input, void *output)'),
    GdiplusShutdown: gdiplus.func('void GdiplusShutdown(uintptr_t token)'),
    CreateFromHDC: gdiplus.func('int GdipCreateFromHDC(void *hdc, _Out_ void **graphics)'),
    DeleteGraphics: gdiplus.func('int GdipDeleteGraphics(void *graphics)'),
    SetSmoothingMode: gdiplus.func('int GdipSetSmoothingMode(void *graphics, int mode)'),
    SetTextRenderingHint: gdiplus.func('int GdipSetTextRenderingHint(void *graphics, int hint)'),
    CreateSolidFill: gdiplus.func('int GdipCreateSolidFill(uint32_t color, _Out_ void **brush)'),
    DeleteBrush: gdiplus.func('int GdipDeleteBrush(void *brush)'),
    CreatePen1: gdiplus.func('int GdipCreatePen1(uint32_t color, float width, int unit, _Out_ void **pen)'),
    DeletePen: gdiplus.func('int GdipDeletePen(void *pen)'),
    CreateFontFamilyFromName: gdiplus.func('int GdipCreateFontFamilyFromName(const char16_t *name, void *collection, _Out_ void **family)'),
    DeleteFontFamily: gdiplus.func('int GdipDeleteFontFamily(void *family)'),
    CreateFont: gdiplus.func('int GdipCreateFont(void *family, float size, int style, int unit, _Out_ void **font)'),
    DeleteFont: gdiplus.func('int GdipDeleteFont(void *font)'),
    CreateStringFormat: gdiplus.func('int GdipCreateStringFormat(int attributes, int language, _Out_ void **format)'),
    DeleteStringFormat: gdiplus.func('int GdipDeleteStringFormat(void *format)'),
    SetStringFormatAlign: gdiplus.func('int GdipSetStringFormatAlign(void *format, int align)'),
    SetStringFormatLineAlign: gdiplus.func('int GdipSetStringFormatLineAlign(void *format, int align)'),
    SetStringFormatFlags: gdiplus.func('int GdipSetStringFormatFlags(void *format, int flags)'),
    SetStringFormatTrimming: gdiplus.func('int GdipSetStringFormatTrimming(void *format, int trimming)'),
    DrawString: gdiplus.func('int GdipDrawString(void *graphics, const char16_t *text, int length, void *font, DST_RectF *rect, void *format, void *brush)'),
    MeasureString: gdiplus.func('int GdipMeasureString(void *graphics, const char16_t *text, int length, void *font, DST_RectF *rect, void *format, _Out_ DST_RectF *box, _Out_ int *fitted, _Out_ int *lines)'),
    FillRectangle: gdiplus.func('int GdipFillRectangle(void *graphics, void *brush, float x, float y, float w, float h)'),
    FillEllipse: gdiplus.func('int GdipFillEllipse(void *graphics, void *brush, float x, float y, float w, float h)'),
    CreatePath: gdiplus.func('int GdipCreatePath(int mode, _Out_ void **path)'),
    DeletePath: gdiplus.func('int GdipDeletePath(void *path)'),
    AddPathArc: gdiplus.func('int GdipAddPathArc(void *path, float x, float y, float w, float h, float start, float sweep)'),
    AddPathLine: gdiplus.func('int GdipAddPathLine(void *path, float x1, float y1, float x2, float y2)'),
    ClosePathFigure: gdiplus.func('int GdipClosePathFigure(void *path)'),
    FillPath: gdiplus.func('int GdipFillPath(void *graphics, void *brush, void *path)'),
    DrawPath: gdiplus.func('int GdipDrawPath(void *graphics, void *pen, void *path)'),
    DrawLine: gdiplus.func('int GdipDrawLine(void *graphics, void *pen, float x1, float y1, float x2, float y2)'),
    DrawEllipse: gdiplus.func('int GdipDrawEllipse(void *graphics, void *pen, float x, float y, float w, float h)'),
    SetClipRect: gdiplus.func('int GdipSetClipRect(void *graphics, float x, float y, float w, float h, int combineMode)'),
    ResetClip: gdiplus.func('int GdipResetClip(void *graphics)'),
  }

  // 注意：CreateCompatibleDC / BitBlt / SelectObject 都在 gdi32，不在 user32（踩过）。
  const native = {
    GetDC: user32.func('void *GetDC(void *hwnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
    GetClientRect: user32.func('int GetClientRect(void *hwnd, _Out_ DST_GDI_RECT *rect)'),
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    CreateCompatibleBitmap: gdi32.func('void *CreateCompatibleBitmap(void *hdc, int cx, int cy)'),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    DeleteDC: gdi32.func('int DeleteDC(void *hdc)'),
    DeleteObject: gdi32.func('int DeleteObject(void *obj)'),
    BitBlt: gdi32.func('int BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32_t rop)'),
    CreateSolidBrush: gdi32.func('void *CreateSolidBrush(uint32_t color)'),
  }

  const SRCCOPY = 0x00cc0020
  const fonts = new Map()
  const brushes = new Map()
  let families = null
  let token = 0
  let started = false

  /** 建立字体族（一次）：中文优先雅黑，回落 UI 字体，再回落 GDI+ 通用无衬线。 */
  function ensureFamilies() {
    if (families !== null) return families
    const build = (names) => {
      for (const name of names) {
        const out = [null]
        if (gdip.CreateFontFamilyFromName(name, null, out) === 0 && out[0] !== null) return out[0]
      }
      return null
    }
    families = {
      ui: build(['Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI']),
      mono: build(['Cascadia Mono', 'Consolas', 'Courier New']),
    }
    return families
  }

  /** 取/建一个字体（按像素）。 */
  function font(sizePx, { bold = false, mono = false } = {}) {
    const key = sizePx + '|' + (bold ? 'b' : '') + (mono ? 'm' : '')
    const cached = fonts.get(key)
    if (cached !== undefined) return cached
    const family = mono ? ensureFamilies().mono : ensureFamilies().ui
    if (family === null) return null
    const out = [null]
    // FontStyleBold = 1
    if (gdip.CreateFont(family, sizePx, bold ? 1 : 0, 2 /* UnitPixel */, out) !== 0) return null
    fonts.set(key, out[0])
    return out[0]
  }

  /** 取/建一个纯色画刷。 */
  function brush(color) {
    const cached = brushes.get(color)
    if (cached !== undefined) return cached
    const out = [null]
    if (gdip.CreateSolidFill(color, out) !== 0) return null
    brushes.set(color, out[0])
    return out[0]
  }

  /** 圆角矩形路径。 */
  function roundRectPath(x, y, w, h, r) {
    const out = [null]
    if (gdip.CreatePath(0, out) !== 0) return null
    const path = out[0]
    const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2))
    const d = radius * 2
    gdip.AddPathArc(path, x, y, d, d, 180, 90)
    gdip.AddPathLine(path, x + radius, y, x + w - radius, y)
    gdip.AddPathArc(path, x + w - d, y, d, d, 270, 90)
    gdip.AddPathLine(path, x + w, y + radius, x + w, y + h - radius)
    gdip.AddPathArc(path, x + w - d, y + h - d, d, d, 0, 90)
    gdip.AddPathLine(path, x + w - radius, y + h, x + radius, y + h)
    gdip.AddPathArc(path, x, y + h - d, d, d, 90, 90)
    gdip.AddPathLine(path, x, y + h - radius, x, y + radius)
    gdip.ClosePathFigure(path)
    return path
  }

  /**
   * 一个面向 HDC 的画笔（每帧创建一个即可）。
   */
  function painterFromHdc(hdc) {
    const out = [null]
    if (gdip.CreateFromHDC(hdc, out) !== 0) return null
    const graphics = out[0]
    gdip.SetSmoothingMode(graphics, 4) // AntiAlias
    gdip.SetTextRenderingHint(graphics, 4) // ClearTypeGridFit
    const scratch = [null]
    gdip.CreateStringFormat(0, 0, scratch)
    const format = scratch[0]
    if (format !== null) {
      gdip.SetStringFormatFlags(format, 0x1000 /* NoWrap */ | 0x4000 /* NoClip */)
      gdip.SetStringFormatTrimming(format, 3 /* EllipsisCharacter */)
    }
    return {
      graphics,
      format,
      fillRoundRect(x, y, w, h, r, color) {
        const path = roundRectPath(x, y, w, h, r)
        if (path === null) return
        gdip.FillPath(graphics, brush(color), path)
        gdip.DeletePath(path)
      },
      strokeRoundRect(x, y, w, h, r, color, width = 1) {
        const path = roundRectPath(x, y, w, h, r)
        if (path === null) return
        const pen = [null]
        if (gdip.CreatePen1(color, width, 2, pen) === 0) {
          gdip.DrawPath(graphics, pen[0], path)
          gdip.DeletePen(pen[0])
        }
        gdip.DeletePath(path)
      },
      fillRect(x, y, w, h, color) {
        gdip.FillRectangle(graphics, brush(color), x, y, w, h)
      },
      fillCircle(x, y, size, color) {
        gdip.FillEllipse(graphics, brush(color), x, y, size, size)
      },
      line(x1, y1, x2, y2, color, width = 1) {
        const pen = [null]
        if (gdip.CreatePen1(color, width, 2, pen) !== 0) return
        gdip.DrawLine(graphics, pen[0], x1, y1, x2, y2)
        gdip.DeletePen(pen[0])
      },
      /** 单行文本（超出省略）。 */
      text(text, x, y, w, h, { size = 14, bold = false, mono = false, color = 0xff000000 } = {}) {
        const f = font(size, { bold, mono })
        if (f === null || text === '') return
        const rect = { X: x, Y: y, Width: w, Height: h }
        gdip.DrawString(graphics, String(text), -1, f, rect, format, brush(color))
      },
      /** 测量单行文本尺寸。 */
      measure(text, { size = 14, bold = false, mono = false } = {}) {
        const f = font(size, { bold, mono })
        if (f === null) return { width: 0, height: size * 1.4 }
        const rect = { X: 0, Y: 0, Width: 100000, Height: size * 4 }
        const box = {}
        const fitted = new Int32Array(1)
        const lines = new Int32Array(1)
        gdip.MeasureString(graphics, String(text), -1, f, rect, format, box, fitted, lines)
        return { width: box.Width ?? 0, height: box.Height ?? size * 1.4 }
      },
      /**
       * 换行绘制一段文本（自己排版：按空格/CJK 边界断行，支持粗体与等宽混排）。
       * @returns 实际绘制高度。
       */
      paragraph(text, x, y, w, { size = 14, lineHeight = null, color = 0xff000000, bold = false, mono = false, maxHeight = Infinity, dryRun = false, indent = 0 } = {}) {
        const lh = lineHeight ?? Math.round(size * 1.55)
        const tokens = tokenize(text, { bold, mono, size, measure: (t, opts) => this.measure(t, opts) })
        let cursorX = x
        let cursorY = y
        let firstLine = true
        let lineText = ''
        // 连续同格式的 token 合成一次 DrawString。
        // 为什么必须合：CJK 在 tokenize 里是**逐字**成 token 的（为了能逐字断行），
        // 如果逐字 DrawString，每画一个字都会各自推进一次字形宽度，中文看起来就像
        // 每个字之间插了空格。合并成整行后由字体自己做排版，间距才正常。
        let run = null
        const flushRun = () => {
          if (run === null) return
          // 绘制矩形要比 run.width **宽一个 em**：token 宽度用的是"净推进量"（已扣掉前导边距），
          // 而 DrawString 判断要不要加省略号用的是"净宽 + 边距"。给紧了就会在行尾冒出"…"。
          // 多给不会画坏：StringFormat 带 NoClip，超出部分交给上层裁剪。
          this.text(run.text, run.x, run.y, run.width + run.size, lh, { size: run.size, bold: run.bold, mono: run.mono, color })
          run = null
        }
        /** 行首禁则：句末标点不该被挤到下一行的行首。 */
        const NO_LINE_START = /^[，。、；：？！）】》」』”’…—·,.?!:;)\]}>]+$/
        for (const tk of tokens) {
          if (tk.break === true) {
            flushRun()
            cursorX = x
            cursorY += lh
            firstLine = false
            lineText = ''
            if (cursorY + lh > y + maxHeight) return cursorY - y
            continue
          }
          const lineStart = firstLine ? x + indent : x
          // 逐 token 累加的宽度会把**相邻字形之间的边距重复计一遍**（东亚文字尤其明显），
          // 结果就是换行提前一两个字。所以只在"快到边界"时真去量一次整行，用实测宽度定夺。
          if (cursorX + tk.width > x + w && cursorX > lineStart) {
            const realWidth = this.measure(lineText + tk.text, { size: tk.size, bold: tk.bold, mono: tk.mono }).width
            // measure 会多算一份前导边距（≈ size/3），比较时补回来，免得把放得下的行判成放不下
            const fits = lineStart + realWidth - tk.size * 0.4 <= x + w
            // 行首禁则：句末标点不该被挤到下一行行首，宁可让它悬挂出去
            if (!fits && !NO_LINE_START.test(tk.text)) {
              flushRun()
              cursorX = x
              cursorY += lh
              firstLine = false
              lineText = ''
              if (cursorY + lh > y + maxHeight) return cursorY - y
            }
          }
          if (!dryRun) {
            const contiguous =
              run !== null &&
              run.y === cursorY &&
              run.size === tk.size &&
              run.bold === tk.bold &&
              run.mono === tk.mono &&
              Math.abs(run.x + run.width - cursorX) < 0.6
            if (contiguous) {
              run.text += tk.text
              run.width += tk.width
            } else {
              flushRun()
              run = { text: tk.text, x: cursorX, y: cursorY, width: tk.width, size: tk.size, bold: tk.bold, mono: tk.mono }
            }
          }
          lineText += tk.text
          cursorX += tk.width
        }
        flushRun()
        return cursorY - y + lh
      },
      /** 设置/恢复裁剪矩形（画超出区域的滚动内容时必须用，否则会盖到页脚上）。 */
      setClip(x, y, w, h) {
        // CombineModeReplace = 0（GpCombineMode: Replace=0, Intersect=1, Union=2, Xor=3, Exclude=4, Complement=5）。
        // 曾经写成 4 = Exclude：裁剪区变成"这块矩形之外"，正文被整块裁掉，正文区一片空白（踩过）。
        const status = gdip.SetClipRect(graphics, x, y, Math.max(0, w), Math.max(0, h), 0)
        if (status !== 0) throw new Error('GdipSetClipRect failed with status ' + status)
      },
      resetClip() {
        gdip.ResetClip(graphics)
      },
      /** 填充一个多边形（Points 为 [[x,y], ...]）。 */
      fillPolygon(points, color) {
        if (points.length < 3) return
        const out = [null]
        if (gdip.CreatePath(0, out) !== 0) return
        const path = out[0]
        gdip.AddPathLine(path, points[0][0], points[0][1], points[1][0], points[1][1])
        for (let i = 1; i < points.length - 1; i++) {
          gdip.AddPathLine(path, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
        }
        gdip.ClosePathFigure(path)
        gdip.FillPath(graphics, brush(color), path)
        gdip.DeletePath(path)
      },
      strokeEllipse(x, y, w, h, color, width = 1) {
        const path = (() => {
          const out = [null]
          if (gdip.CreatePath(0, out) !== 0) return null
          const p = out[0]
          gdip.AddPathArc(p, x, y, w, h, 0, 360)
          gdip.ClosePathFigure(p)
          return p
        })()
        if (path === null) return
        const pen = [null]
        if (gdip.CreatePen1(color, width, 2, pen) === 0) {
          gdip.DrawPath(graphics, pen[0], path)
          gdip.DeletePen(pen[0])
        }
        gdip.DeletePath(path)
      },
      dispose() {
        if (format !== null) gdip.DeleteStringFormat(format)
        gdip.DeleteGraphics(graphics)
      },
    }
  }

  /**
   * CJK 单字的真实推进量（带缓存）。
   *
   * 不能直接用 `measure(单字).width`：MeasureString 会把**前导边距**一起算进结果
   * （实测请求 18.75px 时单字报 25.55，而真实推进只有 19.31），逐字相加会让整行
   * 提前断行。用"8 个字减 1 个字再除 7"把边距消掉才是可用的推进量。
   */
  const cjkCache = new Map()
  function cjkAdvance(defaults, style) {
    const key = `${style.size}|${style.bold === true}|${style.mono === true}`
    const hit = cjkCache.get(key)
    if (hit !== undefined) return hit
    const one = defaults.measure('中', style).width
    const eight = defaults.measure('中'.repeat(8), style).width
    const advance = (eight - one) / 7
    const value = advance > 0 ? advance : one
    cjkCache.set(key, value)
    return value
  }

  /** 把文本切成可断行的 token（空格断行 + CJK 逐字断行；同时保留粗体/代码样式）。 */
  function tokenize(text, defaults) {
    const tokens = []
    const parts = String(text).split(/(\*\*[^*]+\*\*|\`[^\`]+\`)/g)
    for (const part of parts) {
      if (part === '') continue
      let style = { bold: defaults.bold, mono: defaults.mono, size: defaults.size }
      let body = part
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        style = { ...style, bold: true }
        body = part.slice(2, -2)
      } else if (part.startsWith('\`') && part.endsWith('\`') && part.length > 2) {
        style = { ...style, mono: true, size: Math.max(11, defaults.size - 1) }
        body = part.slice(1, -1)
      }
      let buffer = ''
      const flush = () => {
        if (buffer === '') return
        tokens.push({ text: buffer, width: defaults.measure(buffer, style).width, ...style })
        buffer = ''
      }
      for (const char of body) {
        if (char === '\n') {
          flush()
          tokens.push({ break: true })
          continue
        }
        const isCjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)
        if (char === ' ') {
          buffer += char
          flush()
        } else if (isCjk) {
          flush()
          tokens.push({ text: char, width: cjkAdvance(defaults, style), ...style })
        } else {
          buffer += char
        }
      }
      flush()
    }
    return tokens
  }

  return {
    koffi,
    gdip,
    native,
    rgb,
    font,
    brush,
    roundRectPath,
    painterFromHdc,
    ensureFamilies,
    /** 启动 GDI+（幂等）。 */
    startup() {
      if (started) return true
      const out = new BigUint64Array(1)
      const status = gdip.GdiplusStartup(out, { GdiplusVersion: 1, DebugEventCallback: null, SuppressBackgroundThread: 0, SuppressExternalCodecs: 0 }, null)
      if (status !== 0) return false
      token = out[0]
      started = true
      return true
    },
    shutdown() {
      if (started) gdip.GdiplusShutdown(token)
      started = false
    },
    /** 双缓冲：把一次绘制画到内存位图再 BitBlt 到窗口 DC，避免闪烁。 */
    withDoubleBuffer(hwnd, draw) {
      const hdc = native.GetDC(hwnd)
      if (hdc === null) return
      try {
        const rect = {}
        native.GetClientRect(hwnd, rect)
        const width = Math.max(1, rect.right - rect.left)
        const height = Math.max(1, rect.bottom - rect.top)
        const memDc = native.CreateCompatibleDC(hdc)
        const bitmap = native.CreateCompatibleBitmap(hdc, width, height)
        const previous = native.SelectObject(memDc, bitmap)
        try {
          const painter = painterFromHdc(memDc)
          if (painter !== null) {
            try {
              draw(painter, width, height)
            } finally {
              painter.dispose()
            }
          }
          native.BitBlt(hdc, 0, 0, width, height, memDc, 0, 0, SRCCOPY)
        } finally {
          native.SelectObject(memDc, previous)
          native.DeleteObject(bitmap)
          native.DeleteDC(memDc)
        }
      } finally {
        native.ReleaseDC(hwnd, hdc)
      }
    },
  }
}
