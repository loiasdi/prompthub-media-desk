import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Publishing } from '../src/publish/service.js'
import { activeRecord, blocksDuplicate, blocksStorageSwitch, executingRecord, migratePublishRecords, readPublishRecords, visibleRecord, writePublishRecords } from '../src/publish/records.js'
import { assertNoPublishActivities, withPublishActivity } from '../src/publish/activity.js'
import { openStorage, relocateStorage } from '../src/storage-management.js'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'md-publish-records-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const store = new Store(join(base, 'workspace'))
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '稿件', platform: 'YouTube' }] }, { undoable: false })
  return { base, store, file: join(store.root, '.publish-records.json') }
}

test('v1 在锁内无损迁移到 v2，保留原字节备份；后续写入与重复迁移不降级或丢回执', async t => {
  const f = await fixture(t)
  const api = { itemId: 'piece', taskId: randomUUID(), platform: 'youtube', status: 'unknown', receiptId: 'receipt', plan: { draft: { title: '原题目' }, account: { id: 'account', name: '账号' } } }
  await f.store.run(() => writePublishRecords(f.store.root, [api]))
  const original = await readFile(f.file)
  assert.equal(JSON.parse(original).version, 1)
  await f.store.run(() => migratePublishRecords(f.store.root))
  const first = JSON.parse(await readFile(f.file, 'utf8'))
  assert.equal(first.version, 2)
  assert.deepEqual(first.records, [{ ...api, provider: 'api' }])
  assert.deepEqual(await readFile(join(f.store.root, first.migration.backupFile)), original)
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600)
  assert.equal((await lstat(join(f.store.root, first.migration.backupFile))).mode & 0o777, 0o600)
  const browser = { provider: 'maitian', itemId: 'piece', taskId: randomUUID(), platform: 'xhs', status: 'awaiting_user' }
  await f.store.run(async () => writePublishRecords(f.store.root, [...await readPublishRecords(f.store.root), browser]))
  const after = await readFile(f.file)
  await f.store.run(() => migratePublishRecords(f.store.root))
  assert.deepEqual(await readFile(f.file), after)
  const upgraded = JSON.parse(after)
  assert.deepEqual(upgraded.migration, first.migration)
  assert.equal(upgraded.records[0].receiptId, api.receiptId)
  assert.equal(blocksDuplicate(upgraded.records[1]), true)
  assert.notEqual(upgraded.version, 1, 'The old v1 reader must reject this version, rather than discard browser states')
})

test('活动及过期的旧 publishing 都不凭时间升级；未知格式不会被写操作覆盖', async t => {
  const f = await fixture(t)
  for (const deadline of [Date.now() + 60_000, Date.now() - 60_000]) {
    await f.store.run(() => writePublishRecords(f.store.root, [{ status: 'publishing', deadline }]))
    const original = await readFile(f.file)
    await assert.rejects(f.store.run(() => migratePublishRecords(f.store.root)), /旧投稿尚未完成核对/)
    assert.deepEqual(await readFile(f.file), original)
  }
  await writeFile(f.file, '{"version":3,"records":[]}')
  await assert.rejects(f.store.run(() => writePublishRecords(f.store.root, [])), /无法安全读取/)
  assert.equal(await readFile(f.file, 'utf8'), '{"version":3,"records":[]}')
  await writeFile(f.file, '{"version":1,"records":[]}')
  await assert.rejects(f.store.run(() => writePublishRecords(f.store.root, [{ provider: 'maitian', status: 'queued' }])), /先升级/)
  assert.equal(JSON.parse(await readFile(f.file)).version, 1)
})

test('两个 Host 并发升级只创建一份备份，v2 追加记录串行保留两通道', async t => {
  const f = await fixture(t), other = new Store(f.store.root)
  await f.store.run(() => writePublishRecords(f.store.root, [{ itemId: 'old', status: 'published', receiptId: 'old-receipt' }]))
  await Promise.all([f.store, other].map(store => store.run(() => migratePublishRecords(store.root))))
  assert.equal((await readdir(f.store.root)).filter(name => name.endsWith('.backup.json')).length, 1)
  await Promise.all([f.store, other].map((store, index) => store.run(async () => {
    const rows = await readPublishRecords(store.root)
    rows.push({ provider: index === 0 ? 'api' : 'maitian', itemId: `new-${index}`, status: 'unknown' })
    await writePublishRecords(store.root, rows)
  })))
  const records = await readPublishRecords(f.store.root)
  assert.equal(records.length, 3)
  assert.equal(records[0].receiptId, 'old-receipt')
  assert.deepEqual(records.map(row => row.itemId).sort(), ['new-0', 'new-1', 'old'])
})

