/**
 * 原生"输入一行文字"的小窗（自定义译文语种用）—— **视觉与卡片对齐**。
 *
 * 为什么必须另开窗口：卡片是 `WS_EX_NOACTIVATE` 的 GDI+ 分层窗口，**永远收不到键盘消息**
 * （连 Esc 都只能靠轮询），所以"点一下就在卡片里打字"做不到。这里用一个**普通可激活窗口**
 * 装系统自带的 `EDIT` 控件 —— 输入法（中文/日文）天然可用，也不碰卡片那套分层绘制。
 *
 * 视觉做法（对齐 `card.mjs` 的 CARD / COLOR）：
 *  - **自绘容器窗口**（普通窗口，不是分层窗口）：WM_PAINT 里填白底 + 画 12px 圆角 + 1px 描边 `#e5e9f0`；
 *  - 圆角靠 `SetWindowRgn(CreateRoundRectRgn)` 裁；类样式带 `CS_DROPSHADOW`，由系统给一层投影；
 *  - 内嵌**无边框 EDIT**（白底、`Microsoft YaHei UI`、与正文同色 `#1f2329`），留 8px 内边距；
 *    `EM_SETCUEBANNER` 给一句占位提示。
 *
 * 不用自己建消息泵：`native/window.mjs` 里 `PeekMessageW(msg, null, …)` 取的是**本线程
 * 所有窗口**的消息，这个窗口的消息因此会被同一个泵派发（8ms 一轮）。
 */
