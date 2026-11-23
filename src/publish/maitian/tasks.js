import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withAssetUpload } from '../../asset-upload.js'
import { withPublishActivity } from '../activity.js'
import { blocksDuplicate, executingRecord, providerOf, readPublishRecords, writePublishRecords } from '../records.js'
import { inspectSelection } from '../snapshot.js'
import { captureProject } from './export.js'
import { configurationDigest } from './prepare.js'
import { accountEpoch } from './account-state.js'
import { BrowserOperations } from './browser-operations.js'
import { discoverEngine } from './engine-loader.mjs'
import { componentChanged, MaitianError, publicFailure } from './errors.js'
import { fillState } from './fill-state.js'
import { processIdentity } from './profile-lock.js'
import { browserRecordView } from './task-record.js'
import { TaskControls } from './task-controls.js'
import { TASK_ID, verifyTaskProject } from './task-project.js'
import { stampSnapshotTerminal } from './snapshot-storage.js'

const now = () => new Date().toISOString()
const invalid = () => new MaitianError('TASK_NOT_FOUND', '浏览器任务不存在或已被替换，请重新检查', 409)
export const find = (records, id, taskId) => {
  const record = records.find(row => providerOf(row) === 'maitian' && row.itemId === id && row.taskId === taskId)
  if (!record) throw invalid()
  return record
}

export async function locked(service, callback) {
  return service.store.run(async () => {
    await service.store.refresh()
    const root = service.store.root, records = await readPublishRecords(root)
    return callback(records, root)
  })
}

function assertCurrentCopy(copy, record) {
  const expected = record.plan.draft
  if (copy.provider !== 'maitian' || copy.browser?.profileId !== record.profileId ||
      ['title', 'description', 'tags', 'mode', 'when', 'timezone'].some(key => JSON.stringify(copy[key]) !== JSON.stringify(expected[key])) ||
      (copy.browser?.shortTitle || '') !== expected.shortTitle) throw new MaitianError('REVISION_CHANGED', '发布信息或选材已变化，请重新检查并确认')
}

async function currentPreparation(service, record, { checkFiles = true } = {}) {
  const options = service.config.resolve()
  if (!options.enabled || configurationDigest(options) !== record.configurationDigest) throw new MaitianError('CONFIG_CHANGED', '浏览器配置已变化，请重新检查并确认')
  if (record.expiresAt <= Date.now()) throw new MaitianError('PREPARATION_EXPIRED', '浏览器确认单已过期，请重新检查并确认')
  if ((await discoverEngine(options)).fingerprint !== record.engineFingerprint) throw componentChanged()
  await service.snapshots.assertWorkspaceProject(service.store.root, record)
  if (await accountEpoch(options.profileDir, record.platform) !== record.accountEpoch) throw new MaitianError('ACCOUNT_CHANGED', '登录状态已变化，请重新预检并核对账号')
  await withAssetUpload(service.store, async ({ root }) => {
    const captured = await service.store.run(async () => {
      await service.store.refresh()
      if (root !== service.store.root) throw new MaitianError('WORKSPACE_CHANGED', '工作台目录已变化，请重新准备')
      return captureProject(service.store, record.itemId, record.plan.revision, record.platform)
    })
    assertCurrentCopy(captured.copy, record)
    if (checkFiles) {
      for (const asset of record.plan.assets) {
        const source = await inspectSelection(root, record.itemId, captured.workspace, asset.id, asset.mime.startsWith('video/') ? 'video' : 'image')
        if (source.digest !== asset.digest || source.sizeBytes !== asset.sizeBytes) throw new MaitianError('SOURCE_CHANGED', '素材已变化，请重新检查并确认')
      }
      await verifyTaskProject(join(service.config.root, 'runs'), { projectId: record.projectId, projectDigest: record.projectDigest, data: record.plan.data })
    }
  })
  return options
}

