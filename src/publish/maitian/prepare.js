import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withPublishActivity } from '../activity.js'
import { migratePublishRecords, providerOf, readPublishRecords, writePublishRecords } from '../records.js'
import { BrowserOperations } from './browser-operations.js'
import { accountEpoch } from './account-state.js'
import { discoverEngine } from './engine-loader.mjs'
import { captureProject, snapshotProject } from './export.js'
import { acquireProfileLock } from './profile-lock.js'
import { componentChanged, MaitianError } from './errors.js'
import { browserRecordView } from './task-record.js'

const PREFLIGHT_MS = 5 * 60_000
export const configurationDigest = options => createHash('sha256').update(JSON.stringify({
  enabled: options.enabled, source: options.source, localComponentDir: options.localComponentDir,
  profileId: options.profileId, profileDir: options.profileDir, port: options.port, chromePath: options.chromePath, nodePath: options.nodePath,
  fillTimeoutMinutes: options.fillTimeoutMinutes,
})).digest('hex')

function confirmedAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['label', 'confirmed', 'identityLimitAcknowledged', 'preflightOperationId'].includes(key)) ||
      value.confirmed !== true || value.identityLimitAcknowledged !== true || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200 || /[\x00-\x1f\x7f]/.test(value.label)) throw new MaitianError('ACCOUNT_CONFIRMATION_REQUIRED', '请先在专用 Chrome 核对账号，填写账号标签并确认身份核验限制', 400)
  return { ...value, label: value.label.trim() }
}
function freshPreflight(record, options, engineRef, platform) {
  const checkedAt = Date.parse(record.preflight?.checkedAt)
  if (record.op !== 'preflight' || record.platform !== platform || record.profileId !== options.profileId ||
      !record.completedAt || record.preflight?.ok !== true || !Number.isFinite(checkedAt) || checkedAt > Date.now() + 30_000 || Date.now() - checkedAt >= PREFLIGHT_MS) throw new MaitianError('PREFLIGHT_REQUIRED', '请先重新检查目标平台登录，再核对账号')
  if (record.engineFingerprint !== engineRef.fingerprint) throw componentChanged()
  if (!record.targets.some(target => target.targetId === record.selectedTargetId && typeof target.browserInstanceId === 'string')) throw new MaitianError('PREFLIGHT_PAGE_MISSING', '登录预检缺少原页面引用，请重新检查组件与登录')
  return checkedAt
}

export function preparationView(record) {
  return {
    ...browserRecordView(record), projectDigest: record.projectDigest,
    draft: record.plan.draft,
    account: { label: record.plan.account.label, verification: 'user-confirmed', confirmedAt: record.plan.account.confirmedAt, identityLimitAcknowledged: true },
    assets: record.plan.assets, warnings: record.plan.warnings, limits: record.plan.limits,
  }
}

