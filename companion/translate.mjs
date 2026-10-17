/**
 * 宿主 `POST /dsh-select-translate/api/translate` 的 **SSE 客户端**（手写帧切分）。
 *
 * 从 `main.mjs` 抽出来是为了能单测三件容易**静默出错**的事：
 *  1. **帧切分**：`\n\n` 正好跨在两个网络 chunk 之间（分块到达是常态）时不能漏帧；
 *  2. **requestId 过滤**：迟到的旧译文绝不能盖到新卡片上（两道保护：这次 run 是否还被需要 +
 *     帧里带的 requestId 是否对得上）；
 *  3. **取消**（设计文档 F-18「新请求必须取消旧请求」）：不取消的话模型照跑照计费。
 *
 * 宿主那半边（`index.js` 的 `handleTranslate`）的帧格式就是这里的对手戏，两边各有测试。
 */

/** 从一帧 SSE 文本里取出 JSON 事件；空帧 / 坏 JSON 返回 null。 */
export function parseFrame(frame) {
  const payload = String(frame)
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('')
  if (payload === '') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

/**
 * 建一个翻译通道。同一时刻只保留一个在途请求（latest-wins）。
 * @param options.origin - 宿主地址（如 `http://127.0.0.1:19387`）；空串表示拿不到。
 * @param options.fetchImpl - 注入用（测试用假 fetch）。
 * @param options.now - 注入时钟（测试用）。
 * @param options.isCurrent - `(requestId) => boolean`：这次 run 还是不是"当前那一次"。
 *   返回 false 时整帧丢弃（新手势一来，旧 run 的 delta 就不许再写进卡片）。
 * @param options.token - 宿主下发的路由令牌（宿主路由挂在鉴权栅栏外，见 index.js 的 API_TOKEN）；
 *   经 `x-dsh-select-translate-token` 头带上。
 */
export function createTranslator(options = {}) {
  const origin = (typeof options.origin === 'string' ? options.origin : '').replace(/\/$/, '')
  const token = typeof options.token === 'string' ? options.token : ''
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true
  let active = null

  /** 取消在途请求；返回是否真的取消了。 */
  function cancel() {
    const doomed = active
    active = null
    if (doomed === null) return false
    try {
      doomed.abort()
    } catch {
      /* 已经结束了 */
    }
    return true
  }

  /**
   * 发一次翻译。**会先取消上一次**。
   * 一律 resolve、不抛错：`{ answer, firstTokenMs, totalMs, aborted, error }`。
   * 主动取消时 `aborted: true` 且 `error: null`（调用方不该把它当失败弹红字）。
   *
   * @param request - `{ text, target, requestId }`。
   * @param onEvent - `{type:'delta', chunk, answer}` / `{type:'done', answer, usage, finish}` / `{type:'error', message}`。
   */
  async function run(request, onEvent = () => {}) {
    cancel()
    const controller = new AbortController()
    active = controller
    const startedAt = now()
    let answer = ''
    let firstTokenMs = null
    let error = null

    try {
      if (origin === '') throw new Error('伴生进程没有拿到宿主地址，无法翻译')

      const response = await fetchImpl(origin + '/dsh-select-translate/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(typeof token === 'string' && token !== '' ? { 'x-dsh-select-translate-token': token } : {}) },
        body: JSON.stringify({ text: request.text, target: request.target, requestId: String(request.requestId) }),
        signal: controller.signal,
      })

      if (response.ok !== true || response.body === null || response.body === undefined) {
        const detail = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
        // 宿主半边还是旧版本时，这条路径要么 404、要么被 SPA fallback 回 405。
        // 两种情况都说清楚，别让用户对着红字猜。
        const stale = response.status === 404 || response.status === 405
        throw new Error(
          stale
            ? '宿主插件还没加载到这版，需要重启一次 DeepSeek Harness'
            : '宿主返回 ' + response.status + ' ' + String(detail).slice(0, 120),
        )
      }

      const decoder = new TextDecoder()
      let buffer = ''
      const reader = response.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseFrame(raw)
          if (event === null) continue
          // 两道保护：① 这次 run 已经被更新的划词取代 → 整帧丢弃；
          //           ② 帧里带的 requestId 对不上 → 丢弃（宿主的 start/delta/done/error 都带）。
          if (isCurrent(request.requestId) !== true) continue
          if (event.requestId !== undefined && String(event.requestId) !== String(request.requestId)) continue
          if (event.type === 'delta' && typeof event.text === 'string') {
            if (firstTokenMs === null) firstTokenMs = now() - startedAt
            answer += event.text
            onEvent({ type: 'delta', chunk: event.text, answer })
          } else if (event.type === 'start') {
            // 宿主把"自动"判定出来的目标语言带回来：卡片头部显示「自动·中文」
            onEvent({ type: 'start', resolved: event.resolved ?? null })
          } else if (event.type === 'done') {
            if (event.text) answer = event.text
            // 把宿主的计时一起带出来：我们的 totalMs 减它 = "卡片落后模型多少"
            onEvent({ type: 'done', answer, usage: event.usage ?? null, finish: event.finish ?? null, timing: event.timing ?? null })
          } else if (event.type === 'error') {
            onEvent({ type: 'error', message: String(event.message ?? '翻译失败') })
          }
        }
      }
    } catch (thrown) {
      // 主动 abort 不算错误：关卡片 / 新手势都会走到这里
      if (controller.signal.aborted !== true) error = thrown instanceof Error ? thrown : new Error(String(thrown))
    } finally {
      if (active === controller) active = null
    }

    return { answer, firstTokenMs, totalMs: now() - startedAt, aborted: controller.signal.aborted, error }
  }

  return { run, cancel, isBusy: () => active !== null }
}
