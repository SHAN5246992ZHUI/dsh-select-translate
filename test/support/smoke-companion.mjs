/**
 * 真进程冒烟检查（**按需运行，不参与 `pnpm test`**）。
 *
 * 单元测试验的是"纯逻辑对不对"；这个脚本验的是"**跑起来的那个伴生进程**好不好使"：
 * 重启伴生进程 → 打它自己的排障端点 → 核对命中区、落位/翻转、真实字体度量、真译文。
 *
 * 改过 `companion/**` 之后建议跑一遍（不必重启 DSH）：
 *
 *   node test/support/smoke-companion.mjs
 *
 * 前置：DSH 桌面端在跑（脚本经宿主的 `/system/restart` 重启伴生进程）。
 * 会真的弹一次卡片（结束前自动 /hide），所以别在演示时跑。
 */
import { readFileSync } from 'node:fs'

import { resolveRuntimeFile } from '../../settings.mjs'

/** 宿主 origin 的兜底值：正常情况从运行时文件读（桌面端端口不是固定的）。 */
const DEFAULT_HOST_ORIGIN = 'http://127.0.0.1:19387'
const CARD = { width: 380, shadow: 14, headerH: 44, footerH: 40, bodyLine: 25, padY: 15, edge: 8 }
const TRIGGER = { size: 24, shadow: 10, gap: 12 }
const TRIGGER_WINDOW = TRIGGER.size + TRIGGER.shadow * 2

const json = async (url, options) => {
  // 长文本流式期间本脚本会高频轮询 /status，偶发 ECONNRESET（客户端连接池的坏连接，
  // 伴生进程没崩、译文照常完成）——重试一次就过去了，别让整个脚本半路死掉。
  let last = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await (await fetch(url, options)).json()
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  throw last
}
const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 引导：宿主路由要令牌（见 index.js 的 API_TOKEN），而它不在任何公开端点上 ──
 * 伴生进程启动时会把"随机端口 + 宿主令牌"写进运行时文件（`$DSH_HOME/dsh-select-translate-runtime.json`），
 * 这个文件就是本脚本唯一的引导入口：令牌给宿主用、端口给伴生进程用。
 * 没有它，脚本既不知道端口、也打不动宿主的 /system/restart。
 */
const RUNTIME_FILE = resolveRuntimeFile()
function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'))
  } catch {
    return null
  }
}
const bootRuntime = readRuntime()
if (bootRuntime === null || typeof bootRuntime.hostToken !== 'string' || bootRuntime.hostToken === '') {
  console.error(`✗ 读不到运行时文件 ${RUNTIME_FILE}（DSH 桌面端没在跑？或宿主/伴生还是旧版，重启一次桌面端即可）`)
  process.exit(1)
}
const HOST_TOKEN = bootRuntime.hostToken
/**
 * 宿主 origin 从**运行时文件**读：桌面端端口不是固定的（旧稿硬编码 19387，端口一变就连不上，
 * 表现为 `fetch failed / ECONNREFUSED 127.0.0.1:19387`，会被误当成冒烟失败）。
 */
