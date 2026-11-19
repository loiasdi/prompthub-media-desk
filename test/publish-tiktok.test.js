import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { tikTokCaption, tikTokCopyIssue } from '../src/publish/draft-copy.js'
import { createTikTokAdapter } from '../src/publish/tiktok/index.js'
import { tikTokChunks } from '../src/publish/tiktok/publish.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const itemId = 'tiktok-video-draft'
const openId = 'tiktok-open-id'
const receiptId = 'v_pub_file~v2.123456'
const postId = '7561234567890123456'
const accessToken = 'mock-tiktok-access-token'
const bytes = Buffer.from('0000ftypabcde')
const options = { privacyStatus: 'public', original: true, musicConsent: true, allowComment: false, allowDuet: false, allowStitch: false, isAiGenerated: true, commercialContent: false, ownBrand: false, brandedContent: false, brandedConsent: false }
const draft = { title: '准备投稿', description: '正文', topics: ['测试'], ...options }
const uploadUrl = 'https://open-upload.tiktokapis.com/video/?upload_id=mock-id&upload_token=mock-upload-secret'
const creator = { creator_username: 'author', creator_nickname: 'TikTok 测试作者', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 300 }
const source = (data = bytes, patch = {}) => ({ sizeBytes: data.length, mime: 'video/mp4', duration: 12, stream: ({ start = 0, end = data.length - 1 } = {}) => Readable.from([data.subarray(start, end + 1)]), ...patch })
const ok = data => Response.json({ data, error: { code: 'ok' } })

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'md-tiktok-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: itemId, title: draft.title, body: draft.description, tags: draft.topics, platform: 'TikTok' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ duration: 12 }) })
  const { workspace, asset } = await assets.import(itemId, Readable.from([bytes]), { name: 'local.mp4', revision: 0 })
  const saved = await assets.save(itemId, workspace.revision, { ...workspace, selectedVideo: asset.id, publish: { ...workspace.publish, mode: 'now' } })
  return { store, root, input: { id: itemId, platform: 'tiktok', revision: saved.revision, options } }
}

function platform(overrides = {}) {
  const calls = [], segments = []
  const state = { creator: {}, status: 'PROCESSING_UPLOAD', publicIds: [], ...overrides }
  const adapter = createTikTokAdapter({ openId }, { fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(request.redirect, 'error')
    if (['open-upload.tiktokapis.com', 'upload.us.tiktokapis.com'].includes(url.hostname)) {
      assert.equal(request.method, 'PUT')
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.duplex, 'half')
      const chunks = []
      for await (const chunk of request.body) chunks.push(chunk)
      const data = Buffer.concat(chunks)
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers['content-range'])
      assert.ok(match)
      const [start, end, size] = match.slice(1).map(Number)
      assert.equal(data.length, end - start + 1)
      assert.equal(data.length, Number(request.headers['content-length']))
      assert.equal(start, segments.reduce((sum, segment) => sum + segment.length, 0))
      segments.push(data)
      await state.beforeUpload?.()
      if (state.failUpload === 'unknown') throw new Error(accessToken)
      if (state.failUpload === 'badStatus') return new Response(null, { status: 200 })
      return new Response(null, { status: end + 1 === size ? 201 : 206 })
    }
    assert.equal(url.origin, 'https://open.tiktokapis.com')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    assert.ok(!url.href.includes(accessToken))
    if (url.pathname === '/v2/user/info/') {
      assert.equal(request.method, 'GET')
      assert.equal(url.searchParams.get('fields'), 'open_id,display_name')
      return ok({ user: { open_id: state.openId ?? openId, display_name: 'TikTok 测试作者' } })
    }
    assert.equal(request.method, 'POST')
    if (url.pathname === '/v2/post/publish/creator_info/query/') {
      assert.deepEqual(JSON.parse(request.body), {})
      await state.beforeCreator?.()
      if (state.creatorBlocked) return Response.json({ error: { code: 'spam_risk_too_many_posts', message: accessToken } }, { status: 403 })
      return ok({ ...creator, ...state.creator })
    }
    if (url.pathname === '/v2/post/publish/video/init/') {
      state.created = JSON.parse(request.body)
      await state.beforeCreate?.()
      if (state.failCreate === 'unknown') throw new Error(accessToken)
      if (state.failCreate === 'failed') return Response.json({ error: { code: 'privacy_level_option_mismatch', message: accessToken } }, { status: 400 })
      if (state.failCreate === 'malformed') return ok({ publish_id: '', upload_url: uploadUrl })
      return ok({ publish_id: receiptId, upload_url: state.uploadUrl ?? uploadUrl })
    }
    if (url.pathname === '/v2/post/publish/status/fetch/') {
      assert.deepEqual(JSON.parse(request.body), { publish_id: receiptId })
      if (state.failReview) return Response.json({ error: { code: 'internal_error', message: accessToken } }, { status: 503 })
      if (state.rawIds) return new Response(`{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${postId}]},"error":{"code":"ok"}}`, { headers: { 'content-type': 'application/json' } })
      return ok({ status: state.status, publicaly_available_post_id: state.publicIds })
    }
    assert.fail('Unexpected mocked API call: ' + url.pathname)
  } })
  return { adapter, state, calls, segments, resolvePlatform: key => key === 'tiktok' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(itemId)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('TikTok did not finish posting')
}

