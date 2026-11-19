import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { pinterestCaption, pinterestCopyIssue } from '../src/publish/draft-copy.js'
import { createPinterestAdapter } from '../src/publish/pinterest/index.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const itemId = 'pinterest-video-draft'
const userId = '123456789'
const boardId = '1880028106020515840'
const mediaId = '1880028106020515841'
const pinId = '1880028106020515842'
const accessToken = 'mock-pinterest-access-token'
const bytes = Buffer.from('0000ftypabcde')
const coverBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const options = { categoryId: boardId, privacyStatus: 'public', original: true, isAiGenerated: true, syntheticPerformer: false }
const draft = { title: '准备投稿', description: '正文', topics: ['测试'], ...options }
const video = { sizeBytes: bytes.length, mime: 'video/mp4', duration: 12, stream: () => Readable.from([bytes]) }
const uploadUrl = 'https://pinterest-media-upload.s3-accelerate.amazonaws.com/'
const parameters = { 'Content-Type': 'multipart/form-data', key: 'uploads/video', policy: 'signed-policy', 'x-amz-algorithm': 'AWS4-HMAC-SHA256', 'x-amz-credential': 'mock-credential', 'x-amz-date': '20261118T000000Z', 'x-amz-security-token': 'mock-upload-token', 'x-amz-signature': 'mock-signature' }

