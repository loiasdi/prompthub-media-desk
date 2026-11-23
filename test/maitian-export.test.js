import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { ContentAssets } from '../src/content-assets.js'
import { assertNoAssetUploads } from '../src/asset-upload.js'
import { writePublishRecords } from '../src/publish/records.js'
import { MaitianConfig } from '../src/publish/maitian/config.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { exportProject } from '../src/publish/maitian/export.js'
import { discoverEngine, inspectEngine } from '../src/publish/maitian/engine-loader.mjs'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { inspectSnapshot } from '../src/publish/maitian/media.js'
import { route } from '../src/host.js'
import { component } from './helpers/maitian-component.js'
import { MAITIAN_PLATFORMS } from '../src/publish/maitian/platforms.js'

const exec = promisify(execFile)
const id = 'piece'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'workspace'))
  await store.mutate('', state => { state.items = [{ id, title: '测试稿件', body: '测试正文', platform: '小红书' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  const { workspace: initial, asset: video } = await assets.import(id, createReadStream(new URL('../assets/v-ink.mp4', import.meta.url)), { name: '成片.mp4', revision: 0 })
  const { workspace: withImage, asset: cover } = await assets.import(id, createReadStream(new URL('../assets/ink.jpg', import.meta.url)), { name: '封面.jpg', revision: initial.revision })
  const ws = await assets.save(id, withImage.revision, { ...withImage, selectedVideo: video.id, publish: { ...withImage.publish, mode: 'manual', provider: 'maitian', browser: { profileId: 'default', covers: {}, shortTitle: '视频号独立短标题' } } })
  const original = await component(join(root, 'original'))
  const config = new MaitianConfig(join(root, 'config'))
  await config.save({ source: 'local', localComponentDir: original })
  const service = new MaitianPublishing(store, { config })
  const exportsRoot = join(config.root, 'exports')
  const engineRef = await discoverEngine(config.resolve())
  const contract = await runComponent({ op: 'hello', engineRef })
  const request = { id, revision: ws.revision, platform: 'xhs' }
  const input = { store, engineRef, exportsRoot, contract, ...request, validate: data => runComponent({ op: 'validate', ...data }), inspect: async () => ({ duration: 2 }) }
  return { root, store, assets, ws, video, cover, service, config, exportsRoot, original, request, input }
}

test('工程导出固定素材、保存来源摘要、生成可独立解压的完整工程；不创建发布记录', async t => {
  const f = await fixture(t)
  const before = (await inspectEngine(f.original)).fingerprint
  const result = await exportProject(f.input)
  assert.equal(result.platform, 'xhs')
  assert.deepEqual(result.warnings, ['上游原始提示'])
  assert.equal(JSON.stringify(result).includes(f.root), false)
  const archive = await f.service.archive(result.exportId)
  const unpack = join(f.root, 'unpacked')
  await mkdir(unpack)
  await exec('/usr/bin/tar', ['-xzf', archive.file, '-C', unpack])
  const folder = join(unpack, result.exportId)
  const data = JSON.parse(await readFile(join(folder, 'publish.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(folder, 'media-desk-manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(data.platforms), ['xhs'])
  assert.equal(data.video, 'video.mp4')
  assert.equal(data.platforms.xhs.title, '测试稿件')
  assert.equal(Object.hasOwn(data, 'schedule'), false)
  assert.deepEqual(await readFile(join(folder, data.video)), await readFile(new URL('../assets/v-ink.mp4', import.meta.url)))
  assert.equal(manifest.engineFingerprint, before)
  assert.equal(manifest.itemId, id)
  assert.equal(manifest.assets[0].digest.length, 64)
  assert.equal((await inspectEngine(f.original)).fingerprint, before)
  assert.equal((await readdir(f.store.root)).includes('.publish-records.json'), false)
  assert.deepEqual(await readdir(join(f.store.root, 'pending')), [])
})

test('工程导出不要求扩展源码目录，并写入传入的项目导出目录', async t => {
  const f = await fixture(t)
  await f.config.save({ source: 'store', localComponentDir: '', enabled: false })
  const output = join(f.root, 'project-export')
  const result = await f.service.export(f.request, output)
  assert.equal(result.platform, 'xhs')
  assert.equal(f.service.public().enabled, false)
  assert.equal((await readdir(output)).includes(result.exportId), true)
  assert.equal((await readdir(output)).includes(`${result.exportId}.tar.gz`), true)
  assert.equal((await f.service.archive(result.exportId, output)).size > 0, true)
})

test('七平台与 16:9 封面选择保存后重启可恢复，导出压缩包含所有平台且新增平台参与防重', async t => {
  const f = await fixture(t)
  const platforms = MAITIAN_PLATFORMS.map(p => p.id)
  const saved = await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, browser: { ...f.ws.publish.browser, platforms: [...platforms, 'unsupported', 'xhs'], covers: { '16x9': f.cover.id } } } })
  const restored = new Store(f.store.root)
  await restored.refresh()
  const browser = restored.state.items.find(item => item.id === id).workspace.publish.browser
  assert.deepEqual(browser.platforms, platforms)
  assert.equal(browser.covers['16x9'], f.cover.id)
  const output = join(f.root, 'all-platforms')
  const result = await exportProject({ store: restored, exportsRoot: output, id, revision: saved.revision, platforms, inspect: async () => ({ duration: 2 }) })
  const unpack = join(f.root, 'all-unpacked')
  await mkdir(unpack)
  await exec('/usr/bin/tar', ['-xzf', join(output, `${result.exportId}.tar.gz`), '-C', unpack])
  const folder = join(unpack, result.exportId)
  const data = JSON.parse(await readFile(join(folder, 'publish.json'), 'utf8'))
  assert.deepEqual(Object.keys(data.platforms), platforms)
  assert.deepEqual(data.platforms.youtube.covers, ['16x9'])
  assert.deepEqual(data.platforms.instagram.covers, ['16x9'])
  assert.deepEqual(await readFile(join(folder, data.covers['16x9'])), await readFile(new URL('../assets/ink.jpg', import.meta.url)))
  await writePublishRecords(restored.root, [{ taskId: 'existing-youtube', itemId: id, platform: 'youtube', status: 'published' }])
  await assert.rejects(exportProject({ store: restored, exportsRoot: output, id, revision: saved.revision, platforms, inspect: async () => ({ duration: 2 }) }), error => error.code === 'EXISTING_PUBLICATION')
})

test('多平台打包导出把小红书和视频号写入同一份 publish.json 并统一校验防重', async t => {
  const f = await fixture(t)
  const output = join(f.root, 'multi-export')
  const result = await f.service.export({ id, revision: f.ws.revision, platforms: ['xhs', 'channels'] }, output)
  assert.deepEqual(result.platforms, ['xhs', 'channels'])
  const data = JSON.parse(await readFile(join(output, result.exportId, 'publish.json'), 'utf8'))
  assert.deepEqual(Object.keys(data.platforms), ['xhs', 'channels'])
  assert.equal(data.platforms.xhs.title, '测试稿件')
  assert.equal(data.platforms.channels.shortTitle, '视频号独立短标题')
  await f.store.run(() => writePublishRecords(f.store.root, [{ itemId: id, platform: 'channels', status: 'unknown' }]))
  await assert.rejects(f.service.export({ id, revision: f.ws.revision, platforms: ['xhs', 'channels'] }, output), error => error.code === 'EXISTING_PUBLICATION')
  const confirmed = await f.service.export({ id, revision: f.ws.revision, platforms: ['xhs', 'channels'], confirmExisting: true }, output)
  assert.deepEqual(confirmed.platforms, ['xhs', 'channels'])
})

test('M4V 可通过常规素材导入并以原扩展名进入麦田工程', async t => {
  const f = await fixture(t)
  const { workspace, asset } = await f.assets.import(id, createReadStream(new URL('../assets/v-ink.mp4', import.meta.url)), { name: '成片.m4v', revision: f.ws.revision })
  const saved = await f.assets.save(id, workspace.revision, { ...workspace, selectedVideo: asset.id })
  const result = await f.service.export({ ...f.request, revision: saved.revision })
  const archive = await f.service.archive(result.exportId)
  const unpack = join(f.root, 'm4v-unpacked')
  await mkdir(unpack)
  await exec('/usr/bin/tar', ['-xzf', archive.file, '-C', unpack])
  const data = JSON.parse(await readFile(join(unpack, result.exportId, 'publish.json'), 'utf8'))
  assert.equal(data.video, 'video.m4v')
  assert.deepEqual(await readFile(join(unpack, result.exportId, data.video)), await readFile(new URL('../assets/v-ink.mp4', import.meta.url)))
})

test('原版校验错误保留阻断语义，失败无残留导出；变化后要求重新准备', async t => {
  const f = await fixture(t)
  await assert.rejects(exportProject({ ...f.input, validate: async () => ({ errors: ['上游禁止词规则'], warnings: [] }) }), error => error.code === 'UPSTREAM_VALIDATION' && error.message === '上游禁止词规则')
  assert.deepEqual(await readdir(f.exportsRoot), [])
  await assert.rejects(exportProject({ ...f.input, revision: 0 }), error => error.code === 'REVISION_CHANGED')
  await assert.rejects(exportProject({ ...f.input, validate: async () => {
    await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, title: '新标题' } })
    return { errors: [], warnings: [] }
  } }), error => error.code === 'REVISION_CHANGED')
  assert.deepEqual(await readdir(f.exportsRoot), [])
})

