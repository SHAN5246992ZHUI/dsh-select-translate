/**
 * SPDX-License-Identifier: MIT
 * 本文件衍生自 dsh-selection-tools（MIT · Copyright (c) 2026 dsh-selection-tools contributors）
 *   https://github.com/fyisgod/dsh-selection-tools @ 3f292d92（v0.8.2）
 * 上游声明原文与逐文件改动说明：本插件根目录 THIRD-PARTY-NOTICES.md
 * 与上游对应文件逐字节相同（未做修改）。
 */
/**
 * Win32 / koffi 绑定层：全局鼠标读数、剪贴板、窗口控制、键盘注入。
 *
 * 为什么用 koffi：DSH 自带的桌面端依赖里已经有 koffi（native FFI），插件只要
 * 按"从 dsh 安装目录解析"的方式 require 它，就能在 Node 里直接调 user32/kernel32，
 * 不需要额外进程、不需要编译任何东西。
 *
 * 本文件是纯绑定 + 薄封装，不做业务判断（便于单测/替换）。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 解析 koffi：优先用调用方给的 dsh 安装目录，其次常见候选。 */
export function loadKoffi(hints = []) {
  const candidates = []
  for (const hint of hints) {
    if (typeof hint !== 'string' || hint === '') continue
    // 允许传目录（内部拼 noop.js）或直接传一个 .js/.mjs 文件路径（宿主进程的 argv[1]）
    candidates.push(/\.(js|mjs|cjs)$/.test(hint) ? hint : join(hint, 'noop.js'))
  }
  // 插件宿主进程的 argv[1] 通常就是 <install>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.endsWith('.js')) candidates.push(argv1)
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome !== '') {
    candidates.push(join(dshHome, 'profiles', 'node_modules', 'noop.js'))
    candidates.push(join(dshHome, 'profiles', 'web', 'noop.js'))
  }
  for (const base of candidates) {
    try {
      return createRequire(base)('koffi')
    } catch {
      /* 试下一个候选 */
    }
  }
  try {
    return createRequire(import.meta.url)('koffi')
  } catch {
    return null
  }
}

/** 侦测一个文件是否存在（诊断用）。 */
export function fileExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** 纯函数：虚拟屏幕坐标 → 窗口左上角（把锚点放在第四象限并夹进屏幕）。 */
export function anchorToWindowPosition(anchor, size, workArea, gap = 8) {
  const maxX = workArea.right - size.width
  const maxY = workArea.bottom - size.height
  return {
    x: Math.min(Math.max(anchor.x + gap, workArea.left), Math.max(workArea.left, maxX)),
    y: Math.min(Math.max(anchor.y + gap, workArea.top), Math.max(workArea.top, maxY)),
  }
}

/**
 * 建立 Win32 绑定。
 * @returns 绑定对象；koffi 不可用时返回 null。
 */
