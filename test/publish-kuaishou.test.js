import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { kuaishouCaption, kuaishouCopyIssue } from '../src/publish/draft-copy.js'
import { createKuaishouClient } from '../src/publish/kuaishou/client.js'
import { createKuaishouPublisher } from '../src/publish/kuaishou/publish.js'
import { PublishError } from '../src/publish/errors.js'
import { KUAISHOU_COVER_BYTES, KUAISHOU_VIDEO_BYTES, kuaishouVideoIssue } from '../src/publish/media-rules.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const appId = 'test-app'
const openId = 'test-open-id'
const accessToken = 'test-access-token'
const photoId = '3xwn3kkerxj6g9n'
const endpoint = 'uploader.test.gifshow.com'
const config = { appId, openId }
const draft = { title: '测试作品', description: '这是正文', topics: ['本地测试'], privacyStatus: 'public', requiresAiLabel: false }
const videoSource = bytes => ({ filename: 'video.mp4', mime: 'video/mp4', sizeBytes: bytes.length, duration: 12, stream: ({ start = 0, end = bytes.length - 1 } = {}) => Readable.from([bytes.subarray(start, end + 1)]) })
const coverSource = bytes => ({ filename: 'cover.jpg', mime: 'image/jpeg', sizeBytes: bytes.length, stream: () => Readable.from([bytes]) })
const ok = data => Response.json(data)

test('快手文案、视频格式/大小/时长和必选封面边界', () => {
  assert.equal(kuaishouCaption(draft), '测试作品\n这是正文\n#本地测试')
  assert.equal(kuaishouCopyIssue(draft), '')
  assert.match(kuaishouCopyIssue({ ...draft, title: '标题'.repeat(16) }), /30/)
  assert.match(kuaishouCopyIssue({ ...draft, description: '正文'.repeat(500) }), /1,000/)
  assert.match(kuaishouCopyIssue({ ...draft, topics: ['bad tag'] }), /话题/)
  assert.equal(kuaishouVideoIssue({ mime: 'video/mp4', sizeBytes: KUAISHOU_VIDEO_BYTES, duration: 1800 }), '')
  assert.match(kuaishouVideoIssue({ mime: 'video/mp4', sizeBytes: KUAISHOU_VIDEO_BYTES + 1, duration: 10 }), /100 MB/)
  assert.match(kuaishouVideoIssue({ mime: 'video/mp4', sizeBytes: 100, duration: 1801 }), /30 分钟/)
  assert.equal(KUAISHOU_COVER_BYTES, 10_000_000)
})

