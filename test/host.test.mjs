/**
 * `index.js` —— 宿主半边。
 *
 * 这一半是**两半之间的契约**：伴生进程按 SSE 帧解析译文，卡片按 `targetLabel` 显示目标语言。
 * 它同时也是「固定前缀命中缓存」的实现处，所以提示词必须被钉死。
 *
 * 用假 req/res/ctx 驱动真 `handleTranslate`，不需要起 DSH。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectTargetLanguage, handleTranslate, maxTokensFor, modelLimits, normalizeTarget, pickEffort, SYSTEM_PROMPT, targetLabel } from '../index.js'

/* ────────────────────────── 假 req / res / ctx ────────────────────────── */

function fakeReq(body) {
  const text = JSON.stringify(body)
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
}

function fakeRes() {
  const frames = []
  const listeners = new Map()
  return {
    statusCode: 0,
    headers: null,
    headersSent: false,
    writableEnded: false,
    body: null,
    frames,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk) {
      frames.push(String(chunk))
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk)
      this.writableEnded = true
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return this
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    /** 解析出 SSE 里的 JSON 帧。 */
    events() {
      return frames.map((frame) => {
        const line = frame.split('\n').find((entry) => entry.startsWith('data:'))
        return JSON.parse(line.slice(5).trim())
      })
    },
  }
}

const SELECTION = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }

function fakeCtx(options = {}) {
  const captured = {}
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'agentDefaultModel' && options.withModel !== false ? { currentSelection: () => ({ ...SELECTION }) } : undefined),
    llm: {
      resolveModelInfo: async () => options.modelInfo ?? { reasoning: { efforts: [{ id: 'minimal' }, { id: 'off' }] } },
      stream: (args) => {
        captured.args = args
        return (async function* () {
          if (options.gate !== undefined) await options.gate
          for (const chunk of options.chunks ?? [{ type: 'text-delta', text: '调度器' }, { type: 'text-delta', text: '复用线程。' }]) {
            if (options.onChunk !== undefined) options.onChunk(chunk)
            yield chunk
          }
          if (options.throwAfter !== undefined) throw new Error(options.throwAfter)
        })()
      },
    },
  }
  return { ctx, captured }
}

const call = (ctx, body) => {
  const req = fakeReq(body)
  const res = fakeRes()
  const promise = handleTranslate(ctx, req, res)
  return { req, res, promise }
}

/* ────────────────────────── pickEffort ────────────────────────── */

test('pickEffort：优先挑"最不思考"的一档（deepseek-flash 有 off 就取 off）', async () => {
  const build = (efforts) => ({ get: () => undefined, llm: { resolveModelInfo: async () => ({ reasoning: { efforts } }) } })
  assert.equal(await pickEffort(build([{ id: 'minimal' }, { id: 'off' }]), 'p', 'm'), 'off')
  assert.equal(await pickEffort(build([{ id: 'LOW' }, { id: 'high' }]), 'p', 'm'), 'LOW')
  assert.equal(await pickEffort(build([{ id: 'high' }]), 'p', 'm'), 'high')
  assert.equal(await pickEffort(build([]), 'p', 'm'), undefined)
})

test('pickEffort：拿不到模型信息就返回 undefined（不传该参数，交给适配器默认）', async () => {
  const missing = { get: () => undefined, llm: { resolveModelInfo: async () => ({}) } }
  assert.equal(await pickEffort(missing, 'p', 'm'), undefined)

  const broken = {
    get: () => undefined,
    llm: {
      resolveModelInfo: async () => {
        throw new Error('no such model')
      },
    },
  }
  assert.equal(await pickEffort(broken, 'p', 'm'), undefined)
})

/* ────────────────────────── targetLabel ────────────────────────── */

test('targetLabel：显式目标语言优先；auto 时按原文有没有 CJK 反向判定', () => {
  assert.equal(targetLabel('zh', 'hello'), '中文（简体）')
  assert.equal(targetLabel('en', '你好'), 'English')
  assert.equal(targetLabel('auto', '你好世界'), 'English')
  assert.equal(targetLabel('auto', 'hello world'), '中文（简体）')
  assert.equal(targetLabel('auto', 'mixed 混合'), 'English')
})