export function createWin32(hints = []) {
  const koffi = loadKoffi(hints)
  if (koffi === null) return null

  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  let gdi32 = null
  let dwmapi = null
  try {
    gdi32 = koffi.load('gdi32.dll')
  } catch {
    gdi32 = null
  }
  try {
    dwmapi = koffi.load('dwmapi.dll')
  } catch {
    dwmapi = null
  }

  const POINT = koffi.struct('DST_POINT', { x: 'long', y: 'long' })
  const RECT = koffi.struct('DST_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const GUITHREADINFO = koffi.struct('DST_GUITHREADINFO', {
    cbSize: 'uint32', flags: 'uint32', hwndActive: 'void *', hwndFocus: 'void *',
    hwndCapture: 'void *', hwndMenuOwner: 'void *', hwndMoveSize: 'void *',
    hwndCaret: 'void *', rcCaret: RECT,
  })
  const MONITORINFO = koffi.struct('DST_MONITORINFO', {
    cbSize: 'uint32',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32',
  })
  const KEYBDINPUT = koffi.struct('DST_KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  })
  const MOUSEINPUT = koffi.struct('DST_MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  })
  const INPUTUNION = koffi.union('DST_INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
  const INPUT = koffi.struct('DST_INPUT', { type: 'uint32', u: INPUTUNION })

  const api = {
    koffi,
    user32,
    kernel32,
    gdi32,
    dwmapi,
    types: { POINT, RECT, MONITORINFO, KEYBDINPUT, MOUSEINPUT, INPUT },
    sizeofInput: koffi.sizeof(INPUT),
  }

  // 必须先声明 DPI 感知，再做任何窗口/显示器操作。
  // 不声明时 Windows 会把本进程当成 DPI-unaware：坐标与尺寸全落在"被缩放过的虚拟坐标空间"里
  // （实测 systemDpi 谎报 96、虚拟屏幕 3627×1080，而真实物理是 144dpi / 4480×1600）——
  // 这正是主屏（150%）与副屏（100%）上浮层大小/位置表现不一致的根因。
  try {
    const setContext = user32.func('bool SetProcessDpiAwarenessContext(intptr_t value)')
    if (!setContext(-4 /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */)) {
      user32.func('bool SetProcessDPIAware()')()
    }
  } catch {
    /* 老系统没有这个 API：退化为系统 DPI 感知 */
  }

  api.GetCursorPos = user32.func('bool GetCursorPos(_Out_ DST_POINT *pt)')
  api.GetAsyncKeyState = user32.func('short GetAsyncKeyState(int vKey)')
  api.GetForegroundWindow = user32.func('void *GetForegroundWindow()')
  api.GetGUIThreadInfo = user32.func('bool GetGUIThreadInfo(uint32 thread, _Inout_ DST_GUITHREADINFO *info)')
  api.sizeofGuiThreadInfo = koffi.sizeof(GUITHREADINFO)
  api.GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
  api.GetClassNameW = user32.func('int GetClassNameW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
  api.GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, _Out_ DST_RECT *rect)')
  api.GetWindowThreadProcessId = user32.func('unsigned long GetWindowThreadProcessId(void *hWnd, _Out_ unsigned long *pid)')
  api.IsWindow = user32.func('bool IsWindow(void *hWnd)')
  api.IsWindowVisible = user32.func('bool IsWindowVisible(void *hWnd)')
  // hWndInsertAfter 用 intptr_t 声明：HWND_TOPMOST(-1)/HWND_NOTOPMOST(-2) 是伪句柄常量，
  // 声明成 void* 时 koffi 不接受负数。
  api.SetWindowPos = user32.func('bool SetWindowPos(void *hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, unsigned int uFlags)')
  api.GetWindowLongPtrW = user32.func('intptr_t GetWindowLongPtrW(void *hWnd, int nIndex)')
  api.SetWindowLongPtrW = user32.func('intptr_t SetWindowLongPtrW(void *hWnd, int nIndex, intptr_t dwNewLong)')
  api.ShowWindow = user32.func('bool ShowWindow(void *hWnd, int nCmdShow)')
  api.SetWindowRgn = user32.func('int SetWindowRgn(void *hWnd, void *hRgn, bool bRedraw)')
  api.ReleaseCapture = user32.func('bool ReleaseCapture()')
  api.SendMessageW = user32.func('intptr_t SendMessageW(void *hWnd, unsigned int Msg, uintptr_t wParam, intptr_t lParam)')
  api.GetDpiForWindow = user32.func('unsigned int GetDpiForWindow(void *hWnd)')
  try {
    api.GetDpiForMonitor = koffi.load('shcore.dll').func('int GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ unsigned int *dpiX, _Out_ unsigned int *dpiY)')
  } catch {
    api.GetDpiForMonitor = undefined
  }
  // 出参必须声明成结构体指针，声明为 void* 时 koffi 不接受普通 JS 对象。
  api.SystemParametersInfoW = user32.func('bool SystemParametersInfoW(unsigned int uiAction, unsigned int uiParam, _Out_ DST_RECT *pvParam, unsigned int fWinIni)')
  api.MonitorFromPoint = user32.func('void *MonitorFromPoint(DST_POINT pt, unsigned int dwFlags)')
  api.MonitorFromWindow = user32.func('void *MonitorFromWindow(void *hwnd, unsigned int dwFlags)')
  api.GetMonitorInfoW = user32.func('bool GetMonitorInfoW(void *hMonitor, _Inout_ DST_MONITORINFO *info)')
  api.GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)')
  api.keybd_event = user32.func('void keybd_event(uint8_t bVk, uint8_t bScan, unsigned int dwFlags, uintptr_t dwExtraInfo)')
  api.MapVirtualKeyW = user32.func('unsigned int MapVirtualKeyW(unsigned int uCode, unsigned int uMapType)')
  api.FindWindowW = user32.func('void *FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)')
  // EnumWindows 需要一个真正的回调原型：koffi 不接受裸的 'bool __stdcall(void*, intptr_t)' 字符串。
  api.EnumWindowsProc = koffi.proto('bool __stdcall DstEnumWindowsProc(void *hwnd, intptr_t lParam)')
  api.EnumWindows = user32.func('bool EnumWindows(DstEnumWindowsProc *cb, intptr_t lParam)')
  api.OpenClipboard = user32.func('bool OpenClipboard(void *hWndNewOwner)')
  api.CloseClipboard = user32.func('bool CloseClipboard()')
  api.EmptyClipboard = user32.func('bool EmptyClipboard()')
  api.GetClipboardData = user32.func('void *GetClipboardData(unsigned int uFormat)')
  api.SetClipboardData = user32.func('void *SetClipboardData(unsigned int uFormat, void *hMem)')
  api.GetClipboardSequenceNumber = user32.func('unsigned long GetClipboardSequenceNumber()')
  // 剪贴板属主窗口：用来判断"这次写入是不是前台应用自己干的"（取词只认它）。
  api.GetClipboardOwner = user32.func('void *GetClipboardOwner()')
  api.EnumClipboardFormats = user32.func('unsigned int EnumClipboardFormats(unsigned int format)')
  api.GetClipboardFormatNameW = user32.func('int GetClipboardFormatNameW(unsigned int format, _Out_ uint16_t *name, int size)')
  api.OpenProcess = kernel32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)')
  api.QueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32 *size)')
  api.CloseHandle = kernel32.func('bool CloseHandle(void *handle)')
  // 顶层祖先窗口：UWP 这类应用里，前台是框架窗口（ApplicationFrameHost），真正处理
  // Ctrl+C 的窗口是它的子窗口、属于另一个进程——按"根窗口的进程"能把它们认成一家。
  api.GetAncestor = user32.func('void *GetAncestor(void *hwnd, unsigned int gaFlags)')
  api.GlobalLock = kernel32.func('void *GlobalLock(void *hMem)')
  api.GlobalUnlock = kernel32.func('bool GlobalUnlock(void *hMem)')
  api.GlobalSize = kernel32.func('size_t GlobalSize(void *hMem)')
  api.GlobalAlloc = kernel32.func('void *GlobalAlloc(unsigned int uFlags, size_t dwBytes)')
  api.GlobalFree = kernel32.func('void *GlobalFree(void *hMem)')
  // 写剪贴板要把 JS 缓冲区内容拷进 GlobalAlloc 出来的内存；kernel32 不导出 memcpy，
  // 用它导出的 RtlMoveMemory（ABI 相同），源指针用 koffi.as 取。
  api.RtlMoveMemory = kernel32.func('void RtlMoveMemory(void *dest, const void *src, size_t count)')
  if (gdi32 !== null) {
    api.CreateRoundRectRgn = gdi32.func('void *CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)')
    api.CreateEllipticRgn = gdi32.func('void *CreateEllipticRgn(int x1, int y1, int x2, int y2)')
    api.DeleteObject = gdi32.func('bool DeleteObject(void *ho)')
  }
  if (dwmapi !== null) {
    api.DwmSetWindowAttribute = dwmapi.func('int DwmSetWindowAttribute(void *hwnd, unsigned int attribute, void *pvAttribute, unsigned int cbAttribute)')
  }
  return api
}

