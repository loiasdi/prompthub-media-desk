import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContentAssets } from '../src/content-assets.js'
import { Store } from '../src/store.js'
import { assertNoAssetUploads } from '../src/asset-upload.js'
import { readPublishRecords, writePublishRecords } from '../src/publish/records.js'
import { withPublishActivity } from '../src/publish/activity.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { MaitianConfig } from '../src/publish/maitian/config.js'
import { inspectEngine } from '../src/publish/maitian/engine-loader.mjs'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { BrowserOperations } from '../src/publish/maitian/browser-operations.js'
import { captureProject } from '../src/publish/maitian/export.js'
import { invalidateAccount } from '../src/publish/maitian/account-state.js'
import { acquireProfileLock } from '../src/publish/maitian/profile-lock.js'
import { component } from './helpers/maitian-component.js'
import { route } from '../src/host.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-prepare-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'workspace'))
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '测试标题', body: '实际正文', platform: '小红书', tags: ['话题'] }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  const { workspace: imported, asset: video } = await assets.import('piece', createReadStream(new URL('../assets/v-ink.mp4', import.meta.url)), { name: '成片.mp4', revision: 0 })
  const ws = await assets.save('piece', imported.revision, { ...imported, selectedVideo: video.id, publish: { ...imported.publish, provider: 'maitian', mode: 'now' } })
  const original = await component(join(root, 'original'))
  const config = new MaitianConfig(join(root, 'config'))
  await config.save({ enabled: true, source: 'local', localComponentDir: original })
  const engineRef = await inspectEngine(original)
  await mkdir(config.resolve().profileDir, { recursive: true })
  const operationId = randomUUID(), now = new Date().toISOString()
  const proof = { version: 1, operationId, op: 'preflight', platform: 'xhs', profileId: 'default', profileDir: await realpath(config.resolve().profileDir),
    engineFingerprint: engineRef.fingerprint, engineVersion: engineRef.version, accountEpoch: 'initial', completedAt: now,
    targets: [{ targetId: 'original-target', browserInstanceId: 'browser-a', tabId: 1000 }], selectedTargetId: 'original-target', preflight: { ok: true, checkedAt: now } }
  const journal = new BrowserOperations(config.root)
  await journal.write(proof)
  const calls = []
  const service = new MaitianPublishing(store, { config, inspect: async () => ({ duration: 2 }), run: input => {
    calls.push(input.op)
    assert.ok(['hello', 'validate'].includes(input.op), 'Preparation never uploads, fills or queries a platform')
    return runComponent(input)
  } })
  const request = { id: 'piece', revision: ws.revision, platform: 'xhs', account: { label: '人工核对的小红书账号', confirmed: true, identityLimitAcknowledged: true, preflightOperationId: operationId } }
  return { root, store, assets, ws, original, config, engineRef, proof, journal, service, request, calls }
}

test('浏览器准备单保存完整确认内容与固定工程，不上传；v2 记录不保存本机绝对路径', async t => {
  const f = await fixture(t)
  const prepared = await f.service.prepare(f.request)
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.provider, 'maitian')
  assert.equal(prepared.account.verification, 'user-confirmed')
  assert.equal(prepared.account.label, f.request.account.label)
  assert.equal(prepared.draft.title, '测试标题')
  assert.equal(prepared.draft.description, '实际正文')
  assert.deepEqual(prepared.warnings, ['上游原始提示'])
  assert.equal(prepared.assets[0].digest.length, 64)
  assert.deepEqual(f.calls, ['hello', 'validate'])
  assert.equal(JSON.stringify(prepared).includes(f.root), false)
  const disk = JSON.parse(await readFile(join(f.store.root, '.publish-records.json'), 'utf8'))
  assert.equal(disk.version, 2)
  const record = disk.records[0]
  assert.equal(record.taskId, prepared.taskId)
  assert.equal(record.executionIntentAt, undefined)
  assert.equal(record.projectDigest, prepared.projectDigest)
  assert.equal(JSON.stringify(disk).includes(f.root), false)
  const project = join(f.config.root, 'runs', record.projectId)
  const data = JSON.parse(await readFile(join(project, 'publish.json'), 'utf8'))
  assert.deepEqual(data, record.plan.data)
  assert.deepEqual(await readFile(join(project, data.video)), await readFile(new URL('../assets/v-ink.mp4', import.meta.url)))
  assert.equal((await inspectEngine(f.original)).fingerprint, f.engineRef.fingerprint)
  assert.deepEqual(await readdir(join(f.store.root, 'pending')), [])
  assert.deepEqual(await readdir(join(f.store.root, '.publish-activities')), [])
  assert.equal(f.service.public().implementation.directFill, false)
})

