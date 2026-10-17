/**
 * 取词文本整理（纯函数，便于单测）。
 *
 * 为什么需要：**不是所有 UIA 提供方都会给换行**。PDF（Chromium 的文字层）实测会把整段选区
 * 交成**一整行**，连换行处的空格都丢掉（`this data` → `thisdata`）——
 * 于是模型拿到的原文没有任何结构可保，"保持分段"的提示词无从生效（交接文档 §6 第 23 条）。
 *
 * 这里做两件确定性的整理，**不依赖模型**：
 *  1. `normalizeLineBreaks` —— `\r\n` / `\r` → `\n`（原生排版只认 `\n`）；
 *  2. `restoreListBreaks` —— 只有在**整段完全没有换行**时，才按行内编号/分条标记插回换行。
 *     有换行的文本一律不动（那是提供方给的真实结构，比任何猜测都可靠）。
 */

/** `\r\n` / `\r` → `\n`。 */
export function normalizeLineBreaks(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/**
 * 行内分条标记。要同时满足两点才插换行，避免误伤正文：
 *  - **前面必须紧跟句末标点**（`. ! ? ; :` / 中文全角 / 右括号 / 右方括号）——
 *    这样 "the option (a) is better" 这种正文里的括号引用不会被拆开；
 *  - **标记本身**必须是列表形态：`(a)` / `(xyz)` / `(1)` / `1.`+空格 / `1)` / `①`–`⑳`。
 *    注意 `\d+\.` 后面要求空格，所以 "2.5 GHz" 这种小数不会被误拆。
 */
const INLINE_LIST_BREAK = /(?<=[.!?;:。！？；：\])】])\s*(?=\([A-Za-z0-9]{1,4}\)|[\u2460-\u2473]|\d{1,2}[.)](?=\s))/g

/**
 * 给"被压成一行"的文本按分条标记插回换行。已有换行的文本原样返回。
 * @param {string} text
 * @returns {string}
 */
export function restoreListBreaks(text) {
  const s = String(text ?? '')
  if (s === '' || s.includes('\n')) return s
  return s.replace(INLINE_LIST_BREAK, '\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * 发给模型 / 上屏前的统一整理：先归一行分隔符，再（必要时）按分条标记插回换行。
 * @param {string} text
 * @returns {string}
 */
export function prepareSourceText(text) {
  return restoreListBreaks(normalizeLineBreaks(text))
}
