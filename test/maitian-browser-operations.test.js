import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { browserOperation } from '../src/publish/maitian/browser-operation.mjs'
import { BrowserOperations } from '../src/publish/maitian/browser-operations.js'
import { acquireProfileLock } from '../src/publish/maitian/profile-lock.js'
import { inspectEngine, STORE_URL } from '../src/publish/maitian/engine-loader.mjs'
import { MaitianConfig } from '../src/publish/maitian/config.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { preflightResult } from '../src/publish/maitian/contract.js'
import { component } from './helpers/maitian-component.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-operations-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const engineRef = await inspectEngine(await component(join(root, 'original')))
  const config = new MaitianConfig(join(root, 'config'))
  const portReservation = createServer()
  portReservation.listen(0, '127.0.0.1'); await once(portReservation, 'listening')
  const port = portReservation.address().port
  await new Promise(resolve => portReservation.close(resolve))
  await config.save({ enabled: true, source: 'local', localComponentDir: engineRef.dir, port })
  const options = config.resolve()
  const browser = { root: config.root, profileDir: options.profileDir, profileId: options.profileId, chromePath: options.chromePath, port: options.port }
  const journal = new BrowserOperations(config.root)
  const pages = new Map(), calls = [], launches = []
  let count = 0, closes = 0, mode = 'ready', instanceId = 'browser-a'
  const deps = {
    async launch(value) {
      launches.push(value)
      await assert.rejects(acquireProfileLock(value.profileDir, join(config.root, 'locks')), error => error.code === 'PROFILE_BUSY')
      return { websocketURL: 'ws://transport.invalid', instanceId }
    },
    async connect() {
      return {
        close() { closes++ },
        async send(method, params = {}) {
          calls.push({ method, params })
          if (method === 'Target.createTarget') {
            const targetId = `target-${++count}`
            pages.set(targetId, { targetId, type: 'page', url: params.url })
            return { targetId }
          }
          if (method === 'Target.getTargetInfo') {
            if (!pages.has(params.targetId)) throw Error('Page gone')
            return { targetInfo: pages.get(params.targetId) }
          }
          return {}
        },
      }
    },
    async load(_reference, chrome) {
      assert.equal(_reference.fingerprint, engineRef.fingerprint)
      return {
        bundle: { PLATFORMS: { xhs: { name: '小红书', fields: {} } }, validate() {} },
        publish: {
          ADAPTERS: { xhs: { url: 'https://example.invalid/upload', links: { url: 'https://example.invalid/manage' } } },
          async preflight(ids, opts) {
            assert.deepEqual(ids, ['xhs']); assert.deepEqual(opts, { keepTabs: true })
            const tab = await chrome.tabs.create({ url: 'https://example.invalid/upload' })
            const targetId = [...pages.keys()].at(-1)
            const records = await readdir(journal.root)
            const active = (await Promise.all(records.filter(file => file.endsWith('.json')).map(file => journal.read(file.slice(0, -5))))).find(row => row.targets.some(target => target.targetId === targetId))
            assert.ok(active, 'The original component sees a tab only after its exact target is persisted')
            if (mode === 'throw') throw Error('component failure')
            if (mode === 'malformed') return { xhs: { ok: 'yes' } }
            return { xhs: { ok: mode !== 'logged-out', ...(mode === 'logged-out' && { reason: '请扫码登录' }), tabId: tab.id, secret: 'not returned' } }
          },
          run() { assert.fail('No filling during browser setup or login check') },
          collectLinks() { assert.fail('No work collection during login check') },
        },
      }
    },
  }
  const run = (op, fields = {}) => browserOperation({ op, engineRef, browser, operationId: randomUUID(), platform: 'xhs', ...fields }, deps)
  return { root, config, browser, journal, run, engineRef, calls, launches, pages, get closes() { return closes }, set mode(value) { mode = value }, set instanceId(value) { instanceId = value } }
}

