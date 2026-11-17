import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps } from '../src/ops.js'
import { buildSeed } from '../src/seed.js'
import { Store } from '../src/store.js'
import { emptyWorkspace, sourceAssets } from '../src/workspace-schema.js'
import { storedAssetPath } from '../src/asset-storage.js'

const mediaItems = [
  { src: 'media-desk/files/ref-a.png', kind: 'image', name: '参考图.png' },
  { src: 'media-desk/files/ref-b.mp4', kind: 'video', name: '参考视频.mp4' },
  { src: 'media-desk/files/ref-c.jpg', kind: 'image', name: '参考图二.jpg' },
]
const capture = { op: 'add_item', kind: 'image', title: '一组灵感', media: { src: mediaItems[0].src }, mediaItems }

test('一条灵感保存多个图片和视频，过滤非法地址并去重，封面不会重复登记', () => {
  const state = buildSeed(new Date())
  state.items = []
  const result = applyOps(state, [{ ...capture, mediaItems: [...mediaItems, mediaItems[0], { src: 'javascript:alert(1)' }, null] }])
  assert.deepEqual(result.errors, [])
  assert.equal(state.items.length, 1)
  assert.deepEqual(state.items[0].mediaItems, mediaItems)
  const assets = sourceAssets(state.items[0])
  assert.equal(assets.length, 3)
  assert.deepEqual(assets.map(a => [a.src, a.type, a.name]), mediaItems.map(a => [a.src, a.kind, a.name]))
  assert.deepEqual(emptyWorkspace(state.items[0]).assets, assets)
})

test('多素材灵感重新打开存储后仍完整保留，并属于同一稿件的工作区', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspiration-media-'))
  try {
    const store = new Store(root)
    await store.read()
    for (const media of mediaItems) await writeFile(join(store.filesDir, media.src.split('/').pop()), media.name)
    await store.mutate('导入多素材', state => {
      state.items = []
      assert.deepEqual(applyOps(state, [capture]).errors, [])
      state.items[0].workspace = emptyWorkspace(state.items[0])
    })
    const state = await new Store(root).read()
    assert.equal(state.items.length, 1)
    assert.deepEqual(state.items[0].mediaItems, mediaItems)
    assert.deepEqual(state.items[0].workspace.assets.map(a => a.src), mediaItems.map(a => a.src))
    assert.deepEqual(await readdir(store.filesDir), [])
    for (const media of mediaItems) {
      const name = media.src.split('/').pop()
      const path = join(root, '内容', state.items[0].id, '素材', name)
      assert.equal(await readFile(path, 'utf8'), media.name)
      assert.equal(await storedAssetPath(store.filesDir, name), path)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
