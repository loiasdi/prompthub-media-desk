import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Publishing } from '../src/publish/service.js'
import { apiRecordDigest } from '../src/publish/api-recovery.js'
import { blocksDuplicate, migratePublishRecords, readPublishRecords, writePublishRecords } from '../src/publish/records.js'
import { withPublishActivity } from '../src/publish/activity.js'
import { route } from '../src/host.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-api-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'workspace'))
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '恢复核对', platform: 'YouTube' }] }, { undoable: false })
  const record = { itemId: 'piece', taskId: randomUUID(), platform: 'youtube', status: 'publishing', deadline: Date.now() - 1000, startedAt: '2026-11-20T00:00:00.000Z',
    submissionStarted: true, receiptId: 'receipt-kept', workId: 'work-kept', coverResult: { status: 'pending' },
    plan: { draft: { title: '原题目', privacyStatus: 'private' }, account: { id: 'original-account', name: '原账号' } } }
  await store.run(() => writePublishRecords(store.root, [record]))
  const publishing = new Publishing(store, { resolvePlatform: () => null })
  const request = { id: 'piece', taskId: record.taskId, recordDigest: apiRecordDigest(record), actor: '核对者', reason: '已退出旧 Host，在原账号检查后仍需确认最终结果', confirmed: true, oldHostsStopped: true, platformChecked: true }
  const file = join(store.root, '.publish-records.json')
  return { root, store, record, publishing, request, file }
}
const rows = f => readPublishRecords(f.store.root)
const backupFiles = async f => (await readdir(f.store.root)).filter(name => name.includes('.recovery-') && name.endsWith('.backup.json'))

test('API 中断核对保存原字节备份与审计，状态持久化 unknown，保留原回执及防重后可升级 v2', async t => {
  const f = await fixture(t), original = await readFile(f.file)
  await assert.rejects(f.store.run(() => migratePublishRecords(f.store.root)), /旧投稿尚未完成核对/)
  const status = await f.publishing.status('piece')
  assert.equal(status.jobs[0].status, 'unknown')
  assert.equal(status.jobs[0].canRecoverInterrupted, true)
  assert.equal(status.jobs[0].recoveryRecordDigest, f.request.recordDigest)
  const job = await f.publishing.recoverInterrupted(f.request)
  assert.equal(job.status, 'unknown')
  assert.equal(job.canRecoverInterrupted, undefined)
  assert.equal(job.interruptionRecovery.actor, '核对者')
  const [record] = await rows(f), audit = record.interruptionRecovery
  assert.equal(audit.oldHostsStopped, true); assert.equal(audit.platformChecked, true)
  assert.equal(audit.sourceRecordDigest, f.request.recordDigest)
  assert.equal(audit.sourceDigest, createHash('sha256').update(original).digest('hex'))
  assert.deepEqual(await readFile(join(f.store.root, audit.backupFile)), original)
  assert.equal((await lstat(join(f.store.root, audit.backupFile))).mode & 0o777, 0o600)
  assert.equal(record.receiptId, f.record.receiptId)
  assert.equal(record.workId, f.record.workId)
  assert.equal(record.submissionStarted, true)
  assert.deepEqual(record.coverResult, { status: 'pending' })
  assert.deepEqual(record.plan, f.record.plan)
  assert.equal(blocksDuplicate(record), true)
  assert.equal(JSON.parse(await readFile(f.file)).version, 1)
  assert.equal(JSON.stringify(job).includes('backup'), false)
  assert.equal(JSON.stringify(job).includes(f.root), false)
  await f.store.run(() => migratePublishRecords(f.store.root))
  const disk = JSON.parse(await readFile(f.file))
  assert.equal(disk.version, 2)
  assert.deepEqual(disk.records[0], { ...record, provider: 'api' })
  assert.equal((await f.publishing.status('piece')).lockedPlatforms.youtube, true)
  await assert.rejects(f.publishing.updateClaim(record.taskId, row => { row.status = 'failed' }), /状态已改变/)
  assert.equal((await rows(f))[0].status, 'unknown')
})

