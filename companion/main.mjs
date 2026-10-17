/**
 * dsh-select-translate 伴生进程 —— 系统级划词：取词 + 原生卡片 + 真译文。
 *
 * 为什么必须独立进程：DSH 插件跑在 Electron 宿主的 Node 侧，拿不到全局鼠标、
 * 判断不了"这句话选完没有"，也起不了置顶窗口。这些只能在一个普通 Node 进程里做。
 *
 * 链路：
 *   40ms 轮询全局鼠标 → 手势（拖选/双击）
 *     → UI Automation 读选区（worker 线程 + 超时隔离，不碰剪贴板）
 *       → 原生分层窗口在锚点旁弹出卡片
 *         → POST 宿主的 /dsh-select-translate/api/translate（SSE）→ ctx.llm.stream 逐字回流
 *
 * 取词内核（win32 / gesture / context / uia / uia-worker / gdi / window）**衍生自** MIT 的
 * `fyisgod/dsh-selection-tools` @ 3f292d92（v0.8.2）：其中 win32 / gesture / uia / uia-worker
 * 与其上游版本逐字节相同，context / gdi / window 在上游基础上做了改动。
 * 卡片 UI（`card.mjs`）、编排（本文件）、`translate.mjs`、宿主半边与全部测试是本项目自己写的。
 * ⚠️ 上游的版权声明与 MIT 许可原文，以及逐文件改动说明，见本插件根目录 `THIRD-PARTY-NOTICES.md`
 * ——**那个文件必须随插件一起分发，不得删除**。
 *
 * ⚠️ 刻意**不做剪贴板兜底**（v1 不含 WPS/Office，见 方案.md §2）：取不到就是取不到。
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import {
  cardHitTest,
  cardLayout,
  clampScroll,
  langRowAt,
  normalizeLineBreaks,
  paintCard,
  paintTriggerIcon,
  triggerIconHit,
  triggerIconLayout,
  TRIGGER,
  TRIGGER_WINDOW,
  CARD,
} from './card.mjs'
import { createContextReader } from './context.mjs'
import { createGestureDetector } from './gesture.mjs'
import { hitZone } from './hitzone.mjs'
import { createEdgeDetector, pointInCardRect } from './input.mjs'
import { createGdi } from './native/gdi.mjs'
import { createNativeWindow } from './native/window.mjs'
import { computePlacement, clampWindowToWork } from './placement.mjs'
import { createTranslator } from './translate.mjs'
import { createWin32, monitorScaleForPoint, workAreaForPoint, windowClass, windowRect, windowTitle } from './win32.mjs'
import { resolveRuntimeFile } from '../settings.mjs'

/* ────────────────────────── 配置 ────────────────────────── */

const KOFFI_HINT = process.env.DSH_ST_KOFFI_HINT ?? ''
const ORIGIN = (process.env.DSH_ST_ORIGIN ?? '').replace(/\/$/, '')
const POLL_MS = Number(process.env.DSH_ST_POLL_MS ?? 40)
const UIA_TIMEOUT_MS = Number(process.env.DSH_ST_UIA_TIMEOUT_MS ?? 1800)
const LISTEN_PORT = Number(process.env.DSH_ST_PORT ?? 0)
/** 原文上限。**与宿主 `index.js` 的 MAX_TEXT 必须一致**（两边各自拦一道）。 */
const MAX_TEXT = 15000
/** 初始触发模式：宿主 spawn 时经 env 给（见 index.js）；拿不到就按即划即译。 */
const INITIAL_MODE = process.env.DSH_ST_MODE === 'icon' ? 'icon' : 'auto'
/** 宿主下发的路由令牌：打宿主 `/dsh-select-translate/api/*` 时必须带上（见 index.js 的 API_TOKEN）。 */
const HOST_TOKEN = process.env.DSH_ST_TOKEN ?? ''

const state = {
  startedAt: Date.now(),
  polls: 0,
  gestures: 0,
  recentGestures: [],
  lastProbe: null,
  lastTranslate: null,
  errors: [],
  /** 因为"窗口尺寸跟不上内容"而被丢弃重画的帧数（= 旧实现下会被裁掉底部的帧数）。 */
  resizes: 0,
  /** 绘制开销累计（诊断"文本越长单帧越贵"）：帧数 + 毫秒。 */
  paints: 0,
  paintMs: 0,
  /** 被"合帧"省掉的绘制次数（同一帧里连来多个 delta，只画最后一次）。 */
  paintSkips: 0,
  /** 运行时文件路径（写成功才有；给排障工具读端口与令牌）。 */
  runtimeFile: null,
}

function noteError(scope, error) {
  const message = error instanceof Error ? error.message : String(error)
  state.errors.push({ scope, message, at: Date.now() })
  if (state.errors.length > 20) state.errors.shift()
  process.stderr.write('[dsh-st] ' + scope + ': ' + message + '\n')
}

/**
 * 找到能解析出 koffi 的那个"锚点路径"。
 *
 * `createRequire(base)` 只用 base 的**目录**做解析起点，文件本身不必存在；
 * 而 UIA 跑在 worker 线程里，它需要一个能自己解析到 koffi 的锚点——传空串的话
 * worker 会退回 `import.meta.url`（插件目录下没有 node_modules）而解析失败，
 * 且失败会被静默吞成"读不到选区"。所以这里先试出一份确定可用的锚点再传下去。
 */
