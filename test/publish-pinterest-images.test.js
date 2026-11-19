import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { assetFileName } from '../src/asset-rules.js'
import { createPinterestAdapter } from '../src/publish/pinterest/index.js'
import { pinterestImagesIssue } from '../src/publish/media-rules.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const id = 'pinterest-images'
const userId = '123456789', boardId = '1880028106020515840', pinId = '1880028106020515842'
const options = { categoryId: boardId, privacyStatus: 'public', original: true, isAiGenerated: true, syntheticPerformer: false }
const draft = { title: '图片稿件', description: '正文', topics: [], ...options }
const png = Buffer.from('89504e470d0a1a0a', 'hex')
const jpeg = Buffer.from('ffd8ffe00010', 'hex')
const source = (bytes, mime) => ({ sizeBytes: bytes.length, mime, stream: () => Readable.from([bytes]) })

async function fixture(context, count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'md-pinterest-images-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id, title: draft.title, body: draft.description, tags: [], platform: 'Pinterest' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  let current = await assets.read(id)
  const rows = []
  for (let i = 0; i < count; i++) {
    const bytes = i % 2 ? jpeg : png
    const result = await assets.import(id, Readable.from([Buffer.concat([bytes, Buffer.from([i])])]), { revision: current.revision, name: `${i + 1}.${i % 2 ? 'jpg' : 'png'}` })
    current = result.workspace
    rows.push(result.asset)
  }
  const saved = await assets.save(id, current.revision, { ...current, imageIds: rows.map(row => row.id).reverse(), selectedCover: rows[0]?.id || '', publish: { ...current.publish, format: 'images', mode: 'now' } })
  return { root, store, assets, rows, saved, input: { id, platform: 'pinterest', revision: saved.revision, options } }
}

function mock(overrides = {}) {
  const calls = [], state = { ...overrides }
  const adapter = createPinterestAdapter({ userId }, { fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(url.origin, 'https://api.pinterest.com')
    assert.equal(request.headers.authorization, 'Bearer mock-token')
    assert.equal(request.redirect, 'error')
    if (url.pathname === '/v5/user_account') return Response.json({ id: userId, username: 'author' })
    if (url.pathname === '/v5/boards') return Response.json({ items: [{ id: boardId, name: '原创作品', privacy: 'PUBLIC', owner: { username: 'author' } }] })
    if (url.pathname === '/v5/boards/' + boardId) return Response.json({ id: boardId, name: '原创作品', privacy: 'PUBLIC', owner: { username: 'author' } })
    if (url.pathname === '/v5/pins' && request.method === 'POST') {
      state.created = JSON.parse(request.body)
      await state.beforeCreate?.()
      if (state.failCreate) throw new Error('mock-token')
      return Response.json({ id: state.invalidReceipt ? '' : pinId, board_id: boardId })
    }
    if (url.pathname === '/v5/pins/' + pinId) return Response.json({ id: pinId, board_id: boardId, is_owner: true, media: { media_type: state.reviewType || (state.created.media_source.source_type === 'image_base64' ? 'image' : 'multiple_images') } })
    assert.fail('Unexpected mocked API call: ' + url.pathname)
  } })
  return { calls, state, adapter, resolvePlatform: key => key === 'pinterest' ? { adapter, accessToken: 'mock-token' } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Image task did not finish')
}

for (const count of [1, 2, 5]) test(`Pinterest ${count} 张图片：只读准备、顺序与快照、内联直传、检查点、回执与类型回查`, async context => {
  const { store, root, input, rows } = await fixture(context, count)
  const { calls, state, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  assert.equal(prepared.video, null)
  assert.equal(prepared.cover, null) // A stale selectedCover must not leak into image publishing.
  assert.deepEqual(prepared.images.map(row => row.id), rows.map(row => row.id).reverse())
  assert.ok(calls.every(([method]) => method === 'GET'))
  state.beforeCreate = async () => {
    const records = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8')).records
    assert.equal(records[0].submissionStarted, true)
    assert.ok(!JSON.stringify(records).includes('mock-token'))
  }
  const start = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(start)
  await publishing.start(start)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(job.receiptId, pinId)
  assert.equal(state.created.media_source.source_type, count === 1 ? 'image_base64' : 'multiple_image_base64')
  const sent = count === 1 ? [state.created.media_source] : state.created.media_source.items
  for (const [index, row] of [...rows].reverse().entries()) {
    assert.equal(sent[index].content_type, ((count - index - 1) & 1) ? 'image/jpeg' : 'image/png')
    const original = await readFile(join(root, '内容', id, '素材', assetFileName(row.src).split('/').at(-1)))
    assert.deepEqual(Buffer.from(sent[index].data, 'base64'), original)
    assert.equal(sent[index].url, undefined)
  }
  assert.deepEqual(state.created.ai_disclosures, { values: ['AI_MODIFIED'] })
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1)
  const reviewed = await publishing.review({ id, taskId: job.taskId })
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.reviewError, undefined)
  await assert.rejects(publishing.prepare(input), /已有/)
  for (let attempt = 0; attempt < 100 && (await readdir(root)).some(name => name.startsWith('media-desk-publish-')); attempt++) await delay(10)
  assert.equal((await readdir(root)).some(name => name.startsWith('media-desk-publish-')), false)
})