test('缺确认、异常字段、伪造路径/状态和旧摘要被拒绝；校验失败不建立备份', async t => {
  const f = await fixture(t), original = await readFile(f.file)
  for (const patch of [{ oldHostsStopped: false }, { platformChecked: false }, { confirmed: false }, { actor: '' }, { reason: 'a\nline' }, { id: 123 }, { root: '/arbitrary' }, { status: 'failed' }, { taskId: '../other' }]) {
    await assert.rejects(f.publishing.recoverInterrupted({ ...f.request, ...patch }), { status: 400 })
  }
  await assert.rejects(f.publishing.recoverInterrupted({ ...f.request, recordDigest: '0'.repeat(64) }), /记录已变化/)
  assert.deepEqual(await readFile(f.file), original)
  assert.deepEqual(await backupFiles(f), [])
})

test('未来 deadline、已完成/未知/浏览器任务不可恢复；其他活动投稿也阻止核对', async t => {
  const f = await fixture(t)
  const check = async records => {
    await f.store.run(() => writePublishRecords(f.store.root, records))
    const original = await readFile(f.file)
    await assert.rejects(f.publishing.recoverInterrupted({ ...f.request, recordDigest: apiRecordDigest(records[0]) }), { status: 409 })
    assert.deepEqual(await readFile(f.file), original)
  }
  for (const patch of [{ deadline: Date.now() + 60_000 }, { status: 'unknown' }, { status: 'published' }, { deadline: null }]) await check([{ ...f.record, ...patch }])
  await check([f.record, { ...f.record, taskId: randomUUID(), deadline: Date.now() + 60_000 }])
  await f.store.run(async () => { await writePublishRecords(f.store.root, []); await migratePublishRecords(f.store.root); await writePublishRecords(f.store.root, [{ ...f.record, provider: 'maitian' }]) })
  await assert.rejects(f.publishing.recoverInterrupted(f.request), { status: 404 })
  assert.deepEqual(await backupFiles(f), [])
})