function resolveKoffiBase() {
  const candidates = []
  if (KOFFI_HINT !== '') candidates.push(/\.(js|mjs|cjs)$/.test(KOFFI_HINT) ? KOFFI_HINT : join(KOFFI_HINT, 'noop.js'))
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.endsWith('.js')) candidates.push(argv1)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    candidates.push(join(process.env.DSH_HOME, 'profiles', 'node_modules', 'noop.js'))
    candidates.push(join(process.env.DSH_HOME, 'profiles', 'web', 'noop.js'))
  }
  candidates.push(import.meta.url)
  for (const base of candidates) {
    try {
      createRequire(base)('koffi')
      return base
    } catch {
      /* 试下一个 */
    }
  }
  return KOFFI_HINT
}

/* ────────────────────────── Win32 / UIA / GDI+ ────────────────────────── */

const KOFFI_BASE = resolveKoffiBase()
const api = createWin32([KOFFI_BASE])

if (api === null) {
  process.stderr.write('[dsh-st] koffi 解析失败，系统级取词不可用\n')
  process.exit(3)
}

const reader = createContextReader({ koffiHint: KOFFI_BASE, timeoutMs: UIA_TIMEOUT_MS })
const gdi = createGdi(api.koffi)
gdi.startup()
gdi.ensureFamilies()

/* ────────────────────────── 卡片状态 ────────────────────────── */

/**
 * 卡片业务状态；由 setCard 就地合并（绘制期间回写 bodyHeight 要向调用方可见）。
 *
 * 卡片与小图标**共用同一个窗口**（`show()` 就是 `SetWindowPos`，换尺寸很便宜）：
 * `iconVisible` 决定这次画的是哪一张（见 onPaint/onHitTest/onClick）。
 */
const card = {
  visible: false,
  status: 'idle', // idle | running | done | error
  text: '',
  source: '',
  target: 'auto',
  /** 触发模式：`auto` = 即划即译；`icon` = 划词出小图标、点击才译。 */
  mode: INITIAL_MODE,
  // ↓ 小图标那套（只在 iconVisible 时有意义）
  iconVisible: false,
  iconAnchor: { x: 0, y: 0 },
  iconSource: '',
  iconHover: false,
  iconScale: 1,
  pinned: false,
  langOpen: false,
  hover: null,
  copied: false,
  bodyHeight: CARD.bodyLine,
  /** 文字全排下来要多高（可能远高于卡片上限）；由 paintCard 实测回写。 */
  contentHeight: CARD.bodyLine,
  /** 正文滚动偏移（DIP）；内容比卡片矮时恒为 0。 */
  scroll: 0,
  /** 流式跟随：生成中把视图钉在内容底部；用户手动往上滚会置 false（见 onWheel）。 */
  follow: true,
  langW: CARD.langW,
  copyW: CARD.copyW,
  retryW: CARD.retryW,
  scale: 1,
  anchor: { x: 0, y: 0 },
  /** 缓存当前这块屏的工作区（物理像素）；onPaint 里改尺寸时用来夹取。 */
  work: { left: 0, top: 0, right: 0, bottom: 0 },
  maxBodyDip: 400,
  requestId: 0,
  /** 滚动条透明度（0 = 不画）。滚动/流式跟随时淡入，停手约 0.7s 后淡出。 */
  scrollBarAlpha: 0,
  /** 滚动条"保持显示"的截止时间戳。 */
  scrollBarUntil: 0,
}

let hoverZone = null
let copiedTimer = null
/** 上一次单帧绘制耗时（ms）：用来自适应"合帧"间隔，见 requestPaint。 */
let lastPaintMs = 0
/** 已排队的绘制定时器（null = 没有排队）。 */
let paintTimer = null

/**
 * 请求重绘（**合帧**）。
 *
 * 流式期间 delta 比"一次重绘"来得还密（实测单帧 15–28ms，长文本最贵 53ms），
 * 逐个 delta 同步重绘会把事件循环占满、文字反而落后于模型 —— 这正是"等待时间"的来源。
 * 所以：同一时刻只排一帧，永远画**最新**的那份状态；间隔按上一帧耗时自适应，
 * 重绘再贵也不会吃掉全部时间（显示帧率降级，而不是把流式读取堵死）。
 */
function requestPaint() {
  if (paintTimer !== null) {
    state.paintSkips += 1
    if (card.status === 'running') return // 流式中：让已排队的那帧带上最新状态
    clearTimeout(paintTimer) // 非流式（点按钮、翻译结束）要立刻反馈：把这一帧提前
    paintTimer = null
  }
  const delay = card.status === 'running' ? Math.min(120, Math.max(20, Math.ceil(lastPaintMs * 1.1))) : 0
  paintTimer = setTimeout(() => {
    paintTimer = null
    if (card.visible || card.iconVisible) win.invalidate()
  }, delay)
}

/** 滚动条"动过"：刷新保持显示的截止时间（淡入由轮询推进）。 */
function touchScrollBar() {
  card.scrollBarUntil = Date.now() + CARD.scrollbar.holdMs
}

