import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverEngine, inspectEngine, STORE_ID } from '../src/publish/maitian/engine-loader.mjs'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { MaitianConfig } from '../src/publish/maitian/config.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { component } from './helpers/maitian-component.js'

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('组件发现按数字版本选最新，最高版损坏时不静默回退', async t => {
  const profileDir = await directory(t)
  const base = join(profileDir, 'Default', 'Extensions', STORE_ID)
  await assert.rejects(discoverEngine({ profileDir }), error => error.code === 'COMPONENT_NOT_INSTALLED')
  await component(join(base, '0.9.0_0'), '0.9.0')
  await component(join(base, '0.10.0_0'), '0.10.0')
  assert.equal((await discoverEngine({ profileDir })).version, '0.10.0')
  await mkdir(join(base, '0.11.0_0'))
  await assert.rejects(discoverEngine({ profileDir }), error => error.code === 'COMPONENT_UNREADABLE')
})

test('原目录无 package.json 时只读 ESM 加载，相对 import 与 Chrome 初始化正确', async t => {
  const root = await component(await directory(t))
  const engineRef = await discoverEngine({ source: 'local', localComponentDir: root })
  const before = await inspectEngine(root)
  const result = await runComponent({ engineRef, op: 'hello' })
  assert.equal(result.compatibility, 'structural-compatible')
  assert.equal(result.operations.fill, true)
  assert.equal(result.platforms.xhs.liveVerified, false)
  assert.equal(result.version, '1.0.0')
  assert.equal((await inspectEngine(root)).fingerprint, before.fingerprint)
  assert.deepEqual((await readdir(root)).sort(), ['lib', 'manifest.json'])
})

test('兼容 A→B 自动发现，无模块缓存或旧规则；原引用文件变化使执行失败', async t => {
  const profileDir = await directory(t)
  const base = join(profileDir, 'Default', 'Extensions', STORE_ID)
  const a = await component(join(base, '1.0.0_0'), '1.0.0', { limit: 20 })
  const old = await discoverEngine({ profileDir })
  assert.equal((await runComponent({ engineRef: old, op: 'hello' })).platforms.xhs.fields.title[1], 20)
  await component(join(base, '1.1.0_0'), '1.1.0', { limit: 8 })
  const latest = await discoverEngine({ profileDir })
  assert.equal(latest.version, '1.1.0')
  assert.equal((await runComponent({ engineRef: latest, op: 'hello' })).platforms.xhs.fields.title[1], 8)
  const data = { version: 1, video: 'video.mp4', platforms: { xhs: { title: '123456789' } } }
  assert.deepEqual(await runComponent({ engineRef: latest, op: 'validate', data, files: ['video.mp4'] }), { errors: ['上游标题规则'], warnings: ['上游原始提示'] })
  await writeFile(join(a, 'lib/init.js'), 'export const changed = true;')
  await assert.rejects(runComponent({ engineRef: old, op: 'hello' }), error => error.code === 'COMPONENT_CHANGED')
})

test('缺失填写入口只禁用填写，校验仍可用；校验入参必须为 data 与 Set', async t => {
  const root = await component(await directory(t), '2.0.0', { fill: false })
  const engineRef = await discoverEngine({ source: 'local', localComponentDir: root })
  const result = await runComponent({ engineRef, op: 'hello' })
  assert.equal(result.operations.fill, false)
  assert.equal(result.operations.validate, true)
  const data = { version: 1, video: 'video.mp4', platforms: { xhs: { title: '标题' } } }
  assert.deepEqual(await runComponent({ engineRef, op: 'validate', data, files: ['video.mp4'] }), { errors: [], warnings: ['上游原始提示'] })
  await assert.rejects(runComponent({ engineRef, op: 'validate', data: { dir: 'job', data }, files: ['video.mp4'] }), error => error.code === 'COMPONENT_OPERATION_FAILED')
})

