import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { assetFileName } from '../src/asset-rules.js'
import { PUBLISH_PLATFORMS } from '../src/publish/capabilities.js'
import { facebookCaption, facebookCopyIssue } from '../src/publish/draft-copy.js'
import { createFacebookClient } from '../src/publish/facebook/client.js'
import { readFacebookFeedStatus } from '../src/publish/facebook/feed.js'
import { createFacebookAdapter } from '../src/publish/facebook/index.js'
import { FACEBOOK_IMAGE_BYTES, facebookImagesIssue } from '../src/publish/media-rules.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const id = 'facebook-feed', pageId = '104115123456789', postId = `${pageId}_123456789`
const token = 'mock-facebook-page-token'
const options = { privacyStatus: 'public', isAiGenerated: true }
const draft = { title: '动态标题 [测试]', description: '动态正文 | @用户', topics: ['标签'], format: 'images', ...options }
const png = Buffer.from('89504e470d0a1a0a', 'hex')
const jpeg = Buffer.from('ffd8ff', 'hex')
const photoId = index => String(700000000 + index)

async function fixture(t, format = 'images', count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'md-facebook-feed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id, title: draft.title, body: draft.description, tags: draft.topics, platform: 'Facebook' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ width: 100, height: 100 }) })
  let current = await assets.read(id)
  const images = [], payloads = []
  for (let index = 0; index < count; index++) {
    const bytes = Buffer.concat([index % 2 ? jpeg : png, Buffer.from([index])])
    const row = await assets.import(id, Readable.from([bytes]), { revision: current.revision, name: `${index + 1}.${index % 2 ? 'jpg' : 'png'}` })
    current = row.workspace; images.push(row.asset); payloads.push(bytes)
  }
  const ws = await assets.save(id, current.revision, { ...current, selectedVideo: 'unused-video', selectedCover: 'unused-cover', imageIds: images.map(image => image.id).reverse(), publish: { ...current.publish, format, mode: 'now' } })
  const path = image => join(root, '内容', id, '素材', assetFileName(image.src).split('/').at(-1))
  return { root, store, assets, ws, images, path, payloads: payloads.reverse(), input: { id, platform: 'facebook', revision: ws.revision, options } }
}

function mock(version = 'v27.0') {
  const state = { photos: [], accountId: pageId, created: false, published: false, readError: false }
  const calls = []
  const adapter = createFacebookAdapter({ pageId, graphVersion: version }, { fetchImpl: async (url, request) => {
    assert.equal(url.origin, 'https://graph.facebook.com')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    const call = { method: request.method, path: url.pathname }
    calls.push(call)
    if (url.pathname === `/${version}/me`) return Response.json({ id: state.created && state.finalAccountId || state.accountId, name: '模拟公共主页' })
    if (url.pathname === `/${version}/${pageId}/photos`) {
      assert.equal(request.method, 'POST')
      assert.equal(request.duplex, 'half')
      assert.equal(request.headers.offset, undefined)
      assert.equal(request.headers.file_size, undefined)
      const chunks = []; for await (const chunk of request.body) chunks.push(chunk)
      const body = Buffer.concat(chunks), boundary = request.headers['content-type'].split('boundary=')[1]
      assert.equal(body.length, Number(request.headers['content-length']))
      const prefix = body.subarray(0, body.indexOf('\r\n\r\n', body.indexOf('filename=')) + 4)
      assert.match(prefix.toString(), /name="published"\r\n\r\nfalse\r\n/)
      assert.match(prefix.toString(), /name="source"; filename="image\.(?:png|jpg)"\r\nContent-Type: image\/(?:png|jpeg)\r\n/)
      assert.equal(prefix.toString().includes('url'), false)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      assert.deepEqual(body.subarray(-suffix.length), suffix)
      state.photos.push(body.subarray(prefix.length, -suffix.length))
      return Response.json({ id: state.badPhoto ? '' : state.duplicatePhoto ? photoId(1) : photoId(state.photos.length) })
    }
    if (url.pathname === `/${version}/${pageId}/feed`) {
      assert.equal(request.method, 'POST')
      assert.equal(request.body.get('published'), 'false')
      call.fields = Object.fromEntries(request.body)
      state.created = true
      return Response.json({ id: state.draftId ?? postId })
    }
    if (url.pathname === `/${version}/${postId}` && request.method === 'POST') {
      call.fields = Object.fromEntries(request.body)
      await state.beforeFinal?.()
      assert.equal(request.body.get('is_published'), 'true')
      state.published = true
      if (state.finalError) throw new Error(`untrusted response: ${token}`)
      return Response.json({ success: !state.finalUnconfirmed })
    }
    if (url.pathname === `/${version}/${postId}` && request.method === 'GET') {
      assert.equal(url.searchParams.get('fields'), 'id,from,is_published,is_hidden')
      if (state.readError) return Response.json({ error: { message: token } }, { status: 403 })
      return Response.json({ id: postId, from: { id: pageId }, is_published: state.published, is_hidden: false, ...(state.published ? state.reviewOverride : state.draftOverride) })
    }
    throw new Error(`Unexpected mock call ${request.method} ${url.pathname}`)
  } })
  return { state, calls, adapter, resolvePlatform: platform => platform === 'facebook' ? { adapter, accessToken: token } : null }
}