const win = createNativeWindow({
  api,
  gdi,
  className: 'DshSelectTranslateCardWnd',
  title: '划词翻译',
  initialState: card,
  onError: (error) => noteError('wndproc', error),
  // 头部当标题栏（可拖动、四向箭头），按钮区排除；卡片之外那圈阴影外扩穿透
  onHitTest: (x, y, data) => {
    if (data.iconVisible === true) return triggerIconHit(x / (data.iconScale ?? 1), y / (data.iconScale ?? 1))
    return hitZone(x / (data.scale ?? 1), y / (data.scale ?? 1), data)
  },
  onMouseDown: () => 'click',
  onPaint: (painter, width, height, data, scale) => {
    if (data.iconVisible === true) {
      paintTriggerIcon(painter, width, height, data, data.iconScale ?? scale ?? 1)
      return undefined
    }
    const s = data.scale ?? scale ?? 1
    const paintStartedAt = performance.now()
    const measured = paintCard(painter, width, height, data, s)
    const spent = performance.now() - paintStartedAt
    lastPaintMs = spent
    state.paints += 1
    state.paintMs += spent
    if (measured !== undefined) {
      data.bodyHeight = measured.bodyHeight
      data.contentHeight = measured.contentHeight
      data.scroll = measured.scroll
      data.langW = measured.langW
      data.copyW = measured.copyW
      data.retryW = measured.retryW
    }
    // 尺寸不对就**让 window.mjs 就地调好再重画一帧**（返回想要的矩形），
    // 不要再用 setTimeout 异步重排：流式读取会占住事件循环，那一帧会被裁掉底部。
    const layout = cardLayout(data.bodyHeight, data)
    const wantW = Math.round(layout.windowW * s)
    const wantH = Math.round(layout.windowH * s)
    if (Math.abs(wantW - width) <= 1 && Math.abs(wantH - height) <= 1) return undefined
    // 这一帧会被丢弃并重画：旧实现下它就是"底部被裁掉"的那一帧（/status 的 resizes 计数）
    state.resizes += 1
    const where = clampWindowToWork({ x: win.state.x, y: win.state.y, windowW: wantW, windowH: wantH, work: card.work })
    return { x: where.x, y: where.y, width: wantW, height: wantH }
  },
  /** 滚轮翻长译文（内容比卡片高时才滚得动）。一格滚 3 行。小图标形态没有内容可滚。 */
  onWheel: (delta) => {
    if (card.iconVisible) return false
    const moved = setScroll(card.scroll + (delta > 0 ? -1 : 1) * 3 * CARD.bodyLine)
    // 跟随模式跟着用户的意图走：滚到内容底就恢复"跟随最新"，往上滚就停住不再把他拽回去
    card.follow = atScrollBottom()
    touchScrollBar()
    return moved
  },
  onHover: (x, y, data) => {
    if (data.iconVisible === true) {
      const over = x >= 0 && triggerIconHit(x / (data.iconScale ?? 1), y / (data.iconScale ?? 1)) === 'client'
      if (over === (data.iconHover === true)) return false
      data.iconHover = over
      hoverZone = null
      return true
    }
    let zone = null
    if (x >= 0) {
      const s = data.scale ?? 1
      const layout = cardLayout(data.bodyHeight, data)
      const dipX = x / s
      const dipY = y / s
      if (data.langOpen === true) {
        const row = langRowAt(dipX, dipY, layout)
        zone = row === null ? null : 'lang:' + row
      } else {
        zone = cardHitTest(dipX, dipY, layout)
      }
    }
    if (zone === hoverZone) return false
    hoverZone = zone
    data.hover = zone
    return true
  },
  onClick: (x, y, data) => {
    if (data.iconVisible === true) {
      if (triggerIconHit(x / (data.iconScale ?? 1), y / (data.iconScale ?? 1)) !== 'client') return false
      void activateIcon()
      return true
    }
    const s = data.scale ?? 1
    const dipX = x / s
    const dipY = y / s
    const layout = cardLayout(data.bodyHeight, data)
    if (data.langOpen === true) {
      const row = langRowAt(dipX, dipY, layout)
      if (row !== null) {
        pickLang(row)
        return true
      }
      // 点菜单外只收起菜单，这一下不触发别的按钮（与 client.js 一致）
      setCard({ langOpen: false })
      return true
    }
    const zone = cardHitTest(dipX, dipY, layout)
    if (zone === null) return false
    handleCardAction(zone)
    return true
  },
})

/**
 * 改正文滚动位置（滚轮走这里）。
 * 夹取用**卡片实测的** contentHeight / bodyHeight：内容比卡片矮时上限就是 0，滚不动。
 * @returns 是否真的动了（动过才需要重绘）。
 */
function setScroll(next) {
  const clamped = clampScroll(next, card.contentHeight, card.bodyHeight)
  if (clamped === card.scroll) return false
  card.scroll = clamped
  return true
}

/** 当前是否已经滚到内容底部（流式跟随的"用户没在读旧内容"判据）。 */
function atScrollBottom() {
  const maxScroll = Math.max(0, card.contentHeight - card.bodyHeight)
  return card.scroll >= maxScroll - 1
}

