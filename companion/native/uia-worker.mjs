/**
 * SPDX-License-Identifier: MIT
 * 本文件衍生自 dsh-selection-tools（MIT · Copyright (c) 2026 dsh-selection-tools contributors）
 *   https://github.com/fyisgod/dsh-selection-tools @ 3f292d92（v0.8.2）
 * 上游声明原文与逐文件改动说明：本插件根目录 THIRD-PARTY-NOTICES.md
 * 与上游对应文件逐字节相同（未做修改）。
 */
/**
 * UIA 上下文读取的 worker 线程入口。
 *
 * 单独一条线程的意义：
 * - UIA 的调用是同步 COM，目标应用无响应时会把调用线程一起卡住；跑在 worker 里，
 *   主进程可以用超时直接 terminate 掉它，取词/菜单循环不受影响。
 * - 读失败一律回 null，调用方安静降级成"只送选区"。
 */
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

import { createUiaReader } from './uia.mjs'

let reader = null

/** 懒建 reader（第一次真正要读上下文时才加载 koffi / 初始化 COM）。 */
function ensureReader() {
  if (reader !== null) return reader
  const hint = typeof workerData?.koffiHint === 'string' && workerData.koffiHint !== '' ? workerData.koffiHint : import.meta.url
  const koffi = createRequire(hint)('koffi')
  reader = createUiaReader(koffi)
  return reader
}

/** 睡眠（重试间隔）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读不到时的重试次数与间隔。 */
const RETRIES = 2
const RETRY_GAP_MS = 160

parentPort?.on('message', async (message) => {
  const id = message?.id
  try {
    const api = ensureReader()
    if (message?.type === 'diagnose') {
      parentPort.postMessage({ id, result: api.diagnose(message.point) })
      return
    }
    // press 是手势按下的地方：用来判断读到的选区是不是这次手势选出来的（见 uia.mjs 的 probe）。
    const call = () =>
      message?.type === 'probe'
        ? api.probe(message.point, message.press === undefined ? {} : { press: message.press })
        : api.read(message.point, message.expected)
    // 重试次数由主进程按场景给（默认 2 次）：
    // - 菜单弹出时的预读：Chromium 这类应用是"被 UIA 问到才打开无障碍树"，冷启动那一刻
    //   TextPattern 还不存在（实测：第 0 次 no text pattern，第 1 次开始都正常），所以要重试；
    // - 点菜单项时的补读（0 次）：那时无障碍树已经热了，读不到就是真读不到——不能在这里
    //   再等 320ms 才退到剪贴板兜底。
    const retries = Number.isFinite(message?.retries) ? Math.max(0, Math.trunc(Number(message.retries))) : RETRIES
    let result = call()
    for (let attempt = 1; attempt <= retries && result === null; attempt++) {
      await sleep(RETRY_GAP_MS)
      result = call()
    }
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({ id, result: null, error: error instanceof Error ? error.message : String(error) })
  }
})
