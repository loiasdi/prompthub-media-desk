import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { blocksDuplicate, readPublishRecords, writePublishRecords } from '../src/publish/records.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { processIdentity } from '../src/publish/maitian/profile-lock.js'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { TaskSnapshotStorage, SNAPSHOT_RETENTION_MS, stampSnapshotTerminal, checkSnapshotDisk } from '../src/publish/maitian/snapshot-storage.js'
import { completedTaskFixture, taskFixture } from './helpers/maitian-task.js'

const rows = f => readPublishRecords(f.store.root)
const save = (f, records) => f.store.run(() => writePublishRecords(f.store.root, records))
const exists = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const project = f => join(f.config.root, 'runs', f.record.projectId)
const owner = f => join(f.config.root, 'snapshot-owners', `${f.record.projectId}.json`)
const cleanup = f => f.service.snapshots.withWorkspace(f.store, async () => {})
// Only accepted account fields are sent to the Host.
const prepareRequest = f => ({ id: 'piece', revision: f.ws.revision, platform: 'xhs', account: { label: '核对账号', confirmed: true, identityLimitAcknowledged: true, preflightOperationId: f.record.plan.account.preflightOperationId } })

test('重复准备清理被替换的自有副本和归属文件，当前准备单及原素材保持完整', async t => {
  const f = await taskFixture(t), originalBytes = await readFile(join(project(f), f.record.plan.data.video))
  const next = await f.service.prepare(prepareRequest(f))
  const records = await rows(f)
  assert.equal(records.length, 1)
  assert.equal(records[0].taskId, next.taskId)
  assert.equal(await exists(project(f)), false)
  assert.equal(await exists(owner(f)), false)
  assert.deepEqual(await readFile(join(f.config.root, 'runs', records[0].projectId, records[0].plan.data.video)), originalBytes)
  assert.equal((await readdir(join(f.config.root, 'runs'))).length, 1)
  assert.equal(JSON.stringify(records).includes(f.root), false)
  assert.equal(JSON.stringify(next).includes(f.root), false)
})

test('过期准备自动释放副本并保留摘要，开始仍因过期拒绝；未知遗留目录不按年龄删除', async t => {
  const f = await taskFixture(t)
  const record = { ...f.record, expiresAt: Date.now() - 1 }
  await save(f, [record])
  const legacy = join(f.config.root, 'runs', randomUUID())
  await mkdir(legacy); await writeFile(join(legacy, 'unknown.bin'), 'retain me')
  await cleanup(f)
  const kept = (await rows(f))[0]
  assert.equal(kept.status, 'prepared')
  assert.equal(kept.projectDigest, f.record.projectDigest)
  assert.equal(kept.snapshotCleanup.reason, 'expired-preparation')
  assert.ok(kept.snapshotReleasedAt)
  assert.equal(await exists(project(f)), false)
  assert.equal(await readFile(join(legacy, 'unknown.bin'), 'utf8'), 'retain me')
  await assert.rejects(f.service.start(f.request), error => error.code === 'PREPARATION_EXPIRED')
})

test('有明确证据的终态保留满七天，后续查询时间不延后保留；防重与审计不删除', async t => {
  const f = await completedTaskFixture(t), now = Date.now()
  f.service.snapshots = new TaskSnapshotStorage(f.config.root, { clock: () => now })
  const record = { ...f.record, status: 'published', evidenceSource: 'manual-confirmed', association: { source: 'manual-confirmed', workId: 'test-work' }, snapshotTerminalAt: new Date(now - SNAPSHOT_RETENTION_MS + 1).toISOString(), updatedAt: new Date(now + 1_000_000).toISOString() }
  await save(f, [record]); await cleanup(f)
  assert.equal(await exists(project(f)), true)
  record.snapshotTerminalAt = new Date(now - SNAPSHOT_RETENTION_MS).toISOString()
  await save(f, [record]); await cleanup(f)
  const kept = (await rows(f))[0]
  assert.equal(await exists(project(f)), false)
  assert.equal(kept.status, 'published')
  assert.equal(kept.association.workId, 'test-work')
  assert.equal(blocksDuplicate(kept), true)
  assert.equal(kept.snapshotCleanup.reason, 'terminal-retention')
  assert.equal(kept.updatedAt, record.updatedAt)
})