/** 按锚点摆好卡片：量内容 → 算尺寸 → 越界翻转 → 夹进工作区。 */
function place(anchor, options = {}) {
  if (!options.keepBodyHeight) card.bodyHeight = CARD.bodyLine
  const s = monitorScaleForPoint(api, anchor.x, anchor.y)
  const work = workAreaForPoint(api, anchor.x, anchor.y)
  card.scale = s
  card.anchor = { x: anchor.x, y: anchor.y }
  // 正文最多占工作区 60% 高
  card.maxBodyDip = Math.max(60, ((work.bottom - work.top) / s) * 0.6 - CARD.headerH - CARD.footerH - CARD.padY * 2)

  const layout = cardLayout(card.bodyHeight, card)
  const w = Math.round(layout.windowW * s)
  const h = Math.round(layout.windowH * s)
  const { x, y } = computePlacement({ anchor, work, s, windowW: w, windowH: h })
  // 换成卡片形态（同一个窗口，两者互斥）
  card.iconVisible = false
  card.visible = true
  // 缓存这块屏的工作区：onPaint 里"内容长高了要改尺寸"时要用它夹取
  card.work = work
  win.show(x, y, w, h)
}

function hideCard() {
  card.visible = false
  card.iconVisible = false
  card.status = 'idle'
  card.hover = null
  card.langOpen = false
  card.scroll = 0
  hoverZone = null
  // 关卡片 = 中断在途请求（Esc / ✕ / 点外部关闭都走这里）。
  // 不中断的话模型会继续跑完：用户看不到，但照常计费（设计文档 F-18）。
  translator.cancel()
  win.hide()
}

/* ────────────────────────── 划词小图标（第二个触发模式） ────────────────────────── */

/** 按锚点摆好小图标（同一个窗口，换成图标尺寸与形态）。 */
function placeIcon(anchor) {
  const s = monitorScaleForPoint(api, anchor.x, anchor.y)
  const work = workAreaForPoint(api, anchor.x, anchor.y)
  card.iconScale = s
  card.iconAnchor = { x: anchor.x, y: anchor.y }
  const size = Math.round(TRIGGER_WINDOW * s)
  const { x, y } = computePlacement({
    anchor,
    work,
    s,
    windowW: size,
    windowH: size,
    metrics: { gap: TRIGGER.gap, shadow: TRIGGER.shadow, bodyWidth: TRIGGER.size },
  })
  card.work = work
  card.iconVisible = true
  card.iconHover = false
  win.show(x, y, size, size)
}

/**
 * 划词结束、且**确实取到了文字**时亮出小图标（图标模式）。
 * 取词在亮图标之前做：这样拖动窗口/滚动条这类"没选出文字"的手势不会弹图标；
 * 而且点击时不必再读一次选区（见交接文档 §5 与 设计文档 §4.3 的差异说明）。
 */
function showIcon(anchor, source) {
  card.iconSource = source
  placeIcon(anchor)
}

/** 收起小图标；卡片没在显示就把窗口一起藏掉。 */
function hideIcon() {
  if (card.iconVisible !== true) return
  card.iconVisible = false
  card.iconHover = false
  card.iconSource = ''
  if (card.visible) requestPaint()
  else win.hide()
}

/** 点了小图标：收起图标 → 换成卡片形态 → 翻译那次划词已经读到的原文。 */
async function activateIcon() {
  const text = card.iconSource
  const anchor = card.iconAnchor
  // 就地换形态（不再 hideIcon()：那会先隐藏窗口再显示，闪一下）
  card.iconVisible = false
  card.iconHover = false
  card.iconSource = ''
  if (typeof text !== 'string' || text.trim() === '') {
    win.hide()
    return
  }
  place(anchor)
  await startTranslate(text, card.target)
}

/** 鼠标离锚点太远就收起图标（"鼠标移开即消失"）。 */
function iconShouldDismiss(cursor) {
  if (card.iconVisible !== true) return false
  const distance = Math.hypot(cursor.x - card.iconAnchor.x, cursor.y - card.iconAnchor.y)
  return distance > TRIGGER.dismissDistance * (card.iconScale || 1)
}

/** 屏幕物理坐标是否落在小图标的圆里。 */
function pointInIcon(x, y) {
  const layout = triggerIconLayout()
  const s = card.iconScale || 1
  const localX = (x - win.state.x) / s
  const localY = (y - win.state.y) / s
  const circle = layout.circle
  const radius = circle.w / 2
  const dx = localX - (circle.x + radius)
  const dy = localY - (circle.y + radius)
  return dx * dx + dy * dy <= radius * radius
}

/** 屏幕物理坐标是否落在卡片本体里（不含四周给阴影留的外扩那圈）。 */
function pointInCard(x, y) {
  return pointInCardRect(x, y, { x: win.state.x, y: win.state.y }, card.scale, cardLayout(card.bodyHeight, card))
}

/** 就地改状态并重绘（重绘走合帧，见 requestPaint）。 */
function setCard(patch) {
  Object.assign(card, patch)
  // 正文在变（流式 delta）或滚动位置在变 → 滚动条该露脸
  if (patch.text !== undefined || patch.scroll !== undefined) touchScrollBar()
  if (card.visible || card.iconVisible) requestPaint()
}

/** 切换触发模式并**持久化到宿主**（宿主写 $DSH_HOME/dsh-select-translate.json）。 */
function setMode(mode) {
  const next = mode === 'icon' ? 'icon' : 'auto'
  if (card.mode === next) return next
  setCard({ mode: next })
  if (ORIGIN === '') return next
  void fetch(ORIGIN + '/dsh-select-translate/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(HOST_TOKEN === '' ? {} : { 'x-dsh-select-translate-token': HOST_TOKEN }) },
    body: JSON.stringify({ mode: next }),
  }).catch((error) => noteError('settings', error))
  return next
}

