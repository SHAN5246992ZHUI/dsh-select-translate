/**
 * 卡片落位（纯函数）：锚点偏移 → 越界翻转 → 夹进工作区。
 *
 * 从 `main.mjs` 的 `place()` 抽出来的理由同 `hitzone.mjs`：那里一 import 就会开窗口，
 * 而"越界自动翻转 + 跨屏 DPI 换算"是方案 §3 明写的需求，必须有回归网。
 *
 * 抽样时**逐字保留原表达式**，包括两个容易"顺手化简"反而改掉行为的地方：
 *  1. 右侧翻转判据用的是 `Math.round(bodyWidth * s)`（本体宽），不是窗口宽 `windowW`；
 *  2. 夹取前先按 `Math.round(gap * s)` / `Math.round(shadow * s)` 取整。
 *
 * `metrics` 让划词小图标复用同一套落位/翻转：它只是把 gap/shadow/本体宽换成自己的。
 */
import { CARD } from './card.mjs'

/** 锚点到卡片本体角的间距（DIP）。 */
export const ANCHOR_GAP = 12

/**
 * @param anchor - 屏幕物理坐标（手势落点）。
 * @param work - 该屏工作区（物理像素）：`{ left, top, right, bottom }`。
 * @param s - 该屏缩放。
 * @param windowW/windowH - 已按 s 取整的窗口尺寸（物理像素）。
 * @param metrics - 可选覆盖 `{ gap, shadow, bodyWidth }`：小图标用它自己那套
 *   （`TRIGGER.gap` / `TRIGGER.shadow` / `TRIGGER.size`）。缺省走卡片常量。
 * @returns `{ x, y }` —— 窗口左上角（已含阴影外扩）。
 */
export function computePlacement({ anchor, work, s, windowW, windowH, metrics }) {
  const gapDip = metrics?.gap ?? ANCHOR_GAP
  const shadowDip = metrics?.shadow ?? CARD.shadow
  const bodyWidthDip = metrics?.bodyWidth ?? CARD.width
  const gap = Math.round(gapDip * s)
  const shadow = Math.round(shadowDip * s)
  // 锚点是"卡片本体"的角，不是含阴影外扩的窗口角
  let x = anchor.x + gap - shadow
  let y = anchor.y + gap - shadow
  if (x + shadow * 2 + Math.round(bodyWidthDip * s) > work.right - CARD.edge) x = anchor.x - gap - windowW + shadow
  if (y + windowH > work.bottom - CARD.edge) y = anchor.y - gap - windowH + shadow
  x = Math.min(Math.max(work.left + CARD.edge, x), Math.max(work.left + CARD.edge, work.right - CARD.edge - windowW))
  y = Math.min(Math.max(work.top + CARD.edge, y), Math.max(work.top + CARD.edge, work.bottom - CARD.edge - windowH))
  return { x, y }
}

/**
 * 只把窗口**夹进工作区**，不重新按锚点落位。
 *
 * 用在"内容长高了、窗口要跟着长"的时候：这时要保持左上角不动（用户可能刚把卡片拖到别处），
 * 只在越出工作区时收回来。翻转/定位的那套逻辑仍然只属于 `computePlacement`（新手势时算一次）。
 */
export function clampWindowToWork({ x, y, windowW, windowH, work }) {
  const left = Math.min(Math.max(work.left + CARD.edge, x), Math.max(work.left + CARD.edge, work.right - CARD.edge - windowW))
  const top = Math.min(Math.max(work.top + CARD.edge, y), Math.max(work.top + CARD.edge, work.bottom - CARD.edge - windowH))
  return { x: left, y: top }
}
