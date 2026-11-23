import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fillOperation } from '../src/publish/maitian/fill-operation.mjs'
import { BrowserOperations } from '../src/publish/maitian/browser-operations.js'
import { TaskControls } from '../src/publish/maitian/task-controls.js'
import { acquireProfileLock } from '../src/publish/maitian/profile-lock.js'
import { inspectEngine } from '../src/publish/maitian/engine-loader.mjs'
import { taskFixture } from './helpers/maitian-task.js'

async function fixture(t) {
  const f = await taskFixture(t), engineRef = await inspectEngine(f.original), options = f.config.resolve()
  const runId = randomUUID(), targets = [], events = []
  const journal = new BrowserOperations(f.config.root)
  let preflightTab, authorized = false, runs = 0, closed = false
  const request = { op: 'fill', taskId: f.record.taskId, runId, platform: 'xhs', engineRef, accountEpoch: 'initial',
    projectRef: { projectId: f.record.projectId, projectDigest: f.record.projectDigest, data: f.record.plan.data },
    browser: { root: f.config.root, profileDir: options.profileDir, profileId: 'default', chromePath: options.chromePath, port: options.port } }
  const deps = {
    async launch() {
      await assert.rejects(acquireProfileLock(options.profileDir, join(f.config.root, 'locks')), error => error.code === 'PROFILE_BUSY')
      return { instanceId: 'browser-a', websocketURL: 'ws://fixture.invalid' }
    },
    async connect() {
      return { close() { closed = true }, async send(method) {
        if (method === 'Target.createTarget') { const targetId = `target-${targets.length + 1}`; targets.push(targetId); return { targetId } }
        return {}
      } }
    },
    async load(_ref, chrome) {
      const publish = {
        ADAPTERS: { xhs: { url: 'https://example.invalid/upload', fill() { assert.fail('Must call original orchestration entry only') } } },
        async preflight(ids, opts) {
          assert.deepEqual(ids, ['xhs']); assert.deepEqual(opts, { keepTabs: true })
          preflightTab = await chrome.tabs.create({ url: 'https://example.invalid/upload' })
          assert.equal((await journal.read(runId)).targets.length, 1)
          return { xhs: { ok: true, tabId: preflightTab.id } }
        },
        async run(project, opts) {
          runs++
          assert.equal(authorized, true)
          assert.deepEqual(project, { dir: f.record.projectId, data: f.record.plan.data })
          assert.deepEqual(opts.platforms, ['xhs'])
          assert.deepEqual(await readFile(join(opts.rootPath, project.dir, project.data.video)), await readFile(new URL('../assets/v-ink.mp4', import.meta.url)))
          const tab = await chrome.tabs.create({ url: 'https://example.invalid/upload' })
          assert.equal((await journal.read(runId)).targets.length, 2)
          const state = { id: 'xhs', status: '填写中', failed: false, logs: [], tabId: tab.id }
          opts.onChange(state)
          state.status = '待你发布'
          opts.onChange(state)
          return { xhs: state }
        },
      }
      f.publish = publish
      return { bundle: { PLATFORMS: { xhs: { fields: {} } }, validate(data, files) {
        assert.deepEqual(data, f.record.plan.data)
        assert.ok(files instanceof Set && files.has(data.video))
        return { errors: [], warnings: ['来自原版校验'] }
      } }, publish }
    },
  }
  const callbacks = { authorize: async () => { authorized = true }, emit: async (type, event) => events.push({ type, ...event }) }
  return { ...f, request, deps, callbacks, journal, targets, events, get runs() { return runs }, get closed() { return closed } }
}

test('原版 run 接收固定工程与完整 options；目标先落盘，填好不等于已发布且保留页面', async t => {
  const f = await fixture(t)
  const result = await fillOperation(f.request, f.callbacks, f.deps)
  assert.equal(result.filled, true)
  assert.equal(result.state.status, '待你发布')
  assert.equal(result.operationId, f.request.runId)
  assert.deepEqual(result.warnings, ['来自原版校验'])
  assert.equal(f.runs, 1)
  assert.equal(f.closed, true)
  assert.equal(f.targets.length, 2)
  assert.equal(f.events.length, 2)
  assert.equal(f.events[0].state.status, '填写中', 'Progress snapshots must not change with later upstream mutations')
  const journal = await f.journal.read(f.request.runId)
  assert.equal(journal.selectedTargetId, 'target-2')
  assert.ok(journal.enteredRunAt)
  assert.ok(journal.completedAt)
  assert.ok(journal.targets.every(target => target.taskId === f.request.taskId && target.runId === f.request.runId))
  assert.equal((await inspectEngine(f.original)).fingerprint, f.request.engineRef.fingerprint)
})