/** 选了目标语言：收起菜单并用同一段原文重译。 */
function pickLang(id) {
  setCard({ langOpen: false, target: id, copied: false })
  void startTranslate(card.source, id)
}

function handleCardAction(zone) {
  if (zone === 'close') return hideCard()
  // ⚡ = 即划即译开关；关掉改走小图标模式（不再是"什么都不做"），并持久化
  if (zone === 'bolt') return void setMode(card.mode === 'icon' ? 'auto' : 'icon')
  if (zone === 'pin') return setCard({ pinned: !card.pinned })
  if (zone === 'lang') return setCard({ langOpen: !card.langOpen })
  if (zone === 'retry') return void startTranslate(card.source, card.target)
  if (zone === 'copy') {
    try {
      api.OpenClipboard(null)
      api.EmptyClipboard()
      copyText(card.text)
      api.CloseClipboard()
    } catch (error) {
      noteError('copy', error)
    }
    setCard({ copied: true })
    if (copiedTimer !== null) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setCard({ copied: false }), 1400)
  }
}

/** 把译文写进剪贴板（只在用户点"复制"时发生，与取词链无关）。 */
function copyText(text) {
  const bytes = Buffer.from(text + '\0', 'utf16le')
  const handle = api.GlobalAlloc(0x0042 /* GMEM_MOVEABLE */, bytes.length)
  if (handle === null) return
  const target = api.GlobalLock(handle)
  if (target === null) return
  api.RtlMoveMemory(target, bytes, bytes.length)
  api.GlobalUnlock(handle)
  api.SetClipboardData(13 /* CF_UNICODETEXT */, handle)
}

/* ────────────────────────── 真译文（宿主 ctx.llm.stream） ────────────────────────── */

/** 翻译通道：内部保证 latest-wins + 可取消（帧切分与取消语义见 translate.mjs，已有单测）。 */
const translator = createTranslator({
  origin: ORIGIN,
  token: HOST_TOKEN,
  // 这次 run 还是不是卡片当前那一次：不是就整帧丢弃（迟到的旧译文不许盖到新卡片上）
  isCurrent: (requestId) => String(card.requestId) === String(requestId),
})

async function startTranslate(text, target) {
  // 行分隔符归一化：UIA 常给 `\r`，而提示词与原生排版都只认 `\n`（交接文档 §6 第 23 条）。
  // 放在这个入口，手势 / 小图标 / /simulate 三条路都覆盖到。
  const source = normalizeLineBreaks(text)
  if (source.trim() === '') return
  const requestId = card.requestId + 1
  let finish = null
  let hostTiming = null
  // 新一次译文：从头看，并开启流式跟随（生成中视图钉在底部，新译文出现在最后 1–2 行）
  setCard({
    requestId,
    status: 'running',
    text: '',
    source,
    target,
    visible: true,
    langOpen: false,
    copied: false,
    scroll: 0,
    follow: true,
  })

  // run 内部会先取消上一次在途请求
  const outcome = await translator.run({ text: source, target, requestId }, (event) => {
    if (event.type === 'delta') setCard({ text: event.answer, status: 'running' })
    else if (event.type === 'error') setCard({ text: event.message, status: 'error' })
    else if (event.type === 'done') {
      finish = event.finish ?? null
      hostTiming = event.timing ?? null
    }
  })

  // 被主动取消（Esc / 关卡片 / 新手势）：这不是失败，别弹红字
  if (outcome.aborted) return
  if (outcome.error !== null) {
    noteError('translate', outcome.error)
    setCard({ status: 'error', text: outcome.error.message, scroll: 0, follow: false })
    return
  }

  state.lastTranslate = {
    at: Date.now(),
    requestId,
    chars: source.length,
    answerChars: outcome.answer.length,
    firstTokenMs: outcome.firstTokenMs,
    totalMs: outcome.totalMs,
    target,
    // 截断诊断：长文本被 maxTokens 截断时这里是 'length'。
    // 适配器给的 reason 是对象（实测 {"kind":"stop"}），所以统一取成字符串再暴露。
    finish: typeof finish === 'string' ? finish : (finish?.kind ?? null),
    // 宿主那边的模型耗时。与 totalMs 的差 = **卡片落后模型多少**（合帧/绘制开销的直接指标）
    hostMs: typeof hostTiming?.totalMs === 'number' ? hostTiming.totalMs : null,
    hostFirstMs: typeof hostTiming?.firstTokenMs === 'number' ? hostTiming.firstTokenMs : null,
    paints: state.paints,
    paintMs: Math.round(state.paintMs),
    paintSkips: state.paintSkips,
  }
  // 宿主回过 error 帧时 card.status 已经是 error 了，别用 done 盖掉
  if (card.status === 'running') {
    // 生成结束：停止跟随、回到顶部 —— 卡片停下来时的常态应当是"从译文开头读"
    setCard({ status: outcome.answer === '' ? 'error' : 'done', text: outcome.answer || '模型没有返回内容', scroll: 0, follow: false })
  }
}

/* ────────────────────────── 手势 → 取词 → 卡片 ────────────────────────── */

