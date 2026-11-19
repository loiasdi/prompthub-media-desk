import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath, symlink, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { Settings } from '../src/settings.js'
import { openStorage, relocateStorage } from '../src/storage-management.js'
import { FeishuSync } from '../src/feishu/sync.js'
import { ContentAssets } from '../src/content-assets.js'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
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
    await mkdir(join(root, 'pending'))
    await writeFile(join(root, 'pending', '00000000-0000-4000-8000-000000000001.part'), '中断的上传')
    await mkdir(join(root, '回收站', '内容', 'deleted'), { recursive: true })
    await writeFile(join(root, '回收站', '内容', 'deleted', '稿件.md'), '已删除的稿件')
    const sync = new FeishuSync(store)
    const identity = sync.target({})
    assert.equal((await relocateStorage(store, target, { env })).moved, true)
    assert.equal(store.root, target)
    assert.equal(sync.target({}), identity)
    assert.equal((await settings.read()).trashRetentionDays, 3)
    assert.equal(await readFile(join(target, '内容', 'piece', '素材', 'test.jpg'), 'utf8'), '真实素材')
    await assert.rejects(readdir(join(target, 'pending')), { code: 'ENOENT' })
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


test('设置 API 打开已有工作台，不写入源或目标，并在重启后沿用目标目录', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'desk-open-storage-')))
  const configHome = join(base, 'config'), target = join(base, 'Obsidian Vault', '自媒体工作台')
  const envBefore = { DSH_HOME: process.env.DSH_HOME, MEDIA_DESK_DATA_DIR: process.env.MEDIA_DESK_DATA_DIR }
  process.env.DSH_HOME = configHome
  delete process.env.MEDIA_DESK_DATA_DIR
  t.after(async () => {
    for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(base, { recursive: true, force: true })
  })
  const store = new Store()
  const source = store.root
  await store.mutate('', state => { state.items = [{ id: 'new', title: '本机稿件' }] })
  const old = new Store(target, { markdown: true })
  await old.mutate('', state => { state.items = [{ id: 'old', title: '旧设备稿件' }] })
  await new Settings(old).update({ language: 'zh', trashRetentionDays: 3, image: { apiKey: 'old-workspace-secret' } })
  await writeFile(join(target, 'files', 'photo.jpg'), '旧工作台素材')
  await mkdir(join(target, '回收站', '内容', 'deleted'), { recursive: true })
  await writeFile(join(target, '回收站', '内容', 'deleted', '稿件.md'), '旧回收站稿件')
  const sourceState = await readFile(join(source, 'state.json'))
  const targetFiles = ['state.json', 'settings.json', '.markdown-manifest.json', 'files/photo.jpg', '回收站/.index.json', '回收站/内容/deleted/稿件.md']
  const targetContents = await Promise.all(targetFiles.map(file => readFile(join(target, file))))
  const desk = { settings: new Settings(store) }
  const server = createServer((req, res) => route({ get: () => null }, store, desk, req, res).catch(err => { res.writeHead(err.status || 500); res.end(JSON.stringify({ error: err.message })) }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/media-desk/settings`
  const post = body => fetch(url, { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await post({ documentDir: target })).status, 400) // 迁移仍不允许覆盖，不能隐式切换模式
  desk.activeChats = 1
  assert.equal((await post({ documentDir: target, documentDirMode: 'open' })).status, 409)
  desk.activeChats = 0
  const response = await post({ documentDir: target, documentDirMode: 'open', trashRetentionDays: 1, language: 'en' })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.storage, { root: target, moved: false, opened: true })
  assert.equal(result.documentDir, target)
  assert.equal(result.canOpenDocumentDir, true)
  assert.equal(result.language, 'zh')
  assert.equal(result.trashRetentionDays, 3)
  assert.equal(result.image.hasKey, true)
  assert.ok(!JSON.stringify(result).includes('old-workspace-secret'))
  assert.deepEqual(await readFile(join(source, 'state.json')), sourceState)
  assert.deepEqual(await Promise.all(targetFiles.map(file => readFile(join(target, file)))), targetContents)
  const restarted = new Store()
  assert.equal(restarted.root, target)
  assert.equal(restarted.markdown, true)
  assert.deepEqual((await restarted.read()).items.map(item => item.title), ['旧设备稿件'])
})

test('打开已有工作台拒绝空目录、其他数据、损坏状态和链接，不切换目录', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'desk-invalid-storage-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'current'), target = join(base, 'target'), configHome = join(base, 'config')
  const store = new Store(root)
  await store.read()
  const env = { DSH_HOME: configHome }
  const invalid = path => assert.rejects(openStorage(store, path, { env }), /不是有效的 MediaDesk 工作台/)
  await invalid(target)
  await assert.rejects(readdir(target), { code: 'ENOENT' })
  await mkdir(target)
  await writeFile(join(target, '普通笔记.md'), '保留')
  await invalid(target)
  for (const bad of ['{', 'null', '{}', '{"version":1,"items":[]}']) {
    await writeFile(join(target, 'state.json'), bad)
    await invalid(target)
  }
  await rm(join(target, 'state.json'))
  await symlink(join(root, 'state.json'), join(target, 'state.json'))
  await invalid(target)
  await assert.rejects(openStorage(store, target, { env: { ...env, MEDIA_DESK_DATA_DIR: root } }), /MEDIA_DESK_DATA_DIR/)
  assert.equal(store.root, root)
  await assert.rejects(readFile(join(configHome, 'media-desk-storage.json')), { code: 'ENOENT' })
  assert.equal(await readFile(join(target, '普通笔记.md'), 'utf8'), '保留')
})

test('两种上传期间，另一 Host 都不能打开或迁移工作台；完成后可以切换', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'desk-upload-switch-')))
  const source = join(base, 'source'), target = join(base, 'target'), migrated = join(base, 'migrated')
  const before = { DSH_HOME: process.env.DSH_HOME, MEDIA_DESK_DATA_DIR: process.env.MEDIA_DESK_DATA_DIR }
  process.env.DSH_HOME = join(base, 'config')
  delete process.env.MEDIA_DESK_DATA_DIR
  const uploadStore = new Store(source), settingsStore = new Store(source), targetStore = new Store(target)
  for (const store of [uploadStore, targetStore]) await store.mutate('', state => { state.items = [{ id: 'piece', title: '稿件' }] })
  const uploadDesk = { assets: new ContentAssets(uploadStore, { inspect: async () => ({ metadataStatus: 'ready' }) }) }
  const settingsDesk = { settings: new Settings(settingsStore) }
  const server = createServer((req, res) => {
    const settings = req.url === '/media-desk/settings'
    route({ get: () => null }, settings ? settingsStore : uploadStore, settings ? settingsDesk : uploadDesk, req, res).catch(err => { res.writeHead(err.status || 500); res.end(err.message) })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(base, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/media-desk/`
  const post = body => fetch(url + 'settings', { method: 'POST', body: JSON.stringify(body) })
  const mp4 = Buffer.from('0000ftypisom0000')
  for (const endpoint of ['upload', 'content-assets/import?id=piece&revision=0&name=test.mp4']) {
    const req = request(url + endpoint, { method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': mp4.length } })
    const response = once(req, 'response')
    response.catch(() => {})
    try {
      req.write(mp4.subarray(0, 12))
      let written = false
      const pending = join(source, 'pending')
      for (let i = 0; i < 250 && !written; i++) {
        const [dir] = await readdir(pending).catch(() => [])
        if (dir) {
          const staged = join(pending, dir)
          const [file] = await readdir(staged)
          if (file) written = (await stat(join(staged, file))).size > 0
        }
        if (!written) await delay(8)
      }
      assert.ok(written, `upload did not start: ${endpoint}`)
      for (const change of [{ documentDir: target, documentDirMode: 'open' }, { documentDir: migrated }]) {
        const blocked = await post(change)
        assert.equal(blocked.status, 409)
        assert.match(await blocked.text(), /有素材正在导入/)
      }
      req.end(mp4.subarray(12))
      const [res] = await response
      let text = ''
      for await (const chunk of res) text += chunk
      assert.equal(res.statusCode, 200, text)
      const data = JSON.parse(text)
      const asset = await fetch(url + (data.asset?.src ?? data.src).slice(11), { method: 'HEAD' })
      assert.equal(asset.status, 200)
      assert.deepEqual(await readdir(pending), [])
    } finally { req.destroy() }
  }
  const switched = await post({ documentDir: target, documentDirMode: 'open' })
  assert.equal(switched.status, 200)
  await switched.text()
  assert.equal((await new ContentAssets(settingsStore).read('piece')).assets.length, 0)
})
