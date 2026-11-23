import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Publishing } from '../src/publish/service.js'
import { blocksDuplicate, blocksStorageSwitch, executingRecord, readPublishRecords, writePublishRecords } from '../src/publish/records.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { MaitianError } from '../src/publish/maitian/errors.js'
import { BrowserOperations } from '../src/publish/maitian/browser-operations.js'
import { TaskControls } from '../src/publish/maitian/task-controls.js'
import { processIdentity } from '../src/publish/maitian/profile-lock.js'
import { recoverBrowserRecords } from '../src/publish/maitian/tasks.js'
import { taskFixture } from './helpers/maitian-task.js'
import { route } from '../src/host.js'

const state = (status = '待你发布', failed = false) => ({ id: 'xhs', status, failed, logs: [], tabId: 1000 })
const current = async f => (await readPublishRecords(f.store.root)).find(row => row.taskId === f.prepared.taskId)
const wait = async service => { await Promise.all([...service.executions.values()]) }

test('服务端默认拒绝直接填写且不调用执行器', async t => {
  const f = await taskFixture(t)
  const service = new MaitianPublishing(f.store, { config: f.config, run: () => assert.fail('direct fill must be disabled') })
  assert.equal(service.public().implementation.directFill, false)
  await assert.rejects(service.start(f.request), error => error.code === 'DIRECT_FILL_DISABLED')
  assert.equal(service.executions.size, 0)
  assert.equal((await current(f)).status, 'prepared')
})

test('填写先持久化执行意图，进度属于当前 run；完成仅待人工发布，固定文件继续保留', async t => {
  const f = await taskFixture(t)
  let runs = 0
  f.service.run = async input => {
    runs++
    assert.equal(input.op, 'fill')
    await input.onSpawn({ pid: process.pid })
    assert.equal((await current(f)).executionIntentAt, undefined)
    await input.onReady()
    const intent = await current(f)
    assert.ok(intent.executionIntentAt)
    assert.equal(intent.runId, input.runId)
    assert.equal(intent.lease.stoppedAt, undefined)
    await input.onEvent({ type: 'progress', seq: 4, state: state('上传中') })
    assert.equal((await current(f)).status, 'uploading')
    await new BrowserOperations(f.config.root).write({ version: 1, operationId: input.runId, profileDir: input.browser.profileDir, targets: [{ targetId: 'exact-target', browserInstanceId: 'browser-a' }], selectedTargetId: 'exact-target' })
    return { state: state(), filled: true }
  }
  const queued = await f.service.start(f.request)
  assert.equal(queued.status, 'queued')
  await wait(f.service)
  const record = await current(f)
  assert.equal(record.status, 'awaiting_user')
  assert.ok(record.lease.stoppedAt)
  assert.equal(record.pageOperationId, record.runId)
  assert.equal(executingRecord(record), false)
  assert.equal(blocksDuplicate(record), true)
  assert.equal(blocksStorageSwitch(record), true)
  assert.ok((await readdir(join(f.config.root, 'runs', record.projectId))).includes('publish.json'))
  const repeated = await f.service.start(f.request)
  assert.equal(repeated.status, 'awaiting_user')
  assert.equal(runs, 1)
  const status = await new Publishing(f.store, { resolvePlatform: () => null }).status('piece')
  assert.equal(status.jobs[0].executionActive, false)
  assert.equal(status.lockedPlatforms.xhs, true)
  assert.equal(JSON.stringify(status).includes(f.root), false)
})

test('组件、配置、修订、固定字节或源素材变化，开始前拒绝且不调用填写', async t => {
  for (const change of ['config', 'revision', 'fixed', 'source', 'engine']) {
    const f = await taskFixture(t)
    let runs = 0
    f.service.run = () => { runs++; assert.fail('Must re-prepare before starting') }
    if (change === 'config') await f.config.save({ port: 9444 })
    if (change === 'revision') await f.assets.save('piece', f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, title: '改稿' } })
    if (change === 'fixed') await writeFile(join(f.config.root, 'runs', f.record.projectId, 'video.mp4'), 'changed')
    if (change === 'source') {
      const files = await readdir(join(f.store.root, '内容', 'piece', '素材'))
      await writeFile(join(f.store.root, '内容', 'piece', '素材', files[0]), 'changed')
    }
    if (change === 'engine') await writeFile(join(f.original, 'lib/init.js'), 'export const changed = true')
    await assert.rejects(f.service.start(f.request))
    assert.equal(runs, 0)
    assert.equal((await current(f)).status, 'prepared')
    assert.equal((await current(f)).executionIntentAt, undefined)
  }
})