test('终态计时只在可信终态建立，重复查询不重置；回到审核中清除终态时间', () => {
  const record = { provider: 'maitian', status: 'published', evidenceSource: 'manual-confirmed', association: { source: 'manual-confirmed' } }
  stampSnapshotTerminal(record, '2026-11-01T00:00:00.000Z')
  stampSnapshotTerminal(record, '2026-11-09T00:00:00.000Z')
  assert.equal(record.snapshotTerminalAt, '2026-11-01T00:00:00.000Z')
  record.status = 'pending_review'; stampSnapshotTerminal(record)
  assert.equal(record.snapshotTerminalAt, undefined)
  record.status = 'unknown'; record.executionIntentAt = 'some-intent'; stampSnapshotTerminal(record)
  assert.equal(record.snapshotTerminalAt, undefined)
  record.status = 'failed'; stampSnapshotTerminal(record)
  assert.equal(record.snapshotTerminalAt, undefined)
})

test('未知、待人工、审核中、预约、拒绝和无证据成功不按年龄释放；其他任务引用也阻止释放', async t => {
  const f = await completedTaskFixture(t)
  for (const status of ['unknown', 'awaiting_user', 'pending_review', 'scheduled', 'rejected', 'published', 'failed', 'cancelled']) {
    await save(f, [{ ...f.record, status, snapshotTerminalAt: '2000-01-01T00:00:00.000Z' }])
    await cleanup(f)
    assert.equal(await exists(project(f)), true, status)
  }
  await save(f, [{ ...f.record, expiresAt: 0, status: 'prepared', executionIntentAt: null }, { ...f.record, taskId: randomUUID(), status: 'unknown' }])
  await cleanup(f)
  assert.equal(await exists(project(f)), true)
})

test('取消未上传任务七天后可清理，已授权失败不能借相同 failed 标签释放', async t => {
  const f = await taskFixture(t)
  await f.service.cancel({ id: 'piece', taskId: f.record.taskId })
  const record = (await rows(f))[0]
  assert.ok(record.snapshotTerminalAt)
  record.snapshotTerminalAt = '2000-01-01T00:00:00.000Z'
  await save(f, [record]); await cleanup(f)
  assert.equal(await exists(project(f)), false)
  assert.equal(blocksDuplicate((await rows(f))[0]), false)
})

test('停止标记不能替代进程身份检查：真实子进程活着时不释放', async t => {
  const f = await taskFixture(t)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  t.after(() => { if (child.exitCode === null) child.kill() })
  const record = { ...f.record, expiresAt: 0, lease: { stoppedAt: new Date().toISOString(), runner: { pid: child.pid, identity: await processIdentity(child.pid) } } }
  await save(f, [record]); await cleanup(f)
  assert.equal(await exists(project(f)), true)
  const closed = once(child, 'close'); child.kill(); await closed
  await cleanup(f)
  assert.equal(await exists(project(f)), false)
})

test('不同工作区不清理对方副本；复制工作区不能开始或归档另一工作区拥有的工程', async t => {
  const f = await taskFixture(t), destination = join(f.root, 'workspace-copy')
  await cp(f.store.root, destination, { recursive: true })
  const store = new Store(destination), service = new MaitianPublishing(store, { config: f.config, inspect: async () => ({ duration: 2 }), directFillEnabled: true })
  await service.snapshots.withWorkspace(store, async () => {})
  assert.equal(await exists(project(f)), true)
  await assert.rejects(service.start(f.request), error => error.code === 'SNAPSHOT_WORKSPACE_CHANGED')
  await assert.rejects(service.reconcile({ id: 'piece', taskId: f.record.taskId, action: 'archive', actor: '测试', reason: '已核对', confirmed: true, automationStopped: true, pagesResolved: true, snapshotReleaseConfirmed: true }), error => error.code === 'SNAPSHOT_WORKSPACE_CHANGED')
  assert.equal(await exists(project(f)), true)
})

test('崩溃遗留的归属 staging 与已提交未记账工程可恢复，错误 manifest 和符号链接保守保留', async t => {
  const f = await taskFixture(t)
  await save(f, [])
  const pending = join(f.config.root, 'runs', `.pending-${f.record.projectId}`)
  await cp(project(f), pending, { recursive: true })
  const manifestPath = join(project(f), 'media-desk-manifest.json')
  const manifestBytes = await readFile(manifestPath)
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifestBytes), projectDigest: 'a'.repeat(64) }))
  await cleanup(f)
  assert.equal(await exists(pending), false)
  assert.equal(await exists(project(f)), true)
  assert.equal(await exists(owner(f)), true)
  await writeFile(manifestPath, manifestBytes)
  await cleanup(f)
  assert.equal(await exists(project(f)), false)
  assert.equal(await exists(owner(f)), false)
  // A journal-owned name is insufficient to follow a symlink to arbitrary data.
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'keep')
  await symlink(outside, pending)
  await writeFile(owner(f), JSON.stringify({ version: 1, workspaceRoot: await realpath(f.store.root), projectId: f.record.projectId, projectDigest: null }))
  await cleanup(f)
  assert.equal((await lstat(pending)).isSymbolicLink(), true)
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'keep')
})