async function fixture(context, withCover = false) {
  const root = await mkdtemp(join(tmpdir(), 'md-pinterest-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: itemId, title: draft.title, body: draft.description, tags: draft.topics, platform: 'Pinterest' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ duration: 12 }) })
  const { workspace, asset } = await assets.import(itemId, Readable.from([bytes]), { name: 'local.mp4', revision: 0 })
  let current = workspace, coverId = ''
  if (withCover) {
    const imported = await assets.import(itemId, Readable.from([coverBytes]), { name: 'cover.png', revision: current.revision })
    current = imported.workspace
    coverId = imported.asset.id
  }
  const saved = await assets.save(itemId, current.revision, { ...current, selectedVideo: asset.id, selectedCover: coverId, publish: { ...current.publish, mode: 'now' } })
  return { store, root, assets, saved, input: { id: itemId, platform: 'pinterest', revision: saved.revision, options } }
}

function platform(overrides = {}) {
  const calls = [], uploads = [], waits = []
  const state = { statuses: ['processing', 'succeeded'], board: {}, ...overrides }
  const board = (extra = {}) => ({ id: boardId, name: '原创作品', privacy: 'PUBLIC', owner: { username: 'author' }, ...extra })
  const adapter = createPinterestAdapter({ userId }, { pollAttempts: 2, wait: async ms => { waits.push(ms) }, fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(request.redirect, 'error')
    if (url.origin === new URL(uploadUrl).origin) {
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.duplex, 'half')
      const chunks = []
      for await (const chunk of request.body) chunks.push(chunk)
      const payload = Buffer.concat(chunks)
      assert.equal(payload.length, Number(request.headers['content-length']))
      const boundary = request.headers['content-type'].split('boundary=')[1]
      const fields = Object.entries(parameters).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('')
      const prefix = Buffer.from(`${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      assert.deepEqual(payload.subarray(0, prefix.length), prefix)
      assert.deepEqual(payload.subarray(-suffix.length), suffix)
      assert.deepEqual(payload.subarray(prefix.length, -suffix.length), bytes)
      uploads.push(payload)
      if (state.failUpload) throw new Error(accessToken)
      return new Response(null, { status: 204 })
    }
    assert.equal(url.origin, 'https://api.pinterest.com')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    assert.ok(!url.href.includes(accessToken))
    if (url.pathname === '/v5/user_account') return Response.json({ id: state.userId ?? userId, username: 'author', account_type: 'PINNER' })
    if (url.pathname === '/v5/boards') {
      assert.equal(url.searchParams.get('privacy'), 'PUBLIC')
      assert.equal(url.searchParams.get('page_size'), '100')
      return Response.json(state.pages ? state.pages[url.searchParams.has('bookmark') ? 1 : 0] : { items: [board(state.board)] })
    }
    if (url.pathname === '/v5/boards/' + boardId) return Response.json(board(state.board))
    if (url.pathname === '/v5/media' && request.method === 'POST') {
      assert.deepEqual(JSON.parse(request.body), { media_type: 'video' })
      return Response.json({ media_id: mediaId, media_type: 'video', upload_url: state.uploadUrl ?? uploadUrl, upload_parameters: state.parameters ?? parameters })
    }
    if (url.pathname === '/v5/media/' + mediaId) return Response.json({ media_id: state.mediaId ?? mediaId, media_type: 'video', status: state.statuses.shift() })
    if (url.pathname === '/v5/pins' && request.method === 'POST') {
      state.created = JSON.parse(request.body)
      await state.beforeCreate?.()
      if (state.failCreate === 'unknown') throw new Error(accessToken)
      if (state.failCreate === 'failed') return Response.json({ code: 1, message: accessToken }, { status: 403 })
      if (state.failCreate === 'malformed') return Response.json({ id: pinId, board_id: '1' })
      return Response.json({ id: pinId, board_id: boardId }, { status: 201 })
    }
    if (url.pathname === '/v5/pins/' + pinId) return state.missingPin ? Response.json({ message: accessToken }, { status: 404 }) : Response.json({ id: pinId, board_id: state.reviewBoard ?? boardId, is_owner: state.isOwner ?? true, media: { media_type: 'video' } })
    assert.fail('Unexpected mocked API call: ' + url.pathname)
  } })
  return { adapter, state, calls, uploads, waits, resolvePlatform: key => key === 'pinterest' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(itemId)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Pinterest did not finish posting')
}

test('Pinterest 统一入口：只读准备、自有公开画板、人工确认、本地流上传、检查点、回执和回查', async context => {
  const { store, root, input } = await fixture(context)
  const { adapter, resolvePlatform, calls, state, uploads, waits } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  assert.equal((await publishing.status(itemId)).platforms.pinterest, true)
  assert.deepEqual(await publishing.options('pinterest'), { account: '@author', categories: [{ id: boardId, title: '原创作品' }] })
  const preparation = await publishing.prepare(input)
  assert.deepEqual(preparation.draft, draft)
  assert.equal(preparation.categoryTitle, '原创作品')
  assert.equal(preparation.cover, null)
  assert.ok(calls.every(([method]) => method === 'GET'))
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(() => publishing.start({ ...payload, confirmed: false }), /明确确认/)
  state.userId = '987654321'
  await assert.rejects(() => publishing.start(payload), /配置账号不一致/)
  state.userId = userId
  state.board = { privacy: 'SECRET' }
  await assert.rejects(() => publishing.start(payload), /画板已失效/)
  state.board = {}
  state.beforeCreate = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].status, 'publishing')
  }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(job.receiptId, pinId)
  assert.equal(job.url, `https://www.pinterest.com/pin/${pinId}/`)
  assert.equal(job.actualPrivacy, 'public')
  assert.equal(uploads.length, 1)
  assert.deepEqual(waits, [5000])
  assert.deepEqual(state.created, { title: draft.title, description: '正文\n\n#测试', board_id: boardId, ai_disclosures: { values: ['AI_MODIFIED'] }, media_source: { source_type: 'video_id', media_id: mediaId, cover_image_key_frame_time: 0 } })
  const restarted = new Publishing(store, { resolvePlatform })
  assert.equal((await restarted.review(payload)).status, 'published')
  for (const patch of [{ missingPin: true }, { isOwner: false }, { reviewBoard: '1' }, { board: { privacy: 'SECRET' } }]) {
    Object.assign(state, { missingPin: false, isOwner: true, reviewBoard: boardId, board: {} }, patch)
    const reviewed = await restarted.review(payload)
    assert.equal(reviewed.status, 'published')
    assert.equal(reviewed.url, job.url)
    assert.ok(reviewed.reviewError)
    assert.ok(!reviewed.reviewError.includes(accessToken))
  }
  assert.equal((await restarted.status(itemId)).lockedPlatforms.pinterest, true)
  await assert.rejects(() => restarted.prepare(input), /已有/)
  await restarted.start(payload)
  assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/v5/pins').length, 1)
  assert.equal(adapter.check({ draft, video }).title, draft.title)
  assert.ok(!(await readFile(join(root, '.publish-records.json'), 'utf8')).includes(parameters['x-amz-security-token']))
})

test('Pinterest 封面以内联 Base64 发送，无外链；两项 AI 声明独立保存', async context => {
  const { store, root, input } = await fixture(context, true)
  const { resolvePlatform, state } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare({ ...input, options: { ...options, isAiGenerated: false, syntheticPerformer: true } })
  assert.equal(preparation.cover.filename, 'cover.png')
  await publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'published')
  assert.deepEqual(state.created.ai_disclosures, { values: ['SYNTHETIC_PERFORMER'] })
  assert.deepEqual(state.created.media_source, { source_type: 'video_id', media_id: mediaId, cover_image_content_type: 'image/png', cover_image_data: coverBytes.toString('base64') })
})

test('Pinterest 画板分页只保留本人公开非广告画板，重复分页 fail closed', async () => {
  const own = { id: boardId, name: '原创作品', privacy: 'PUBLIC', owner: { username: 'AUTHOR' } }
  const { adapter, state } = platform({ pages: [{ items: [{ ...own, owner: { username: 'other' } }, { ...own, privacy: 'SECRET' }, { ...own, is_ads_only: true }], bookmark: 'next' }, { items: [own, own] }] })
  assert.deepEqual(await adapter.categories(accessToken), [{ id: boardId, title: '原创作品' }])
  state.pages[1].bookmark = 'next'
  await assert.rejects(() => adapter.categories(accessToken), /分页无效/)
})

for (const patch of [
  { uploadUrl: 'https://example.invalid/' },
  { uploadUrl: uploadUrl + '?token=secret' },
  { uploadUrl: 'https://pinterest-media-upload.s3-accelerate.amazonaws.com.evil.invalid/' },
  { parameters: { ...parameters, evil: 'injection' } },
  { parameters: { ...parameters, key: 'a\r\nb' } },
  { parameters: { ...parameters, policy: '' } },
]) test('Pinterest 拒绝不可信上传目标或签名参数：' + JSON.stringify(patch), async () => {
  const { adapter, calls } = platform(patch)
  await assert.rejects(() => adapter.submit({ accessToken, channelId: userId, draft, video, beforeSubmit: async () => assert.fail('No final post') }), /上传地址|上传参数/)
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/v5/pins'), false)
})

for (const patch of [{ statuses: ['failed'] }, { statuses: ['processing', 'processing'] }, { mediaId: '1' }, { failUpload: true }]) test('Pinterest 上传/处理失败不创建 Pin：' + JSON.stringify(patch), async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls } = platform(patch)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  await publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'failed')
  assert.equal(calls.some(([method, path]) => method === 'POST' && path === '/v5/pins'), false)
  await publishing.prepare(input)
})

