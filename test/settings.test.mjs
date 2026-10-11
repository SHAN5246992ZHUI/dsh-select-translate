/**
 * `settings.mjs` —— 插件设置的默认值、校验、落盘（宿主半边）。
 *
 * 钉的是"配置文件被手改坏也不能让插件起不来"：非法值回落默认、坏 JSON 当作没设置、
 * 写不进去也只在内存里生效（不抛错）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSettingsStore, DEFAULT_SETTINGS, MODES, normalizeSettings, resolveRuntimeFile, resolveSettingsFile } from '../settings.mjs'

test('normalizeSettings：非法值回落默认、未知字段丢掉', () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ mode: 'icon' }), { mode: 'icon' })
  assert.deepEqual(normalizeSettings({ mode: 'auto' }), { mode: 'auto' })
  assert.deepEqual(normalizeSettings({ mode: 'bogus' }), { mode: 'auto' })
  assert.deepEqual(normalizeSettings({ mode: 'icon', 以后加的字段: 1 }), { mode: 'icon' })
  for (const junk of [null, undefined, 'icon', 42, []]) {
    assert.deepEqual(normalizeSettings(junk), { mode: 'auto' })
  }
  assert.deepEqual(MODES, ['auto', 'icon'])
})

test('resolveSettingsFile：落在 $DSH_HOME 下；拿不到 home 就不落盘', () => {
  assert.equal(resolveSettingsFile({ DSH_HOME: 'X:\\dsh-home' }), join('X:\\dsh-home', 'dsh-select-translate.json'))
  assert.equal(resolveSettingsFile({ DSH_HOME: 'X:\\dsh-home\\' }), join('X:\\dsh-home', 'dsh-select-translate.json'))
  assert.equal(resolveSettingsFile({}), '')
  assert.equal(resolveSettingsFile({ DSH_HOME: 42 }), '')
})

test('resolveRuntimeFile：与设置同目录；拿不到 home 就返回空串（运行时文件是给排障工具用的）', () => {
  assert.equal(resolveRuntimeFile({ DSH_HOME: 'X:\\dsh-home' }), join('X:\\dsh-home', 'dsh-select-translate-runtime.json'))
  assert.equal(resolveRuntimeFile({}), '')
  assert.equal(resolveRuntimeFile({ DSH_HOME: '' }), '')
})

test('没有文件路径时纯内存：改了就生效，但不落盘', () => {
  const store = createSettingsStore({ file: '', fs: null })
  assert.equal(store.file, '')
  assert.deepEqual(store.get(), { mode: 'auto' })
  assert.deepEqual(store.patch({ mode: 'icon' }), { mode: 'icon' })
  assert.deepEqual(store.get(), { mode: 'icon' })
})

test('落盘：改完能被新的 store 实例读到（含自动建目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-settings-'))
  try {
    const file = join(dir, 'nested', 'dsh-select-translate.json')
    const first = createSettingsStore({ file })
    assert.deepEqual(first.get(), { mode: 'auto' })
    assert.deepEqual(first.patch({ mode: 'icon' }), { mode: 'icon' })

    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(onDisk, { mode: 'icon' })

    const second = createSettingsStore({ file })
    assert.deepEqual(second.get(), { mode: 'icon' }, '新实例（=重启后）应当读到 icon')
    assert.deepEqual(second.patch({ mode: 'auto' }), { mode: 'auto' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏 JSON / 非法 mode 都当作"还没设置"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-settings-'))
  try {
    const file = join(dir, 'dsh-select-translate.json')
    writeFileSync(file, '这不是 JSON', 'utf8')
    assert.deepEqual(createSettingsStore({ file }).get(), { mode: 'auto' })

    writeFileSync(file, JSON.stringify({ mode: 'nope' }), 'utf8')
    assert.deepEqual(createSettingsStore({ file }).get(), { mode: 'auto' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写不进去也不抛错：本次运行内仍然生效', () => {
  const broken = {
    readFileSync: () => {
      throw new Error('no such file')
    },
    writeFileSync: () => {
      throw new Error('disk full')
    },
    mkdirSync: () => {
      throw new Error('denied')
    },
  }
  const store = createSettingsStore({ file: 'X:\\nope\\dsh-select-translate.json', fs: broken })
  assert.deepEqual(store.get(), { mode: 'auto' })
  assert.deepEqual(store.patch({ mode: 'icon' }), { mode: 'icon' })
  assert.deepEqual(store.get(), { mode: 'icon' })
})