async function handleGesture(gesture) {
  state.gestures += 1
  state.recentGestures.push({ kind: gesture.kind, x: gesture.x, y: gesture.y, at: Date.now() })
  if (state.recentGestures.length > 20) state.recentGestures.shift()

  // 新手势：收起上一次的小图标（新选区取代旧的）
  if (card.iconVisible === true) hideIcon()

  // 点在卡片自己身上：不算划词
  if (card.visible) {
    if (pointInCard(gesture.x, gesture.y)) return
    if (!card.pinned) hideCard()
  }

  const at = { x: gesture.x, y: gesture.y }
  const down = { x: gesture.downX, y: gesture.downY }

  let probe = null
  try {
    // retries: 2 —— Chromium/WebView2 是"被 UIA 问到才打开无障碍树"，冷启动第一次必失败
    probe = await reader.probe(at, { press: down, retries: 2 })
  } catch (error) {
    noteError('probe', error)
  }

  const selection = typeof probe?.selection === 'string' ? normalizeLineBreaks(probe.selection).trim() : ''
  state.lastProbe = {
    at: Date.now(),
    gesture: { kind: gesture.kind, x: gesture.x, y: gesture.y },
    selection: probe === null ? null : probe.selection,
    source: probe === null ? null : probe.source,
    candidates: probe === null ? null : probe.candidates,
  }

  if (selection === '') return // 没选到文字：什么都不弹（v1 不做剪贴板兜底）
  if (selection.length > MAX_TEXT) {
    place(at)
    setCard({ status: 'error', text: '选中的文本有 ' + selection.length + ' 字，超过 ' + MAX_TEXT + ' 字上限', source: selection })
    return
  }

  // 小图标模式：亮图标，等用户点（原文已经在手里，点击时不必再读一次选区）
  if (card.mode === 'icon') {
    showIcon(at, selection)
    return
  }

  // 钉住时原地换内容，不跳位
  if (!(card.pinned && card.visible)) place(at)
  await startTranslate(selection, card.target)
}

const detector = createGestureDetector({
  onGesture: (gesture) => void handleGesture(gesture),
  // 按下就判"点别处即关"：**单击（无位移、非双击）不产生任何手势**，
  // 所以这条不能写在 handleGesture 里——写在里面的话，单击卡片外部永远关不掉卡片
  // （只有"单击时手抖超过 5px"才会关）。
  onPress: (press) => {
    // 小图标：点在圆外就收起（点圆内走 onClick）
    if (card.iconVisible === true) {
      if (!pointInIcon(press.x, press.y)) hideIcon()
      return
    }
    if (!card.visible || card.pinned) return
    if (!pointInCard(press.x, press.y)) hideCard()
  },
})

const point = {}
/**
 * Esc 关卡片。
 *
 * 卡片是 `WS_EX_NOACTIVATE`，**永远收不到键盘消息**，所以只能像鼠标一样轮询。
 * 必须做按下边沿：直接看"按着没有"的话，按住 Esc 会 40ms 一次、一秒关 25 次。
 * 代价：这一下 Esc 也会照常传给下面的应用（没有键盘钩子就拦不住）。
 */
const isEscapeEdge = createEdgeDetector()
const timer = setInterval(() => {
  state.polls += 1
  try {
    if (!api.GetCursorPos(point)) return
    if (isEscapeEdge((api.GetAsyncKeyState(0x1b /* VK_ESCAPE */) & 0x8000) !== 0)) {
      if (card.iconVisible === true) hideIcon()
      else if (card.visible) hideCard()
    }
    // 鼠标移开就收起小图标（"移开即消失"）
    if (iconShouldDismiss(point)) hideIcon()
    // 滚动条淡入淡出：滚动/跟随期间为 1，停手 holdMs 后回 0；40ms 一步、约 3 步走完（fadeMs）。
    // 只在透明度真的变了才重绘（一次滚动最多多花 3 帧）。
    const barWant = Date.now() < card.scrollBarUntil ? 1 : 0
    if (card.scrollBarAlpha !== barWant && card.visible) {
      const step = Math.min(1, POLL_MS / CARD.scrollbar.fadeMs)
      card.scrollBarAlpha = barWant > card.scrollBarAlpha ? Math.min(barWant, card.scrollBarAlpha + step) : Math.max(barWant, card.scrollBarAlpha - step)
      requestPaint()
    }
    // 两种模式都要做手势检测：auto 直接译、icon 先亮图标
    const down = (api.GetAsyncKeyState(0x01) & 0x8000) !== 0
    detector.push({ down, x: point.x, y: point.y, time: Date.now() })
  } catch (error) {
    noteError('poll', error)
  }
}, POLL_MS)
timer.unref?.()

/* ────────────────────────── 本地 HTTP（宿主 + 排障） ────────────────────────── */

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  // 去掉可能的 BOM：PowerShell 的 utf8 重定向、部分客户端都会带上
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

