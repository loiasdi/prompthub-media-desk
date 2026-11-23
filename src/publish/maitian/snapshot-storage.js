import { lstat, mkdir, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { executingRecord, providerOf, readPublishRecords, writePublishRecords } from '../records.js'
import { snapshotTerminal } from '../record-policy.js'
export { stampSnapshotTerminal } from '../record-policy.js'
import { acquireProfileLock, processIdentity } from './profile-lock.js'
import { releaseTaskSnapshot } from './snapshots.js'
import { TASK_ID } from './task-project.js'
import { MaitianError } from './errors.js'
import { readSnapshotOwner, readSnapshotTransfers, effectiveSnapshotRoot, forgetSnapshotTransfer } from './snapshot-ownership.js'

export const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60_000
export const SNAPSHOT_QUOTA_BYTES = 2 * 1024 ** 3
export const SNAPSHOT_DISK_RESERVE_BYTES = 500 * 1024 ** 2
const METADATA_BYTES = 2 * 1024 ** 2
const DIGEST = /^[a-f0-9]{64}$/

export async function checkSnapshotDisk(path, sizeBytes, { reserveBytes = SNAPSHOT_DISK_RESERVE_BYTES, disk = statfs } = {}) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw storageError()
  let free
  try { const info = await disk(path); free = Number(info.bavail) * Number(info.bsize) } catch { throw new MaitianError('SNAPSHOT_DISK_CHECK_FAILED', '无法检查运行素材的可用磁盘空间，请稍后重试', 507) }
  if (!Number.isFinite(free) || free < sizeBytes + METADATA_BYTES + reserveBytes) throw new MaitianError('SNAPSHOT_DISK_SPACE', '磁盘可用空间不足，无法保留安全余量并固定发布素材', 507)
}

async function releasable(records, now) {
  for (const record of records) {
    if (providerOf(record) !== 'maitian' || executingRecord(record) || record.archiveAttempt) return null
    for (const lease of [record.lease, record.reviewLease]) {
      if (!lease?.runner) continue
      if (!Number.isInteger(lease.runner.pid) || lease.runner.pid <= 0 || !lease.runner.identity || await processIdentity(lease.runner.pid) === lease.runner.identity) return null
    }
    if (record.snapshotReleasedAt) continue
    if (record.status === 'prepared' && !record.executionIntentAt && Number.isFinite(record.expiresAt) && record.expiresAt <= now) continue
    const at = Date.parse(record.snapshotTerminalAt)
    if (!snapshotTerminal(record) || !Number.isFinite(at) || now - at < SNAPSHOT_RETENTION_MS) return null
  }
  if (!records.length) return 'unreferenced'
  if (records.every(record => record.snapshotReleasedAt)) return 'already-released'
  return records.every(record => record.status === 'prepared') ? 'expired-preparation' : 'terminal-retention'
}

const storageError = () => new MaitianError('SNAPSHOT_STORAGE_UNSAFE', '运行素材目录无法安全检查，请保留原文件并检查本机存储', 507)
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory()) throw storageError()
}

async function usedBytes(folder, depth = 0, budget = { entries: 0 }) {
  if (depth > 4) throw storageError()
  let total = 0
  for (const name of await readdir(folder)) {
    if (++budget.entries > 20_000) throw storageError()
    const path = join(folder, name), info = await lstat(path)
    if (info.isDirectory()) total += await usedBytes(path, depth + 1, budget)
    else if (info.isFile() && Number.isSafeInteger(info.size)) total += info.size
    else throw storageError()
    if (!Number.isSafeInteger(total)) throw storageError()
  }
  return total
}

