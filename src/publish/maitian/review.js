import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { withPublishActivity } from '../activity.js'
import { executingRecord, writePublishRecords } from '../records.js'
import { accountEpoch } from './account-state.js'
import { BrowserOperations } from './browser-operations.js'
import { configurationDigest } from './prepare.js'
import { processIdentity } from './profile-lock.js'
import { applyReview, linkResult } from './results.js'
import { browserRecordView } from './task-record.js'
import { TASK_ID } from './task-project.js'
import { find, locked, recoverBrowserRecords } from './tasks.js'
import { MaitianError, publicFailure } from './errors.js'

export function taskIdentity({ id, taskId } = {}) {
  if (typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id) || typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new MaitianError('INVALID_TASK', '浏览器任务标识无效', 400)
}

export async function reviewTask(service, request = {}) {
  taskIdentity(request)
  const { id, taskId, account } = request
  if (!account || typeof account !== 'object' || Array.isArray(account) || Object.keys(account).some(key => !['label', 'confirmed', 'identityLimitAcknowledged'].includes(key)) ||
      account.confirmed !== true || account.identityLimitAcknowledged !== true || typeof account.label !== 'string') throw new MaitianError('ACCOUNT_CONFIRMATION_REQUIRED', '请在专用 Chrome 核对原任务账号，并确认身份核验限制', 400)
  return withPublishActivity(service.store, 'maitian-review', async () => {
    const { options, engineRef, contract } = await service.resolve()
    if (!options.enabled) throw new MaitianError('BROWSER_DISABLED', '请先保存并启用专用浏览器设置')
    const checked = await locked(service, async (records, root) => {
      if (await recoverBrowserRecords(records)) await writePublishRecords(root, records)
      const record = find(records, id, taskId)
      if (executingRecord(record) || !record.executionIntentAt || record.resolution) throw new MaitianError('TASK_BUSY', '任务尚在执行或已经结束核对，不能查询结果')
      if (account.label !== record.plan.account.label || record.profileId !== options.profileId) throw new MaitianError('ACCOUNT_CHANGED', '请核对并确认原任务对应的专用资料和账号标签')
      if (!contract.operations['collect-links'] || !contract.platforms[record.platform]?.canCollectLinks || record.contractVersion !== contract.contractVersion) throw new MaitianError('MISSING_COLLECT_LINKS', '当前麦田组件不支持原任务结果查询，请在平台人工核对')
      return record
    })
    const origin = await new BrowserOperations(service.config.root).read(checked.runId || checked.plan.account.preflightOperationId)
    const profileDir = await realpath(options.profileDir)
    if (origin.profileId !== checked.profileId || origin.profileDir !== profileDir) throw new MaitianError('PROFILE_CHANGED', '原任务的专用浏览器资料无法核对，请在平台人工处理')
    const epoch = await accountEpoch(profileDir, checked.platform), digest = configurationDigest(options)
    const reviewId = randomUUID(), identity = await processIdentity(process.pid)
    const claim = await locked(service, async (records, root) => {
      const record = find(records, id, taskId)
      if (executingRecord(record) || record.resolution) throw new MaitianError('TASK_BUSY', '任务正在执行其他操作，请稍后查询')
      const at = new Date().toISOString()
      record.reviewLease = { runId: reviewId, owner: { pid: process.pid, identity }, heartbeatAt: at, expiresAt: Date.now() + 30_000 }
      record.querySupported = true
      record.lastQueryAccount = { label: account.label, verification: 'user-confirmed', confirmedAt: at, identityLimitAcknowledged: true, accountEpoch: epoch }
      record.updatedAt = at
      await writePublishRecords(root, records)
      return { root, record }
    })
    const update = callback => locked(service, async (records, root) => {
      const record = find(records, id, taskId)
      if (root !== claim.root || record.reviewLease?.runId !== reviewId || record.reviewLease.stoppedAt) throw new MaitianError('STALE_RUN', '查询归属已变化，已拒绝旧结果')
      await callback(record)
      record.updatedAt = new Date().toISOString()
      await writePublishRecords(root, records)
      return browserRecordView(record)
    })
    let candidate, failure
    try {
      const response = await service.run({
        op: 'collect-links', taskId, runId: reviewId, platform: checked.platform, engineRef, contractVersion: checked.contractVersion,
        nodePath: options.nodePath, accountEpoch: epoch, expectedProfileDir: profileDir,
        projectRef: { projectId: checked.projectId, data: checked.plan.data },
        browser: { root: service.config.root, profileDir: options.profileDir, profileId: options.profileId, chromePath: options.chromePath, port: options.port },
        onSpawn: async ({ pid }) => {
          const identity = await processIdentity(pid)
          if (!identity) throw new MaitianError('RUNNER_EXITED', '查询执行器提前退出')
          if (configurationDigest(service.config.resolve()) !== digest) throw new MaitianError('CONFIG_CHANGED', '浏览器配置已变化，请重新核对账号后查询')
          await update(record => { record.reviewLease.runner = { pid, identity } })
        },
        onEvent: async () => update(record => { record.reviewLease.heartbeatAt = new Date().toISOString(); record.reviewLease.expiresAt = Date.now() + 30_000 }),
      })
      candidate = linkResult({ [checked.platform]: response?.result }, checked.platform, { privatePaths: [service.config.root, engineRef.dir, options.profileDir, options.chromePath] })
      if (response.result.rejectedFields !== undefined) {
        if (!Array.isArray(response.result.rejectedFields) || response.result.rejectedFields.some(field => !['url', 'workId'].includes(field))) throw new MaitianError('INCOMPATIBLE_LINK_RESULT', '查询结果字段无法确认，请在平台人工核对')
        candidate.rejectedFields = [...new Set([...(candidate.rejectedFields || []), ...response.result.rejectedFields])]
      }
      if (configurationDigest(service.config.resolve()) !== digest || await accountEpoch(profileDir, checked.platform) !== epoch) throw new MaitianError('ACCOUNT_CHANGED', '查询期间配置或已知登录状态变化，请重新核对账号')
    } catch (error) { failure = publicFailure(error) }
    return update(record => {
      record.reviewLease.stoppedAt = new Date().toISOString()
      if (failure) record.reviewError = failure.message
      else {
        record.reviewError = null
        applyReview(record, { reviewId, source: 'maitian-query', queriedAt: new Date().toISOString(),
          engineVersion: engineRef.version, engineFingerprint: engineRef.fingerprint, contractVersion: contract.contractVersion,
          accountVerification: 'user-confirmed', result: candidate })
      }
    })
  })
}