test('导出期间阻止工作台迁移，已有上传需显式确认；不信任登记的封面比例', async t => {
  const f = await fixture(t)
  await f.store.run(() => writePublishRecords(f.store.root, [{ itemId: id, platform: 'xhs', status: 'unknown' }]))
  await assert.rejects(exportProject(f.input), error => error.code === 'EXISTING_PUBLICATION')
  const result = await exportProject({ ...f.input, confirmExisting: true, validate: async () => {
    await assert.rejects(assertNoAssetUploads(f.store.root), error => error.status === 409)
    return { errors: [], warnings: [] }
  } })
  assert.ok(result.exportId)
  const updated = await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, browser: { ...f.ws.publish.browser, covers: { '3x4': f.cover.id } } } })
  await assert.rejects(exportProject({ ...f.input, revision: updated.revision, confirmExisting: true, inspect: async (_file, type) => {
    if (type === 'image') throw Object.assign(new Error('实际封面不符合比例'), { status: 422 })
    return { duration: 2 }
  } }), /实际封面不符合比例/)
  await assert.rejects(inspectSnapshot(new URL('../assets/ink.jpg', import.meta.url), 'image', '4x3'), error => error.code === 'COVER_RATIO_MISMATCH')
})

test('麦田 Host 接口保护写入来源、隐藏路径、下载完整工程，非法导出 ID 被拒绝', async t => {
  const f = await fixture(t)
  const originalExport = f.service.export.bind(f.service)
  f.service.export = async (body, exportsRoot) => exportProject({ ...f.input, ...body, exportsRoot })
  const exportsRoot = join(f.root, 'settings-export')
  let configuredExportDir = exportsRoot
  const desk = { maitianPublishing: f.service, settings: { read: async () => ({ exportDir: configuredExportDir }) } }
  const server = createServer((req, res) => route({}, f.store, desk, req, res).catch(() => { res.statusCode = 500; res.end() }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/media-desk/publish/maitian/`
  const post = (path, body, site = 'same-origin') => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: JSON.stringify(body) })
  assert.equal((await post('config', {}, 'cross-site')).status, 403)
  assert.equal((await fetch(url + 'config')).status, 200)
  assert.equal((await (await fetch(url + 'config')).text()).includes(f.root), false)
  assert.equal((await post('export', { ...f.request, rootPath: '/arbitrary' })).status, 400)
  assert.equal((await post('open-install', {}, 'cross-site')).status, 403)
  assert.equal((await post('open-install', { url: 'https://example.invalid' })).status, 400)
  assert.equal((await post('open-login', { platform: 'xhs', profileDir: '/arbitrary' })).status, 400)
  assert.equal((await post('open-page', { targetId: 'arbitrary' })).status, 400)
  assert.equal((await post('open-install', {})).status, 409)
  assert.equal((await post('probe', { engineRef: '/arbitrary' })).status, 400)
  assert.equal((await post('prepare', { ...f.request, rootPath: '/arbitrary' })).status, 400)
  assert.equal((await post('prepare', { ...f.request, confirmed: true })).status, 400)
  assert.equal((await post('prepare', f.request, 'cross-site')).status, 403)
  assert.equal((await post('probe', {})).status, 200)
  const response = await post('export', f.request)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal((await readdir(exportsRoot)).includes(result.exportId), true)
  assert.equal((await readdir(exportsRoot)).includes(`${result.exportId}.tar.gz`), true)
  const download = await fetch(`http://127.0.0.1:${server.address().port}/` + result.downloadPath)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/gzip')
  assert.equal(download.headers.get('cache-control'), 'no-store')
  const archiveBytes = Buffer.from(await download.arrayBuffer())
  assert.deepEqual(archiveBytes, await readFile((await f.service.archive(result.exportId, exportsRoot)).file))
  configuredExportDir = join(f.root, 'new-settings-export')
  const oldLinkAfterSettingChange = await fetch(`http://127.0.0.1:${server.address().port}/` + result.downloadPath)
  assert.equal(oldLinkAfterSettingChange.status, 200)
  assert.deepEqual(Buffer.from(await oldLinkAfterSettingChange.arrayBuffer()), archiveBytes)
  assert.equal((await fetch(url + 'download?exportId=../config.json')).status, 400)
  assert.equal((await fetch(url + 'download?exportId=00000000-0000-0000-0000-000000000000')).status, 404)
  f.service.export = originalExport
})

test('真实 ffprobe 路径可验证已归属视频并导出；旧草稿字段与新字段重启后保留', async t => {
  const f = await fixture(t)
  const result = await f.service.export(f.request)
  assert.ok(result.exportId)
  const reopened = new ContentAssets(new Store(f.store.root), { inspect: async () => ({}) })
  const ws = await reopened.read(id)
  assert.equal(ws.publish.provider, 'maitian')
  assert.equal(ws.publish.timezone, 'Asia/Shanghai')
  assert.equal(ws.publish.browser.shortTitle, '视频号独立短标题')
  const data = JSON.parse(await readFile(join(f.exportsRoot, result.exportId, 'publish.json'), 'utf8'))
  assert.ok(data.durationSec > 0)
})

test('导出复制和压缩前均检查容量，拒绝时移除本次副本并保留原素材和发布记录', async t => {
  const f = await fixture(t), original = await readFile(new URL('../assets/v-ink.mp4', import.meta.url))
  let checkedSize, inspected = false
  const full = Object.assign(new Error('测试磁盘余量不足'), { status: 507 })
  await assert.rejects(exportProject({ ...f.input, beforeCopy: async ({ sizeBytes }) => { checkedSize = sizeBytes; throw full }, inspect: async () => { inspected = true } }), error => error === full)
  assert.equal(checkedSize, original.length)
  assert.equal(inspected, false)
  assert.deepEqual(await readdir(f.exportsRoot), [])
  await assert.rejects(exportProject({ ...f.input, beforeArchive: async ({ sizeBytes }) => { checkedSize = sizeBytes; throw full } }), error => error === full)
  assert.equal(checkedSize, original.length)
  assert.deepEqual(await readdir(f.exportsRoot), [])
  assert.deepEqual(await readFile(new URL('../assets/v-ink.mp4', import.meta.url)), original)
  await assert.rejects(readFile(join(f.store.root, '.publish-records.json')), { code: 'ENOENT' })
})