test('执行、防重、目录阻塞各自判断；浏览器不套 API 超时，归档不解除防重', () => {
  const api = { status: 'publishing', deadline: Date.now() + 60_000 }
  assert.equal(activeRecord(api), true)
  assert.equal(blocksStorageSwitch(api), true)
  assert.equal(blocksStorageSwitch({ ...api, deadline: 0 }), false)
  assert.equal(visibleRecord({ ...api, deadline: 0 }).status, 'unknown')
  for (const status of ['queued', 'preflighting', 'uploading', 'filling']) {
    const row = { provider: 'maitian', status, deadline: 0 }
    assert.equal(activeRecord(row), false)
    assert.equal(executingRecord(row), true)
    assert.equal(visibleRecord(row).status, status)
    assert.equal(blocksDuplicate(row), true)
    assert.equal(blocksStorageSwitch(row), true)
  }
  for (const status of ['awaiting_user', 'pending_review', 'scheduled', 'unknown', 'rejected', 'new-upstream-state']) {
    const row = { provider: 'maitian', status, archivedAt: 'time' }
    assert.equal(executingRecord(row), false)
    assert.equal(blocksDuplicate(row), true)
    assert.equal(blocksStorageSwitch(row), true, 'An archive timestamp alone is insufficient')
    const archive = { at: 'time', automationStopped: true, pagesResolved: true, snapshotReleased: true }
    assert.equal(blocksStorageSwitch({ ...row, archive }), false)
    assert.equal(blocksDuplicate({ ...row, archive }), true)
    assert.equal(blocksStorageSwitch({ ...row, archive, lease: { expiresAt: 0 } }), true, 'Lease expiry cannot prove the process stopped')
  }
  const failed = { provider: 'maitian', status: 'failed', executionIntentAt: 'time' }
  assert.equal(blocksDuplicate(failed), true, 'An upstream failure does not prove no upload occurred')
  assert.equal(blocksDuplicate({ ...failed, resolution: { action: 'confirmed-not-submitted', at: 'time', actor: 'user', reason: '已处理残留草稿', automationStopped: true, residualsCleared: true } }), false)
  assert.equal(blocksDuplicate({ provider: 'maitian', status: 'failed' }), false)
  assert.equal(blocksDuplicate({ provider: 'maitian', status: 'failed', lease: { expiresAt: 0 } }), true)
  assert.equal(blocksDuplicate({ provider: 'maitian', status: 'prepared' }), false)
})

test('请求尚未有任务记录也阻止跨 Host 切换与迁移，退出后清理活动登记', async t => {
  const f = await fixture(t), other = new Store(f.store.root)
  const target = new Store(join(f.base, 'target'))
  await target.mutate('', state => { state.items = [] })
  const env = { DSH_HOME: join(f.base, 'config') }
  await withPublishActivity(f.store, 'api-prepare', async () => {
    await assert.rejects(other.run(() => migratePublishRecords(other.root)), /发布操作正在进行/)
    await assert.rejects(relocateStorage(other, join(f.base, 'moved'), { env }), /发布操作正在进行/)
    await assert.rejects(openStorage(other, target.root, { env }), /发布操作正在进行/)
    const folder = join(f.store.root, '.publish-activities')
    const [name] = await readdir(folder)
    const ownerFile = join(folder, name)
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    owner.startedAt = '2000-01-01T00:00:00Z'
    await writeFile(ownerFile, JSON.stringify(owner))
    await assert.rejects(other.run(() => assertNoPublishActivities(other.root)), /发布操作正在进行/)
  })
  assert.deepEqual(await readdir(join(f.store.root, '.publish-activities')), [])
  await f.store.run(() => migratePublishRecords(f.store.root))
  const result = await relocateStorage(other, join(f.base, 'moved'), { env })
  assert.equal(result.moved, true)
})

