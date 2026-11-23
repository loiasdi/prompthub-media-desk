import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withPublishActivity } from '../activity.js'
import { executingRecord, writePublishRecords } from '../records.js'
import { acquireProfileLock, processIdentity } from './profile-lock.js'
import { workId, workURL } from './results.js'
import { scheduleISO } from './project.js'
import { releaseTaskSnapshot } from './snapshots.js'
import { taskIdentity } from './review.js'
import { browserRecordView } from './task-record.js'
import { find, locked, recoverBrowserRecords } from './tasks.js'
import { MaitianError } from './errors.js'
import { stampSnapshotTerminal } from './snapshot-storage.js'

const COMMON = ['id', 'taskId', 'action', 'actor', 'reason', 'confirmed']
const FIELDS = {
  associate: [...COMMON, 'platformChecked', 'reviewId', 'evidence'],
  'confirmed-not-submitted': [...COMMON, 'automationStopped', 'platformChecked', 'originalPageChecked', 'residualsCleared'],
  archive: [...COMMON, 'automationStopped', 'pagesResolved', 'snapshotReleaseConfirmed'],
}
const requiredText = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value)

async function assertStopped(record) {
  if (executingRecord(record)) throw new MaitianError('TASK_BUSY', '执行器尚未确认停止，不能人工解除或归档')
  for (const runner of [record.lease?.runner, record.reviewLease?.runner]) {
    if (runner?.identity && await processIdentity(runner.pid) === runner.identity) throw new MaitianError('TASK_BUSY', '原执行进程仍存活，请先完成停止与核对')
  }
}

function evidenceOf(value, platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['status', 'workId', 'url', 'actualWhen', 'actualTimezone'].includes(key)) ||
      !['published', 'pending_review', 'scheduled', 'rejected'].includes(value.status)) throw new MaitianError('INVALID_EVIDENCE', '请填写在平台核对的作品状态及证据', 400)
  const evidence = { status: value.status, workId: workId(value.workId), url: workURL(platform, value.url), scheduleVerification: 'unverified' }
  if (value.actualWhen !== undefined || value.actualTimezone !== undefined) {
    if (value.status !== 'scheduled') throw new MaitianError('INVALID_EVIDENCE', '实际预约时间只能用于已核对的定时作品', 400)
    evidence.actualScheduleAt = scheduleISO(value.actualWhen, value.actualTimezone)
    evidence.actualTimezone = value.actualTimezone
    evidence.scheduleVerification = 'manual-confirmed'
  }
  return evidence
}