const HOST = `${String(bootRuntime.origin ?? DEFAULT_HOST_ORIGIN).replace(/\/$/, '')}/dsh-select-translate/api`
/** 打宿主路由（自动带令牌）。 */
const hostJson = (path, options = {}) => json(HOST + path, { ...options, headers: { 'content-type': 'application/json', 'x-dsh-select-translate-token': HOST_TOKEN, ...(options.headers ?? {}) } })
const hostGet = (path) => hostJson(path)
const hostPost = (path, body) => hostJson(path, { method: 'POST', body: JSON.stringify(body) })
console.log(`运行时文件：${RUNTIME_FILE}（令牌已取到，${HOST_TOKEN.length} 字符）`)

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : '  → ' + detail}`)
  if (!ok) failures.push(label)
}

/**
 * 外部干扰的软检查。
 *
 * 这个脚本跑的时候**人可能正在用这个插件**：一次真实划词就会把我们的伪造请求顶掉
 * （latest-wins 是对的），把 ⚡ 切模式也会改变后续行为 —— 那都不该算脚本失败。
 * 所以脆弱的一节先记"外来指纹"（手势数 / 模式 / 最近一次翻译时间），结束对比；
 * 被打断就报 ⚠ 跳过（不计失败），并说清原因。
 */
async function fingerprint() {
  const st = await json(`${C}/status`)
  return { gestures: st.state.gestures, mode: st.card.mode, lastAt: st.state.lastTranslate?.at ?? 0 }
}
function interfered(before, after) {
  if (before === null || after === null) return false
  if (after.gestures > before.gestures) return '期间有真实鼠标手势'
  if (after.mode !== before.mode) return '期间模式被切换'
  if (after.lastAt !== before.lastAt) return '期间有外部划词'
  return null
}
/** 被打断就 ⚠ 跳过，否则按断言判定。 */
function checkUnlessInterfered(label, reason, ok, detail) {
  if (reason !== null) {
    console.log(`  ⚠ 跳过 ${label} —— ${reason}（本次运行期间有人在使用插件）`)
    return
  }
  check(label, ok, detail)
}

/**
 * 等一个"静默窗口"：连续 2 秒内没有真实手势 / 外部划词 / 模式切换。
 *
 * 脚本后面几节依赖"卡片状态不会被别人改"（伪造划词、假流式）。人一边用一边跑就会互相顶掉
 * （latest-wins 本来就是对的），那种失败没有信息量。等不到静默窗口就跳过那几节。
 */
async function quietWindow(timeoutMs = 8000) {
  const started = Date.now()
  let current = await json(`${C}/status`)
  while (Date.now() - started < timeoutMs) {
    const snap = { gestures: current.state.gestures, mode: current.card.mode, lastAt: current.state.lastTranslate?.at ?? 0 }
    await sleep(2000)
    current = await json(`${C}/status`)
    const same = current.state.gestures === snap.gestures && current.card.mode === snap.mode && (current.state.lastTranslate?.at ?? 0) === snap.lastAt
    if (same) return true
  }
  return false
}

/* 1. 重启伴生进程，等它就绪 -------------------------------------------------- */
const restarted = await hostPost('/system/restart', {})
console.log('重启伴生进程 →', JSON.stringify(restarted.companion))

// 重启后运行时文件会被新进程重写：等 pid 变化（别拿到旧端口，那是个死端口）
let runtime = null
let port = 0
for (let i = 0; i < 40; i++) {
  runtime = readRuntime()
  if (runtime !== null && runtime.pid !== bootRuntime.pid && Number(runtime.port) > 0) {
    port = Number(runtime.port)
    break
  }
  await sleep(250)
}
if (port === 0) {
  console.error('✗ 伴生进程没起来（运行时文件没更新）：', JSON.stringify(runtime))
  process.exit(1)
}
const C = `http://127.0.0.1:${port}`
const hostStatus = await hostGet('/system/status')
console.log(`伴生进程 running :${port}\n模型座 = ${JSON.stringify(hostStatus.model)}\n`)

/* 1b. 路由令牌（§5.2 P1-④）：不带令牌必须 401，/ping 例外 ---------------------- */
// 宿主还没重启过就是旧版（不要求令牌）——那种情况下说清楚，别当成失败。
const bareStatus = await fetch(`${HOST}/settings`).then((r) => r.status).catch(() => 0)
if (bareStatus === 401) {
  check('宿主路由要令牌：不带 x-dsh-select-translate-token → 401', true, 'status=401')
  const pingStatus = await fetch(`${HOST}/ping`).then((r) => r.status).catch(() => 0)
  check('/ping 不需要令牌（存活探测）', pingStatus === 200, `status=${pingStatus}`)
  const wrong = await fetch(`${HOST}/system/status`, { headers: { 'x-dsh-select-translate-token': 'wrong-token' } }).then((r) => r.status).catch(() => 0)
  check('令牌不对 → 401', wrong === 401, `status=${wrong}`)
} else {
  console.log(`  ⚠ 跳过令牌校验：宿主路由还没要求令牌（不带令牌返回 ${bareStatus}）→ 宿主仍是旧版，重启桌面端后自动生效`)
}

