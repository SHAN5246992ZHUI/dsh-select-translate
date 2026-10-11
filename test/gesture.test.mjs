/**
 * `companion/gesture.mjs` —— 手势状态机 + 取词串行队列。
 *
 * 钉的是三件踩过的事：
 *  1. **阈值**：拖选 5px、双击 420ms/6px（方案 §6.6「别改成 SetWindowsHookEx」的这套轮询参数）；
 *  2. **位移用"按下到松开之间的最大位移"**：绕一圈回到原点的拖拽也算拖选；
 *  3. **latest-wins 串行队列**：两次取词绝不能重叠（旧实现的剪贴板串台就是这里没串行）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGestureDetector, createLatestQueue, GESTURE_DEFAULTS, pointInRect } from '../companion/gesture.mjs'

/** 跑一串采样，收集出手势与按下回调。 */
function feed(samples, options = {}) {
  const gestures = []
  const presses = []
  const detector = createGestureDetector({
    ...options,
    onGesture: (gesture) => gestures.push(gesture),
    onPress: (press) => presses.push(press),
  })
  for (const sample of samples) detector.push(sample)
  return { gestures, presses }
}

test('默认阈值与方案一致：拖选 5px / 双击 420ms·6px', () => {
  assert.deepEqual(GESTURE_DEFAULTS, { dragMinDistance: 5, doubleClickMs: 420, doubleClickSlop: 6 })
})

test('位移刚好到阈值算拖选，差一点不算', () => {
  const under = feed([
    { down: true, x: 100, y: 100, time: 0 },
    { down: false, x: 104, y: 100, time: 40 }, // 4px < 5
  ])
  assert.equal(under.gestures.length, 0)

  const exact = feed([
    { down: true, x: 100, y: 100, time: 0 },
    { down: false, x: 105, y: 100, time: 40 }, // 5px = 阈值
  ])
  assert.equal(exact.gestures.length, 1)
  assert.equal(exact.gestures[0].kind, 'drag')
})

test('拖选判定看的是"按下到松开之间的最大位移"，绕回原点仍算拖选', () => {
  const { gestures } = feed([
    { down: true, x: 0, y: 0, time: 0 },
    { down: true, x: 30, y: 40, time: 40 }, // 中途跑远：50px
    { down: true, x: 1, y: 1, time: 80 },
    { down: false, x: 1, y: 1, time: 120 }, // 松开时离按下点只有 ~1.41px
  ])
  assert.equal(gestures.length, 1)
  assert.equal(gestures[0].kind, 'drag')
  assert.equal(gestures[0].distance, 50)
})

test('手势带上按下点（downX/downY）与松开点（x/y）：用来分辨"这次到底选没选出文字"', () => {
  const { gestures } = feed([
    { down: true, x: 10, y: 20, time: 0 },
    { down: false, x: 90, y: 120, time: 60 },
  ])
  assert.equal(gestures[0].x, 90)
  assert.equal(gestures[0].y, 120)
  assert.equal(gestures[0].downX, 10)
  assert.equal(gestures[0].downY, 20)
  assert.equal(gestures[0].time, 60)
})

test('双击：两次点击在 420ms / 6px 内算双击，位置超限则不算', () => {
  const double = feed([
    { down: true, x: 500, y: 500, time: 1000 },
    { down: false, x: 500, y: 500, time: 1010 },
    { down: true, x: 503, y: 504, time: 1200 }, // 间隔 190ms、距离 5px
    { down: false, x: 503, y: 504, time: 1210 },
  ])
  assert.equal(double.gestures.length, 1)
  assert.equal(double.gestures[0].kind, 'double')

  const tooFar = feed([
    { down: true, x: 500, y: 500, time: 1000 },
    { down: false, x: 500, y: 500, time: 1010 },
    { down: true, x: 520, y: 500, time: 1200 }, // 距离 20px > 6
    { down: false, x: 520, y: 500, time: 1210 },
  ])
  assert.equal(tooFar.gestures.length, 0)
})

