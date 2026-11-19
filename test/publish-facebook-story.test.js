import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { createFacebookAdapter } from '../src/publish/facebook/index.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const id = 'fb-story', pageId = '104115123456789', videoId = '705432109876543', postId = '123456789001234'
const token = 'mock-page-token'
const bytes = Buffer.from('0000ftypabcde')
const photoBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const photoId = '705432109876544'
const metadata = { duration: 20, width: 1080, height: 1920, frameRate: 30 }
const video = { ...metadata, mime: 'video/mp4', sizeBytes: bytes.length, stream: () => Readable.from([bytes]) }
const options = { destination: 'story', privacyStatus: 'public', isAiGenerated: true }
const draft = { title: '仅本地记录标题', description: '不发送的正文', topics: ['不发送的话题'], ...options }
const source = `https://rupload.facebook.com/video-upload/v27.0/${videoId}`
const collect = async body => { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks) }
const storyRow = (overrides = {}) => ({ post_id: postId, status: 'PUBLISHED', media_type: 'video', media_id: videoId, url: `https://www.facebook.com/stories/${postId}`, ...overrides })

function mock(version = 'v27.0') {
  const state = { uploaded: false, accountId: pageId, stories: [storyRow()], photoId }, calls = []
  const adapter = createFacebookAdapter({ pageId, graphVersion: version }, { fetchImpl: async (url, req) => {
    assert.equal(req.redirect, 'error')
    if (req.method === 'GET') {
      if (url.pathname === `/${version}/${pageId}/stories`) assert.equal(url.search, '')
      else assert.deepEqual(Object.fromEntries(url.searchParams), { fields: 'id,name' })
    }
    else assert.equal(url.search, '', '令牌和媒体 URL 不放入 query')
    calls.push(`${req.method} ${url.pathname}`)
    if (url.origin === 'https://rupload.facebook.com') {
      assert.equal(url.href, state.uploadUrl || source)
      assert.equal(req.method, 'POST')
      assert.equal(req.headers.authorization, `OAuth ${token}`)
      assert.equal(req.headers['content-type'], 'application/octet-stream')
      assert.equal(req.headers['content-length'], String(bytes.length))
      assert.equal(req.headers.file_size, String(bytes.length))
      assert.equal(req.headers.offset, '0')
      assert.equal(req.duplex, 'half')
      await state.beforeUpload?.()
      assert.deepEqual(await collect(req.body), bytes)
      state.uploaded = true
      return Response.json({ success: state.badUpload ? false : true })
    }
    assert.equal(url.origin, 'https://graph.facebook.com')
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    if (url.pathname === `/${version}/me`) return Response.json({ id: state.uploaded && state.finalAccountId || state.accountId, name: '测试快拍公共主页' })
    if (url.pathname === `/${version}/${pageId}/photos`) {
      assert.equal(req.method, 'POST')
      assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/)
      const chunks = []; for await (const chunk of req.body) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      assert.equal(body.length, Number(req.headers['content-length']))
      assert.match(body.toString(), /name="published"\r\n\r\nfalse/)
      assert.ok(body.includes(photoBytes))
      state.photoUploaded = true
      return Response.json({ id: state.photoId })
    }
    if (url.pathname === `/${version}/${pageId}/photo_stories`) {
      assert.equal(req.method, 'POST')
      assert.deepEqual(Object.fromEntries(req.body), { photo_id: state.photoId })
      assert.equal(state.photoUploaded, true)
      await state.beforeFinish?.()
      if (state.disconnect) throw Error('raw-private-response')
      if (state.finalResponse) return Response.json(state.finalResponse)
      return Response.json({ success: true, post_id: postId })
    }
    if (url.pathname === `/${version}/${pageId}/video_stories`) {
      assert.equal(req.method, 'POST')
      if (req.body.get('upload_phase') === 'start') {
        assert.deepEqual(Object.fromEntries(req.body), { upload_phase: 'start' })
        return Response.json({ video_id: state.badVideoId || videoId, upload_url: state.uploadUrl || source })
      }
      assert.deepEqual(Object.fromEntries(req.body), { upload_phase: 'finish', video_id: videoId, is_ai_generated: String(state.expectedAi ?? true) })
      await state.beforeFinish?.()
      if (state.disconnect) throw Error('raw-private-response')
      if (state.finalResponse) return Response.json(state.finalResponse)
      return Response.json({ success: true, post_id: postId })
    }
    if (url.pathname === `/${version}/${pageId}/stories`) {
      if (state.readError) return Response.json({}, { status: 503 })
      return Response.json({ data: state.stories })
    }
    assert.fail('Unexpected request: ' + url.pathname)
  } })
  return { adapter, state, calls, resolvePlatform: key => key === 'facebook' ? { adapter, accessToken: token } : null }
}