/* ────────────────────────── SYSTEM_PROMPT ────────────────────────── */

test('SYSTEM_PROMPT 是缓存前缀：内容被钉死（改标点就要同步改这条测试并接受缓存失效）', () => {
  assert.equal(
    SYSTEM_PROMPT,
    [
      '你是一个翻译引擎。把用户给出的文本翻译成用户指定的语言。',
      '规则：',
      '1. 只输出译文。不要前言、不要解释、不要括号注释、不要语言标注、不要复述原文。',
      '2. 保留原文里的代码、变量名、文件路径、URL、命令与专有名词，不要翻译它们。',
      '3. 保持原文的结构：原文怎么分段，译文就怎么分段；段落之间保留一个空行。',
      '4. 原文若含编号或分条（1. / 2) / ① / - / •），译文按条分行输出，编号原样保留，不要合并成一段。',
      '5. 用该领域通行的译法；拿不准时保留原文。',
    ].join('\n'),
  )
})

/* ────────────────────────── auto 目标语言 ────────────────────────── */

test('auto 目标语言按"谁占主导"判，不是"见到一个汉字就当中文"', () => {
  // 没有汉字 → 译成中文
  assert.equal(detectTargetLanguage('Hello world'), 'zh')
  assert.equal(detectTargetLanguage('12345 !!!'), 'zh')
  // 纯中文 → 译成英文
  assert.equal(detectTargetLanguage('这是中文'), 'en')
  // ★ 踩过的 bug：开头一句中文 + 后面一大段英文，旧实现（CJK.test）会判成中文 → 输出英文
  assert.equal(
    detectTargetLanguage('题目：For the two-ray model, find the delay spread between the two signals.'),
    'zh',
  )
  // 中文正文里夹几个英文术语，仍算中文主导
  assert.equal(detectTargetLanguage('使用 ctx.llm.stream 调用模型'), 'en')

  // 显式指定不受影响
  assert.equal(targetLabel('zh', 'Hello'), '中文（简体）')
  assert.equal(targetLabel('en', '这是中文'), 'English')
  assert.equal(targetLabel('auto', 'Hello world'), '中文（简体）')
  assert.equal(targetLabel('auto', '这是中文'), 'English')
})

/* ────────────────────────── handleTranslate ────────────────────────── */

test('handleTranslate：空文本 / 超长文本直接 400，不碰模型', async () => {
  const empty = call(fakeCtx().ctx, { text: '   ' })
  await empty.promise
  assert.equal(empty.res.statusCode, 400)
  assert.match(empty.res.body, /text is empty/)

  const long = call(fakeCtx().ctx, { text: '中'.repeat(15001) })
  await long.promise
  assert.equal(long.res.statusCode, 400)
  assert.match(long.res.body, /longer than 15000/)

  // 上限从 2000 → 5000 → 15000：5001 字现在必须放行
  const ok = call(fakeCtx({ chunks: [] }).ctx, { text: 'a'.repeat(5001) })
  await ok.promise
  assert.equal(ok.res.statusCode, 200)
})

test('maxTokensFor：短句维持 1024，长文本按长度放大但压在 8192 以内', () => {
  assert.equal(maxTokensFor(''), 1024)
  assert.equal(maxTokensFor('a'.repeat(100)), 1024)
  assert.equal(maxTokensFor('a'.repeat(2000)), 1600)
  assert.equal(maxTokensFor('a'.repeat(5000)), 4000)
  assert.equal(maxTokensFor('a'.repeat(15000)), 8192)
  assert.equal(maxTokensFor('a'.repeat(20000)), 8192)
})

test('handleTranslate：15000 字长文本会拿到放大后的 maxTokens（否则译文被截断）', async () => {
  const { ctx, captured } = fakeCtx({ chunks: [] })
  const { res, promise } = call(ctx, { text: 'a'.repeat(15000) })
  await promise

  assert.equal(res.statusCode, 200)
  assert.equal(captured.args.maxTokens, 8192)
})

