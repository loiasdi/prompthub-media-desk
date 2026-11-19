import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { linkedInCaption, linkedInCommentary, linkedInCopyIssue } from '../src/publish/draft-copy.js'
import { createLinkedInAdapter } from '../src/publish/linkedin/index.js'
import { DEFAULT_LINKEDIN_VERSION } from '../src/publish/linkedin/client.js'
import { configuredPlatform } from '../src/publish/platforms.js'
import { Publishing } from '../src/publish/service.js'
import { Store } from '../src/store.js'

const itemId = 'linkedin-draft'
const accessToken = 'mock-linkedin-token'
const memberId = 'member_abc'
const owner = `urn:li:person:${memberId}`
const videoUrn = 'urn:li:video:ABC_123-test'
const receiptId = 'urn:li:ugcPost:123456789'
const uploadToken = 'private-upload-session'
const bytes = Buffer.concat([Buffer.from('0000ftypabcde'), Buffer.alloc(80_000 - 13, 9)])
const uploadUrl = part => `https://www.linkedin.com/dms-uploads/ABC_123-test/uploadedVideo?part=${part}&sau=private-signed-url`
const draft = { title: '准备发布 [视频]', description: '正文 | @读者 <测试> \\ *斜体*', topics: ['测试', 'demo_tag'], privacyStatus: 'public' }

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'md-linkedin-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: itemId, title: draft.title, body: draft.description, tags: draft.topics, platform: 'LinkedIn' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ duration: 12 }) })
  const { workspace, asset } = await assets.import(itemId, Readable.from([bytes]), { name: '本地成片.mp4', revision: 0 })
  const saved = await assets.save(itemId, workspace.revision, { ...workspace, selectedVideo: asset.id, publish: { ...workspace.publish, mode: 'now' } })
  return { root, store, input: { id: itemId, revision: saved.revision, platform: 'linkedin', options: { privacyStatus: 'public' } } }
}

function platform(overrides = {}) {
  const calls = []
  const state = { processing: ['PROCESSING', 'AVAILABLE'], ...overrides }
  const adapter = createLinkedInAdapter({ memberId }, {
    pollAttempts: 2, wait: async () => {},
    async fetchImpl(url, request) {
      calls.push([request.method, url.pathname, url.searchParams.get('action')])
      assert.equal(request.redirect, 'error')
      if (url.origin === 'https://www.linkedin.com') {
        assert.equal(request.method, 'PUT')
        assert.equal(request.headers.authorization, undefined)
        assert.equal(request.headers['Linkedin-Version'], undefined)
        assert.equal(request.headers['content-type'], 'application/octet-stream')
        assert.equal(request.duplex, 'half')
        const part = Number(url.searchParams.get('part'))
        assert.equal(Number(request.headers['content-length']), 40_000)
        assert.deepEqual(await collect(request.body), bytes.subarray((part - 1) * 40_000, part * 40_000))
        return new Response(null, { headers: state.noEtag ? {} : { etag: part === 1 ? '"part-1"' : '/ambry-video/signedId/part-2.bin' } })
      }
      assert.equal(url.origin, 'https://api.linkedin.com')
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
      assert.ok(!url.href.includes(accessToken))
      if (url.pathname === '/v2/userinfo') {
        assert.equal(request.method, 'GET')
        return Response.json({ sub: state.memberId ?? memberId, name: 'LinkedIn 测试作者' })
      }
      assert.equal(request.headers['Linkedin-Version'], DEFAULT_LINKEDIN_VERSION)
      assert.equal(request.headers['X-Restli-Protocol-Version'], '2.0.0')
      if (url.pathname === '/rest/videos' && url.searchParams.get('action') === 'initializeUpload') {
        assert.deepEqual(JSON.parse(request.body), { initializeUploadRequest: { owner, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } })
        return Response.json({ value: { video: videoUrn, uploadToken, uploadUrlsExpireAt: Date.now() + 60_000, uploadInstructions: state.parts ?? [
          { firstByte: 0, lastByte: 39_999, uploadUrl: uploadUrl(1) },
          { firstByte: 40_000, lastByte: 79_999, uploadUrl: uploadUrl(2) },
        ] } })
      }
      if (url.pathname === '/rest/videos' && url.searchParams.get('action') === 'finalizeUpload') {
        assert.deepEqual(JSON.parse(request.body), { finalizeUploadRequest: { video: videoUrn, uploadToken, uploadedPartIds: ['part-1', '/ambry-video/signedId/part-2.bin'] } })
        return new Response(null, { status: state.finalizeFailure ? 503 : 200 })
      }
      if (url.pathname === `/rest/videos/${encodeURIComponent(videoUrn)}`) {
        assert.equal(request.method, 'GET')
        return Response.json({ id: videoUrn, owner: state.videoOwner ?? owner, status: state.processing.shift() ?? 'PROCESSING' })
      }
      if (url.pathname === '/rest/posts') {
        assert.equal(request.method, 'POST')
        assert.deepEqual(JSON.parse(request.body), {
          author: owner, commentary: linkedInCommentary(draft), visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          content: { media: { id: videoUrn } }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
        })
        await state.beforeCreate?.()
        if (state.disconnect) throw new Error(`do not expose ${accessToken}`)
        if (state.rejection) return Response.json({ message: accessToken }, { status: 403 })
        return new Response(null, { status: 201, headers: state.missingReceipt ? {} : { 'x-restli-id': receiptId } })
      }
      if (url.pathname === `/rest/posts/${encodeURIComponent(receiptId)}`) {
        assert.equal(request.method, 'GET')
        assert.equal(url.searchParams.get('viewContext'), 'AUTHOR')
        if (state.readDenied) return Response.json({ message: accessToken }, { status: 403 })
        return Response.json({ id: receiptId, author: state.postOwner ?? owner, content: { media: { id: videoUrn } }, visibility: 'PUBLIC', lifecycleState: state.postState ?? 'PUBLISHED' })
      }
      assert.fail(`Unexpected LinkedIn request: ${url.pathname}`)
    },
  })
  return { state, calls, adapter, resolvePlatform: key => key === 'linkedin' ? { adapter, accessToken } : null }
}

