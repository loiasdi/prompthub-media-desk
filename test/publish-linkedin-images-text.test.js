import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { assetFileName } from '../src/asset-rules.js'
import { linkedInCommentary } from '../src/publish/draft-copy.js'
import { linkedInImagesIssue } from '../src/publish/media-rules.js'
import { createLinkedInAdapter } from '../src/publish/linkedin/index.js'
import { DEFAULT_LINKEDIN_VERSION } from '../src/publish/linkedin/client.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const id = 'linkedin-image-text'
const memberId = 'mock-member', owner = `urn:li:person:${memberId}`
const receiptId = 'urn:li:ugcPost:123456789'
const accessToken = 'mock-linkedin-token'
const options = { privacyStatus: 'public' }
const draft = { title: '图片稿件 [测试]', description: '正文 | @用户', topics: ['标签'], ...options }
const png = Buffer.from('89504e470d0a1a0a', 'hex')
const imageUrn = index => `urn:li:image:IMAGE_${index}`
const uploadUrl = index => `https://www.linkedin.com/dms-uploads/IMAGE_${index}/uploaded-image/0?ut=private-upload-token`

async function fixture(context, format = 'images', count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'md-linkedin-image-text-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id, title: draft.title, body: draft.description, tags: draft.topics, platform: 'LinkedIn' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ width: 100, height: 100 }) })
  let current = await assets.read(id)
  const rows = []
  for (let index = 0; index < count; index++) {
    const { workspace, asset } = await assets.import(id, Readable.from([Buffer.concat([png, Buffer.from([index])])]), { revision: current.revision, name: `${index + 1}.png` })
    current = workspace
    rows.push(asset)
  }
  const saved = await assets.save(id, current.revision, { ...current, imageIds: rows.map(row => row.id).reverse(), selectedCover: rows[0]?.id || '', publish: { ...current.publish, format, mode: 'now' } })
  const path = row => join(root, '内容', id, '素材', assetFileName(row.src).split('/').at(-1))
  return { root, store, assets, rows, path, saved, input: { id, platform: 'linkedin', revision: saved.revision, options } }
}

function mock(overrides = {}) {
  const calls = [], uploads = [], state = { count: 0, ...overrides }
  const adapter = createLinkedInAdapter({ memberId }, { fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(request.redirect, 'error')
    if (url.origin === 'https://www.linkedin.com') {
      assert.equal(request.method, 'PUT')
      // Official image uploads, unlike video chunks, require OAuth.
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
      assert.equal(request.headers['content-type'], 'application/octet-stream')
      assert.equal(request.duplex, 'half')
      const chunks = []
      for await (const chunk of request.body) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      assert.equal(bytes.length, Number(request.headers['content-length']))
      uploads.push(bytes)
      if (state.changeAccountAfterUpload) state.memberId = 'different-member'
      if (state.failUpload) return new Response(null, { status: 503 })
      return new Response(null, { status: 201 })
    }
    assert.equal(url.origin, 'https://api.linkedin.com')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    if (url.pathname === '/v2/userinfo') return Response.json({ sub: state.memberId ?? memberId, name: '测试作者' })
    assert.equal(request.headers['Linkedin-Version'], DEFAULT_LINKEDIN_VERSION)
    assert.equal(request.headers['X-Restli-Protocol-Version'], '2.0.0')
    if (url.pathname === '/rest/images') {
      assert.equal(request.method, 'POST') // Do not add an unavailable w_member_social-only GET gate.
      assert.equal(url.searchParams.get('action'), 'initializeUpload')
      assert.deepEqual(JSON.parse(request.body), { initializeUploadRequest: { owner } })
      state.count++
      return Response.json({ value: { image: state.duplicate ? imageUrn(1) : state.invalidImage ? 'urn:li:video:WRONG' : imageUrn(state.count), uploadUrl: state.uploadUrl ?? uploadUrl(state.count), uploadUrlExpiresAt: state.expires ?? Date.now() + 60_000 } })
    }
    if (url.pathname === '/rest/posts') {
      assert.equal(request.method, 'POST')
      state.created = JSON.parse(request.body)
      await state.beforeCreate?.()
      if (state.disconnect) throw new Error(accessToken)
      if (state.rejected) return Response.json({ message: accessToken }, { status: 403 })
      return new Response(null, { status: 201, headers: state.missingReceipt ? {} : { 'x-restli-id': receiptId } })
    }
    if (url.pathname === '/rest/posts/' + encodeURIComponent(receiptId)) {
      assert.equal(request.method, 'GET')
      assert.equal(url.searchParams.get('viewContext'), 'AUTHOR')
      if (state.readDenied) return new Response('{}', { status: 403 })
      const content = state.reverse ? { multiImage: { images: [...state.created.content.multiImage.images].reverse() } } : state.created.content
      return Response.json({ id: receiptId, author: owner, ...(content && { content }), visibility: 'PUBLIC', lifecycleState: state.postState ?? 'PUBLISHED' })
    }
    assert.fail('Unexpected mocked LinkedIn request: ' + url.pathname)
  } })
  return { adapter, calls, uploads, state, resolvePlatform: key => key === 'linkedin' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('LinkedIn task did not finish')
}

