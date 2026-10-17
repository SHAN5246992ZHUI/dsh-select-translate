/**
 * `companion/text.mjs` —— 取词文本整理（交接文档 §6 第 23 条）。
 *
 * 这一块的样本全部来自**真实现场**：在 DSH 里打开 PDF 划选一段题库文字，
 * UIA 的文字层把整段交成**一行**，而且换行处的空格也丢了（`this data` → `thisdata`）——
 * 模型拿到的原文没有任何结构可保，"保持分段"的提示词因此无从生效。
 *
 * 所以这里钉两件事：**该拆的拆开**（行内编号/分条），**不该拆的不许动**（小数、正文里的括号引用）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeLineBreaks, prepareSourceText, restoreListBreaks } from '../companion/text.mjs'

/** 真实样本：在 DSH 的 PDF 里划选"表1这道题"，UIA 交出来的原文（一行、空格也有丢失）。 */
const PDF_SAMPLE =
  '3. Table 1 lists a set of empirical path loss measurements. Assume a carrier frequency fc = 2 GHz. [10points]' +
  '(a) Find the parameters of a single-slope path loss model plus log-normal shadowing that best fit thisdata ' +
  'assuming K is calculated from free-space path loss at the reference distance dr = 1 m.' +
  '(b) Find the path loss at 2 km based on this model.' +
  '(c) Find the outage probability at a distance d assuming the received power at d due to path lossalone is ' +
  '10 dB above the required power for non-outage.'

test('normalizeLineBreaks：\\r\\n / \\r → \\n，非字符串当空串', () => {
  assert.equal(normalizeLineBreaks('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'].join('\n'))
  assert.equal(normalizeLineBreaks(undefined), '')
  assert.equal(normalizeLineBreaks(null), '')
  assert.equal(normalizeLineBreaks('已经是\n换行'), '已经是\n换行')
})

test('restoreListBreaks：PDF 那种"压成一行"的题目，按 (a)(b)(c) 插回换行', () => {
  const out = restoreListBreaks(PDF_SAMPLE)
  const lines = out.split('\n')

  // 4 段：题干 + (a) + (b) + (c)
  assert.equal(lines.length, 4, out)
  assert.ok(lines[0].startsWith('3. Table 1'), lines[0])
  assert.ok(lines[1].startsWith('(a) Find the parameters'), lines[1])
  assert.ok(lines[2].startsWith('(b) Find the path loss'), lines[2])
  assert.ok(lines[3].startsWith('(c) Find the outage probability'), lines[3])
  // 原文内容一个字都不能丢
  assert.equal(out.replace(/\n/g, ''), PDF_SAMPLE)
})

test('restoreListBreaks：编号风格都认（1. / 2) / ① / (1)）', () => {
  const out = restoreListBreaks('步骤如下。1. 装插件。2. 重启应用。3. 选中文字。')
  assert.deepEqual(out.split('\n'), ['步骤如下。', '1. 装插件。', '2. 重启应用。', '3. 选中文字。'])

  const paren = restoreListBreaks('Choose one.(1) First.(2) Second.')
  assert.equal(paren, ['Choose one.', '(1) First.', '(2) Second.'].join('\n'))

  const circled = restoreListBreaks('三种情况。① 正常。② 超时。③ 报错。')
  assert.deepEqual(circled.split('\n'), ['三种情况。', '① 正常。', '② 超时。', '③ 报错。'])
})

test('restoreListBreaks：不许误伤 —— 小数、正文里的括号引用、已有换行', () => {
  // 2.5 GHz 不是 "2." 开头的分条（点号后面不是空格）
  assert.equal(restoreListBreaks('载波频率 fc = 2.5 GHz，距离 2.4 m。'), '载波频率 fc = 2.5 GHz，距离 2.4 m。')
  // 正文里的括号引用前面不是句末标点 → 不拆
  assert.equal(restoreListBreaks('You can pick the option (a) or the option (b).'), 'You can pick the option (a) or the option (b).')
  // 已经有换行的文本一律不动（提供方给的真实结构优先于任何猜测）
  const already = '第一段。\n(a) 第二段。\n(b) 第三段。'
  assert.equal(restoreListBreaks(already), already)
})

test('prepareSourceText：先归一行分隔符、再（必要时）插回分条换行，且幂等', () => {
  // \r\n 版本：先归一化成 \n，于是 restore 不再动手（真实结构已存在）
  const crlf = '题干。\r\n(a) 第一项。\r\n(b) 第二项。'
  const out = prepareSourceText(crlf)
  assert.equal(out.includes('\r'), false)
  assert.deepEqual(out.split('\n'), ['题干。', '(a) 第一项。', '(b) 第二项。'])

  // 幂等：整理过的文本再整理一次不变
  const once = prepareSourceText(PDF_SAMPLE)
  assert.equal(prepareSourceText(once), once)
})