/** 前台线程的焦点控件与光标控件（用来区分"表格网格"和"文字编辑框"）。 */
export function foregroundEditor(api) {
  if (typeof api.GetGUIThreadInfo !== 'function') return null
  const info = { cbSize: api.sizeofGuiThreadInfo }
  if (!api.GetGUIThreadInfo(0, info)) return null
  return { focusClass: windowClass(api, info.hwndFocus), caretClass: windowClass(api, info.hwndCaret),
    caret: info.hwndCaret != null && info.hwndCaret !== 0, flags: Number(info.flags) }
}

/** 只枚举剪贴板里的格式名，不读任何格式的载荷。 */
export function clipboardFormats(api) {
  if (typeof api.EnumClipboardFormats !== 'function' || !api.OpenClipboard(null)) return []
  try {
    const formats = []
    for (let id = api.EnumClipboardFormats(0); id; id = api.EnumClipboardFormats(id)) {
      const buffer = new Uint16Array(256)
      const length = api.GetClipboardFormatNameW(id, buffer, buffer.length)
      formats.push(length > 0 ? String.fromCharCode(...buffer.subarray(0, length)) : String(id))
    }
    return formats
  } finally {
    api.CloseClipboard()
  }
}

/** 只查可执行文件路径，绝不碰命令行。 */
export function processImage(api, pid) {
  if (!(pid > 0) || typeof api.OpenProcess !== 'function') return ''
  const handle = api.OpenProcess(0x1000, false, pid)
  if (handle === null) return ''
  try {
    const buffer = new Uint16Array(32768)
    const size = [buffer.length]
    if (!api.QueryFullProcessImageNameW(handle, 0, buffer, size)) return ''
    return String.fromCharCode(...buffer.subarray(0, size[0]))
  } finally {
    api.CloseHandle(handle)
  }
}

