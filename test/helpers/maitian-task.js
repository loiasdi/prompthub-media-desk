import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContentAssets } from '../../src/content-assets.js'
import { Store } from '../../src/store.js'
import { readPublishRecords, writePublishRecords } from '../../src/publish/records.js'
import { MaitianPublishing } from '../../src/publish/maitian/service.js'
import { MaitianConfig } from '../../src/publish/maitian/config.js'
import { inspectEngine } from '../../src/publish/maitian/engine-loader.mjs'
import { BrowserOperations } from '../../src/publish/maitian/browser-operations.js'
import { component } from './maitian-component.js'

export async function taskFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-task-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'workspace'))
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '测试标题', body: '实际正文', platform: '小红书', tags: ['话题'] }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  const { workspace: imported, asset: video } = await assets.import('piece', createReadStream(new URL('../../assets/v-ink.mp4', import.meta.url)), { name: '成片.mp4', revision: 0 })
  const ws = await assets.save('piece', imported.revision, { ...imported, selectedVideo: video.id, publish: { ...imported.publish, provider: 'maitian', mode: 'now' } })
  const original = await component(join(root, 'original'))
  const config = new MaitianConfig(join(root, 'config'))
  await config.save({ enabled: true, source: 'local', localComponentDir: original })
  const engineRef = await inspectEngine(original)
  await mkdir(config.resolve().profileDir, { recursive: true })
  const operationId = randomUUID(), now = new Date().toISOString()
  await new BrowserOperations(config.root).write({ version: 1, operationId, op: 'preflight', platform: 'xhs', profileId: 'default', profileDir: await realpath(config.resolve().profileDir),
    engineFingerprint: engineRef.fingerprint, engineVersion: engineRef.version, accountEpoch: 'initial', completedAt: now,
    targets: [{ targetId: 'original-target', browserInstanceId: 'browser-a', tabId: 1000 }], selectedTargetId: 'original-target', preflight: { ok: true, checkedAt: now } })
  const service = new MaitianPublishing(store, { config, inspect: async () => ({ duration: 2 }), directFillEnabled: true })
  const prepared = await service.prepare({ id: 'piece', revision: ws.revision, platform: 'xhs', account: { label: '人工核对账号', confirmed: true, identityLimitAcknowledged: true, preflightOperationId: operationId } })
  const record = (await readPublishRecords(store.root))[0]
  const request = { id: 'piece', taskId: prepared.taskId, confirmed: true, projectDigest: prepared.projectDigest }
  return { root, store, assets, video, ws, original, config, service, prepared, record, request }
}

export async function completedTaskFixture(t) {
  const f = await taskFixture(t), runId = randomUUID(), at = new Date().toISOString()
  const record = { ...f.record, runId, pageOperationId: runId, executionIntentAt: at, status: 'awaiting_user',
    lease: { runId, stoppedAt: at }, querySupported: true }
  await f.store.run(() => writePublishRecords(f.store.root, [record]))
  await new BrowserOperations(f.config.root).write({ version: 1, operationId: runId, op: 'fill', taskId: record.taskId, runId, platform: record.platform,
    profileId: record.profileId, profileDir: await realpath(f.config.resolve().profileDir), targets: [{ targetId: 'exact-original', browserInstanceId: 'browser-a', tabId: 1000 }], selectedTargetId: 'exact-original' })
  return { ...f, record, query: { id: 'piece', taskId: record.taskId, account: { label: record.plan.account.label, confirmed: true, identityLimitAcknowledged: true } } }
}