test('modelLimits：只挑容量相关字段，未知结构就给 keys（不解析、不猜）', () => {
  assert.equal(modelLimits(null), null)
  assert.equal(modelLimits('deepseek-flash'), null)
  assert.deepEqual(modelLimits({ provider: 'p', maxOutputTokens: 8192, contextWindow: 65536, vendor: 'deepseek' }), {
    keys: ['provider', 'maxOutputTokens', 'contextWindow', 'vendor'],
    maxOutputTokens: 8192,
    contextWindow: 65536,
  })
  // 嵌套的 limits / capabilities 原样带出来
  const nested = modelLimits({ limits: { output: 4096 }, reasoning: { efforts: [] } })
  assert.deepEqual(nested, { keys: ['limits', 'reasoning'], limits: { output: 4096 } })
})

test('handleTranslate：没有可用默认模型时 503（提示去哪配）', async () => {
  const { res, promise } = call(fakeCtx({ withModel: false }).ctx, { text: 'hello' })
  await promise
  assert.equal(res.statusCode, 503)
  assert.match(res.body, /默认模型/)
})

test('handleTranslate：SSE 帧序列 start → delta… → done，正文是逐字拼接的结果', async () => {
  const { ctx, captured } = fakeCtx({
    chunks: [
      { type: 'text-delta', text: '调度器' },
      { type: 'text-delta', text: '把 goroutine ' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } },
      { type: 'finish', reason: 'stop' },
      { type: 'text-delta', text: '复用线程。' },
    ],
  })
  const { res, promise } = call(ctx, { text: 'The scheduler multiplexes goroutines.', target: 'zh', requestId: '7' })
  await promise

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  const events = res.events()
  assert.equal(events[0].type, 'start')
  assert.equal(events[0].requestId, '7')
  assert.equal(events[0].provider, SELECTION.provider)
  assert.equal(events[0].model, SELECTION.model)
  assert.equal(events[0].reasoningEffort, 'off')

  assert.deepEqual(
    events.filter((event) => event.type === 'delta').map((event) => event.text),
    ['调度器', '把 goroutine ', '复用线程。'],
  )
  // delta 也必须带 requestId：不带的话客户端"迟到的旧译文不许盖上来"那条保护对 delta 失效
  for (const event of events.filter((entry) => entry.type === 'delta')) assert.equal(event.requestId, '7')

  const done = events.at(-1)
  assert.equal(done.type, 'done')
  assert.equal(done.text, '调度器把 goroutine 复用线程。')
  assert.equal(done.requestId, '7')
  assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 8 })
  assert.equal(done.finish, 'stop')
  assert.equal(typeof done.timing.totalMs, 'number')
  assert.equal(typeof done.timing.firstTokenMs, 'number')
  assert.equal(captured.args.temperature, 0.3)
  assert.equal(captured.args.maxTokens, 1024)
})

test('handleTranslate：system 前缀逐字节透传，原文只出现在 user 里（缓存前缀不能变）', async () => {
  const { ctx, captured } = fakeCtx({ chunks: [] })
  const { promise } = call(ctx, { text: 'Hello there', target: 'en' })

  await promise
  assert.equal(captured.args.system, SYSTEM_PROMPT)
  assert.equal(captured.args.messages.length, 1)
  assert.equal(captured.args.messages[0].role, 'user')
  assert.equal(captured.args.messages[0].content[0].type, 'text')
  assert.equal(captured.args.messages[0].content[0].text, '目标语言：English\n\nHello there')
  assert.equal(captured.args.reasoningEffort, 'off')
})

test('handleTranslate：模型抛错时发 error 帧并收尾（不留半截连接）', async () => {
  const { ctx } = fakeCtx({ chunks: [{ type: 'text-delta', text: '半句' }], throwAfter: '模型挂了' })
  const { res, promise } = call(ctx, { text: 'hello' })
  await promise

  const events = res.events()
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).message, '模型挂了')
  assert.equal(res.writableEnded, true)
})

