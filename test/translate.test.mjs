/**
 * `companion/translate.mjs` —— 宿主 SSE 的**客户端**半边。
 *
 * 与 `test/host.test.mjs` 是同一份协议的两端：那边钉"宿主发什么帧"，这边钉"伴生进程怎么解帧"。
 * 重点钉三件容易静默出错的事：**帧跨 chunk 切分**、**requestId 过滤**、**取消**（F-18）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTranslator, parseFrame } from '../companion/translate.mjs'

const encoder = new TextEncoder()
const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'

/** 一次性吐完所有 chunk 再结束的假响应。 */
function sseResponse(chunks, options = {}) {
  let index = 0
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    body: options.body === undefined ? { getReader: () => ({ read: async () => (index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true, value: undefined }) }) } : options.body,
    text: async () => options.detail ?? 'error body',
  }
}

/** 永远不回、但 abort 时按真 fetch 的语义 reject 的假响应。 */
function hangingResponse(init) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')))
            void resolve
          }),
      }),
    },
    text: async () => '',
  }
}

/** 按调用顺序返回预设响应的假 fetch。 */
function fakeFetch(sequence) {
  const calls = []
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init })
      const next = sequence.shift()
      if (next === undefined) throw new Error('unexpected fetch call')
      // 预设项可以是响应对象，也可以是"由 signal 生成响应"的函数（挂住型）
      return typeof next === 'function' ? next(init) : next
    },
  }
}

/** 每次调用 +10ms 的假时钟（让计时断言确定）。 */
function clock(step = 10) {
  let time = 0
  return () => (time += step)
}

const request = (patch = {}) => ({ text: 'The scheduler multiplexes goroutines.', target: 'zh', requestId: '7', ...patch })
const settle = () => new Promise((resolve) => setImmediate(resolve))

/* ────────────────────────── parseFrame ────────────────────────── */

test('parseFrame：多行 data 拼接成一条、忽略非 data 行、空帧与坏 JSON 返回 null', () => {
  assert.deepEqual(parseFrame('data: {"type":"delta","text":"中"}'), { type: 'delta', text: '中' })
  assert.deepEqual(parseFrame('event: message\ndata: {"type":"done"}'), { type: 'done' })
  assert.deepEqual(parseFrame('data: {"type":\ndata: "delta"}'), { type: 'delta' })
  assert.equal(parseFrame(''), null)
  assert.equal(parseFrame(': 注释'), null)
  assert.equal(parseFrame('data: {坏 JSON'), null)
})

/* ────────────────────────── 正常链路 ────────────────────────── */

test('分块到达：一帧被切成两个 chunk（连 \\n\\n 也跨块）也不能漏帧', async () => {
  const { impl, calls } = fakeFetch([
    sseResponse([
      frame({ type: 'start', requestId: '7' }) + 'data: {"type":"delta","text":"调',
      '度器"}\n',
      '\n' + frame({ type: 'delta', text: '复用', requestId: '7' }),
      frame({ type: 'done', text: '调度器复用', usage: { outputTokens: 3 }, finish: 'stop', requestId: '7' }),
    ]),
  ])
  const translator = createTranslator({ origin: 'http://127.0.0.1:19387', fetchImpl: impl, now: clock() })
  const events = []
  const outcome = await translator.run(request(), (event) => events.push(event))

  assert.equal(calls[0].url, 'http://127.0.0.1:19387/dsh-select-translate/api/translate')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'The scheduler multiplexes goroutines.', target: 'zh', requestId: '7' })
  assert.equal(calls[0].init.headers['x-dsh-select-translate-token'], undefined, '没给令牌就不带这个头（本地/测试场景）')

  assert.deepEqual(
    events.filter((event) => event.type === 'delta').map((event) => [event.chunk, event.answer]),
    [
      ['调度器', '调度器'],
      ['复用', '调度器复用'],
    ],
  )
  const done = events.at(-1)
  assert.equal(done.type, 'done')
  assert.equal(done.answer, '调度器复用')
  assert.deepEqual(done.usage, { outputTokens: 3 })
  assert.equal(done.finish, 'stop')

  assert.equal(outcome.answer, '调度器复用')
  assert.equal(outcome.error, null)
  assert.equal(outcome.aborted, false)
  // 假时钟：startedAt=10 → 首字=20-10=10 → totalMs=30-10=20
  assert.equal(outcome.firstTokenMs, 10)
  assert.equal(outcome.totalMs, 20)
})

test('requestId 不匹配的帧被丢掉（迟到的旧译文不许盖到新卡片上）', async () => {
  const { impl } = fakeFetch([
    sseResponse([
      frame({ type: 'delta', text: '旧译文', requestId: '6' }),
      frame({ type: 'delta', text: '新译文', requestId: '7' }),
      frame({ type: 'delta', text: '没带 id 也算数' }),
      frame({ type: 'done', text: '新译文没带 id 也算数', requestId: '7' }),
    ]),
  ])
  const translator = createTranslator({ origin: 'http://127.0.0.1:1', fetchImpl: impl, now: clock() })
  const outcome = await translator.run(request({ requestId: '7' }))
  assert.equal(outcome.answer, '新译文没带 id 也算数')
})