async function finish(publishing) {
  for (let index = 0; index < 150; index++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job?.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Facebook mock publishing timed out')
}

async function begin(f, remote) {
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const preparation = await publishing.prepare(f.input)
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  return { publishing, preparation, payload, job: await finish(publishing) }
}

for (const count of [1, 2, 10]) test(`Facebook 图文 ${count} 张：本地 multipart、顺序、发布前 AI 同次设置、回执检查点`, async t => {
  const f = await fixture(t, 'images', count), remote = mock()
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  assert.deepEqual(await publishing.options('facebook'), { account: '模拟公共主页', categories: [], constraints: { feedAiSupported: true, storySupported: true } })
  const preparation = await publishing.prepare(f.input)
  assert.equal(preparation.draft.format, 'images')
  assert.equal(preparation.video, null)
  assert.equal(preparation.cover, null)
  assert.deepEqual(preparation.images.map(image => image.filename), f.images.map(image => image.name).reverse())
  assert.ok(remote.calls.every(call => call.method === 'GET'))
  remote.state.beforeFinal = async () => {
    const records = JSON.parse(await readFile(join(f.root, '.publish-records.json'), 'utf8')).records
    assert.equal(records[0].receiptId, postId)
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].status, 'publishing')
  }
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(publishing.start({ ...payload, confirmed: false }), /明确确认/)
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, postId)
  assert.deepEqual(remote.state.photos, f.payloads)
  const create = remote.calls.find(call => call.path.endsWith('/feed'))
  assert.equal(create.fields.message, facebookCaption({ ...draft, format: 'images' }))
  assert.equal(create.fields.message.startsWith(draft.title), true)
  for (let index = 0; index < count; index++) assert.deepEqual(JSON.parse(create.fields[`attached_media[${index}]`]), { media_fbid: photoId(index + 1) })
  const final = remote.calls.find(call => call.method === 'POST' && call.path.endsWith(postId))
  assert.deepEqual(final.fields, { is_published: 'true', is_ai_generated: 'true' })
  const lastAccount = remote.calls.findLastIndex(call => call.path.endsWith('/me'))
  assert.equal(remote.calls[lastAccount + 1], final)
  assert.equal(remote.calls.filter(call => call.path.endsWith('/feed')).length, 1)
  const reviewed = await publishing.review({ id, taskId: preparation.taskId })
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.url, `https://www.facebook.com/${pageId}/posts/123456789`)
  assert.equal(PUBLISH_PLATFORMS.facebook.workUrl.test(reviewed.url), true)
  const beforeRepeat = remote.calls.length
  await publishing.start(payload)
  assert.equal(remote.calls.length, beforeRepeat)
  await assert.rejects(publishing.prepare(f.input), /已有/)
})