test('活动登记仅清理确认已终止的唯一 owner，异常登记保守阻止迁移', async t => {
  const f = await fixture(t)
  await withPublishActivity(f.store, 'api-review', async () => {
    const folder = join(f.store.root, '.publish-activities')
    const [name] = await readdir(folder)
    const file = join(folder, name)
    const value = JSON.parse(await readFile(file, 'utf8'))
    value.identity = 'a different start identity'
    await writeFile(file, JSON.stringify(value))
    await f.store.run(() => assertNoPublishActivities(f.store.root))
    assert.deepEqual(await readdir(folder), [])
    await writeFile(join(folder, 'unexpected.json'), '{}')
    await assert.rejects(f.store.run(() => assertNoPublishActivities(f.store.root)), /发布操作正在进行/)
    assert.deepEqual(await readdir(folder), ['unexpected.json'])
    await rm(join(folder, 'unexpected.json'))
  })
})

test('混合通道记录安全展示且统一防重，API start/review/update 不接管浏览器任务', async t => {
  const f = await fixture(t)
  const taskId = randomUUID()
  const browser = { provider: 'maitian', taskId, itemId: 'piece', platform: 'youtube', status: 'awaiting_user', plan: { draft: { title: '浏览器题目' }, account: { label: '人工核对账号' }, privatePath: '/private/engine' }, engineRef: { dir: '/private/engine' } }
  await f.store.run(async () => { await migratePublishRecords(f.store.root); await writePublishRecords(f.store.root, [browser]) })
  const publishing = new Publishing(f.store, { resolvePlatform: () => ({ adapter: {} }) })
  const status = await publishing.status('piece')
  assert.equal(status.lockedPlatforms.youtube, true)
  assert.equal(status.jobs[0].provider, 'maitian')
  assert.equal(status.jobs[0].canReview, false)
  assert.equal(JSON.stringify(status).includes('/private'), false)
  await assert.rejects(publishing.prepare({ id: 'piece', platform: 'youtube' }), /已有/)
  await assert.rejects(publishing.start({ id: 'piece', taskId, confirmed: true }), /不存在或已被替换/)
  await assert.rejects(publishing.review({ id: 'piece', taskId }), /不能在线回查/)
  await assert.rejects(publishing.updateClaim(taskId, () => assert.fail()), /状态已改变/)
  assert.deepEqual(await readPublishRecords(f.store.root), [browser])
})

test('实际子进程存活时不能清除活动登记，确认退出后才可恢复迁移', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const child = fork(new URL('./helpers/publish-activity-owner.mjs', import.meta.url), [f.store.root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(() => child.kill('SIGKILL'))
  const [message] = await once(child, 'message')
  assert.equal(message.ready, true)
  await assert.rejects(f.store.run(() => migratePublishRecords(f.store.root)), /发布操作正在进行/)
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  await f.store.run(() => migratePublishRecords(f.store.root))
  assert.equal(JSON.parse(await readFile(f.file)).version, 2)
  assert.deepEqual(await readdir(join(f.store.root, '.publish-activities')), [])
})

test('实际 v2 浏览器任务阻止双 Host 打开/迁移目录；有效归档可以迁移但仍防重', async t => {
  const f = await fixture(t), other = new Store(f.store.root)
  const target = new Store(join(f.base, 'target'))
  await target.mutate('', state => { state.items = [] })
  const env = { DSH_HOME: join(f.base, 'config') }, moved = join(f.base, 'moved')
  await f.store.run(() => migratePublishRecords(f.store.root))
  for (const status of ['queued', 'preflighting', 'filling', 'awaiting_user', 'pending_review', 'scheduled', 'unknown', 'failed']) {
    await f.store.run(() => writePublishRecords(f.store.root, [{ provider: 'maitian', itemId: 'piece', taskId: randomUUID(), platform: 'xhs', status, executionIntentAt: 'time' }]))
    await assert.rejects(openStorage(other, target.root, { env }), /投稿任务正在进行/)
    await assert.rejects(relocateStorage(other, moved, { env }), /投稿任务正在进行/)
    assert.equal(other.root, f.store.root)
  }
  const archivedAt = new Date().toISOString()
  const archived = { provider: 'maitian', itemId: 'piece', taskId: randomUUID(), platform: 'xhs', status: 'unknown', archivedAt,
    archive: { at: archivedAt, automationStopped: true, pagesResolved: true, snapshotReleased: true } }
  await f.store.run(() => writePublishRecords(f.store.root, [archived]))
  assert.equal((await relocateStorage(other, moved, { env })).moved, true)
  const [preserved] = await readPublishRecords(moved)
  assert.deepEqual(preserved, archived)
  assert.equal(blocksDuplicate(preserved), true)
})
