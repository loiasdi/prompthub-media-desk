import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { applyOps } from '../src/ops.js'
import { reconcileContentFolders, purgeExpiredContent } from '../src/content-folders.js'
import { Settings } from '../src/settings.js'

test('删除稿件将完整目录移入回收站，撤销后恢复素材和 Obsidian 手改内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-folder-delete-'))
  try {
    const store = new Store(root, { markdown: true })
    await store.mutate('创建', state => {
      state.items = [{ id: 'piece', title: '稿件', body: '原稿' }]
    }, { undoable: false })
    const folder = join(root, '内容', 'piece')
    await mkdir(join(folder, '素材'))
    await writeFile(join(folder, '素材', 'ref.png'), '图片内容')
    await writeFile(join(folder, '稿件.md'), 'Obsidian 的手动编辑')
    await store.mutate('删除', state => assert.deepEqual(applyOps(state, [{ op: 'delete_item', id: 'piece' }]).errors, []))
    await assert.rejects(access(folder), { code: 'ENOENT' })
    const trash = join(root, '回收站', '内容', 'piece')
    assert.equal(await readFile(join(trash, '素材', 'ref.png'), 'utf8'), '图片内容')
    assert.equal(await readFile(join(trash, '稿件.md'), 'utf8'), 'Obsidian 的手动编辑')
    assert.equal((await new Store(root).read()).items.length, 0)
    await store.undoLast()
    assert.equal((await store.read()).items[0].id, 'piece')
    assert.equal(await readFile(join(folder, '素材', 'ref.png'), 'utf8'), '图片内容')
    assert.equal(await readFile(join(folder, '稿件.md'), 'utf8'), 'Obsidian 的手动编辑')
    await assert.rejects(access(trash), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('清理历史删除目录只识别工作台目录，可重复执行，不移动自建目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-folder-orphan-'))
  try {
    for (const id of ['deleted', 'personal', 'live']) await mkdir(join(root, '内容', id), { recursive: true })
    await writeFile(join(root, '内容', 'deleted', '稿件.md'), '---\nmedia_desk_id: "deleted"\n---\n')
    await writeFile(join(root, '内容', 'personal', '笔记.md'), '自己的资料')
    assert.deepEqual(await reconcileContentFolders(root, [{ id: 'live' }]), { moved: 1, restored: 0 })
    await access(join(root, '内容', 'personal'))
    await access(join(root, '内容', 'live'))
    await access(join(root, '回收站', '内容', 'deleted'))
    assert.deepEqual(await reconcileContentFolders(root, [{ id: 'live' }]), { moved: 0, restored: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('回收站按删除时间和 1/3/7/15 天保留设置到期清理，旧内容首次计时且保护现存稿件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-trash-ttl-'))
  try {
    const now = Date.parse('2026-11-18T00:00:00Z')
    const index = {}
    for (const id of ['expired', 'recent', 'legacy', 'live']) {
      await mkdir(join(root, '回收站', '内容', id), { recursive: true })
      if (id !== 'legacy') index[id] = { deletedAt: new Date(now - (id === 'recent' ? 0.5 : 20) * 86400000).toISOString() }
    }
    await writeFile(join(root, '回收站', '.index.json'), JSON.stringify(index))
    assert.deepEqual(await purgeExpiredContent(root, [{ id: 'live' }], 7, now), ['expired'])
    await access(join(root, '回收站', '内容', 'legacy'))
    await access(join(root, '回收站', '内容', 'live'))
    assert.deepEqual(await purgeExpiredContent(root, [{ id: 'live' }], 1, now + 86400000), ['legacy', 'recent'])
    const settings = new Settings(root)
    for (const days of [1, 3, 7, 15]) assert.equal((await settings.update({ trashRetentionDays: days })).trashRetentionDays, days)
    await assert.rejects(settings.update({ trashRetentionDays: 2 }), /保留时间/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('其他窗口彻底清理后，旧窗口不能撤销出没有文件的稿件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-trash-undo-'))
  try {
    const store = new Store(root, { markdown: true })
    await store.mutate('创建', state => { state.items = [{ id: 'piece', title: '稿件' }] })
    await store.mutate('删除', state => { state.items = [] })
    const other = new Store(root)
    await other.run(async () => {
      await other.refresh()
      assert.ok((await purgeExpiredContent(root, other.state.items, 7, Date.now() + 8 * 86400000)).includes('piece'))
    })
    await assert.rejects(store.undoLast(), /彻底删除/)
    assert.equal((await store.read()).items.length, 0)
    await assert.rejects(access(join(root, '内容', 'piece')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
