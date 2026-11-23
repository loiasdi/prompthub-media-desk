import { lstat, mkdir, readFile, readdir, realpath, rename, rm, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { executingRecord, providerOf } from '../records.js'
import { processIdentity } from './profile-lock.js'
import { TASK_ID } from './task-project.js'
import { MaitianError } from './errors.js'

const DIGEST = /^[a-f0-9]{64}$/
const MAX_ENTRIES = 20_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const absolute = value => typeof value === 'string' && isAbsolute(value)
const digest = value => value === null || DIGEST.test(value || '')
export const ownershipError = () => new MaitianError('SNAPSHOT_STORAGE_UNSAFE', '运行素材目录无法安全检查，请保留原文件并检查本机存储', 507)

export function validSnapshotOwner(owner, id) {
  return owner?.version === 1 && TASK_ID.test(id) && owner.projectId === id && absolute(owner.workspaceRoot) && digest(owner.projectDigest)
}

export async function readSnapshotOwner(root, id) {
  if (!TASK_ID.test(id)) throw ownershipError()
  try {
    const folder = join(root, 'snapshot-owners')
    if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== join(await realpath(root), 'snapshot-owners')) throw ownershipError()
    const path = join(root, 'snapshot-owners', `${id}.json`), info = await lstat(path)
    if (!info.isFile() || info.size > 16_000) throw ownershipError()
    const owner = JSON.parse(await readFile(path, 'utf8'))
    if (!validSnapshotOwner(owner, id)) throw ownershipError()
    return owner
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw ownershipError()
  }
}

// This private index changes ownership for a whole verified migration in one atomic write.
// Ordinary workspace copies do not carry it. Paths are never put in portable publish records.
export async function readSnapshotTransfers(root) {
  try {
    const path = join(root, 'snapshot-transfers.json'), info = await lstat(path)
    if (!info.isFile() || info.size > 12_000_000) throw ownershipError()
    const index = JSON.parse(await readFile(path, 'utf8'))
    if (index?.version !== 1 || !object(index.owners) || Object.keys(index.owners).length > MAX_ENTRIES) throw ownershipError()
    for (const [id, entry] of Object.entries(index.owners)) {
      if (!TASK_ID.test(id) || !object(entry) || !absolute(entry.originalWorkspaceRoot) || !absolute(entry.workspaceRoot) || !digest(entry.projectDigest) ||
          !TASK_ID.test(entry.transfer?.id || '') || !absolute(entry.transfer?.from) || !Number.isFinite(Date.parse(entry.transfer?.at))) throw ownershipError()
    }
    return index
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, owners: {} }
    throw ownershipError()
  }
}

export function effectiveSnapshotRoot(owner, index) {
  const entry = index.owners[owner.projectId]
  if (!entry) return owner.workspaceRoot
  if (entry.originalWorkspaceRoot !== owner.workspaceRoot || entry.projectDigest !== owner.projectDigest) throw ownershipError()
  return entry.workspaceRoot
}

async function writeTransfers(root, index) {
  const bytes = JSON.stringify(index)
  if (Buffer.byteLength(bytes) > 12_000_000 || Object.keys(index.owners).length > MAX_ENTRIES) throw ownershipError()
  const temporary = join(root, `.snapshot-transfers-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await rename(temporary, join(root, 'snapshot-transfers.json'))
    if (process.platform !== 'win32') {
      const directory = await open(root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally { await rm(temporary, { force: true }) }
}

export async function assertSnapshotRelocationStopped(records) {
  for (const record of records) {
    if (providerOf(record) !== 'maitian') continue
    if (executingRecord(record)) throw new MaitianError('TASK_BUSY', '有投稿任务正在进行，请完成后再更换目录')
    for (const lease of [record.lease, record.reviewLease]) {
      if (!lease?.runner) continue
      if (!Number.isInteger(lease.runner.pid) || lease.runner.pid <= 0 || !lease.runner.identity || await processIdentity(lease.runner.pid) === lease.runner.identity) {
        throw new MaitianError('TASK_BUSY', '原执行进程仍存活，请先完成停止与核对')
      }
    }
  }
}

// Caller holds the machine snapshot lock and source Store lock through commit. At commit,
// the published, verified destination is also locked and has not yet been activated.
export async function prepareWorkspaceSnapshotTransfer(root, source, records) {
  const index = await readSnapshotTransfers(root)
  const sourceRoot = await realpath(source)
  await assertSnapshotRelocationStopped(records)
  const owners = new Map()
  let names = []
  try {
    const folder = join(root, 'snapshot-owners')
    if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== join(await realpath(root), 'snapshot-owners')) throw ownershipError()
    names = await readdir(folder)
    if (names.length > MAX_ENTRIES) throw ownershipError()
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of names) {
    if (!name.endsWith('.json') || !TASK_ID.test(name.slice(0, -5))) continue
    let owner
    try { owner = await readSnapshotOwner(root, name.slice(0, -5)) } catch { continue }
    if (owner && effectiveSnapshotRoot(owner, index) === sourceRoot) owners.set(owner.projectId, owner)
  }
  for (const record of records) {
    if (providerOf(record) !== 'maitian') continue
    const owner = owners.get(record.projectId)
    if (owner && owner.projectDigest === record.projectDigest) continue
    // A copied history cannot transfer another workspace's snapshot. Legacy media with
    // no ownership proof must be resolved in its original workspace before migration.
    let present = false
    if (TASK_ID.test(record.projectId || '')) {
      try { await lstat(join(root, 'runs', record.projectId)); present = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (present) throw new MaitianError('SNAPSHOT_RELOCATION_UNPROVEN', '部分任务副本归属无法确认，请先在原工作区核对并归档后再迁移')
  }
  return async (target, transfer) => {
    const targetRoot = await realpath(target)
    if (sourceRoot === targetRoot || !TASK_ID.test(transfer?.id || '') || !Number.isFinite(Date.parse(transfer?.at))) throw ownershipError()
    for (const owner of owners.values()) {
      index.owners[owner.projectId] = { originalWorkspaceRoot: owner.workspaceRoot, projectDigest: owner.projectDigest, workspaceRoot: targetRoot,
        transfer: { id: transfer.id, at: transfer.at, from: sourceRoot } }
    }
    if (owners.size) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeTransfers(root, index)
    }
    return { transferred: owners.size }
  }
}

// Caller holds the machine snapshot lock, after the owned snapshot and journal are removed.
export async function forgetSnapshotTransfer(root, projectId) {
  const index = await readSnapshotTransfers(root)
  if (Object.hasOwn(index.owners, projectId)) {
    delete index.owners[projectId]
    await writeTransfers(root, index)
  }
}