test('安装引导不依赖组件，页面 target 私有落盘；重连精确激活原页并保留窗口', async t => {
  const f = await fixture(t)
  const opened = await f.run('open-install', { engineRef: undefined, platform: undefined })
  assert.equal(opened.opened, 'extension-store')
  assert.equal(f.calls.find(call => call.method === 'Target.createTarget').params.url, STORE_URL)
  const record = await f.journal.read(opened.operationId)
  assert.equal(record.targets.length, 1)
  assert.equal(record.selectedTargetId, 'target-1')
  assert.equal((await stat(f.journal.file(opened.operationId))).mode & 0o777, 0o600)
  const reopened = await f.run('open-page', { engineRef: undefined, pageOperationId: opened.operationId })
  assert.equal(reopened.operationId, opened.operationId)
  assert.deepEqual(f.calls.at(-2), { method: 'Target.activateTarget', params: { targetId: 'target-1' } })
  assert.equal(f.launches.at(-1).existingOnly, true)
  assert.equal(f.calls.filter(call => call.method === 'Target.createTarget').length, 1)
  assert.equal(f.closes, 2)
  assert.equal(f.pages.size, 1)
  assert.equal(JSON.stringify(opened).includes(f.root), false)
  const lock = await acquireProfileLock(f.browser.profileDir, join(f.config.root, 'locks'))
  await lock.release()
})

test('登录入口来自原版 adapter，预检直接调用原版入口，不把登录当成身份核验', async t => {
  const f = await fixture(t)
  const opened = await f.run('open-login')
  assert.equal(opened.opened, 'platform-login')
  assert.equal(f.calls.find(call => call.method === 'Target.createTarget').params.url, 'https://example.invalid/upload')
  const result = await f.run('preflight')
  assert.equal(result.ok, true)
  assert.equal(result.accountVerification, 'login-only')
  assert.equal(result.canOpenPage, true)
  assert.equal(result.engineVersion, '1.0.0')
  assert.equal(Object.hasOwn(result, 'tabId'), false)
  assert.equal(JSON.stringify(result).includes('not returned'), false)
  assert.equal((await f.journal.read(result.operationId)).selectedTargetId, 'target-2')
  assert.equal((await inspectEngine(f.engineRef.dir)).fingerprint, f.engineRef.fingerprint)
  f.mode = 'logged-out'
  const loggedOut = await f.run('preflight')
  assert.equal(loggedOut.ok, false)
  assert.equal(loggedOut.reason, '请扫码登录')
  assert.equal(loggedOut.canOpenPage, true)
})

test('作品管理页直接使用原版 links.url，独立于原任务页面，不调用预检、上传或查询', async t => {
  const f = await fixture(t)
  const result = await f.run('open-management')
  assert.equal(result.opened, 'platform-management')
  assert.equal(f.calls.find(call => call.method === 'Target.createTarget').params.url, 'https://example.invalid/manage')
  const record = await f.journal.read(result.operationId)
  assert.equal(record.op, 'open-management')
  assert.equal(record.preflight, undefined)
  assert.equal(record.selectedTargetId, 'target-1')
})

test('不同实例或 profile 不认领同 URL 新页；组件异常后释放锁并保留原 target 线索', async t => {
  const f = await fixture(t)
  const opened = await f.run('open-login')
  f.instanceId = 'browser-b'
  await assert.rejects(f.run('open-page', { pageOperationId: opened.operationId }), error => error.code === 'BROWSER_CHANGED')
  const launches = f.launches.length
  await assert.rejects(f.run('open-page', { pageOperationId: opened.operationId, browser: { ...f.browser, profileId: 'different' } }), error => error.code === 'PROFILE_CHANGED')
  assert.equal(f.launches.length, launches)
  assert.equal(f.calls.filter(call => call.method === 'Target.createTarget').length, 1)
  f.mode = 'throw'
  await assert.rejects(f.run('preflight'), /component failure/)
  const records = await readdir(f.journal.root)
  const unfinished = (await Promise.all(records.map(file => f.journal.read(file.slice(0, -5))))).find(row => row.op === 'preflight')
  assert.equal(unfinished.completedAt, undefined)
  assert.equal(unfinished.targets.length, 1)
  f.mode = 'malformed'
  await assert.rejects(f.run('preflight'), error => error.code === 'INCOMPATIBLE_PREFLIGHT_RESULT')
  const lock = await acquireProfileLock(f.browser.profileDir, join(f.config.root, 'locks'))
  await lock.release()
  assert.ok(f.pages.size > 1)
})