async function finish(publishing) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const job = (await publishing.status(itemId)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('LinkedIn posting did not finish')
}

test('LinkedIn 统一入口：准备只读、人工确认、顺序分片、等待转码、帖子回执与回查', async context => {
  const { root, store, input } = await fixture(context)
  const { resolvePlatform, calls, state } = platform()
  const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
  assert.equal((await publishing.status(itemId)).platforms.linkedin, true)
  assert.deepEqual(await publishing.options('linkedin'), { account: 'LinkedIn 测试作者', categories: [] })
  for (const options of [{}, { privacyStatus: 'private' }, { privacyStatus: 'connections' }]) await assert.rejects(() => publishing.prepare({ ...input, options }), /确认 LinkedIn 公开/)
  const preparation = await publishing.prepare(input)
  assert.equal(preparation.cover, null)
  assert.deepEqual(preparation.draft, draft)
  assert.ok(calls.every(call => call[0] === 'GET'))
  assert.ok(!JSON.stringify(preparation).includes(accessToken))
  const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
  await assert.rejects(() => publishing.start({ ...payload, confirmed: false }), /明确确认/)
  state.memberId = 'different-member'
  await assert.rejects(() => publishing.start(payload), /个人账号不一致/)
  state.memberId = memberId
  state.beforeCreate = async () => {
    const { records } = JSON.parse(await readFile(join(root, '.publish-records.json'), 'utf8'))
    assert.equal(records[0].submissionStarted, true)
    assert.equal(records[0].status, 'publishing')
  }
  await publishing.start(payload)
  const job = await finish(publishing)
  assert.equal(job.status, 'published')
  assert.equal(job.receiptId, receiptId)
  assert.equal(job.actualPrivacy, 'public')
  assert.equal(job.url, `https://www.linkedin.com/feed/update/${receiptId}/`)
  assert.equal(job.canReview, true)
  assert.equal(calls.filter(call => call[0] === 'PUT').length, 2)
  assert.equal(calls.filter(call => call[0] === 'GET' && call[1].startsWith('/rest/videos/')).length, 2)
  assert.equal(calls.filter(call => call[0] === 'POST' && call[1] === '/rest/posts').length, 1)
  state.readDenied = true
  const denied = await publishing.review(payload)
  assert.equal(denied.status, 'published')
  assert.equal(denied.url, job.url)
  assert.match(denied.reviewError, /r_member_social/)
  state.readDenied = false
  state.postOwner = 'urn:li:person:other'
  assert.equal((await publishing.review(payload)).status, 'published')
  state.postOwner = owner
  assert.equal((await new Publishing(store, { resolvePlatform }).review(payload)).status, 'published')
  await assert.rejects(() => publishing.prepare(input), /已有/)
  await publishing.start(payload)
  assert.equal(calls.filter(call => call[0] === 'POST' && call[1] === '/rest/posts').length, 1)
  const history = await readFile(join(root, '.publish-records.json'), 'utf8')
  for (const secret of [accessToken, uploadToken, 'private-signed-url', 'part-1']) assert.ok(!history.includes(secret))
})

