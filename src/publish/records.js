import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '../workspace-schema.js'
import { assertNoPublishActivities } from './activity.js'
import { retryApproved } from './record-policy.js'

const API_BLOCKED = new Set(['publishing', 'pending_review', 'unknown', 'published'])
const BROWSER_EXECUTING = new Set(['queued', 'preflighting', 'uploading', 'filling'])
export const providerOf = record => record?.provider ?? 'api'
// Keep the existing API execution deadline separate from browser process ownership.
export const activeRecord = record => providerOf(record) === 'api' && record?.status === 'publishing' && Date.now() < record.deadline
export const executingRecord = record => providerOf(record) === 'api' ? activeRecord(record)
  : Boolean(record?.lease && !record.lease.stoppedAt || record?.reviewLease && !record.reviewLease.stoppedAt || BROWSER_EXECUTING.has(record?.status))

export function blocksDuplicate(record) {
  if (providerOf(record) === 'api') return API_BLOCKED.has(record?.status)
  if (record?.lease && !record.lease.stoppedAt || record?.reviewLease && !record.reviewLease.stoppedAt) return true
  if (record?.status === 'prepared') return false
  if (['failed', 'cancelled'].includes(record?.status)) return Boolean(record.executionIntentAt && !retryApproved(record))
  // Unrecognised browser states and rejected results stay blocked until explicitly reconciled.
  return true
}
export function blocksStorageSwitch(record) {
  if (providerOf(record) === 'api') return activeRecord(record)
  if (executingRecord(record)) return true
  if (['prepared', 'published'].includes(record?.status) || !blocksDuplicate(record)) return false
  const archive = record?.archive
  return !(record?.archivedAt && archive?.at === record.archivedAt && archive.automationStopped === true &&
    archive.pagesResolved === true && archive.snapshotReleased === true)
}
export function visibleRecord(record) {
  if (providerOf(record) !== 'api') return record
  const result = record?.status === 'publishing' && !activeRecord(record)
    ? { ...record, status: 'unknown', message: '投稿中断，无法确认结果。请先在平台创作中心核对。' } : record
  return result?.coverResult?.status === 'pending' && !activeRecord(record)
    ? { ...result, coverResult: { status: 'unknown', message: '视频回执已保存，但缩略图设置结果未确认，请在平台创作中心核对；不要重新上传视频。' } } : result
}

const object = value => value && typeof value === 'object' && !Array.isArray(value)
async function readDocument(root) {
  const path = join(root, '.publish-records.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 20_000_000) throw Error('unsafe')
    const bytes = await readFile(path)
    const data = JSON.parse(bytes)
    if (![1, 2].includes(data?.version) || !Array.isArray(data.records) || data.records.some(row => !object(row) ||
      !['api', 'maitian'].includes(providerOf(row)) || data.version === 1 && providerOf(row) !== 'api')) throw Error('invalid')
    return { ...data, bytes }
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, records: [], bytes: null }
    throw fail('发布记录无法安全读取', 500)
  }
}

// Operations are called under the same cross-Host Store lock as revisions and directory migration.
export async function readPublishRecords(root) { return (await readDocument(root)).records }

// Caller holds Store.run. Preserve exact bytes before an explicit recovery changes any record.
export async function backupPublishRecords(root) {
  const current = await readDocument(root)
  if (!current.bytes) throw fail('发布记录不存在，无法建立核对备份', 409)
  const backupFile = `.publish-records.recovery-${randomUUID()}.backup.json`
  await atomicWrite(root, backupFile, current.bytes)
  return { backupFile, sourceDigest: createHash('sha256').update(current.bytes).digest('hex') }
}

async function atomicWrite(root, filename, payload) {
  const path = join(root, filename)
  const temp = join(root, `.state-lock-publish-${randomUUID()}.tmp`)
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(payload)
      await file.sync()
    } finally { await file.close() }
    await rename(temp, path)
    if (process.platform !== 'win32') {
      const dir = await open(root, 'r')
      try { await dir.sync() } finally { await dir.close() }
    }
  } finally { await rm(temp, { force: true }) }
}

export async function writePublishRecords(root, records) {
  const current = await readDocument(root)
  if (!Array.isArray(records) || records.some(row => !object(row) || !['api', 'maitian'].includes(providerOf(row)))) throw fail('发布记录格式无法写入', 500)
  if (current.version === 1 && records.some(row => providerOf(row) !== 'api')) throw fail('请先升级发布记录格式后再使用浏览器任务', 409)
  const data = {
    version: current.version,
    ...(current.migration && { migration: current.migration }),
    records: current.version === 2 ? records.map(row => ({ ...row, provider: providerOf(row) })) : records,
  }
  await atomicWrite(root, '.publish-records.json', JSON.stringify(data))
}

// Caller must hold Store.run AND the chosen browser profile lock, acquired outside Store.run.
// No automatic downgrade or backup restoration is provided: that would lose duplicate protection.
export async function migratePublishRecords(root, { activityToken } = {}) {
  const current = await readDocument(root)
  if (current.version === 2) return current.records
  await assertNoPublishActivities(root, { exceptToken: activityToken })
  // Legacy records lack process identity. Even an expired deadline cannot prove process exit.
  if (current.records.some(row => row.status === 'publishing' || executingRecord(row))) throw fail('旧投稿尚未完成核对，请停止旧 Host 并处理投稿结果后再升级', 409)
  const backupFile = current.bytes ? `.publish-records.v1-${randomUUID()}.backup.json` : null
  if (backupFile) await atomicWrite(root, backupFile, current.bytes)
  const records = current.records.map(row => ({ ...row, provider: 'api' }))
  await atomicWrite(root, '.publish-records.json', JSON.stringify({
    version: 2, records,
    migration: { fromVersion: current.bytes ? 1 : null, migratedAt: new Date().toISOString(), backupFile,
      sourceDigest: current.bytes ? createHash('sha256').update(current.bytes).digest('hex') : null },
  }))
  return records
}