test('同 profile 的预检、登录和配置变更互斥；未启用的配置不启动执行器', async t => {
  const f = await fixture(t)
  let runs = 0
  const service = new MaitianPublishing({}, { config: f.config, run: async () => { runs++; return {} } })
  const lock = await acquireProfileLock(f.browser.profileDir, join(f.config.root, 'locks'))
  await assert.rejects(f.run('open-install'), error => error.code === 'PROFILE_BUSY')
  await assert.rejects(service.save({ port: 9444 }), error => error.code === 'PROFILE_BUSY')
  assert.equal(f.launches.length, 0)
  await lock.release()
  await service.save({ enabled: false })
  await assert.rejects(service.browser('open-install'), error => error.code === 'BROWSER_DISABLED')
  assert.equal(runs, 0)
})

test('浏览器执行 IPC 无需引擎也能诊断启动失败；不接受客户端指定的任意操作', async t => {
  const f = await fixture(t)
  await assert.rejects(runComponent({ op: 'fill', browser: f.browser }), error => error.code === 'INVALID_TASK_REQUEST')
  await assert.rejects(runComponent({ op: 'open-install', operationId: randomUUID(), browser: { ...f.browser, chromePath: '/no-maitian-test-browser' } }), error => error.code === (process.platform === 'darwin' ? 'CHROME_START_FAILED' : 'UNSUPPORTED_OS'))
  const lock = await acquireProfileLock(f.browser.profileDir, join(f.config.root, 'locks'))
  await lock.release()
  assert.deepEqual(preflightResult({ xhs: { ok: true, tabId: 42, accountName: 'not an identity contract' } }, 'xhs'), { summary: { ok: true }, tabId: 42 })
  assert.throws(() => preflightResult({ xhs: { ok: true, tabId: '42' } }, 'xhs'), error => error.code === 'INCOMPATIBLE_PREFLIGHT_RESULT')
})

test('服务层每次平台操作重新发现并探测兼容新版；安装与原页恢复不依赖组件存在', async t => {
  const f = await fixture(t)
  const requests = []
  const service = new MaitianPublishing({}, { config: f.config, run: async input => {
    if (input.op === 'hello') return runComponent(input)
    requests.push(input)
    return { operationId: input.operationId, canOpenPage: true }
  } })
  await service.browser('open-login', { platform: 'xhs' })
  assert.equal(requests.at(-1).engineRef.version, '1.0.0')
  await component(f.engineRef.dir, '1.1.0', { limit: 8 })
  await service.browser('preflight', { platform: 'xhs' })
  assert.equal(requests.at(-1).engineRef.version, '1.1.0')
  assert.notEqual(requests.at(-1).engineRef.fingerprint, requests[0].engineRef.fingerprint)
  assert.equal(requests.at(-1).browser.profileDir, f.browser.profileDir)
  assert.equal(service.public().implementation.directFill, false)
  await rm(f.engineRef.dir, { recursive: true })
  await service.browser('open-install')
  assert.equal(requests.at(-1).engineRef, undefined)
  await service.browser('open-page', { operationId: requests[0].operationId })
  assert.equal(requests.at(-1).pageOperationId, requests[0].operationId)
  await assert.rejects(service.browser('open-login', { platform: 'xhs' }), error => error.code === 'COMPONENT_UNREADABLE')
})