/** 常量（避免业务代码里出现魔数）。 */
export const WIN = {
  VK_LBUTTON: 0x01,
  VK_CONTROL: 0x11,
  VK_C: 0x43,
  VK_ESCAPE: 0x1b,
  VK_MENU: 0x12,
  /** GetAncestor 的 GA_ROOT（取顶层祖先窗口）。 */
  GA_ROOT: 2,
  KEYEVENTF_KEYUP: 0x0002,
  CF_TEXT: 1,
  CF_UNICODETEXT: 13,
  GMEM_MOVEABLE: 0x0042,
  GWL_STYLE: -16,
  GWL_EXSTYLE: -20,
  WS_CAPTION: 0x00c00000,
  WS_THICKFRAME: 0x00040000,
  WS_POPUP: 0x80000000,
  WS_EX_TOOLWINDOW: 0x00000080,
  WS_EX_NOACTIVATE: 0x08000000,
  SWP_NOSIZE: 0x0001,
  SWP_NOMOVE: 0x0002,
  SWP_NOZORDER: 0x0004,
  SWP_NOACTIVATE: 0x0010,
  SWP_FRAMECHANGED: 0x0020,
  SWP_SHOWWINDOW: 0x0040,
  HWND_TOPMOST: -1,
  HWND_NOTOPMOST: -2,
  SW_HIDE: 0,
  SW_SHOWNOACTIVATE: 4,
  SW_SHOWNORMAL: 1,
  SPI_GETWORKAREA: 0x0030,
  WM_NCLBUTTONDOWN: 0x00a1,
  HTCAPTION: 2,
  DWMWA_WINDOW_CORNER_PREFERENCE: 33,
  DWMWCP_ROUND: 2,
}

/** UTF-16 缓冲区 → JS 字符串。 */
export function decodeUtf16(buffer) {
  const end = buffer.indexOf(0)
  const length = end === -1 ? buffer.length : end
  return Buffer.from(buffer.buffer, buffer.byteOffset, length * 2).toString('utf16le')
}

/** 读取窗口标题。 */
export function windowTitle(api, hwnd) {
  const buffer = new Uint16Array(512)
  api.GetWindowTextW(hwnd, buffer, buffer.length)
  return decodeUtf16(buffer)
}

/** 读取窗口类名。 */
export function windowClass(api, hwnd) {
  const buffer = new Uint16Array(256)
  api.GetClassNameW(hwnd, buffer, buffer.length)
  return decodeUtf16(buffer)
}

