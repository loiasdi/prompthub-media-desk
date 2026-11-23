import { storedAssetPath } from '../src/asset-storage.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Store } from '../src/store.js'
import { ContentAssets, inspectMedia } from '../src/content-assets.js'
import { emptyWorkspace, sourceAssets } from '../src/workspace-schema.js'
import { route } from '../src/host.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
function wav() {
  const data = Buffer.alloc(16044)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(16000, 40)
  return data
}
const inspect = async (_file, type) => ({ metadataStatus: 'ready', ...(type === 'image' ? { width: 1, height: 1 } : { duration: 1 }) })
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-assets-'))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '内容', body: '正文', platform: '小红书' }] }, { undoable: false })
  try { await fn({ root, store, assets: new ContentAssets(store, { inspect }) }) }
  finally { await rm(root, { recursive: true, force: true }) }
}
const importPng = (assets, revision = 0, extra = {}) => assets.import('piece', Readable.from([PNG.subarray(0, 3), PNG.subarray(3)]), { name: '风景.png', revision, ...extra })

test('内容素材：文件、文件夹、用途、提示词和发布顺序重启后完整恢复', () => fixture(async ({ root, store, assets }) => {
  let { workspace: ws, asset } = await importPng(assets, 0, { relativePath: '参考/场景/风景.png' })
  assert.equal(ws.folders[0].name, '参考/场景')
  assert.equal(asset.folder, ws.folders[0].id)
  assert.equal(asset.bytes, PNG.length)
  assert.equal(asset.sha256.length, 64)
  assert.deepEqual(await readFile(await storedAssetPath(store.filesDir, asset.src.slice(17))), PNG)
  ws = await assets.save('piece', ws.revision, {
    ...ws, folders: [{ ...ws.folders[0], name: '场景参考' }], edits: { [asset.id]: { name: '正式封面.png', role: 'cover', folder: ws.folders[0].id } },
    selectedCover: asset.id, imageIds: [asset.id], promptSettings: { model: 'seedance', ratio: '16:9', duration: '60', style: '纪实', referenceIds: [asset.id] },
    coverPromptText: '3:4 竖版封面\n标题：先画出能卖的东西\n人物靠右，左侧大字，明亮自然光',
    promptText: '全局视频参数：\n角色设定：关关\n\n【第1段 - 13.3秒】\n镜头一：|近景|3.8秒|画面|台词|音效',
    segments: [{ id: 'clip_1', title: '开场', seconds: 6, voice: '旁白', prompt: '镜头提示词', image: asset.src }],
    publish: { ...ws.publish, title: '发布标题', description: '发布正文', mode: 'scheduled', when: '2026-12-01T12:30', tags: '#创作' }, publishEdited: { title: true, description: true },
  })
  const reopened = new ContentAssets(new Store(root), { inspect })
  assert.deepEqual(await reopened.read('piece'), ws)
  assert.equal((await reopened.read('piece')).selectedCover, asset.id)
  assert.equal((await reopened.read('piece')).promptText, ws.promptText)
  assert.equal((await reopened.read('piece')).coverPromptText, ws.coverPromptText)
  assert.equal(store.undo.length, 0, '自动保存不占用稿件撤销')
}))