test('TikTok 统一入口：实时权限、只读准备、显式确认、双检查点、本地上传和回查', async context => {
  const { store, root, input } = await fixture(context)
  const { adapter, state, calls, segments, resolvePlatform } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const info = await publishing.options('tiktok')
  assert.equal(info.account, 'TikTok 测试作者 (@author)')
  assert.deepEqual(info.constraints.privacyLevels, creator.privacy_level_options)
  assert.equal(info.constraints.stitchDisabled, true)
  const preparation = await publishing.prepare(input)
  assert.deepEqual(preparation.draft, draft)
  assert.equal(preparation.cover, null)
  assert.ok(calls.every(([, path]) => ['/v2/user/info/', '/v2/post/publish/creator_info/query/'].includes(path)))
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(() => publishing.start({ ...payload, confirmed: false }), /明确确认/)
  state.openId = 'other-account'
  await assert.rejects(() => publishing.start(payload), /配置账号不一致/)
  state.openId = openId
  state.creator = { privacy_level_options: ['SELF_ONLY'] }
  await assert.rejects(() => publishing.start(payload), /创作者权限已变化/)
  state.creator = {}
  state.beforeCreate = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].receiptId, undefined)
  }
  state.beforeUpload = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].receiptId, receiptId)
  }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, receiptId)
  assert.equal(job.canReview, true)
  assert.deepEqual(Buffer.concat(segments), bytes)
  assert.deepEqual(state.created, { post_info: { title: '准备投稿\n\n正文\n\n#测试', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: true, disable_duet: true, disable_stitch: true, is_aigc: true, brand_organic_toggle: false, brand_content_toggle: false, video_cover_timestamp_ms: 0 }, source_info: { source: 'FILE_UPLOAD', video_size: bytes.length, chunk_size: bytes.length, total_chunk_count: 1 } })
  const restarted = new Publishing(store, { resolvePlatform })
  assert.equal((await restarted.review(payload)).status, 'pending_review')
  state.rawIds = true
  state.creatorBlocked = true
  const complete = await restarted.review(payload)
  assert.equal(complete.status, 'published')
  assert.equal(complete.url, `https://www.tiktok.com/@author/video/${postId}`)
  state.failReview = true
  const failedRead = await restarted.review(payload)
  assert.equal(failedRead.status, 'published')
  assert.equal(failedRead.url, complete.url)
  assert.ok(failedRead.reviewError)
  assert.ok(!failedRead.reviewError.includes(accessToken))
  await assert.rejects(() => restarted.prepare(input), /已有/)
  await restarted.start(payload)
  assert.equal(calls.filter(([, path]) => path === '/v2/post/publish/video/init/').length, 1)
  const records = await readFile(join(root, '.publish-records.json'), 'utf8')
  assert.ok(!records.includes('mock-upload-secret'))
  assert.ok(!records.includes(accessToken))
  assert.equal(adapter.check({ draft, video: source() }).privacy_level, 'PUBLIC_TO_EVERYONE')
})

test('TikTok 分片用 floor 计数，尾部合入最后一片，不传 OAuth 到上传地址', async () => {
  const data = Buffer.alloc(25_000_123, 7)
  const { adapter, state, segments } = platform({ uploadUrl: uploadUrl.replace('open-upload.tiktokapis.com', 'upload.us.tiktokapis.com') })
  const checkpoints = []
  await adapter.submit({ accessToken, channelId: openId, draft, video: source(data), beforeSubmit: async id => { checkpoints.push(id) } })
  assert.deepEqual(checkpoints, [undefined, receiptId])
  assert.deepEqual(tikTokChunks(data.length), { chunkSize: 10_000_000, chunkCount: 2 })
  assert.deepEqual(state.created.source_info, { source: 'FILE_UPLOAD', video_size: data.length, chunk_size: 10_000_000, total_chunk_count: 2 })
  assert.deepEqual(segments.map(chunk => chunk.length), [10_000_000, 15_000_123])
  assert.deepEqual(Buffer.concat(segments), data)
  assert.deepEqual(tikTokChunks(4_000_000), { chunkSize: 4_000_000, chunkCount: 1 })
  assert.deepEqual(tikTokChunks(10_000_000), { chunkSize: 10_000_000, chunkCount: 1 })
  assert.deepEqual(tikTokChunks(250_000_000), { chunkSize: 10_000_000, chunkCount: 25 })
})

for (const failCreate of ['unknown', 'malformed', 'failed']) test('TikTok 初始化不确定不重放，明确拒绝允许重新准备：' + failCreate, async context => {
  const { store, root, input } = await fixture(context)
  const { calls, resolvePlatform } = platform({ failCreate })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, failCreate === 'failed' ? 'failed' : 'unknown')
  assert.ok(!job.message.includes(accessToken))
  if (failCreate === 'failed') await publishing.prepare(input)
  else {
    await assert.rejects(() => publishing.prepare(input), /已有/)
    await publishing.start(payload)
  }
  assert.equal(calls.filter(([, path]) => path === '/v2/post/publish/video/init/').length, 1)
})

