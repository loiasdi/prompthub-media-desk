import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { xCaption, xCopyIssue } from '../src/publish/draft-copy.js'
import { createXAdapter } from '../src/publish/x/index.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const itemId = 'x-video-draft'
const userId = '123456789'
const mediaId = '1880028106020515840'
const postId = '1880028106020515841'
const accessToken = 'mock-x-access-token'
const bytes = Buffer.from('0000ftypabcde')
const draft = { title: '准备投稿', description: '正文', topics: ['测试'], privacyStatus: 'public', isAiGenerated: true, isPaidPartnership: false }

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'md-x-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: itemId, title: draft.title, body: draft.description, tags: draft.topics, platform: 'X' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ duration: 12 }) })
  const { workspace, asset } = await assets.import(itemId, Readable.from([bytes]), { name: 'local.mp4', revision: 0 })
  const saved = await assets.save(itemId, workspace.revision, { ...workspace, selectedVideo: asset.id, publish: { ...workspace.publish, mode: 'now' } })
  return { store, root, input: { id: itemId, platform: 'x', revision: saved.revision, options: { privacyStatus: 'public', isAiGenerated: true, isPaidPartnership: false } } }
}

function platform(overrides = {}) {
  const calls = []
  const segments = []
  const waits = []
  const state = { processing: [{ state: 'in_progress', check_after_secs: 1 }, { state: 'succeeded' }], ...overrides }
  const adapter = createXAdapter({ userId }, { partBytes: 5, pollAttempts: 2, wait: async milliseconds => { waits.push(milliseconds) }, fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(url.origin, 'https://api.x.com')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    assert.ok(!url.href.includes(accessToken))
    if (url.pathname === '/2/users/me') {
      assert.equal(request.method, 'GET')
      assert.equal(url.searchParams.get('user.fields'), 'id,name,username,protected')
      return Response.json({ data: { id: state.userId ?? userId, name: 'X 测试作者', username: 'x_author', protected: state.protected ?? false } })
    }
    if (url.pathname === '/2/media/upload/initialize') {
      assert.equal(request.method, 'POST')
      assert.deepEqual(JSON.parse(request.body), { media_type: 'video/mp4', total_bytes: bytes.length, media_category: 'tweet_video' })
      return Response.json({ data: { id: mediaId, expires_after_secs: state.expiry ?? 86400 } })
    }
    if (url.pathname === `/2/media/upload/${mediaId}/append`) {
      assert.equal(request.method, 'POST')
      assert.equal(request.duplex, 'half')
      const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(request.headers['content-type'])[1]
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="segment_index"\r\n\r\n${segments.length}\r\n--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      const chunks = []
      for await (const chunk of request.body) chunks.push(chunk)
      const payload = Buffer.concat(chunks)
      assert.equal(payload.length, Number(request.headers['content-length']))
      assert.deepEqual(payload.subarray(0, prefix.length), prefix)
      assert.deepEqual(payload.subarray(-suffix.length), suffix)
      segments.push(payload.subarray(prefix.length, -suffix.length))
      if (state.failPart === segments.length) return Response.json({ errors: [{ detail: accessToken }] }, { status: 400 })
      return Response.json({ data: {} })
    }
    if (url.pathname === `/2/media/upload/${mediaId}/finalize`) {
      assert.equal(request.method, 'POST')
      assert.deepEqual(Buffer.concat(segments), bytes)
      return Response.json({ data: { id: state.finalizeId ?? mediaId, ...(state.synchronous ? {} : { processing_info: state.finalizeInfo ?? { state: 'pending', check_after_secs: 2 } }) } })
    }
    if (url.pathname === '/2/media/upload') {
      assert.equal(request.method, 'GET')
      assert.equal(url.searchParams.get('media_id'), mediaId)
      assert.equal(url.searchParams.get('command'), 'STATUS')
      return Response.json({ data: { id: mediaId, processing_info: state.processing.shift() } })
    }
    if (url.pathname === '/2/tweets') {
      assert.equal(request.method, 'POST')
      assert.deepEqual(JSON.parse(request.body), { text: xCaption(draft), made_with_ai: true, paid_partnership: false, media: { media_ids: [mediaId] } })
      await state.beforeCreate?.()
      if (state.disconnect) throw new Error(`do not expose ${accessToken}`)
      if (state.rejected) return Response.json({ errors: [{ detail: accessToken }] }, { status: 403 })
      if (state.noReceipt) return Response.json({ data: {} }, { status: 201 })
      return Response.json({ data: { id: postId }, ...(state.partialError && { errors: [{ detail: accessToken }] }) }, { status: 201 })
    }
    if (url.pathname === `/2/tweets/${postId}`) {
      assert.equal(request.method, 'GET')
      assert.equal(url.searchParams.get('tweet.fields'), 'id,author_id')
      if (state.missingPost) return Response.json({ errors: [{ detail: accessToken }] }, { status: 404 })
      return Response.json({ data: { id: postId, author_id: state.postOwner ?? userId } })
    }
    assert.fail(`Unexpected X request: ${url.pathname}`)
  } })
  return { calls, state, segments, waits, resolvePlatform: key => key === 'x' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(itemId)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('X did not finish posting')
}

