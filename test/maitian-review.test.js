import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { route } from '../src/host.js'
import { Store } from '../src/store.js'
import { Publishing } from '../src/publish/service.js'
import { blocksDuplicate, blocksStorageSwitch, executingRecord, readPublishRecords, writePublishRecords } from '../src/publish/records.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { processIdentity } from '../src/publish/maitian/profile-lock.js'
import { recoverBrowserRecords } from '../src/publish/maitian/tasks.js'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { component } from './helpers/maitian-component.js'
import { completedTaskFixture } from './helpers/maitian-task.js'

const current = async f => (await readPublishRecords(f.store.root)).find(row => row.taskId === f.record.taskId)
const save = (f, mutate) => f.store.run(async () => {
  const records = await readPublishRecords(f.store.root); mutate(records[0], records); await writePublishRecords(f.store.root, records)
})
const manual = (f, extra = {}) => ({ id: 'piece', taskId: f.record.taskId, actor: '测试核对者', reason: '在原平台核对了对应作品与账号', confirmed: true, ...extra })
function runner(f, result) {
  const calls = []
  f.service.run = async input => {
    calls.push(input)
    if (input.op === 'hello') return runComponent(input)
    assert.equal(input.op, 'collect-links')
    assert.deepEqual(input.projectRef.data, f.record.plan.data)
    assert.ok((await current(f)).reviewLease.runId)
    return { result }
  }
  return calls
}

test('原版查询首次结果只记候选，人工关联后同 ID 才更新；重启后证据和防重保留', async t => {
  const f = await completedTaskFixture(t)
  const calls = runner(f, { status: '审核中', workId: 'work-a', url: 'https://www.xiaohongshu.com/explore/work-a' })
  const first = await f.service.review(f.query)
  assert.equal(first.status, 'awaiting_user')
  assert.equal(first.lastReview.needsConfirmation, true)
  assert.equal(first.lastReview.source, 'maitian-query')
  assert.ok((await current(f)).reviewLease.stoppedAt)
  assert.equal(first.executionActive, false)
  assert.equal(JSON.stringify(first).includes(f.root), false)
  assert.equal(Object.hasOwn(first.lastReview.result, 'candidateCount'), false)
  await f.service.reconcile(manual(f, { action: 'associate', platformChecked: true, reviewId: first.lastReview.reviewId, evidence: { status: 'pending_review', workId: 'work-a', url: first.lastReview.result.url } }))
  assert.equal((await current(f)).evidenceSource, 'manual-confirmed')
  runner(f, { status: '已发布', workId: 'work-a', url: 'https://www.xiaohongshu.com/explore/work-a' })
  const next = await f.service.review(f.query)
  assert.equal(next.status, 'published')
  assert.equal(next.evidenceSource, 'upstream-matched-id')
  assert.equal(next.lastReview.matchedAssociatedId, true)
  const restarted = new Publishing(new Store(f.store.root), { resolvePlatform: () => null })
  const status = await restarted.status('piece')
  assert.equal(status.jobs[0].association.workId, 'work-a')
  assert.equal(status.lockedPlatforms.xhs, true)
  assert.equal(calls.filter(call => call.op === 'collect-links').length, 1)
})

test('恢复查询使用保存的旧工程，不受确认单/预约过期、源稿改动和快照释放影响；兼容新版自动采用', async t => {
  const f = await completedTaskFixture(t)
  await save(f, record => { record.expiresAt = 1; record.plan.data.schedule = '2020-01-01T00:00:00.000Z' })
  f.record = await current(f)
  await rm(join(f.config.root, 'runs', f.record.projectId), { recursive: true })
  await f.assets.save('piece', f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, title: '后来修改的标题' } })
  await component(f.original, '1.1.0', { limit: 1, fill: false })
  const calls = runner(f, { status: '未找到', url: '', note: '仍需在平台核对' })
  const job = await f.service.review(f.query)
  assert.equal(job.status, 'awaiting_user')
  assert.equal(job.lastReview.engineVersion, '1.1.0')
  assert.deepEqual(calls.map(call => call.op), ['hello', 'collect-links'])
  assert.equal(blocksDuplicate(await current(f)), true)
})

