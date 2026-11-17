import { mkdir, readdir, readFile, rename, realpath, lstat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const exists = path => lstat(path).catch(err => { if (err.code !== 'ENOENT') throw err; return null })
const safeId = id => /^[\w-]+$/.test(id)
const readIndex = async root => JSON.parse(await readFile(join(root, '回收站', '.index.json'), 'utf8').catch(err => { if (err.code !== 'ENOENT') throw err; return '{}' }))
async function saveIndex(root, index) {
  const path = join(root, '回收站', '.index.json')
  await writeFile(`${path}.tmp`, JSON.stringify(index))
  await rename(`${path}.tmp`, path)
}

// 删除与撤销共用目录生命周期。保留外部编辑和素材，不永久删除用户文件。
export async function reconcileContentFolders(root, items, previousIds = []) {
  const base = await realpath(root)
  const content = join(root, '内容')
  const trash = join(root, '回收站', '内容')
  const live = new Set(items.map(item => item.id))
  const known = new Set(previousIds)
  const index = await readIndex(root)
  const ensure = async path => {
    await mkdir(path, { recursive: true })
    if (await realpath(path) !== join(base, path.slice(root.length + 1))) throw new Error('内容目录不能是符号链接')
  }
  await ensure(content)
  if (await exists(trash)) await ensure(trash)
  let moved = 0
  let restored = 0
  for (const id of live) {
    if (!safeId(id)) continue
    const source = join(trash, id)
    if (!await exists(source)) continue
    await ensure(trash)
    if ((await lstat(source)).isSymbolicLink()) throw new Error('内容目录不能是符号链接')
    if (await exists(join(content, id))) throw new Error(`恢复稿件目录冲突：${id}`)
    await rename(source, join(content, id))
    delete index[id]
    restored++
  }
  for (const entry of await readdir(content, { withFileTypes: true })) {
    const id = entry.name
    if (!safeId(id) || !entry.isDirectory() || live.has(id)) continue
    // 历史遗留目录须带工作台生成的标记；不移动用户自行建立的目录。
    if (!known.has(id)) {
      let managed = false
      for (const name of ['灵感.md', '稿件.md']) {
        const text = await readFile(join(content, id, name), 'utf8').catch(err => { if (err.code !== 'ENOENT') throw err; return '' })
        if (text.includes(`\nmedia_desk_id: ${JSON.stringify(id)}\n`)) { managed = true; break }
      }
      if (!managed) continue
    }
    await ensure(trash)
    if (await exists(join(trash, id))) throw new Error(`回收站目录冲突：${id}`)
    await rename(join(content, id), join(trash, id))
    index[id] = { deletedAt: new Date().toISOString() }
    moved++
  }
  if (moved || restored) await saveIndex(root, index)
  return { moved, restored }
}

// 启动、定时以及读写内容时调用。旧回收站首次登记从现在计时。
export async function purgeExpiredContent(root, items, days, now = Date.now()) {
  if (![1, 3, 7, 15].includes(days)) throw new Error('回收站保留时间无效')
  const trash = join(root, '回收站', '内容')
  if (!await exists(trash)) return []
  if (await realpath(trash) !== join(await realpath(root), '回收站', '内容')) throw new Error('回收站不能是符号链接')
  const index = await readIndex(root)
  const live = new Set(items.map(item => item.id))
  const removed = []
  let changed = false
  for (const entry of await readdir(trash, { withFileTypes: true })) {
    const id = entry.name
    if (!entry.isDirectory() || !safeId(id) || live.has(id)) continue
    const deleted = Date.parse(index[id]?.deletedAt)
    if (!Number.isFinite(deleted)) {
      index[id] = { deletedAt: new Date(now).toISOString() }
      changed = true
    } else if (now - deleted >= days * 86400000) {
      await rm(join(trash, id), { recursive: true })
      index[id] = { ...index[id], purgedAt: new Date(now).toISOString() }
      removed.push(id)
      changed = true
    }
  }
  if (changed) await saveIndex(root, index)
  return removed
}

export async function purgedContentIds(root) {
  return new Set(Object.entries(await readIndex(root)).filter(([, value]) => value?.purgedAt).map(([id]) => id))
}