export async function startTask(service, { id, taskId, confirmed, projectDigest } = {}) {
  if (!service.directFillEnabled) throw new MaitianError('DIRECT_FILL_DISABLED', '直接填写尚未启用；请使用导出工程并在原版麦田助手中发布', 403)
  if (!/^[\w-]{1,160}$/.test(id || '') || !TASK_ID.test(taskId || '') || confirmed !== true || !/^[a-f0-9]{64}$/.test(projectDigest || '')) throw new MaitianError('TASK_CONFIRMATION_REQUIRED', '须明确确认当前浏览器填写单及工程摘要', 400)
  return withPublishActivity(service.store, 'maitian-start', async () => {
    const checked = await locked(service, records => find(records, id, taskId))
    if (checked.projectDigest !== projectDigest) throw new MaitianError('PROJECT_CHANGED', '确认单摘要不符，请重新检查并确认')
    if (checked.status !== 'prepared') return browserRecordView(checked)
    const options = await currentPreparation(service, checked)
    const engineRef = await discoverEngine(options)
    const runId = randomUUID(), identity = await processIdentity(process.pid)
    const claim = await locked(service, async (records, root) => {
      const record = find(records, id, taskId)
      if (record.status !== 'prepared') return { existing: browserRecordView(record) }
      if (record.expiresAt <= Date.now() || records.some(row => row !== record && row.itemId === id && row.platform === record.platform && blocksDuplicate(row))) throw new MaitianError('EXISTING_PUBLICATION', '确认单已过期或已有投稿，请先核对平台结果')
      assertCurrentCopy(captureProject(service.store, id, record.plan.revision, record.platform).copy, record)
      record.status = 'queued'; record.phase = 'queued'; record.runId = runId
      record.startedAt = record.updatedAt = now()
      record.lease = { runId, owner: { pid: process.pid, identity }, heartbeatAt: now(), expiresAt: Date.now() + 30_000 }
      await writePublishRecords(root, records)
      return { record, root }
    })
    if (claim.existing) return claim.existing
    const promise = executeTask(service, claim, { options, engineRef })
    service.executions.set(runId, promise)
    void promise.catch(error => { service.lastTaskError = publicFailure(error) }).finally(() => service.executions.delete(runId))
    return browserRecordView(claim.record)
  })
}

async function executeTask(service, { record: claim, root: claimedRoot }, { options, engineRef }) {
  const { taskId, runId, itemId: id, platform } = claim
  const update = callback => locked(service, async (records, root) => {
    if (root !== claimedRoot) throw new MaitianError('WORKSPACE_CHANGED', '活动浏览器任务的工作台目录已变化')
    const record = find(records, id, taskId)
    if (record.runId !== runId || record.lease?.stoppedAt) throw new MaitianError('STALE_RUN', '浏览器执行归属已变化，已拒绝旧事件')
    await callback(record, records)
    record.updatedAt = now()
    await writePublishRecords(root, records)
    return record
  })
  let result, failure
  try {
    await withPublishActivity(service.store, 'maitian-fill', async () => {
      result = await service.run({
        op: 'fill', taskId, runId, platform, engineRef, accountEpoch: claim.accountEpoch,
        timeoutMs: options.fillTimeoutMinutes * 60_000,
        nodePath: options.nodePath, projectRef: { projectId: claim.projectId, projectDigest: claim.projectDigest, data: claim.plan.data },
        browser: { root: service.config.root, profileDir: options.profileDir, profileId: options.profileId, chromePath: options.chromePath, port: options.port },
        onTimeout: async () => {
          await new TaskControls(service.config.root).cancel(taskId, runId)
          await update(record => {
            record.protectionTimedOutAt = now()
            record.cancelRequestedAt ||= now()
            record.message = '已达到本地填写保护时限，正在请求停止；请等待执行器退出并核对平台结果'
            if (record.executionIntentAt) record.status = 'unknown'
          })
        },
        onSpawn: async ({ pid }) => {
          const identity = await processIdentity(pid)
          if (!identity) throw new MaitianError('RUNNER_EXITED', '组件执行器提前退出')
          await update(record => { record.lease.runner = { pid, identity }; record.status = 'preflighting'; record.phase = 'preflighting' })
        },
        onReady: async () => {
          await currentPreparation(service, claim)
          await update((record, records) => {
            if (record.cancelRequestedAt) throw new MaitianError('RUNNER_CANCELLED', '已请求停止浏览器填写')
            if (record.expiresAt <= Date.now()) throw new MaitianError('PREPARATION_EXPIRED', '浏览器确认单已过期，请重新检查并确认')
            if (records.some(row => row !== record && row.itemId === id && row.platform === platform && blocksDuplicate(row))) throw new MaitianError('EXISTING_PUBLICATION', '已有其他投稿，请先核对平台结果')
            assertCurrentCopy(captureProject(service.store, id, record.plan.revision, platform).copy, record)
            // Atomic durable intent precedes the execute IPC acknowledgement.
            record.executionIntentAt = now(); record.status = 'preflighting'; record.phase = 'preflighting'
          })
        },
        onEvent: async message => {
          await update(record => {
            record.lease.heartbeatAt = now(); record.lease.expiresAt = Date.now() + 30_000
            record.lastEventSeq = message.seq
            if (message.type === 'progress') {
              if (!record.executionIntentAt) throw new MaitianError('INVALID_PROTOCOL', '执行器在确认前报告填写进度，已停止')
              const state = fillState(message.state, platform)
              record.upstreamState = state.raw
              record.phase = state.phase
              if (state.raw.failed) record.status = 'unknown'
              else if (['preflighting', 'uploading', 'filling'].includes(state.phase)) record.status = state.phase
            }
          })
        },
      })
    })
  } catch (error) { failure = publicFailure(error) }
  let finalState
  if (result) {
    try { finalState = fillState(result.state, platform) }
    catch (error) { failure = publicFailure(error); result = undefined }
  }
  // runComponent settles only after confirmed child close and all earlier events have drained.
  await update(async record => {
    record.lease.stoppedAt = now()
    record.completedAt = now()
    if (result && record.executionIntentAt) {
      record.upstreamState = finalState.raw
      record.status = finalState.filled && !record.cancelRequestedAt ? 'awaiting_user' : 'unknown'
      record.message = record.status === 'awaiting_user' ? '已填好，待你在平台检查并发布' : '填写结果待核对，请检查原平台页面；不会自动重新上传'
    } else {
      record.status = record.executionIntentAt ? 'unknown' : record.cancelRequestedAt ? 'cancelled' : 'failed'
      record.error = failure || { code: 'INVALID_PROTOCOL', message: '执行器未完成授权协议，请检查执行环境', status: 502 }
      record.message = record.protectionTimedOutAt ? '已达到本地填写保护时限，执行器已停止；请核对原平台页面，上传可能仍在继续' : record.executionIntentAt ? '执行已停止，平台可能已有上传内容，请先核对；不会自动重新上传' : '执行器已退出，尚未授权原版开始填写，请重新检查后准备'
    }
    record.phase = 'stopped'
    stampSnapshotTerminal(record)
    try {
      const journal = await new BrowserOperations(service.config.root).read(runId)
      record.pageOperationId = journal.selectedTargetId ? runId : null
    } catch { record.pageOperationId = null }
  })
}