test('同工作区双 Host 确认只领取一次；其他通道的迟到记录阻断填写授权', async t => {
  const f = await taskFixture(t)
  let release, entered
  const called = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const run = async input => {
    await input.onSpawn({ pid: process.pid }); entered()
    await held
    await input.onReady()
    return { state: state() }
  }
  const second = new MaitianPublishing(f.store, { config: f.config, run, directFillEnabled: true })
  f.service.run = run
  const claimed = await Promise.all([f.service.start(f.request), second.start(f.request)])
  await called
  assert.equal(f.service.executions.size + second.executions.size, 1)
  assert.ok(claimed.every(row => row.taskId === f.prepared.taskId))
  await f.store.run(async () => {
    const records = await readPublishRecords(f.store.root)
    records.push({ provider: 'api', itemId: 'piece', platform: 'xhs', status: 'unknown' })
    await writePublishRecords(f.store.root, records)
  })
  release()
  await wait(f.service); await wait(second)
  assert.equal((await current(f)).status, 'failed')
  assert.equal((await current(f)).executionIntentAt, undefined)
  assert.equal(blocksDuplicate(await current(f)), false)
})

test('原版失败标志、未知新状态和发送后失联均保守为 unknown，不允许再次上传', async t => {
  for (const mode of ['failed-state', 'new-state', 'disconnect', 'malformed-result']) {
    const f = await taskFixture(t)
    let runs = 0
    f.service.run = async input => {
      runs++
      await input.onSpawn({ pid: process.pid }); await input.onReady()
      if (mode === 'disconnect') throw new MaitianError('RUNNER_EXITED', 'test disconnect')
      if (mode === 'malformed-result') return { state: { status: 'invalid' } }
      return { state: mode === 'failed-state' ? state('待你发布', true) : state('新版未识别状态') }
    }
    await f.service.start(f.request); await wait(f.service)
    const record = await current(f)
    assert.equal(record.status, 'unknown')
    assert.ok(record.executionIntentAt)
    assert.ok(record.lease.stoppedAt)
    assert.equal(blocksDuplicate(record), true)
    await f.service.start(f.request)
    assert.equal(runs, 1)
  }
})

test('本地填写保护时限绑定确认单，超时保留活跃租约直到执行器关闭并阻止重投', async t => {
  const f = await taskFixture(t)
  assert.equal(f.prepared.limits.fillTimeoutMinutes, 360)
  let runs = 0
  f.service.run = async input => {
    runs++
    assert.equal(input.timeoutMs, 360 * 60_000)
    await input.onSpawn({ pid: process.pid }); await input.onReady(); await input.onTimeout()
    const during = await current(f)
    assert.ok(during.protectionTimedOutAt)
    assert.ok(during.cancelRequestedAt)
    assert.equal(executingRecord(during), true)
    assert.equal(blocksDuplicate(during), true)
    assert.equal(during.lease.stoppedAt, undefined)
    assert.equal(await new TaskControls(f.config.root).cancelled(during.taskId, during.runId), true)
    throw new MaitianError('RUNNER_TIMEOUT', '已达到本地填写保护时限')
  }
  await f.service.start(f.request); await wait(f.service)
  const record = await current(f)
  assert.equal(record.status, 'unknown')
  assert.ok(record.lease.stoppedAt)
  assert.equal(record.error.code, 'RUNNER_TIMEOUT')
  assert.equal(blocksDuplicate(record), true)
  await f.service.start(f.request)
  assert.equal(runs, 1)
  const changed = await taskFixture(t)
  await changed.config.save({ fillTimeoutMinutes: 480 })
  await assert.rejects(changed.service.start(changed.request), error => error.code === 'CONFIG_CHANGED')
})

