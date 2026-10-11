/**
 * dsh-select-translate —— 客户端半边（页内卡片）。
 *
 * 🔒 **已冻结 · M1 终稿视觉基准。** 这张卡片是"长什么样"的唯一定义。
 * 系统级那条路（`companion/card.mjs`，GDI+ 自绘）必须与它对齐：尺寸、配色、字号、
 * 间距、图标形状（那边的图标坐标就是从这里 SVG 的 path 按 16 单位画布换算过去的）。
 *
 * 所以：**改视觉先改这里，再同步到 card.mjs**，不要只改一边。
 * 功能上的新东西（真取词、真译文、快捷键…）走宿主半边与伴生进程，不动这张卡的外观。
 *
 * 手写、无需构建：宿主把本文件当 `<script>` 经 /plugins 送达，脚本只调
 * `window.__ModuleLoader__.load({ id, factory })` 注册工厂，模块体在首次物化时才跑。
 * 译文目前是假数据，本地按字流式吐出来。
 *
 * 两个关键结构决定：
 *  1. 卡片用 `createPortal` 挂到 `document.body` 的直挂层（z-index 拉满）。
 *     不能留在 `shell.overlay` 里——那一层自带 z-index，是个层叠上下文，
 *     内部再高的 z-index 也压不过层外的窗口。
 *  2. 两个开关（⚡ 即划即译 / 📌 钉住）存在 localStorage，刷新后保留。
 */
