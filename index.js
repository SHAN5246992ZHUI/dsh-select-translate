/**
 * dsh-select-translate —— 宿主半边。
 *
 * 三件事：
 *  1. 在 `webServer` 上挂 `/dsh-select-translate/api/*`（**刻意不在 `/api` 下**——那个前缀被
 *     `@deepseek-ai/dsh-client-connection` 的鉴权栅栏占着，裸请求一律 401）。
 *  2. `POST /translate` 用 **`ctx.llm.stream`** 直接打模型（**不经过 agent**）：
 *     一次裸模型调用、token 级流式，没有工具、没有会话、不落盘。
 *  3. 拉起 / 看护伴生进程（全局取词那一半）。
 *
 * 翻译提示词刻意拆成"逐字节稳定的 system + 只在末尾变化的 user"，
 * 这样固定前缀能被上下文缓存命中。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createSettingsStore } from './settings.mjs'

export const name = 'dsh-select-translate'

/** 硬依赖：路由宿主 + 模型通道 + 子进程。 */
export const inject = ['webServer', 'llm', 'subprocess']

const API_PREFIX = '/dsh-select-translate/api'

/**
 * 路由令牌。
 *
 * 这些路由挂在 `/api` 鉴权栅栏**之外**（§6 第 2 条），所以本机任何进程都能打。
 * 其中最要命的是 `/translate`（能花掉你的额度）与 `/system/restart`。
 *
 * 令牌每次启动随机生成、只在内存里 + 经 env 传给伴生进程；校验要求请求带
 * `x-dsh-select-translate-token` 头。**为什么是自定义头**：跨源网页要带自定义头就必须先过 CORS 预检，
 * 而我们从不回 CORS 头 → 浏览器根本不发这个请求。这是挡住"网页偷打本机端口"的关键，
 * 比把令牌塞进 query/body 强得多（后者用 `text/plain` 就能免预检发出）。
 *
 * 说清楚边界：**能扫本机端口、能读文件的本地进程仍然拿得到**（伴生进程会把令牌写进
 * 运行时文件给排障工具用）。这道锁防的是网页与顺手一发的脚本，不是同用户的恶意程序。
 */
const API_TOKEN = process.env.DSH_ST_TOKEN || randomBytes(32).toString('hex')

/** 当前令牌（伴生进程经 env 拿；排障工具从运行时文件读）。导出是为了单测。 */
export function getApiToken() {
  return API_TOKEN
}