test('handleTranslate：客户端断开（Esc / 新一次划词）→ abort 掉模型调用', async () => {
  // 用一个闸门把模型流卡住：这样"断开"发生在请求还在途中的真实时刻
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { ctx, captured } = fakeCtx({ chunks: [], gate })
  const { res, promise } = call(ctx, { text: 'hello' })

  for (let i = 0; i < 50 && captured.args === undefined; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.notEqual(captured.args, undefined, '请求没有走到 ctx.llm.stream')
  assert.equal(captured.args.signal.aborted, false)

  res.emit('close')
  assert.equal(captured.args.signal.aborted, true)
  release()
  await promise
  assert.equal(res.writableEnded, true)
})

test('handleTranslate：没给 target → auto；预设照旧；其它字符串当自定义语种原样进提示词', async () => {
  // 没给 / 非字符串 → auto（按主导语言判定：纯中文 → English）
  for (const target of [undefined, 42]) {
    const { ctx, captured } = fakeCtx({ chunks: [] })
    const { promise } = call(ctx, { text: '你好', target })
    await promise
    assert.equal(captured.args.messages[0].content[0].text, '目标语言：English\n\n你好')
  }
  // 自定义语种（下拉里的"自定义…"填进来的）→ 原样交给模型
  {
    const { ctx, captured } = fakeCtx({ chunks: [] })
    const { promise } = call(ctx, { text: '你好', target: '日本語' })
    await promise
    assert.equal(captured.args.messages[0].content[0].text, '目标语言：日本語\n\n你好')
  }
  // 超长自定义语种被截断到 24 字（它会原样进提示词，不能让任意长内容挤进来）
  {
    const { ctx, captured } = fakeCtx({ chunks: [] })
    const { promise } = call(ctx, { text: '你好', target: 'x'.repeat(50) })
    await promise
    assert.equal(captured.args.messages[0].content[0].text, '目标语言：' + 'x'.repeat(24) + '\n\n你好')
  }
})

test('start 帧带 resolved：auto 回传判定结果，自定义语种回传原值（卡片头部靠它显示"自动·中文"）', async () => {
  {
    const { ctx } = fakeCtx({ chunks: [] })
    const { res, promise } = call(ctx, { text: 'Hello world', target: 'auto' })
    await promise
    assert.equal(res.events().find((event) => event.type === 'start').resolved, 'zh')
  }
  {
    const { ctx } = fakeCtx({ chunks: [] })
    const { res, promise } = call(ctx, { text: '你好', target: '日本語' })
    await promise
    assert.equal(res.events().find((event) => event.type === 'start').resolved, '日本語')
  }
})

test('normalizeTarget：空/非字符串 → auto，预设透传，自定义语种截断 24 字', () => {
  assert.equal(normalizeTarget(undefined), 'auto')
  assert.equal(normalizeTarget(''), 'auto')
  assert.equal(normalizeTarget('  auto '), 'auto')
  assert.equal(normalizeTarget('zh'), 'zh')
  assert.equal(normalizeTarget('en'), 'en')
  assert.equal(normalizeTarget(' 日本語 '), '日本語')
  assert.equal(normalizeTarget('x'.repeat(50)).length, 24)
})

/* ────────────────────────── 路由令牌（上架前的安全卫生）────────────────────────── */

test('isAuthorizedToken：只有长度与内容都对的令牌才放行', async () => {
  const { getApiToken, isAuthorizedToken } = await import('../index.js')
  const token = getApiToken()
  assert.equal(typeof token, 'string')
  assert.ok(token.length >= 32, `令牌太短：${token.length}`)

  assert.equal(isAuthorizedToken({ 'x-dsh-select-translate-token': token }), true)
  assert.equal(isAuthorizedToken({}), false, '没有头 → 不放行')
  assert.equal(isAuthorizedToken({ 'x-dsh-select-translate-token': '' }), false, '空串 → 不放行')
  assert.equal(isAuthorizedToken({ 'x-dsh-select-translate-token': 'x'.repeat(token.length) }), false, '等长但内容错 → 不放行')
  assert.equal(isAuthorizedToken({ 'x-dsh-select-translate-token': token.slice(0, 8) }), false, '前缀 → 不放行')
  // 长度不等时 timingSafeEqual 会抛，实现必须先比长度（这条就是钉它别抛）
  assert.equal(isAuthorizedToken({ 'x-dsh-select-translate-token': token + 'extra' }), false, '超长 → 不放行且不抛')
})

test('宿主路由真的挂了令牌守卫：非 /ping 401、/ping 放行、带对令牌 200', async () => {
  const { apply, getApiToken } = await import('../index.js')
  let handler = null
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => {
      fn()
    },
    webServer: {
      register: (route) => {
        handler = route.handler
      },
    },
    subprocess: {
      // 假子进程：stdout/stderr 要有 on()，done 永不 settle（免得触发退避重启）
      spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, done: new Promise(() => {}), kill() {} }),
    },
  }
  apply(ctx)
  assert.equal(typeof handler, 'function', 'apply 应该注册了路由')

  const call = (path, headers) => {
    const res = {
      statusCode: 0,
      body: '',
      headersSent: false,
      writableEnded: false,
      writeHead(status) {
        this.statusCode = status
        this.headersSent = true
      },
      end(chunk) {
        if (chunk !== undefined) this.body = String(chunk)
        this.writableEnded = true
      },
    }
    // 守卫路径与 /ping、GET /settings 都是同步写响应，不用等 tick。
    // ⚠️ 路由是**按前缀挂载**的，真实 `req.url` 是完整路径（`/dsh-select-translate/api/...`），
    // 测试也必须喂完整路径 —— 传裸 `/ping` 会被当成"非 ping 路径"而 401（踩过）。
    handler({ url: 'http://127.0.0.1:19387' + path, method: 'GET', headers }, res)
    return res
  }

  const noToken = call('/dsh-select-translate/api/settings')
  assert.equal(noToken.statusCode, 401, '没带令牌应当 401')
  assert.match(noToken.body, /unauthorized/)

  const wrong = call('/dsh-select-translate/api/settings', { 'x-dsh-select-translate-token': 'nope' })
  assert.equal(wrong.statusCode, 401, '令牌错了应当 401')

  const ping = call('/dsh-select-translate/api/ping')
  assert.equal(ping.statusCode, 200, '/ping 不该要令牌（存活探测）')

  const good = call('/dsh-select-translate/api/settings', { 'x-dsh-select-translate-token': getApiToken() })
  assert.equal(good.statusCode, 200, '带对令牌应当放行')
  assert.equal(JSON.parse(good.body).ok, true)
})