export async function prepareTask(service, request) {
  const account = confirmedAccount(request?.account)
  const { id, revision, platform } = request
  if (!['xhs', 'channels'].includes(platform) || typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id) || !Number.isInteger(revision) || revision < 0) throw new MaitianError('INVALID_TARGET', '稿件、修订或目标平台无效', 400)
  if (!service.config.read().enabled) throw new MaitianError('BROWSER_DISABLED', '请先保存并启用专用浏览器设置')
  const { options, engineRef, contract } = await service.resolve()
  if (!options.enabled) throw new MaitianError('BROWSER_DISABLED', '请先保存并启用专用浏览器设置')
  if (!['validate', 'preflight', 'fill'].every(op => contract.operations[op]) || !contract.platforms[platform]?.mapped) throw new MaitianError('UNSUPPORTED_OPERATION', '当前麦田组件缺少填写或校验能力，请更新组件或连接层')
  const digest = configurationDigest(options)
  const preflight = await new BrowserOperations(service.config.root).read(account.preflightOperationId)
  const checkedAt = freshPreflight(preflight, options, engineRef, platform)
  const taskId = randomUUID()
  let prepared
  const checkSelection = copy => {
    if (copy.provider !== 'maitian' || !['now', 'scheduled'].includes(copy.mode) || copy.browser?.profileId !== options.profileId) throw new MaitianError('BROWSER_SELECTION_REQUIRED', '请在发布页选择浏览器填写、对应资料和发布时间', 400)
  }
  await withPublishActivity(service.store, 'maitian-prepare', async ({ root, token }) => {
    // No waiting on browser ownership while holding the Store lock.
    const lock = await acquireProfileLock(options.profileDir, join(service.config.root, 'locks'))
    try {
      if (preflight.profileDir !== lock.profileDir || preflight.accountEpoch !== await accountEpoch(lock.profileDir, platform)) throw new MaitianError('ACCOUNT_CHANGED', '专用浏览器或登录状态已变化，请重新预检并核对账号')
      await service.store.run(async () => {
        await service.store.refresh()
        if (service.store.root !== root) throw new MaitianError('WORKSPACE_CHANGED', '工作台目录已变化，请重新准备')
        checkSelection(captureProject(service.store, id, revision, platform).copy)
        await migratePublishRecords(root, { activityToken: token })
      })
    } finally { await lock.release() }
    const checkCurrent = async () => {
      if (configurationDigest(service.config.resolve()) !== digest) throw new MaitianError('CONFIG_CHANGED', '浏览器配置已变化，请重新检查并确认')
      freshPreflight(preflight, options, engineRef, platform)
      if (await accountEpoch(options.profileDir, platform) !== preflight.accountEpoch) throw new MaitianError('ACCOUNT_CHANGED', '登录状态已变化，请重新预检并核对账号')
    }
    await service.snapshots.withWorkspace(service.store, storage => snapshotProject({
      store: service.store, projectsRoot: join(service.config.root, 'runs'), engineRef, contract,
      id, revision, platform, inspect: service.inspect,
      validate: input => service.run({ nodePath: options.nodePath, op: 'validate', ...input }),
      onReserve: storage.onReserve, beforeCopy: storage.checkCapacity, onReady: storage.onReady,
      onCapture: async ({ copy }) => {
        checkSelection(copy)
        await checkCurrent()
      },
      beforeCommit: async () => {
        await checkCurrent()
        const latest = await discoverEngine(service.config.resolve())
        if (latest.fingerprint !== engineRef.fingerprint) throw componentChanged()
      },
      onCommit: async ({ root, manifest, data, copy }) => {
        await checkCurrent()
        const now = new Date().toISOString()
        prepared = {
          provider: 'maitian', itemId: id, taskId, platform, status: 'prepared',
          preparedAt: now, updatedAt: now, expiresAt: Math.min(Date.now() + 15 * 60_000, checkedAt + PREFLIGHT_MS),
          projectId: manifest.snapshotId, projectDigest: manifest.projectDigest, profileId: options.profileId,
          engineVersion: engineRef.version, engineFingerprint: engineRef.fingerprint, contractVersion: contract.contractVersion,
          querySupported: Boolean(contract.platforms[platform]?.canCollectLinks),
          configurationDigest: digest, accountEpoch: preflight.accountEpoch,
          plan: {
            limits: { fillTimeoutMinutes: options.fillTimeoutMinutes, stopGraceSeconds: 30 },
            revision, draft: { title: copy.title, description: copy.description, tags: copy.tags,
              shortTitle: copy.browser?.shortTitle || '', mode: copy.mode, when: copy.when, timezone: copy.timezone,
              ...(data.schedule && { schedule: data.schedule }) },
            account: { label: account.label, verification: 'user-confirmed', confirmedAt: now, identityLimitAcknowledged: true, preflightOperationId: preflight.operationId },
            assets: manifest.assets, warnings: manifest.warnings, data,
          },
        }
        const records = await readPublishRecords(root)
        // Only replace this provider's prepared record; never remove another provider's task.
        const keep = records.filter(row => providerOf(row) !== 'maitian' || row.status !== 'prepared' || row.itemId !== id || row.platform !== platform)
        await writePublishRecords(root, [...keep, prepared])
      },
    }))
  })
  return preparationView(prepared)
}
