import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'

test('Obsidian 目录保存 JSON、Markdown 与素材链接，外部编辑不会被覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-desk-'))
  try {
    const store = new Store(root, { markdown: true })
    await store.mutate('创建稿件', state => { state.items = [{ id: 'piece', title: '灵感', production: { title: '标题', description: '简介', topics: '#话题', article: '稿件正文' }, workspace: { promptText: '视频提示词原文', assets: [{ id: 'file', name: '参考图.png', src: 'media-desk/files/ref.png', type: 'image' }], hidden: [], coverDesign: { variants: { '3:4': { prompt: '竖版封面提示词' } } } } }] }, { undoable: false })
    assert.equal(store.markdownError, null)
    const folder = join(root, '内容', 'piece')
    assert.ok((await readFile(join(folder, '稿件.md'), 'utf8')).includes('稿件正文'))
    assert.ok((await readFile(join(folder, '视频提示词.md'), 'utf8')).includes('视频提示词原文'))
    assert.ok((await readFile(join(folder, '封面设计.md'), 'utf8')).includes('竖版封面提示词'))
    assert.ok((await readFile(join(folder, '素材.md'), 'utf8')).includes('../../files/ref.png'))
    await writeFile(join(folder, '稿件.md'), 'Obsidian 中的手动修改')
    await store.mutate('更新稿件', state => { state.items[0].production.article = '工作台的新正文' }, { undoable: false })
    assert.equal(await readFile(join(folder, '稿件.md'), 'utf8'), 'Obsidian 中的手动修改')
    const names = (await readdir(folder)).filter(name => name.includes('稿件.工作台更新'))
    assert.equal(names.length, 1)
    assert.ok((await readFile(join(folder, names[0]), 'utf8')).includes('工作台的新正文'))
    await store.mutate('重复同步', () => {}, { undoable: false })
    assert.equal((await readdir(folder)).filter(name => name.includes('稿件.工作台更新')).length, 1)
    assert.equal((await new Store(root).read()).items[0].production.article, '工作台的新正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})