test('回收站：重启可恢复文件，删除会清理选材和参考，但不移除原文件', () => fixture(async ({ root, assets }) => {
  const { asset, workspace } = await importPng(assets)
  let ws = await assets.save('piece', workspace.revision, { ...workspace, selectedCover: asset.id, imageIds: [asset.id], promptSettings: { ...workspace.promptSettings, referenceIds: [asset.id] }, segments: [{ id: 'clip_1', image: asset.src, prompt: '开场' }] })
  ws = await assets.recycle('piece', ws.revision, asset.id)
  assert.deepEqual(ws.hidden, [asset.id])
  assert.ok(ws.trash[0].deletedAt)
  assert.equal(ws.selectedCover, '')
  assert.deepEqual(ws.imageIds, [])
  assert.deepEqual(ws.promptSettings.referenceIds, [])
  assert.equal(ws.segments[0].image, '')
  ws = await assets.save('piece', ws.revision, { ...ws, segments: [{ ...ws.segments[0], image: asset.src }] })
  assert.equal(ws.segments[0].image, '', '草稿保存不能重新引用回收站中的文件')
  const restarted = new ContentAssets(new Store(root), { inspect })
  const after = await restarted.recycle('piece', ws.revision, asset.id, true)
  assert.deepEqual(after.hidden, [])
  assert.deepEqual(after.trash, [])
  assert.equal(after.selectedCover, '', '恢复文件不会悄悄恢复发布选择')
  assert.deepEqual(await readFile(await storedAssetPath(join(root, 'files'), asset.src.slice(17))), PNG)
}))

test('素材接口拒绝伪造文件、跨内容引用与旧修订，不影响已有数据', () => fixture(async ({ store, assets }) => {
  const { asset, workspace } = await importPng(assets)
  const forged = await assets.save('piece', workspace.revision, { ...workspace, assets: [{ id: 'evil', src: 'file:///etc/passwd' }], hidden: [asset.id], selectedVideo: asset.id, selectedCover: 'evil', imageIds: ['evil', asset.id, asset.id], promptSettings: { ...workspace.promptSettings, referenceIds: ['evil'] }, segments: [{ id: 'clip', image: 'javascript:alert(1)', prompt: 'p' }] })
  assert.equal(forged.assets.length, 1)
  assert.equal(forged.assets[0].src, asset.src)
  assert.deepEqual(forged.hidden, [])
  assert.equal(forged.selectedVideo, '')
  assert.equal(forged.selectedCover, '')
  assert.deepEqual(forged.imageIds, [asset.id])
  assert.equal(forged.segments[0].image, '')
  assert.deepEqual(forged.promptSettings.referenceIds, [])
  await assert.rejects(assets.save('piece', workspace.revision, workspace), err => err.status === 409)
  await store.mutate('', state => { state.items.push({ id: 'other', title: '另一篇' }) }, { undoable: false })
  await assert.rejects(assets.recycle('other', 0, asset.id), err => err.status === 404)
}))

test('内部成图合并只追加文件和版本关联，保留检查媒体期间的其他窗口修改', () => fixture(async ({ store, assets }) => {
  const current = await assets.read('piece')
  const saved = await assets.save('piece', current.revision, { ...current, outlineText: '已保存' })
  // 普通上传保持严格修订检查，不能通过伪造合并选项跳过。
  await assert.rejects(assets.import('piece', Readable.from([PNG]), { name: 'ordinary.png', revision: current.revision, mergeCoverResult: true }), { status: 409 })
  const merging = new ContentAssets(store, { inspect: async () => {
    const latest = await assets.read('piece')
    await assets.save('piece', latest.revision, { ...latest, outlineText: '检查图片期间更新', publish: { ...latest.publish, description: '最新发布文案' }, publishEdited: { description: true } })
    return { width: 1152, height: 1536 }
  } })
  const result = await merging.import('piece', Readable.from([PNG]), { name: 'cover.png', revision: saved.revision, coverRatio: '3:4', mergeCoverResult: true })
  const reopened = await assets.read('piece')
  assert.equal(reopened.outlineText, '检查图片期间更新')
  assert.equal(reopened.publish.description, '最新发布文案')
  assert.deepEqual(reopened.coverDesign.variants['3:4'].imageIds, [result.asset.id])
  assert.equal(reopened.assets.length, current.assets.length + 1)
}))

test('并行 Host：同一修订只能成功保存一次，不会覆盖另一窗口', () => fixture(async ({ root, assets }) => {
  const ws = await assets.read('piece')
  const other = new ContentAssets(new Store(root), { inspect })
  const results = await Promise.allSettled([assets.save('piece', 0, { ...ws, publish: { ...ws.publish, title: 'A' } }), other.save('piece', 0, { ...ws, publish: { ...ws.publish, title: 'B' } })])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.status, 409)
  assert.equal((await new ContentAssets(new Store(root)).read('piece')).revision, 1)
}))