test('Facebook 纯文字：残留选材不读取，标题与话题并入正文，无图片或独立标题字段', async t => {
  const f = await fixture(t, 'text'), remote = mock()
  for (const image of f.images) await rm(f.path(image))
  const { job, preparation } = await begin(f, remote)
  assert.equal(job.status, 'pending_review')
  assert.equal(preparation.images, undefined)
  assert.equal(remote.state.photos.length, 0)
  const fields = remote.calls.find(call => call.path.endsWith('/feed')).fields
  assert.deepEqual(fields, { message: facebookCaption({ ...draft, format: 'text' }), published: 'false' })
})

test('Facebook 图片规则：数量、真实 MIME 和每张 10 MB；文案限制包括合并后的标题', () => {
  const image = { mime: 'image/png', sizeBytes: FACEBOOK_IMAGE_BYTES }
  assert.equal(facebookImagesIssue([image]), '')
  assert.equal(facebookImagesIssue(Array(10).fill(image)), '')
  for (const images of [undefined, [], Array(11).fill(image), [{ ...image, mime: 'image/webp' }], [{ ...image, sizeBytes: 0 }], [{ ...image, sizeBytes: NaN }], [{ ...image, sizeBytes: FACEBOOK_IMAGE_BYTES + 1 }]]) assert.ok(facebookImagesIssue(images))
  assert.equal(facebookCopyIssue({ ...draft, title: 't', description: 'x'.repeat(15997), topics: [] }), '')
  assert.match(facebookCopyIssue({ ...draft, title: 'tt', description: 'x'.repeat(15997), topics: [] }), /16000/)
  assert.match(facebookCopyIssue({ ...draft, topics: ['bad tag'] }), /话题/)
  const adapter = mock().adapter
  const source = { ...image, stream: () => Readable.from(png) }
  assert.throws(() => adapter.check({ draft, images: [] }), /1 至 10/)
  assert.throws(() => adapter.check({ draft, images: [source], video: {} }), /不发送/)
  assert.throws(() => adapter.check({ draft: { ...draft, format: 'text' }, images: [source] }), /不发送图片/)
  assert.throws(() => adapter.check({ draft: { ...draft, format: 'article' }, images: [source] }), /对应类型/)
  assert.equal(PUBLISH_PLATFORMS.facebook.workUrl.test('https://www.facebook.com/1/posts/2?access_token=secret'), false)
})

test('Facebook v25：仍能发布非 AI 动态，不发送未支持的 AI 参数；AI 动态先阻止并提示升级', async t => {
  const f = await fixture(t, 'text'), remote = mock('v25.0')
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  await assert.rejects(publishing.prepare(f.input), /v27\.0/)
  assert.ok(remote.calls.every(call => call.method === 'GET'))
  f.input.options = { ...options, isAiGenerated: false }
  const { job } = await begin(f, remote)
  assert.equal(job.status, 'pending_review')
  assert.deepEqual(remote.calls.find(call => call.method === 'POST' && call.path.endsWith(postId)).fields, { is_published: 'true' })
})

for (const issue of ['badPhoto', 'duplicatePhoto', 'draftId']) test(`Facebook ${issue}：异常媒体/草稿回执不发公开请求`, async t => {
  const f = await fixture(t), remote = mock()
  remote.state[issue] = issue === 'draftId' ? '999_123456789' : true
  const { job } = await begin(f, remote)
  assert.equal(job.status, 'failed')
  assert.equal(remote.calls.some(call => call.method === 'POST' && call.path.endsWith(postId)), false)
  assert.equal(remote.calls.some(call => call.path.endsWith('/feed')), issue === 'draftId')
})

for (const issue of ['finalError', 'finalUnconfirmed']) test(`Facebook ${issue}：公开响应不确定仍持久化回执、阻止重投并能恢复回查`, async t => {
  const f = await fixture(t), remote = mock()
  remote.state[issue] = true
  const { publishing, job, preparation } = await begin(f, remote)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, postId)
  assert.equal(job.canReview, true)
  assert.equal(JSON.stringify(job).includes(token), false)
  await assert.rejects(publishing.prepare(f.input), /已有/)
  const restarted = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  assert.equal((await restarted.review({ id, taskId: preparation.taskId })).status, 'published')
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith(postId)).length, 1)
})

