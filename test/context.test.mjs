/**
 * `companion/context.mjs` —— 取词的超时隔离与在途请求语义。
 *
 * 这条是"取词不卡 UI"的全部保障（方案 §5：UIA 跑 worker + 超时隔离）：
 * UIA 是同步 COM，目标应用无响应时会把调用线程一起卡住；worker 超时就直接 terminate 并重建。
 * 配置见 `companion/native/uia-worker.mjs`。
 *
 * 用 `test/support/echo-worker.mjs` 当对手戏，它按落点 x 切换行为：
 *   x = 1 → 永不回消息（模拟目标应用无响应）；x = 2 → 回一条 error；其他 → 正常回结果。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextReader } from '../companion/context.mjs'

const WORKER = new URL('./support/echo-worker.mjs', import.meta.url)
const TIMEOUT_MS = 300

function makeReader(options = {}) {
  return createContextReader({ workerUrl: WORKER, timeoutMs: TIMEOUT_MS, ...options })
}

test('probe：正常路径拿回选区结果，并记账', async () => {
  const reader = makeReader()
  try {
    const result = await reader.probe({ x: 0, y: 0 }, { retries: 2 })
    assert.deepEqual(result, { selection: '假选区文本', unit: 'point', type: 'probe' })
    const stats = reader.stats()
    assert.equal(stats.probes, 1)
    assert.equal(stats.ok, 1)
    assert.equal(stats.timeouts, 0)
    assert.equal(stats.errors, 0)
  } finally {
    reader.dispose()
  }
})

test('read：走同一套通道，单独记账', async () => {
  const reader = makeReader()
  try {
    const result = await reader.read({ x: 0, y: 0 }, '预期文本')
    assert.equal(result.type, 'read')
    const stats = reader.stats()
    assert.equal(stats.reads, 1)
    assert.equal(stats.ok, 1)
  } finally {
    reader.dispose()
  }
})

test('目标应用无响应：超时后返回 null（绝不抛错、绝不断链），worker 被重建', async () => {
  const reader = makeReader()
  try {
    const started = Date.now()
    const result = await reader.probe({ x: 1, y: 0 })
    assert.equal(result, null)
    assert.ok(Date.now() - started >= TIMEOUT_MS - 20, '应当等到超时预算用完')
    const stats = reader.stats()
    assert.equal(stats.timeouts, 1)
    assert.equal(stats.restarts, 1)
    assert.equal(stats.ok, 0)
  } finally {
    reader.dispose()
  }
})

test('超时之后仍然可用：下一次请求会新建 worker 并成功', async () => {
  const reader = makeReader()
  try {
    assert.equal(await reader.probe({ x: 1, y: 0 }), null)
    const recovered = await reader.probe({ x: 0, y: 0 })
    assert.equal(recovered.selection, '假选区文本')
    const stats = reader.stats()
    assert.equal(stats.timeouts, 1)
    assert.equal(stats.ok, 1)
    assert.equal(stats.restarts, 1)
  } finally {
    reader.dispose()
  }
})

test('worker 内部失败：结果是 null，原因留在 stats.lastError（原来会被静默吞掉）', async () => {
  const reader = makeReader()
  try {
    const result = await reader.probe({ x: 2, y: 0 })
    assert.equal(result, null)
    const stats = reader.stats()
    assert.equal(stats.errors, 1)
    assert.equal(stats.lastError, 'worker exploded')
    assert.equal(stats.timeouts, 0)
  } finally {
    reader.dispose()
  }
})

test('在途只保留最新一次：被取代的请求立即拿到 null，最新那次正常返回', async () => {
  const reader = makeReader()
  try {
    const first = reader.probe({ x: 0, y: 0 })
    const second = reader.probe({ x: 0, y: 0 })
    const [a, b] = await Promise.all([first, second])
    assert.equal(a, null)
    assert.equal(b.selection, '假选区文本')
    assert.equal(reader.stats().ok, 1)
  } finally {
    reader.dispose()
  }
})

test('diagnose 走同一通道（排障端点用），不记 probes', async () => {
  const reader = makeReader()
  try {
    const report = await reader.diagnose({ x: 0, y: 0 })
    assert.equal(report.type, 'diagnose')
    assert.equal(reader.stats().probes, 0)
  } finally {
    reader.dispose()
  }
})

test('dispose 之后再请求：能自愈（新 worker），不抛错', async () => {
  const reader = makeReader()
  try {
    reader.dispose()
    const result = await reader.probe({ x: 0, y: 0 })
    assert.equal(result.selection, '假选区文本')
  } finally {
    reader.dispose()
  }
})
