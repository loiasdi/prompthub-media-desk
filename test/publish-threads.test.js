import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { threadsCaption, threadsCopyIssue, threadsTextWeight } from '../src/publish/draft-copy.js'
import { createThreadsAdapter } from '../src/publish/threads/index.js'
import { validThreadsLink } from '../src/publish/threads/client.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const itemId = 'threads-text-draft'
const userId = '123456789'
const containerId = '1880028106020515840'
const postId = '1880028106020515841'
const accessToken = 'mock-threads-access-token'
const url = 'https://www.threads.com/@author/post/AbC_123xyz'
const options = { privacyStatus: 'account', replyControl: 'mentioned_only', isAiGenerated: true }
const draft = { title: '准备投稿', description: '正文', topics: ['测试'], ...options }

async function fixture(context, format = 'text') {
  const root = await mkdtemp(join(tmpdir(), 'md-threads-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: itemId, title: draft.title, body: draft.description, tags: draft.topics, platform: 'Threads' }] }, { undoable: false })
  const assets = new ContentAssets(store)
  const workspace = await assets.read(itemId)
  const saved = await assets.save(itemId, workspace.revision, { ...workspace, selectedVideo: 'unavailable-old-selection', selectedCover: 'unavailable-old-cover', publish: { ...workspace.publish, mode: 'now', format } })
  return { store, root, assets, saved, input: { id: itemId, platform: 'threads', revision: saved.revision, options } }
}

function platform(overrides = {}) {
  const calls = [], waits = []
  const state = { statuses: ['IN_PROGRESS', 'FINISHED'], containerStatus: 'PUBLISHED', ...overrides }
  const adapter = createThreadsAdapter({ userId }, { pollAttempts: 2, wait: async ms => { waits.push(ms) }, fetchImpl: async (address, request) => {
    calls.push([request.method, address.pathname])
    assert.equal(address.origin, 'https://graph.threads.com')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    assert.ok(!address.href.includes(accessToken))
    if (address.pathname === '/v1.0/me') {
      assert.equal(request.method, 'GET')
      assert.equal(address.searchParams.get('fields'), 'id,username,name')
      return Response.json({ id: state.userId ?? userId, username: 'author', name: 'Threads 测试作者' })
    }
    if (address.pathname === `/v1.0/${userId}/threads`) {
      assert.equal(request.method, 'POST')
      const body = Object.fromEntries(request.body)
      assert.deepEqual(body, { media_type: 'TEXT', is_carousel_item: 'false', auto_publish_text: 'false', text: '准备投稿\n\n正文', reply_control: 'mentioned_only', is_made_with_ai: 'true', topic_tag: '测试' })
      assert.equal(body.access_token, undefined)
      if (state.failCreate) throw new Error(accessToken)
      return Response.json({ id: containerId })
    }
    if (address.pathname === `/v1.0/${userId}/threads_publish`) {
      assert.equal(request.method, 'POST')
      assert.deepEqual(Object.fromEntries(request.body), { creation_id: containerId })
      await state.beforePublish?.()
      if (state.failPublish === 'unknown') throw new Error(accessToken)
      if (state.failPublish === 'malformed') return Response.json({ success: true })
      if (state.failPublish === 'failed') return Response.json({ error: { code: 10, message: accessToken } }, { status: 403 })
      state.didPublish = true
      return Response.json({ id: postId })
    }
    if (address.pathname === '/v1.0/' + containerId) {
      assert.equal(address.searchParams.get('fields'), 'id,status')
      if (state.containerError) return Response.json({ error: { code: 1, message: accessToken } }, { status: 503 })
      return Response.json({ id: state.badContainer ? '1' : containerId, status: state.statuses.length ? state.statuses.shift() : state.containerStatus })
    }
    if (address.pathname === '/v1.0/' + postId) {
      assert.equal(address.searchParams.get('fields'), 'id,owner,media_type,permalink')
      if (state.postError) return Response.json({ error: { code: 100, message: accessToken } }, { status: 404 })
      return Response.json({ id: postId, owner: { id: state.ownerId ?? userId }, media_type: state.mediaType ?? 'TEXT_POST', permalink: state.link ?? url })
    }
    assert.fail('Unexpected mocked API call: ' + address.pathname)
  } })
  return { adapter, state, calls, waits, resolvePlatform: key => key === 'threads' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(itemId)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Threads did not finish posting')
}

test('Threads 统一入口不要求或读取素材；只读准备、确认后创建容器、持久化检查点、发布与回查', async context => {
  const { store, root, input, saved } = await fixture(context)
  assert.equal(saved.publish.format, 'text')
  assert.equal(saved.publish.platform, 'Threads')
  const { state, calls, waits, resolvePlatform } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  assert.deepEqual(await publishing.options('threads'), { account: 'Threads 测试作者 (@author)', categories: [] })
  const preparation = await publishing.prepare(input)
  assert.deepEqual(preparation.draft, draft)
  assert.equal(preparation.video, null)
  assert.equal(preparation.cover, null)
  assert.ok(calls.every(([method]) => method === 'GET'))
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(() => publishing.start({ ...payload, confirmed: false }), /明确确认/)
  state.userId = '987654321'
  await assert.rejects(() => publishing.start(payload), /配置账号不一致/)
  state.userId = userId
  state.beforePublish = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].receiptId, containerId)
  }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(job.receiptId, postId)
  assert.equal(job.url, url)
  assert.equal(job.actualPrivacy, undefined)
  assert.deepEqual(waits, [60_000])
  const restarted = new Publishing(store, { resolvePlatform })
  assert.equal((await restarted.review(payload)).status, 'published')
  for (const patch of [{ postError: true }, { ownerId: '1' }, { mediaType: 'VIDEO' }]) {
    Object.assign(state, { postError: false, ownerId: userId, mediaType: 'TEXT_POST' }, patch)
    const reviewed = await restarted.review(payload)
    assert.equal(reviewed.status, 'published')
    assert.equal(reviewed.url, url)
    assert.ok(reviewed.reviewError)
    assert.ok(!reviewed.reviewError.includes(accessToken))
  }
  await assert.rejects(() => restarted.prepare(input), /已有/)
  await restarted.start(payload)
  assert.equal(calls.filter(([, path]) => path.endsWith('/threads_publish')).length, 1)
  assert.ok(!(await readFile(join(root, '.publish-records.json'), 'utf8')).includes(accessToken))
})