/** 窗口矩形（屏幕物理坐标）。 */
export function windowRect(api, hwnd) {
  const rect = {}
  if (!api.GetWindowRect(hwnd, rect)) return null
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

/**
 * 包含指定点的显示器工作区（排除任务栏）。
 * 多屏时浮层必须跟着"锚点所在的屏幕"走，不能再用 SPI_GETWORKAREA（那只返回主屏）。
 */
export function workAreaForPoint(api, x, y) {
  try {
    // MONITOR_DEFAULTTONEAREST = 2：点不在任何显示器内时给最近的一块，而不是主屏。
    const monitor = api.MonitorFromPoint({ x: Math.round(x), y: Math.round(y) }, 2)
    if (monitor !== null) {
      const info = { cbSize: api.koffi.sizeof(api.types.MONITORINFO) }
      if (api.GetMonitorInfoW(monitor, info)) {
        const work = info.rcWork
        return { left: work.left, top: work.top, right: work.right, bottom: work.bottom }
      }
    }
  } catch {
    /* 落到主屏 */
  }
  return primaryWorkArea(api)
}

/**
 * 指定点所在显示器的缩放系数（1.0 = 96dpi / 100%，1.5 = 150%）。
 * 用 GetDpiForMonitor 能拿到"目标显示器"的 DPI，因此在把窗口移过去之前就能算对尺寸。
 */
export function monitorScaleForPoint(api, x, y) {
  try {
    if (typeof api.GetDpiForMonitor === 'function') {
      const monitor = api.MonitorFromPoint({ x: Math.round(x), y: Math.round(y) }, 2)
      if (monitor !== null) {
        const dpiX = new Uint32Array(1)
        const dpiY = new Uint32Array(1)
        // MDT_EFFECTIVE_DPI = 0
        if (Number(api.GetDpiForMonitor(monitor, 0, dpiX, dpiY)) === 0 && dpiX[0] > 0) return dpiX[0] / 96
      }
    }
  } catch {
    /* 落到窗口 DPI */
  }
  try {
    const dpi = Number(api.GetDpiForWindow(api.GetForegroundWindow()))
    if (dpi > 0) return dpi / 96
  } catch {
    /* 落到 1.0 */
  }
  return 1
}

/** 窗口当前所在显示器的工作区。 */
export function workAreaForWindow(api, hwnd) {
  try {
    const monitor = api.MonitorFromWindow(hwnd, 2)
    if (monitor !== null) {
      const info = { cbSize: api.koffi.sizeof(api.types.MONITORINFO) }
      if (api.GetMonitorInfoW(monitor, info)) {
        const work = info.rcWork
        return { left: work.left, top: work.top, right: work.right, bottom: work.bottom }
      }
    }
  } catch {
    /* 落到主屏 */
  }
  return primaryWorkArea(api)
}

/** 主显示器工作区（排除任务栏）。 */
export function primaryWorkArea(api) {
  const rect = {}
  if (api.SystemParametersInfoW(WIN.SPI_GETWORKAREA, 0, rect, 0)) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  }
  return { left: 0, top: 0, right: 1920, bottom: 1080 }
}

/** 按精确标题查顶层窗口（Edge/Chrome 的 --app 窗口标题就是页面标题）。 */
export function findWindowByTitle(api, title) {
  const hwnd = api.FindWindowW(null, title)
  if (hwnd === null) return null
  return { hwnd, title: windowTitle(api, hwnd), pid: windowPid(api, hwnd) }
}

/** 找出所有标题以 prefix 开头的可见顶层窗口（用于清理上一次运行时遗留的浮层窗口）。 */
export function findAllWindowsByTitlePrefix(api, prefix) {
  const found = []
  const callback = api.koffi.register((hwnd) => {
    if (!api.IsWindowVisible(hwnd)) return true
    const title = windowTitle(api, hwnd)
    if (title.startsWith(prefix)) found.push({ hwnd, title, pid: windowPid(api, hwnd) })
    return true
  }, api.koffi.pointer(api.EnumWindowsProc))
  try {
    api.EnumWindows(callback, 0)
  } finally {
    api.koffi.unregister(callback)
  }
  return found
}

/** 按标题前缀查找可见顶层窗口（返回 { hwnd, title, pid } 或 null）。 */
export function findWindowByTitlePrefix(api, prefix) {
  const exact = findWindowByTitle(api, prefix)
  if (exact !== null) return exact
  let found = null
  const callback = api.koffi.register((hwnd) => {
    if (found !== null) return false
    if (!api.IsWindowVisible(hwnd)) return true
    const title = windowTitle(api, hwnd)
    if (title.startsWith(prefix)) {
      found = { hwnd, title, pid: windowPid(api, hwnd) }
      return false
    }
    return true
  }, api.koffi.pointer(api.EnumWindowsProc))
  try {
    api.EnumWindows(callback, 0)
  } finally {
    api.koffi.unregister(callback)
  }
  return found
}

