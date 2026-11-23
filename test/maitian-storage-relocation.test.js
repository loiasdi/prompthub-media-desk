import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/store.js'
import { Settings } from '../src/settings.js'
import { route } from '../src/host.js'
import { relocateStorage, openStorage } from '../src/storage-management.js'
import { blocksDuplicate, readPublishRecords, writePublishRecords } from '../src/publish/records.js'
import { withPublishActivity } from '../src/publish/activity.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { TaskSnapshotStorage } from '../src/publish/maitian/snapshot-storage.js'
import { processIdentity } from '../src/publish/maitian/profile-lock.js'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { taskFixture, completedTaskFixture } from './helpers/maitian-task.js'

const exists = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const media = f => join(f.config.root, 'runs', f.record.projectId)
const ownerFile = f => join(f.config.root, 'snapshot-owners', `${f.record.projectId}.json`)
const indexFile = f => join(f.config.root, 'snapshot-transfers.json')
const options = f => ({ env: { DSH_HOME: join(f.root, 'host-config') }, snapshots: f.service.snapshots })
const relocate = (f, target) => relocateStorage(f.store, target, options(f))
const archive = f => ({ id: 'piece', taskId: f.record.taskId, action: 'archive', actor: '测试核对人', reason: '已检查平台和原页面', confirmed: true, automationStopped: true, pagesResolved: true, snapshotReleaseConfirmed: true })
const save = (f, records) => f.store.run(() => writePublishRecords(f.store.root, records))