test('重画产生独立版本，旧图及其名称和发布引用保留；删除内容后可撤销恢复', () => fixture(async ({ store, assets }) => {
  await store.mutate('', state => { state.items[0].production = { title: '成稿', cover: { src: 'media-desk/files/a.png' } } }, { undoable: false })
  let ws = await assets.read('piece')
  ws = await assets.save('piece', 0, { ...ws, edits: { [ws.selectedCover]: { name: '旧版封面', role: 'cover' } } })
  const old = ws.selectedCover
  await store.mutate('重画', state => { state.items[0].production.cover = { src: 'media-desk/files/b.png' } }, { undoable: false })
  const after = await assets.read('piece')
  assert.equal(after.assets.length, 2)
  assert.equal(after.selectedCover, old)
  assert.equal(after.edits[old].name, '旧版封面')
  await store.mutate('删除内容', state => { state.items = [] })
  await assert.rejects(assets.read('piece'), err => err.status === 404)
  await store.undoLast()
  assert.equal((await assets.read('piece')).selectedCover, old)
}))

test('生成轮询返回完整工作区登记，跨过的中间版本也能同步到页面', () => fixture(async ({ store, assets }) => {
  let ws = await assets.read('piece')
  ws = await assets.save('piece', ws.revision, ws)
  for (const version of ['a', 'b', 'c']) await store.mutate('', state => {
    state.items[0].production = { status: 'done', cover: { src: `media-desk/files/${version}.png` } }
  }, { undoable: false })
  const desk = { producer: { settle: async () => {}, status: () => ({ running: false }) } }
  const server = createServer((req, res) => route({}, store, desk, req, res).catch(err => { res.writeHead(500); res.end(err.message) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/media-desk/production?id=piece`)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.production.cover.src, 'media-desk/files/c.png')
    assert.equal(data.workspace.revision, ws.revision, '登记生成文件不会使用户编辑发生冲突')
    assert.deepEqual(data.workspace.assets.map(a => a.src), ['a', 'b', 'c'].map(v => `media-desk/files/${v}.png`))
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))

test('失败导入清理临时文件：伪装、损坏、流中断、落盘失败均不登记', () => fixture(async ({ root, store, assets }) => {
  await assert.rejects(assets.import('piece', Readable.from(['<html>fake</html>']), { name: 'fake.png', revision: 0 }), err => err.status === 415)
  const broken = new ContentAssets(store, { inspect: async () => { throw new Error('broken') } })
  await assert.rejects(importPng(broken), /broken/)
  const stream = Readable.from((async function* () { yield PNG.subarray(0, 20); throw new Error('disconnected') })())
  await assert.rejects(assets.import('piece', stream, { name: 'cut.png', revision: 0 }), /disconnected/)
  const persist = store.persist
  store.persist = async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) }
  await assert.rejects(importPng(assets), err => err.status === 507)
  store.persist = persist
  assert.deepEqual(await readdir(join(root, 'pending')), [])
  assert.deepEqual(await readdir(join(root, 'files')), [])
  assert.equal((await assets.read('piece')).revision, 0)
  assert.equal((await assets.read('piece')).assets.length, 0)
}))

test('提交前发现工作台已变化，即使同 ID 同修订也不会写到新目录', () => fixture(async ({ root, store }) => {
  const other = new Store(join(root, 'other'))
  await other.mutate('', state => { state.items = [{ id: 'piece', title: '另一篇' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => {
    store.useRoot(other.root) // 模拟正常切换拦截之外的目录变化。
    return { width: 1, height: 1 }
  } })
  await assert.rejects(importPng(assets), err => err.status === 409 && /工作台目录已更换/.test(err.message))
  assert.deepEqual(await readdir(join(root, 'pending')), [])
  for (const candidate of [new Store(root), other]) {
    const workspace = await new ContentAssets(candidate).read('piece')
    assert.equal(workspace.revision, 0)
    assert.deepEqual(workspace.assets, [])
    await assert.rejects(stat(join(candidate.root, '内容', 'piece', '素材')), { code: 'ENOENT' })
  }
}))

test('媒体探测：本机工具缺失给出明确状态；损坏和类型不匹配不入库', async () => {
  assert.equal((await inspectMedia('x.wav', 'audio', null, async () => { throw Object.assign(new Error(), { code: 'ENOENT' }) })).metadataStatus, 'unavailable')
  await assert.rejects(inspectMedia('x.wav', 'audio', null, async () => ({ stdout: '{"streams":[{"codec_type":"video"}]}' })), err => err.status === 415)
  await assert.rejects(inspectMedia('x.wav', 'audio', null, async () => { throw new Error('bad') }), err => err.status === 422)
  const info = await inspectMedia('local.mp4', 'video', null, async (_cmd, args) => {
    assert.ok(args.includes('file,pipe'))
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, side_data_list: [{ rotation: 90 }] }], format: { duration: '3.5' } }) }
  })
  assert.equal(info.width, 1920)
  assert.equal(info.height, 1080)
  assert.equal(info.duration, 3.5)
})

test('真实媒体：图片尺寸、WAV 时长和视频缩略图读取', () => fixture(async ({ root, store }) => {
  const assets = new ContentAssets(store)
  const image = await importPng(assets)
  if (image.asset.metadataStatus === 'ready') {
    assert.equal(image.asset.width, 1)
    assert.equal(image.asset.height, 1)
  }
  const audio = await assets.import('piece', Readable.from([wav()]), { name: 'voice.wav', revision: image.workspace.revision })
  assert.equal(audio.asset.type, 'audio')
  if (audio.asset.metadataStatus === 'ready') assert.equal(audio.asset.duration, 1)
  const video = await assets.import('piece', Readable.from([await readFile(new URL('../assets/v-ink.mp4', import.meta.url))]), { name: 'result.mp4', revision: audio.workspace.revision })
  if (video.asset.metadataStatus === 'ready') {
    assert.ok(video.asset.duration > 0)
    assert.ok(video.asset.width > 0)
    if (video.asset.poster) assert.ok((await readFile(await storedAssetPath(join(root, 'files'), video.asset.poster.slice(17)))).length > 0)
    else assert.ok(video.asset.metadataWarning)
  }
}))

test('HTTP：导入音频、Range/HEAD 播放、回收站恢复、跨站拒绝和重启读取', () => fixture(async ({ root, store, assets }) => {
  const server = createServer((req, res) => route({}, store, { assets }, req, res).catch(err => { res.writeHead(err.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/media-desk/`
  try {
    const response = await fetch(`${base}content-assets/import?id=piece&revision=0&name=voice.wav`, { method: 'POST', body: wav() })
    assert.equal(response.status, 200)
    const { asset, workspace } = await response.json()
    const url = base + asset.src.replace('media-desk/', '')
    const range = await fetch(url, { headers: { Range: 'bytes=4-11' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-type'), 'audio/wav')
    assert.equal((await range.arrayBuffer()).byteLength, 8)
    const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=-8' } })
    assert.equal(head.status, 206)
    assert.equal(head.headers.get('content-length'), '8')
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal((await fetch(url, { headers: { Range: 'bytes=999999-' } })).status, 416)
    assert.equal((await fetch(`${base}workspace/save`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403)
    const trash = await fetch(`${base}content-assets/trash`, { method: 'POST', body: JSON.stringify({ id: 'piece', revision: workspace.revision, assetId: asset.id }) })
    assert.equal(trash.status, 200)
    const ws = (await trash.json()).workspace
    assert.equal((await new ContentAssets(new Store(root)).read('piece')).hidden[0], asset.id)
    const restore = await fetch(`${base}content-assets/restore`, { method: 'POST', body: JSON.stringify({ id: 'piece', revision: ws.revision, assetId: asset.id }) })
    assert.equal(restore.status, 200)
    assert.deepEqual((await restore.json()).workspace.hidden, [])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))

test('HTTP：通用上传和稿件素材导入都能流式保存超过 250 MB 的视频', () => fixture(async ({ root, store }) => {
  const video = await readFile(new URL('../assets/v-ink.mp4', import.meta.url))
  const size = 251_000_000
  // 用 MP4 的 free box 补齐体积，不在内存中构建整个大文件。
  const free = Buffer.alloc(8)
  free.writeUInt32BE(size - video.length)
  free.write('free', 4)
  const padding = Buffer.alloc(1024 * 1024, 0x5a)
  function* chunks() {
    yield video
    yield free
    for (let remaining = size - video.length - free.length; remaining > 0; remaining -= padding.length) {
      yield padding.subarray(0, Math.min(remaining, padding.length))
    }
  }
  const desk = {}
  const server = createServer((req, res) => route({}, store, desk, req, res).catch(err => { res.writeHead(err.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/media-desk/`
  try {
    for (const endpoint of ['upload', 'content-assets/import?id=piece&revision=0&name=large.mp4']) {
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'video/mp4', 'content-length': String(size) }, body: Readable.from(chunks()), duplex: 'half' })
      const data = await response.json()
      assert.equal(response.status, 200, `${endpoint}: ${data.error || ''}`)
      const src = data.asset?.src ?? data.src
      const path = await storedAssetPath(store.filesDir, src.slice(17))
      assert.equal((await stat(path)).size, size)
      const tail = await fetch(base + src.slice(11), { headers: { Range: 'bytes=-8' } })
      assert.equal(tail.status, 206)
      assert.deepEqual(Buffer.from(await tail.arrayBuffer()), padding.subarray(0, 8))
      if (endpoint === 'upload') await rm(path)
      else {
        const reopened = await new ContentAssets(new Store(root)).read('piece')
        assert.equal(reopened.assets[0].bytes, size)
        assert.equal(reopened.assets[0].src, src)
      }
    }
    assert.deepEqual(await readdir(join(root, 'pending')), [])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))

test('素材按稿件归档，旧地址迁移后仍可读取，共用素材分别保留', () => fixture(async ({ root, store, assets }) => {
  const { asset } = await importPng(assets)
  assert.match(asset.src, /^media-desk\/files\/piece\//)
  assert.deepEqual(await readFile(join(root, '内容', 'piece', '素材', asset.src.split('/').pop())), PNG)
  await writeFile(join(root, 'files', 'legacy.png'), PNG)
  await store.mutate('', state => {
    state.items[0].media = { src: 'media-desk/files/legacy.png' }
    state.items.push({ id: 'second', title: '另一篇', media: { src: 'media-desk/files/legacy.png' } })
  }, { undoable: false })
  const { migrateContentAssets } = await import('../src/migrate-content-assets.js')
  assert.deepEqual(await migrateContentAssets(store), { files: 0, copies: 0 }) // 保存时已自动归档
  for (const id of ['piece', 'second']) assert.deepEqual(await readFile(join(root, '内容', id, '素材', 'legacy.png')), PNG)
  assert.deepEqual(await readFile(await storedAssetPath(store.filesDir, 'legacy.png')), PNG)
  assert.deepEqual(await readdir(store.filesDir), [])
  assert.deepEqual(await migrateContentAssets(store), { files: 0, copies: 0 })
  await assert.rejects(storedAssetPath(store.filesDir, '../state.json'), /路径无效/)
}))

test('通用上传清理过期暂存，保留活跃进程的文件、新文件和无关文件', () => fixture(async ({ root, store }) => {
  const pending = join(root, 'pending')
  const live = `upload-${process.pid}-00000000-0000-4000-8000-000000000001`
  const dead = 'upload-2147483647-00000000-0000-4000-8000-000000000002'
  const legacy = '00000000-0000-4000-8000-000000000003.part'
  const fresh = '00000000-0000-4000-8000-000000000004.part'
  const old = new Date(Date.now() - 48 * 3600_000)
  for (const name of [live, dead]) {
    const path = join(pending, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'video.mp4'), 'unfinished')
    await utimes(path, old, old)
  }
  for (const name of [legacy, fresh, 'keep.txt']) await writeFile(join(pending, name), 'unfinished')
  for (const name of [legacy, 'keep.txt']) await utimes(join(pending, name), old, old)
  const desk = {}
  const server = createServer((req, res) => route({}, store, desk, req, res).catch(err => { res.writeHead(err.status || 500); res.end(err.message) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/media-desk/upload`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })
    assert.equal(response.status, 200, await response.text())
    assert.deepEqual((await readdir(pending)).sort(), [live, fresh, 'keep.txt'].sort())
    assert.equal(await readFile(join(pending, live, 'video.mp4'), 'utf8'), 'unfinished')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))

test('首页收藏：本机抓取明确失败，可仅存链接；媒体上传可用且非法协议不入库', () => fixture(async ({ store }) => {
  const server = createServer((req, res) => route({}, store, {}, req, res).catch(err => { res.writeHead(err.status || 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/media-desk/`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const original = (await store.read()).items.length
    const failed = await post('capture-url', { url: 'http://127.0.0.1:4311/?tab=article' })
    assert.equal(failed.ok, false)
    assert.match((await failed.json()).error, /本机|内网/)
    assert.equal((await store.read()).items.length, original)
    const saved = await post('capture-url', { url: 'http://127.0.0.1:4311/?tab=article', metadata: false })
    assert.equal(saved.ok, true)
    const result = await saved.json()
    assert.ok(result.id)
    assert.equal(result.state.items.find(row => row.id === result.id).url, 'http://127.0.0.1:4311/?tab=article')
    const invalid = await post('capture-url', { url: 'javascript:alert(1)', metadata: false })
    assert.equal(invalid.status, 400)
    assert.equal((await store.read()).items.length, original + 1)
    const upload = await fetch(base + 'upload', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })
    assert.equal(upload.status, 200)
    const media = await upload.json()
    assert.equal(media.kind, 'image')
    assert.deepEqual(await readFile(await storedAssetPath(store.filesDir, media.src.slice(17))), PNG)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))


test('多封面选择重启保留顺序，回收默认封面清理比例槽位并使用下一张', () => fixture(async ({ root, assets }) => {
  const first = await importPng(assets, 0, { name: '竖版.png', coverResult: true, coverRatio: '3:4' })
  const second = await importPng(assets, first.workspace.revision, { name: '横版.png', coverResult: true, coverRatio: '16:9' })
  let ws = await assets.save('piece', second.workspace.revision, { ...second.workspace,
    selectedCover: first.asset.id, selectedCoverIds: [first.asset.id, second.asset.id, first.asset.id, 'missing'],
    publish: { ...second.workspace.publish, browser: { covers: { '3x4': first.asset.id, '16x9': second.asset.id } } },
  })
  const restarted = new ContentAssets(new Store(root), { inspect })
  assert.deepEqual((await restarted.read('piece')).selectedCoverIds, [first.asset.id, second.asset.id])
  ws = await restarted.recycle('piece', ws.revision, first.asset.id)
  assert.equal(ws.selectedCover, second.asset.id)
  assert.deepEqual(ws.selectedCoverIds, [second.asset.id])
  assert.deepEqual(ws.publish.browser.covers, { '16x9': second.asset.id })
  ws = await restarted.recycle('piece', ws.revision, first.asset.id, true)
  assert.deepEqual(ws.selectedCoverIds, [second.asset.id], '恢复素材不自动加入发布选择')
  ws = await restarted.save('piece', ws.revision, { ...ws, selectedCover: '', selectedCoverIds: [], publish: { ...ws.publish, browser: { covers: {} } } })
  assert.deepEqual((await new ContentAssets(new Store(root), { inspect }).read('piece')).selectedCoverIds, [])
}))