/** 请求头里是否带了正确的令牌（常量时间比较，避免时序侧信道）。 */
export function isAuthorizedToken(headers) {
  const given = headers?.['x-dsh-select-translate-token']
  if (typeof given !== 'string' || given === '') return false
  const a = Buffer.from(given)
  const b = Buffer.from(API_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}
/** 原文上限。**与 `companion/main.mjs` 的 MAX_TEXT 必须一致**（两边各自拦一道）。 */
const MAX_TEXT = 15000

/**
 * 本插件是否支持当前平台。
 *
 * 原生取词与卡片是 Windows 专属：UIA（COM）、GDI+、`user32`/`kernel32` 全靠 koffi 直调。
 * 其它平台如果照常加载，会 spawn 出一个必然崩溃的伴生进程 → 退出 → 退避重启，无尽循环、
 * 日志刷屏，而插件表现为"完全没用"。
 * 市场注册表**没有 OS 字段**（只能用描述写清"仅 Windows"），所以这一道守卫必须写在代码里。
 * 抽成函数是为了能单测（`apply` 里那条分支没法在非 Windows 机器上真跑）。
 */
export function isSupportedPlatform(platform = process.platform) {
  return platform === 'win32'
}

/**
 * 固定提示词：它是缓存前缀（方案 §4：固定前缀命中上下文缓存），**改一次就让缓存失效一次**。
 * 所以只在"提示词确实没覆盖某类输入"时才动，并同步更新 `test/host.test.mjs` 里钉死的那份。
 * 导出是为了让单测把它钉住。
 */
export const SYSTEM_PROMPT = [
  '你是一个翻译引擎。把用户给出的文本翻译成用户指定的语言。',
  '规则：',
  '1. 只输出译文。不要前言、不要解释、不要括号注释、不要语言标注、不要复述原文。',
  '2. 保留原文里的代码、变量名、文件路径、URL、命令与专有名词，不要翻译它们。',
  '3. 保持原文的结构：原文怎么分段，译文就怎么分段；段落之间保留一个空行。',
  '4. 原文若含编号或分条（1. / 2) / ① / - / •），译文按条分行输出，编号原样保留，不要合并成一段。',
  '5. 用该领域通行的译法；拿不准时保留原文。',
].join('\n')

/** 汉字（CJK 统一表意文字）。`auto` 判语种时**数个数**，不再"见到一个就当中文"。 */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
/** 拉丁词（英文等拉丁字母语言按"词"计量）。 */
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*/g

const COMPANION_ENTRY = fileURLToPath(new URL('./companion/main.mjs', import.meta.url))
const COMPANION_CWD = fileURLToPath(new URL('.', import.meta.url))
const PORT_PATTERN = /listening on http:\/\/127\.0\.0\.1:(\d+)/

/* ────────────────────────── 小工具 ────────────────────────── */

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

/** SSE 写口；响应已结束就静默丢弃。 */
function makeSink(res) {
  return {
    send(payload) {
      if (res.writableEnded === true) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    },
  }
}

/* ────────────────────────── 伴生进程 ────────────────────────── */

function koffiHint() {
  const argv1 = process.argv[1]
  return typeof argv1 === 'string' && argv1.endsWith('.js') ? argv1 : ''
}

/**
 * 伴生进程生命周期。
 *
 * 三处细节来自参考实现踩过的坑，一个都不能省：
 *  - `done` 回调要**认身份**（迟到的退出会抹掉新进程的状态）；
 *  - `restart` 里必须**复位 stopping**，否则看门狗永久失效；
 *  - 停不掉就 `taskkill /T /F` 补刀，避免两个伴生进程各自开一个浮层。
 */
function createCompanion(ctx, options = {}) {
  const maxRestarts = 5
  /** 每次 spawn 时把当前设置经 env 给伴生进程（拿不到就按默认）。 */
  const readSettings = options.settings ?? (() => ({ mode: 'auto' }))
  let child = null
  let restartTimer = null
  let stopping = false
  let status = { state: 'stopped', restarts: 0 }

  function origin() {
    const port = ctx.webServer?.port
    return typeof port === 'number' && port > 0 ? `http://127.0.0.1:${port}` : ''
  }

  function forceKill(pid) {
    if (typeof pid !== 'number' || pid <= 0 || process.platform !== 'win32') return
    try {
      const killer = ctx.subprocess.spawn({
        argv: ['taskkill', '/pid', String(pid), '/T', '/F'],
        cwd: COMPANION_CWD,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 500,
      })
      void killer.done.catch(() => {})
    } catch {
      /* 补刀失败只能算了 */
    }
  }

  function start() {
    if (stopping || child !== null) return
    status = { ...status, state: 'starting', startedAt: Date.now(), lastError: undefined }
    let spawned
    try {
      spawned = ctx.subprocess.spawn({
        // process.execPath 在桌面端是 Electron 二进制；靠 ELECTRON_RUN_AS_NODE 让它当 Node 跑，
        // 这样既不猜 node 路径，也不会再拉起一个 GUI 实例。
        argv: [process.execPath, COMPANION_ENTRY],
        cwd: COMPANION_CWD,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 800,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_ST_KOFFI_HINT: koffiHint(),
          DSH_ST_ORIGIN: origin(),
          // 路由令牌：伴生进程要拿它去打 /translate 与 /settings（见 API_TOKEN 注释）
          DSH_ST_TOKEN: API_TOKEN,
          // 初始触发模式：伴生进程启动时就读到，免得"刚启动那一下"用的是默认模式
          DSH_ST_MODE: String(readSettings().mode ?? 'auto'),
        },
      })
    } catch (error) {
      status = { ...status, state: 'failed', lastError: error instanceof Error ? error.message : String(error) }
      return
    }
    child = spawned

    spawned.stdout?.on('data', (chunk) => {
      const match = PORT_PATTERN.exec(chunk.toString('utf8'))
      if (match === null) return
      status = { ...status, state: 'running', port: Number(match[1]) }
      ctx.logger?.info?.(`dsh-select-translate: companion ready on ${match[1]}`)
    })
    spawned.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') status = { ...status, lastError: text.slice(-400) }
    })

    void spawned.done.then((outcome) => {
      if (child !== spawned) return // 认身份：老进程迟到的退出不许动新进程的状态
      child = null
      if (stopping) {
        status = { ...status, state: 'stopped', port: undefined }
        return
      }
      status = {
        ...status,
        state: 'failed',
        port: undefined,
        lastError: `companion exited (code=${outcome?.exitCode ?? 'null'})`,
      }
      ctx.logger?.warn?.(`dsh-select-translate: companion exited code=${outcome?.exitCode ?? 'null'}`)
      if (status.restarts < maxRestarts) {
        status.restarts += 1
        restartTimer = setTimeout(() => {
          restartTimer = null
          if (!stopping) start()
        }, Math.min(30000, 1000 * 2 ** status.restarts))
      }
    })
  }

  function stop() {
    stopping = true
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const doomed = child
    child = null
    status = { ...status, state: 'stopped', port: undefined }
    if (doomed === null) return null
    try {
      doomed.terminate()
    } catch {
      /* 已经死了 */
    }
    return doomed
  }

  async function restart() {
    const doomed = stop()
    if (doomed !== null) {
      try {
        await doomed.waitForExit()
      } catch {
        /* 等不到就直接往下走，反正 start 会另起一个 */
      }
    }
    stopping = false // 不复位的话看门狗永久失效
    start()
    return status
  }

  /**
   * 把设置推给**正在跑**的伴生进程（用户切了 ⚡ 或改了配置时）。
   * 进程不在就当没发生：下次 spawn 会用 env 给到最新值。
   */
  async function pushSettings(patch) {
    const port = status.port
    if (status.state !== 'running' || typeof port !== 'number' || port <= 0) return false
    // 重试一次：本机短连接偶发 ECONNRESET（连接池坏连接），不该让"改模式"静默失效
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (response.ok === true) return true
      } catch {
        /* 换一次连接再试 */
      }
    }
    return false
  }

  return {
    start,
    stop,
    restart,
    pushSettings,
    status: () => ({ ...status }),
    install() {
      ctx.effect(
        () => {
          start()
          return () => {
            stop()
          }
        },
        'dsh-select-translate: companion',
      )
    },
  }
}