test('跨 Host 取消不抢浏览器锁，进程未退出前持续活跃；停止后仍保留上传防重', async t => {
  const f = await taskFixture(t)
  let entered, release
  const called = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  f.service.run = async input => {
    await input.onSpawn({ pid: process.pid }); await input.onReady(); entered()
    await held
    assert.equal(await new TaskControls(f.config.root).cancelled(input.taskId, input.runId), true)
    return { state: state() }
  }
  await f.service.start(f.request); await called
  const second = new MaitianPublishing(f.store, { config: f.config })
  const pending = await second.cancel({ id: 'piece', taskId: f.prepared.taskId })
  assert.equal(pending.cancelRequested, true)
  assert.equal(pending.executionActive, true)
  assert.equal((await current(f)).lease.stoppedAt, undefined)
  release(); await wait(f.service)
  const record = await current(f)
  assert.equal(record.status, 'unknown')
  assert.ok(record.lease.stoppedAt)
  assert.equal(blocksDuplicate(record), true)
})

test('真实 runner 存活时租约过期或 Host 已退出不能解锁；确认两个进程均退出才完成恢复', async t => {
  const f = await taskFixture(t)
  const runner = fork(new URL('./helpers/publish-activity-owner.mjs', import.meta.url), [join(f.root, 'child-workspace')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(() => { if (runner.exitCode === null) runner.kill('SIGKILL') })
  await once(runner, 'message')
  const runnerIdentity = await processIdentity(runner.pid)
  const record = { ...f.record, status: 'uploading', executionIntentAt: new Date().toISOString(), runId: f.prepared.taskId,
    lease: { owner: { pid: process.pid, identity: 'different-start-identity' }, runner: { pid: runner.pid, identity: runnerIdentity }, expiresAt: 1 } }
  assert.equal(await recoverBrowserRecords([record]), true)
  assert.equal(record.status, 'unknown')
  assert.equal(record.lease.stoppedAt, undefined)
  assert.equal(executingRecord(record), true)
  assert.equal(await recoverBrowserRecords([record]), false)
  const closed = once(runner, 'close'); runner.kill('SIGTERM'); await closed
  assert.equal(await recoverBrowserRecords([record]), true)
  assert.ok(record.lease.stoppedAt)
  assert.equal(record.status, 'unknown')
  assert.equal(executingRecord(record), false)
  assert.equal(blocksDuplicate(record), true)
})

test('真实 HTTP 开始需同源明确确认和摘要，取消响应不声称停止；前端拿不到私有执行参数', async t => {
  const f = await taskFixture(t)
  let entered, release
  const began = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  f.service.run = async input => {
    await input.onSpawn({ pid: process.pid }); await input.onReady(); entered()
    await held
    return { state: state() }
  }
  const desk = { maitianPublishing: f.service }
  const server = createServer((req, res) => route({}, f.store, desk, req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/media-desk/publish/maitian/`
  const post = (op, body, site = 'same-origin') => fetch(base + op, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: JSON.stringify(body) })
  assert.equal((await post('start', f.request, 'cross-site')).status, 403)
  assert.equal((await post('start', { ...f.request, profileDir: '/arbitrary' })).status, 400)
  assert.equal((await post('start', { ...f.request, confirmed: false })).status, 400)
  assert.equal((await post('start', { ...f.request, projectDigest: 'f'.repeat(64) })).status, 409)
  const started = await post('start', f.request)
  assert.equal(started.status, 202)
  assert.equal(JSON.stringify(await started.json()).includes(f.root), false)
  await began
  const stopped = await post('cancel', { id: 'piece', taskId: f.prepared.taskId })
  assert.equal(stopped.status, 200)
  const body = await stopped.json()
  assert.equal(body.job.cancelRequested, true)
  assert.equal(body.job.executionActive, true)
  release(); await wait(f.service)
  assert.equal((await current(f)).status, 'unknown')
})