test('快手 OAuth 账号、分片直传、封面表单、作品回执与状态查询', async () => {
  const videoBytes = Buffer.alloc(4_000_017, 7)
  const coverBytes = Buffer.from('local cover')
  const calls = []
  const uploadChecks = []
  const client = createKuaishouClient(config, {
    allowInsecureUpload: true,
    validatePublicUrl: async url => uploadChecks.push(url),
    fetchImpl: async (url, request) => {
      const address = new URL(url)
      calls.push({ url: address, method: request.method, headers: request.headers, body: request.body, redirect: request.redirect })
      if (address.pathname === '/openapi/user_info') return ok({ result: 1, user_info: { name: '测试账号' } })
      if (address.pathname === '/openapi/photo/start_upload') return ok({ result: 1, upload_token: 'short-lived-upload-token', endpoint })
      if (address.pathname === '/api/upload/fragment') {
        const fragmentId = Number(address.searchParams.get('fragment_id'))
        const bytes = Buffer.concat(await Array.fromAsync(request.body))
        const start = fragmentId * 4_000_000
        assert.deepEqual(bytes, videoBytes.subarray(start, start + bytes.length))
        assert.equal(request.headers['content-type'], 'video/mp4')
        return ok({ result: 1, checksum: `fragment-${fragmentId}` })
      }
      if (address.pathname === '/api/upload/complete') return ok({ result: 1 })
      if (address.pathname === '/openapi/photo/publish') {
        assert.equal(address.protocol, 'https:')
        assert.equal(address.searchParams.get('upload_token'), 'short-lived-upload-token')
        assert.equal(request.body.get('caption'), kuaishouCaption(draft))
        const sentCover = request.body.get('cover')
        assert.equal(sentCover.type, 'image/jpeg')
        assert.deepEqual(Buffer.from(await sentCover.arrayBuffer()), coverBytes)
        return ok({ result: 1, video_info: { photo_id: photoId, pending: true } })
      }
      if (address.pathname === '/openapi/photo/info') return ok({ result: 1, video_info: { photo_id: photoId, pending: false } })
      assert.fail(`Unexpected Kuaishou endpoint: ${address.pathname}`)
    },
  })
  const publisher = createKuaishouPublisher(client)
  const channelId = client.credentialId(accessToken)
  assert.deepEqual(await publisher.account(accessToken), { id: channelId, name: '测试账号' })
  assert.notEqual(client.credentialId('different-token'), channelId)
  await assert.rejects(() => publisher.submit({ accessToken: 'different-token', channelId, draft, video: videoSource(videoBytes), cover: coverSource(coverBytes), beforeSubmit: async () => {} }), /账号与投稿确认单不一致/)
  const video = videoSource(videoBytes)
  const cover = coverSource(coverBytes)
  let checkpoint = false
  const result = await publisher.submit({
    accessToken, channelId, draft, video, cover,
    beforeSubmit: async () => { checkpoint = true },
  })
  assert.equal(result.status, 'pending_review')
  assert.equal(result.receiptId, photoId)
  assert.equal(checkpoint, true)
  assert.equal(calls.filter(call => call.url.pathname === '/api/upload/fragment').length, 2)
  assert.ok(calls.every(call => call.redirect === 'error'))
  assert.ok(calls.filter(call => call.url.protocol === 'https:').every(call => call.url.searchParams.get('access_token') === accessToken))
  assert.ok(uploadChecks.every(url => url.startsWith('http://uploader.test.gifshow.com/')))
  const reviewed = await publisher.review({ accessToken, channelId, receiptId: photoId })
  assert.deepEqual(reviewed, { status: 'published', receiptId: photoId, url: `https://www.kuaishou.com/short-video/${photoId}`, privacyStatus: 'public' })
})

test('快手媒体 HTTP 默认拒绝，禁用后无上传请求；伪造上传域名被拒绝', async () => {
  const payload = { result: 1, upload_token: 'token', endpoint }
  const noHttp = createKuaishouClient(config, { fetchImpl: async () => ok(payload) })
  await assert.rejects(() => noHttp.startUpload(accessToken), error => error instanceof PublishError && error.code === 'KUAISHOU_HTTP_DISABLED')
  const malicious = createKuaishouClient(config, { allowInsecureUpload: true, fetchImpl: async () => ok({ ...payload, endpoint: 'attacker.example' }) })
  await assert.rejects(() => malicious.startUpload(accessToken), error => error instanceof PublishError && error.code === 'KUAISHOU_INVALID_ENDPOINT')
})

test('快手回查明确发布失败时进入失败终态', async () => {
  const client = createKuaishouClient(config, { fetchImpl: async () => ok({ result: 100120003 }) })
  const publisher = createKuaishouPublisher(client)
  const result = await publisher.review({ accessToken, channelId: client.credentialId(accessToken), receiptId: photoId })
  assert.deepEqual(result, { status: 'failed', receiptId: photoId })
})

test('快手未知创建结果保留提交检查点且不自动重试', async () => {
  let publishCalls = 0
  let checkpoint = false
  const client = {
    openId,
    credentialId: token => `${openId}:${token}`,
    account: async () => ({ id: openId, name: '测试账号' }),
    startUpload: async () => ({ uploadToken: 'upload-token', endpoint }),
    uploadFragment: async () => {},
    completeUpload: async () => {},
    publish: async () => {
      publishCalls++
      assert.equal(checkpoint, true)
      throw new PublishError('KUAISHOU_NO_RESPONSE', 'no response', { stage: 'submit', outcome: 'unknown' })
    },
  }
  const publisher = createKuaishouPublisher(client)
  const video = videoSource(Buffer.from('video'))
  const cover = coverSource(Buffer.from('cover'))
  await assert.rejects(() => publisher.submit({ accessToken, channelId: `${openId}:${accessToken}`, draft, video, cover, beforeSubmit: async () => { checkpoint = true } }), error => error.outcome === 'unknown')
  assert.equal(publishCalls, 1)
})