test('探测拒绝浏览器副作用、符号链接和异常校验结果，不向外暴露上游异常', async t => {
  const root = await component(await directory(t), '1.0.0', { sideEffect: true })
  let engineRef = await discoverEngine({ source: 'local', localComponentDir: root })
  await assert.rejects(runComponent({ engineRef, op: 'hello' }), error => error.code === 'PROBE_SIDE_EFFECT')
  await component(root, '1.0.0', { validation: "return { errors: 'secret path /private/credentials', warnings: [] }" })
  engineRef = await discoverEngine({ source: 'local', localComponentDir: root })
  await assert.rejects(runComponent({ engineRef, op: 'validate', data: {}, files: [] }), error => error.code === 'INCOMPATIBLE_RESULT' && !error.message.includes('credentials'))
  await symlink(join(root, 'manifest.json'), join(root, 'lib/escape.js'))
  await assert.rejects(inspectEngine(root), error => error.code === 'COMPONENT_UNREADABLE')
})

test('执行器超时、非法运行时和已取消请求给出可诊断错误', async t => {
  const root = await component(await directory(t))
  const engineRef = await discoverEngine({ source: 'local', localComponentDir: root })
  await assert.rejects(runComponent({ nodePath: '/missing-maitian-node', engineRef, op: 'hello' }), error => error.code === 'RUNNER_START_FAILED')
  await assert.rejects(runComponent({ engineRef, op: 'hello', signal: AbortSignal.abort() }), error => error.code === 'RUNNER_CANCELLED')
  await writeFile(join(root, 'lib/init.js'), 'await new Promise(() => {});')
  const hanging = await inspectEngine(root)
  await assert.rejects(runComponent({ engineRef: hanging, op: 'hello', timeoutMs: 200 }), error => error.code === 'RUNNER_TIMEOUT')
})

test('缺少 WebSocket 时离线 hello 和 validate 仍可运行', async t => {
  const root = await component(await directory(t))
  const engineRef = await discoverEngine({ source: 'local', localComponentDir: root })
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = [previous, '--no-experimental-websocket'].filter(Boolean).join(' ')
  try {
    assert.equal(typeof WebSocket, 'function')
    assert.equal((await runComponent({ engineRef, op: 'hello' })).compatibility, 'structural-compatible')
    const data = { version: 1, video: 'video.mp4', platforms: { xhs: { title: '有效标题' } } }
    assert.deepEqual(await runComponent({ engineRef, op: 'validate', data, files: ['video.mp4'] }), { errors: [], warnings: ['上游原始提示'] })
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
})

test('配置私有原子保存，公开响应隐藏路径，缓存诊断不启动执行器', async t => {
  const root = await directory(t)
  const config = new MaitianConfig(join(root, 'config'))
  assert.equal(config.read().source, 'store')
  assert.equal(config.public().fillTimeoutMinutes, 360)
  await mkdir(config.root, { recursive: true, mode: 0o700 })
  await writeFile(config.file, JSON.stringify({ ...config.read(), exportComponentDir: '/obsolete/extension/path' }))
  assert.equal(Object.hasOwn(config.read(), 'exportComponentDir'), false)
  await config.save({ enabled: false })
  assert.equal(JSON.parse(await readFile(config.file, 'utf8')).exportComponentDir, undefined)
  const componentDir = await component(join(root, 'original'))
  await config.save({ source: 'local', localComponentDir: componentDir, enabled: true })
  assert.equal((await stat(config.file)).mode & 0o777, 0o600)
  assert.equal((await stat(config.root)).mode & 0o777, 0o700)
  assert.equal(JSON.stringify(config.public()).includes(root), false)
  assert.equal(JSON.parse(await readFile(config.file, 'utf8')).localComponentDir, componentDir)
  await assert.rejects(config.save({ nodePath: 'node' }), error => error.code === 'INVALID_CONFIG')
  await assert.rejects(config.save({ engineVersion: '1.0.0' }), error => error.code === 'INVALID_CONFIG')
  for (const fillTimeoutMinutes of [0, 1441, 1.5, '360', null]) await assert.rejects(config.save({ fillTimeoutMinutes }), error => error.code === 'INVALID_CONFIG')
  await config.save({ fillTimeoutMinutes: 480 })
  assert.equal(config.public().fillTimeoutMinutes, 480)
  const service = new MaitianPublishing({}, { config })
  assert.equal(service.public().diagnostic.code, 'NOT_PROBED')
  assert.equal((await service.probe()).diagnostic.detectedVersion, '1.0.0')
  await service.save({ enabled: false })
  assert.equal(service.public().diagnostic.code, 'NOT_PROBED')
})