async function fixture(t, format = 'video') {
  const root = await mkdtemp(join(tmpdir(), 'md-facebook-story-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id, title: draft.title, body: draft.description, platform: 'Facebook', tags: draft.topics }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => metadata })
  const imported = await assets.import(id, Readable.from([format === 'video' ? bytes : photoBytes]), { name: format === 'video' ? 'story.mp4' : 'story.png', revision: 0 })
  const ws = await assets.save(id, imported.workspace.revision, { ...imported.workspace, selectedVideo: format === 'video' ? imported.asset.id : '', selectedCover: 'unused-cover', imageIds: format === 'images' ? [imported.asset.id] : ['unused-image'], publish: { ...imported.workspace.publish, format, mode: 'now' } })
  return { root, store, ws, assets, path: join(root, '内容', id, '素材', imported.asset.src.split('/').at(-1)), input: { id, revision: ws.revision, platform: 'facebook', options } }
}
async function finish(publishing) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Story task did not finish')
}

for (const isAiGenerated of [true, false]) test(`Facebook 视频快拍 AI=${isAiGenerated}：只读准备、私有快照、提交前检查点、单次发布`, async t => {
  const f = await fixture(t), remote = mock()
  remote.state.expectedAi = isAiGenerated
  const publishing = new Publishing(f.store, { snapshotRoot: f.root, resolvePlatform: remote.resolvePlatform })
  assert.equal((await publishing.options('facebook')).constraints.storySupported, true)
  const prepared = await publishing.prepare({ ...f.input, options: { ...options, isAiGenerated } })
  assert.equal(prepared.draft.destination, 'story')
  assert.equal(prepared.cover, null)
  assert.equal(prepared.images, undefined)
  assert.ok(remote.calls.every(call => call.startsWith('GET ')))
  remote.state.beforeUpload = async () => { await writeFile(f.path, 'changed-original') }
  remote.state.beforeFinish = async () => {
    const { records } = JSON.parse(await readFile(join(f.root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].receiptId, videoId)
  }
  const payload = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, videoId)
  assert.equal(job.destination, 'story')
  const records = JSON.parse(await readFile(join(f.root, '.publish-records.json'), 'utf8')).records
  assert.equal(records[0].workId, postId)
  assert.ok(!JSON.stringify(records).includes(token) && !JSON.stringify(records).includes('rupload.facebook.com'))
  assert.equal(remote.calls.filter(call => call === `POST /v27.0/${pageId}/video_stories`).length, 2)
  assert.equal((await publishing.start(payload)).taskId, job.taskId)
  await assert.rejects(publishing.prepare(f.input), /已有/)
  const restarted = new Publishing(new Store(f.root), { resolvePlatform: remote.resolvePlatform })
  const reviewed = await restarted.review(payload)
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.destination, 'story')
  assert.equal(reviewed.url, `https://www.facebook.com/stories/${postId}`, '使用官方 Stories 列表中的原生链接，不构造 Reel 链接')
  remote.state.readError = true
  const unavailable = await restarted.review(payload)
  assert.equal(unavailable.status, 'published')
  assert.equal(unavailable.receiptId, videoId)
  assert.ok(unavailable.reviewError)
  remote.state.readError = false
  remote.state.stories = [storyRow({ status: 'ARCHIVED' })]
  assert.equal((await restarted.review(payload)).status, 'unknown', '快拍过期不能当成拒稿或开放重投')
  await assert.rejects(restarted.prepare(f.input), /已有/)
  assert.equal(remote.calls.filter(call => call.startsWith('POST ')).length, 3)
})

test('Facebook 视频快拍：v25 默认不开放，不静默降级 Reels 或忽略 AI 声明', async () => {
  const { adapter, calls } = mock('v25.0')
  assert.throws(() => adapter.check({ draft, video }), /v27/)
  await assert.rejects(adapter.submit({ accessToken: token, channelId: pageId, draft, video, beforeSubmit: async () => {} }), /v27/)
  assert.deepEqual(calls, [])
})