test('查询失败、无结果、不同 ID 和异常字段不覆盖人工已确认状态，也不解除防重', async t => {
  const f = await completedTaskFixture(t)
  await f.service.reconcile(manual(f, { action: 'associate', platformChecked: true, evidence: { status: 'published', workId: 'work-a' } }))
  for (const result of [{ status: '未找到', url: '' }, { status: '审核中', workId: 'different-work' }, { status: '已发布', workId: 'work-a', url: 'javascript:alert(1)' }, { status: 'new-status', workId: 'work-a' }, {}]) {
    runner(f, result)
    const job = await f.service.review(f.query)
    assert.equal(job.status, 'published')
    assert.equal(blocksDuplicate(await current(f)), true)
    assert.equal(job.executionActive, false)
  }
  assert.ok((await current(f)).reviewError)
})

test('查询要求原账号人工确认与原 profile；同任务双 Host 查询互斥，查询期间阻止目录切换', async t => {
  const f = await completedTaskFixture(t)
  runner(f, { status: '未找到' })
  await assert.rejects(f.service.review({ ...f.query, account: { ...f.query.account, confirmed: false } }), error => error.code === 'ACCOUNT_CONFIRMATION_REQUIRED')
  await assert.rejects(f.service.review({ ...f.query, account: { ...f.query.account, label: '另一个账号' } }), error => error.code === 'ACCOUNT_CHANGED')
  await f.config.save({ profileId: 'other' })
  await assert.rejects(f.service.review(f.query), error => error.code === 'ACCOUNT_CHANGED')
  await f.config.save({ profileId: 'default' })
  let entered, release
  const began = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const run = f.service.run
  f.service.run = async input => {
    if (input.op !== 'collect-links') return run(input)
    entered(); await held; return { result: { status: '未找到' } }
  }
  const pending = f.service.review(f.query)
  await began
  const during = await current(f)
  assert.equal(executingRecord(during), true)
  assert.equal(blocksStorageSwitch(during), true)
  const second = new MaitianPublishing(new Store(f.store.root), { config: f.config })
  await assert.rejects(second.review(f.query), error => error.code === 'TASK_BUSY')
  await assert.rejects(second.reconcile(manual(f, { action: 'confirmed-not-submitted', automationStopped: true, residualsCleared: true, platformChecked: true, originalPageChecked: true })), error => error.code === 'TASK_BUSY')
  release(); await pending
  assert.equal(executingRecord(await current(f)), false)
})

test('人工核对需要充分确认；未提交核对可允许重新准备，已有提交证据不能冒充未提交', async t => {
  const f = await completedTaskFixture(t)
  const request = manual(f, { action: 'confirmed-not-submitted', automationStopped: true, residualsCleared: true, platformChecked: true, originalPageChecked: true })
  for (const field of ['automationStopped', 'residualsCleared', 'platformChecked', 'originalPageChecked']) await assert.rejects(f.service.reconcile({ ...request, [field]: false }), error => error.code === 'RECONCILIATION_REQUIRED')
  await assert.rejects(f.service.reconcile({ ...request, actor: '' }), error => error.code === 'RECONCILIATION_REQUIRED')
  const job = await f.service.reconcile(request)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.resolved, true)
  assert.equal(blocksDuplicate(await current(f)), false)
  assert.equal((await current(f)).resolution.residualsCleared, true)
  await assert.rejects(f.service.review(f.query), error => error.code === 'TASK_BUSY')
  const second = await completedTaskFixture(t)
  await second.service.reconcile(manual(second, { action: 'associate', platformChecked: true, evidence: { status: 'published' } }))
  await assert.rejects(second.service.reconcile({ ...request, taskId: second.record.taskId }), error => error.code === 'EXISTING_PUBLICATION')
})