for (const [label, parts] of [
  ['外部域名', [{ firstByte: 0, lastByte: 79_999, uploadUrl: 'https://evil.invalid/dms-uploads/a' }]],
  ['域名后缀伪装', [{ firstByte: 0, lastByte: 79_999, uploadUrl: 'https://www.linkedin.com.evil.invalid/dms-uploads/a' }]],
  ['官方域名其他路径', [{ firstByte: 0, lastByte: 79_999, uploadUrl: 'https://www.linkedin.com/feed/' }]],
  ['带用户名', [{ firstByte: 0, lastByte: 79_999, uploadUrl: 'https://other@www.linkedin.com/dms-uploads/a' }]],
  ['越界', [{ firstByte: 0, lastByte: 80_000, uploadUrl: uploadUrl(1) }]],
  ['缺尾段', [{ firstByte: 0, lastByte: 39_999, uploadUrl: uploadUrl(1) }]],
  ['重叠', [{ firstByte: 0, lastByte: 39_999, uploadUrl: uploadUrl(1) }, { firstByte: 39_999, lastByte: 79_999, uploadUrl: uploadUrl(2) }]],
  ['后段不安全', [{ firstByte: 0, lastByte: 39_999, uploadUrl: uploadUrl(1) }, { firstByte: 40_000, lastByte: 79_999, uploadUrl: 'http://www.linkedin.com/dms-uploads/a' }]],
]) {
  test(`LinkedIn 在发送任何素材前拒绝${label}`, async context => {
    const { store, input, root } = await fixture(context)
    const { resolvePlatform, calls } = platform({ parts })
    const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
    const preparation = await publishing.prepare(input)
    await publishing.start({ id: itemId, taskId: preparation.taskId, confirmed: true })
    assert.equal((await finish(publishing)).status, 'failed')
    assert.ok(calls.every(call => call[0] !== 'PUT' && call[1] !== '/rest/posts'))
  })
}

for (const [label, overrides, unknown] of [
  ['缺失 ETag', { noEtag: true }, false],
  ['分片完成失败', { finalizeFailure: true }, false],
  ['视频归属变化', { videoOwner: 'urn:li:person:other' }, false],
  ['转码失败', { processing: ['PROCESSING_FAILED'] }, false],
  ['转码超时', { processing: ['PROCESSING', 'PROCESSING'] }, false],
  ['最终请求断线', { disconnect: true }, true],
  ['成功响应缺回执', { missingReceipt: true }, true],
  ['明确拒绝发布', { rejection: true }, false],
]) {
  test(`LinkedIn ${label}：保留可确认结果，未知任务不重投`, async context => {
    const { store, input, root } = await fixture(context)
    const { resolvePlatform, calls } = platform(overrides)
    const publishing = new Publishing(store, { resolvePlatform, snapshotRoot: root })
    const preparation = await publishing.prepare(input)
    const payload = { id: itemId, taskId: preparation.taskId, confirmed: true }
    await publishing.start(payload)
    const job = await finish(publishing)
    assert.equal(job.status, unknown ? 'unknown' : 'failed')
    assert.ok(!JSON.stringify(job).includes(accessToken))
    const created = calls.filter(call => call[0] === 'POST' && call[1] === '/rest/posts').length
    assert.equal(created, unknown || overrides.rejection ? 1 : 0)
    await publishing.start(payload)
    assert.equal(calls.filter(call => call[0] === 'POST' && call[1] === '/rest/posts').length, created)
    if (unknown) await assert.rejects(() => publishing.prepare(input), /已有/)
    else assert.ok((await publishing.prepare(input)).taskId)
  })
}

test('LinkedIn Host 默认关闭，固定个人账号与 API 版本，验证发布文案和 little 转义', () => {
  const env = { MEDIA_DESK_LINKEDIN_PUBLISH: '1', MEDIA_DESK_LINKEDIN_ACCESS_TOKEN: accessToken, MEDIA_DESK_LINKEDIN_MEMBER_ID: memberId }
  assert.ok(configuredPlatform('linkedin', env))
  for (const key of Object.keys(env)) assert.equal(configuredPlatform('linkedin', { ...env, [key]: '' }), null)
  for (const version of ['latest', '202613', '20261', '202611\n']) assert.equal(configuredPlatform('linkedin', { ...env, MEDIA_DESK_LINKEDIN_API_VERSION: version }), null)
  assert.equal(linkedInCopyIssue(draft), '')
  assert.match(linkedInCopyIssue({ ...draft, description: '文'.repeat(3000) }), /3,000/)
  assert.match(linkedInCopyIssue({ ...draft, topics: ['two words'] }), /话题/)
  assert.equal(linkedInCaption(draft), '准备发布 [视频]\n\n正文 | @读者 <测试> \\ *斜体*\n\n#测试 #demo_tag')
  assert.equal(linkedInCommentary(draft), '准备发布 \\[视频\\]\n\n正文 \\| \\@读者 \\<测试\\> \\\\ \\*斜体\\*\n\n{hashtag|\\#|测试} {hashtag|\\#|demo\\_tag}')
})