test('X 统一入口：只读准备、确认后按零起点分片、等待处理、创建一次并保存回执', async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls, state, segments, waits } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  assert.equal((await publishing.status(itemId)).platforms.x, true)
  assert.deepEqual(await publishing.options('x'), { account: 'X 测试作者 (@x_author)', categories: [] })
  for (const options of [{ isAiGenerated: undefined }, { isPaidPartnership: undefined }, { privacyStatus: 'private' }]) await assert.rejects(() => publishing.prepare({ ...input, options: { ...input.options, ...options } }), /确认 X 公开/)
  const preparation = await publishing.prepare(input)
  assert.deepEqual(preparation.draft, draft)
  assert.equal(preparation.cover, null)
  assert.ok(calls.every(call => call[0] === 'GET'))
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(() => publishing.start({ ...payload, confirmed: false }), /明确确认/)
  state.userId = '987654321'
  await assert.rejects(() => publishing.start(payload), /配置账号不一致/)
  state.userId = userId
  state.protected = true
  await assert.rejects(() => publishing.start(payload), /公开账号/)
  state.protected = false
  state.beforeCreate = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].status, 'publishing')
  }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(job.receiptId, postId)
  assert.equal(job.url, `https://x.com/i/web/status/${postId}`)
  assert.equal(job.actualPrivacy, 'public')
  assert.deepEqual(segments.map(segment => segment.length), [5, 5, 3])
  assert.deepEqual(waits, [2000, 1000])
  assert.equal((await new Publishing(store, { resolvePlatform }).review(payload)).status, 'published')
  state.missingPost = true
  const failedRead = await publishing.review(payload)
  assert.equal(failedRead.status, 'published')
  assert.equal(failedRead.url, job.url)
  assert.ok(failedRead.reviewError)
  state.missingPost = false
  state.postOwner = '987654321'
  assert.match((await publishing.review(payload)).reviewError, /原投稿账号/)
  await publishing.start(payload)
  assert.equal(calls.filter(call => call[0] === 'POST' && call[1] === '/2/tweets').length, 1)
  await assert.rejects(() => publishing.prepare(input), /已有/)
  const history = await readFile(join(root, '.publish-records.json'), 'utf8')
  assert.ok(!history.includes(accessToken) && !history.includes(mediaId))
})

for (const [label, overrides, status, creates] of [
  ['上传分片失败', { failPart: 2 }, 'failed', 0],
  ['无效会话期限', { expiry: 0 }, 'failed', 0],
  ['错误媒体回执', { finalizeId: '9' }, 'failed', 0],
  ['处理失败', { finalizeInfo: { state: 'failed' } }, 'failed', 0],
  ['无效处理状态', { finalizeInfo: {} }, 'failed', 0],
  ['处理等待异常', { finalizeInfo: { state: 'pending', check_after_secs: -1 } }, 'failed', 0],
  ['状态查询缺失处理信息', { processing: [] }, 'failed', 0],
  ['处理超时', { processing: [{ state: 'pending' }, { state: 'pending' }] }, 'failed', 0],
  ['最终请求断线', { disconnect: true }, 'unknown', 1],
  ['成功响应缺回执', { noReceipt: true }, 'unknown', 1],
  ['回执伴随错误', { partialError: true }, 'unknown', 1],
  ['明确拒绝发布', { rejected: true }, 'failed', 1],
  ['同步处理完成', { synchronous: true }, 'published', 1],
]) {
  test(`X ${label}：失败不发布，未知结果不重投`, async context => {
    const { store, root, input } = await fixture(context)
    const { resolvePlatform, calls, waits } = platform(overrides)
    const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
    const preparation = await publishing.prepare(input)
    const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
    await publishing.start(payload)
    const job = await finish(publishing)
    assert.equal(job.status, status)
    assert.equal(calls.filter(call => call[0] === 'POST' && call[1] === '/2/tweets').length, creates)
    assert.ok(!JSON.stringify(job).includes(accessToken))
    if (overrides.synchronous) assert.deepEqual(waits, [])
    if (status === 'failed') assert.ok((await publishing.prepare(input)).taskId)
    else await assert.rejects(() => publishing.prepare(input), /已有/)
    await publishing.start(payload)
    assert.equal(calls.filter(call => call[0] === 'POST' && call[1] === '/2/tweets').length, creates)
  })
}

test('X 默认关闭、固定自有账号；官方文字权重包含中文、emoji 与 URL', () => {
  const env = { MEDIA_DESK_X_PUBLISH: '1', MEDIA_DESK_X_USER_ID: userId, MEDIA_DESK_X_ACCESS_TOKEN: accessToken }
  assert.ok(configuredPlatform('x', env))
  for (const key of Object.keys(env)) assert.equal(configuredPlatform('x', { ...env, [key]: '' }), null)
  for (const value of ['https://x.com/author', 'author', '0', '12345678901234567890']) assert.equal(configuredPlatform('x', { ...env, MEDIA_DESK_X_USER_ID: value }), null)
  const copy = { title: '文'.repeat(140), description: '', topics: [] }
  assert.equal(xCopyIssue(copy), '')
  assert.match(xCopyIssue({ ...copy, title: '文'.repeat(141) }), /280/)
  assert.equal(xCopyIssue({ ...copy, title: '🚀'.repeat(140) }), '')
  assert.match(xCopyIssue({ ...copy, title: '🚀'.repeat(141) }), /280/)
  assert.equal(xCopyIssue({ ...copy, title: 'x'.repeat(254), description: 'https://example.com/' + 'a'.repeat(500) }), '')
  assert.match(xCopyIssue({ ...copy, title: 'x'.repeat(256), description: 'https://example.com/' + 'a'.repeat(500) }), /280/)
  assert.match(xCopyIssue({ ...copy, topics: ['two words'] }), /话题/)
  assert.equal(xCaption(draft), '准备投稿\n\n正文\n\n#测试')
})
