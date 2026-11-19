import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { blueskyCaption, blueskyCopyIssue, blueskyFacets } from '../src/publish/draft-copy.js'
import { PUBLISH_PLATFORMS } from '../src/publish/capabilities.js'
import { createBlueskyClient, createBlueskyRecordKey } from '../src/publish/bluesky/client.js'
import { createBlueskyPublisher } from '../src/publish/bluesky/publish.js'
import { PublishError } from '../src/publish/errors.js'
import { BLUESKY_IMAGE_BYTES, blueskyImagesIssue } from '../src/publish/media-rules.js'
import { configuredPlatform } from '../src/publish/platforms.js'

const did = 'did:plc:abcdefghijklmnopqrstuvwxyz123456'
const handle = 'author.bsky.social'
const appPassword = 'abcd-efgh-ijkl-mnop'
const config = { did, handle, appPassword }
const postDraft = { title: '测试标题', description: '正文 https://example.com/test。', topics: ['测试'], privacyStatus: 'public', format: 'text' }
const image = bytes => ({ mime: 'image/png', sizeBytes: bytes.length, stream: () => Readable.from([bytes]) })
const ok = data => Response.json(data)

test('Bluesky 文案校验与 facets 使用 UTF-8 字节偏移', () => {
  const text = blueskyCaption({ ...postDraft, title: '猫 🐈', description: '看 https://example.com/a_(b)。', topics: ['测试'] })
  const facets = blueskyFacets(text)
  assert.equal(facets.length, 2)
  assert.deepEqual(facets[0].features[0], { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a_(b)' })
  assert.equal(facets[0].index.byteStart, Buffer.byteLength(text.slice(0, text.indexOf('https'))))
  assert.deepEqual(facets[1].features[0], { $type: 'app.bsky.richtext.facet#tag', tag: '测试' })
  assert.match(blueskyCopyIssue({ ...postDraft, title: 'x'.repeat(301) }), /300/)
  assert.match(blueskyCopyIssue({ ...postDraft, topics: ['bad tag'] }), /话题/)
})

test('Bluesky 限定纯文字及 1–4 张 2 MB JPEG/PNG 图文', () => {
  assert.equal(blueskyImagesIssue([image(Buffer.alloc(BLUESKY_IMAGE_BYTES))]), '')
  assert.match(blueskyImagesIssue([image(Buffer.alloc(BLUESKY_IMAGE_BYTES + 1))]), /2 MB/)
  assert.match(blueskyImagesIssue([]), /1 至 4/)
  assert.equal(PUBLISH_PLATFORMS.bluesky.formats.join(','), 'images,text')
  const publisher = createBlueskyPublisher({ did, account: async () => ({ handle }), createPost: async () => ({}) })
  assert.throws(() => publisher.check({ draft: { ...postDraft, format: 'video' } }), /仅支持纯文字或图文/)
  assert.throws(() => publisher.check({ draft: { ...postDraft, format: 'images' }, images: [] }), /1 至 4/)
  assert.throws(() => publisher.check({ draft: postDraft, video: {} }), /不能包含素材/)
  assert.throws(() => publisher.check({ draft: { ...postDraft, privacyStatus: 'private' } }), /公开发布/)
})

test('Bluesky Host 配置必须启用且凭据完整', () => {
  assert.equal(configuredPlatform('bluesky', {}), null)
  assert.equal(configuredPlatform('bluesky', { MEDIA_DESK_BLUESKY_PUBLISH: '1' }), null)
  const result = configuredPlatform('bluesky', {
    MEDIA_DESK_BLUESKY_PUBLISH: '1', MEDIA_DESK_BLUESKY_DID: did,
    MEDIA_DESK_BLUESKY_HANDLE: handle, MEDIA_DESK_BLUESKY_APP_PASSWORD: appPassword,
  })
  assert.ok(result?.adapter)
})

test('Bluesky 验证登录 DID、直传图片字节并创建含 facets 的帖子', async () => {
  const calls = []
  const checks = []
  const imgBytes = Buffer.from('local image bytes')
  const client = createBlueskyClient(config, {
    validatePds: async url => checks.push(url),
    fetchImpl: async (url, request) => {
      const address = new URL(url)
      calls.push({ path: address.pathname, method: request.method, headers: request.headers, body: request.body, redirect: request.redirect })
      if (address.pathname.endsWith('createSession')) return ok({ did, handle, accessJwt: 'test-jwt' })
      if (address.pathname.endsWith('getProfile')) return ok({ did, handle, displayName: 'Test Author' })
      if (address.pathname.endsWith('uploadBlob')) {
        const uploaded = Buffer.concat(await Array.fromAsync(request.body))
        assert.deepEqual(uploaded, imgBytes)
        return ok({ blob: { $type: 'blob', ref: { $link: 'bafkreiabc' }, mimeType: 'image/png', size: imgBytes.length } })
      }
      if (address.pathname.endsWith('createRecord')) {
        const json = JSON.parse(request.body)
        assert.equal(json.repo, did)
        assert.equal(json.record.$type, 'app.bsky.feed.post')
        assert.equal(json.record.text, blueskyCaption({ ...postDraft, format: 'images' }))
        assert.ok(json.record.facets.some(facet => facet.features[0].$type.endsWith('#link')))
        assert.equal(json.record.embed.images.length, 1)
        return ok({ uri: `at://${did}/app.bsky.feed.post/${json.rkey}`, cid: 'bafy-post' })
      }
      assert.fail('Unexpected Bluesky API call: ' + address.pathname)
    },
  })
  const publisher = createBlueskyPublisher(client)
  assert.deepEqual(await publisher.account(), { id: did, name: 'Test Author (@author.bsky.social)', handle })
  const checkpoints = []
  const result = await publisher.submit({
    channelId: did, draft: { ...postDraft, format: 'images' }, images: [image(imgBytes)],
    beforeSubmit: async receipt => checkpoints.push(receipt),
  })
  assert.equal(result.status, 'published')
  assert.equal(result.receiptId, checkpoints[0])
  assert.match(result.url, /^https:\/\/bsky\.app\/profile\/author\.bsky\.social\/post\//)
  assert.ok(calls.every(call => call.redirect === 'error'))
  assert.equal(calls.filter(call => call.path.endsWith('createRecord')).length, 1)
  assert.ok(checks.every(url => url === 'https://bsky.social/'))
})

test('Bluesky 登录 DID 不符和 PDS 非公网 HTTPS 在发帖前失败', async () => {
  const mismatch = createBlueskyClient(config, {
    validatePds: async () => {},
    fetchImpl: async () => ok({ did: 'did:plc:wrong', handle, accessJwt: 'token' }),
  })
  await assert.rejects(() => mismatch.account(), error => error instanceof PublishError && error.code === 'BLUESKY_ACCOUNT_MISMATCH')
  for (const pdsUrl of ['http://bsky.social', 'https://localhost', 'https://user:pass@bsky.social', 'https://bsky.social:8443']) {
    assert.throws(() => createBlueskyClient({ ...config, pdsUrl }), /Invalid Bluesky PDS URL/)
  }
})

test('Bluesky 在创建记录前持久化原 URI，未知结果仅按该 URI 回查', async () => {
  assert.match(createBlueskyRecordKey(1_700_000_000_000, 12), /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/)
  let receiptId
  let rkey
  const state = { createCalls: 0, reviewCalls: 0 }
  const client = {
    did,
    account: async () => ({ handle }),
    createPost: async (_draft, _images, key) => {
      state.createCalls++
      rkey = key
      assert.equal(`at://${did}/app.bsky.feed.post/${key}`, receiptId)
      throw new PublishError('BLUESKY_NO_RESPONSE', 'no response', { stage: 'submit', outcome: 'unknown' })
    },
    getPost: async key => {
      state.reviewCalls++
      assert.equal(key, rkey)
      return { uri: receiptId, value: { $type: 'app.bsky.feed.post' } }
    },
  }
  const publisher = createBlueskyPublisher(client)
  let saved
  await assert.rejects(() => publisher.submit({ channelId: did, draft: postDraft, beforeSubmit: async value => { saved = value; receiptId = value } }), error => error.outcome === 'unknown')
  assert.equal(saved, receiptId)
  const reviewed = await publisher.review({ channelId: did, receiptId: saved })
  assert.equal(reviewed.status, 'published')
  assert.equal(state.createCalls, 1)
  assert.equal(state.reviewCalls, 1)
})

test('Bluesky 不接受缺少完整图片源的发布请求', async () => {
  const publisher = createBlueskyPublisher({ did, account: async () => ({ handle }), createPost: async () => ({}) })
  assert.throws(() => publisher.check({ draft: { ...postDraft, format: 'images' }, images: [{ mime: 'image/png', sizeBytes: 10 }] }), /有效的本地发布图片/)
})