test('Facebook 视频快拍：3–60 秒 MP4、本地流、公开和 AI 声明，不接受图文或独立封面', () => {
  const { adapter, calls } = mock()
  for (const duration of [3, 60]) assert.doesNotThrow(() => adapter.check({ draft, video: { ...video, duration } }))
  for (const patch of [{ mime: 'video/webm' }, { mime: 'video/quicktime' }, { duration: undefined }, { duration: NaN }, { duration: 2 }, { duration: 61 }, { width: undefined }, { width: 1920 }, { height: undefined }, { height: 1080 }, { frameRate: undefined }, { frameRate: 12 }, { sizeBytes: 0 }, { sizeBytes: 250_000_001 }, { stream: undefined }]) assert.throws(() => adapter.check({ draft, video: { ...video, ...patch } }), { code: 'INVALID_FACEBOOK_DRAFT' })
  for (const patch of [{ privacyStatus: 'private' }, { isAiGenerated: undefined }, { format: 'images' }, { format: 'text' }]) assert.throws(() => adapter.check({ draft: { ...draft, ...patch }, video }), { code: 'INVALID_FACEBOOK_DRAFT' })
  for (const extra of [{ cover: {} }, { images: [{}] }, { images: {} }]) assert.throws(() => adapter.check({ draft, video, ...extra }), { code: 'INVALID_FACEBOOK_DRAFT' })
  assert.deepEqual(calls, [])
})

for (const scenario of ['disconnect', 'bad-success', 'missing-post-id', 'unsafe-number', 'wrong-page-post']) test(`Facebook 视频快拍 ${scenario}：保存视频回执、未知不重投、重启不重放`, async t => {
  const f = await fixture(t), remote = mock()
  if (scenario === 'disconnect') remote.state.disconnect = true
  else remote.state.finalResponse = { success: scenario !== 'bad-success', post_id: scenario === 'missing-post-id' ? undefined : scenario === 'unsafe-number' ? 9007199254740992 : scenario === 'wrong-page-post' ? '999999_123456' : postId }
  const publishing = new Publishing(f.store, { snapshotRoot: f.root, resolvePlatform: remote.resolvePlatform })
  const prepared = await publishing.prepare(f.input)
  const payload = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, videoId)
  assert.equal(job.canReview, true)
  assert.equal(JSON.stringify(job).includes('raw-private-response'), false)
  const restarted = new Publishing(new Store(f.root), { resolvePlatform: remote.resolvePlatform })
  assert.equal((await restarted.start(payload)).taskId, job.taskId)
  await assert.rejects(restarted.prepare(f.input), /已有/)
  assert.equal((await restarted.review(payload)).status, 'published')
  assert.equal((await restarted.status(id)).jobs[0].url, `https://www.facebook.com/stories/${postId}`)
  assert.equal(remote.calls.filter(call => call.startsWith('POST ')).length, 3)
})

for (const uploadUrl of ['https://evil.invalid/upload', `http://rupload.facebook.com/video-upload/v27.0/${videoId}`, `https://rupload.facebook.com/video-upload/v27.0/${videoId}?extra=1`, `https://rupload.facebook.com/video-upload/v27.0/99999`, `https://rupload.facebook.com/video-upload/v25.0/${videoId}`, `https://rupload.facebook.com/video-upload/${videoId}`]) test(`Facebook 视频快拍不向非可信地址上传：${uploadUrl}`, async () => {
  const remote = mock(); remote.state.uploadUrl = uploadUrl
  await assert.rejects(remote.adapter.submit({ accessToken: token, channelId: pageId, draft, video, beforeSubmit: async () => assert.fail('Cannot checkpoint before upload') }), { code: 'FACEBOOK_UNSAFE_UPLOAD' })
  assert.equal(remote.calls.length, 2)
})

for (const scenario of ['bad-upload', 'changed-account', 'checkpoint']) test(`Facebook 视频快拍 ${scenario}：不发最终公开请求`, async () => {
  const remote = mock()
  if (scenario === 'bad-upload') remote.state.badUpload = true
  if (scenario === 'changed-account') remote.state.finalAccountId = '123456789'
  let checkpoint = false
  await assert.rejects(remote.adapter.submit({ accessToken: token, channelId: pageId, draft, video, beforeSubmit: async () => { checkpoint = true; throw Error('disk-full') } }))
  assert.equal(checkpoint, scenario === 'checkpoint')
  assert.equal(remote.calls.filter(call => call === `POST /v27.0/${pageId}/video_stories`).length, 1)
})