// 脚本后面要测"小图标模式"，会切 ⚡ —— **运行前的模式必须记下来，收尾还原**，
// 免得把用户的真实选择覆盖成 auto。
const originalMode = (await json(`${C}/status`)).card.mode
// 宿主有 /settings 路由就走宿主（真实路径）；还没重启过就退回直接命令伴生进程。
const hostSettings = await hostGet('/settings').catch(() => null)
const settingsLive = hostSettings !== null && hostSettings.ok === true
const switchMode = (mode) => (settingsLive ? hostPost('/settings', { mode }) : post(`${C}/settings`, { mode }))

/* 2. 进程与窗口 -------------------------------------------------------------- */
let s = await json(`${C}/status`)
console.log('进程状态')
check('窗口存活', s.window.alive === true)
check('UIA 通道没报错', s.uia.timeouts === 0 && s.uia.errors === 0, JSON.stringify(s.uia.lastError))
check('还没划词时卡片不可见', s.card.visible === false)

/* 3. 命中区（HTCAPTION 收不到点击 / 阴影外扩要穿透） ------------------------- */
console.log('\n命中区 /hittest（s=1.25 下按 DIP 传）')
const zones = [
  ['关闭按钮', 372, 36, 'hand'],
  ['页眉空白', 200, 22, 'caption'],
  ['正文', 200, 100, 'client'],
  ['卡片之外', 200, 400, 'transparent'],
]
for (const [label, x, y, want] of zones) {
  const result = await post(`${C}/hittest`, { x, y })
  check(`${label} → ${want}`, result.zone === want, `实际 ${result.zone}`)
}

/* 4. 真实字体度量（假度量模型就是照它校准的） -------------------------------- */
console.log('\n真实字体度量 /measure（size=18.75）')
const measured = await post(`${C}/measure`, { size: 18.75 })
const measure = measured.measure ?? {}
const advance = (measure.cjk8 - measure.cjk1) / 7
check('单字盒宽 ≈ 25.55', Math.abs(measure.cjk1 - 25.55) < 0.05, String(measure.cjk1))
check('净推进（8字−1字）/7 ≈ 19.31', Math.abs(advance - 19.31) < 0.05, String(advance))
check('前导边距 ≈ size/3', Math.abs(measure.cjk1 - advance - 18.75 / 3) < 0.05, String(measure.cjk1 - advance))

/* 5. 落位 + 真译文 ----------------------------------------------------------- */
// 先钉住：钉住的卡片按设计"点别处不关"，所以**旁边有真人在动鼠标**也不会把卡片关掉
// （第一版没钉，跑的时候被一次外部点击关掉了——那正好说明"点别处即关"生效了）。
async function togglePin() {
  const layout = (await post(`${C}/hittest`, { x: 0, y: 0 })).layout
  const pin = layout.hitPin
  return post(`${C}/click`, { x: pin.x + pin.w / 2, y: pin.y + pin.h / 2 })
}

console.log('\n落位 /simulate + 真译文')
await post(`${C}/simulate`, { x: 400, y: 300, text: 'The scheduler multiplexes goroutines onto OS threads.' })
await togglePin()
s = await json(`${C}/status`)
check('📌 钉住按钮生效（钉住后不受外部点击影响）', s.card.pinned === true)
await post(`${C}/simulate`, { x: 400, y: 300, text: 'The scheduler multiplexes goroutines onto OS threads.' })
s = await json(`${C}/status`)
const scale = s.window.scale
const gap = Math.round(12 * scale)
const shadow = Math.round(CARD.shadow * scale)
const layoutW = CARD.width + CARD.shadow * 2
const layoutH = (CARD.headerH + CARD.bodyLine + CARD.padY * 2 + CARD.footerH) + CARD.shadow * 2
check('卡片在屏上', s.window.rect !== null, JSON.stringify(s.window.rect))
check('落位 = 锚点右下 12（按该屏 DPI 取整）', s.window.rect?.x === 400 + gap - shadow && s.window.rect?.y === 300 + gap - shadow, JSON.stringify(s.window.rect))
check('窗口宽度 = 布局宽 × 缩放', s.window.rect?.w === Math.round(layoutW * scale), `${s.window.rect?.w} vs ${Math.round(layoutW * scale)}`)
check('译文非空', (s.state.lastTranslate?.answerChars ?? 0) > 0, JSON.stringify(s.state.lastTranslate))
check('首字延迟有值', typeof s.state.lastTranslate?.firstTokenMs === 'number')

