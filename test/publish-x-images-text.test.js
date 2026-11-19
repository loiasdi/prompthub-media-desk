import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { assetFileName } from '../src/asset-rules.js'
import { xCaption } from '../src/publish/draft-copy.js'
import { xImagesIssue, X_IMAGE_BYTES } from '../src/publish/media-rules.js'
import { createXAdapter } from '../src/publish/x/index.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const id = 'x-images-text', userId = '123456789', postId = '1880028106020515899'
const accessToken = 'mock-x-token'
const options = { privacyStatus: 'public', isAiGenerated: true, isPaidPartnership: false }
const draft = { title: '图片稿件', description: '正文', topics: ['标签'], ...options }
const png = Buffer.from('89504e470d0a1a0a', 'hex'), jpeg = Buffer.from('ffd8ffe00010', 'hex')
const mediaId = index => '18800281060205158' + String(index).padStart(2, '0')

async function fixture(context, format = 'images', count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'md-x-images-text-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id, title: draft.title, body: draft.description, tags: draft.topics, platform: 'X' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  let current = await assets.read(id)
  const rows = []
  for (let index = 0; index < count; index++) {
    const bytes = index % 2 ? jpeg : png
    const result = await assets.import(id, Readable.from([Buffer.concat([bytes, Buffer.from([index])])]), { revision: current.revision, name: `${index + 1}.${index % 2 ? 'jpg' : 'png'}` })
    current = result.workspace
    rows.push(result.asset)
  }
  const saved = await assets.save(id, current.revision, { ...current, imageIds: rows.map(row => row.id).reverse(), selectedCover: rows[0]?.id || '', publish: { ...current.publish, format, mode: 'now' } })
  const path = row => join(root, '内容', id, '素材', assetFileName(row.src).split('/').at(-1))
  return { root, store, assets, rows, path, saved, input: { id, platform: 'x', revision: saved.revision, options } }
}

function mock(overrides = {}) {
  const calls = [], sessions = [], waits = [], state = { ...overrides }
  const adapter = createXAdapter({ userId }, { partBytes: 5, pollAttempts: 2, wait: async ms => { waits.push(ms) }, fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(url.origin, 'https://api.x.com')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    assert.equal(url.href.includes(accessToken), false)
    if (url.pathname === '/2/users/me') {
      await state.beforeAccount?.()
      return Response.json({ data: { id: state.userId ?? userId, name: 'X 测试作者', username: 'author', protected: state.protected ?? false } })
    }
    if (url.pathname === '/2/media/upload/initialize') {
      const payload = JSON.parse(request.body)
      assert.equal(payload.media_category, 'tweet_image')
      assert.ok(['image/png', 'image/jpeg'].includes(payload.media_type))
      const session = { ...payload, id: state.duplicate ? mediaId(1) : mediaId(sessions.length + 1), chunks: [] }
      sessions.push(session)
      return Response.json({ data: { id: state.invalidId ? '' : session.id, expires_after_secs: state.expiry ?? 86400 } })
    }
    const session = sessions.at(-1)
    if (session && url.pathname === `/2/media/upload/${session.id}/append`) {
      assert.equal(request.method, 'POST')
      assert.equal(request.duplex, 'half')
      const chunks = []; for await (const chunk of request.body) chunks.push(chunk)
      const payload = Buffer.concat(chunks)
      assert.equal(payload.length, Number(request.headers['content-length']))
      const boundary = request.headers['content-type'].split('boundary=')[1]
      const mime = session.media_type
      const filename = mime === 'image/jpeg' ? 'image.jpg' : 'image.png'
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="segment_index"\r\n\r\n${session.chunks.length}\r\n--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      assert.deepEqual(payload.subarray(0, prefix.length), prefix)
      assert.deepEqual(payload.subarray(-suffix.length), suffix)
      session.chunks.push(payload.subarray(prefix.length, -suffix.length))
      if (state.failUpload) return Response.json({ errors: [{ detail: accessToken }] }, { status: 503 })
      return Response.json({ data: {} })
    }
    if (session && url.pathname === `/2/media/upload/${session.id}/finalize`) {
      assert.equal(Buffer.concat(session.chunks).length, session.total_bytes)
      return Response.json({ data: { id: state.finalizeMismatch ? mediaId(99) : session.id, ...(state.async && { processing_info: { state: 'pending', check_after_secs: 1 } }) } })
    }
    if (url.pathname === '/2/media/upload') {
      assert.equal(request.method, 'GET')
      assert.equal(url.searchParams.get('media_id'), session.id)
      assert.equal(url.searchParams.get('command'), 'STATUS')
      return Response.json({ data: { id: session.id, processing_info: { state: state.processingFail ? 'failed' : 'succeeded' } } })
    }
    if (url.pathname === '/2/tweets') {
      assert.equal(request.method, 'POST')
      state.created = JSON.parse(request.body)
      await state.beforeCreate?.()
      if (state.disconnect) throw new Error(accessToken)
      if (state.rejected) return Response.json({ errors: [{ detail: accessToken }] }, { status: 403 })
      return Response.json({ data: state.noReceipt ? {} : { id: postId }, ...(state.partialError && { errors: [{ detail: accessToken }] }) }, { status: 201 })
    }
    if (url.pathname === `/2/tweets/${postId}`) {
      if (state.readDenied) return new Response('{}', { status: 403 })
      return Response.json({ data: { id: postId, author_id: state.postOwner ?? userId } })
    }
    assert.fail('Unexpected mocked X request: ' + url.pathname)
  } })
  return { adapter, calls, sessions, waits, state, resolvePlatform: key => key === 'x' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('X task did not finish')
}