/** 某个虚拟键此刻是否按着（GetAsyncKeyState 的最高位；读不到按"没按"处理）。 */
export function keyDown(api, vk) {
  try {
    return (Number(api.GetAsyncKeyState(vk)) & 0x8000) !== 0
  } catch {
    return false
  }
}

/** 剪贴板属主窗口（没人认领时返回 null）。 */
export function clipboardOwnerWindow(api) {
  try {
    if (typeof api.GetClipboardOwner !== 'function') return undefined
    const owner = api.GetClipboardOwner()
    if (owner === null || owner === undefined || owner === 0) return null
    return owner
  } catch {
    return undefined
  }
}

/** 窗口的顶层祖先（GetAncestor(GA_ROOT)）；读不到返回 null。 */
export function rootWindow(api, hwnd) {
  try {
    if (typeof api.GetAncestor !== 'function') return null
    const root = api.GetAncestor(hwnd, WIN.GA_ROOT)
    return root === null || root === undefined || root === 0 ? null : root
  } catch {
    return null
  }
}

/** 窗口所属进程 pid。 */
export function windowPid(api, hwnd) {
  const pid = new Uint32Array(1)
  api.GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}

/** 读剪贴板的 CF_UNICODETEXT（失败返回 null；调用方负责重试）。 */
export function readClipboardText(api) {
  if (!api.OpenClipboard(null)) return null
  try {
    const handle = api.GetClipboardData(WIN.CF_UNICODETEXT)
    if (handle === null) return null
    const pointer = api.GlobalLock(handle)
    if (pointer === null) return null
    try {
      const bytes = Number(api.GlobalSize(handle))
      const chars = Math.max(1, Math.min(Math.floor(bytes / 2), 1 << 20))
      const text = String(api.koffi.decode(pointer, 'char16_t', chars))
      return text.replace(/\u0000+$/u, '')
    } finally {
      api.GlobalUnlock(handle)
    }
  } finally {
    api.CloseClipboard()
  }
}

/** 写剪贴板 CF_UNICODETEXT。 */
export function writeClipboardText(api, text) {
  const buffer = Buffer.from(text + '\u0000', 'utf16le')
  const handle = api.GlobalAlloc(WIN.GMEM_MOVEABLE, buffer.length)
  if (handle === null) return false
  const pointer = api.GlobalLock(handle)
  if (pointer === null) {
    api.GlobalFree(handle)
    return false
  }
  api.RtlMoveMemory(pointer, api.koffi.as(buffer, 'uint8_t *'), buffer.length)
  api.GlobalUnlock(handle)
  if (!api.OpenClipboard(null)) {
    api.GlobalFree(handle)
    return false
  }
  try {
    api.EmptyClipboard()
    return api.SetClipboardData(WIN.CF_UNICODETEXT, handle) !== null
  } finally {
    api.CloseClipboard()
  }
}

/** 虚拟键 → 扫描码（拿不到返回 0）。 */
function scanCode(api, vk) {
  try {
    if (typeof api.MapVirtualKeyW !== 'function') return 0
    // MAPVK_VK_TO_VSC = 0；只要低字节（keybd_event 的 bScan 是 BYTE）。
    return Number(api.MapVirtualKeyW(vk, 0)) & 0xff
  } catch {
    return 0
  }
}

/**
 * 注入 Ctrl+<key>（默认 Ctrl+C）：与真实按键同样的路径，前台应用无法区分。
 *
 * 扫描码必须补上：相当一部分应用（Chromium/WebView2 一类的窗口，也就是 DSH 桌面端自己）
 * 对"没有扫描码的合成按键"不认，注入的 Ctrl+C 进不去，剪贴板一动不动——补上之后这条路
 * 才真的能兜底。
 */
export function sendCopyShortcut(api, key = WIN.VK_C) {
  const control = scanCode(api, WIN.VK_CONTROL)
  const scan = scanCode(api, key)
  api.keybd_event(WIN.VK_CONTROL, control, 0, 0)
  api.keybd_event(key, scan, 0, 0)
  api.keybd_event(key, scan, WIN.KEYEVENTF_KEYUP, 0)
  api.keybd_event(WIN.VK_CONTROL, control, WIN.KEYEVENTF_KEYUP, 0)
}

