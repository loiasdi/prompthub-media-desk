import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { Settings } from '../src/settings.js'
import { relocateStorage } from '../src/storage-management.js'
import { FeishuSync } from '../src/feishu/sync.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { route } from '../src/host.js'

test('更换文档目录迁移稿件素材回收站和设置，旧目录保留，飞书身份稳定且新保存使用新目录', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'desk-relocate-')))
  const root = join(base, 'old'), target = join(base, 'new'), configHome = join(base, 'config')
  const env = { DSH_HOME: configHome }
  try {
    const store = new Store(root, { markdown: true })
    const settings = new Settings(store)
    await store.mutate('', state => { state.items = [{ id: 'piece', title: '稿件' }] })
    await settings.update({ trashRetentionDays: 3 })
    await mkdir(join(root, '内容', 'piece', '素材'), { recursive: true })
    await writeFile(join(root, '内容', 'piece', '素材', 'test.jpg'), '真实素材')
    await mkdir(join(root, '回收站', '内容', 'deleted'), { recursive: true })
    await writeFile(join(root, '回收站', '内容', 'deleted', '稿件.md'), '已删除的稿件')
    const sync = new FeishuSync(store)
    const identity = sync.target({})
    assert.equal((await relocateStorage(store, target, { env })).moved, true)
    assert.equal(store.root, target)
    assert.equal(sync.target({}), identity)
    assert.equal((await settings.read()).trashRetentionDays, 3)
    assert.equal(await readFile(join(target, '内容', 'piece', '素材', 'test.jpg'), 'utf8'), '真实素材')
    assert.equal(await readFile(join(target, '回收站', '内容', 'deleted', '稿件.md'), 'utf8'), '已删除的稿件')
    assert.equal(JSON.parse(await readFile(join(configHome, 'media-desk-storage.json'))).root, target)
    await store.mutate('', state => { state.items[0].title = '新目录的改稿' })
    assert.equal((await new Store(target).read()).items[0].title, '新目录的改稿')
    assert.equal(JSON.parse(await readFile(join(root, 'state.json'))).items[0].title, '稿件')
    await assert.rejects(relocateStorage(store, join(target, 'nested'), { env }), /互相包含/)
    await assert.rejects(relocateStorage(store, root, { env }), /不是空目录/)
    await assert.rejects(relocateStorage(store, 'relative-path', { env }), /绝对路径/)
    assert.equal((await relocateStorage(store, target, { env })).moved, false)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('设置 API 显示实际文档目录，修改保留天数并拒绝不支持的天数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-storage-api-'))
  const store = new Store(root)
  const desk = { settings: new Settings(store) }
  const ctx = { get: () => null }
  const server = createServer((req, res) => route(ctx, store, desk, req, res).catch(err => { res.writeHead(err.status || 500); res.end(JSON.stringify({ error: err.message })) }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/media-desk/settings`
  try {
    const settings = await (await fetch(url)).json()
    assert.equal(settings.documentDir, root)
    assert.equal(settings.trashRetentionDays, 7)
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ documentDir: root, trashRetentionDays: 15 }) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).trashRetentionDays, 15)
    assert.equal((await new Settings(store).read()).trashRetentionDays, 15)
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ trashRetentionDays: 30 }) })).status, 400)
    const failed = await fetch(url, { method: 'POST', body: JSON.stringify({ documentDir: join(root, 'nested'), trashRetentionDays: 1, language: 'en' }) })
    assert.equal(failed.status, 400)
    assert.equal((await new Settings(store).read()).trashRetentionDays, 15)
    assert.equal((await new Settings(store).read()).language, 'auto')
    desk.producer = { assets: new Set(['piece:cover']) }
    const busy = await fetch(url, { method: 'POST', body: JSON.stringify({ documentDir: join(root, 'nested'), trashRetentionDays: 1 }) })
    assert.equal(busy.status, 409)
    assert.equal((await new Settings(store).read()).trashRetentionDays, 15)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