for (const returnedId of [1234, `${pageId}_12345678`]) test(`Facebook 视频快拍接受官方安全数字/归属当前 Page 的复合 post_id：${returnedId}`, async () => {
  const remote = mock(); remote.state.finalResponse = { success: true, post_id: returnedId }
  const result = await remote.adapter.submit({ accessToken: token, channelId: pageId, draft, video, beforeSubmit: async id => assert.equal(id, videoId) })
  assert.equal(result.workId, String(returnedId))
  assert.equal(result.status, 'pending_review')
})

for (const [name, rows, expected] of [
  ['还未出现在列表', [], 'pending_review'],
  ['未匹配的照片类型', [storyRow({ media_type: 'photo' })], 'pending_review'],
  ['已归档', [storyRow({ status: 'ARCHIVED' })], 'unknown'],
  ['缺少发布 ID', [storyRow({ post_id: '' })], 'unknown'],
  ['返回的作品与检查点冲突', [storyRow({ post_id: '123456789001235' })], 'unknown'],
]) test(`Facebook 视频快拍回查${name}：不误判状态`, async () => {
  const remote = mock(); remote.state.stories = rows
  const result = await remote.adapter.review({ accessToken: token, channelId: pageId, receiptId: videoId, workId: postId, destination: 'story' })
  assert.equal(result.status, expected)
  assert.equal(result.url, undefined)
  assert.ok(remote.calls.every(call => call.startsWith('GET ')))
})

test('Facebook 视频快拍回查核对 Page、视频 ID 与状态，缺失不误判', async () => {
  for (const stories of [undefined, {}]) {
    const remote = mock(); remote.state.stories = stories
    await assert.rejects(remote.adapter.review({ accessToken: token, channelId: pageId, receiptId: videoId, destination: 'story' }), { outcome: 'unknown' })
  }
  const duplicate = mock(); duplicate.state.stories = [storyRow(), storyRow()]
  assert.equal((await duplicate.adapter.review({ accessToken: token, channelId: pageId, receiptId: videoId, destination: 'story' })).status, 'unknown')
  const remote = mock(); remote.state.accountId = '999999'
  await assert.rejects(remote.adapter.review({ accessToken: token, channelId: pageId, receiptId: videoId, destination: 'story' }), { code: 'FACEBOOK_WRONG_PAGE' })
  assert.equal(remote.calls.length, 1)
})

test('Facebook 快拍仅展示可信域名和路径的原生 Story 链接', async () => {
  for (const url of [`https://www.facebook.com/stories/${postId}`, `https://facebook.com/stories/${pageId}/${postId}`]) {
    const remote = mock(); remote.state.stories = [storyRow({ url })]
    const result = await remote.adapter.review({ accessToken: token, channelId: pageId, receiptId: videoId, workId: postId, destination: 'story' })
    assert.equal(result.url, url)
  }
  for (const url of [`http://www.facebook.com/stories/${postId}`, `https://facebook.com.evil.test/stories/${postId}`, `https://facebook.com/stories/${postId}?redirect=example.test`, `https://facebook.com/stories/${pageId}/${postId}/extra`]) {
    const remote = mock(); remote.state.stories = [storyRow({ url })]
    const result = await remote.adapter.review({ accessToken: token, channelId: pageId, receiptId: videoId, workId: postId, destination: 'story' })
    assert.equal(result.url, undefined)
  }
})

const photoOptions = { destination: 'photo_story', privacyStatus: 'public', isAiGenerated: false }
const photoDraft = { title: '只供本地记录', description: '不发送的正文', topics: ['不发送的话题'], format: 'images', ...photoOptions }

async function photoFixture(t) {
  return fixture(t, 'images')
}

test('Facebook 照片快拍：只读准备、单张本地图片、AI 声明安全拦截、持久回执与原生状态链接', async t => {
  const f = await photoFixture(t), remote = mock()
  remote.state.stories = [storyRow({ media_type: 'photo', media_id: photoId })]
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const input = { ...f.input, options: photoOptions }
  const prepared = await publishing.prepare(input)
  assert.equal(prepared.draft.destination, 'photo_story')
  assert.equal(prepared.draft.format, 'images')
  assert.equal(prepared.images.length, 1)
  assert.ok(remote.calls.every(call => call.startsWith('GET ')))
  await assert.rejects(publishing.prepare({ ...input, options: { ...photoOptions, isAiGenerated: true } }), /AI 声明字段/)
  assert.ok(remote.calls.every(call => call.startsWith('GET ')))
  remote.state.beforeFinish = async () => {
    const { records } = JSON.parse(await readFile(join(f.root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].receiptId, photoId)
    assert.equal(records[0].submissionStarted, true)
  }
  const payload = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, photoId)
  assert.equal(job.destination, 'photo_story')
  assert.equal(remote.calls.filter(call => call === `POST /v27.0/${pageId}/photos`).length, 1)
  assert.equal(remote.calls.filter(call => call === `POST /v27.0/${pageId}/photo_stories`).length, 1)
  assert.equal(remote.calls.some(call => call.includes('/video_stories')), false)
  const reviewed = await publishing.review(payload)
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.url, `https://www.facebook.com/stories/${postId}`)
  assert.equal((await publishing.status(id)).jobs[0].destination, 'photo_story')
  assert.ok(!JSON.stringify(await readFile(join(f.root, '.publish-records.json'), 'utf8')).includes(token))
})