test('快手统一发布入口从稿件本地素材生成确认单、显式确认后提交并回查', async context => {
  const root = await mkdtemp(join(tmpdir(), 'md-kuaishou-publish-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const itemId = 'kuaishou-piece'
  const videoBytes = Buffer.from('0000ftypisom-local-video')
  const coverBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01])
  await store.mutate('', state => { state.items = [{ id: itemId, title: '快手测试标题', body: '快手测试正文', platform: '快手', tags: ['测试'] }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async file => file.endsWith('.mp4') ? { duration: 12 } : {} })
  const { workspace: first, asset: video } = await assets.import(itemId, Readable.from([videoBytes]), { name: '本地视频.mp4', revision: 0 })
  const { workspace: second, asset: cover } = await assets.import(itemId, Readable.from([coverBytes]), { name: '本地封面.jpg', revision: first.revision })
  const workspace = await assets.save(itemId, second.revision, {
    ...second, selectedVideo: video.id, selectedCover: cover.id,
    publish: { ...second.publish, platform: '快手', format: 'video', mode: 'now' },
  })
  let createCalls = 0
  const adapter = createKuaishouPublisher({
    openId,
    credentialId: token => `${openId}:${token}`,
    account: async token => ({ id: `${openId}:${token}`, name: '快手测试账号' }),
    startUpload: async () => ({ uploadToken: 'short-token', endpoint }),
    uploadFragment: async (_host, _token, _fragment, source, start, end) => assert.deepEqual(Buffer.concat(await Array.fromAsync(source.stream({ start, end }))), videoBytes.subarray(start, end + 1)),
    completeUpload: async () => {},
    publish: async (_token, _uploadToken, caption, coverSource) => {
      createCalls++
      assert.equal(caption, '快手测试标题\n快手测试正文\n#测试')
      assert.deepEqual(Buffer.concat(await Array.fromAsync(coverSource.stream())), coverBytes)
      const state = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
      assert.equal(state.records[0].submissionStarted, true)
      assert.equal(state.records[0].receiptId, undefined)
      return { photoId, pending: true }
    },
    videoInfo: async () => ({ photoId, pending: false }),
  })
  const publishing = new Publishing(store, { resolvePlatform: platform => platform === 'kuaishou' ? { adapter, accessToken } : null, snapshotRoot: root })
  const prepared = await publishing.prepare({ id: itemId, revision: workspace.revision, platform: 'kuaishou', options: { privacyStatus: 'public', requiresAiLabel: false } })
  assert.equal(prepared.draft.privacyStatus, 'public')
  assert.equal(prepared.cover.filename, '本地封面.jpg')
  await assert.rejects(() => publishing.start({ id: itemId, taskId: prepared.taskId, confirmed: false }), /明确确认/)
  await publishing.start({ id: itemId, taskId: prepared.taskId, confirmed: true })
  let job
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await publishing.status(itemId)).jobs[0]
    if (job?.status !== 'publishing') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(job.status, 'pending_review', JSON.stringify(job))
  assert.equal(job.receiptId, photoId)
  assert.equal(job.canReview, true)
  assert.equal(createCalls, 1)
  const reviewed = await publishing.review({ id: itemId, taskId: prepared.taskId })
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.url, `https://www.kuaishou.com/short-video/${photoId}`)
})

test('快手账户配置要求启用直传风险开关与完整凭据', () => {
  assert.equal(configuredPlatform('kuaishou', { MEDIA_DESK_KUAISHOU_PUBLISH: '1' }), null)
  const env = {
    MEDIA_DESK_KUAISHOU_PUBLISH: '1', MEDIA_DESK_KUAISHOU_ALLOW_INSECURE_UPLOAD: '1',
    MEDIA_DESK_KUAISHOU_APP_ID: appId, MEDIA_DESK_KUAISHOU_OPEN_ID: openId,
    MEDIA_DESK_KUAISHOU_ACCESS_TOKEN: accessToken,
  }
  assert.ok(configuredPlatform('kuaishou', env)?.adapter)
  assert.equal(configuredPlatform('kuaishou', { ...env, MEDIA_DESK_KUAISHOU_OPEN_ID: '' }), null)
})