test('归属文件缺失或损坏不自动接管旧工程；不同摘要与未停止查询也不释放', async t => {
  const f = await taskFixture(t)
  await save(f, [{ ...f.record, expiresAt: 0 }])
  const original = await readFile(owner(f))
  await writeFile(owner(f), '{broken'); await cleanup(f)
  assert.equal(await exists(project(f)), true)
  await rm(owner(f)); await cleanup(f)
  assert.equal(await exists(project(f)), true)
  await writeFile(owner(f), original)
  await save(f, [{ ...f.record, expiresAt: 0, projectDigest: 'b'.repeat(64) }]); await cleanup(f)
  assert.equal(await exists(project(f)), true)
  await save(f, [{ ...f.record, expiresAt: 0, reviewLease: { expiresAt: 0 } }]); await cleanup(f)
  assert.equal(await exists(project(f)), true)
  await save(f, [{ ...f.record, expiresAt: 0, lease: { stoppedAt: 'some-stop', runner: { pid: 'invalid', identity: 'unknown' } } }]); await cleanup(f)
  assert.equal(await exists(project(f)), true)
})

test('删除失败保留释放意图和记录，修复 manifest 后可重试；不修改原发布状态', async t => {
  const f = await taskFixture(t)
  await save(f, [{ ...f.record, expiresAt: 0 }])
  const path = join(project(f), 'media-desk-manifest.json'), bytes = await readFile(path)
  await writeFile(path, '{}'); await cleanup(f)
  assert.ok((await rows(f))[0].snapshotCleanupAttempt)
  assert.equal((await rows(f))[0].snapshotReleasedAt, undefined)
  await writeFile(path, bytes); await cleanup(f)
  assert.equal((await rows(f))[0].snapshotCleanupAttempt, undefined)
  assert.equal((await rows(f))[0].status, 'prepared')
  assert.equal(await exists(project(f)), false)
})

test('容量限制在复制前读取真实文件大小，失败不留下准备单或新副本', async t => {
  const f = await taskFixture(t)
  const mediaSize = (await lstat(join(project(f), f.record.plan.data.video))).size
  const quota = 2 * 1024 ** 2 + mediaSize - 1
  await save(f, []); await cleanup(f)
  const service = new MaitianPublishing(f.store, { config: f.config, snapshots: new TaskSnapshotStorage(f.config.root, { quotaBytes: quota }), inspect: async () => { throw Error('must not copy media') } })
  await assert.rejects(service.prepare(prepareRequest(f)), error => error.code === 'SNAPSHOT_QUOTA_EXCEEDED' && error.status === 507)
  assert.equal((await rows(f)).length, 0)
  assert.equal((await readdir(join(f.config.root, 'runs'))).length, 0)
  assert.equal((await readdir(join(f.config.root, 'snapshot-owners'))).length, 0)
})

test('容量不足时保留尚未成功替换的准备单，未知目录占用也计入总量', async t => {
  const f = await taskFixture(t)
  const bytes = (await lstat(join(project(f), f.record.plan.data.video))).size
  const extra = join(f.config.root, 'runs', randomUUID())
  await mkdir(extra); await writeFile(join(extra, 'legacy'), Buffer.alloc(bytes))
  const snapshots = new TaskSnapshotStorage(f.config.root, { quotaBytes: 2 * 1024 ** 2 + bytes })
  const service = new MaitianPublishing(f.store, { config: f.config, snapshots })
  await assert.rejects(service.prepare(prepareRequest(f)), error => error.code === 'SNAPSHOT_QUOTA_EXCEEDED')
  assert.equal((await rows(f)).length, 1)
  assert.equal(await exists(project(f)), true)
  assert.equal(await exists(extra), true)
})