test('有当前 Host 发布活动时即使超时且人工确认也拒绝；真实进程退出后允许恢复', async t => {
  const f = await fixture(t)
  await withPublishActivity(f.store, 'api-review', () => assert.rejects(f.publishing.recoverInterrupted(f.request), /发布操作正在进行/))
  const child = fork(new URL('./helpers/publish-activity-owner.mjs', import.meta.url), [f.store.root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(() => child.kill('SIGKILL'))
  await once(child, 'message')
  await assert.rejects(f.publishing.recoverInterrupted(f.request), /发布操作正在进行/)
  assert.deepEqual(await backupFiles(f), [])
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  await f.publishing.recoverInterrupted(f.request)
  assert.equal((await rows(f))[0].status, 'unknown')
  assert.deepEqual(await readdir(join(f.store.root, '.publish-activities')), [])
})

test('重复确认幂等；平台回查或另 Host 已改变记录时旧摘要不能覆盖新结果', async t => {
  const f = await fixture(t)
  await f.publishing.recoverInterrupted(f.request)
  const bytes = await readFile(f.file)
  await f.publishing.recoverInterrupted(f.request)
  assert.deepEqual(await readFile(f.file), bytes)
  assert.equal((await backupFiles(f)).length, 1)
  const second = await fixture(t)
  await second.store.run(() => writePublishRecords(second.store.root, [{ ...second.record, status: 'published', updatedAt: 'new-result' }]))
  await assert.rejects(second.publishing.recoverInterrupted(second.request), /记录已变化/)
  assert.equal((await rows(second))[0].status, 'published')
  assert.deepEqual(await backupFiles(second), [])
})

test('双 Host 重复恢复和 v2 后恢复保留两条记录，只处理指定任务', async t => {
  const f = await fixture(t), second = new Publishing(new Store(f.store.root), { resolvePlatform: () => null })
  await f.store.run(() => writePublishRecords(f.store.root, [f.record, { ...f.record, taskId: randomUUID(), status: 'unknown' }]))
  const outcomes = await Promise.allSettled([f.publishing.recoverInterrupted(f.request), second.recoverInterrupted(f.request)])
  // Contending live recovery activities may reject each other. A fresh attempt is safe and idempotent.
  outcomes.forEach(value => { if (value.status === 'rejected') assert.equal(value.reason.status, 409) })
  await f.publishing.recoverInterrupted(f.request)
  assert.equal((await backupFiles(f)).length, 1)
  assert.equal((await rows(f)).length, 2)
  assert.equal((await rows(f))[1].interruptionRecovery, undefined)
  await f.store.run(() => migratePublishRecords(f.store.root))
  const added = { ...f.record, provider: 'api', taskId: randomUUID() }
  await f.store.run(async () => writePublishRecords(f.store.root, [...await rows(f), added]))
  await second.recoverInterrupted({ ...f.request, taskId: added.taskId, recordDigest: apiRecordDigest(added) })
  assert.equal(JSON.parse(await readFile(f.file)).version, 2)
  assert.equal((await rows(f)).length, 3)
})

test('真实 HTTP 恢复入口拒绝跨站/额外字段；返回的审计不暴露备份和私有字段', async t => {
  const f = await fixture(t), server = createServer((req, res) => route({}, f.store, { publishing: f.publishing }, req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/media-desk/publish/recover-interrupted`
  const overview = await fetch(url.replace('recover-interrupted', 'interrupted'))
  assert.equal(overview.status, 200)
  assert.equal((await overview.json()).jobs[0].recoveryRecordDigest, f.request.recordDigest)
  const post = (body, site = 'same-origin') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: JSON.stringify(body) })
  assert.equal((await post(f.request, 'cross-site')).status, 403)
  assert.equal((await post({ ...f.request, dir: '/private' })).status, 400)
  const response = await post(f.request), data = await response.json()
  assert.equal(response.status, 200)
  assert.equal(data.job.status, 'unknown')
  assert.equal(data.job.interruptionRecovery.actor, '核对者')
  assert.equal(JSON.stringify(data).includes('backupFile'), false)
  assert.equal(JSON.stringify(data).includes('original-account'), false)
})

test('升级前总览包含其他稿件及二十条历史之外的中断任务，不受原稿删除影响', async t => {
  const f = await fixture(t)
  const gone = { ...f.record, itemId: 'deleted-piece', taskId: randomUUID() }
  const active = { ...f.record, itemId: 'another-piece', taskId: randomUUID(), deadline: Date.now() + 60_000 }
  const history = Array.from({ length: 25 }, () => ({ ...f.record, taskId: randomUUID(), status: 'published' }))
  await f.store.run(() => writePublishRecords(f.store.root, [f.record, gone, active, ...history]))
  assert.equal((await f.publishing.status('piece')).jobs.length, 20)
  const overview = await f.publishing.interruptionOverview()
  assert.equal(overview.jobs.length, 3)
  assert.equal(overview.jobs[1].itemId, 'deleted-piece')
  assert.equal(overview.jobs[1].canRecoverInterrupted, true)
  assert.equal(overview.jobs[2].canRecoverInterrupted, undefined)
  await f.store.run(() => writePublishRecords(f.store.root, [f.record, gone, ...history]))
  await f.publishing.recoverInterrupted({ ...f.request, id: gone.itemId, taskId: gone.taskId, recordDigest: apiRecordDigest(gone) })
  assert.equal((await f.publishing.interruptionOverview()).jobs.length, 1)
  assert.equal((await rows(f)).find(row => row.taskId === gone.taskId).status, 'unknown')
})

test('核对后仍按原回执和账号查询，不重新上传；新平台结果可更新并保留恢复审计', async t => {
  const f = await fixture(t), calls = []
  await f.publishing.recoverInterrupted(f.request)
  const publishing = new Publishing(f.store, { resolvePlatform: () => ({ accessToken: 'private-fixture-token', adapter: {
    account: async () => ({ channelId: 'original-account', title: '原账号' }),
    review: async input => { calls.push(input); return { status: 'published', privacyStatus: 'private', url: 'https://www.youtube.com/watch?v=receipt-kept' } },
    submit: () => assert.fail('Recovery must never upload again'),
  } }) })
  const job = await publishing.review({ id: 'piece', taskId: f.record.taskId })
  assert.equal(job.status, 'published')
  assert.equal(calls[0].receiptId, f.record.receiptId)
  assert.equal(calls[0].channelId, f.record.plan.account.id)
  assert.equal((await rows(f))[0].interruptionRecovery.sourceRecordDigest, f.request.recordDigest)
  assert.equal(blocksDuplicate((await rows(f))[0]), true)
  await assert.rejects(publishing.recoverInterrupted(f.request), /记录已变化/)
  assert.equal((await rows(f))[0].status, 'published')
})