test('执行授权前后都重新核对原版和固定字节，变化时不进入 run', async t => {
  for (const change of ['engine', 'project']) {
    const f = await fixture(t)
    f.callbacks.authorize = async () => {
      if (change === 'engine') await writeFile(join(f.original, 'lib/init.js'), 'export const changed = true')
      else await writeFile(join(f.config.root, 'runs', f.record.projectId, 'video.mp4'), 'changed')
    }
    await assert.rejects(fillOperation(f.request, f.callbacks, f.deps), error => ['COMPONENT_CHANGED', 'PROJECT_CHANGED'].includes(error.code))
    assert.equal(f.runs, 0)
    assert.equal((await f.journal.read(f.request.runId)).enteredRunAt, undefined)
    const lock = await acquireProfileLock(f.request.browser.profileDir, join(f.config.root, 'locks')); await lock.release()
  }
})

test('原版 run 首条页面回调前中断，不把单独的登录预检页误认作原填写页', async t => {
  const f = await fixture(t), original = f.deps.load
  f.deps.load = async (...args) => {
    const engine = await original(...args)
    engine.publish.run = async () => { throw Error('Exit before the first tab callback') }
    return engine
  }
  await assert.rejects(fillOperation(f.request, f.callbacks, f.deps), /first tab callback/)
  const record = await f.journal.read(f.request.runId)
  assert.equal(record.preflightTargetId, 'target-1')
  assert.equal(record.selectedTargetId, undefined)
  assert.ok(record.enteredRunAt)
})

test('上游校验或预检失败不会请求执行授权，不绕过校验错误或新增平台抓取', async t => {
  for (const failure of ['validation', 'login']) {
    const f = await fixture(t), originalLoad = f.deps.load
    let authorizations = 0
    f.callbacks.authorize = async () => { authorizations++ }
    f.deps.load = async (...args) => {
      const engine = await originalLoad(...args)
      if (failure === 'validation') engine.bundle.validate = () => ({ errors: ['原版硬错误'], warnings: [] })
      else engine.publish.preflight = async () => ({ xhs: { ok: false, reason: '登录过期' } })
      return engine
    }
    await assert.rejects(fillOperation(f.request, f.callbacks, f.deps), error => error.code === (failure === 'validation' ? 'UPSTREAM_VALIDATION' : 'PREFLIGHT_FAILED'))
    assert.equal(authorizations, 0); assert.equal(f.runs, 0)
  }
})

test('协作停止只经 shouldStop 交给原版，当前步骤返回后才退出并留下目标线索', { timeout: 5000 }, async t => {
  const f = await fixture(t), originalLoad = f.deps.load
  let entered, release
  const began = new Promise(resolve => { entered = resolve })
  const allowReturn = new Promise(resolve => { release = resolve })
  f.deps.load = async (...args) => {
    const engine = await originalLoad(...args)
    engine.publish.run = async (_project, options) => {
      entered()
      while (!options.shouldStop()) await new Promise(resolve => setTimeout(resolve, 25))
      await allowReturn
      return { xhs: { id: 'xhs', status: '已停止', failed: false, logs: [], tabId: null } }
    }
    return engine
  }
  let settled = false
  const running = fillOperation(f.request, f.callbacks, f.deps).finally(() => { settled = true })
  const rejected = assert.rejects(running, error => error.code === 'RUNNER_CANCELLED')
  await began
  await new TaskControls(f.config.root).cancel(f.request.taskId, f.request.runId)
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(settled, false)
  await assert.rejects(acquireProfileLock(f.request.browser.profileDir, join(f.config.root, 'locks')), error => error.code === 'PROFILE_BUSY')
  release(); await rejected
  assert.equal(f.closed, true)
  const journal = await f.journal.read(f.request.runId)
  assert.ok(journal.enteredRunAt)
  assert.equal(journal.completedAt, undefined)
  assert.equal(journal.targets.length, 1)
})