export async function cancelTask(service, { id, taskId } = {}) {
  if (!/^[\w-]{1,160}$/.test(id || '') || !TASK_ID.test(taskId || '')) throw new MaitianError('INVALID_TASK', '浏览器任务标识无效', 400)
  return locked(service, async (records, root) => {
    const record = find(records, id, taskId)
    if (record.status === 'prepared') {
      record.status = 'cancelled'; record.updatedAt = now()
      stampSnapshotTerminal(record)
    } else if (record.lease && !record.lease.stoppedAt) {
      // The owner polls this file; cancellation must never acquire a second profile lock.
      await new TaskControls(service.config.root).cancel(taskId, record.runId)
      record.cancelRequestedAt ||= now()
      record.message = '已请求停止，当前步骤可能仍在执行；请等待执行器退出后核对原页面'
    }
    await writePublishRecords(root, records)
    return browserRecordView(record)
  })
}

async function alive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || typeof owner.identity !== 'string' || !owner.identity) return null
  return await processIdentity(owner.pid) === owner.identity
}

// Called under Store.run. Age diagnoses a stale lease; only process identity proves termination.
export async function recoverBrowserRecords(records) {
  let changed = false
  for (const record of records) {
    if (providerOf(record) !== 'maitian') continue
    const review = record.reviewLease
    if (review && !review.stoppedAt) {
      const hostAlive = await alive(review.owner), runnerAlive = review.runner ? await alive(review.runner) : false
      if (hostAlive === false && runnerAlive === false) {
        review.stoppedAt = now()
        record.reviewError = '原查询进程已退出，尚未取得新结果；原发布状态和防重继续保留'
        record.updatedAt = now(); changed = true
      } else if (Date.now() > review.expiresAt && !review.diagnosedAt) {
        review.diagnosedAt = now()
        record.reviewError = '查询心跳已过期，尚未确认进程退出；继续保留执行锁'
        record.updatedAt = now(); changed = true
      }
    }
    if (!(record.lease && !record.lease.stoppedAt || ['queued', 'preflighting', 'uploading', 'filling'].includes(record.status))) continue
    const lease = record.lease
    if (lease?.stoppedAt) {
      record.status = 'unknown'; record.phase = 'stopped'; record.updatedAt = now()
      record.message = '执行器已停止，但终态记录不完整，请先核对平台结果'
      changed = true
      continue
    }
    const hostAlive = await alive(lease?.owner), runnerAlive = lease?.runner ? await alive(lease.runner) : false
    if (hostAlive === false && runnerAlive === false) {
      if (lease) lease.stoppedAt = now()
      record.status = record.executionIntentAt ? 'unknown' : record.cancelRequestedAt ? 'cancelled' : 'failed'
      stampSnapshotTerminal(record)
      record.phase = 'stopped'; record.updatedAt = now()
      record.message = '原执行进程已退出，请先核对平台结果；不会自动恢复上传'
      changed = true
    } else if (record.status !== 'unknown' && (!lease || Date.now() > lease.expiresAt)) {
      record.lease ||= { expiresAt: 0 }
      record.status = 'unknown'; record.updatedAt = now()
      record.message = '执行器心跳已过期，尚未确认进程退出；继续保留执行锁与防重'
      changed = true
    }
  }
  return changed
}