export async function reconcileTask(service, request = {}) {
  taskIdentity(request)
  const allowed = Object.hasOwn(FIELDS, request.action) ? FIELDS[request.action] : null
  if (!allowed || Object.keys(request).some(key => !allowed.includes(key)) || request.confirmed !== true || !requiredText(request.actor, 200) || !requiredText(request.reason, 2000)) throw new MaitianError('RECONCILIATION_REQUIRED', '请明确确认核对操作，并填写操作者与原因', 400)
  const { id, taskId, action } = request
  if (action === 'associate' && request.platformChecked !== true || action === 'confirmed-not-submitted' && !['automationStopped', 'platformChecked', 'originalPageChecked', 'residualsCleared'].every(key => request[key] === true) ||
      action === 'archive' && !['automationStopped', 'pagesResolved', 'snapshotReleaseConfirmed'].every(key => request[key] === true)) throw new MaitianError('RECONCILIATION_REQUIRED', '请先核对平台、处理原页面和残留内容，并确认自动流程已经停止', 400)
  return withPublishActivity(service.store, 'maitian-reconcile', async () => {
    const options = service.config.resolve()
    // Never wait on a browser owner while holding Store.run.
    const lock = await acquireProfileLock(options.profileDir, join(service.config.root, 'locks'))
    try { return await service.snapshots.withLock(async () => {
      const claim = await locked(service, async (records, root) => {
        if (await recoverBrowserRecords(records)) await writePublishRecords(root, records)
        const record = find(records, id, taskId)
        if (record.profileId !== options.profileId) throw new MaitianError('PROFILE_CHANGED', '请切回原任务的专用资料后核对')
        await assertStopped(record)
        if ((record.reconciliations || []).length >= 1000) throw new MaitianError('AUDIT_LIMIT', '该任务核对记录已达上限，请保留记录后处理')
        const audit = { id: randomUUID(), action, at: new Date().toISOString(), actor: request.actor.trim(), reason: request.reason.trim(), confirmed: true }
        if (action === 'associate') {
          if (!record.executionIntentAt || record.resolution || record.archivedAt) throw new MaitianError('INVALID_EVIDENCE', '该任务未开始填写或已经完成归档核对，不能直接关联作品')
          if (request.reviewId !== undefined && request.reviewId !== record.lastReview?.reviewId) throw new MaitianError('REVIEW_CHANGED', '查询候选已经变化，请重新检查当前结果')
          const evidence = evidenceOf(request.evidence, record.platform)
          const duplicate = records.some(row => row !== record && row.platform === record.platform && row.association && !row.resolution &&
            (evidence.workId && row.association.workId === evidence.workId || evidence.url && row.association.url === evidence.url))
          if (duplicate) throw new MaitianError('WORK_ALREADY_ASSOCIATED', '该作品已经关联到另一个任务，请先核对原记录')
          if (evidence.actualScheduleAt && record.plan.data.schedule) evidence.scheduleMismatch = Date.parse(evidence.actualScheduleAt) !== Date.parse(record.plan.data.schedule)
          record.association = { ...evidence, source: 'manual-confirmed', actor: audit.actor, confirmedAt: audit.at, reason: audit.reason, ...(request.reviewId && { reviewId: request.reviewId }) }
          record.status = evidence.status; record.url = evidence.url; record.evidenceSource = 'manual-confirmed'
          record.message = evidence.scheduleMismatch ? '已人工关联作品，实际平台预约时间与原计划不同' : '已根据人工平台核对关联作品'
          audit.evidence = record.association
        } else if (action === 'confirmed-not-submitted') {
          if (record.archivedAt || ['published', 'pending_review', 'scheduled'].includes(record.status) || record.association && record.association.status !== 'rejected') throw new MaitianError('EXISTING_PUBLICATION', '记录已有平台提交证据，不能确认为从未提交')
          record.resolution = { ...audit, automationStopped: true, residualsCleared: true, platformChecked: true, originalPageChecked: true }
          record.status = 'cancelled'; record.message = '已人工确认未提交并处理残留，可重新准备；原任务不会自动重投'
          record.evidenceSource = 'manual-confirmed-not-submitted'
        } else {
          await service.snapshots.assertWorkspaceProject(root, record)
          if (records.some(row => row !== record && row.projectId === record.projectId && !row.archive?.snapshotReleased)) throw new MaitianError('SNAPSHOT_REFERENCED', '固定工程仍被其他任务引用，不能释放')
          record.archiveAttempt = { ...audit, automationStopped: true, pagesResolved: true, snapshotReleaseConfirmed: true }
          record.reconciliations = [...(record.reconciliations || []), { ...record.archiveAttempt, phase: 'release-pending' }]
        }
        if (action !== 'archive') record.reconciliations = [...(record.reconciliations || []), audit]
        record.updatedAt = audit.at
        stampSnapshotTerminal(record, audit.at)
        await writePublishRecords(root, records)
        return { root, record, audit }
      })
      if (action !== 'archive') return browserRecordView(claim.record)
      await releaseTaskSnapshot(service.config.root, claim.record)
      return locked(service, async (records, root) => {
        const record = find(records, id, taskId)
        if (root !== claim.root || record.archiveAttempt?.id !== claim.audit.id) throw new MaitianError('STALE_RUN', '归档归属已变化，请重新检查')
        await assertStopped(record)
        record.archivedAt = record.updatedAt = claim.audit.at
        record.archive = { ...claim.audit, automationStopped: true, pagesResolved: true, snapshotReleased: true, phase: 'released' }
        record.snapshotReleasedAt = new Date().toISOString()
        record.reconciliations = (record.reconciliations || []).map(audit => audit.id === claim.audit.id ? record.archive : audit)
        record.archiveAttempt = null
        if (record.status === 'prepared') record.status = 'cancelled'
        await writePublishRecords(root, records)
        return browserRecordView(record)
      })
    }) } finally { await lock.release() }
  })
}

export async function openTaskPage(service, request = {}, management = false) {
  taskIdentity(request)
  return withPublishActivity(service.store, 'maitian-open-page', async () => {
    const record = await locked(service, async (records, root) => {
      if (await recoverBrowserRecords(records)) await writePublishRecords(root, records)
      const record = find(records, request.id, request.taskId)
      if (executingRecord(record)) throw new MaitianError('TASK_BUSY', '任务仍在操作浏览器，请先等待当前操作结束')
      return record
    })
    if (service.config.resolve().profileId !== record.profileId) throw new MaitianError('PROFILE_CHANGED', '请切回原任务的专用资料后打开页面')
    if (management) {
      const result = await service.browser('open-management', { platform: record.platform })
      return { opened: result.opened, canOpenPage: false }
    }
    if (!record.runId || record.archivedAt || record.resolution) throw new MaitianError('PAGE_REFERENCE_LOST', '原任务页面不可恢复，请打开平台作品管理页核对')
    const result = await service.browser('open-page', { operationId: record.pageOperationId || record.runId })
    return { canOpenPage: result.canOpenPage === true }
  })
}
