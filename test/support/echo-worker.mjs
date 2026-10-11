/**
 * 假 UIA worker：给 `context.mjs` 的超时隔离 / 错误 / 取代逻辑当对手戏。
 *
 * 用**落点的 x 坐标**切换行为（生产侧的 `probe()` 只传 point/retries/press，所以只能这样打信号）：
 *   x = 1 → 永不回消息（模拟"目标应用无响应"）
 *   x = 2 → 回一条 error（模拟 worker 内部失败）
 *   其他 → 正常回一条选区结果
 *
 * 顶部的 `process.exit(0)` 是护栏：万一有人直接 `node --test`（不带 glob）扫到本文件并把它
 * 当测试跑，它会立刻退出，而不是守着 parentPort 把测试进程挂死。
 */
import { parentPort } from 'node:worker_threads'

if (parentPort === null) process.exit(0)

parentPort.on('message', (message) => {
  const { id, type, point } = message
  if (point?.x === 1) return // 故意不回：让调用方超时
  if (point?.x === 2) {
    parentPort.postMessage({ id, error: 'worker exploded' })
    return
  }
  parentPort.postMessage({ id, result: { selection: '假选区文本', unit: 'point', type } })
})