test('磁盘余量包含待复制字节和元数据；容量充足也不能耗尽保留空间', async t => {
  const f = await taskFixture(t)
  const available = 2 * 1024 ** 2 + 100_000
  let inspections = 0
  const snapshots = new TaskSnapshotStorage(f.config.root, { reserveBytes: 100_000, disk: async () => ({ bsize: 1, bavail: available }) })
  const service = new MaitianPublishing(f.store, { config: f.config, snapshots, inspect: async () => { inspections++; return { duration: 2 } } })
  await assert.rejects(service.prepare(prepareRequest(f)), error => error.code === 'SNAPSHOT_DISK_SPACE')
  assert.equal(inspections, 0)
  assert.equal((await rows(f)).length, 1)
  assert.equal((await readdir(join(f.config.root, 'runs'))).length, 1)
})

test('存储锁跨实例和 profile 互斥，清理不等待 Store 锁内的另一个容量分配', async t => {
  const f = await taskFixture(t)
  const second = new TaskSnapshotStorage(f.config.root)
  await f.service.snapshots.withLock(async () => {
    await assert.rejects(second.withWorkspace(f.store, async () => {}), error => error.code === 'SNAPSHOT_STORAGE_BUSY')
    // The storage lock never prevents independent draft saves.
    await f.store.mutate('测试保存', state => { state.items[0].title = '仍可保存' }, { undoable: false })
  })
  await second.withWorkspace(f.store, async () => {})
  assert.equal(f.store.state.items[0].title, '仍可保存')
})

test('磁盘检测失败不继续复制；空间边界包含压缩打包所需字节和余量', async () => {
  await assert.rejects(checkSnapshotDisk('/unused', 100, { disk: async () => { throw Error('private path') } }), error => error.code === 'SNAPSHOT_DISK_CHECK_FAILED' && !error.message.includes('private'))
  const reserveBytes = 500, sizeBytes = 1000, free = 2 * 1024 ** 2 + reserveBytes + sizeBytes
  await checkSnapshotDisk('/unused', sizeBytes, { reserveBytes, disk: async () => ({ bsize: 1, bavail: free }) })
  await assert.rejects(checkSnapshotDisk('/unused', sizeBytes, { reserveBytes, disk: async () => ({ bsize: 1, bavail: free - 1 }) }), error => error.code === 'SNAPSHOT_DISK_SPACE')
})

test('真实独立 Host 持锁时拒绝清理，确认进程退出后恢复锁并清理过期副本', async t => {
  const f = await taskFixture(t)
  await save(f, [{ ...f.record, expiresAt: 0 }])
  const source = `import { TaskSnapshotStorage } from ${JSON.stringify(new URL('../src/publish/maitian/snapshot-storage.js', import.meta.url).href)};
    await new TaskSnapshotStorage(${JSON.stringify(f.config.root)}).withLock(async () => { process.stdout.write('locked\\n'); await new Promise(() => { setInterval(() => {}, 1000) }); });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [ready] = await once(child.stdout, 'data')
  assert.equal(ready.toString().trim(), 'locked')
  await assert.rejects(cleanup(f), error => error.code === 'SNAPSHOT_STORAGE_BUSY')
  assert.equal(await exists(project(f)), true)
  const closed = once(child, 'close'); child.kill(); await closed
  await cleanup(f)
  assert.equal(await exists(project(f)), false)
})

test('七天后释放媒体仍可用原版查询，查询不重建媒体或改变原执行标识', async t => {
  const f = await completedTaskFixture(t)
  await save(f, [{ ...f.record, status: 'published', evidenceSource: 'manual-confirmed', association: { source: 'manual-confirmed', workId: 'kept-work' }, snapshotTerminalAt: '2000-01-01T00:00:00.000Z' }])
  await cleanup(f)
  assert.equal(await exists(project(f)), false)
  const calls = []
  f.service.run = async input => {
    calls.push(input.op)
    if (input.op === 'hello') return runComponent(input)
    assert.equal(input.op, 'collect-links')
    assert.deepEqual(input.projectRef.data, f.record.plan.data)
    return { result: { status: '已发布', workId: 'kept-work' } }
  }
  const view = await f.service.review(f.query)
  assert.equal(view.status, 'published')
  assert.equal(view.lastReview.matchedAssociatedId, true)
  assert.deepEqual(calls, ['hello', 'collect-links'])
  assert.equal((await rows(f))[0].runId, f.record.runId)
  assert.equal((await rows(f))[0].snapshotTerminalAt, '2000-01-01T00:00:00.000Z')
  assert.equal(await exists(project(f)), false)
  assert.equal(blocksDuplicate((await rows(f))[0]), true)
})