test('视频号无 URL 也可人工关联；实际预约时间单独核对并提示与计划不一致', async t => {
  const f = await completedTaskFixture(t)
  await save(f, record => { record.platform = 'channels'; record.plan.data.schedule = '2026-12-01T10:00:00.000Z' })
  const job = await f.service.reconcile(manual(f, { action: 'associate', platformChecked: true,
    evidence: { status: 'scheduled', url: null, actualWhen: '2026-12-01T19:00', actualTimezone: 'Asia/Shanghai' } }))
  assert.equal(job.status, 'scheduled')
  assert.equal(job.url, null)
  assert.equal(job.association.actualScheduleAt, '2026-12-01T11:00:00.000Z')
  assert.equal(job.association.scheduleMismatch, true)
  assert.equal(job.association.scheduleVerification, 'manual-confirmed')
  assert.equal(blocksDuplicate(await current(f)), true)
})

test('归档先核实停止与页面处理，再实际释放快照；未知状态与防重保留，目录阻塞可解除', async t => {
  const f = await completedTaskFixture(t)
  await save(f, record => { record.status = 'unknown' })
  const request = manual(f, { action: 'archive', automationStopped: true, pagesResolved: true, snapshotReleaseConfirmed: true })
  await assert.rejects(f.service.reconcile({ ...request, pagesResolved: false }), error => error.code === 'RECONCILIATION_REQUIRED')
  const job = await f.service.reconcile(request)
  const record = await current(f)
  assert.equal(job.status, 'unknown')
  assert.ok(job.archivedAt)
  assert.equal(record.archive.snapshotReleased, true)
  await assert.rejects(readdir(join(f.config.root, 'runs', record.projectId)), { code: 'ENOENT' })
  assert.equal(blocksDuplicate(record), true)
  assert.equal(blocksStorageSwitch(record), false)
  assert.ok(record.plan.data.video)
  assert.equal(job.canLocatePage, false)
  assert.equal(record.reconciliations[0].action, 'archive')
  assert.equal(record.reconciliations[0].phase, 'released')
  assert.ok((await readdir(join(f.store.root, '内容', 'piece', '素材'))).length > 0, 'Original draft assets are retained')
  runner(f, { status: '未找到' })
  assert.equal((await f.service.review(f.query)).status, 'unknown', 'Archived result queries do not need discarded snapshot files')
})