for (const count of [1, 2, 4]) test(`X ${count} 张图文：顺序快照、真实 MIME、分片处理、检查点、单次发布与回查`, async context => {
  const { root, store, input, rows, path } = await fixture(context, 'images', count)
  const { calls, state, sessions, waits, resolvePlatform } = mock({ async: true })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  assert.equal(prepared.draft.format, 'images')
  assert.equal(prepared.cover, null)
  assert.equal(prepared.video, null)
  assert.deepEqual(prepared.images.map(image => image.id), rows.map(row => row.id).reverse())
  assert.ok(calls.every(([method]) => method === 'GET'))
  state.beforeCreate = async () => {
    assert.equal(JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8')).records[0].submissionStarted, true)
  }
  const start = { id, taskId: prepared.taskId, confirmed: true }
  await assert.rejects(publishing.start({ ...start, confirmed: false }), /明确确认/)
  await publishing.start(start)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(job.receiptId, postId)
  assert.deepEqual(state.created, { text: xCaption(draft), made_with_ai: true, paid_partnership: false, media: { media_ids: sessions.map(session => session.id) } })
  for (let index = 0; index < count; index++) assert.deepEqual(Buffer.concat(sessions[index].chunks), await readFile(path(rows[count - index - 1])))
  assert.deepEqual(waits, Array(count).fill(1000))
  await publishing.start(start)
  assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/2/tweets').length, 1)
  const persisted = await readFile(join(root, '.publish-records.json'), 'utf8')
  for (const privateValue of [accessToken, ...sessions.map(session => session.id), 'processing_info', 'multipart/form-data']) assert.ok(!persisted.includes(privateValue))
  state.readDenied = true
  let reviewed = await publishing.review(start)
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.url, job.url)
  assert.ok(reviewed.reviewError)
  state.readDenied = false
  state.postOwner = '99999999'
  assert.ok((await publishing.review(start)).reviewError)
  state.postOwner = userId
  assert.equal((await new Publishing(store, { resolvePlatform }).review(start)).reviewError, undefined)
  await assert.rejects(publishing.prepare(input), /已有/)
})

test('X 纯文字不读取缺失的已选图片、不调用上传 API，保留 AI/商业合作声明', async context => {
  const { root, store, input, rows, path } = await fixture(context, 'text')
  for (const row of rows) await rm(path(row))
  const { calls, state, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  assert.equal(prepared.draft.format, 'text')
  assert.equal(prepared.images, undefined)
  assert.equal(prepared.video, null)
  assert.equal(prepared.cover, null)
  assert.ok(calls.every(([method]) => method === 'GET'))
  const start = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(start)
  assert.equal((await finish(publishing)).status, 'published')
  assert.deepEqual(state.created, { text: xCaption(draft), made_with_ai: true, paid_partnership: false })
  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [['POST', '/2/tweets']])
  assert.equal((await publishing.review(start)).reviewError, undefined)
})