/** 去掉标题栏（保留可缩放边框），使其看起来像浮层而不是普通窗口。 */
export function stripCaption(api, hwnd) {
  const style = Number(api.GetWindowLongPtrW(hwnd, WIN.GWL_STYLE))
  api.SetWindowLongPtrW(hwnd, WIN.GWL_STYLE, style & ~WIN.WS_CAPTION)
  const exStyle = Number(api.GetWindowLongPtrW(hwnd, WIN.GWL_EXSTYLE))
  api.SetWindowLongPtrW(hwnd, WIN.GWL_EXSTYLE, exStyle | WIN.WS_EX_TOOLWINDOW)
  // hWndInsertAfter 必须给数字 0（声明为 intptr_t，不接受 null），SWP_NOZORDER 下该值被忽略。
  api.SetWindowPos(hwnd, 0, 0, 0, 0, 0, WIN.SWP_NOMOVE | WIN.SWP_NOSIZE | WIN.SWP_NOZORDER | WIN.SWP_FRAMECHANGED | WIN.SWP_NOACTIVATE)
  if (typeof api.DwmSetWindowAttribute === 'function') {
    const preference = Buffer.alloc(4)
    preference.writeInt32LE(WIN.DWMWCP_ROUND, 0)
    try {
      api.DwmSetWindowAttribute(hwnd, WIN.DWMWA_WINDOW_CORNER_PREFERENCE, preference, 4)
    } catch {
      /* 旧系统不支持圆角偏好，忽略 */
    }
  }
}

/** 设置窗口位置与尺寸（物理像素）。 */
export function moveResize(api, hwnd, x, y, width, height, { topmost = true, show = true } = {}) {
  let flags = WIN.SWP_NOACTIVATE
  if (show) flags |= WIN.SWP_SHOWWINDOW
  return api.SetWindowPos(hwnd, topmost ? WIN.HWND_TOPMOST : WIN.HWND_NOTOPMOST, Math.round(x), Math.round(y), Math.round(width), Math.round(height), flags)
}

/** 圆角矩形窗口区域（radius 为像素半径）。 */
export function setRoundRegion(api, hwnd, width, height, radius) {
  if (typeof api.CreateRoundRectRgn !== 'function') return false
  const region = api.CreateRoundRectRgn(0, 0, Math.round(width) + 1, Math.round(height) + 1, radius * 2, radius * 2)
  if (region === null) return false
  api.SetWindowRgn(hwnd, region, true)
  return true
}

/**
 * 在窗口内部指定偏移处设置区域（圆角矩形或圆）。
 *
 * 用途：Edge 的 --app 窗口会在客户区顶部画一条浏览器标题栏，浮层不需要它——
 * 把区域设在"内容区"上，标题栏与边框就会被裁掉（既不显示也不吃点击）。
 * @param left/top - 内容区相对窗口左上角的偏移（物理像素）。
 * @param width/height - 内容区尺寸（物理像素）。
 * @param circle - true 时裁成圆。
 * @param radius - 圆角半径（圆角矩形用）。
 */
export function setRegionAt(api, hwnd, left, top, width, height, circle = false, radius = 0) {
  if (typeof api.CreateRoundRectRgn !== 'function') return false
  const region = circle
    ? api.CreateEllipticRgn(left, top, left + width + 1, top + height + 1)
    : api.CreateRoundRectRgn(left, top, left + width + 1, top + height + 1, radius * 2, radius * 2)
  if (region === null) return false
  api.SetWindowRgn(hwnd, region, true)
  return true
}

/** 圆形窗口区域（悬浮球）。 */
export function setCircleRegion(api, hwnd, size) {
  if (typeof api.CreateEllipticRgn !== 'function') return false
  const region = api.CreateEllipticRgn(0, 0, Math.round(size) + 1, Math.round(size) + 1)
  if (region === null) return false
  api.SetWindowRgn(hwnd, region, true)
  return true
}

/** 让 Windows 自己接管拖动（页面标题栏按下时调用）。 */
export function beginNativeDrag(api, hwnd) {
  api.ReleaseCapture()
  api.SendMessageW(hwnd, WIN.WM_NCLBUTTONDOWN, WIN.HTCAPTION, 0)
}

/** 窗口 DPI 缩放（1.0 = 96dpi）。 */
export function windowScale(api, hwnd) {
  try {
    const dpi = Number(api.GetDpiForWindow(hwnd))
    return dpi > 0 ? dpi / 96 : 1
  } catch {
    return 1
  }
}