export function createInputWindow({ api }) {
  const koffi = api.koffi
  const user32 = api.user32
  const gdi32 = api.gdi32
  const kernel32 = api.kernel32

  /** GDI 的 COLORREF 是 0x00BBGGRR，和 CSS 的 #RRGGBB 相反 —— 别直接抄卡片里的数值。 */
  const rgb = (r, g, b) => (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16)
  const WHITE = rgb(255, 255, 255)
  const BORDER = rgb(0xe5, 0xe9, 0xf0) // card.mjs COLOR.border
  const TEXT = rgb(0x1f, 0x23, 0x29) // card.mjs COLOR.text

  const RECT = koffi.struct('DST_IW_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  let wndProcProto = null
  try {
    wndProcProto = koffi.proto('intptr_t __stdcall DST_IW_WndProc(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  } catch {
    wndProcProto = koffi.pointer('DST_IW_WndProc')
  }
  const WNDCLASSEXW = koffi.struct('DST_IW_WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: koffi.pointer(wndProcProto ?? 'DST_IW_WndProc'),
    cbClsExtra: 'int',
    cbWndExtra: 'int',
    hInstance: 'void *',
    hIcon: 'void *',
    hCursor: 'void *',
    hbrBackground: 'void *',
    lpszMenuName: 'const char16_t *',
    lpszClassName: 'const char16_t *',
    hIconSm: 'void *',
  })

  const u = {
    RegisterClassExW: user32.func('uint16 RegisterClassExW(DST_IW_WNDCLASSEXW *wc)'),
    CreateWindowExW: user32.func(
      'void *CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
    ),
    DefWindowProcW: user32.func('intptr_t DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    DestroyWindow: user32.func('bool DestroyWindow(void *hwnd)'),
    LoadCursorW: user32.func('void *LoadCursorW(void *instance, const char16_t *name)'),
    SetWindowTextW: user32.func('bool SetWindowTextW(void *hwnd, const char16_t *text)'),
    GetWindowTextW: user32.func('int GetWindowTextW(void *hwnd, void *buffer, int maxCount)'),
    SetFocus: user32.func('void *SetFocus(void *hwnd)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(void *hwnd)'),
    GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
    GetClientRect: user32.func('bool GetClientRect(void *hwnd, _Out_ DST_IW_RECT *rect)'),
    GetDC: user32.func('void *GetDC(void *hwnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
    ValidateRect: user32.func('bool ValidateRect(void *hwnd, DST_IW_RECT *rect)'),
    SetWindowRgn: user32.func('int SetWindowRgn(void *hwnd, void *hrgn, bool redraw)'),
    SendMessageW: user32.func('intptr_t SendMessageW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    SendMessageStrW: user32.func('intptr_t SendMessageW(void *hwnd, uint32_t msg, uintptr_t wParam, const char16_t *lParam)'),
    GetModuleHandleW: kernel32.func('void *GetModuleHandleW(const char16_t *name)'),
    CreateSolidBrush: gdi32.func('void *CreateSolidBrush(uint32_t color)'),
    CreatePen: gdi32.func('void *CreatePen(int style, int width, uint32_t color)'),
    CreateRoundRectRgn: gdi32.func('void *CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)'),
    CreateFontW: gdi32.func(
      'void *CreateFontW(int height, int width, int escapement, int orientation, int weight, uint32_t italic, uint32_t underline, uint32_t strikeOut, uint32_t charSet, uint32_t outPrecision, uint32_t clipPrecision, uint32_t quality, uint32_t pitchAndFamily, const char16_t *face)',
    ),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    DeleteObject: gdi32.func('bool DeleteObject(void *obj)'),
    GetStockObject: gdi32.func('void *GetStockObject(int index)'),
    SetBkColor: gdi32.func('uint32_t SetBkColor(void *hdc, uint32_t color)'),
    SetTextColor: gdi32.func('uint32_t SetTextColor(void *hdc, uint32_t color)'),
    PatBlt: gdi32.func('bool PatBlt(void *hdc, int x, int y, int w, int h, uint32_t rop)'),
    RoundRect: gdi32.func('bool RoundRect(void *hdc, int left, int top, int right, int bottom, int width, int height)'),
  }

  const WM = {
    PAINT: 0x000f,
    ERASEBKGND: 0x0014,
    CTLCOLOREDIT: 0x0133,
    DESTROY: 0x0002,
    SETFONT: 0x0030,
    SETCUEBANNER: 0x1501,
  }
  const WS_POPUP = 0x80000000
  const WS_VISIBLE = 0x10000000
  const WS_CHILD = 0x40000000
  const ES_AUTOHSCROLL = 0x0080
  const WS_EX_TOPMOST = 0x00000008
  const CS_DROPSHADOW = 0x00020000
  const NULL_BRUSH = 5 // GetStockObject(5) = NULL_BRUSH：RoundRect 只描边、不填充
  const IDC_ARROW = 32512
  const CLASS_NAME = 'DshStInputWnd'

  const buffer = Buffer.alloc(256 * 2)
  let container = null
  let edit = null
  let whiteBrush = null
  let registered = false
  let wndProcPtr = null
  /** 当前这扇窗的视觉参数（按显示器缩放算好，绘制时直接用）。 */
  let metrics = { radius: 12, border: 1 }

  const brush = () => {
    if (whiteBrush === null) whiteBrush = u.CreateSolidBrush(WHITE)
    return whiteBrush
  }

  /** WM_PAINT：填白底 + 画圆角描边（窗口区域本身已经被裁成圆角）。 */
  function paint(hwnd) {
    const hdc = u.GetDC(hwnd)
    if (hdc === null) return
    try {
      const rect = { left: 0, top: 0, right: 0, bottom: 0 }
      if (!u.GetClientRect(hwnd, rect)) return
      const w = rect.right
      const h = rect.bottom
      // 白底用 PatBlt（不用 FillRect：那要传 RECT 结构体，参数越少越不容易踩 koffi 的坑）
      const oldBrush = u.SelectObject(hdc, brush())
      try {
        u.PatBlt(hdc, 0, 0, w, h, 0x00f00021 /* PATCOPY */)
      } finally {
        u.SelectObject(hdc, oldBrush)
      }
      const pen = u.CreatePen(0 /* PS_SOLID */, metrics.border, BORDER)
      const penOld = u.SelectObject(hdc, pen)
      const brushOld = u.SelectObject(hdc, u.GetStockObject(NULL_BRUSH))
      try {
        u.RoundRect(hdc, 0, 0, w, h, metrics.radius * 2, metrics.radius * 2)
      } finally {
        u.SelectObject(hdc, brushOld)
        u.SelectObject(hdc, penOld)
        u.DeleteObject(pen)
      }
    } finally {
      u.ReleaseDC(hwnd, hdc)
      u.ValidateRect(hwnd, null) // 无论如何都清掉更新区，别让 WM_PAINT 变成死循环
    }
  }

  function handleMessage(hwnd, msg, wParam, lParam) {
    switch (msg) {
      case WM.PAINT:
        paint(hwnd)
        return 0
      case WM.ERASEBKGND:
        return 1
      case WM.CTLCOLOREDIT: {
        // wParam = EDIT 的 HDC：把它的底色 / 字色也换成卡片同款
        const hdc = wParam
        u.SetBkColor(hdc, WHITE)
        u.SetTextColor(hdc, TEXT)
        return brush()
      }
      case WM.DESTROY:
        return 0
      default:
        return u.DefWindowProcW(hwnd, msg, wParam, lParam)
    }
  }

  /** 注册窗口类（幂等）。 */
  function ensureClass() {
    if (registered) return
    const instance = u.GetModuleHandleW(null)
    wndProcPtr = koffi.register((hwnd, msg, wParam, lParam) => {
      try {
        return handleMessage(hwnd, msg, wParam, lParam)
      } catch (error) {
        // 兜住并上报：WndProc 里抛出的异常会被 koffi 吞掉，表现为"窗口没画出来"（同 window.mjs）
        process.stderr.write('[dsh-st] input wndproc: ' + (error instanceof Error ? error.message : String(error)) + '\n')
        return 0
      }
    }, koffi.pointer(wndProcProto ?? 'DST_IW_WndProc'))
    const wc = {
      cbSize: koffi.sizeof(WNDCLASSEXW),
      style: CS_DROPSHADOW,
      lpfnWndProc: wndProcPtr,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: instance,
      hIcon: null,
      hCursor: u.LoadCursorW(null, koffi.as(IDC_ARROW, 'char16_t *')),
      hbrBackground: null,
      lpszMenuName: null,
      lpszClassName: CLASS_NAME,
      hIconSm: null,
    }
    u.RegisterClassExW(wc)
    registered = true
  }

  return {
    /** 打开输入窗（物理像素坐标；`scale` 是显示器缩放，圆角/内边距/字体都按它放大）。 */
    open({ x, y, width, height, initial = '', scale = 1 }) {
      this.close()
      ensureClass()
      const s = Number.isFinite(scale) && scale > 0 ? scale : 1
      const radius = Math.max(6, Math.round(12 * s))
      const pad = Math.max(4, Math.round(8 * s))
      const w = Math.max(140, Math.round(width))
      const h = Math.max(28, Math.round(height))
      metrics = { radius, border: Math.max(1, Math.round(s)) }

      container = u.CreateWindowExW(WS_EX_TOPMOST, CLASS_NAME, '自定义译文语种', WS_POPUP | WS_VISIBLE, Math.round(x), Math.round(y), w, h, null, null, u.GetModuleHandleW(null), null)
      if (container === null) return false
      // 圆角：系统按这个区域裁剪窗口（硬边）；描边由 WM_PAINT 里的 RoundRect 画在上面
      const region = u.CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2)
      if (region !== null) u.SetWindowRgn(container, region, true)

      edit = u.CreateWindowExW(0, 'EDIT', '', WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, pad, pad, Math.max(20, w - pad * 2), Math.max(16, h - pad * 2), container, null, null, null)
      if (edit === null) {
        this.close()
        return false
      }
      const font = u.CreateFontW(-Math.round(14 * s), 0, 0, 0, 400, 0, 0, 0, 1 /* DEFAULT_CHARSET */, 0, 0, 5 /* CLEARTYPE_QUALITY */, 0, 'Microsoft YaHei UI')
      if (font !== null) u.SendMessageW(edit, WM.SETFONT, font, 1)
      u.SendMessageStrW(edit, WM.SETCUEBANNER, 1, '输入语种，如 日本語 / 한국어')
      if (typeof initial === 'string' && initial !== '') u.SetWindowTextW(edit, initial)
      this.focus()
      return true
    },
    /**
     * 把键盘焦点抢过来。
     *
     * 允许调用的前提是**本进程刚收到用户的点击**（点下拉里的"自定义…"）——那一下让我们的进程
     * 成为"最后输入来源"，`SetForegroundWindow` 才不会被系统拒绝。抢不到就返回 false，
     * 调用方可以过一会儿再试一次。
     */
    focus() {
      if (container === null) return false
      u.SetForegroundWindow(container)
      if (edit !== null) u.SetFocus(edit)
      return u.GetForegroundWindow() === container
    },
    isOpen() {
      return container !== null
    },
    /** 当前是不是输入窗在前台（用来判断"用户点了别处"）。 */
    focused() {
      return container !== null && u.GetForegroundWindow() === container
    },
    /** 读取用户输入的文字（UTF-16 → JS 字符串）。 */
    value() {
      if (edit === null) return ''
      const length = u.GetWindowTextW(edit, buffer, 256)
      return length > 0 ? buffer.subarray(0, length * 2).toString('utf16le') : ''
    },
    close() {
      if (container === null) return
      u.DestroyWindow(container) // 子窗口（EDIT）跟着一起销毁
      container = null
      edit = null
    },
  }
}