/* ────────────────────────── 模型通道 ────────────────────────── */

function routeOf(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
    }
  } catch {
    /* 服务缺席就走部署默认 */
  }
  return undefined
}

/**
 * 挑"最不思考"的一档。
 *
 * 我们想要"关掉深度思考"；DSH 里这个旋钮叫 `reasoningEffort`，
 * 有没有真正的"关"取决于模型能力——所以按名字优先找 off/none/minimal/low，
 * 找不到就取适配器给的第一项（列表按适配器偏好排序）。
 */
export async function pickEffort(ctx, provider, model) {
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    const efforts = info?.reasoning?.efforts ?? []
    if (efforts.length === 0) return undefined
    for (const wanted of ['off', 'none', 'disabled', 'minimal', 'low']) {
      const hit = efforts.find((effort) => String(effort?.id ?? '').toLowerCase() === wanted)
      if (hit !== undefined) return hit.id
    }
    return efforts[0]?.id
  } catch {
    return undefined
  }
}

/**
 * `auto` 时判断该译成哪种语言：**按"谁占主导"判，不是"有没有汉字"**。
 *
 * 旧实现是 `CJK.test(text)` —— 只要原文里出现**一个**汉字就判成"中文"，于是译成英文；
 * 结果"开头一句中文 + 后面一大段英文"的选区整段被当成中文，输出还是英文（实测踩过）。
 * 现在按信息量比：**约 2 个汉字 ≈ 1 个英文词**；汉字占主导才译成英文，否则译成中文。
 * 没有汉字 → 中文；没有拉丁词（纯中文/纯符号）→ 英文。
 */
export function detectTargetLanguage(text) {
  const source = String(text ?? '')
  const cjk = (source.match(CJK_CHAR) ?? []).length
  const words = (source.match(LATIN_WORD) ?? []).length
  if (cjk === 0) return 'zh'
  if (words === 0) return 'en'
  return cjk >= words * 2 ? 'en' : 'zh'
}

/**
 * 目标语言标签（写进提示词的"目标语言：…"）。
 *  - `auto`：按主导语言判定（见 `detectTargetLanguage`）；
 *  - `zh` / `en`：预设；
 *  - **其它字符串 = 用户自定义语种**（如 `日本語`），原样交给模型。
 */
export function targetLabel(target, text) {
  if (target === 'zh') return '中文（简体）'
  if (target === 'en') return 'English'
  if (target === 'auto') return detectTargetLanguage(text) === 'en' ? 'English' : '中文（简体）'
  return String(target)
}