/* ────────────────────────── 平台守卫（上架必需）────────────────────────── */

test('isSupportedPlatform：只有 win32 才算支持', async () => {
  const { isSupportedPlatform } = await import('../index.js')
  assert.equal(isSupportedPlatform('win32'), true)
  assert.equal(isSupportedPlatform('darwin'), false)
  assert.equal(isSupportedPlatform('linux'), false)
  assert.equal(isSupportedPlatform(''), false)
})

test('apply 在非 Windows 上直接跳过：不 spawn 伴生进程、不注册路由，只留一条 warn', async () => {
  const { apply } = await import('../index.js')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor?.configurable !== true) return // 环境不允许改 process.platform：跳过
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const warnings = []
    let registered = 0
    let spawned = 0
    const ctx = {
      logger: { info() {}, warn: (...args) => warnings.push(args.join(' ')) },
      effect: (fn) => fn(),
      webServer: { register: () => (registered += 1) },
      subprocess: { spawn: () => (spawned += 1) },
    }
    apply(ctx)
    assert.equal(spawned, 0, '非 Windows 不该拉起伴生进程')
    assert.equal(registered, 0, '非 Windows 不该注册路由')
    assert.ok(
      warnings.some((line) => line.includes('Windows')),
      `应该留一条说明平台的 warn，实际：${JSON.stringify(warnings)}`,
    )
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
  }
})