for (const patch of [{ failCreate: true }, { containerError: true }, { statuses: ['ERROR'] }, { statuses: ['EXPIRED'] }, { statuses: ['IN_PROGRESS', 'IN_PROGRESS'] }, { badContainer: true }]) test('Threads 发布前失败不发送最终请求，可重新准备：' + JSON.stringify(patch), async context => {
  const { store, root, input } = await fixture(context)
  const { calls, resolvePlatform } = platform(patch)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  await publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true })
  const job = await finish(publishing)
  assert.equal(job.status, 'failed')
  assert.equal(calls.some(([, path]) => path.endsWith('/threads_publish')), false)
  await publishing.prepare(input)
})

for (const failPublish of ['unknown', 'malformed', 'failed']) test('Threads 最终请求不确定时保留容器回执且不重发，明确拒绝可重备：' + failPublish, async context => {
  const { store, root, input } = await fixture(context)
  const { state, calls, resolvePlatform } = platform({ failPublish })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, failPublish === 'failed' ? 'failed' : 'unknown')
  assert.equal(job.receiptId, containerId)
  assert.ok(!job.message.includes(accessToken))
  if (failPublish === 'failed') await publishing.prepare(input)
  else {
    state.containerStatus = 'FINISHED'
    const unconfirmed = await publishing.review(payload)
    assert.equal(unconfirmed.status, 'unknown')
    assert.ok(unconfirmed.reviewError)
    await assert.rejects(() => publishing.prepare(input), /已有/)
    state.containerStatus = 'PUBLISHED'
    const confirmed = await publishing.review(payload)
    assert.equal(confirmed.status, 'published')
    assert.equal(confirmed.url, undefined)
    await publishing.start(payload)
  }
  assert.equal(calls.filter(([, path]) => path.endsWith('/threads_publish')).length, 1)
})