for (const count of [1, 2, 20]) test(`LinkedIn ${count} 张图片：顺序快照、流式直传、单图/多图结构、检查点、待确认回执和回查`, async context => {
  const { store, root, input, rows, path } = await fixture(context, 'images', count)
  const { calls, state, uploads, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  assert.equal(prepared.draft.format, 'images')
  assert.equal(prepared.video, null)
  assert.equal(prepared.cover, null)
  assert.deepEqual(prepared.images.map(row => row.id), rows.map(row => row.id).reverse())
  assert.ok(calls.every(([method]) => method === 'GET'))
  state.beforeCreate = async () => {
    assert.equal(JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8')).records[0].submissionStarted, true)
  }
  const start = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(start)
  const job = await finish(publishing)
  assert.equal(job.status, 'pending_review') // Image processing is async; do not overclaim availability.
  assert.equal(job.receiptId, receiptId)
  assert.equal(state.created.commentary, linkedInCommentary(draft))
  assert.equal(state.created.visibility, 'PUBLIC')
  if (count === 1) assert.deepEqual(state.created.content, { media: { id: imageUrn(1) } })
  else assert.deepEqual(state.created.content, { multiImage: { images: Array.from({ length: count }, (_, index) => ({ id: imageUrn(index + 1) })) } })
  for (let index = 0; index < count; index++) assert.deepEqual(uploads[index], await readFile(path(rows[count - index - 1])))
  await publishing.start(start)
  assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/rest/posts').length, 1)
  const persisted = await readFile(join(root, '.publish-records.json'), 'utf8')
  assert.deepEqual(JSON.parse(persisted).records[0].mediaIds, Array.from({ length: count }, (_, index) => imageUrn(index + 1)))
  for (const secret of [accessToken, 'private-upload-token', 'dms-uploads', png.toString('base64')]) assert.ok(!persisted.includes(secret))
  state.readDenied = true
  let reviewed = await publishing.review(start)
  assert.equal(reviewed.status, 'pending_review')
  assert.match(reviewed.reviewError, /r_member_social/)
  state.readDenied = false
  if (count > 1) {
    state.reverse = true
    reviewed = await publishing.review(start)
    assert.equal(reviewed.status, 'pending_review')
    assert.match(reviewed.reviewError, /顺序/)
    state.reverse = false
  }
  state.postState = 'PUBLISH_REQUESTED'
  assert.equal((await publishing.review(start)).status, 'pending_review')
  state.postState = 'PUBLISHED'
  assert.equal((await new Publishing(store, { resolvePlatform }).review(start)).status, 'published')
  await assert.rejects(publishing.prepare(input), /已有/)
})

test('LinkedIn 纯文字不读取残留图片，不调用素材 API；人工确认后仅创建一次帖子', async context => {
  const { store, root, input, rows, path } = await fixture(context, 'text')
  for (const row of rows) await rm(path(row)) // Selected-but-missing media must be irrelevant in text mode.
  const { calls, state, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  assert.equal(prepared.draft.format, 'text')
  assert.equal(prepared.video, null)
  assert.equal(prepared.cover, null)
  assert.equal(prepared.images, undefined)
  const start = { id, taskId: prepared.taskId, confirmed: true }
  await assert.rejects(publishing.start({ ...start, confirmed: false }), /明确确认/)
  assert.ok(calls.every(([method]) => method === 'GET'))
  await publishing.start(start)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(state.created.content, undefined)
  assert.equal(state.created.commentary, linkedInCommentary(draft))
  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [['POST', '/rest/posts']])
  assert.equal((await publishing.review(start)).status, 'published')
})

test('LinkedIn 图片变更与类型变更使旧确认单失效，不上传或发帖', async context => {
  const { store, root, input, assets, saved, rows, path } = await fixture(context)
  const { calls, resolvePlatform } = mock()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  let prepared = await publishing.prepare(input)
  const changed = await assets.save(id, saved.revision, { ...saved, publish: { ...saved.publish, format: 'text' } })
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化/)
  const restored = await assets.save(id, changed.revision, { ...changed, publish: { ...changed.publish, format: 'images' } })
  prepared = await publishing.prepare({ ...input, revision: restored.revision })
  await writeFile(path(rows[0]), Buffer.concat([png, Buffer.from('changed')]))
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), /变化|格式无效/)
  assert.ok(calls.every(([method]) => method === 'GET'))
})

