import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { weChatArticleHtml, weChatCopyIssue } from '../src/publish/draft-copy.js'
import { createWeChatAdapter } from '../src/publish/wechat/index.js'
import { validWeChatLink } from '../src/publish/wechat/links.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const itemId = 'wechat-article-draft'
const appId = 'wx1234567890abcdef'
const clientSecret = 'a'.repeat(32)
const accessToken = 'mock-wechat-server-token'
const coverId = 'mock_permanent_cover'
const draftId = 'mock_wechat_draft'
const receiptId = '100000001'
const articleUrl = 'https://mp.weixin.qq.com/s/AbC_def-123xyz'
const coverBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const options = { privacyStatus: 'public', author: '作者', digest: '摘要', allowComment: false, onlyFansComment: false, requiresNativeDeclaration: false }
const draft = { title: '公众号测试文章', description: '正文 <script>恶意脚本</script>\n下一行\n\n结尾 & 安全', topics: [], ...options }
const cover = { sizeBytes: coverBytes.length, mime: 'image/png', stream: () => Readable.from([coverBytes]) }

async function fixture(context, format = 'article') {
  const root = await mkdtemp(join(tmpdir(), 'md-wechat-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: itemId, title: draft.title, body: draft.description, tags: [], platform: '公众号' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  const { workspace, asset } = await assets.import(itemId, Readable.from([coverBytes]), { name: '封面.png', revision: 0 })
  const saved = await assets.save(itemId, workspace.revision, { ...workspace, selectedCover: asset.id, publish: { ...workspace.publish, mode: 'now', format } })
  return { store, root, assets, saved, input: { id: itemId, platform: 'wechat', revision: saved.revision, options } }
}

function platform(overrides = {}) {
  const calls = [], uploads = []
  const state = { now: 1_000_000, publishStatus: 1, ...overrides }
  const adapter = createWeChatAdapter({ clientId: appId, clientSecret }, { now: () => state.now, fetchImpl: async (url, request) => {
    calls.push([request.method, url.pathname])
    assert.equal(url.origin, 'https://api.weixin.qq.com')
    assert.equal(request.redirect, 'error')
    if (url.pathname === '/cgi-bin/stable_token') {
      assert.equal(request.method, 'POST')
      assert.equal(url.search, '')
      assert.deepEqual(JSON.parse(request.body), { appid: appId, secret: clientSecret, grant_type: 'client_credential', force_refresh: false })
      if (state.failToken) return Response.json({ errcode: 40125, errmsg: clientSecret })
      return Response.json({ access_token: accessToken, expires_in: state.expires ?? 7200 })
    }
    assert.equal(url.searchParams.get('access_token'), accessToken)
    assert.equal(url.href.includes(clientSecret), false)
    if (url.pathname === '/cgi-bin/material/get_materialcount') {
      assert.equal(request.method, 'GET')
      await state.beforeAccount?.()
      if (state.failAccount) return Response.json({ errcode: 40014, errmsg: accessToken })
      return Response.json({ image_count: 0, news_count: 0, voice_count: 0, video_count: 0 })
    }
    assert.equal(request.method, 'POST')
    if (url.pathname === '/cgi-bin/material/add_material') {
      assert.equal(url.searchParams.get('type'), 'image')
      assert.equal(request.duplex, 'half')
      const chunks = []
      for await (const chunk of request.body) chunks.push(chunk)
      const payload = Buffer.concat(chunks)
      const boundary = request.headers['content-type'].split('boundary=')[1]
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      assert.equal(payload.length, Number(request.headers['content-length']))
      assert.deepEqual(payload, Buffer.concat([prefix, coverBytes, suffix]))
      uploads.push(payload)
      if (state.failCover) return Response.json({ errcode: 45009, errmsg: accessToken })
      return Response.json({ media_id: coverId })
    }
    if (url.pathname === '/cgi-bin/draft/add') {
      state.article = JSON.parse(request.body)
      assert.deepEqual(state.article, { articles: [{ article_type: 'news', title: draft.title, content: '<p>正文 &lt;script&gt;恶意脚本&lt;/script&gt;<br/>下一行</p><p>结尾 &amp; 安全</p>', author: '作者', digest: '摘要', need_open_comment: 0, only_fans_can_comment: 0, thumb_media_id: coverId }] })
      if (state.failDraft) throw new Error(accessToken)
      return Response.json({ media_id: draftId })
    }
    if (url.pathname === '/cgi-bin/freepublish/submit') {
      assert.deepEqual(JSON.parse(request.body), { media_id: draftId })
      await state.beforePublish?.()
      if (state.failPublish === 'unknown') throw new Error(accessToken)
      if (state.failPublish === 'failed') return Response.json({ errcode: 48001, errmsg: accessToken })
      if (state.failPublish === 'malformed') return Response.json({ errcode: 0 })
      return Response.json({ publish_id: receiptId })
    }
    if (url.pathname === '/cgi-bin/freepublish/get') {
      assert.deepEqual(JSON.parse(request.body), { publish_id: receiptId })
      if (state.failReview) return Response.json({ errcode: -1, errmsg: accessToken }, { status: 503 })
      return Response.json({ publish_id: state.otherReceipt ? '100000002' : receiptId, publish_status: state.publishStatus, article_id: 'mock_article_id', article_detail: { count: state.multiple ? 2 : 1, item: [{ idx: 1, article_url: state.articleUrl ?? articleUrl }] } })
    }
    assert.fail('Unexpected mocked API call: ' + url.pathname)
  } })
  return { adapter, state, calls, uploads, resolvePlatform: key => key === 'wechat' ? { adapter } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(itemId)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('WeChat did not finish publishing')
}

test('公众号统一入口：只读准备、本地必选封面、文章 HTML 转义、检查点、异步发表回执和详情回查', async context => {
  const { store, root, input, saved } = await fixture(context)
  assert.equal(saved.publish.format, 'article')
  const { state, calls, uploads, resolvePlatform } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  assert.deepEqual(await publishing.options('wechat'), { account: `微信公众号 (${appId})`, categories: [] })
  const preparation = await publishing.prepare(input)
  assert.deepEqual(preparation.draft, draft)
  assert.equal(preparation.video, null)
  assert.equal(preparation.cover.filename, '封面.png')
  assert.ok(calls.every(([, path]) => ['/cgi-bin/stable_token', '/cgi-bin/material/get_materialcount'].includes(path)))
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(() => publishing.start({ ...payload, confirmed: false }), /明确确认/)
  state.failAccount = true
  await assert.rejects(() => publishing.start(payload), /微信公众.*未确认/)
  state.failAccount = false
  state.beforePublish = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].receiptId, undefined)
  }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, receiptId)
  assert.equal(job.canReview, true)
  assert.equal(uploads.length, 1)
  assert.equal((await publishing.review(payload)).status, 'pending_review')
  state.publishStatus = 0
  const complete = await publishing.review(payload)
  assert.equal(complete.status, 'published')
  assert.equal(complete.url, articleUrl)
  assert.equal(complete.actualPrivacy, 'public')
  state.failReview = true
  const failedRead = await publishing.review(payload)
  assert.equal(failedRead.status, 'published')
  assert.equal(failedRead.url, articleUrl)
  assert.ok(failedRead.reviewError)
  await assert.rejects(() => publishing.prepare(input), /已有/)
  await publishing.start(payload)
  assert.equal(calls.filter(([, path]) => path === '/cgi-bin/freepublish/submit').length, 1)
  const records = await readFile(join(root, '.publish-records.json'), 'utf8')
  assert.ok(!records.includes(clientSecret))
  assert.ok(!records.includes(accessToken))
})