for (const failCreate of ['unknown', 'malformed', 'failed']) test('Pinterest 最终请求不确定禁止重发，明确拒绝允许重新准备：' + failCreate, async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls } = platform({ failCreate })
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
  assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/v5/pins').length, 1)
})

test('Pinterest 校验标题、说明、格式、时长、封面和必填参数，默认禁用且令牌不公开', () => {
  const { adapter } = platform()
  assert.equal(pinterestCaption(draft), '正文\n\n#测试')
  assert.equal(pinterestCopyIssue({ ...draft, title: '😀'.repeat(100) }), '')
  assert.match(pinterestCopyIssue({ ...draft, title: '😀'.repeat(101) }), /100/)
  assert.match(pinterestCopyIssue({ ...draft, description: 'a'.repeat(800) }), /800/)
  assert.match(pinterestCopyIssue({ ...draft, topics: ['bad topic'] }), /话题/)
  for (const patch of [{ categoryId: Number(boardId) }, { categoryId: '' }, { privacyStatus: 'private' }, { original: false }, { isAiGenerated: undefined }, { syntheticPerformer: undefined }]) assert.throws(() => adapter.check({ draft: { ...draft, ...patch }, video }))
  for (const patch of [{ mime: 'video/webm' }, { duration: 3 }, { duration: 901 }, { sizeBytes: 250_000_001 }]) assert.throws(() => adapter.check({ draft, video: { ...video, ...patch } }))
  assert.throws(() => adapter.check({ draft, video, cover: { ...video, mime: 'image/webp' } }))
  assert.equal(configuredPlatform('pinterest', {}), null)
  assert.equal(configuredPlatform('pinterest', { MEDIA_DESK_PINTEREST_ACCESS_TOKEN: accessToken, MEDIA_DESK_PINTEREST_USER_ID: userId }), null)
  assert.equal(configuredPlatform('pinterest', { MEDIA_DESK_PINTEREST_PUBLISH: '1', MEDIA_DESK_PINTEREST_ACCESS_TOKEN: accessToken, MEDIA_DESK_PINTEREST_USER_ID: 'username' }), null)
  assert.ok(configuredPlatform('pinterest', { MEDIA_DESK_PINTEREST_PUBLISH: '1', MEDIA_DESK_PINTEREST_ACCESS_TOKEN: accessToken, MEDIA_DESK_PINTEREST_USER_ID: userId }))
})
