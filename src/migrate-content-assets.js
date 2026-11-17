import { copyFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { contentAssetDirectory } from './asset-storage.js'
import { writeObsidianNotes } from './obsidian-notes.js'

export async function migrateContentAssets(store) {
  return store.run(async () => {
    await store.refresh()
    const result = await archiveContentAssets(store)
    if (store.markdown) await writeObsidianNotes(store.root, store.state)
    return result
  })
}

// 调用方持有 Store 锁；上传文件确定归属后，在保存内容时完成归档。
export async function archiveContentAssets(store) {
    const migrated = new Set()
    let copies = 0
    for (const item of store.state.items) {
      const names = new Set()
      const visit = value => {
        if (typeof value === 'string') {
          const match = /^media-desk\/files\/([\w-][\w.-]*)$/.exec(value)
          if (match) names.add(match[1])
        } else if (value && typeof value === 'object') Object.values(value).forEach(visit)
      }
      visit(item)
      for (const name of names) {
        const source = join(store.filesDir, name)
        const original = await readFile(source).catch(err => { if (err.code !== 'ENOENT') throw err; return null })
        if (!original) continue
        const target = join(await contentAssetDirectory(store.root, item.id), name)
        await copyFile(source, target, constants.COPYFILE_EXCL).catch(err => { if (err.code !== 'EEXIST') throw err })
        if (!(await readFile(target)).equals(original)) throw new Error(`素材迁移校验失败：${name}`)
        migrated.add(source)
        copies++
      }
    }
    // 所有归属副本均完成校验后才移除混放文件；共享文件在各稿件下分别保留。
    for (const source of migrated) await unlink(source)
    return { files: migrated.size, copies }
}