test('isCurrent 变 false 之后，后续帧整帧丢弃（旧 run 不许再写进卡片）', async () => {
  const { impl } = fakeFetch([
    sseResponse([frame({ type: 'delta', text: '第一段' }), frame({ type: 'delta', text: '第二段' }), frame({ type: 'done', text: '第一段第二段' })]),
  ])
  let current = true
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock(), isCurrent: () => current })
  const events = []
  const outcome = await translator.run(request(), (event) => {
    events.push(event)
    current = false // 回调里模拟"用户马上又划了一次"
  })

  assert.deepEqual(
    events.map((event) => event.type),
    ['delta'],
  )
  assert.equal(outcome.answer, '第一段')
  assert.equal(outcome.error, null)
})

test('isCurrent 一开始就是 false：一个事件都不出', async () => {
  const { impl } = fakeFetch([sseResponse([frame({ type: 'delta', text: '不该出现' }), frame({ type: 'done', text: '也不该出现' })])])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock(), isCurrent: () => false })
  const events = []
  const outcome = await translator.run(request(), (event) => events.push(event))

  assert.deepEqual(events, [])
  assert.equal(outcome.answer, '')
})

test('done 帧带 text 时以它为准（补全最后一个 chunk）', async () => {
  const { impl } = fakeFetch([sseResponse([frame({ type: 'delta', text: '半句' }), frame({ type: 'done', text: '半句完整。' })])])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
  const outcome = await translator.run(request())
  assert.equal(outcome.answer, '半句完整。')
})

test('宿主回 error 帧：透出 message，且不算传输错误', async () => {
  const { impl } = fakeFetch([sseResponse([frame({ type: 'error', message: '额度不足', requestId: '7' })])])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
  const events = []
  const outcome = await translator.run(request(), (event) => events.push(event))
  assert.deepEqual(events, [{ type: 'error', message: '额度不足' }])
  assert.equal(outcome.error, null)
})

/* ────────────────────────── 失败路径 ────────────────────────── */

test('404 / 405 说"宿主没加载到这版"，其他状态码带状态与响应体', async () => {
  for (const status of [404, 405]) {
    const { impl } = fakeFetch([sseResponse([], { ok: false, status })])
    const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
    const outcome = await translator.run(request())
    assert.match(outcome.error.message, /重启一次 DeepSeek Harness/)
  }

  const { impl } = fakeFetch([sseResponse([], { ok: false, status: 500, detail: 'boom' })])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
  const outcome = await translator.run(request())
  assert.equal(outcome.error.message, '宿主返回 500 boom')
})

test('响应没有 body 也算失败；没拿到宿主地址时立刻报错', async () => {
  const { impl } = fakeFetch([sseResponse([], { body: null })])
  const withBody = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
  assert.match((await withBody.run(request())).error.message, /宿主返回 200/)

  const noOrigin = createTranslator({ origin: '', fetchImpl: impl, now: clock() })
  assert.match((await noOrigin.run(request())).error.message, /没有拿到宿主地址/)
})

/* ────────────────────────── 取消（F-18） ────────────────────────── */

test('cancel()：在途请求立即结束，且算"取消"而不是"失败"', async () => {
  const { impl, calls } = fakeFetch([hangingResponse])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
  const pending = translator.run(request())
  await settle()

  assert.equal(calls[0].init.signal.aborted, false)
  assert.equal(translator.isBusy(), true)
  assert.equal(translator.cancel(), true)

  const outcome = await pending
  assert.equal(calls[0].init.signal.aborted, true)
  assert.equal(outcome.aborted, true)
  assert.equal(outcome.error, null)
  assert.equal(translator.isBusy(), false)
  assert.equal(translator.cancel(), false)
})

test('新请求取消旧请求（latest-wins）：旧的那次不会继续跑，也不报错', async () => {
  const { impl, calls } = fakeFetch([hangingResponse, () => sseResponse([frame({ type: 'done', text: '第二次译文' })])])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })

  const first = translator.run(request({ text: '第一次', requestId: '1' }))
  await settle()
  assert.equal(calls.length, 1)

  const second = await translator.run(request({ text: '第二次', requestId: '2' }))

  assert.equal(calls[0].init.signal.aborted, true, '旧请求必须被 abort')
  assert.equal((await first).aborted, true)
  assert.equal((await first).error, null)
  assert.equal(second.answer, '第二次译文')
  assert.equal(second.aborted, false)
})

test('取消之后再发新请求：通道仍然可用', async () => {
  const { impl } = fakeFetch([hangingResponse, () => sseResponse([frame({ type: 'done', text: '好的' })])])
  const translator = createTranslator({ origin: 'http://x', fetchImpl: impl, now: clock() })
  const pending = translator.run(request())
  await settle()
  translator.cancel()
  await pending

  const outcome = await translator.run(request({ requestId: '8' }))
  assert.equal(outcome.answer, '好的')
  assert.equal(outcome.error, null)
})

test('给了令牌就带上 x-dsh-select-translate-token 头（宿主路由挂在鉴权栅栏外，见 index.js 的 API_TOKEN）', async () => {
  const { calls, impl } = fakeFetch([() => sseResponse([frame({ type: 'done', text: '好的', requestId: '9' })])])
  const translator = createTranslator({ origin: 'http://x', token: 'abc123', fetchImpl: impl, now: clock() })
  const outcome = await translator.run(request({ requestId: '9' }))

  assert.equal(outcome.answer, '好的')
  assert.equal(calls[0].init.headers['x-dsh-select-translate-token'], 'abc123')
  assert.equal(calls[0].init.headers['content-type'], 'application/json', '不要因为加令牌把 content-type 弄丢')
})