test('公众号短期后台令牌缓存，过期后以非强刷模式获取；凭据不能用网页 OAuth 令牌替代', async () => {
  const { adapter, state, calls } = platform()
  await Promise.all([adapter.account(), adapter.account()])
  assert.equal(calls.filter(([, path]) => path === '/cgi-bin/stable_token').length, 1)
  state.now += 7_200_000
  await adapter.account()
  assert.equal(calls.filter(([, path]) => path === '/cgi-bin/stable_token').length, 2)
  assert.equal(configuredPlatform('wechat', { MEDIA_DESK_WECHAT_PUBLISH: '1', MEDIA_DESK_WECHAT_ACCESS_TOKEN: accessToken }), null)
  assert.equal(configuredPlatform('wechat', { MEDIA_DESK_WECHAT_CLIENT_ID: appId, MEDIA_DESK_WECHAT_CLIENT_SECRET: clientSecret }), null)
  assert.ok(configuredPlatform('wechat', { MEDIA_DESK_WECHAT_PUBLISH: '1', MEDIA_DESK_WECHAT_CLIENT_ID: appId, MEDIA_DESK_WECHAT_CLIENT_SECRET: clientSecret }))
  await assert.rejects(() => platform({ failToken: true }).adapter.account(), error => !error.message.includes(clientSecret))
  await assert.rejects(() => platform({ expires: 10000 }).adapter.account(), /后台令牌/)
})

for (const patch of [{ failCover: true }, { failDraft: true }]) test('公众号上传或建草稿失败不发表，允许重新准备：' + JSON.stringify(patch), async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls } = platform(patch)
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  await publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true })
  assert.equal((await finish(publishing)).status, 'failed')
  assert.equal(calls.some(([, path]) => path === '/cgi-bin/freepublish/submit'), false)
  await publishing.prepare(input)
})