const server = createServer((req, res) => {
  const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')

  if (url.pathname === '/ping') return json(res, 200, { ok: true, plugin: 'dsh-select-translate', role: 'companion' })

  if (url.pathname === '/status') {
    return json(res, 200, {
      ok: true,
      pid: process.pid,
      state: { ...state, pollMs: POLL_MS, uptimeMs: Date.now() - state.startedAt },
      uia: reader.stats(),
      card: {
        visible: card.visible,
        status: card.status,
        chars: card.text.length,
        mode: card.mode,
        iconVisible: card.iconVisible,
        iconSource: card.iconSource === '' ? '' : card.iconSource.slice(0, 40),
        pinned: card.pinned,
        langOpen: card.langOpen,
        target: card.target,
        bodyHeight: Math.round(card.bodyHeight),
        contentHeight: Math.round(card.contentHeight),
        scroll: Math.round(card.scroll),
        follow: card.follow,
        scrollBarAlpha: Number(card.scrollBarAlpha.toFixed(2)),
        langW: Math.round(card.langW),
        copyW: Math.round(card.copyW),
        retryW: Math.round(card.retryW),
      },
      window: {
        alive: win.isAlive(),
        scale: card.iconVisible ? card.iconScale : card.scale,
        rect: card.visible || card.iconVisible ? { x: win.state.x, y: win.state.y, w: win.state.width, h: win.state.height } : null,
      },
      origin: ORIGIN,
    })
  }

  if (url.pathname === '/hide') {
    hideCard()
    return json(res, 200, { ok: true })
  }

  /** 宿主推设置过来（用户改了模式）或排障时直接改。 */
  if (url.pathname === '/settings') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        if (parsed.mode === 'auto' || parsed.mode === 'icon') {
          // 只应用，不回写：回写由"用户点 ⚡"那一侧负责，避免两边互相推
          setCard({ mode: parsed.mode })
          if (parsed.mode === 'auto') hideIcon()
        }
        return json(res, 200, { ok: true, mode: card.mode })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  // 排障：直接亮出小图标（不必真的划词）；可选带 text 当"已读到的原文"
  if (url.pathname === '/icon') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const x = Math.round(Number(parsed.x ?? 400))
        const y = Math.round(Number(parsed.y ?? 300))
        showIcon({ x, y }, typeof parsed.text === 'string' ? parsed.text : '')
        return json(res, 200, { ok: true, mode: card.mode, rect: { x: win.state.x, y: win.state.y, w: win.state.width, h: win.state.height } })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  // 排障：等价于点了一下小图标
  if (url.pathname === '/icon/click') {
    void (async () => {
      const had = card.iconSource
      if (card.iconVisible !== true) return json(res, 200, { ok: true, clicked: false, message: 'icon not visible' })
      await activateIcon()
      await new Promise((resolve) => setTimeout(resolve, 50))
      return json(res, 200, { ok: true, clicked: true, source: had.slice(0, 40), card: { visible: card.visible, status: card.status } })
    })()
    return
  }

  // 排障：程序化滚动（滚轮走 onWheel，这里等价于转多少格）
  if (url.pathname === '/scroll') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const delta = Number(parsed.delta ?? 0)
        const moved = setScroll(Number.isFinite(delta) ? card.scroll + delta : 0)
        // 与真实滚轮同一套语义：滚到内容底恢复跟随，往上滚就停住；滚动条也跟着淡入
        card.follow = atScrollBottom()
        touchScrollBar()
        if (moved && card.visible) requestPaint()
        return json(res, 200, {
          ok: true,
          moved,
          scroll: Math.round(card.scroll),
          maxScroll: Math.round(Math.max(0, card.contentHeight - card.bodyHeight)),
          follow: card.follow,
        })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  // 排障：在指定坐标伪造一次划词（不需要真的动鼠标）
  if (url.pathname === '/simulate') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const x = Math.round(Number(parsed.x ?? 400))
        const y = Math.round(Number(parsed.y ?? 300))
        const text = typeof parsed.text === 'string' && parsed.text !== '' ? parsed.text : 'The scheduler multiplexes goroutines onto OS threads.'
        place({ x, y })
        setCard({ copied: false, source: text, langOpen: parsed.langOpen === true })
        if (parsed.fake === true) {
          // 假流式：不打宿主，直接把给定译文逐字吐出来（纯视觉验收用，节奏固定好断言）
          const full = typeof parsed.fakeText === 'string' ? parsed.fakeText : '调度器把 goroutine 复用到操作系统线程上。'
          card.requestId += 1
          const id = card.requestId
          // 与 startTranslate 同一套语义：从头看 + 打开跟随；结束时停止跟随并回到顶部
          setCard({ status: 'running', text: '', scroll: 0, follow: true })
          // fakeStep：每 tick 吐几个字（默认 1；调大能让长文本的视觉验收快很多）
          const step = Math.max(1, Math.min(200, Math.round(Number(parsed.fakeStep ?? 1))))
          // fakeTickMs：吐字间隔（默认 24ms）。调小可以模拟"模型吐得比我们画得快"，
          // 用来验收"合帧"是否让读取节奏不被重绘拖慢。
          const tickMs = Math.max(1, Math.min(200, Math.round(Number(parsed.fakeTickMs ?? 24))))
          let i = 0
          const tick = setInterval(() => {
            if (card.requestId !== id) return clearInterval(tick)
            i = Math.min(full.length, i + step)
            setCard({ text: full.slice(0, i) })
            if (i >= full.length) {
              clearInterval(tick)
              setCard({ status: 'done', scroll: 0, follow: false })
            }
          }, tickMs)
          return json(res, 200, { ok: true, mode: 'fake' })
        }
        await startTranslate(text, card.target)
        return json(res, 200, { ok: true, mode: 'translate' })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  // 排障：量字体真实推进量（判断 GDI+ 的 em 与请求像素差多少）
  if (url.pathname === '/measure') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const size = Number(parsed.size ?? CARD.bodyFont * card.scale)
        const out = { size }
        if (win.isAlive()) {
          gdi.withDoubleBuffer(win.state.hwnd, (painter) => {
            for (const n of [1, 2, 4, 8, 16]) {
              out['cjk' + n] = painter.measure('中'.repeat(n), { size }).width
            }
            out.ascii8 = painter.measure('DeepSeek', { size }).width
            out.space = painter.measure(' ', { size }).width
          })
        }
        return json(res, 200, { ok: true, measure: out })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  // 排障：按 DIP 坐标查这张卡片会返回哪个命中区（含拖动区）
  if (url.pathname === '/hittest') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const x = Number(parsed.x)
        const y = Number(parsed.y)
        const usable = Number.isFinite(x) && Number.isFinite(y)
        const layout = cardLayout(card.bodyHeight, card)
        return json(res, 200, {
          ok: true,
          zone: usable ? hitZone(x, y, card) : null,
          button: usable ? cardHitTest(x, y, layout) : null,
          menuRow: usable && card.langOpen ? langRowAt(x, y, layout) : null,
          layout: {
            card: layout.card,
            windowW: layout.windowW,
            windowH: layout.windowH,
            hitClose: layout.hitClose,
            hitPin: layout.hitPin,
            hitBolt: layout.hitBolt,
            dividerX: layout.dividerX,
            hitLang: layout.hitLang,
            hitCopy: layout.hitCopy,
            hitRetry: layout.hitRetry,
            langMenu: layout.langMenu,
          },
        })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  // 排障：按 DIP 坐标点一下卡片（等价于用户点击）
  if (url.pathname === '/click') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const x = Number(parsed.x)
        const y = Number(parsed.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return json(res, 400, { ok: false, message: 'x/y required' })
        const layout = cardLayout(card.bodyHeight, card)
        const row = card.langOpen ? langRowAt(x, y, layout) : null
        const zone = row !== null ? 'lang:' + row : cardHitTest(x, y, layout) ?? null
        if (parsed.probe === true) return json(res, 200, { ok: true, zone, menuRow: row })
        if (row !== null) {
          pickLang(row)
          return json(res, 200, { ok: true, zone })
        }
        if (zone === null) {
          if (card.langOpen) {
            setCard({ langOpen: false })
            return json(res, 200, { ok: true, zone: null, message: 'menu closed' })
          }
          return json(res, 200, { ok: true, zone: null, message: 'no hit' })
        }
        handleCardAction(zone)
        return json(res, 200, { ok: true, zone })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  if (url.pathname === '/probe') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const x = Math.round(Number(parsed.x))
        const y = Math.round(Number(parsed.y))
        if (!Number.isFinite(x) || !Number.isFinite(y)) return json(res, 400, { ok: false, message: 'x/y required' })
        const press =
          Number.isFinite(Number(parsed.pressX)) && Number.isFinite(Number(parsed.pressY))
            ? { x: Math.round(Number(parsed.pressX)), y: Math.round(Number(parsed.pressY)) }
            : undefined
        return json(res, 200, { ok: true, probe: await reader.probe({ x, y }, { press, retries: 2 }) })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  if (url.pathname === '/diagnose') {
    void (async () => {
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const x = Math.round(Number(parsed.x))
        const y = Math.round(Number(parsed.y))
        if (!Number.isFinite(x) || !Number.isFinite(y)) return json(res, 400, { ok: false, message: 'x/y required' })
        return json(res, 200, { ok: true, report: await reader.diagnose({ x, y }) })
      } catch (error) {
        return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return
  }

  if (url.pathname === '/where') {
    try {
      const pt = {}
      api.GetCursorPos(pt)
      const hwnd = api.GetForegroundWindow()
      return json(res, 200, {
        ok: true,
        cursor: { x: pt.x, y: pt.y },
        screen: { width: api.GetSystemMetrics(0), height: api.GetSystemMetrics(1) },
        foreground: hwnd === null ? null : { title: windowTitle(api, hwnd), className: windowClass(api, hwnd), rect: windowRect(api, hwnd) },
      })
    } catch (error) {
      return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return json(res, 404, { ok: false, message: 'not found' })
})

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  const port = server.address().port
  try {
    win.create()
  } catch (error) {
    noteError('window', error)
  }
  // 宿主靠这一行正则抓端口（0 = 随机端口）。走 stdout 私有管道，网页读不到。
  process.stdout.write('dsh-select-translate companion listening on http://127.0.0.1:' + port + '\n')
  // 运行时文件：给本机排障工具（真进程冒烟脚本）拿"随机端口 + 宿主令牌"。
  // 它不扩大攻击面：网页读不到本机文件；能读文件的本地进程本来也能读别的。
  const runtimeFile = resolveRuntimeFile()
  if (runtimeFile !== '') {
    try {
      mkdirSync(dirname(runtimeFile), { recursive: true })
      writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, port, hostToken: HOST_TOKEN, origin: ORIGIN, startedAt: Date.now() }, null, 2) + '\n', 'utf8')
      state.runtimeFile = runtimeFile
    } catch (error) {
      noteError('runtime-file', error)
    }
  }
})

/* ────────────────────────── 收尾 ────────────────────────── */

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('uncaughtException', (error) => noteError('uncaught', error))
process.on('unhandledRejection', (error) => noteError('unhandledRejection', error))