test('Pinterest 图片变更或选择变更后，旧确认单不得上传', async context => {
  const { store, root, input, assets, saved, rows } = await fixture(context)
  const { calls, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  let prepared = await publishing.prepare(input)
  const updated = await assets.save(id, saved.revision, { ...saved, imageIds: [...saved.imageIds].reverse() })
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化/)
  prepared = await publishing.prepare({ ...input, revision: updated.revision })
  await writeFile(join(root, '内容', id, '素材', assetFileName(rows[0].src).split('/').at(-1)), Buffer.concat([png, Buffer.from('changed')]))
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化|格式无效/)
  assert.ok(calls.every(([method]) => method === 'GET'))
})

test('Pinterest 缺图、过多、外链或回收站图片在准备阶段被拦截', async context => {
  const { store, root, input, assets, saved, rows } = await fixture(context, 6)
  const { calls, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  await assert.rejects(publishing.prepare(input), /数量/)
  const current = await assets.save(id, saved.revision, { ...saved, imageIds: [] })
  await assert.rejects(publishing.prepare({ ...input, revision: current.revision }), /数量/)
  const selected = await assets.save(id, current.revision, { ...current, imageIds: [rows[0].id] })
  await store.mutate('', state => { state.items[0].workspace.hidden.push(rows[0].id) }, { undoable: false })
  await assert.rejects(publishing.prepare({ ...input, revision: selected.revision }), /可用|素材/)
  await store.mutate('', state => { state.items[0].workspace.hidden = [] }, { undoable: false })
  await store.mutate('', state => { const ws = state.items[0].workspace; ws.assets.find(row => row.id === rows[0].id).src = 'https://example.com/image.png' }, { undoable: false })
  await assert.rejects(publishing.prepare({ ...input, revision: selected.revision }), /外链|素材/)
  assert.ok(calls.every(([method]) => method === 'GET'))
})

test('Pinterest 图片校验拒绝混合素材、GIF、容量超限与短读，最终提交前失败不发请求', async () => {
  const { adapter, calls } = mock()
  const image = source(png, 'image/png')
  assert.equal(pinterestImagesIssue([image]), '')
  assert.ok(pinterestImagesIssue([ { ...image, mime: 'image/gif' } ]))
  assert.ok(pinterestImagesIssue([ { ...image, sizeBytes: 10 * 1024 * 1024 + 1 } ]))
  assert.ok(pinterestImagesIssue(Array.from({ length: 3 }, () => ({ ...image, sizeBytes: 8 * 1024 * 1024 }))))
  assert.throws(() => adapter.check({ draft, images: [image], cover: image }), /混发/)
  assert.throws(() => adapter.check({ draft, images: [image], video: {} }), /混发/)
  const submit = images => adapter.submit({ accessToken: 'mock-token', channelId: userId, draft, images, beforeSubmit: async () => assert.fail('No checkpoint for bad image') })
  await assert.rejects(submit([{ ...image, sizeBytes: png.length + 1 }]), /变化/)
  await assert.rejects(submit([{ ...image, sizeBytes: png.length - 1 }]), /变化/)
  assert.ok(calls.every(([method]) => method === 'GET'))
})

for (const failure of ['failCreate', 'invalidReceipt']) test(`Pinterest 图片最终结果不确定 (${failure})：禁止重投`, async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls } = mock({ [failure]: true })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'unknown')
  await assert.rejects(publishing.prepare(input), /已有/)
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1)
})

test('Pinterest 图片 Pin 回查类型不匹配时保留已有发布记录并显示错误', async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, state } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  const job = await finish(publishing)
  state.reviewType = 'video'
  const reviewed = await publishing.review({ id, taskId: job.taskId })
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.url, job.url)
  assert.ok(reviewed.reviewError)
})