for (const failPublish of ['unknown', 'malformed', 'failed']) test('公众号最终发表不确定不重发，微信明确拒绝可重新准备：' + failPublish, async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, calls } = platform({ failPublish })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, failPublish === 'failed' ? 'failed' : 'unknown')
  assert.ok(!job.message.includes(accessToken))
  if (failPublish === 'failed') await publishing.prepare(input)
  else {
    await assert.rejects(() => publishing.prepare(input), /已有/)
    await publishing.start(payload)
  }
  assert.equal(calls.filter(([, path]) => path === '/cgi-bin/freepublish/submit').length, 1)
})

test('公众号平台删除/封禁不能释放重发锁；明确发表失败与不匹配详情分别处理', async context => {
  const { store, root, input } = await fixture(context)
  const { resolvePlatform, state } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare(input)
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  await finish(publishing)
  state.publishStatus = 0
  state.multiple = true
  const invalid = await publishing.review(payload)
  assert.equal(invalid.status, 'pending_review')
  assert.ok(invalid.reviewError)
  state.multiple = false
  state.otherReceipt = true
  assert.ok((await publishing.review(payload)).reviewError)
  state.otherReceipt = false
  for (const publishStatus of [0, 5, 6]) {
    state.publishStatus = publishStatus
    const reviewed = await publishing.review(payload)
    assert.equal(reviewed.status, publishStatus ? 'unknown' : 'published')
    assert.equal(reviewed.url, publishStatus ? undefined : articleUrl)
    await assert.rejects(() => publishing.prepare(input), /已有/)
  }
  state.publishStatus = 4
  assert.equal((await publishing.review(payload)).status, 'rejected')
  await publishing.prepare(input)
})

test('公众号缺封面、AI/原创声明需求或视频格式均阻止准备', async context => {
  const { store, root, input, assets, saved } = await fixture(context)
  const { resolvePlatform, calls } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  await assert.rejects(() => publishing.prepare({ ...input, options: { ...options, requiresNativeDeclaration: true } }), /原生 AI 标识或原创声明/)
  const noCover = await assets.save(itemId, saved.revision, { ...saved, selectedCover: '' })
  await assert.rejects(() => publishing.prepare({ ...input, revision: noCover.revision }), /必须选择/)
  const video = await assets.save(itemId, noCover.revision, { ...noCover, selectedCover: saved.selectedCover, publish: { ...noCover.publish, format: 'video' } })
  await assert.rejects(() => publishing.prepare({ ...input, revision: video.revision }), /文章/)
  assert.equal(calls.some(([, path]) => ['/cgi-bin/material/add_material', '/cgi-bin/draft/add', '/cgi-bin/freepublish/submit'].includes(path)), false)
})

test('公众号文章转义、当前标题/摘要限制、本地封面与官方作品链接白名单', () => {
  const { adapter } = platform()
  assert.equal(weChatArticleHtml(' <b>正文</b>\n换行\n\n结尾 '), '<p>&lt;b&gt;正文&lt;/b&gt;<br/>换行</p><p>结尾</p>')
  assert.equal(weChatCopyIssue({ ...draft, title: '字'.repeat(32) }), '')
  for (const patch of [{ title: '字'.repeat(33) }, { description: '' }, { author: '字'.repeat(17) }, { digest: '字'.repeat(121) }, { topics: ['标签'] }, { description: '<'.repeat(5000) }]) assert.ok(weChatCopyIssue({ ...draft, ...patch }))
  assert.throws(() => adapter.check({ draft, cover: { ...cover, sizeBytes: 10_000_001 } }))
  assert.throws(() => adapter.check({ draft, cover: { ...cover, mime: 'image/webp' } }))
  assert.throws(() => adapter.check({ draft: { ...draft, allowComment: undefined }, cover }))
  assert.throws(() => adapter.check({ draft: { ...draft, onlyFansComment: true }, cover }))
  assert.equal(adapter.check({ draft: { ...draft, allowComment: true, onlyFansComment: true }, cover }).only_fans_can_comment, 1)
  assert.equal(validWeChatLink(articleUrl), true)
  const long = 'https://mp.weixin.qq.com/s?__biz=MzA123%3D%3D&mid=12345678&idx=1&sn=' + 'a'.repeat(32)
  assert.equal(validWeChatLink(long), true)
  for (const value of [long + '&redirect=https://evil.invalid', articleUrl + '#x', articleUrl.replace('mp.weixin.qq.com', 'mp.weixin.qq.com.evil.invalid'), 'javascript:alert(1)']) assert.equal(validWeChatLink(value), false)
})