for (const [label, overrides] of [
  ['恶意上传地址', { uploadUrl: 'https://evil.example/dms-uploads/image' }],
  ['伪域', { uploadUrl: 'https://www.linkedin.com.evil.example/dms-uploads/image' }],
  ['明文上传', { uploadUrl: 'http://www.linkedin.com/dms-uploads/image' }],
  ['非上传路径', { uploadUrl: 'https://www.linkedin.com/feed/' }],
  ['已过期', { expires: 1 }],
  ['非图片 URN', { invalidImage: true }],
  ['重复图片 URN', { duplicate: true }],
  ['上传失败', { failUpload: true }],
]) test(`LinkedIn ${label} 不发送最终帖子请求且不泄露令牌`, async context => {
  const { store, root, input } = await fixture(context)
  const { calls, resolvePlatform } = mock(overrides)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  const job = await finish(publishing)
  assert.equal(job.status, 'failed')
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/rest/posts'), false)
  assert.ok(!JSON.stringify(job).includes(accessToken))
})

for (const format of ['text', 'images']) for (const [label, overrides, expected] of [
  ['断线', { disconnect: true }, 'unknown'], ['缺失回执', { missingReceipt: true }, 'unknown'], ['明确拒绝', { rejected: true }, 'failed'],
]) test(`LinkedIn ${format} 最终${label}：保留可确认状态、不自动重发`, async context => {
  const { store, root, input } = await fixture(context, format, format === 'images' ? 2 : 0)
  const { calls, resolvePlatform } = mock(overrides)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, expected)
  if (expected === 'unknown') await assert.rejects(publishing.prepare(input), /已有/)
  assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/rest/posts').length, 1)
})

test('LinkedIn 图片上传后账号变化，在最终检查点前停止创建帖子', async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls } = mock({ changeAccountAfterUpload: true })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  await publishing.start({ id, taskId: prepared.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'failed')
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/rest/posts'), false)
  assert.equal(JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8')).records[0].submissionStarted, undefined)
})

test('LinkedIn 图文处理明确失败后标记拒绝，允许重新准备，不自动重投', async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform } = mock({ postState: 'PUBLISH_FAILED' })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  const start = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(start)
  await finish(publishing)
  const reviewed = await publishing.review(start)
  assert.equal(reviewed.status, 'rejected')
  assert.equal(reviewed.url, undefined)
  assert.ok((await publishing.prepare(input)).taskId)
})

test('LinkedIn 图片数量/大小/像素和混发校验，不能将缺图静默变成纯文字', () => {
  const { adapter } = mock()
  const image = { sizeBytes: png.length, mime: 'image/png', stream: () => Readable.from([png]) }
  for (const images of [[], Array(21).fill(image), [{ ...image, mime: 'image/gif' }], [{ ...image, sizeBytes: 10 * 1024 * 1024 + 1 }], [{ ...image, width: 10_000, height: 10_000 }]]) {
    assert.ok(linkedInImagesIssue(images))
    assert.throws(() => adapter.check({ draft: { ...draft, format: 'images' }, images }))
  }
  assert.equal(linkedInImagesIssue([image]), '')
  assert.throws(() => adapter.check({ draft: { ...draft, format: 'images' }, images: [image], video: {} }), /混发/)
  assert.throws(() => adapter.check({ draft: { ...draft, format: 'text' }, images: [image] }), /不能混入/)
})
