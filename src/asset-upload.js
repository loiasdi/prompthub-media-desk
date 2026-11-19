import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tr } from './i18n.js'

const uuid = '[\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12}'
const uploads = new RegExp(`^upload-([1-9]\\d{0,9})-${uuid}$`)
const legacyPart = new RegExp(`^${uuid}\\.part$`)
const lastCleanup = new Map()
const missing = err => { if (err.code !== 'ENOENT') throw err; return null }
const error = (message, status) => Object.assign(new Error(tr(message)), { status })

function ownerIsAlive(name) {
  const pid = Number(uploads.exec(name)?.[1])
  if (!pid || pid > 0x7fff_ffff) return false
  try { process.kill(pid, 0); return true }
  catch (err) { if (err.code === 'ESRCH') return false; if (err.code === 'EPERM') return true; throw err }
}

async function pendingEntries(root) {
  const path = join(root, 'pending')
  const info = await lstat(path).catch(missing)
  if (!info) return []
  if (!info.isDirectory()) throw error('素材临时目录无效', 409)
  return readdir(path, { withFileTypes: true }).catch(err => missing(err) ?? [])
}

async function cleanPendingUploads(root) {
  const now = Date.now()
  if (now - (lastCleanup.get(root) ?? 0) < 3600000) return
  const entries = await pendingEntries(root)
  for (const entry of entries) {
    const staged = entry.isDirectory() && uploads.test(entry.name)
    if (!staged && !(entry.isFile() && legacyPart.test(entry.name))) continue
    if (staged && ownerIsAlive(entry.name)) continue
    const path = join(root, 'pending', entry.name)
    const info = await lstat(path).catch(missing)
    if (info && now - info.mtimeMs > 86400000) await rm(path, { recursive: staged, force: true })
  }
  lastCleanup.set(root, now)
}

// Called while holding the source workspace lock. Uploads create their staging
// directories under the same lock, so this works across local Host processes.
export async function assertNoAssetUploads(root) {
  const entries = await pendingEntries(root)
  if (entries.some(entry => entry.isDirectory() && ownerIsAlive(entry.name))) {
    throw error('有素材正在导入，请完成后再更换目录', 409)
  }
}

export function assertUploadRoot(store, root) {
  if (store.root !== root) throw error('工作台目录已更换，请重新选择文件导入', 409)
}

export async function withAssetUpload(store, run) {
  const root = store.root
  const token = randomUUID()
  const pending = join(root, 'pending')
  const dir = join(pending, `upload-${process.pid}-${token}`)
  let staged = false
  try {
    const state = await store.run(async () => {
      assertUploadRoot(store, root)
      await store.refresh()
      await store.cleanupTrash()
      await mkdir(pending, { recursive: true })
      if (!(await lstat(pending)).isDirectory()) throw error('素材临时目录无效', 409)
      await mkdir(dir, { mode: 0o700 })
      staged = true
      return store.state
    })
    await cleanPendingUploads(root)
    return await run({ root, dir, token, state })
  } catch (err) {
    if (err.code === 'ENOSPC') throw error('磁盘空间不足，未导入此文件', 507)
    throw err
  } finally {
    if (staged) await rm(dir, { recursive: true, force: true })
  }
}