test('Facebook 上传后账号变化：再次核对公共主页身份，不发公开请求', async t => {
  const f = await fixture(t), remote = mock()
  remote.state.finalAccountId = '999'
  const { job } = await begin(f, remote)
  assert.equal(job.status, 'failed')
  assert.equal(job.receiptId, postId)
  assert.match(job.message, /公共主页不一致/)
  assert.equal(remote.calls.some(call => call.method === 'POST' && call.path.endsWith(postId)), false)
})

for (const draftOverride of [{ is_published: true }, { is_hidden: true }, { from: { id: '999' } }, { is_published: null }]) test(`Facebook 草稿状态异常 ${JSON.stringify(draftOverride)}：不公开，保留可核对回执`, async t => {
  const f = await fixture(t), remote = mock()
  remote.state.draftOverride = draftOverride
  const { job } = await begin(f, remote)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, postId)
  assert.equal(remote.calls.some(call => call.method === 'POST' && call.path.endsWith(postId)), false)
})

test('Facebook 动态回查：未发表/隐藏不冒充公开，失败保留既有成功回执与安全链接', async t => {
  const f = await fixture(t), remote = mock()
  const { publishing, preparation } = await begin(f, remote)
  const request = { id, taskId: preparation.taskId }
  remote.state.reviewOverride = { is_published: false }
  assert.equal((await publishing.review(request)).status, 'unknown')
  remote.state.reviewOverride = { is_hidden: true }
  assert.equal((await publishing.review(request)).url, undefined)
  remote.state.reviewOverride = undefined
  const success = await publishing.review(request)
  assert.equal(success.status, 'published')
  remote.state.readError = true
  const failed = await publishing.review(request)
  assert.equal(failed.status, 'published')
  assert.equal(failed.url, success.url)
  assert.equal(failed.receiptId, postId)
  assert.equal(JSON.stringify(failed).includes(token), false)
  for (const override of [{ id: '999_123456789' }, { from: { id: '999' } }, { is_hidden: undefined }, { is_published: 'true' }]) assert.throws(() => readFacebookFeedStatus({ id: postId, from: { id: pageId }, is_hidden: false, is_published: true, ...override }, postId, pageId), /完整动态状态/)
})

test('Facebook 确认单后本地图片变化：禁止执行，准备阶段不上传图片', async t => {
  const f = await fixture(t), remote = mock()
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const preparation = await publishing.prepare(f.input)
  const image = f.images[0]
  await writeFile(f.path(image), Buffer.concat([png, Buffer.from('changed')]))
  await assert.rejects(publishing.start({ id, taskId: preparation.taskId, confirmed: true }), /变化|重新检查|素材/)
  assert.ok(remote.calls.every(call => call.method === 'GET'))
})

test('Facebook multipart 请求异常关闭流，固定 Graph 域名且不泄漏凭据', async () => {
  let stream
  const client = createFacebookClient({ pageId, graphVersion: 'v27.0' }, { fetchImpl: async (url, request) => {
    assert.equal(url.href, `https://graph.facebook.com/v27.0/${pageId}/photos`)
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    throw new Error(`bad location https://evil.invalid/${token}`)
  } })
  await assert.rejects(client.uploadPhoto(token, { mime: 'image/png', sizeBytes: png.length, filename: 'bad\r\nfilename.png', stream: () => { stream = Readable.from([png]); return stream } }), error => error.stage === 'upload' && !error.message.includes(token) && !error.message.includes('evil.invalid'))
  assert.equal(stream.destroyed, true)
  let calls = 0
  const aborted = createFacebookClient({ pageId }, { fetchImpl: async () => { calls++; return Response.json({ id: photoId(1) }) } })
  await assert.rejects(aborted.uploadPhoto(token, { mime: 'image/png', sizeBytes: 8, stream: () => assert.fail('Aborted photo must not open a stream') }, AbortSignal.abort()), /取消/)
  assert.equal(calls, 0)
})
