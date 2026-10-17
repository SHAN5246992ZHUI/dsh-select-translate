/**
 * 原生"输入一行文字"的小窗（自定义译文语种用）。
 *
 * 为什么必须另开窗口：卡片是 `WS_EX_NOACTIVATE` 的 GDI+ 分层窗口，**永远收不到键盘消息**
 * （连 Esc 都只能靠轮询），所以"点一下就在卡片里打字"做不到。这里用一个**普通可激活窗口**
 * 装系统自带的 `EDIT` 控件 —— 输入法（中文/日文）天然可用，也不碰卡片那套分层绘制。
 *
 * 不用自己建消息泵：`native/window.mjs` 里 `PeekMessageW(msg, null, …)` 取的是**本线程
 * 所有窗口**的消息，这个窗口的消息因此会被同一个泵派发（8ms 一轮）。
 *
 * 选的是**顶层 EDIT**（不套父窗口）：EDIT 是系统注册类，不需要自己写 WndProc；
 * 焦点交给 `SetForegroundWindow` + `SetFocus`，回车/Esc 由伴生进程的轮询边沿检测处理。
 */
export function createInputWindow({ api }) {
  const user32 = api.user32
  const gdi32 = api.gdi32
  const u = {
    CreateWindowExW: user32.func(
      'void *CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
    ),
    DestroyWindow: user32.func('bool DestroyWindow(void *hwnd)'),
    SetWindowTextW: user32.func('bool SetWindowTextW(void *hwnd, const char16_t *text)'),
    GetWindowTextW: user32.func('int GetWindowTextW(void *hwnd, void *buffer, int maxCount)'),
    SetFocus: user32.func('void *SetFocus(void *hwnd)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(void *hwnd)'),
    GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
    MoveWindow: user32.func('bool MoveWindow(void *hwnd, int x, int y, int w, int h, bool repaint)'),
    SendMessageW: user32.func('intptr_t SendMessageW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    GetStockObject: gdi32.func('void *GetStockObject(int index)'),
  }

  const WS_POPUP = 0x80000000
  const WS_BORDER = 0x00800000
  const WS_VISIBLE = 0x10000000
  const ES_AUTOHSCROLL = 0x0080
  const WS_EX_TOOLWINDOW = 0x00000080
  const WS_EX_TOPMOST = 0x00000008
  const WM_SETFONT = 0x0030
  const DEFAULT_GUI_FONT = 17

  /** GetWindowTextW 的接收缓冲（UTF-16，256 个字符）。 */
  const buffer = Buffer.alloc(256 * 2)
  let hwnd = null

  return {
    /** 打开输入窗（物理像素坐标）。返回 false = 系统没让建窗口。 */
    open({ x, y, width, height, initial = '' }) {
      this.close()
      hwnd = u.CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
        'EDIT',
        '',
        WS_POPUP | WS_BORDER | WS_VISIBLE | ES_AUTOHSCROLL,
        Math.round(x),
        Math.round(y),
        Math.max(120, Math.round(width)),
        Math.max(22, Math.round(height)),
        null,
        null,
        null,
        null,
      )
      if (hwnd === null) return false
      u.SendMessageW(hwnd, WM_SETFONT, u.GetStockObject(DEFAULT_GUI_FONT), 1)
      if (typeof initial === 'string' && initial !== '') u.SetWindowTextW(hwnd, initial)
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
      if (hwnd === null) return false
      u.SetForegroundWindow(hwnd)
      u.SetFocus(hwnd)
      return u.GetForegroundWindow() === hwnd
    },
    isOpen() {
      return hwnd !== null
    },
    /** 当前是不是输入窗在前台（用来判断"用户点了别处"）。 */
    focused() {
      return hwnd !== null && u.GetForegroundWindow() === hwnd
    },
    /** 读取用户输入的文字（UTF-16 → JS 字符串）。 */
    value() {
      if (hwnd === null) return ''
      const length = u.GetWindowTextW(hwnd, buffer, 256)
      return length > 0 ? buffer.subarray(0, length * 2).toString('utf16le') : ''
    },
    close() {
      if (hwnd === null) return
      u.DestroyWindow(hwnd)
      hwnd = null
    },
  }
}