/* 6. 越界翻转 ---------------------------------------------------------------- */
// 钉住时卡片按设计"原地不动"，所以先取消钉住
console.log('\n越界翻转')
await togglePin()
await post(`${C}/simulate`, { x: 2520, y: 1450, text: 'Bottom right corner flip check.' })
s = await json(`${C}/status`)
const rect = s.window.rect
const screen = await json(`${C}/where`)
check('取消钉住后卡片跟着走', s.card.pinned === false)
check('向右越界 → 翻到锚点左侧', rect !== null && rect.x < 2520, `x=${rect?.x}`)
check('向下越界 → 翻到锚点上方', rect !== null && rect.y < 1450, `y=${rect?.y}`)
check('整窗仍在屏内', rect !== null && rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= screen.screen.width, JSON.stringify(rect))

/* 7. 并发划词：后一次必须接管，且"取消"不能变成错误 ------------------------- */
console.log('\n并发划词（latest-wins + 取消，P0-2 的集成验证）')
await togglePin() // 再钉住，避免旁人的点击把卡片关掉影响下面的断言
const firstText = 'First selection that must be superseded by the second one.'
const secondText = 'Second selection that must win the race.'
// 先发起第一次、**等它确实在跑**，再发起第二次。
// （不能用 Promise.all 同时发两个：谁先到达 startTranslate 是竞态，断言会时好时坏 —— 踩过。）
void post(`${C}/simulate`, { x: 300, y: 300, text: firstText })
for (let i = 0; i < 200; i++) {
  if ((await json(`${C}/status`)).card.status === 'running') break
  await sleep(10)
}
await post(`${C}/simulate`, { x: 300, y: 320, text: secondText })
await sleep(300)
s = await json(`${C}/status`)
// 用"第二段原文的长度"判定谁赢了：requestId 是累加值，硬编码会随步骤增多而失效
check('后一次接管（lastTranslate 记的是第二段原文）', s.state.lastTranslate?.chars === secondText.length, JSON.stringify(s.state.lastTranslate))
check('先发起的那次没有被记成错误', s.state.errors.length === 0, JSON.stringify(s.state.errors))
check('卡片上是后一次的译文', s.card.status === 'done' && s.card.chars > 0, `status=${s.card.status} chars=${s.card.chars}`)