window.__ModuleLoader__.load({
  id: 'dsh-select-translate',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const createPortal = typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal : null

    /* ────────────────────────── 常量 ────────────────────────── */

    const CARD_WIDTH = 380
    const GAP = 12
    const EDGE = 8
    const MAX_H_RATIO = 0.6
    const DEBOUNCE_MS = 280
    const CHUNK_MS = 22

    const HOST_ATTR = 'data-st-portal'
    const PORTAL_Z = 2147483000 // 压过应用内所有窗口/弹层

    const AUTO_KEY = 'dsh-select-translate:auto' // ⚡ 即划即译
    const PIN_KEY = 'dsh-select-translate:pin' // 📌 钉住

    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

    const LANGS = [
      { id: 'auto', label: '自动' },
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ]

    const DEMO_HITS = [
      { match: /scheduler multiplexes/i, zh: '调度器把 goroutine 复用到操作系统线程上。', en: 'The scheduler multiplexes goroutines onto OS threads.' },
      { match: /don'?t design windows/i, zh: '我不设计窗口。', en: "I don't design windows." },
      { match: /取词要稳/, zh: '取词要稳，翻译要快。', en: 'Capture must be reliable, and translation must be fast.' },
      { match: /宁可不显示/, zh: '宁可不显示，也不要显示错的。', en: 'Better to show nothing at all than to show something wrong.' },
      { match: /Copy\/Retranslate/i, zh: '复制／重译的间距与图标', en: 'Copy/Retranslate spacing and icons' },
    ]

    const DEMO_FALLBACK = {
      zh: [
        '这是一段演示译文，用来确认卡片的排版、流式节奏和跟随位置。',
        '演示数据 —— 真实译文会在 M2 接入 ctx.llm.stream 之后出现。',
      ],
      en: [
        'This is a demo translation, for reviewing the card layout, streaming rhythm, and positioning.',
        'Demo data only — the real translation arrives in M2 via ctx.llm.stream.',
      ],
    }

    function resolveTarget(text, target) {
      if (target === 'zh' || target === 'en') return target
      return CJK.test(text) ? 'en' : 'zh'
    }

    function pickDemo(text, target, variant) {
      const hit = DEMO_HITS.find((d) => d.match.test(text))
      if (hit !== undefined) return target === 'en' ? hit.en : hit.zh
      const list = DEMO_FALLBACK[target === 'en' ? 'en' : 'zh']
      return list[variant % list.length]
    }

    /* ────────────────────────── 直挂层 ────────────────────────── */

    let portalHost = null

    function getPortalHost() {
      if (portalHost !== null && document.body.contains(portalHost)) return portalHost
      const existing = document.querySelector('div[' + HOST_ATTR + ']')
      if (existing !== null) {
        portalHost = existing
      } else {
        portalHost = document.createElement('div')
        portalHost.setAttribute(HOST_ATTR, 'true')
        document.body.appendChild(portalHost)
      }
      // 内联写死：整层必须点击穿透，只有卡片本体自己收回 pointer-events
      portalHost.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:' + PORTAL_Z + ';'
      return portalHost
    }

    /* ────────────────────────── 开关持久化 ────────────────────────── */

    function readFlag(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return fallback
        return raw === '1'
      } catch {
        return fallback
      }
    }

    function writeFlag(key, value) {
      try {
        window.localStorage.setItem(key, value ? '1' : '0')
      } catch {
        /* 隐私模式等场景写不进去，忽略 */
      }
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    const STYLE_TAG_ID = 'dsh-select-translate/client.css'
    const CSS = `
.hc-root { pointer-events: none; }
.hc-card {
  position: fixed; display: flex; flex-direction: column; overflow: hidden;
  width: ${CARD_WIDTH}px; max-width: calc(100vw - 16px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #ffffff));
  color: var(--dsw-alias-label-primary, #1f2329);
  /* 头部统一降对比度：图标用浅灰；强调态只留"字形变蓝"，底色沿用原来的灰 */
  --hc-muted: var(--dsw-alias-label-tertiary, #8a94a6);
  --hc-subtle: var(--dsw-alias-label-secondary, #677183);
  --hc-accent: #4d6bfe; /* DeepSeek 蓝，固定值：主题令牌偏淡 */
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(16, 27, 50, .16), 0 2px 8px rgba(16, 27, 50, .06);
  pointer-events: auto;
  font-size: 14px; line-height: 1.6;
  animation: hc-in .14s ease-out;
}
@keyframes hc-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.hc-head {
  display: flex; align-items: center; gap: 2px; flex: 0 0 auto;
  height: 44px; padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e5e9f0);
}
.hc-title {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px; border: 0; border-radius: 8px;
  background: transparent; color: var(--hc-subtle);
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
}
.hc-title:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); color: var(--dsw-alias-label-primary, #1f2329); }
.hc-title .hc-sub { color: var(--hc-muted); font-weight: 400; }
.hc-badge {
  margin-left: 4px; padding: 1px 6px; border-radius: 5px;
  font-size: 10px; font-weight: 500; letter-spacing: .2px;
  color: var(--dsw-alias-label-secondary, #677183);
  background: var(--dsw-alias-bg-layer-1, rgba(31, 35, 41, .05));
}
.hc-spacer { flex: 1 1 auto; }
.hc-div { width: 1px; height: 16px; margin: 0 4px; background: var(--dsw-alias-border-l1, #e5e9f0); }
.hc-icon {
  display: inline-grid; place-items: center; flex: 0 0 auto;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--hc-muted); cursor: pointer;
  transition: color .12s, background .12s;
}
.hc-icon:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); color: var(--hc-subtle); }
.hc-icon[data-on="true"] {
  color: var(--hc-accent);
  background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06));
}
.hc-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 15px 18px;
  font-size: 15px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
  user-select: text;
  /* 细滚动条：与原生卡片（card.mjs 的 CARD.scrollbar）同宽同色 */
  scrollbar-width: thin;
  scrollbar-color: var(--hc-scroll, #c9cedb) transparent;
}
.hc-body::-webkit-scrollbar { width: 6px; height: 6px; }
.hc-body::-webkit-scrollbar-track { background: transparent; }
.hc-body::-webkit-scrollbar-thumb { background: var(--hc-scroll, #c9cedb); border-radius: 3px; }
.hc-body::-webkit-scrollbar-thumb:hover { background: var(--hc-muted, #8a94a6); }
.hc-body.is-empty { color: var(--dsw-alias-label-secondary, #677183); font-size: 14px; }
.hc-caret {
  display: inline-block; width: 2px; height: 1em; margin-left: 2px;
  vertical-align: -2px; background: var(--hc-accent, #4d6bfe);
  animation: hc-blink 1s steps(2, start) infinite;
}
@keyframes hc-blink { 50% { opacity: 0; } }
.hc-foot {
  display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
  height: 40px; padding: 0 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e5e9f0);
}
.hc-act {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, #677183);
  font: inherit; font-size: 12px; cursor: pointer;
}
.hc-act:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); color: var(--dsw-alias-label-primary, #1f2329); }
.hc-act:disabled { opacity: .45; cursor: default; }
.hc-langs {
  position: absolute; top: 40px; left: 10px; z-index: 1;
  min-width: 128px; padding: 4px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #ffffff));
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0); border-radius: 10px;
  box-shadow: 0 12px 28px rgba(16, 27, 50, .16);
}
.hc-lang {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; height: 30px; padding: 0 8px; border: 0; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; text-align: left;
}
.hc-lang:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, .06)); }
.hc-lang[data-on="true"] { color: var(--hc-accent, #4d6bfe); }
.hc-mini {
  position: fixed; display: grid; place-items: center;
  width: 24px; height: 24px; padding: 0;
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0); border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #ffffff));
  color: var(--dsw-alias-label-secondary, #677183);
  box-shadow: 0 6px 16px rgba(16, 27, 50, .18);
  pointer-events: auto; cursor: pointer;
  animation: hc-in .12s ease-out;
}
.hc-mini:hover { color: var(--dsw-alias-brand-primary, #4d6bfe); border-color: currentColor; }
.hc-set { display: flex; flex-direction: column; gap: 12px; max-width: 640px; padding: 4px 0 24px; }
.hc-set h2 { margin: 0; font-size: 20px; }
.hc-set p { margin: 0; color: var(--dsw-alias-label-secondary, #677183); font-size: 13px; }
.hc-set button {
  align-self: flex-start; height: 34px; padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l1, #e5e9f0); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1, transparent); color: inherit;
  font: inherit; font-size: 13px; cursor: pointer;
}
.hc-set button:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe); }
`

    function ensureStyles() {
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-select-translate' // 清理契约：client-modules 按它删除
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ────────────────────────── 图标 ────────────────────────── */

    function Icon(props) {
      const size = props.size ?? 16
      const base = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }
      switch (props.name) {
        case 'globe':
          return h('svg', base, h('circle', { cx: 8, cy: 8, r: 6 }), h('path', { d: 'M2 8h12' }), h('path', { d: 'M8 2c1.7 2 1.7 10 0 12M8 2c-1.7 2-1.7 10 0 12' }))
        case 'caret':
          return h('svg', base, h('path', { d: 'm4.5 6.5 3.5 3.5 3.5-3.5' }))
        case 'close':
          return h('svg', base, h('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }))
        case 'copy':
          return h('svg', base, h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 2 }), h('path', { d: 'M10.5 5.5v-1a2 2 0 0 0-2-2h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1' }))
        case 'retry':
          return h('svg', base, h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.68' }), h('path', { d: 'M13.5 3v3h-3' }))
        case 'check':
          return h('svg', base, h('path', { d: 'm3.5 8.5 3 3 6-7' }))
        case 'bolt':
          return h('svg', base, h('path', { d: 'M9.5 1.5 3.6 9h4.1l-1.2 5.5L13 7H8.9z' }))
        case 'pin':
          return h('svg', base, h('path', { d: 'M6.5 1.5h3' }), h('path', { d: 'M5.6 3.5h4.8v3.2l1.5 2H4.1l1.5-2z' }), h('path', { d: 'M8 8.7V14.3' }))
        default:
          return null
      }
    }

    /* ────────────────────────── 假流式 ────────────────────────── */

    function startDemoStream(options) {
      const full = pickDemo(options.text, options.target, options.variant)
      let index = 0
      const timer = window.setInterval(() => {
        index = Math.min(full.length, index + 1 + Math.floor(Math.random() * 2))
        options.onUpdate(full.slice(0, index), index >= full.length)
        if (index >= full.length) window.clearInterval(timer)
      }, CHUNK_MS)
      return () => window.clearInterval(timer)
    }

    /* ────────────────────────── 主组件 ────────────────────────── */

    function Overlay() {
      const [card, setCard] = React.useState(null)
      const [mini, setMini] = React.useState(null)
      const [pos, setPos] = React.useState(null)
      const [maxH, setMaxH] = React.useState(480)
      const [langOpen, setLangOpen] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [autoOn, setAutoOn] = React.useState(() => readFlag(AUTO_KEY, true))
      const [pinned, setPinned] = React.useState(() => readFlag(PIN_KEY, false))

      const rootRef = React.useRef(null)
      const cardRef = React.useRef(null)
      const posRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      const debounceRef = React.useRef(null)
      const pendingRef = React.useRef(null)
      const runIdRef = React.useRef(0)
      const variantRef = React.useRef(0)
      const lastSigRef = React.useRef(null)
      const copiedTimerRef = React.useRef(null)

      // 让监听器永远读到最新值，避免闭包过期
      const autoRef = React.useRef(autoOn)
      const pinRef = React.useRef(pinned)
      const cardStateRef = React.useRef(null)
      autoRef.current = autoOn
      pinRef.current = pinned
      cardStateRef.current = card

      const applyPos = React.useCallback((value) => {
        posRef.current = value
        setPos(value)
      }, [])

      const inside = React.useCallback((node) => {
        return rootRef.current !== null && node != null && rootRef.current.contains(node)
      }, [])

      const stopStream = () => {
        if (cancelRef.current !== null) {
          cancelRef.current()
          cancelRef.current = null
        }
      }

      /** 开卡片 + 起流。keepPlace = 钉住时"原地换内容"。 */
      const openCard = React.useCallback(
        (payload, keepPlace) => {
          runIdRef.current += 1
          const id = runIdRef.current
          stopStream()
          if (copiedTimerRef.current !== null) {
            window.clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = null
          }
          setCopied(false)
          setLangOpen(false)
          setMini(null)

          const pinnedKeep = keepPlace === true && cardStateRef.current !== null
          if (!pinnedKeep) applyPos(null)

          const target = resolveTarget(payload.text, payload.target ?? 'auto')
          const anchor = pinnedKeep ? { x: cardStateRef.current.x, y: cardStateRef.current.y } : { x: payload.x, y: payload.y }
          variantRef.current = 0
          setCard({
            id,
            x: anchor.x,
            y: anchor.y,
            text: payload.text,
            target: payload.target ?? 'auto',
            answer: '',
            status: 'running',
            keepPlace: pinnedKeep,
          })

          cancelRef.current = startDemoStream({
            text: payload.text,
            target,
            variant: 0,
            onUpdate: (answer, done) => {
              setCard((current) => {
                if (current === null || current.id !== id) return current
                return { ...current, answer, status: done ? 'done' : 'running' }
              })
            },
          })
        },
        [applyPos],
      )

      const openRef = React.useRef(openCard)
      openRef.current = openCard

      const closeCard = () => {
        stopStream()
        setLangOpen(false)
        setCard(null)
      }

      /* 选区侦测 */
      React.useEffect(() => {
        const isEditable = (node) => {
          const el = node == null ? null : node.nodeType === 1 ? node : node.parentElement
          return el != null && el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]') != null
        }

        const readSelection = () => {
          const selection = window.getSelection()
          if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
          const text = selection.toString().trim()
          if (text === '') return null
          const range = selection.getRangeAt(0)
          if (inside(range.commonAncestorContainer)) return null
          if (isEditable(range.commonAncestorContainer)) return null
          return { text, rect: range.getBoundingClientRect() }
        }

        const schedule = (payload) => {
          pendingRef.current = payload
          if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
          debounceRef.current = window.setTimeout(() => {
            debounceRef.current = null
            const next = pendingRef.current
            if (next === null) return
            // ⚡ 关掉即划即译 → 只出小图标，点一下才翻译
            if (autoRef.current) openRef.current(next, pinRef.current)
            else setMini({ x: next.x, y: next.y, text: next.text })
          }, DEBOUNCE_MS)
        }

        const onUp = (event) => {
          if (inside(event.target)) return
          const x = event.clientX
          const y = event.clientY
          window.setTimeout(() => {
            const found = readSelection()
            if (found === null) return
            const sig = found.text + '|' + Math.round(found.rect.left) + '|' + Math.round(found.rect.top)
            if (sig === lastSigRef.current) return
            lastSigRef.current = sig
            schedule({ x, y, text: found.text })
          }, 0)
        }

        const onDown = (event) => {
          if (inside(event.target)) return
          setLangOpen(false)
          setMini(null)
          if (pinRef.current) return // 📌 钉住：点别处不关，保留最新译文
          setCard(null)
        }

        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setLangOpen(false)
          setMini(null)
          setCard(null)
        }

        const onSelectionChange = () => {
          const selection = window.getSelection()
          if (selection === null || selection.isCollapsed) lastSigRef.current = null
        }

        const onDemo = (event) => {
          const detail = event.detail ?? {}
          openRef.current(
            {
              x: detail.x ?? Math.round(window.innerWidth * 0.55),
              y: detail.y ?? 140,
              text: detail.text ?? 'The scheduler multiplexes goroutines onto OS threads.',
            },
            false,
          )
        }

        document.addEventListener('mouseup', onUp, true)
        document.addEventListener('dblclick', onUp, true)
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('selectionchange', onSelectionChange)
        window.addEventListener('scroll', onDown, true)
        window.addEventListener('dsh-select-translate:demo', onDemo)

        return () => {
          document.removeEventListener('mouseup', onUp, true)
          document.removeEventListener('dblclick', onUp, true)
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('selectionchange', onSelectionChange)
          window.removeEventListener('scroll', onDown, true)
          window.removeEventListener('dsh-select-translate:demo', onDemo)
          if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
          if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
          stopStream()
        }
      }, [inside])

      /* 定位：量真实尺寸 → 夹进视口 / 越界翻转；钉住换内容时原地不动 */
      React.useLayoutEffect(() => {
        if (card === null) return
        if (card.keepPlace === true && posRef.current !== null) return
        const el = cardRef.current
        if (el === null) return
        const rect = el.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        let x = card.x + GAP
        let y = card.y + GAP
        if (x + rect.width > vw - EDGE) x = Math.max(EDGE, card.x - GAP - rect.width)
        if (y + rect.height > vh - EDGE) y = Math.max(EDGE, card.y - GAP - rect.height)
        x = Math.min(Math.max(EDGE, x), Math.max(EDGE, vw - rect.width - EDGE))
        applyPos({ x, y })
        setMaxH(Math.max(140, Math.min(vh * MAX_H_RATIO, vh - y - EDGE)))
      }, [card === null ? null : card.id, applyPos])

      /* ── 交互 ── */

      const toggleAuto = () => {
        const next = !autoOn
        setAutoOn(next)
        writeFlag(AUTO_KEY, next)
        if (next) setMini(null)
      }

      const togglePin = () => {
        const next = !pinned
        setPinned(next)
        writeFlag(PIN_KEY, next)
      }

      const retranslate = (text, target, keepPlace) => {
        runIdRef.current += 1
        const id = runIdRef.current
        stopStream()
        setCard((current) => (current === null ? current : { ...current, id, answer: '', status: 'running', keepPlace }))
        cancelRef.current = startDemoStream({
          text,
          target: resolveTarget(text, target),
          variant: variantRef.current,
          onUpdate: (answer, done) => {
            setCard((current) => {
              if (current === null || current.id !== id) return current
              return { ...current, answer, status: done ? 'done' : 'running' }
            })
          },
        })
      }

      const pickLang = (langId) => {
        if (card === null) return
        setLangOpen(false)
        variantRef.current = 0
        setCard((current) => (current === null ? current : { ...current, target: langId }))
        retranslate(card.text, langId, true)
      }

      const onRetry = () => {
        if (card === null) return
        variantRef.current += 1
        setCopied(false)
        retranslate(card.text, card.target, true)
      }

      const onCopy = () => {
        if (card === null || card.answer === '') return
        const done = () => {
          setCopied(true)
          if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
          copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1400)
        }
        if (navigator.clipboard?.writeText !== undefined) {
          navigator.clipboard.writeText(card.answer).then(done, () => fallbackCopy(card.answer, done))
        } else {
          fallbackCopy(card.answer, done)
        }
      }

      /* ── 渲染 ── */

      const showLangs = card !== null && langOpen
      const bodyText = card === null ? '' : card.answer
      const host = React.useMemo(() => getPortalHost(), [])

      const tree = h(
        'div',
        { className: 'hc-root', ref: rootRef, 'data-st-root': 'true', style: { pointerEvents: 'none' } },
        mini !== null &&
          h(
            'button',
            {
              type: 'button',
              className: 'hc-mini',
              'aria-label': '翻译选中的文字',
              title: '翻译',
              style: { left: mini.x + GAP + 'px', top: mini.y + GAP + 'px', pointerEvents: 'auto' },
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => openRef.current(mini, pinRef.current),
            },
            h(Icon, { name: 'globe', size: 14 }),
          ),
        card !== null &&
          h(
            'section',
            {
              className: 'hc-card',
              ref: cardRef,
              role: 'dialog',
              'aria-label': '划词翻译',
              'data-pinned': pinned ? 'true' : 'false',
              style: {
                left: (pos === null ? card.x + GAP : pos.x) + 'px',
                top: (pos === null ? card.y + GAP : pos.y) + 'px',
                maxHeight: maxH + 'px',
                visibility: pos === null ? 'hidden' : 'visible',
                pointerEvents: 'auto',
              },
            },
            h(
              'header',
              { className: 'hc-head', style: { position: 'relative' } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'hc-title',
                  'aria-haspopup': 'listbox',
                  'aria-expanded': showLangs,
                  onClick: () => setLangOpen((open) => !open),
                },
                h(Icon, { name: 'globe', size: 15 }),
                h('span', null, '翻译'),
                h('span', { className: 'hc-sub' }, (LANGS.find((l) => l.id === card.target) ?? LANGS[0]).label),
                h(Icon, { name: 'caret', size: 14 }),
              ),
              h('span', { className: 'hc-badge' }, '演示'),
              h('span', { className: 'hc-spacer' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'hc-icon',
                  'data-on': autoOn ? 'true' : 'false',
                  'aria-pressed': autoOn,
                  'aria-label': autoOn ? '即划即译：开' : '即划即译：关',
                  title: autoOn ? '即划即译：开' : '即划即译：关',
                  onClick: toggleAuto,
                },
                h(Icon, { name: 'bolt', size: 15 }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'hc-icon',
                  'data-on': pinned ? 'true' : 'false',
                  'aria-pressed': pinned,
                  'aria-label': pinned ? '已钉住：点别处不关闭' : '钉住：点别处不关闭',
                  title: pinned ? '已钉住：点别处不关闭' : '钉住：点别处不关闭',
                  onClick: togglePin,
                },
                h(Icon, { name: 'pin', size: 15 }),
              ),
              h('span', { className: 'hc-div' }),
              h('button', { type: 'button', className: 'hc-icon', 'aria-label': '关闭', title: '关闭', onClick: closeCard }, h(Icon, { name: 'close' })),
              showLangs &&
                h(
                  'div',
                  { className: 'hc-langs', role: 'listbox' },
                  LANGS.map((lang) =>
                    h(
                      'button',
                      {
                        key: lang.id,
                        type: 'button',
                        className: 'hc-lang',
                        role: 'option',
                        'aria-selected': card.target === lang.id,
                        'data-on': card.target === lang.id ? 'true' : 'false',
                        onClick: () => pickLang(lang.id),
                      },
                      h('span', null, lang.label),
                      card.target === lang.id ? h(Icon, { name: 'check', size: 14 }) : null,
                    ),
                  ),
                ),
            ),
            h(
              'div',
              { className: 'hc-body' + (bodyText === '' ? ' is-empty' : '') },
              bodyText === '' ? h('span', null, '翻译中') : h('span', null, bodyText),
              card.status === 'running' ? h('span', { className: 'hc-caret' }) : null,
            ),
            h(
              'footer',
              { className: 'hc-foot' },
              h(
                'button',
                { type: 'button', className: 'hc-act', disabled: bodyText === '', onClick: onCopy },
                h(Icon, { name: copied ? 'check' : 'copy', size: 15 }),
                h('span', null, copied ? '已复制' : '复制'),
              ),
              h('button', { type: 'button', className: 'hc-act', onClick: onRetry }, h(Icon, { name: 'retry', size: 15 }), h('span', null, '重译')),
            ),
          ),
      )

      return createPortal === null ? tree : createPortal(tree, host)
    }

    function fallbackCopy(text, done) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
        done()
      } catch {
        /* 复制失败就静默 */
      }
    }

    /* ────────────────────────── 设置页 ────────────────────────── */

    function SettingsSection() {
      return h(
        'div',
        { className: 'hc-set' },
        h('h2', null, '划词翻译'),
        h('p', null, 'M1 阶段：卡片外观 Demo，译文是假数据。真实取词与模型在 M2 接上。'),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              window.dispatchEvent(
                new CustomEvent('dsh-select-translate:demo', {
                  detail: { text: 'The scheduler multiplexes goroutines onto OS threads.', x: Math.round(window.innerWidth * 0.55), y: 140 },
                }),
              )
            },
          },
          '预览卡片',
        ),
        h('p', null, '卡片头部右侧：⚡ 即划即译开关（开启时划完即译；关闭则只出小图标，点一下才译）；📌 钉住（点别处不关闭、保留最新译文；再划词时窗口原地换内容）。'),
        h('p', null, '也可以直接在页面里划选任意文字：停手约 0.28 秒出结果。Esc 关闭。'),
      )
    }

    /* ────────────────────────── 注册 ────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-select-translate', order: 80 }, Overlay))
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-select-translate',
              order: 45,
              label: () => ((document.documentElement.lang || '').startsWith('zh') ? '划词翻译' : 'Word translate'),
            },
            SettingsSection,
          ),
        )
      },
    }
  },
})