test('Threads 发布已确认但作品读取失败不当成发帖失败，不暴露恶意链接', async context => {
  const { store, root, input } = await fixture(context)
  const { state, resolvePlatform } = platform({ postError: true })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  assert.equal((await finish(publishing)).status, 'published')
  state.postError = false
  state.link = 'https://example.invalid/post/abc'
  assert.equal((await publishing.review(payload)).url, undefined)
  state.link = url.replace('threads.com', 'threads.net')
  assert.equal((await publishing.review(payload)).url, state.link)
})

test('Threads 发现容器已发布时不再发最终请求，检查点失效也不允许当作未发重投', async () => {
  const { adapter, calls } = platform({ statuses: ['PUBLISHED'] })
  const ids = []
  const result = await adapter.submit({ accessToken, channelId: userId, draft, beforeSubmit: async id => { ids.push(id) } })
  assert.equal(result.status, 'published')
  assert.deepEqual(ids, [containerId])
  assert.equal(calls.some(([, path]) => path.endsWith('/threads_publish')), false)
  const next = platform({ statuses: ['PUBLISHED'] })
  await assert.rejects(() => next.adapter.submit({ accessToken, channelId: userId, draft, beforeSubmit: async () => { throw new Error('checkpoint unavailable') } }), error => error.outcome === 'unknown')
})

test('Threads 仅允许纯文字，格式篡改或修订号过期不能准备/提交', async context => {
  const { store, root, input, assets, saved } = await fixture(context, 'video')
  const { resolvePlatform, calls } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  await assert.rejects(() => publishing.prepare(input), /纯文字/)
  const fixed = await assets.save(itemId, saved.revision, { ...saved, publish: { ...saved.publish, format: 'text' } })
  const preparation = await publishing.prepare({ ...input, revision: fixed.revision })
  await assets.save(itemId, fixed.revision, { ...fixed, publish: { ...fixed.publish, format: 'images' } })
  await assert.rejects(() => publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true }), /已变化/)
  assert.equal(calls.some(([method]) => method === 'POST'), false)
})

test('Threads 文案500权重、独立原生话题、账号隐私/回复/AI必填和配置默认关闭', () => {
  const { adapter } = platform()
  assert.equal(threadsCaption(draft), '准备投稿\n\n正文')
  assert.equal(threadsTextWeight('中文😀'), 6)
  assert.equal(threadsTextWeight('👨‍👩‍👧‍👦'), 25)
  assert.equal(threadsCopyIssue({ ...draft, title: '字'.repeat(500), description: '', topics: [] }), '')
  assert.equal(threadsCopyIssue({ ...draft, title: '😀'.repeat(125), description: '', topics: [] }), '')
  assert.match(threadsCopyIssue({ ...draft, title: '😀'.repeat(126) }), /500/)
  for (const topics of [['a', 'b'], ['a.b'], ['a&b'], ['字'.repeat(51)]]) assert.match(threadsCopyIssue({ ...draft, topics }), /话题/)
  assert.equal(threadsCopyIssue({ ...draft, topics: ['open source'] }), '')
  for (const patch of [{ privacyStatus: 'public' }, { replyControl: '' }, { isAiGenerated: undefined }]) assert.throws(() => adapter.check({ draft: { ...draft, ...patch } }))
  assert.throws(() => adapter.check({ draft, video: {} }))
  assert.throws(() => adapter.check({ draft, cover: {} }))
  assert.equal(validThreadsLink(url), true)
  for (const value of ['javascript:alert(1)', url + '?token=secret', url.replace('threads.com', 'threads.com.evil.invalid')]) assert.equal(validThreadsLink(value), false)
  assert.equal(configuredPlatform('threads', {}), null)
  assert.equal(configuredPlatform('threads', { MEDIA_DESK_THREADS_ACCESS_TOKEN: accessToken, MEDIA_DESK_THREADS_USER_ID: userId }), null)
  assert.equal(configuredPlatform('threads', { MEDIA_DESK_THREADS_PUBLISH: '1', MEDIA_DESK_THREADS_ACCESS_TOKEN: accessToken, MEDIA_DESK_THREADS_USER_ID: '@author' }), null)
  assert.ok(configuredPlatform('threads', { MEDIA_DESK_THREADS_PUBLISH: '1', MEDIA_DESK_THREADS_ACCESS_TOKEN: accessToken, MEDIA_DESK_THREADS_USER_ID: userId }))
})
