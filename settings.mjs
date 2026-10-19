/**
 * 插件设置（**宿主半边**）：默认值、校验、落盘。
 *
 * 为什么不用 DSH 官方的设置体系（结论来自 §5.5 的调研）：
 *  - 宿主可以 `export const Config` 声明可配置项，但**没有任何已发布客户端会按 schema 自动画页面**，
 *    要自己画设置页；而 `Config` 要用 schemastery/zod 构造 schema，插件目录里没有 node_modules，
 *    依赖解析不到 —— 所以这里走"自己写一份最小 JSON"（0.1.3 起不再有设置页，这份设置只由卡片头部 ⚡ 读写）；
 *  - 这与已发布的同类插件一致（`dsh-selection-tools` 就是 fs 写 `DSH_HOME/dsh-selection-tools.json`）。
 *
 * 文件位置：`$DSH_HOME/dsh-select-translate.json`（拿不到 DSH_HOME 就只在内存里生效）。
 * 全同步 IO：文件极小、只在启动与用户切开关时读写，省掉一整条异步管道。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认设置。 */
export const DEFAULT_SETTINGS = { mode: 'auto' }

/** 触发模式：`auto` = 即划即译；`icon` = 划词出小图标、点击才译。 */
export const MODES = ['auto', 'icon']

const NODE_FS = { readFileSync, writeFileSync, mkdirSync }

/**
 * 把任意输入收敛成合法设置：未知字段丢掉、非法值回落默认。
 * 这样"配置文件被手改坏"不会让插件起不来。
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    mode: MODES.includes(source.mode) ? source.mode : DEFAULT_SETTINGS.mode,
  }
}

/** 默认文件路径：`$DSH_HOME/dsh-select-translate.json`；拿不到 home 就返回空串（纯内存）。 */
export function resolveSettingsFile(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME : ''
  return home === '' ? '' : join(home, 'dsh-select-translate.json')
}

/**
 * 运行时文件：`$DSH_HOME/dsh-select-translate-runtime.json`。
 *
 * 伴生进程启动时把自己监听的随机端口与宿主下发的路由令牌写进去，**只给本机排障工具用**
 * （真进程冒烟脚本靠它拿端口 + 令牌）。它不扩大攻击面：网页读不到本机文件，
 * 能读文件的本地进程本来也能读别的。
 */
export function resolveRuntimeFile(env = process.env) {
  const file = resolveSettingsFile(env)
  return file === '' ? '' : join(dirname(file), 'dsh-select-translate-runtime.json')
}

/**
 * 建一个同步的设置存储。
 * @param options.file - 覆盖文件路径（测试用）。
 * @param options.env - 覆盖环境（测试用）。
 * @param options.fs - 覆盖 fs（`readFileSync` / `writeFileSync` / `mkdirSync`）；传 `null` 表示纯内存。
 */
export function createSettingsStore(options = {}) {
  const fs = options.fs === undefined ? NODE_FS : options.fs
  const file = options.file ?? resolveSettingsFile(options.env)
  let cache = null

  function readRaw() {
    if (fs === null || file === '') return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // 文件不存在 / 不是合法 JSON / 读不动：一律当"还没有设置"
      return null
    }
  }

  /** 当前设置（首次读盘后进缓存）。 */
  function get() {
    if (cache === null) cache = normalizeSettings(readRaw())
    return cache
  }

  /** 合并一部分设置并落盘；写不进去也返回新值（只在内存里生效）。 */
  function patch(partial) {
    const next = normalizeSettings({ ...get(), ...(partial !== null && typeof partial === 'object' ? partial : {}) })
    cache = next
    if (fs !== null && file !== '') {
      try {
        const dir = dirname(file)
        if (dir !== '' && dir !== '.') fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
      } catch {
        /* 写不进去就算了：本次运行内仍然生效 */
      }
    }
    return next
  }

  return { file, get, patch }
}