/**
 * 目标语言参数：预设白名单 + **自定义语种**（自由字符串）。
 * 自由字符串要截断：它会原样进提示词，不能让任意长内容挤进来。
 */
export function normalizeTarget(value) {
  if (typeof value !== 'string') return 'auto'
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'auto') return 'auto'
  if (trimmed === 'zh' || trimmed === 'en') return trimmed
  return trimmed.slice(0, 24)
}

/**
 * 输出上限按原文长度动态估算。
 *
 * 固定值一定会出问题：**上限被截断时 `finish` 会是 `max-tokens`**（实测 3000 字输入配 1800 上限
 * 就截断了，输出到 3723 字还没收尾）。所以按长度放大，并把天花板抬到 8192（15000 字输入
 * 译成中文约 7500 字 ≈ 4000–5000 token，4096 不够）。
 * 下限仍保留 1024（短句不浪费额度）。
 */
export function maxTokensFor(text) {
  return Math.min(8192, Math.max(1024, Math.ceil(String(text).length * 0.8)))
}

/* ────────────────────────── 路由 ────────────────────────── */

/**
 * 从模型信息里挑出"跟容量有关"的字段（排障用）。
 * 目的：`maxTokensFor` 的天花板现在是 8192，但**模型的真实输出上限是多少**只能问适配器，
 * 不该靠猜。这里不做任何解析，只把相关键暴露出来（未知结构就只给 keys）。
 */
export function modelLimits(info) {
  if (info === null || typeof info !== 'object') return null
  const out = { keys: Object.keys(info).slice(0, 40) }
  for (const key of ['maxOutputTokens', 'maxOutput', 'maxTokens', 'contextWindow', 'contextLength', 'context', 'maxInputTokens']) {
    if (info[key] !== undefined) out[key] = info[key]
  }
  for (const key of ['limits', 'capabilities', 'output']) {
    const value = info[key]
    if (value !== null && typeof value === 'object') out[key] = value
  }
  return out
}

async function handleStatus(ctx, res, companion, settings) {
  const route = routeOf(ctx)
  const model = route === undefined ? null : { provider: route.provider, model: route.model, reasoningEffort: await pickEffort(ctx, route.provider, route.model) }
  let limits = null
  if (route !== undefined) {
    try {
      limits = modelLimits(await ctx.llm.resolveModelInfo(route.provider, route.model))
    } catch {
      /* 拿不到就算了，别让排障端点也挂掉 */
    }
  }
  json(res, 200, {
    ok: true,
    plugin: name,
    companion: companion.status(),
    model: model === null ? null : { ...model, limits },
    settings: settings === undefined ? null : { ...settings.get(), file: settings.file },
  })
}

/** 翻译路由（导出以便单测 SSE 帧契约：伴生进程就是照这些帧解析的）。 */
export async function handleTranslate(ctx, req, res) {
  let args
  try {
    const parsed = JSON.parse((await readBody(req)) || '{}')
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    if (text.trim() === '') throw new Error('text is empty')
    if (text.length > MAX_TEXT) throw new Error(`text is longer than ${MAX_TEXT} characters`)
    args = {
      text,
      target: normalizeTarget(parsed.target),
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : '',
    }
  } catch (error) {
    return json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }

  const route = routeOf(ctx)
  if (route === undefined) {
    return json(res, 503, { ok: false, message: '没有可用的默认模型，请先在 DSH 设置里配置模型' })
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const sink = makeSink(res)

  // 客户端断开（Esc / 新一次划词）→ abort，模型调用随之取消
  const abort = new AbortController()
  res.on('close', () => abort.abort())

  const effort = await pickEffort(ctx, route.provider, route.model)
  const startedAt = Date.now()
  let firstDeltaAt = 0
  let answer = ''
  let usage = null
  let finish = null

  sink.send({
    type: 'start',
    requestId: args.requestId,
    provider: route.provider,
    model: route.model,
    reasoningEffort: effort ?? null,
    // 卡片头部要显示"自动"到底判成了哪种语言（见 companion/card.mjs 的 targetText）。
    resolved: args.target === 'auto' ? detectTargetLanguage(args.text) : args.target,
  })

  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `目标语言：${targetLabel(args.target, args.text)}\n\n${args.text}` }],
        },
      ],
      temperature: 0.3,
      maxTokens: maxTokensFor(args.text),
      signal: abort.signal,
    })

    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        if (firstDeltaAt === 0) firstDeltaAt = Date.now()
        answer += chunk.text
        // delta 也必须带 requestId：两端客户端都只在"帧里带了 requestId"时才做比较，
        // 不带的话"迟到的旧译文不许盖到新卡片上"这条保护对 delta 等于没有。
        sink.send({ type: 'delta', text: chunk.text, requestId: args.requestId })
      } else if (chunk?.type === 'usage') {
        usage = chunk.usage ?? null
      } else if (chunk?.type === 'finish') {
        finish = chunk.reason ?? null
      }
    }

    sink.send({
      type: 'done',
      requestId: args.requestId,
      text: answer,
      usage,
      finish,
      timing: { totalMs: Date.now() - startedAt, firstTokenMs: firstDeltaAt === 0 ? null : firstDeltaAt - startedAt },
    })
  } catch (error) {
    // 只记 message，不把 error 对象整个交给宿主日志：适配器可能把请求体塞进 error，
    // 那样原文就会进 DSH 日志，与 README 的「不落盘」承诺自相矛盾。
    ctx.logger?.warn?.('dsh-select-translate: translate failed', error instanceof Error ? error.message : String(error))
    sink.send({ type: 'error', requestId: args.requestId, message: error instanceof Error ? error.message : String(error) })
  } finally {
    res.end()
  }
}