// One machine-wide lock serializes allocation and deletion across profiles and workspaces.
// The private journal proves ownership; unknown/legacy directories count toward quota but are never guessed at.
export class TaskSnapshotStorage {
  constructor(root, { quotaBytes = SNAPSHOT_QUOTA_BYTES, reserveBytes = SNAPSHOT_DISK_RESERVE_BYTES, disk = statfs, clock = Date.now } = {}) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new TypeError('Invalid snapshot storage policy')
    Object.assign(this, { root, quotaBytes, reserveBytes, disk, clock })
  }
  async withLock(run) {
    let lock
    try { lock = await acquireProfileLock(join(this.root, 'snapshot-storage'), join(this.root, 'storage-locks')) }
    catch (error) {
      if (error.code === 'PROFILE_BUSY') throw new MaitianError('SNAPSHOT_STORAGE_BUSY', '运行素材正在准备或清理，请稍后重试')
      throw error
    }
    try { return await run() } finally { await lock.release() }
  }
  async assertWorkspaceProject(workspace, record) {
    if (!TASK_ID.test(record?.projectId || '') || !DIGEST.test(record?.projectDigest || '')) throw storageError()
    const owner = await readSnapshotOwner(this.root, record.projectId)
    const index = await readSnapshotTransfers(this.root)
    // Pre-journal snapshots remain usable in place; migration cannot adopt existing legacy media.
    const proof = owner || index.owners[record.projectId]
    if (!proof) return
    const ownedRoot = owner ? effectiveSnapshotRoot(owner, index) : proof.workspaceRoot
    if (proof.projectDigest !== record.projectDigest || ownedRoot !== await realpath(workspace)) throw new MaitianError('SNAPSHOT_WORKSPACE_CHANGED', '固定素材属于其他工作区，请回原工作区处理；原任务仍可查询核对')
  }
  async withWorkspace(store, run) {
    return this.withLock(async () => {
      const root = await realpath(store.root)
      await directory(join(this.root, 'runs'))
      await directory(join(this.root, 'snapshot-owners'))
      const runs = join(await realpath(this.root), 'runs')
      if (await realpath(join(this.root, 'runs')) !== runs || await realpath(join(this.root, 'snapshot-owners')) !== join(await realpath(this.root), 'snapshot-owners')) throw storageError()
      const journal = id => join(this.root, 'snapshot-owners', `${id}.json`)
      const write = async owner => {
        const temporary = join(this.root, 'snapshot-owners', `.pending-${randomUUID()}`)
        try {
          await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
          await rename(temporary, journal(owner.projectId))
        } finally { await rm(temporary, { force: true }) }
      }
      const checkCapacity = async ({ sizeBytes = 0 } = {}) => {
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw storageError()
        if (await usedBytes(runs) + sizeBytes + METADATA_BYTES > this.quotaBytes) throw new MaitianError('SNAPSHOT_QUOTA_EXCEEDED', '运行素材已达到本机容量上限，请先核对并归档旧任务', 507)
        await checkSnapshotDisk(runs, sizeBytes, this)
      }
      const cleanup = async () => {
        const removed = [], retained = []
        const transfers = await readSnapshotTransfers(this.root)
        const names = await readdir(join(this.root, 'snapshot-owners'))
        if (names.length > 20_000) throw storageError()
        for (const name of names) {
          if (!name.endsWith('.json') || !TASK_ID.test(name.slice(0, -5))) continue
          let owner
          try {
            const info = await lstat(join(this.root, 'snapshot-owners', name))
            if (!info.isFile() || info.size > 16_000) continue
            owner = JSON.parse(await readFile(join(this.root, 'snapshot-owners', name), 'utf8'))
          } catch { continue }
          if (owner?.version !== 1 || owner.projectId !== name.slice(0, -5) || typeof owner.workspaceRoot !== 'string' || !isAbsolute(owner.workspaceRoot) || owner.projectDigest !== null && !DIGEST.test(owner.projectDigest || '')) continue
          if (effectiveSnapshotRoot(owner, transfers) !== root) continue
          await store.run(async () => {
            await store.refresh()
            if (await realpath(store.root) !== root) throw new MaitianError('WORKSPACE_CHANGED', '工作台目录已变化，请重新准备')
            const records = await readPublishRecords(store.root)
            const references = records.filter(record => record.projectId === owner.projectId)
            const reason = await releasable(references, this.clock())
            if (!reason || references.some(record => record.projectDigest !== owner.projectDigest)) { retained.push(owner.projectId); return }
            const at = new Date(this.clock()).toISOString()
            for (const record of references) record.snapshotCleanupAttempt = { reason, at }
            if (references.length) await writePublishRecords(store.root, records)
            // A crash before rename leaves only a journal-owned staging directory.
            const pending = join(runs, `.pending-${owner.projectId}`)
            try {
              if (!(await lstat(pending)).isDirectory() || await realpath(pending) !== pending) throw storageError()
              await rm(pending, { recursive: true, force: true })
            } catch (error) { if (error.code !== 'ENOENT') { retained.push(owner.projectId); return } }
            try {
              await releaseTaskSnapshot(this.root, owner)
            } catch { retained.push(owner.projectId); return }
            for (const record of references) {
              record.snapshotReleasedAt ||= at
              record.snapshotCleanup = { reason, at }
              delete record.snapshotCleanupAttempt
            }
            if (references.length) await writePublishRecords(store.root, records)
            await rm(journal(owner.projectId), { force: true })
            await forgetSnapshotTransfer(this.root, owner.projectId)
            removed.push(owner.projectId)
          })
        }
        return { removed, retained }
      }
      await cleanup()
      const session = {
        checkCapacity,
        onReserve: async ({ snapshotId, root: capturedRoot }) => {
          if (await realpath(capturedRoot) !== root) throw new MaitianError('WORKSPACE_CHANGED', '工作台目录已变化，请重新准备')
          await checkCapacity()
          await write({ version: 1, projectId: snapshotId, workspaceRoot: root, projectDigest: null })
        },
        onReady: async ({ manifest }) => {
          await checkCapacity()
          await write({ version: 1, projectId: manifest.snapshotId, workspaceRoot: root, projectDigest: manifest.projectDigest })
        },
        cleanup,
      }
      try { return await run(session) }
      finally { await cleanup() }
    })
  }
}