test('双击：间隔超过 420ms 不算；第一次点击本身不出手势', () => {
  const late = feed([
    { down: true, x: 500, y: 500, time: 1000 },
    { down: false, x: 500, y: 500, time: 1010 },
    { down: true, x: 500, y: 500, time: 1600 }, // 间隔 590ms > 420
    { down: false, x: 500, y: 500, time: 1610 },
  ])
  assert.equal(late.gestures.length, 0)
})

test('单击（没按下过 / 只是没动）不出任何手势', () => {
  assert.equal(feed([{ down: false, x: 1, y: 1, time: 0 }]).gestures.length, 0)
  assert.equal(
    feed([
      { down: true, x: 5, y: 5, time: 0 },
      { down: false, x: 5, y: 5, time: 30 },
    ]).gestures.length,
    0,
  )
})

test('onPress 只在"按下那一刻"回调一次，并标出这是不是双击的第二下', () => {
  const { presses } = feed([
    { down: true, x: 100, y: 100, time: 1000 },
    { down: true, x: 101, y: 100, time: 1020 }, // 按住期间重复采样：不许再回调
    { down: true, x: 102, y: 100, time: 1040 },
    { down: false, x: 102, y: 100, time: 1060 },
    { down: true, x: 102, y: 100, time: 1100 }, // 双击的第二下
    { down: false, x: 102, y: 100, time: 1120 },
  ])
  assert.equal(presses.length, 2)
  assert.equal(presses[0].second, false)
  assert.equal(presses[1].second, true)
  assert.equal(presses[1].x, 102)
})

test('自定义阈值能被覆盖（测试与调试用）', () => {
  const { gestures } = feed(
    [
      { down: true, x: 0, y: 0, time: 0 },
      { down: false, x: 2, y: 0, time: 10 },
    ],
    { dragMinDistance: 2 },
  )
  assert.equal(gestures.length, 1)
})

test('pointInRect：边界算在内，rect 为空时不算', () => {
  const rect = { left: 0, top: 0, right: 10, bottom: 10 }
  assert.equal(pointInRect({ x: 0, y: 0 }, rect), true)
  assert.equal(pointInRect({ x: 10, y: 10 }, rect), true)
  assert.equal(pointInRect({ x: 10.5, y: 5 }, rect), false)
  assert.equal(pointInRect({ x: 5, y: 5 }, null), false)
  assert.equal(pointInRect({ x: 5, y: 5 }, undefined), false)
})

/* ────────────────────────── 串行队列 ────────────────────────── */

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function untilIdle(queue) {
  for (let i = 0; i < 200; i++) {
    const stats = queue.stats()
    if (stats.running === false && stats.queued === false) return
    await tick()
  }
  throw new Error('队列没有停下来')
}

test('串行队列：同一时刻只跑一个，排队时只保留最新一次', async () => {
  const started = []
  let peak = 0
  let active = 0
  let releaseFirst = null
  const queue = createLatestQueue({
    run: async (payload) => {
      active += 1
      peak = Math.max(peak, active)
      started.push(payload)
      if (payload === 1) await new Promise((resolve) => (releaseFirst = resolve))
      active -= 1
    },
  })

  queue.submit(1)
  await tick()
  assert.deepEqual(started, [1])

  queue.submit(2)
  queue.submit(3) // 覆盖掉 2：用户最后划的那段才算数
  releaseFirst()
  await untilIdle(queue)

  assert.deepEqual(started, [1, 3])
  assert.equal(peak, 1)
})

test('isLatest：期间来了新手势，旧结果就不作数', async () => {
  const queue = createLatestQueue({ run: async () => {} })
  const first = queue.submit('a')
  assert.equal(queue.isLatest(first), true)
  const second = queue.submit('b')
  assert.equal(queue.isLatest(first), false)
  assert.equal(queue.isLatest(second), true)
  await untilIdle(queue)
})

test('串行队列：一次任务抛错不会卡死队列，后续任务照跑', async () => {
  const ran = []
  const errors = []
  const queue = createLatestQueue({
    run: async (payload) => {
      ran.push(payload)
      if (payload === 'bad') throw new Error('boom')
    },
    onError: (error) => errors.push(error.message),
  })
  queue.submit('bad')
  queue.submit('good')
  await untilIdle(queue)
  assert.deepEqual(ran, ['bad', 'good'])
  assert.deepEqual(errors, ['boom'])
})