export function apply(ctx) {
  // 平台守卫（见 isSupportedPlatform）：非 Windows 直接静默降级——不 spawn、不注册路由。
  // 不这么做的话，macOS/Linux 上会陷入"伴生进程崩溃 → 退避重启"循环。
  if (!isSupportedPlatform()) {
    ctx.logger?.warn?.('dsh-select-translate: 本插件只在 Windows 上工作（UIA 取词 + GDI+ 原生卡片），已跳过加载')
    return
  }
  const settings = createSettingsStore()
  const companion = createCompanion(ctx, { settings: () => settings.get() })
  companion.install()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          void (async () => {
            const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
            const method = String(req.method ?? 'GET').toUpperCase()
            try {
              // 路由令牌（见 API_TOKEN 注释）：`/ping` 放行（无害的存活探测），其余一律要带
              // `x-dsh-select-translate-token`。**用自定义头而不是 query/body** 是为了让跨源网页根本发不出请求 ——
              // 带自定义头的跨源请求会触发 CORS 预检，而我们从不回 CORS 头，浏览器直接拦下。
              if (url.pathname !== `${API_PREFIX}/ping` && !isAuthorizedToken(req.headers)) {
                return json(res, 401, { ok: false, message: 'unauthorized: missing or wrong x-dsh-select-translate-token' })
              }
              if (url.pathname === `${API_PREFIX}/ping`) return json(res, 200, { ok: true, plugin: name })
              if (url.pathname === `${API_PREFIX}/system/status` && method === 'GET') {
                return void (await handleStatus(ctx, res, companion, settings))
              }
              if (url.pathname === `${API_PREFIX}/system/restart` && method === 'POST') {
                return json(res, 200, { ok: true, companion: await companion.restart() })
              }
              // 设置：读 / 改。改完推给正在跑的伴生进程（进程不在就等下次 spawn 的 env）
              if (url.pathname === `${API_PREFIX}/settings` && method === 'GET') {
                return json(res, 200, { ok: true, ...settings.get(), file: settings.file })
              }
              if (url.pathname === `${API_PREFIX}/settings` && method === 'POST') {
                let parsed
                try {
                  parsed = JSON.parse((await readBody(req)) || '{}')
                } catch {
                  return json(res, 400, { ok: false, message: 'invalid JSON' })
                }
                const next = settings.patch(parsed)
                const pushed = await companion.pushSettings(next)
                return json(res, 200, { ok: true, ...next, pushed })
              }
              if (url.pathname === `${API_PREFIX}/translate`) {
                if (method !== 'POST') return json(res, 405, { ok: false, message: 'use POST' })
                return void (await handleTranslate(ctx, req, res))
              }
              return json(res, 404, { ok: false, message: 'not found' })
            } catch (error) {
              ctx.logger?.warn?.('dsh-select-translate: route failure', error)
              if (res.headersSent !== true) json(res, 500, { ok: false, message: 'internal error' })
              else if (res.writableEnded !== true) res.end()
            }
          })()
        },
      }),
    'dsh-select-translate: routes',
  )

  ctx.logger?.info?.('dsh-select-translate: activated')
}