/* 8. 长文本（可选：--long）-------------------------------------------------- */
// 需要宿主已加载新版 index.js（改过宿主半边就必须重启桌面端，禁用再启用也换不掉 ESM 缓存）。
// 8–10 节要"没人同时在用插件"：真实划词会把伪造请求顶掉（latest-wins 是对的），切模式会改行为。
const quiet = await quietWindow()
if (!quiet) console.log('  ⚠ 检测到你正在使用插件（有真实划词 / 切模式）→ 8–10 节跳过；不用它时重跑即可')
if (quiet) {
if (process.argv.includes('--long')) {
  console.log('\n长文本 4000 字（--long；会真花一次模型调用）')
  // ⚠️ 长文本必须**真实多样**，不能"同一句重复 80 遍"：重复输入会让模型自己也复读，
  // 输出无限膨胀撞上 maxTokens 上限 → `finish: max-tokens`，于是「没被截断」那条检查会**假失败**
  // （实测：同句重复的 4000 字输入产出 6400 字译文被截断；换成下面这种多样文本就稳定 `stop`）。
  const paragraphs = [
    'The scheduler multiplexes thousands of goroutines onto a small number of operating system threads, and the runtime decides when a blocked goroutine should yield its thread.',
    'A load balancer keeps the number of in-flight requests bounded by admitting work only when a slot is free, which prevents a slow backend from exhausting connection memory.',
    'The storage engine writes every mutation to an append-only log before updating the in-memory index, so a crash can be recovered by replaying the tail of the log.',
    'Caches are useful only when invalidation is correct, and the cheapest way to stay correct is to make every cached value immutable and versioned.',
    'A worker pool grows while tasks are queued and shrinks when the queue drains, but shrinking too eagerly wastes the warm state that made the pool fast in the first place.',
    'Timeouts are not error handling; they are a statement about how long the caller is willing to wait before it gives up and releases the resources it is holding.',
    'Observability without sampling is affordable only when the hot path is cheap, which is why most systems record counters eagerly and traces selectively.',
    'Backpressure is the difference between a system that degrades and a system that falls over: refusing work early is a feature, not a failure.',
    'The compiler inlines small functions to remove call overhead, then the profiler shows that the remaining cost is memory traffic rather than instructions.',
    'A lock protects a data structure, not an intention, so the same mutex held for a longer section quietly serialises work that looked parallel on paper.',
    'Retries amplify load exactly when the system is least able to absorb it, so retry policies need jitter, a budget, and a clear owner.',
    'Schema changes are safe when they are additive first: deploy code that tolerates both shapes, migrate the data, then remove the old path in a later release.',
  ]
  const rotated = [...paragraphs.slice(5), ...paragraphs.slice(0, 5)] // 换一段起点，避免每次都一模一样
  const text = rotated.join(' ').repeat(3).slice(0, 4000)
  await togglePin() // 取消钉住，让卡片能换位
  const started = Date.now()

  // **不 await**：一边流式生成一边采样窗口尺寸 —— 这才是"底部会不会被裁"的真实场景。
  // 回归的是这个 bug：卡片按新内容排了版，但 DIB 还是旧窗口尺寸，超出的部分被裁掉，
  // 而异步重排要等事件循环空下来（流式读取会一直占着），于是整个翻译过程底部都缺着。
  const pending = post(`${C}/simulate`, { x: 400, y: 300, text })
  for (let i = 0; i < 200; i++) {
    if ((await json(`${C}/status`)).card.status === 'running') break
    await sleep(20)
  }
  let worstGap = 0
  let samples = 0
  let followSamples = 0
  let followViolations = 0
  for (let i = 0; i < 2000; i++) {
    const st = await json(`${C}/status`)
    const rect = st.window.rect
    if (rect !== null && st.card.visible === true) {
      const need = Math.round((CARD.headerH + st.card.bodyHeight + CARD.padY * 2 + CARD.footerH + CARD.shadow * 2) * st.window.scale)
      worstGap = Math.max(worstGap, need - rect.h)
      samples += 1
    }
    // 流式跟随：内容一旦超过视口，视图就该钉在内容底部（新译文出现在最后 1–2 行）
    if (st.card.status === 'running' && st.card.contentHeight > st.card.bodyHeight) {
      followSamples += 1
      if (st.card.scroll < st.card.contentHeight - st.card.bodyHeight - 1) followViolations += 1
    }
    if (st.card.status === 'done' || st.card.status === 'error') break
    await sleep(25)
  }
  await pending
  s = await json(`${C}/status`)
  const translated = s.state.lastTranslate
  // /status 里 finish 已被规范化成字符串（'stop' / 'length' / 'max-tokens' …）
  const finishKind = typeof translated?.finish === 'string' ? translated.finish : (translated?.finish?.kind ?? null)
  check('流式期间窗口从没被裁（页脚/底部始终在窗口内）', worstGap <= 1, `最大差 ${worstGap}px，采样 ${samples} 帧`)
  check('流式期间跟随最新（视图钉在内容底部）', followSamples === 0 || followViolations === 0, followSamples === 0 ? '本次真流式是**突发式**返回的，没有可判定的中间帧（确定性验证见下面"流式跟随"一节）' : `采样 ${followSamples} 帧、没跟上 ${followViolations} 帧`)
  check('翻译完成后回到译文开头（停止跟随）', s.card.scroll === 0 && s.card.follow === false, `scroll=${s.card.scroll} follow=${s.card.follow}`)
  check('上限放行（4000 字能翻出来）', translated !== null, JSON.stringify(translated))
  check('译文没被输出上限截断（finish 不是 length / max-tokens）', finishKind !== 'length' && finishKind !== 'max-tokens', `finish=${JSON.stringify(translated?.finish)} answerChars=${translated?.answerChars}`)
  check('译文长度合理（>800 字）', (translated?.answerChars ?? 0) > 800, String(translated?.answerChars))
  check('内容高于视口（所以能滚）', s.card.contentHeight > s.card.bodyHeight, `${s.card.contentHeight} vs ${s.card.bodyHeight}`)
  const scrolled = await post(`${C}/scroll`, { delta: 600 })
  check('滚轮能滚下去', scrolled.scroll > 0, JSON.stringify(scrolled))
  const topped = await post(`${C}/scroll`, { delta: -99999 })
  check('能滚回顶部', topped.scroll === 0, JSON.stringify(topped))
  console.log(`  （这些内容卡片一次显示不下，靠滚轮看：耗时 ${Date.now() - started}ms）`)
  await json(`${C}/hide`)
}

/* 9. 小图标模式 + 设置持久化 ------------------------------------------------- */
console.log('\n小图标模式（第二个触发模式）')
await json(`${C}/hide`)
await sleep(150)
if (!settingsLive) {
  console.log('  ⚠ 宿主还没有 /settings 路由（改过 index.js 要重启桌面端）→ 这一段只验伴生进程侧')
} else {
  check('宿主能读设置', hostSettings.mode === 'auto' || hostSettings.mode === 'icon', JSON.stringify(hostSettings))
  check('设置文件路径在 $DSH_HOME 下', typeof hostSettings.file === 'string' && hostSettings.file.endsWith('dsh-select-translate.json'), hostSettings.file)
}

const switched = await switchMode('icon')
await sleep(80)
s = await json(`${C}/status`)
check('切到 icon 模式', s.card.mode === 'icon', JSON.stringify(switched))

// 鼠标此刻在别处（用户在看界面）：把图标亮在真实光标处
const cursor = (await json(`${C}/where`)).cursor
await post(`${C}/icon`, { x: cursor.x, y: cursor.y, text: 'The scheduler multiplexes goroutines onto OS threads.' })
await sleep(200)
s = await json(`${C}/status`)
const iconScale = s.window.scale
check('图标出现（同一个窗口换成图标形态）', s.card.iconVisible === true, JSON.stringify(s.card))
check('图标窗口 = 44 DIP × 缩放', s.window.rect?.w === Math.round(TRIGGER_WINDOW * iconScale), JSON.stringify(s.window.rect))
check(
  '图标落在锚点右下 12（阴影外扩 10）',
  s.window.rect?.x === cursor.x + Math.round(TRIGGER.gap * iconScale) - Math.round(TRIGGER.shadow * iconScale),
  JSON.stringify(s.window.rect),
)
check('鼠标就在图标上 → 不会自动收起', s.card.iconVisible === true)

// 0.1.5 起：鼠标离得再远也不收起 —— 图标要保留到下一次点击 / Esc / 新选区
const farX = cursor.x > 1300 ? cursor.x - 400 : cursor.x + 400
await post(`${C}/icon`, { x: farX, y: cursor.y, text: 'x' })
await sleep(400)
check('鼠标离得远 → 图标仍然显示（不再"移开即消失"）', (await json(`${C}/status`)).card.iconVisible === true)

// 点图标 = 取词已在手里 → 直接翻译并换成卡片形态
await post(`${C}/icon`, { x: cursor.x, y: cursor.y, text: 'The scheduler multiplexes goroutines onto OS threads.' })
const clicked = await post(`${C}/icon/click`)
s = await json(`${C}/status`)
check('点了图标 → 图标收起、卡片出现', clicked.clicked === true && s.card.visible === true && s.card.iconVisible === false, JSON.stringify({ clicked, card: { visible: s.card.visible, iconVisible: s.card.iconVisible } }))
check('点了图标 → 真译文出来了', s.card.status === 'done' && s.card.chars > 0, `status=${s.card.status} chars=${s.card.chars}`)
check('这一段没有新错误', s.state.errors.length === 0, JSON.stringify(s.state.errors))

// 切回**运行前**的模式（收尾还会再核对一次；不能把用户的 ⚡ 选择覆盖掉）
await switchMode(originalMode)
await sleep(80)
s = await json(`${C}/status`)
check(`切回运行前的模式「${originalMode}」`, s.card.mode === originalMode, JSON.stringify(s.card))

/* 10. 流式跟随（假流式，节奏确定；不花模型调用）------------------------------- */
// 真流式的节奏是模型决定的（有时一口气返回，没有可判定的中间帧），所以"跟随最新"这条
// 用**自带假流式**来钉：每 24ms 吐 fakeStep 个字，内容必然涨过视口，能稳定采样到中间态。
console.log('\n流式跟随（假流式：每 24ms 吐 8 字）')
await json(`${C}/hide`)
await sleep(120)
const fakeText = '调度器把 goroutine 复用到操作系统线程上，宿主这边只做排版与绘制。'.repeat(30).slice(0, 960)
const fake = await post(`${C}/simulate`, { x: 400, y: 300, fake: true, fakeStep: 8, fakeText })
check('假流式已开始', fake.mode === 'fake', JSON.stringify(fake))

let overflowFrames = 0
let followedFrames = 0
let stragglers = 0
for (let i = 0; i < 4000; i++) {
  const st = await json(`${C}/status`)
  if (st.card.status !== 'running') break
  if (st.card.contentHeight > st.card.bodyHeight) {
    overflowFrames += 1
    if (st.card.scroll >= st.card.contentHeight - st.card.bodyHeight - 1) followedFrames += 1
    else stragglers += 1
  }
  await sleep(8)
}
s = await json(`${C}/status`)
check('内容确实涨到超过视口（否则这条断言没意义）', overflowFrames > 20, `超过视口的采样 ${overflowFrames} 帧`)
check('流式期间一直跟随最新（scroll 贴在内容底，新译文在最后 1–2 行）', overflowFrames > 0 && stragglers === 0, `跟随 ${followedFrames} 帧 / 没跟上 ${stragglers} 帧`)
check('流式结束后回到译文开头并停止跟随', s.card.status === 'done' && s.card.scroll === 0 && s.card.follow === false, `status=${s.card.status} scroll=${s.card.scroll} follow=${s.card.follow}`)

// 手动往上滚 → 跟随暂停（否则流式期间没法回看已生成的部分）
await post(`${C}/simulate`, { x: 400, y: 300, fake: true, fakeStep: 8, fakeText })
// 必须等到「**当前这一流**正在跑 且 已涨过视口」：
// 只看 contentHeight > bodyHeight 会被**上一个假流式残留下来的高度**满足（踩过），
// 那时 /scroll 打在新流的清空状态上，maxScroll=0，断言就假失败。
let overflowed = null
for (let i = 0; i < 900; i++) {
  const st = await json(`${C}/status`)
  if (st.card.status === 'running' && st.card.contentHeight > st.card.bodyHeight) {
    overflowed = st
    break
  }
  await sleep(15)
}
check(
  '（前置）当前这一流正在跑且涨过了视口',
  overflowed !== null,
  overflowed === null ? '等不到"running 且溢出"' : `status=${overflowed.card.status} chars=${overflowed.card.chars} contentH=${overflowed.card.contentHeight} bodyH=${overflowed.card.bodyHeight}`,
)
const up = await post(`${C}/scroll`, { delta: -200 })
await sleep(120)
s = await json(`${C}/status`)
check(
  '手动往上滚 → 跟随暂停（不被每帧拽回底部）',
  up.maxScroll > 0 && up.follow === false && s.card.follow === false && s.card.scroll < s.card.contentHeight - s.card.bodyHeight,
  `up=${JSON.stringify(up)} scroll=${s.card.scroll} follow=${s.card.follow}`,
)
const back = await post(`${C}/scroll`, { delta: 99999 })
check('再滚回底部 → 跟随恢复', back.follow === true && back.scroll === back.maxScroll, JSON.stringify(back))
await json(`${C}/hide`)
} // quiet：8–10 节需要静默窗口

/* 11. 收尾 ------------------------------------------------------------------- */
await json(`${C}/hide`)
s = await json(`${C}/status`)
console.log('\n收尾')
check('卡片已隐藏', s.card.visible === false)
// 还原用户原本的 ⚡ 模式：本节为了测图标模式会切换它，不能把别人的选择覆盖掉
if (s.card.mode !== originalMode) {
  await switchMode(originalMode)
  await sleep(80)
  s = await json(`${C}/status`)
}
check(`⚡ 模式已还原为运行前的「${originalMode}」`, s.card.mode === originalMode, `现在是 ${s.card.mode}`)
check('这一轮没有错误堆积', s.state.errors.length === 0, JSON.stringify(s.state.errors))

console.log(failures.length === 0 ? '\n全部通过 ✓' : `\n失败 ${failures.length} 项：${failures.join(' / ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