test('正式迁移原子转交副本归属，旧目录保持原字节；新准备单替换并清理旧副本', async t => {
  const f = await taskFixture(t), source = f.store.root, target = join(f.root, 'migrated')
  const sourceRecords = await readFile(join(source, '.publish-records.json')), originalOwner = await readFile(ownerFile(f))
  const videoBytes = await readFile(join(media(f), f.record.plan.data.video))
  const result = await relocate(f, target)
  assert.deepEqual(result, { root: await realpath(target), moved: true, backupRoot: await realpath(source) })
  assert.deepEqual(await readFile(join(source, '.publish-records.json')), sourceRecords)
  assert.deepEqual(await readFile(ownerFile(f)), originalOwner)
  const [record] = await readPublishRecords(target)
  assert.equal(record.status, 'prepared')
  assert.equal(record.expiresAt, 0)
  assert.equal(record.workspaceRelocation.preparationInvalidated, true)
  assert.ok(record.workspaceRelocation.id)
  assert.equal(JSON.stringify(record).includes(f.root), false)
  const index = JSON.parse(await readFile(indexFile(f)))
  assert.equal(index.owners[record.projectId].workspaceRoot, await realpath(target))
  assert.equal(index.owners[record.projectId].originalWorkspaceRoot, await realpath(source))
  assert.equal((await stat(indexFile(f))).mode & 0o777, 0o600)
  await f.service.snapshots.assertWorkspaceProject(target, record)
  await assert.rejects(f.service.snapshots.assertWorkspaceProject(source, f.record), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  const oldHost = new MaitianPublishing(new Store(source), { config: f.config, directFillEnabled: true })
  await assert.rejects(oldHost.start(f.request), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  await assert.rejects(oldHost.reconcile(archive(f)), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  await assert.rejects(f.service.start(f.request), { code: 'PREPARATION_EXPIRED' })
  await oldHost.snapshots.withWorkspace(oldHost.store, async () => {})
  assert.equal(await exists(media(f)), true)
  const next = await f.service.prepare({ id: 'piece', revision: f.ws.revision, platform: 'xhs', account: { label: '重新核对', confirmed: true, identityLimitAcknowledged: true, preflightOperationId: f.record.plan.account.preflightOperationId } })
  assert.notEqual(next.taskId, f.record.taskId)
  assert.equal(await exists(media(f)), false)
  assert.equal(await exists(ownerFile(f)), false)
  assert.equal(JSON.parse(await readFile(indexFile(f))).owners[f.record.projectId], undefined)
  const [current] = await readPublishRecords(target)
  assert.deepEqual(await readFile(join(f.config.root, 'runs', current.projectId, current.plan.data.video)), videoBytes)
})

test('连续迁移后仅最新目录能归档，历史、回执和防重保留，查询仍只调用原版 collectLinks', async t => {
  const f = await completedTaskFixture(t), source = f.store.root, second = join(f.root, 'second'), third = join(f.root, 'third')
  const record = { ...f.record, status: 'published', evidenceSource: 'manual-confirmed', association: { source: 'manual-confirmed', workId: 'retained-work' }, snapshotTerminalAt: new Date().toISOString() }
  await save(f, [record])
  const bytes = await readFile(join(source, '.publish-records.json'))
  await relocate(f, second)
  await relocate(f, third)
  assert.deepEqual(await readFile(join(source, '.publish-records.json')), bytes)
  assert.deepEqual(await readFile(join(third, '.publish-records.json')), bytes)
  for (const root of [source, second]) {
    const old = new MaitianPublishing(new Store(root), { config: f.config })
    await old.snapshots.withWorkspace(old.store, async () => {})
    await assert.rejects(old.reconcile(archive(f)), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  }
  assert.equal(await exists(media(f)), true)
  const calls = []
  f.service.run = async request => {
    calls.push(request.op)
    if (request.op === 'hello') return runComponent(request)
    assert.equal(request.op, 'collect-links')
    return { result: { status: '已发布', workId: 'retained-work' } }
  }
  assert.equal((await f.service.review(f.query)).status, 'published')
  assert.deepEqual(calls, ['hello', 'collect-links'])
  const [queried] = await readPublishRecords(third)
  assert.equal(queried.runId, record.runId)
  assert.equal(queried.snapshotTerminalAt, record.snapshotTerminalAt)
  assert.equal(blocksDuplicate(queried), true)
  await f.service.reconcile(archive(f))
  assert.equal(await exists(media(f)), false)
  const [archived] = await readPublishRecords(third)
  assert.equal(archived.status, 'published')
  assert.equal(blocksDuplicate(archived), true)
})

test('迁移后的七天终态清理由新目录执行，旧备份不能提前清理或重置保留起点', async t => {
  const f = await completedTaskFixture(t), source = f.store.root, target = join(f.root, 'migrated')
  const record = { ...f.record, status: 'published', evidenceSource: 'manual-confirmed', association: { source: 'manual-confirmed' }, snapshotTerminalAt: '2000-01-01T00:00:00.000Z' }
  await save(f, [record]); await relocate(f, target)
  const old = new Store(source)
  await f.service.snapshots.withWorkspace(old, async () => {})
  assert.equal(await exists(media(f)), true)
  await f.service.snapshots.withWorkspace(f.store, async () => {})
  assert.equal(await exists(media(f)), false)
  const [kept] = await readPublishRecords(target)
  assert.equal(kept.snapshotTerminalAt, record.snapshotTerminalAt)
  assert.equal(kept.snapshotCleanup.reason, 'terminal-retention')
  assert.equal(blocksDuplicate(kept), true)
  assert.equal((await readPublishRecords(source))[0].snapshotReleasedAt, undefined)
})

test('待核对任务和正在查询的终态任务继续阻止迁移，不写入归属索引', async t => {
  const f = await completedTaskFixture(t), target = join(f.root, 'migrated')
  for (const status of ['awaiting_user', 'unknown', 'pending_review', 'scheduled']) {
    await save(f, [{ ...f.record, status }])
    await assert.rejects(relocate(f, target), /有投稿任务正在进行/)
  }
  await save(f, [{ ...f.record, status: 'published', reviewLease: { runId: randomUUID(), expiresAt: 0 } }])
  await assert.rejects(relocate(f, target), /有投稿任务正在进行/)
  assert.equal(await exists(target), false)
  assert.equal(await exists(indexFile(f)), false)
})

test('停止标记不替代进程退出，另一个真实执行进程存活时不能转交', async t => {
  const f = await taskFixture(t), target = join(f.root, 'migrated')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  t.after(() => { if (child.exitCode === null) child.kill() })
  await save(f, [{ ...f.record, status: 'published', lease: { stoppedAt: new Date().toISOString(), runner: { pid: child.pid, identity: await processIdentity(child.pid) } } }])
  await assert.rejects(relocate(f, target), { code: 'TASK_BUSY' })
  assert.equal(await exists(target), false)
  const closed = once(child, 'close'); child.kill(); await closed
  assert.equal((await relocate(f, target)).moved, true)
})

test('另一个 Host 持存储锁时迁移快速拒绝；进程退出后可转交', async t => {
  const f = await taskFixture(t), target = join(f.root, 'migrated')
  const script = `import { TaskSnapshotStorage } from ${JSON.stringify(new URL('../src/publish/maitian/snapshot-storage.js', import.meta.url).href)};
    await new TaskSnapshotStorage(${JSON.stringify(f.config.root)}).withLock(async () => { process.stdout.write('locked\\n'); await new Promise(() => { setInterval(() => {}, 1000) }); });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [ready] = await once(child.stdout, 'data')
  assert.equal(ready.toString().trim(), 'locked')
  await assert.rejects(relocate(f, target), { code: 'SNAPSHOT_STORAGE_BUSY' })
  const closed = once(child, 'close'); child.kill(); await closed
  assert.equal((await relocate(f, target)).moved, true)
})

test('另一 Host 尚无任务记录的活动操作也阻止迁移，结束后可迁移', async t => {
  const f = await taskFixture(t), target = join(f.root, 'migrated'), other = new Store(f.store.root)
  await withPublishActivity(other, 'maitian-review', async () => {
    await assert.rejects(relocate(f, target), /有发布操作正在进行/)
    assert.equal(await exists(target), false)
  })
  assert.equal((await relocate(f, target)).moved, true)
})

test('原工作区无引用的遗留副本随正式迁移转交，可在目标目录清理', async t => {
  const f = await taskFixture(t), source = f.store.root, target = join(f.root, 'migrated')
  await save(f, [])
  await relocate(f, target)
  await f.service.snapshots.withWorkspace(new Store(source), async () => {})
  assert.equal(await exists(media(f)), true)
  await f.service.snapshots.withWorkspace(f.store, async () => {})
  assert.equal(await exists(media(f)), false)
})

test('直接复制和打开不会接管副本，复制目录也不能通过再次迁移偷取归属', async t => {
  const f = await taskFixture(t), source = f.store.root, copied = join(f.root, 'copied'), target = join(f.root, 'migrated-copy')
  await cp(source, copied, { recursive: true })
  await openStorage(f.store, copied, options(f))
  await assert.rejects(f.service.start(f.request), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  await assert.rejects(relocate(f, target), { code: 'SNAPSHOT_RELOCATION_UNPROVEN' })
  assert.equal(await exists(target), false)
  assert.equal(await exists(indexFile(f)), false)
  await f.service.snapshots.assertWorkspaceProject(source, f.record)
})

test('缺少旧归属的现存副本需先原地归档，不能借飞书身份自动接管', async t => {
  const f = await taskFixture(t), target = join(f.root, 'migrated')
  await f.store.mutate('', state => { state.storageIdentityRoot = target }, { undoable: false })
  await rm(ownerFile(f))
  await assert.rejects(relocate(f, target), { code: 'SNAPSHOT_RELOCATION_UNPROVEN' })
  assert.equal(await exists(target), false)
  assert.equal(await exists(indexFile(f)), false)
  await f.service.reconcile(archive(f))
  assert.equal(await exists(media(f)), false)
  assert.equal((await relocate(f, target)).moved, true)
})

test('配置激活失败后数据和归属留在已校验目标，重新打开目标可恢复；旧备份不回收新副本', async t => {
  const f = await taskFixture(t), source = f.store.root, target = join(f.root, 'migrated'), configHome = options(f).env.DSH_HOME
  await mkdir(configHome)
  await writeFile(join(configHome, 'media-desk-storage.json'), '{invalid')
  await assert.rejects(relocate(f, target), /数据已迁移，目录配置切换未完成/)
  assert.equal(f.store.root, source)
  assert.equal(await exists(join(target, 'state.json')), true)
  await new TaskSnapshotStorage(f.config.root).assertWorkspaceProject(target, f.record)
  await assert.rejects(f.service.snapshots.assertWorkspaceProject(source, f.record), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  await rm(join(configHome, 'media-desk-storage.json'))
  const restarted = new Store(source)
  await openStorage(restarted, target, options(f))
  await f.service.snapshots.withWorkspace(restarted, async () => {})
  assert.equal(await exists(media(f)), false)
  assert.equal(restarted.root, await realpath(target))
  assert.equal(JSON.parse(await readFile(join(configHome, 'media-desk-storage.json'))).root, await realpath(target))
})

test('复制校验失败不转交归属，不激活目标；源目录和素材保留', async t => {
  const f = await taskFixture(t), source = f.store.root, target = join(f.root, 'migrated')
  await symlink(join(source, 'state.json'), join(source, 'unexpected-link'))
  await assert.rejects(relocate(f, target), /符号链接/)
  assert.equal(await exists(target), false)
  assert.equal(await exists(indexFile(f)), false)
  await f.service.snapshots.assertWorkspaceProject(source, f.record)
  assert.equal(await exists(media(f)), true)
})

test('归属索引损坏或被替换为符号链接时拒绝迁移和清理，不跟随外部文件', async t => {
  const f = await taskFixture(t), target = join(f.root, 'migrated'), outside = join(f.root, 'outside.json')
  await writeFile(indexFile(f), '{bad')
  await assert.rejects(relocate(f, target), { code: 'SNAPSHOT_STORAGE_UNSAFE' })
  await assert.rejects(f.service.snapshots.withWorkspace(f.store, async () => {}), { code: 'SNAPSHOT_STORAGE_UNSAFE' })
  await rm(indexFile(f))
  await writeFile(outside, JSON.stringify({ version: 1, owners: {} }))
  await symlink(outside, indexFile(f))
  await assert.rejects(relocate(f, target), { code: 'SNAPSHOT_STORAGE_UNSAFE' })
  assert.equal(await readFile(outside, 'utf8'), JSON.stringify({ version: 1, owners: {} }))
  assert.equal(await exists(media(f)), true)
  assert.equal(await exists(target), false)
})

test('同时迁移的两份 Host 只有一份能转交，另一个目标不留下副本', async t => {
  const f = await taskFixture(t), a = join(f.root, 'a'), b = join(f.root, 'b'), original = f.store.root
  const other = new Store(original)
  const results = await Promise.allSettled([relocate(f, a), relocateStorage(other, b, options(f))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SNAPSHOT_STORAGE_BUSY')
  const destination = results.find(result => result.status === 'fulfilled').value.root
  assert.equal(Number(await exists(a)) + Number(await exists(b)), 1)
  await f.service.snapshots.assertWorkspaceProject(destination, f.record)
  await assert.rejects(f.service.snapshots.assertWorkspaceProject(original, f.record), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
})

test('目标公布后被另一写入修改时拒绝转交，不覆盖目标记录或修改源归属', async t => {
  const f = await taskFixture(t), original = f.store.root, target = join(f.root, 'migrated')
  const canonical = join(await realpath(f.root), 'migrated'), run = Store.prototype.run
  let changed = false
  Store.prototype.run = function (task) {
    if (this.root !== canonical || changed) return run.call(this, task)
    changed = true
    return run.call(this, async () => {
      const records = await readPublishRecords(this.root)
      records[0].message = '另一个 Host 已更新'
      await writePublishRecords(this.root, records)
      return task()
    })
  }
  try { await assert.rejects(relocate(f, target), /迁移目标的发布记录已变化/) }
  finally { Store.prototype.run = run }
  assert.equal(changed, true)
  assert.equal((await readPublishRecords(target))[0].message, '另一个 Host 已更新')
  assert.equal(await exists(indexFile(f)), false)
  await f.service.snapshots.assertWorkspaceProject(original, f.record)
  assert.equal(f.store.root, original)
})

test('设置 HTTP 迁移使用同一发布服务的副本存储，失效旧确认单且不调用组件或平台', async t => {
  const f = await taskFixture(t), original = f.store.root, target = join(f.root, 'migrated')
  const before = { DSH_HOME: process.env.DSH_HOME, MEDIA_DESK_DATA_DIR: process.env.MEDIA_DESK_DATA_DIR }
  process.env.DSH_HOME = options(f).env.DSH_HOME
  delete process.env.MEDIA_DESK_DATA_DIR
  t.after(() => {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  })
  let componentCalls = 0
  f.service.run = async () => { componentCalls++; throw Error('Unexpected component operation') }
  const desk = { settings: new Settings(f.store), maitianPublishing: f.service }
  const server = createServer((req, res) => route({ get: () => null }, f.store, desk, req, res).catch(error => {
    res.writeHead(error.status || 500); res.end(JSON.stringify({ error: error.message }))
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/media-desk/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentDir: target }) })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.storage.moved, true)
  assert.equal(body.documentDir, await realpath(target))
  assert.equal(JSON.stringify(body).includes(f.config.root), false)
  assert.equal(componentCalls, 0)
  assert.equal((await readPublishRecords(original))[0].expiresAt, f.record.expiresAt)
  assert.equal((await readPublishRecords(target))[0].expiresAt, 0)
  await f.service.snapshots.assertWorkspaceProject(target, f.record)
})

test('同次迁移的多份副本共同转交，所有旧确认单失效，旧工作区不能释放任意一份', async t => {
  const f = await taskFixture(t), source = f.store.root, target = join(f.root, 'migrated'), secondId = randomUUID()
  const second = { ...f.record, taskId: randomUUID(), projectId: secondId }
  const secondMedia = join(f.config.root, 'runs', secondId)
  await cp(media(f), secondMedia, { recursive: true })
  const manifestPath = join(secondMedia, 'media-desk-manifest.json')
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath)), snapshotId: secondId }))
  await writeFile(join(f.config.root, 'snapshot-owners', `${secondId}.json`), JSON.stringify({ version: 1, projectId: secondId, projectDigest: second.projectDigest, workspaceRoot: await realpath(source) }))
  await save(f, [f.record, second])
  await relocate(f, target)
  const index = JSON.parse(await readFile(indexFile(f)))
  assert.equal(Object.keys(index.owners).length, 2)
  for (const record of await readPublishRecords(target)) {
    assert.equal(record.expiresAt, 0)
    assert.equal(index.owners[record.projectId].transfer.id, record.workspaceRelocation.id)
    await f.service.snapshots.assertWorkspaceProject(target, record)
    await assert.rejects(f.service.snapshots.assertWorkspaceProject(source, record), { code: 'SNAPSHOT_WORKSPACE_CHANGED' })
  }
  await f.service.snapshots.withWorkspace(new Store(source), async () => {})
  assert.equal(await exists(media(f)), true)
  assert.equal(await exists(secondMedia), true)
  await f.service.snapshots.withWorkspace(f.store, async () => {})
  assert.equal(await exists(media(f)), false)
  assert.equal(await exists(secondMedia), false)
  assert.deepEqual(JSON.parse(await readFile(indexFile(f))).owners, {})
})

test('转交索引必须与原归属摘要和原目录匹配，损坏证明时两边都不能释放', async t => {
  const f = await taskFixture(t), source = f.store.root, target = join(f.root, 'migrated')
  await relocate(f, target)
  const index = JSON.parse(await readFile(indexFile(f)))
  index.owners[f.record.projectId].projectDigest = 'f'.repeat(64)
  await writeFile(indexFile(f), JSON.stringify(index))
  for (const root of [source, target]) {
    await assert.rejects(f.service.snapshots.assertWorkspaceProject(root, f.record), { code: 'SNAPSHOT_STORAGE_UNSAFE' })
    await assert.rejects(f.service.snapshots.withWorkspace(new Store(root), async () => {}), { code: 'SNAPSHOT_STORAGE_UNSAFE' })
  }
  assert.equal(await exists(media(f)), true)
})