for (const patch of [{ failUpload: 'unknown' }, { failUpload: 'badStatus' }, { uploadUrl: 'https://example.invalid/' }, { uploadUrl: 'https://open-upload.tiktokapis.com.evil.invalid/video/?upload_id=a&upload_token=b' }, { uploadUrl: uploadUrl + '&redirect=bad' }]) test('TikTok 上传异常保留已持久回执，可回查但不能重投：' + JSON.stringify(patch), async context => {
  const { store, root, input } = await fixture(context)
  const { state, calls, resolvePlatform } = platform(patch)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, receiptId)
  assert.equal(job.canReview, true)
  await assert.rejects(() => publishing.prepare(input), /已有/)
  state.creatorBlocked = true
  state.status = 'PUBLISH_COMPLETE'
  assert.equal((await publishing.review(payload)).status, 'published')
  assert.equal(calls.filter(([, path]) => path === '/v2/post/publish/video/init/').length, 1)
})

test('TikTok 状态明确失败可重新准备；未识别状态不覆盖已知结果，私密完成不伪造链接', async context => {
  const { store, root, input } = await fixture(context)
  const { state, resolvePlatform } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare({ ...input, options: { ...options, privacyStatus: 'private' } })
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  await finish(publishing)
  state.status = 'SEND_TO_USER_INBOX'
  assert.equal((await publishing.review(payload)).status, 'pending_review')
  state.status = 'PUBLISH_COMPLETE'
  const complete = await publishing.review(payload)
  assert.equal(complete.status, 'published')
  assert.equal(complete.url, undefined)
  state.status = 'FAILED'
  assert.equal((await publishing.review(payload)).status, 'rejected')
  await publishing.prepare(input)
})

test('TikTok 创作者返回发帖限制时停止准备，提交前权限再变也不会初始化', async context => {
  const { store, root, input } = await fixture(context)
  const { state, calls, resolvePlatform } = platform({ creatorBlocked: true })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  await assert.rejects(() => publishing.prepare(input), /TikTok 暂时.*请稍后重试/)
  state.creatorBlocked = false
  const preparation = await publishing.prepare(input)
  let creatorReads = 0
  state.beforeCreator = async () => { if (++creatorReads === 2) state.creator = { privacy_level_options: ['SELF_ONLY'] } }
  await publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'failed')
  assert.equal(calls.some(([, path]) => path === '/v2/post/publish/video/init/'), false)
})

test('TikTok 后端强制原创、音乐/品牌声明、互动权限、可见范围及真实时长', async () => {
  const { adapter } = platform()
  const account = await adapter.account(accessToken)
  for (const patch of [{ original: false }, { musicConsent: false }, { privacyStatus: '' }, { isAiGenerated: undefined }, { allowStitch: true }, { commercialContent: true }, { ownBrand: true }, { commercialContent: true, brandedContent: true }, { commercialContent: true, brandedContent: true, brandedConsent: true, privacyStatus: 'private' }]) assert.throws(() => adapter.check({ draft: { ...draft, ...patch }, video: source(), account }))
  for (const patch of [{ duration: undefined }, { duration: 2 }, { duration: 301 }, { mime: 'video/avi' }, { frameRate: 22 }, { width: 350 }, { sizeBytes: 250_000_001 }]) assert.throws(() => adapter.check({ draft, video: source(bytes, patch), account }))
  const branded = adapter.check({ draft: { ...draft, commercialContent: true, brandedContent: true, brandedConsent: true, ownBrand: true }, video: source(), account })
  assert.equal(branded.brand_content_toggle, true)
  assert.equal(branded.brand_organic_toggle, true)
  assert.equal(tikTokCaption(draft), '准备投稿\n\n正文\n\n#测试')
  assert.equal(tikTokCopyIssue({ ...draft, title: '😀'.repeat(1096), description: '', topics: [] }), '')
  assert.match(tikTokCopyIssue({ ...draft, title: '😀'.repeat(1101) }), /2,200/)
  assert.equal(configuredPlatform('tiktok', {}), null)
  assert.equal(configuredPlatform('tiktok', { MEDIA_DESK_TIKTOK_ACCESS_TOKEN: accessToken, MEDIA_DESK_TIKTOK_OPEN_ID: openId }), null)
  assert.equal(configuredPlatform('tiktok', { MEDIA_DESK_TIKTOK_PUBLISH: '1', MEDIA_DESK_TIKTOK_ACCESS_TOKEN: accessToken, MEDIA_DESK_TIKTOK_OPEN_ID: 'http://unsafe' }), null)
  assert.ok(configuredPlatform('tiktok', { MEDIA_DESK_TIKTOK_PUBLISH: '1', MEDIA_DESK_TIKTOK_ACCESS_TOKEN: accessToken, MEDIA_DESK_TIKTOK_OPEN_ID: openId }))
})
