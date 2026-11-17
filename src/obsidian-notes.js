import { mkdir, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { storedAssetPath, validAssetPath } from './asset-storage.js'
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(value).digest('hex')
const read = path => readFile(path, 'utf8').catch(err => { if (err.code === 'ENOENT') return null; throw err })

// 生成可读 Markdown。Obsidian 中的编辑永不被静默覆盖，工作台更新写入相邻文件。
export async function writeObsidianNotes(root, state) {
  const notes = join(root, '内容')
  await mkdir(notes, { recursive: true })
  if (await realpath(notes) !== join(await realpath(root), '内容')) throw new Error('Markdown 目录不能是符号链接')
  const manifestPath = join(root, '.markdown-manifest.json')
  const manifest = JSON.parse(await read(manifestPath) || '{}')
  const next = { ...manifest }
  const index = []
  for (const item of state.items || []) {
    if (!/^[\w-]+$/.test(item.id)) continue
    const p = item.production || {}
    const title = p.title || item.title || '未命名'
    index.push(`- [${title.replace(/[\[\]\n\r]/g, ' ')}](内容/${item.id}/稿件.md) · [素材](内容/${item.id}/素材.md)`)
    const folder = join(notes, item.id)
    await mkdir(folder, { recursive: true })
    if (await realpath(folder) !== join(await realpath(notes), item.id)) throw new Error('Markdown 目录不能是符号链接')
    const ws = item.workspace || {}
    const meta = `---\nmedia_desk_id: ${JSON.stringify(item.id)}\ntitle: ${JSON.stringify(title)}\n---\n\n`
    const assetLinks = await Promise.all((ws.assets || []).filter(a => !(ws.hidden || []).includes(a.id)).map(async a => {
      const source = a.src?.startsWith('media-desk/files/') ? a.src.slice(17) : ''
      if (!validAssetPath(source)) return ''
      let path
      try { path = await storedAssetPath(join(root, 'files'), source) }
      catch (err) { if (err.code !== 'ENOENT') throw err; path = join(root, 'files', source) }
      const url = relative(folder, path).split('/').map(encodeURIComponent).join('/')
      return `- [${(ws.edits?.[a.id]?.name || a.name || source).replace(/[\[\]\n\r]/g, ' ')}](${url})`
    }))
    const files = {
      '灵感.md': `${meta}# 灵感\n\n${ws.ideaText ?? item.body ?? ''}\n`,
      '大纲.md': `${meta}# 内容大纲\n\n${ws.outlineText || ''}\n`,
      '稿件.md': `${meta}# ${title}\n\n## 描述\n\n${p.description ?? ''}\n\n## 话题\n\n${p.topics ?? (item.tags || []).join(' ')}\n\n## 正文\n\n${p.article || item.body || ''}\n`,
      '视频提示词.md': `${meta}${ws.promptText ?? ''}\n`,
      '封面设计.md': `${meta}# ${ws.coverDesign?.title || title}\n\n${ws.coverDesign?.requirements || ''}\n\n${Object.entries(ws.coverDesign?.variants || {}).map(([ratio, v]) => `## ${ratio}\n\n${v.prompt || ''}`).join('\n\n')}\n\n${ws.coverPromptText || ''}\n`,
      '配图设计.md': `${meta}# 配图设计\n\n${(ws.coverDesign?.illustrations || []).map(row => `## ${row.title || '未命名配图'} · ${row.ratio}\n\n${row.requirements || ''}\n\n${row.prompt || ''}\n\n关联成图：${(row.imageIds || []).map(id => ws.assets?.find(a => a.id === id)?.name || id).join('、')}`).join('\n\n')}\n`,
      '素材.md': `${meta}# 素材\n\n${assetLinks.filter(Boolean).join('\n')}\n`,
    }
    for (const [name, text] of Object.entries(files)) await syncFile(`${item.id}/${name}`, join(folder, name), text)
  }
  await syncFile('内容索引.md', join(root, '内容索引.md'), `# 内容索引\n\n${index.join('\n')}\n`)
  async function syncFile(key, target, text) {
      if ((await lstat(target).catch(err => { if (err.code !== 'ENOENT') throw err }))?.isSymbolicLink()) throw new Error('Markdown 文件不能是符号链接')
      const existing = await read(target)
      if (existing === text) { next[key] = hash(text); return }
      if (existing !== null && hash(existing) !== manifest[key]) {
        const conflict = target.replace(/\.md$/, `.工作台更新-${hash(text).slice(0, 12)}.md`)
        await writeFile(conflict, text, { flag: 'wx' }).catch(err => { if (err.code !== 'EEXIST') throw err })
        return
      }
      const temp = `${target}.${process.pid}.tmp`
      await writeFile(temp, text)
      await rename(temp, target)
      next[key] = hash(text)
  }
  const temp = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(next))
  await rename(temp, manifestPath)
}