test('快照归属缺失或真实自动进程存活时拒绝归档，不用人工勾选绕过', async t => {
  const f = await completedTaskFixture(t)
  const request = manual(f, { action: 'archive', automationStopped: true, pagesResolved: true, snapshotReleaseConfirmed: true })
  await rm(join(f.config.root, 'runs', f.record.projectId, 'media-desk-manifest.json'))
  await assert.rejects(f.service.reconcile(request), error => error.code === 'SNAPSHOT_RELEASE_FAILED')
  assert.equal((await current(f)).archivedAt, undefined)
  assert.equal((await current(f)).reconciliations[0].phase, 'release-pending')
  assert.ok((await readdir(join(f.config.root, 'runs', f.record.projectId))).includes('video.mp4'))
  const runner = fork(new URL('./helpers/publish-activity-owner.mjs', import.meta.url), [join(f.root, 'child-workspace')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(() => { if (runner.exitCode === null) runner.kill('SIGKILL') })
  await once(runner, 'message')
  const identity = await processIdentity(runner.pid)
  await save(f, record => { record.lease.runner = { pid: runner.pid, identity } })
  await assert.rejects(f.service.reconcile(request), error => error.code === 'TASK_BUSY')
  const closed = once(runner, 'close'); runner.kill('SIGTERM'); await closed
})

test('查询租约恢复不改变已发布结果；存活查询进程不会仅因心跳超时被解锁', async t => {
  const f = await completedTaskFixture(t)
  const runner = fork(new URL('./helpers/publish-activity-owner.mjs', import.meta.url), [join(f.root, 'child-workspace')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(() => { if (runner.exitCode === null) runner.kill('SIGKILL') })
  await once(runner, 'message')
  const record = { ...f.record, status: 'published', reviewLease: { runId: randomUUID(), owner: { pid: process.pid, identity: 'previous-start' }, runner: { pid: runner.pid, identity: await processIdentity(runner.pid) }, expiresAt: 1 } }
  assert.equal(await recoverBrowserRecords([record]), true)
  assert.equal(record.status, 'published')
  assert.equal(executingRecord(record), true)
  const closed = once(runner, 'close'); runner.kill('SIGTERM'); await closed
  assert.equal(await recoverBrowserRecords([record]), true)
  assert.equal(record.status, 'published')
  assert.equal(executingRecord(record), false)
  assert.equal(blocksDuplicate(record), true)
})

test('任务原页打开只由 Host 解析引用，原组件删除仍可恢复；管理页与原页入口区分', async t => {
  const f = await completedTaskFixture(t), calls = []
  const run = f.service.run
  f.service.run = async input => {
    if (input.op === 'hello') return run(input)
    calls.push(input)
    return { operationId: input.operationId, canOpenPage: true, opened: input.op === 'open-management' ? 'platform-management' : undefined }
  }
  await rm(f.original, { recursive: true })
  assert.deepEqual(await f.service.openTaskPage({ id: 'piece', taskId: f.record.taskId }), { canOpenPage: true })
  assert.equal(calls[0].pageOperationId, f.record.runId)
  assert.equal(calls[0].engineRef, undefined)
  assert.equal(JSON.stringify(await f.service.openTaskPage({ id: 'piece', taskId: f.record.taskId })).includes(f.root), false)
  await assert.rejects(f.service.openManagement({ id: 'piece', taskId: f.record.taskId }), error => error.code === 'COMPONENT_UNREADABLE')
})

test('HTTP 查询、关联和任务原页操作保持同源与严格字段，不由客户端指定路径或 target', async t => {
  const f = await completedTaskFixture(t)
  runner(f, { status: '已发布', workId: 'work-a', url: 'https://www.xiaohongshu.com/explore/work-a' })
  const server = createServer((req, res) => route({}, f.store, { maitianPublishing: f.service }, req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/media-desk/publish/maitian/`
  const post = (op, body, site = 'same-origin') => fetch(base + op, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: JSON.stringify(body) })
  assert.equal((await post('review', f.query, 'cross-site')).status, 403)
  assert.equal((await post('review', { ...f.query, projectRef: '/arbitrary' })).status, 400)
  assert.equal((await post('open-page', { id: 'piece', taskId: f.record.taskId, operationId: f.record.runId })).status, 400)
  assert.equal((await post('open-management', { id: 'piece', taskId: f.record.taskId, url: 'https://evil.invalid' })).status, 400)
  assert.equal((await post('reconcile', manual(f, { action: '__proto__' }))).status, 400)
  const reviewed = await post('review', f.query)
  assert.equal(reviewed.status, 200)
  const body = await reviewed.json()
  assert.equal(body.job.status, 'awaiting_user')
  assert.equal(JSON.stringify(body).includes(f.root), false)
  const association = manual(f, { action: 'associate', platformChecked: true, reviewId: body.job.lastReview.reviewId, evidence: { status: 'published', workId: 'work-a' } })
  assert.equal((await post('reconcile', { ...association, evidence: { ...association.evidence, cookie: 'secret' } })).status, 400)
  const associated = await post('reconcile', association)
  assert.equal(associated.status, 200)
  assert.equal((await associated.json()).job.evidenceSource, 'manual-confirmed')
})