test('Facebook 照片快拍：发布回执丢失后从 Page Stories 按 photo media_id 恢复，不重复发布', async t => {
  const f = await photoFixture(t), remote = mock()
  remote.state.disconnect = true
  remote.state.stories = [storyRow({ media_type: 'photo', media_id: photoId })]
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const input = { ...f.input, options: photoOptions }
  const prepared = await publishing.prepare(input)
  const payload = { id, taskId: prepared.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, photoId)
  const restarted = new Publishing(new Store(f.root), { resolvePlatform: remote.resolvePlatform })
  assert.equal((await restarted.review(payload)).status, 'published')
  assert.equal((await restarted.start(payload)).taskId, job.taskId)
  await assert.rejects(restarted.prepare(input), /已有/)
  assert.equal(remote.calls.filter(call => call === `POST /v27.0/${pageId}/photo_stories`).length, 1)
  assert.equal(remote.calls.filter(call => call === `POST /v27.0/${pageId}/photos`).length, 1)
})

test('Facebook 照片快拍：Host 拒绝多图素材，适配器拒绝 AI、视频、封面、格式错误和版本回退', async t => {
  const f = await photoFixture(t), remote = mock()
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const extra = await f.assets.import(id, Readable.from([Buffer.concat([photoBytes, Buffer.from('extra')])]), { name: 'second.png', revision: f.ws.revision })
  const multiWs = await f.assets.save(id, extra.workspace.revision, { ...extra.workspace, imageIds: [...f.ws.imageIds, extra.asset.id] })
  await assert.rejects(publishing.prepare({ ...f.input, revision: multiWs.revision, options: photoOptions }), /只支持一张/)
  const image = { mime: 'image/png', sizeBytes: photoBytes.length, stream: () => Readable.from([photoBytes]) }
  for (const patch of [{ isAiGenerated: true }, { privacyStatus: 'private' }, { format: 'text' }]) {
    assert.throws(() => remote.adapter.check({ draft: { ...photoDraft, ...patch }, images: [image] }), { code: 'INVALID_FACEBOOK_DRAFT' })
  }
  for (const images of [[], [image, image], [{ ...image, mime: 'image/gif' }], [{ ...image, sizeBytes: 10_000_001 }]]) assert.throws(() => remote.adapter.check({ draft: photoDraft, images }), { code: 'INVALID_FACEBOOK_DRAFT' })
  assert.throws(() => remote.adapter.check({ draft: photoDraft, images: [image], video }), { code: 'INVALID_FACEBOOK_DRAFT' })
  assert.throws(() => remote.adapter.check({ draft: photoDraft, images: [image], cover: {} }), { code: 'INVALID_FACEBOOK_DRAFT' })
  const old = mock('v25.0')
  assert.throws(() => old.adapter.check({ draft: photoDraft, images: [image] }), /v27/)
  assert.deepEqual(old.calls, [])
})

test('Facebook 视频快拍确认前源文件或文案变化，旧确认单不可提交', async t => {
  const f = await fixture(t), remote = mock()
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform })
  const prepared = await publishing.prepare(f.input)
  const next = await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, title: '新标题' }, publishEdited: { title: true } })
  await assert.rejects(publishing.start({ id, taskId: prepared.taskId, confirmed: true }), { status: 409 })
  const current = await publishing.prepare({ ...f.input, revision: next.revision })
  await writeFile(f.path, '0000ftypCHANGED')
  await assert.rejects(publishing.start({ id, taskId: current.taskId, confirmed: true }), /素材已变化/)
  assert.ok(remote.calls.every(call => call.startsWith('GET ')))
})