test('缺少人工确认、过期预检或未选择浏览器方式，不创建可执行单或升级记录', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.prepare({ ...f.request, account: { ...f.request.account, confirmed: false } }), error => error.code === 'ACCOUNT_CONFIRMATION_REQUIRED')
  assert.deepEqual(f.calls, [])
  await f.journal.write({ ...f.proof, preflight: { ok: true, checkedAt: '2000-01-01T00:00:00Z' } })
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'PREFLIGHT_REQUIRED')
  await f.journal.write({ ...f.proof, preflight: { ...f.proof.preflight, ok: false } })
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'PREFLIGHT_REQUIRED')
  await f.journal.write({ ...f.proof, engineFingerprint: 'changed' })
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'COMPONENT_CHANGED')
  await f.journal.write(f.proof)
  const changed = await f.assets.save('piece', f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, provider: 'api' } })
  await assert.rejects(f.service.prepare({ ...f.request, revision: changed.revision }), error => error.code === 'BROWSER_SELECTION_REQUIRED')
  await assert.rejects(readFile(join(f.store.root, '.publish-records.json')), { code: 'ENOENT' })
})

test('直驱目标平台只覆盖工程快照的平台映射，不改写稿件平台', async t => {
  const f = await fixture(t)
  const captured = captureProject(f.store, 'piece', f.ws.revision, 'channels')
  assert.equal(captured.copy.platform, '视频号')
  assert.equal((await f.assets.read('piece')).publish.platform, '小红书')
})

test('固定文件期间组件更新要求重新确认，失败清理快照，不留下准备单', async t => {
  const f = await fixture(t)
  const run = f.service.run
  f.service.run = async input => {
    const result = await run(input)
    if (input.op === 'validate') await component(f.original, '1.1.0', { limit: 8 })
    return result
  }
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'COMPONENT_CHANGED')
  assert.deepEqual(await readPublishRecords(f.store.root), [])
  assert.deepEqual(await readdir(join(f.config.root, 'runs')), [])
  assert.deepEqual(await readdir(join(f.store.root, 'pending')), [])
})

test('复制期间不占 Store 锁；修订变化和迟到的另通道任务阻断提交', async t => {
  const f = await fixture(t)
  f.service.inspect = async () => {
    await assert.rejects(assertNoAssetUploads(f.store.root), error => error.status === 409)
    await f.assets.save('piece', f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, title: '改稿' } })
    return { duration: 2 }
  }
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'REVISION_CHANGED')
  assert.deepEqual(await readdir(join(f.config.root, 'runs')), [])
  const newer = await f.assets.read('piece')
  f.service.inspect = async () => {
    await f.store.run(() => writePublishRecords(f.store.root, [{ provider: 'api', itemId: 'piece', platform: 'xhs', status: 'unknown' }]))
    return { duration: 2 }
  }
  await assert.rejects(f.service.prepare({ ...f.request, revision: newer.revision }), error => error.code === 'EXISTING_PUBLICATION')
  assert.equal((await readPublishRecords(f.store.root)).length, 1)
  assert.deepEqual(await readdir(join(f.config.root, 'runs')), [])
})

test('本项目打开登录页后原账号确认失效，profile 忙或有 API 活动时不升级', async t => {
  const f = await fixture(t)
  const lock = await acquireProfileLock(f.config.resolve().profileDir, join(f.config.root, 'locks'))
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'PROFILE_BUSY')
  await lock.release()
  await withPublishActivity(f.store, 'api-prepare', () => assert.rejects(f.service.prepare(f.request), /发布操作正在进行/))
  await assert.rejects(readFile(join(f.store.root, '.publish-records.json')), { code: 'ENOENT' })
  const next = await acquireProfileLock(f.config.resolve().profileDir, join(f.config.root, 'locks'))
  try { await invalidateAccount(next.profileDir, 'xhs') } finally { await next.release() }
  await assert.rejects(f.service.prepare(f.request), error => error.code === 'ACCOUNT_CHANGED')
})

test('同源 HTTP 准备返回可审查确认单，严格拒绝额外路径和未经确认的账号字段', async t => {
  const f = await fixture(t)
  const desk = { maitianPublishing: f.service }
  const server = createServer((req, res) => route({}, f.store, desk, req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/media-desk/publish/maitian/prepare`
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) })
  assert.equal((await post({ ...f.request, account: { ...f.request.account, profileDir: '/arbitrary' } })).status, 400)
  const response = await post(f.request)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.preparation.status, 'prepared')
  assert.equal(body.preparation.account.verification, 'user-confirmed')
  assert.equal(JSON.stringify(body).includes(f.root), false)
  assert.deepEqual(f.calls, ['hello', 'validate'])
})
