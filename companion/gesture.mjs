/**
 * SPDX-License-Identifier: MIT
 * 本文件衍生自 dsh-selection-tools（MIT · Copyright (c) 2026 dsh-selection-tools contributors）
 *   https://github.com/fyisgod/dsh-selection-tools @ 3f292d92（v0.8.2）
 * 上游声明原文与逐文件改动说明：本插件根目录 THIRD-PARTY-NOTICES.md
 * 与上游对应文件逐字节相同（未做修改）；仅有两处注释指向了上游的 companion/policy.mjs
 * ——那个文件本项目没有，本文件已把它们改指 companion/main.mjs。
 */
/**
 * 全局"划词手势"状态机（纯函数式，不碰任何系统 API，便于单测）。
 *
 * 输入是一串鼠标采样（左键按下与否 + 光标位置 + 时间），输出是两种手势：
 * - \`drag\`：按下后移动超过阈值再松开（拖选）；
 * - \`double\`：两次间隔很短、位置几乎相同的点击（双击选词）。
 *
 * 两种手势都带上 \`x\`/\`y\`（松开的位置，菜单锚在这里）与 \`downX\`/\`downY\`（按下的位置）：
 * 后者用来回答"这一次拖拽/双击到底选没选出文字"——旧选区还留在应用里的时候，光凭松开
 * 的位置分不出"这次真选了"和"上次留下的"。
 *
 * 除了手势本身，还会在**鼠标按下的那一刻**回调一次 \`onPress\`。上游（dsh-selection-tools）
 * 用它拍"手势之前的选区快照"，本项目不用这套（我们不做菜单判定）：我们用它实现
 * **"按下即判"——按下的位置在卡片/小图标之外就立刻收起**（单击不产生手势，写在
 * \`onGesture\` 里的话"点卡片外面"永远关不掉）。见 companion/main.mjs 的 \`onPress\`。
 * 带上 \`second\` 是为了让调用方知道这一下是"双击的第二下"——本项目暂未用到。
 *
 * 采样由调用方（companion/main.mjs）以固定频率喂进来，因此这里完全不依赖
 * 钩子/回调，测试可以直接喂一串假采样。
 */

/** 默认阈值。 */
export const GESTURE_DEFAULTS = {
  /** 拖选判定：按下到松开之间的最大位移（像素）。 */
  dragMinDistance: 5,
  /** 双击判定：两次点击的最大间隔（毫秒）。 */
  doubleClickMs: 420,
  /** 双击判定：两次点击的最大位移（像素）。 */
  doubleClickSlop: 6,
}

/**
 * 创建手势检测器。
 * @param options - 阈值覆盖 + \`onGesture\` / \`onPress\` 回调。
 * @returns \`{ push }\`。
 */
export function createGestureDetector(options = {}) {
  const config = { ...GESTURE_DEFAULTS, ...options }
  const onGesture = options.onGesture ?? (() => {})
  const onPress = options.onPress ?? (() => {})

  let pressed = false
  let downX = 0
  let downY = 0
  let moved = 0
  let lastUpX = 0
  let lastUpY = 0
  let lastUpTime = Number.NEGATIVE_INFINITY
  let awaitingSecondClick = false

  /**
   * 喂一个采样。
   * @param sample - \`{ down, x, y, time }\`（time 为毫秒时间戳）。
   */
  function push(sample) {
    const { down, x, y, time } = sample
    if (down) {
      if (!pressed) {
        pressed = true
        downX = x
        downY = y
        moved = 0
        awaitingSecondClick =
          time - lastUpTime <= config.doubleClickMs &&
          Math.hypot(x - lastUpX, y - lastUpY) <= config.doubleClickSlop
        // 按下的这一刻回调：调用方要在这里拍一张"手势之前的选区"快照（见文件头）。
        onPress({ x, y, time, second: awaitingSecondClick })
      } else {
        moved = Math.max(moved, Math.hypot(x - downX, y - downY))
      }
      return
    }
    if (!pressed) return
    pressed = false
    const distance = Math.max(moved, Math.hypot(x - downX, y - downY))
    // downX/downY 也要带上：调用方用"按下点"判断**这次手势是不是选出了那段文字**
    // （旧选区还留在应用里时，光凭鼠标松开的位置分不出"这次真选了"还是"上次留下的"）。
    const at = { x, y, time, downX, downY }
    if (distance >= config.dragMinDistance) {
      awaitingSecondClick = false
      onGesture({ kind: 'drag', distance, ...at })
    } else if (awaitingSecondClick) {
      awaitingSecondClick = false
      onGesture({ kind: 'double', distance, ...at })
    }
    lastUpX = x
    lastUpY = y
    lastUpTime = time
  }

  return { push }
}

/** 点是否落在矩形内（用于忽略落在浮层自己身上的点击）。 */
export function pointInRect(point, rect) {
  if (rect === null || rect === undefined) return false
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

/**
 * 手势串行队列（latest-wins）。
 *
 * 取词要**注入 Ctrl+C 并读全局剪贴板**，所以两次取词绝不能重叠：后一次注入引起的剪贴板
 * 变化会被前一次的轮询读到（前一次迟到的"还原"也会正好写在后一次的轮询窗口里），于是
 * 菜单与回答窗口拿着一整段跟"这次选区"无关的文字弹出来——用户看到的就是"点菜单按钮后
 * 窗口里的输入内容与选中的文字不符"。
 *
 * 规则：
 * - 同一时刻只跑一个任务（真正的串行，不靠运气）；
 * - 排队时只保留**最新**一次手势（用户最后划的那段才是他要的）；
 * - 跑完时用 {@link createLatestQueue.isLatest} 判一下"结果还作不作数"——期间又来了
 *   新手势的话，旧结果直接丢掉，不许拿它去弹菜单。
 *
 * @param options - \`run(payload, seq)\`、\`onError(error)\`。
 */
export function createLatestQueue(options = {}) {
  const run = options.run ?? (async () => {})
  const onError = options.onError ?? (() => {})
  let running = false
  let queued = null
  let latest = 0

  /** 依次跑完队列（同一时刻只有一个在跑）。 */
  async function pump() {
    if (running) return
    running = true
    try {
      while (queued !== null) {
        const job = queued
        queued = null
        try {
          await run(job.payload, job.seq)
        } catch (error) {
          onError(error)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    /**
     * 提交一次手势。
     * @returns 本次提交的序号（配合 isLatest 判断结果还算不算数）。
     */
    submit(payload) {
      latest += 1
      queued = { payload, seq: latest }
      void pump()
      return latest
    },
    /** 这个序号还是最新的吗（期间没有更新的手势进来）。 */
    isLatest(seq) {
      return seq === latest
    },
    /** 现在有任务在跑吗 / 有排队的手势吗（诊断用）。 */
    stats() {
      return { running, queued: queued !== null, latest }
    },
  }
}
