/**
 * SPDX-License-Identifier: MIT
 * 本文件衍生自 dsh-selection-tools（MIT · Copyright (c) 2026 dsh-selection-tools contributors）
 *   https://github.com/fyisgod/dsh-selection-tools @ 3f292d92（v0.8.2）
 * 上游声明原文与逐文件改动说明：本插件根目录 THIRD-PARTY-NOTICES.md
 * 改动：worker 统计增加 lastError（见 NOTICES 1.1）。
 */
/**
 * 选区与上下文读取（UI Automation）的主进程侧。
 *
 * 除了「选区所在的段落」，worker 还负责**读选区本身**（probe）——那是划词的主取词
 * 路径，全程不碰剪贴板；剪贴板只在 probe 读不到时才作为兜底（见 main.mjs）。
 *
 * 两个刻意的设计：
 * 1. **跑在 worker 线程里**：UIA 是同步 COM，目标应用无响应时会把调用线程一起卡住。
 *    worker 超时就直接 terminate 并重建，主进程的取词/菜单/绘制一秒都不会被拖住。
 * 2. **在菜单弹出之后再读**：用户在菜单上犹豫的这几百毫秒就是它的时间预算，
 *    所以"读上下文"不会给划词到菜单的链路加任何延迟；点菜单项时才去等结果。
 */
import { Worker } from 'node:worker_threads'

/**
 * 建立上下文读取器。
 * @param options - \`koffiHint\`（解析 koffi 的锚点路径）、\`timeoutMs\`（单次读取预算）、\`workerUrl\`。
 */
export function createContextReader(options = {}) {
  const workerUrl = options.workerUrl ?? new URL('./native/uia-worker.mjs', import.meta.url)
  const koffiHint = typeof options.koffiHint === 'string' ? options.koffiHint : ''
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 1200

  let worker = null
  let seq = 0
  let inflight = null
  // lastError 是刻意加的：worker 里的 UIA 初始化失败原本会被静默吞成"读不到选区"，
  // 表现为"取词一直没反应"却查不出原因。留一份给 /status 看。
  const stats = { reads: 0, probes: 0, ok: 0, timeouts: 0, errors: 0, restarts: 0, lastError: null }

  /** 结束（或丢弃）当前在途请求；结果一律是"没有上下文"而不是抛错。 */
  function settle(result, reason) {
    if (inflight === null) return
    const current = inflight
    inflight = null
    clearTimeout(current.timer)
    if (reason !== undefined) stats.errors++
    current.resolve(result)
  }

  /** 丢掉 worker（超时/异常）：下次请求会重建。 */
  function drop(reason) {
    if (worker !== null) {
      const dying = worker
      worker = null
      stats.restarts++
      try {
        void dying.terminate()
      } catch {
        /* 已经是死的 */
      }
    }
    if (inflight !== null && reason === 'timeout') stats.timeouts++
    settle(null, reason)
  }

  /** 懒建 worker。 */
  function ensureWorker() {
    if (worker !== null) return worker
    const created = new Worker(workerUrl, { workerData: { koffiHint } })
    created.on('message', (message) => {
      if (message === null || typeof message !== 'object' || message.id !== inflight?.id) return
      if (typeof message.error === 'string' && message.error !== '') stats.lastError = message.error
      settle(message.result ?? null, message.error === undefined ? undefined : 'error')
    })
    created.on('error', (error) => {
      if (worker === created) worker = null
      stats.errors++
      stats.lastError = error instanceof Error ? error.message : String(error)
      settle(null, 'error')
      void error
    })
    created.on('exit', () => {
      if (worker === created) worker = null
    })
    // 不因为这条线程把进程留在前台
    created.unref?.()
    worker = created
    return created
  }

  /** 发一次请求（同一时刻只保留最新的一次）。 */
  function request(type, payload) {
    return new Promise((resolve) => {
      const target = ensureWorker()
      if (inflight !== null) settle(null, 'superseded')
      const id = ++seq
      const timer = setTimeout(() => drop('timeout'), timeoutMs)
      inflight = { id, timer, resolve }
      try {
        target.postMessage({ id, type, ...payload })
      } catch (error) {
        settle(null, 'error')
        void error
      }
    })
  }

  return {
    /**
     * 读取选区所在的上下文段落。
     * @param point - 取词手势的落点（屏幕物理坐标）。
     * @param expected - 剪贴板里拿到的选中文本（校验 UIA 选区没串台）。
     * @returns \`{ unit, text, selection, className }\` 或 null。
     */
    read(point, expected) {
      stats.reads++
      return request('read', { point, expected }).then((result) => {
        if (result !== null) stats.ok++
        return result
      })
    },
    /**
     * 探一次：选区文本 + 选区所在段落（**不注入按键、不碰剪贴板**）。
     *
     * 这是划词的主取词路径：菜单弹出时先探一次（读到选区就顺带拿到上下文），
     * 点菜单项时如果还没读到，再补探一次（那时无障碍树已经热了）。
     * @param point - 手势落点（屏幕物理坐标）。
     * @param options.press - 手势**按下**的屏幕坐标：用来判断读到的选区是不是这次手势选出来的
     *   （缺省时按 point 算）。
     * @param options.retries - 读不到时在 worker 里重试几次（默认 2；补读时给 0）。
     * @returns `{ selection, unit, text, ... }` / `null`，语义见 uia.mjs 的 probe()。
     */
    probe(point, options = {}) {
      stats.probes++
      return request('probe', { point, retries: options.retries, press: options.press }).then((result) => {
        if (result !== null) stats.ok++
        return result
      })
    },
    /** 诊断（验收用）：这个点上 UIA 到底看到了什么。 */
    diagnose(point) {
      return request('diagnose', { point })
    },
    stats: () => ({ ...stats }),
    dispose() {
      drop('dispose')
    },
  }
}
