import { storageLocation } from './storage-location.js'
import { writeObsidianNotes } from './obsidian-notes.js'
import { archiveContentAssets } from './migrate-content-assets.js'
import { reconcileContentFolders, purgeExpiredContent, purgedContentIds } from './content-folders.js'
import { Settings } from './settings.js'
// 持久化：可配置数据目录，默认 $DSH_HOME/media-desk。桌面端和 Web 端读同一份数据。
// 两个 Host 进程可能同时运行，所以每次写入前都按 mtime 判断是否需要重读。
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSeed, migrateState } from './seed.js'
import { registerWorkspaceSources } from './workspace-schema.js'

const MAX_UNDO = 30

async function removeLockOwner(lock, name) {
  // 文件名标识唯一的一次持有；过期观察只能清理该持有者，不能删掉后来取得的锁。
  if (name) await rm(join(lock, name), { force: true })
  try { await rmdir(lock) } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err
  }
}

async function recoverLock(lock) {
  let names
  try { names = await readdir(lock) } catch (err) { if (err.code === 'ENOENT') return; throw err }
  if (!names.length) return removeLockOwner(lock)
  for (const name of names) {
    // owner.json 兼容上一版遗留的锁；新版发布前就已写好唯一 owner 文件。
    if (name !== 'owner.json' && !/^owner-\d+-[\da-f-]+\.json$/.test(name)) continue
    try {
      const owner = JSON.parse(await readFile(join(lock, name), 'utf8'))
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid lock owner')
      try { process.kill(owner.pid, 0) } catch (err) {
        if (err.code === 'ESRCH') await removeLockOwner(lock, name)
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue
      const info = await stat(join(lock, name)).catch(() => null)
      if (info && Date.now() - info.mtimeMs > 60000) await removeLockOwner(lock, name)
    }
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyed = list => list.every(row => isObject(row) && typeof row.id === 'string')

function revertList(before, after, current) {
  const was = new Map(before.map(row => [row.id, row]))
  const now = new Map(after.map(row => [row.id, row]))
  // 这一步新增的行撤掉，两边都有的行逐字段撤回，其余（之后才加的）原样保留
  const result = current
    .filter(row => !(now.has(row.id) && !was.has(row.id)))
    .map(row => (was.has(row.id) && now.has(row.id) ? revertChange(was.get(row.id), now.get(row.id), row) : row))
  // 这一步删掉的行放回原来的位置
  const present = new Set(result.map(row => row.id))
  before.forEach((row, index) => {
    if (now.has(row.id) || present.has(row.id)) return
    result.splice(Math.min(index, result.length), 0, structuredClone(row))
    present.add(row.id)
  })
  return result
}

/**
 * 三方合并式撤销：只撤回这一步改过、之后又没被别的操作改动的部分。
 * 撤销「切换风格」不会抹掉之后生成的成稿；撤销「对话改标题」不会把之后画好的图退回去。
 * @param {*} before - 这一步之前的值。
 * @param {*} after - 这一步之后的值。
 * @param {*} current - 现在的值。
 * @returns {*} 撤销后的值。
 */
export function revertChange(before, after, current) {
  if (same(before, after)) return current
  if (same(current, after)) return before === undefined ? undefined : structuredClone(before)
  if (isObject(before) && isObject(after) && isObject(current)) {
    const result = { ...current }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = revertChange(before[key], after[key], current[key])
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    if (keyed(before) && keyed(after) && keyed(current) && (before.length || after.length)) return revertList(before, after, current)
    if (before.length === after.length && after.length === current.length) return current.map((row, index) => revertChange(before[index], after[index], row))
  }
  // 之后又被改过且无法逐项合并时，保留现在的值
  return current
}

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export class Store {
  constructor(root = storageLocation().root, { markdown = storageLocation().markdown && root === storageLocation().root } = {}) {
    this.markdown = markdown
    this.markdownError = null
    this.root = root
    this.file = join(root, 'state.json')
    this.filesDir = join(root, 'files')
    this.state = null
    this.mtimeMs = 0
    this.inode = 0
    this.undo = []
    this.queue = Promise.resolve()
    this.followLocation = root === storageLocation().root
    this.lastTrashCleanup = 0
  }

  useRoot(root, markdown = this.markdown) {
    if (this.root === root) return
    this.root = root
    this.file = join(root, 'state.json')
    this.filesDir = join(root, 'files')
    this.markdown = markdown
    this.state = null
    this.mtimeMs = 0
    this.inode = 0
    this.undo = []
    this.lastTrashCleanup = 0
  }

  async cleanupTrash(force = false) {
    if (!force && Date.now() - this.lastTrashCleanup < 60000) return
    const settings = await new Settings(this).read()
    const removed = await purgeExpiredContent(this.root, this.state.items, settings.trashRetentionDays)
    if (removed.length) this.undo = this.undo.filter(entry => !removed.some(id => [entry.before, entry.after].some(value => JSON.parse(value).items.some(item => item.id === id))))
    this.lastTrashCleanup = Date.now()
    return removed
  }

  async refresh() {
    await mkdir(this.filesDir, { recursive: true })
    let info = null
    try {
      info = await stat(this.file)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (!info) {
      this.state = buildSeed(new Date())
      await this.persist()
      return
    }
    if (this.state && info.mtimeMs === this.mtimeMs && info.ino === this.inode) return
    this.state = migrateState(JSON.parse(await readFile(this.file, 'utf8')))
    this.mtimeMs = info.mtimeMs
    this.inode = info.ino
  }

  async persist() {
    const previous = await readFile(this.file, 'utf8').catch(err => { if (err.code !== 'ENOENT') throw err; return '{}' })
    await reconcileContentFolders(this.root, this.state.items, (JSON.parse(previous).items || []).map(item => item.id))
    await archiveContentAssets(this)
    await this.cleanupTrash()
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.state))
    await rename(tmp, this.file)
    const info = await stat(this.file)
    this.mtimeMs = info.mtimeMs
    this.inode = info.ino
    if (this.markdown) {
      try { await writeObsidianNotes(this.root, this.state); this.markdownError = null }
      catch (err) { this.markdownError = err.message; console.error('Markdown 同步失败：', err.message) }
    }
  }

  /** 串行执行，避免同一进程内的并发写互相覆盖。 */
  run(task) {
    const next = this.queue.then(() => this.locked(task), () => this.locked(task))
    this.queue = next.catch(() => {})
    return next
  }

  // 两个 Host 或预览进程共享目录时，修订号的比较与落盘必须处于同一把锁内。
  async locked(task) {
    if (this.followLocation) { const location = storageLocation(); this.useRoot(location.root, location.markdown) }
    await mkdir(this.root, { recursive: true })
    const lock = join(this.root, '.state-lock')
    const token = randomUUID()
    const staging = join(this.root, `.state-lock-${token}`)
    const ownerName = `owner-${process.pid}-${token}.json`
    const deadline = Date.now() + 10000
    let acquired = false
    await mkdir(staging)
    try {
      await writeFile(join(staging, ownerName), JSON.stringify({ pid: process.pid }))
      for (;;) {
        // 原子发布非空目录：已有持有者时 rename 失败，不暴露尚未登记 owner 的空锁。
        try { await rename(staging, lock); acquired = true; break } catch (err) {
          if (!['ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err
        }
        await recoverLock(lock)
        if (Date.now() > deadline) throw Object.assign(new Error('内容存储正忙，请重试'), { status: 503 })
        await delay(30)
      }
      // 另一个进程可能在等待锁期间更换了目录。
      if (this.followLocation && storageLocation().root !== this.root) return await this.locked(task)
      return await task()
    } finally {
      if (acquired) await removeLockOwner(lock, ownerName)
      else await rm(staging, { recursive: true, force: true })
    }
  }

  read() {
    return this.run(async () => {
      await this.refresh()
      await this.cleanupTrash()
      return this.state
    })
  }

  /**
   * @param {string} label - 显示在撤销入口上的说明。
   * @param {(state: object) => any} mutate - 就地修改状态。
   * @param {{undoable?: boolean}} [options]
   * @returns {Promise<any>} mutate 的返回值。
   */
  mutate(label, mutate, { undoable = true } = {}) {
    return this.run(async () => {
      await this.refresh()
      const before = JSON.stringify(this.state)
      let result
      let after
      try {
        result = await mutate(this.state)
        for (const item of this.state.items) registerWorkspaceSources(item)
        after = JSON.stringify(this.state)
        await this.persist()
      } catch (err) { this.state = JSON.parse(before); throw err }
      if (undoable) {
        // 什么都没改的操作不占撤销位，免得用户点撤销却没反应
        if (after !== before) {
          this.undo.push({ label, before, after })
          if (this.undo.length > MAX_UNDO) this.undo.shift()
        }
      }
      return result
    })
  }

  undoLast() {
    return this.run(async () => {
      await this.refresh()
      await this.cleanupTrash()
      const entry = this.undo.pop()
      if (!entry) return null
      const restored = revertChange(JSON.parse(entry.before), JSON.parse(entry.after), this.state)
      const purged = await purgedContentIds(this.root)
      const live = new Set(this.state.items.map(item => item.id))
      if (restored.items.some(item => !live.has(item.id) && purged.has(item.id))) throw Object.assign(new Error('稿件已超过回收站保留时间并彻底删除，无法撤销'), { status: 409 })
      this.state = restored
      await this.persist()
      return entry.label
    })
  }
}
