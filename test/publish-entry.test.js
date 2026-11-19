import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { route } from '../src/host.js'
import { createBilibiliAdapter } from '../src/publish/bilibili/index.js'
import { createDouyinAdapter } from '../src/publish/douyin/index.js'
import { createFacebookAdapter } from '../src/publish/facebook/index.js'
import { createInstagramAdapter } from '../src/publish/instagram/index.js'
import { PublishError } from '../src/publish/errors.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { createYouTubeAdapter } from '../src/publish/youtube/index.js'
import { relocateStorage } from '../src/storage-management.js'
import { Store } from '../src/store.js'

const bytes = Buffer.from('0000ftypabcde')
const coverBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const id = 'piece'
const token = 'fixture-token-not-for-browser'
const receiptId = 'DshUpload12'
const fbPageId = '104115123456789'
const fbReceipt = '705432109876543'
const fbUpload = `https://rupload.facebook.com/video-upload/v25.0/${fbReceipt}`
const igAccountId = '17841405822304914'
const igContainer = '17889455560051444'
const igWork = '17920238422030506'
const igUpload = `https://rupload.facebook.com/ig-api-upload/v27.0/${igContainer}`
const location = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=upload-session-secret'
const ok = data => Response.json({ code: 0, data })
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }

async function fixture(t, platform = 'youtube') {
  const root = await mkdtemp(join(tmpdir(), 'md-publish-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const label = { youtube: 'YouTube', bilibili: 'B站', facebook: 'Facebook', instagram: 'Instagram', douyin: '抖音' }[platform]
  await store.mutate('', state => { state.items = [{ id, title: '要发送的稿件', body: '正文', platform: label, tags: ['话题'] }, { id: 'sample', title: '样例', sample: true }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  const { workspace: first, asset: video } = await assets.import(id, Readable.from([bytes]), { name: '本地成片.mp4', revision: 0 })
  const { workspace: second, asset: cover } = await assets.import(id, Readable.from([coverBytes]), { name: '本地封面.png', revision: first.revision })
  const ws = await assets.save(id, second.revision, { ...second, selectedVideo: video.id, selectedCover: cover.id, publish: { ...second.publish, mode: 'now' } })
  const options = platform === 'youtube' ? { categoryId: '22', selfDeclaredMadeForKids: false, privacyStatus: 'unlisted' } : platform === 'bilibili' ? { categoryId: '22', copyright: 1 } : platform === 'facebook' ? { privacyStatus: 'public', isAiGenerated: true } : platform === 'douyin' ? { privacyStatus: 'public', allowDownload: false, requiresAiLabel: false, original: true } : { shareToFeed: false, isAiGenerated: true }
  return { root, store, assets, ws, video, cover, input: { id, platform, revision: ws.revision, options } }
}

function fake(platform, overrides = {}) {
  const paths = []
  const state = { accountId: platform === 'facebook' ? fbPageId : 'channel-a', reviewError: false, failSubmit: '' }
  const fetchImpl = async (url, req) => {
    paths.push(`${req.method} ${url.pathname}`)
    if (overrides[`${req.method} ${url.pathname}`]) return overrides[`${req.method} ${url.pathname}`](url, req, state)
    switch (url.pathname) {
      case '/youtube/v3/channels': return Response.json({ items: [{ id: state.accountId, snippet: { title: '测试频道' } }] })
      case '/youtube/v3/videoCategories': return Response.json({ items: [{ id: '22', snippet: { title: '生活', assignable: true } }] })
      case '/upload/youtube/v3/videos':
        if (req.method === 'POST') return new Response(null, { headers: { location } })
        assert.deepEqual(await collect(req.body), bytes)
        if (state.failSubmit === 'unknown') throw new Error('possibly submitted')
        if (state.failSubmit === 'failed') return Response.json({ error: { code: 404, message: 'Upload session not found' } }, { status: 404 })
        return Response.json({ id: receiptId, snippet: { channelId: state.accountId } }, { status: 201 })
      case '/youtube/v3/videos':
        return state.reviewError ? Response.json({}, { status: 503 }) : Response.json({ items: [{ id: receiptId, snippet: { channelId: state.accountId }, status: { uploadStatus: 'processed', privacyStatus: 'unlisted' }, processingDetails: { processingStatus: 'succeeded' } }] })
      case '/upload/youtube/v3/thumbnails/set':
        assert.equal(req.method, 'POST')
        assert.equal(url.searchParams.get('videoId'), receiptId)
        await state.beforeThumbnail?.()
        assert.deepEqual(await collect(req.body), coverBytes)
        if (state.thumbnailError === 'unknown') throw Error('private-response')
        if (state.thumbnailError === 'not_set') return Response.json({}, { status: 403 })
        return Response.json({ items: [{ high: { url: 'https://i.ytimg.com/vi/DshUpload12/hqdefault.jpg', width: 480, height: 360 } }] })
      case '/v25.0/me':
        assert.equal(url.searchParams.get('fields'), 'id,name')
        assert.equal(req.headers.authorization, `Bearer ${token}`)
        return Response.json({ id: state.accountId, name: '测试 Facebook 公共主页' })
      case `/v25.0/${fbPageId}/video_reels`: {
        assert.equal(url.search, '')
        assert.equal(req.headers.authorization, `Bearer ${token}`)
        const phase = req.body.get('upload_phase')
        if (phase === 'start') return Response.json({ video_id: fbReceipt, upload_url: state.uploadUrl || fbUpload })
        assert.equal(phase, 'finish')
        assert.equal(req.body.get('video_id'), fbReceipt)
        assert.equal(req.body.get('video_state'), 'PUBLISHED')
        assert.equal(req.body.get('title'), '要发送的稿件')
        assert.equal(req.body.get('description'), '正文\n\n#话题')
        assert.equal(req.body.get('is_ai_generated'), 'true')
        await state.beforeFinish?.()
        if (state.failSubmit === 'unknown') throw new Error(`raw-response ${token}`)
        return Response.json({ success: true })
      }
      case `/video-upload/v25.0/${fbReceipt}`:
      case `/video-upload/${fbReceipt}`:
        assert.equal(url.href, state.uploadUrl || fbUpload)
        assert.equal(req.headers.authorization, `OAuth ${token}`)
        assert.equal(req.headers['content-type'], 'application/octet-stream')
        assert.equal(req.headers.file_size, String(bytes.length))
        assert.equal(req.headers['content-length'], String(bytes.length))
        assert.equal(req.headers.offset, '0')
        assert.equal(req.redirect, 'error')
        assert.deepEqual(await collect(req.body), bytes)
        return Response.json({ success: !state.failUpload })
      case `/v25.0/${fbReceipt}`:
        assert.equal(req.method, 'GET')
        assert.equal(url.searchParams.get('fields'), 'id,status')
        return Response.json({ id: fbReceipt, status: state.reviewStatus || { video_status: 'ready', publishing_phase: { status: 'completed', publish_status: 'published' } } })
      case '/arcopen/fn/user/account/info': return ok({ openid: state.accountId, name: '测试 B 站账号' })
      case '/arcopen/fn/archive/type/list': return ok([{ id: 1, name: '生活', children: [{ id: 22, name: '日常' }] }])
      case '/arcopen/fn/archive/video/init': return ok({ upload_token: 'upload-secret' })
      case '/video/v2/part/upload': assert.deepEqual(await collect(req.body), bytes); return ok()
      case '/arcopen/fn/archive/video/complete': return ok()
      case '/arcopen/fn/archive/cover/upload': assert.deepEqual(Buffer.from(await req.body.get('file').arrayBuffer()), coverBytes); return ok({ url: 'https://i0.hdslb.com/cover.png' })
      case '/arcopen/fn/archive/add-by-utoken': assert.equal(JSON.parse(req.body).tid, 22); return ok({ resource_id: receiptId })
      case '/arcopen/fn/archive/view': return ok({ resource_id: 'BV123abc', addit_info: { state: 0 } })
      default: assert.fail(`Unexpected request: ${url.pathname}`)
    }
  }
  const config = { clientId: 'fake-app', clientSecret: 'fake-secret', redirectUri: 'http://127.0.0.1:4311/callback' }
  const adapter = ({ youtube: createYouTubeAdapter, bilibili: createBilibiliAdapter, facebook: createFacebookAdapter }[platform])({ ...config, pageId: fbPageId }, { fetchImpl })
  return { paths, state, resolvePlatform: key => key === platform ? { adapter, accessToken: token, region: 'US' } : null }
}

async function jobFinished(publishing) {
  for (let i = 0; i < 150; i++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Posting did not leave publishing state')
}

async function http(t, store, publishing) {
  const desk = { publishing }
  const server = createServer((req, res) => route({}, store, desk, req, res).catch(() => { res.statusCode = 500; res.end('{}') }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  return (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/media-desk/publish/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
}

for (const platform of ['youtube', 'bilibili']) {
  test(`发布入口 ${platform}：先检查，确认后直传，重启后仍可回查`, async t => {
    const { root, store, input } = await fixture(t, platform)
    const { resolvePlatform, paths } = fake(platform)
    const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
    const api = await http(t, store, publishing)
    const status = await (await api(`status?id=${id}`)).json()
    assert.equal(status.platforms[platform], true)
    assert.deepEqual(status.jobs, [])
    const opts = await (await api(`options?platform=${platform}`)).json()
    assert.equal(opts.categories[0].id, '22')
    assert.ok(!JSON.stringify(opts).includes(token))
    const prepResponse = await api('prepare', { ...input, accessToken: 'ignored' })
    assert.equal(prepResponse.status, 200)
    const { preparation } = await prepResponse.json()
    assert.equal(preparation.video.filename, '本地成片.mp4')
    assert.equal(Boolean(preparation.cover), ['bilibili', 'youtube'].includes(platform))
    assert.deepEqual(preparation.draft.topics, ['话题'])
    assert.equal(preparation.account.id, undefined)
    assert.ok(paths.every(path => path.startsWith('GET ')))
    const payload = { id, taskId: preparation.taskId, confirmed: true }
    assert.equal((await api('start', { ...payload, confirmed: false })).status, 400)
    assert.equal((await api('start', payload, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await api('start', payload, { 'sec-fetch-site': 'cross-site' })).status, 403)
    const started = await api('start', payload)
    assert.equal(started.status, 202)
    assert.equal((await started.json()).job.status, 'publishing')
    const job = await jobFinished(publishing)
    assert.equal(job.status, 'pending_review')
    assert.equal(job.receiptId, receiptId)
    if (platform === 'youtube') assert.equal(job.coverResult.status, 'set')
    const reloaded = new Publishing(new Store(root), { resolvePlatform })
    assert.equal((await reloaded.start(payload)).taskId, job.taskId, '相同确认重复发送只返回已有任务')
    assert.equal((await reloaded.review(payload)).status, 'published')
    assert.equal((await reloaded.status(id)).lockedPlatforms[platform], true)
    assert.equal(paths.filter(path => path === (platform === 'youtube' ? 'PUT /upload/youtube/v3/videos' : 'POST /arcopen/fn/archive/add-by-utoken')).length, 1)
    const disk = await readFile(join(root, '.publish-records.json'), 'utf8')
    assert.ok(!/fixture-token|upload-session-secret|upload-secret/.test(disk))
    assert.ok(disk.includes('submissionStarted'))
  })
}

test('YouTube Host 缩略图专用上限：允许超过通用 10 MiB 的本地图片，拒绝超过 50 MB', async t => {
  const { root, store, input, assets } = await fixture(t)
  const { resolvePlatform, paths } = fake('youtube')
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 1)
  coverBytes.copy(bytes)
  const imported = await assets.import(id, Readable.from([bytes]), { name: 'larger.png', revision: input.revision })
  const saved = await assets.save(id, imported.workspace.revision, { ...imported.workspace, selectedCover: imported.asset.id })
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const preparation = await publishing.prepare({ ...input, revision: saved.revision })
  assert.equal(preparation.cover.sizeBytes, bytes.length)
  const path = join(root, '内容', id, '素材', imported.asset.src.split('/').at(-1))
  await truncate(path, 50_000_001)
  await assert.rejects(publishing.prepare({ ...input, revision: saved.revision }), /大小限制/)
  assert.ok(paths.every(path => path.startsWith('GET ')))
})

for (const thumbnailError of ['not_set', 'unknown']) {
  test(`YouTube 缩略图 ${thumbnailError}：检查点落盘、私有快照直传、重启回查不丢封面警告且不重投`, async t => {
    const { root, store, input, cover } = await fixture(t)
    const { resolvePlatform, state, paths } = fake('youtube')
    state.thumbnailError = thumbnailError
    state.beforeThumbnail = async () => {
      const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
      assert.equal(records[0].receiptId, receiptId)
      assert.deepEqual(records[0].coverResult, { status: 'pending' })
      await writeFile(join(root, '内容', id, '素材', cover.src.split('/').at(-1)), Buffer.from('changed-original'))
    }
    const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
    const { taskId } = await publishing.prepare(input)
    assert.ok(paths.every(path => path.startsWith('GET ')))
    const payload = { id, taskId, confirmed: true }
    await publishing.start(payload)
    const job = await jobFinished(publishing)
    assert.equal(job.status, 'pending_review')
    assert.equal(job.receiptId, receiptId)
    assert.equal(job.coverResult.status, thumbnailError)
    const reloaded = new Publishing(new Store(root), { resolvePlatform })
    const reviewed = await reloaded.review(payload)
    assert.equal(reviewed.status, 'published')
    assert.deepEqual(reviewed.coverResult, job.coverResult)
    assert.equal((await reloaded.start(payload)).taskId, taskId)
    await assert.rejects(reloaded.prepare(input), /已有.*投稿记录/)
    assert.equal(paths.filter(path => path === 'POST /upload/youtube/v3/thumbnails/set').length, 1)
    assert.equal(paths.filter(path => path === 'PUT /upload/youtube/v3/videos').length, 1)
  })
}

test('发布入口拒绝未启用、示例、缺参数、素材改动和工作区修订冲突', async t => {
  const { root, store, input, assets, ws, video } = await fixture(t)
  const { resolvePlatform, paths } = fake('youtube')
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  assert.equal(configuredPlatform('youtube', { MEDIA_DESK_YOUTUBE_ACCESS_TOKEN: token }), null)
  assert.equal((await new Publishing(store, { resolvePlatform: () => null }).status(id)).platforms.youtube, false)
  await assert.rejects(publishing.prepare({ ...input, id: 'sample' }), /示例/)
  await assert.rejects(publishing.prepare({ ...input, options: { ...input.options, selfDeclaredMadeForKids: undefined } }), /受众/)
  const first = await publishing.prepare(input)
  const next = await assets.save(id, ws.revision, { ...ws, publish: { ...ws.publish, title: '修改后标题' }, publishEdited: { title: true } })
  await assert.rejects(publishing.start({ id, taskId: first.taskId, confirmed: true }), { status: 409 })
  const second = await publishing.prepare({ ...input, revision: next.revision })
  const asset = video.src.split('/').at(-1)
  await writeFile(join(root, '内容', id, '素材', asset), Buffer.from('0000ftypCHANGED'))
  await assert.rejects(publishing.start({ id, taskId: second.taskId, confirmed: true }), /素材已变化/)
  assert.ok(paths.every(path => path.startsWith('GET ')))
  assert.ok(!(await readdir(root)).some(name => name.startsWith('media-desk-publish-')))
})

test('跨 Host 同时确认只领取一次，已固定的文件不受源稿件改动影响，回查错误保留回执', async t => {
  const { root, store, input, video } = await fixture(t)
  let release, begin
  const entered = new Promise(resolve => { begin = resolve })
  const wait = new Promise(resolve => { release = resolve })
  t.after(release)
  const { resolvePlatform, state, paths } = fake('youtube', {
    'PUT /upload/youtube/v3/videos': async (_, req) => { begin(); await wait; assert.deepEqual(await collect(req.body), bytes); return Response.json({ id: receiptId, snippet: { channelId: 'channel-a' } }, { status: 201 }) },
  })
  const a = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const b = new Publishing(new Store(root), { resolvePlatform, snapshotRoot: root })
  const { taskId } = await a.prepare(input)
  const payload = { id, taskId, confirmed: true }
  try {
    await Promise.all([a.start(payload), b.start(payload)])
    await entered
    await assert.rejects(relocateStorage(new Store(root), root + '-blocked', { env: {} }), /投稿任务/)
    await writeFile(join(root, '内容', id, '素材', video.src.split('/').at(-1)), Buffer.from('replacement'))
  } finally { release() }
  const job = await jobFinished(a)
  assert.equal(job.status, 'pending_review')
  state.reviewError = true
  const result = await b.review(payload)
  assert.equal(result.status, 'pending_review')
  assert.equal(result.receiptId, receiptId)
  assert.match(result.reviewError, /503/)
  state.reviewError = false
  assert.equal((await b.review(payload)).status, 'published')
  assert.equal(paths.filter(path => path.startsWith('PUT ')).length, 1)
})

test('账号换绑要求重新检查；结果未知阻止再次投稿', async t => {
  const { root, store, input } = await fixture(t)
  const { resolvePlatform, state } = fake('youtube')
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const { taskId } = await publishing.prepare(input)
  const payload = { id, taskId, confirmed: true }
  state.accountId = 'another-channel'
  await assert.rejects(publishing.start(payload), /发布账号已更换/)
  state.accountId = 'channel-a'
  state.failSubmit = 'unknown'
  await publishing.start(payload)
  const job = await jobFinished(publishing)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, undefined)
  await assert.rejects(new Publishing(new Store(root), { resolvePlatform }).prepare(input), /已有.*投稿记录/)
})

test('明确的提交失败允许用户重新准备，不自动重试', async t => {
  const { root, store, input } = await fixture(t)
  const { resolvePlatform, state, paths } = fake('youtube')
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  state.failSubmit = 'failed'
  const { taskId } = await publishing.prepare(input)
  await publishing.start({ id, taskId, confirmed: true })
  assert.equal((await jobFinished(publishing)).status, 'failed')
  assert.notEqual((await publishing.prepare(input)).taskId, taskId)
  assert.equal(paths.filter(path => path.startsWith('PUT ')).length, 1)
})

test('Facebook Reels：无分区/封面，公开和 AI 声明必填，确认后直传并回查', async t => {
  const { root, store, input } = await fixture(t, 'facebook')
  const { paths, state, resolvePlatform } = fake('facebook')
  state.uploadUrl = `https://rupload.facebook.com/video-upload/${fbReceipt}` // The official nonversioned response form.
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const api = await http(t, store, publishing)
  assert.equal((await (await api(`status?id=${id}`)).json()).platforms.facebook, true)
  assert.deepEqual(await (await api('options?platform=facebook')).json(), { account: '测试 Facebook 公共主页', categories: [], constraints: { feedAiSupported: false, storySupported: false } })
  assert.equal((await api('prepare', { ...input, options: { privacyStatus: 'private', isAiGenerated: true } })).status, 400)
  assert.equal((await api('prepare', { ...input, options: { privacyStatus: 'public' } })).status, 400)
  const prep = await api('prepare', input)
  assert.equal(prep.status, 200)
  const { preparation } = await prep.json()
  assert.equal(preparation.draft.categoryId, undefined)
  assert.equal(preparation.categoryTitle, undefined)
  assert.equal(preparation.cover, null)
  assert.equal(preparation.draft.isAiGenerated, true)
  assert.ok(paths.every(path => path === 'GET /v25.0/me'))
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  assert.equal((await api('start', { ...payload, confirmed: false })).status, 400)
  assert.equal((await api('start', payload)).status, 202)
  const job = await jobFinished(publishing)
  assert.equal(job.receiptId, fbReceipt)
  assert.equal(job.status, 'pending_review')
  const platformWrites = paths.filter(path => path.startsWith('POST'))
  assert.deepEqual(platformWrites, [`POST /v25.0/${fbPageId}/video_reels`, `POST /video-upload/${fbReceipt}`, `POST /v25.0/${fbPageId}/video_reels`])
  state.reviewStatus = { video_status: 'ready', publishing_phase: { status: 'in_progress' } }
  assert.equal((await publishing.review(payload)).status, 'pending_review', 'encoding readiness is not publication')
  state.reviewStatus = undefined
  const restarted = new Publishing(new Store(root), { resolvePlatform })
  const result = await restarted.review(payload)
  assert.equal(result.status, 'published')
  assert.equal(result.url, `https://www.facebook.com/reel/${fbReceipt}`)
  assert.equal((await restarted.start(payload)).taskId, preparation.taskId)
  assert.equal(paths.filter(path => path.startsWith('POST')).length, 3)
  assert.ok(!(await readFile(join(root, '.publish-records.json'), 'utf8')).includes(token))
})

test('Facebook 拒绝错误主页和不可信的上传地址，既不转发凭据也不发布', async t => {
  const { root, store, input } = await fixture(t, 'facebook')
  const { paths, state, resolvePlatform } = fake('facebook')
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  state.accountId = '123'
  await assert.rejects(publishing.prepare(input), /公共主页不一致/)
  state.accountId = fbPageId
  for (const url of [fbUpload.replace('https:', 'http:'), fbUpload.replace('rupload.facebook.com', 'rupload.facebook.com.example.invalid'), fbUpload.replace('.com/', '.com:444/'), `${fbUpload}?bad=1`, fbUpload.replace(fbReceipt, '222'), fbUpload.replace('v25.0/', 'v23.0/')]) {
    state.uploadUrl = url
    const { taskId } = await publishing.prepare(input)
    await publishing.start({ id, taskId, confirmed: true })
    const job = await jobFinished(publishing)
    assert.equal(job.status, 'failed')
    assert.match(job.message, /可信/)
  }
  assert.equal(paths.filter(path => path.startsWith('POST')).length, 6, 'only starts, no upload and no finish')
})

test('Facebook 上传未确认不 finish；finish 失联保留回执供回查且禁止重投', async t => {
  const { root, store, input } = await fixture(t, 'facebook')
  const { paths, state, resolvePlatform } = fake('facebook')
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  state.failUpload = true
  const first = await publishing.prepare(input)
  await publishing.start({ id, taskId: first.taskId, confirmed: true })
  assert.equal((await jobFinished(publishing)).status, 'failed')
  assert.equal(paths.filter(path => path.endsWith('/video_reels')).length, 1)
  state.failUpload = false
  state.failSubmit = 'unknown'
  let duringFinish
  state.beforeFinish = async () => { duringFinish = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8')).records.at(-1) }
  const next = await publishing.prepare(input)
  await publishing.start({ id, taskId: next.taskId, confirmed: true })
  const job = await jobFinished(publishing)
  assert.equal(job.status, 'unknown')
  assert.equal(duringFinish?.receiptId, fbReceipt, 'persist receipt before the finish request')
  assert.equal(duringFinish?.submissionStarted, true)
  assert.equal(job.receiptId, fbReceipt)
  assert.ok(!JSON.stringify(job).includes(token))
  await assert.rejects(publishing.prepare(input), /已有/)
  const onDisk = await readFile(join(root, '.publish-records.json'), 'utf8')
  assert.equal(JSON.parse(onDisk).records.at(-1).submissionStarted, true)
  assert.ok(!onDisk.includes(token))
  assert.equal((await publishing.review({ id, taskId: job.taskId })).status, 'published')
})


test('Facebook Host 配置必须显式开启、指定数字主页并提供令牌', () => {
  const env = { MEDIA_DESK_FACEBOOK_PUBLISH: '1', MEDIA_DESK_FACEBOOK_PAGE_ID: fbPageId, MEDIA_DESK_FACEBOOK_ACCESS_TOKEN: token }
  assert.ok(configuredPlatform('facebook', env)?.adapter)
  assert.equal(configuredPlatform('facebook', { ...env, MEDIA_DESK_FACEBOOK_PUBLISH: '0' }), null)
  assert.equal(configuredPlatform('facebook', { ...env, MEDIA_DESK_FACEBOOK_PAGE_ID: 'me' }), null)
  assert.equal(configuredPlatform('facebook', { ...env, MEDIA_DESK_FACEBOOK_ACCESS_TOKEN: '' }), null)
  assert.equal(configuredPlatform('facebook', { ...env, MEDIA_DESK_FACEBOOK_GRAPH_VERSION: 'latest' }), null)
})

function instagramFixture() {
  const paths = [], waits = []
  const state = { account: igAccountId, phases: ['IN_PROGRESS', 'FINISHED'], failSubmit: false, permalink: 'https://www.instagram.com/reel/C0de_Xyz/' }
  const adapter = createInstagramAdapter({ pageId: fbPageId }, {
    wait: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms) },
    async fetchImpl(url, req) {
      paths.push(`${req.method} ${url.pathname}`)
      assert.equal(url.protocol, 'https:')
      assert.equal(req.redirect, 'error')
      assert.equal(req.headers.authorization, `${url.hostname === 'rupload.facebook.com' ? 'OAuth' : 'Bearer'} ${token}`)
      assert.equal(url.searchParams.has('access_token'), false)
      switch (url.pathname) {
        case `/v27.0/${fbPageId}`:
          assert.equal(url.searchParams.get('fields'), 'id,instagram_business_account{id,username}')
          return Response.json({ id: fbPageId, instagram_business_account: state.account && { id: state.account, username: 'test.brand' } })
        case `/v27.0/${igAccountId}/media`:
          assert.deepEqual(Object.fromEntries(req.body), { media_type: 'REELS', upload_type: 'resumable', caption: '要发送的稿件\n\n正文\n\n#话题', share_to_feed: 'false', is_ai_generated: 'true' })
          return Response.json({ id: igContainer, uri: state.uri ?? igUpload })
        case `/ig-api-upload/v27.0/${igContainer}`:
        case `/ig-api-upload/${igContainer}`:
          assert.equal(url.hostname, 'rupload.facebook.com')
          assert.equal(req.headers.offset, '0')
          assert.equal(req.headers.file_size, String(bytes.length))
          assert.equal(req.headers['content-length'], String(bytes.length))
          assert.equal(req.duplex, 'half')
          assert.deepEqual(await collect(req.body), bytes)
          return Response.json({ success: true })
        case `/v27.0/${igContainer}`:
          assert.equal(url.searchParams.get('fields'), 'id,status_code')
          return Response.json({ id: igContainer, status_code: state.phases.shift() || state.phase || 'PUBLISHED' })
        case `/v27.0/${igAccountId}/media_publish`:
          await state.beforeFinish?.()
          assert.deepEqual(Object.fromEntries(req.body), { creation_id: igContainer })
          if (state.failSubmit) throw new Error(`private ${token}`)
          return Response.json({ id: igWork })
        case `/v27.0/${igWork}`:
          assert.equal(url.searchParams.get('fields'), 'id,media_product_type,permalink')
          return state.mediaError ? Response.json({ error: { code: 100, message: token } }, { status: 400 })
            : Response.json({ id: igWork, media_product_type: 'REELS', permalink: state.permalink })
        default: assert.fail(`Unexpected path ${url.pathname}`)
      }
    },
  })
  return { state, paths, waits, resolvePlatform: key => key === 'instagram' ? { adapter, accessToken: token } : null }
}

test('Instagram Reels 读账号准备 → 本地流上传 → 等处理 → 单次发布 → 查作品 ID', async t => {
  const { root, store, input } = await fixture(t, 'instagram')
  const { state, paths, waits, resolvePlatform } = instagramFixture()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const api = await http(t, store, publishing)
  assert.equal((await (await api(`status?id=${id}`)).json()).platforms.instagram, true)
  assert.deepEqual(await (await api('options?platform=instagram')).json(), { account: '@test.brand', categories: [] })
  for (const options of [{ isAiGenerated: true }, { shareToFeed: false }]) assert.equal((await api('prepare', { ...input, options })).status, 400)
  const pre = await api('prepare', input)
  assert.equal(pre.status, 200)
  const { preparation } = await pre.json()
  assert.equal(preparation.cover, null)
  assert.equal(preparation.categoryTitle, undefined)
  assert.equal(preparation.draft.shareToFeed, false)
  assert.ok(paths.every(p => /^GET /.test(p)))
  state.beforeFinish = async () => {
    const rec = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8')).records.at(-1)
    assert.equal(rec.receiptId, igContainer)
    assert.equal(rec.submissionStarted, true)
  }
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  assert.equal((await api('start', { ...payload, confirmed: false })).status, 400)
  assert.equal((await api('start', payload)).status, 202)
  const job = await jobFinished(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, igContainer)
  assert.equal(job.workId, undefined, 'private record field is not needed in the WebView')
  assert.deepEqual(waits, [60_000])
  assert.deepEqual(paths.slice(-5), [`POST /v27.0/${igAccountId}/media`, `POST /ig-api-upload/v27.0/${igContainer}`, `GET /v27.0/${igContainer}`, `GET /v27.0/${igContainer}`, `POST /v27.0/${igAccountId}/media_publish`])
  const restarted = new Publishing(new Store(root), { resolvePlatform })
  state.permalink = 'https://example.invalid/reel/C0de_Xyz/'
  assert.equal((await restarted.review(payload)).url, undefined)
  state.permalink = 'https://www.instagram.com/reel/C0de_Xyz/'
  const result = await restarted.review(payload)
  assert.equal(result.status, 'published')
  assert.equal(result.url, state.permalink)
  state.mediaError = true
  assert.equal((await restarted.review(payload)).url, state.permalink, 'transient permalink lookup failure retains prior confirmed URL')
  assert.equal((await restarted.start(payload)).taskId, preparation.taskId)
  assert.equal(paths.filter(p => p.endsWith('/media_publish')).length, 1)
  assert.ok(!(await readFile(join(root, '.publish-records.json'), 'utf8')).includes(token))
})

test('Instagram 拒绝账号关联变化和非官方上传地址，不发送文件或发布请求', async t => {
  const { root, store, input } = await fixture(t, 'instagram')
  const { state, paths, resolvePlatform } = instagramFixture()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const { taskId } = await publishing.prepare(input)
  state.account = '2026161616'
  await assert.rejects(publishing.start({ id, taskId, confirmed: true }), /账号已更换/)
  state.account = undefined
  await assert.rejects(publishing.prepare(input), /关联的 Instagram/)
  state.account = igAccountId
  for (const uri of [igUpload.replace('https:', 'http:'), igUpload.replace('rupload.facebook.com', 'rupload.facebook.com.example.invalid'), igUpload.replace('.com/', '.com:444/'), igUpload.replace(igContainer, igWork), igUpload.replace('/ig-api-upload/', '/video-upload/'), `${igUpload}?evil=1`]) {
    state.uri = uri
    const { taskId } = await publishing.prepare(input)
    await publishing.start({ id, taskId, confirmed: true })
    assert.match((await jobFinished(publishing)).message, /可信/)
  }
  assert.equal(paths.filter(p => p.startsWith('POST')).length, 6, 'only official initialization requests were sent')
})

test('Instagram 未就绪不会提交；最终 POST 失联后保留容器回查且不重复发布', async t => {
  const { root, store, input } = await fixture(t, 'instagram')
  const { state, waits, paths, resolvePlatform } = instagramFixture()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  state.phases = []; state.phase = 'IN_PROGRESS'
  let pre = await publishing.prepare(input)
  await publishing.start({ id, taskId: pre.taskId, confirmed: true })
  assert.equal((await jobFinished(publishing)).status, 'failed')
  assert.deepEqual(waits, [60_000, 60_000, 60_000, 60_000])
  assert.equal(paths.some(p => p.endsWith('/media_publish')), false)
  state.phase = 'FINISHED'
  state.failSubmit = true
  pre = await publishing.prepare(input)
  await publishing.start({ id, taskId: pre.taskId, confirmed: true })
  const job = await jobFinished(publishing)
  assert.equal(job.status, 'unknown')
  assert.equal(job.receiptId, igContainer)
  assert.ok(!JSON.stringify(job).includes(token))
  const payload = { id, taskId: job.taskId }
  assert.equal((await publishing.review(payload)).status, 'unknown', 'FINISHED means ready, not posted')
  await assert.rejects(publishing.prepare(input), /已有/)
  state.phase = 'PUBLISHED'
  const restarted = new Publishing(new Store(root), { resolvePlatform })
  const result = await restarted.review(payload)
  assert.equal(result.status, 'published')
  assert.equal(result.url, undefined)
  assert.equal(paths.filter(p => p.endsWith('/media_publish')).length, 1)
})

test('Instagram 重启后可回查已超时的持久化发布检查点', async t => {
  const { root, store, input } = await fixture(t, 'instagram')
  const { state, resolvePlatform } = instagramFixture()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const prepared = await publishing.prepare(input)
  // Simulate a Host that was killed after persisting the checkpoint but before
  // receiving a finish response, and has passed its job deadline.
  const path = join(root, '.publish-records.json')
  const disk = JSON.parse(await readFile(path, 'utf8'))
  Object.assign(disk.records.at(-1), { status: 'publishing', receiptId: igContainer, deadline: Date.now() - 1000, submissionStarted: true })
  await writeFile(path, JSON.stringify(disk), { mode: 0o600 })
  const restarted = new Publishing(new Store(root), { resolvePlatform })
  state.phases = []
  assert.equal((await restarted.status(id)).jobs[0].status, 'unknown')
  assert.equal((await restarted.review({ id, taskId: prepared.taskId })).status, 'published')
})

test('Instagram Host 开关、Facebook 关联主页和独立口令均需配置', () => {
  const env = { MEDIA_DESK_INSTAGRAM_PUBLISH: '1', MEDIA_DESK_INSTAGRAM_PAGE_ID: fbPageId, MEDIA_DESK_INSTAGRAM_ACCESS_TOKEN: token }
  assert.ok(configuredPlatform('instagram', env)?.adapter)
  assert.equal(configuredPlatform('instagram', { ...env, MEDIA_DESK_INSTAGRAM_PUBLISH: '0' }), null)
  assert.equal(configuredPlatform('instagram', { ...env, MEDIA_DESK_INSTAGRAM_PAGE_ID: 'me' }), null)
  assert.equal(configuredPlatform('instagram', { ...env, MEDIA_DESK_INSTAGRAM_ACCESS_TOKEN: '' }), null)
})

const dyOpenId = 'user-example-id'
const dyVideoId = '@encrypted/video+file='
const dyCoverId = '@encrypted/cover+file='
const dyUploadId = '@upload/session+secret='
const dyItemId = '@encrypted/item+receipt='
const dyWorkId = '7215132967188970000'

function douyinPlatform({ multipart = false, ...state } = {}) {
  const paths = []
  const parts = []
  const ok = data => Response.json({ data: { error_code: 0, ...data }, extra: { error_code: 0 } })
  async function media(req, field, type, ext) {
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(req.headers['content-type'])[1]
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${field}.${ext}"\r\nContent-Type: ${type}\r\n\r\n`)
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    const payload = await collect(req.body)
    assert.equal(Number(req.headers['content-length']), payload.length)
    assert.deepEqual(payload.subarray(0, head.length), head)
    assert.deepEqual(payload.subarray(-tail.length), tail)
    assert.equal(req.duplex, 'half')
    return payload.subarray(head.length, -tail.length)
  }
  const adapter = createDouyinAdapter({ openId: dyOpenId }, {
    ...(multipart && { singleBytes: 5, partBytes: 5 }),
    async fetchImpl(url, req) {
      const endpoint = url.pathname.split('/').filter(Boolean).at(-1)
      paths.push(endpoint)
      assert.equal(url.origin, 'https://open.douyin.com')
      assert.equal(req.redirect, 'error')
      assert.ok(!url.href.includes(token))
      if (endpoint === 'userinfo') {
        assert.equal(url.search, '')
        assert.equal(req.method, 'POST')
        assert.equal(req.headers['access-token'], undefined)
        assert.equal(req.body.get('access_token'), token)
        assert.equal(req.body.get('open_id'), dyOpenId)
        return Response.json({ err_no: 0, data: { error_code: '0', open_id: state.accountId ?? dyOpenId, nickname: '测试抖音账号' } })
      }
      if (endpoint === 'get_iframe_by_video') {
        assert.equal(req.method, 'GET')
        assert.equal(req.headers['access-token'], undefined)
        assert.equal(url.searchParams.get('video_id'), dyWorkId)
        return state.notPublic ? Response.json({ err_no: 28003004 }) : Response.json({ err_no: 0, data: { iframe_code: '<iframe>' } })
      }
      assert.equal(req.method, 'POST')
      assert.equal(req.headers['access-token'], token)
      assert.equal(url.searchParams.get('open_id'), dyOpenId)
      switch (endpoint) {
        case 'upload_video':
          assert.deepEqual(await media(req, 'video', 'video/mp4', 'mp4'), bytes)
          return ok({ video: { video_id: dyVideoId } })
        case 'init_video_part_upload':
          assert.equal(req.body, undefined)
          assert.equal(req.headers['content-type'], 'application/json')
          return ok({ upload_id: dyUploadId })
        case 'upload_video_part':
          assert.equal(url.searchParams.get('upload_id'), dyUploadId)
          assert.equal(url.searchParams.get('part_number'), String(parts.length + 1))
          parts.push(await media(req, 'video', 'video/mp4', 'mp4'))
          return state.failPart === parts.length ? ok({ error_code: 2114020 }) : ok({})
        case 'complete_video_part_upload':
          assert.equal(url.searchParams.get('upload_id'), dyUploadId)
          assert.equal(req.body, undefined)
          assert.deepEqual(Buffer.concat(parts), bytes)
          return ok({ video: { video_id: dyVideoId } })
        case 'upload_image':
          assert.deepEqual(await media(req, 'image', 'image/png', 'png'), coverBytes)
          return ok({ image: { image_id: dyCoverId } })
        case 'create_video':
          assert.deepEqual(JSON.parse(req.body), { video_id: dyVideoId, custom_cover_image_url: dyCoverId, text: '要发送的稿件\n正文\n#话题', private_status: state.privateStatus ?? 0, download_type: state.downloadType ?? 1 })
          await state.beforeCreate?.()
          if (state.disconnect) throw new Error(`do not expose ${token}`)
          if (state.reject) return ok({ error_code: 2190007, description: `do not expose ${token}` })
          return ok({ item_id: dyItemId, video_id: state.noWorkId ? undefined : dyWorkId })
        default: assert.fail(`Unexpected Douyin request: ${endpoint}`)
      }
    },
  })
  return { paths, parts, state, resolvePlatform: key => key === 'douyin' ? { adapter, accessToken: token } : null }
}

test('抖音复用发布入口：校验和准备不上传，确认后本地直传与公开回查', async t => {
  const { root, store, input } = await fixture(t, 'douyin')
  const { resolvePlatform, paths, state } = douyinPlatform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  const api = await http(t, store, publishing)
  assert.deepEqual(await publishing.options('douyin'), { account: '测试抖音账号', categories: [] })
  for (const options of [{ requiresAiLabel: true }, { requiresAiLabel: undefined }, { original: false }, { allowDownload: undefined }, { privacyStatus: 'unlisted' }]) {
    assert.equal((await api('prepare', { ...input, options: { ...input.options, ...options } })).status, 400)
  }
  const { preparation } = await (await api('prepare', input)).json()
  assert.equal(preparation.account.name, '测试抖音账号')
  assert.equal(preparation.cover.filename, '本地封面.png')
  assert.ok(!JSON.stringify(preparation).includes(token))
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  assert.equal((await api('start', { ...payload, confirmed: false })).status, 400)
  state.accountId = 'different-account'
  await assert.rejects(() => publishing.start(payload), /令牌与配置账号不一致/)
  assert.ok(paths.every(path => path === 'userinfo'))
  state.accountId = dyOpenId
  state.beforeCreate = async () => {
    const { records: [record] } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(record.status, 'publishing')
    assert.equal(record.submissionStarted, true)
  }
  assert.equal((await api('start', payload)).status, 202)
  const job = await jobFinished(publishing)
  assert.equal(job.status, 'pending_review')
  assert.equal(job.receiptId, dyItemId)
  assert.equal(job.canReview, true)
  assert.deepEqual(paths.filter(p => p !== 'userinfo'), ['upload_video', 'upload_image', 'create_video'])
  state.notPublic = true
  const reviewed = await publishing.review(payload)
  assert.equal(reviewed.status, 'pending_review')
  assert.equal(reviewed.url, undefined)
  state.notPublic = false
  const final = await new Publishing(store, { resolvePlatform }).review(payload)
  assert.equal(final.status, 'published')
  assert.equal(final.url, `https://www.douyin.com/video/${dyWorkId}`)
  assert.ok(!JSON.stringify(final).includes(token))
})

for (const scenario of ['private', 'no-public-id', 'failed-part', 'unknown', 'rejected']) {
  test(`抖音分片 ${scenario}：不误判、不重投`, async t => {
    const { root, store, input } = await fixture(t, 'douyin')
    const { resolvePlatform, paths, parts } = douyinPlatform({ multipart: true, privateStatus: scenario === 'private' ? 1 : 0, downloadType: 0, noWorkId: scenario === 'no-public-id', failPart: scenario === 'failed-part' ? 2 : 0, disconnect: scenario === 'unknown', reject: scenario === 'rejected' })
    const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
    input.options = { ...input.options, privacyStatus: scenario === 'private' ? 'private' : 'public', allowDownload: true }
    const preparation = await publishing.prepare(input)
    const payload = { id, taskId: preparation.taskId, confirmed: true }
    await publishing.start(payload)
    const job = await jobFinished(publishing)
    const requests = paths.filter(p => p !== 'userinfo')
    if (scenario === 'failed-part') {
      assert.equal(job.status, 'failed')
      assert.deepEqual(requests, ['init_video_part_upload', 'upload_video_part', 'upload_video_part'])
    } else {
      assert.deepEqual(parts.map(p => p.length), [5, 5, 3])
      assert.deepEqual(requests, ['init_video_part_upload', 'upload_video_part', 'upload_video_part', 'upload_video_part', 'complete_video_part_upload', 'upload_image', 'create_video'])
      assert.equal(job.status, scenario === 'unknown' ? 'unknown' : scenario === 'rejected' ? 'failed' : 'pending_review')
    }
    assert.equal(job.canReview, false)
    await assert.rejects(() => publishing.review(payload), /不能在线回查/)
    const history = await readFile(join(root, '.publish-records.json'), 'utf8')
    assert.ok(!history.includes(token) && !history.includes(dyUploadId) && !history.includes(dyVideoId) && !history.includes(dyCoverId))
    if (job.status === 'failed') assert.ok((await publishing.prepare(input)).taskId)
    else await assert.rejects(() => publishing.prepare(input), /已有/)
    await publishing.start(payload)
    assert.deepEqual(paths.filter(p => p !== 'userinfo'), requests)
  })
}

test('抖音 Host 默认关闭，需要显式开启、有效 Open ID 和令牌', () => {
  const env = { MEDIA_DESK_DOUYIN_PUBLISH: '1', MEDIA_DESK_DOUYIN_OPEN_ID: dyOpenId, MEDIA_DESK_DOUYIN_ACCESS_TOKEN: token }
  assert.ok(configuredPlatform('douyin', env))
  for (const key of Object.keys(env)) assert.equal(configuredPlatform('douyin', { ...env, [key]: '' }), null)
  assert.equal(configuredPlatform('douyin', { ...env, MEDIA_DESK_DOUYIN_OPEN_ID: 'https://example.invalid' }), null)
})