test('X 图片顺序、类型或文件变化使旧确认单失效，准备和过期确认不能发素材', async context => {
  const { root, store, assets, saved, rows, path, input } = await fixture(context)
  const { calls, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  let prepared = await publishing.prepare(input)
  const changed = await assets.save(id, saved.revision, { ...saved, publish: { ...saved.publish, format: 'text' } })
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化/)
  prepared = await publishing.prepare({ ...input, revision: changed.revision })
  const restored = await assets.save(id, changed.revision, { ...changed, publish: { ...changed.publish, format: 'images' } })
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化/)
  prepared = await publishing.prepare({ ...input, revision: restored.revision })
  const reordered = await assets.save(id, restored.revision, { ...restored, imageIds: [...restored.imageIds].reverse() })
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化/)
  prepared = await publishing.prepare({ ...input, revision: reordered.revision })
  await writeFile(path(rows[0]), Buffer.concat([png, Buffer.from('changed')]))
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化|格式无效/)
  assert.ok(calls.every(([method]) => method === 'GET'))
})

test('X 无图或超过四张图在准备阶段即拒绝，不上传素材', async context => {
  const { root, store, input, assets, saved } = await fixture(context, 'images', 5)
  const { calls, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  await assert.rejects(publishing.prepare(input), /数量/)
  const empty = await assets.save(id, saved.revision, { ...saved, imageIds: [] })
  await assert.rejects(publishing.prepare({ ...input, revision: empty.revision }), /数量/)
  assert.ok(calls.every(([method]) => method === 'GET'))
})

for (const [label, overrides] of [
  ['无效媒体 ID', { invalidId: true }], ['重复媒体 ID', { duplicate: true }], ['无效有效期', { expiry: 0 }],
  ['上传失败', { failUpload: true }], ['完成回执不匹配', { finalizeMismatch: true }], ['处理失败', { async: true, processingFail: true }],
]) test(`X 图文${label}：不发送最终帖子，不泄露令牌`, async context => {
  const { root, store, input } = await fixture(context)
  const { calls, resolvePlatform } = mock(overrides)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  const job = await finish(publishing)
  assert.equal(job.status, 'failed')
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/2/tweets'), false)
  assert.ok(!JSON.stringify(job).includes(accessToken))
})

for (const format of ['images', 'text']) for (const [label, overrides, status] of [
  ['断线', { disconnect: true }, 'unknown'], ['缺回执', { noReceipt: true }, 'unknown'], ['部分错误', { partialError: true }, 'unknown'], ['明确拒绝', { rejected: true }, 'failed'],
]) test(`X ${format} 最终${label}：不自动重发，未知结果阻止再次准备`, async context => {
  const { root, store, input } = await fixture(context, format, format === 'images' ? 2 : 0)
  const { calls, resolvePlatform } = mock(overrides)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, status)
  if (status === 'unknown') await assert.rejects(publishing.prepare(input), /已有/)
  assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/2/tweets').length, 1)
})

test('X 上传后公开账号改变，停止创建帖子', async context => {
  const { root, store, input } = await fixture(context)
  const { state, calls, sessions, resolvePlatform } = mock()
  state.beforeAccount = async () => { if (sessions.length) state.protected = true }
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'failed')
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/2/tweets'), false)
})

test('X 第一张图在后续操作期间过期，最终发帖前再次核对所有会话', async context => {
  const { root, store, input } = await fixture(context)
  const { state, calls, sessions, resolvePlatform } = mock({ expiry: 1 })
  state.beforeAccount = async () => { if (sessions.length) await delay(1050) }
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  const job = await finish(publishing)
  assert.equal(job.status, 'failed')
  assert.match(job.message, /过期/)
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/2/tweets'), false)
})

test('X 图文数量、大小、MIME 与混发校验；缺图不能降级为纯文字', () => {
  const { adapter } = mock()
  const image = { mime: 'image/png', sizeBytes: png.length, stream: () => Readable.from([png]) }
  assert.equal(xImagesIssue([image]), '')
  assert.equal(xImagesIssue([{ ...image, sizeBytes: X_IMAGE_BYTES }]), '')
  for (const images of [[], Array(5).fill(image), [{ ...image, sizeBytes: X_IMAGE_BYTES + 1 }], [{ ...image, mime: 'image/gif' }], [{ ...image, mime: 'image/webp' }]]) {
    assert.ok(xImagesIssue(images))
    assert.throws(() => adapter.check({ draft: { ...draft, format: 'images' }, images }))
  }
  assert.throws(() => adapter.check({ draft: { ...draft, format: 'images' }, images: [image], video: {} }), /混发/)
  assert.throws(() => adapter.check({ draft: { ...draft, format: 'text' }, images: [image] }), /不能混入/)
})
