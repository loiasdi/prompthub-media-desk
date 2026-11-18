import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { withLocalUploadSource } from '../src/publish/local-source.js'
import { createYouTubeAdapter } from '../src/publish/youtube/index.js'

const config = { clientId: 'desktop-client-id', clientSecret: 'desktop-client-secret', redirectUri: 'http://127.0.0.1:4311/callback' }
const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const scope = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
const channelId = 'UCaBcD123456789012345678'
const receiptId = 'DshUpload12'
const uploadPath = '/upload/youtube/v3/videos'
const uploadUrl = `https://www.googleapis.com${uploadPath}?uploadType=resumable&upload_id=opaque-upload-id`
const channel = { id: channelId, snippet: { title: '我的频道' } }
const category = { id: '22', snippet: { title: 'People & Blogs', assignable: true } }
const draft = { title: ' 首条视频 ', description: '原样保留话题 #测试', topics: ['测试', 'two words', ' 测试 '], categoryId: '22', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }
const bytes = Buffer.from([0x00, 0xff, 0x80, 0x7f])
const source = { filename: 'test.mp4', mime: 'video/mp4', sizeBytes: bytes.length, stream: () => Readable.from([bytes]) }
const base = { accessToken: 'access-token', channelId, draft, video: source, beforeSubmit: async () => {} }
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }
const submitted = (id = receiptId, owner = channelId) => Response.json({ id, snippet: { channelId: owner } }, { status: 201 })

function mockAdapter(overrides = {}, options = {}) {
  const calls = []
  const adapter = createYouTubeAdapter(config, { ...options, fetchImpl: async (url, req) => {
    const key = `${req.method} ${url.pathname}`
    calls.push([url, req])
    if (Object.hasOwn(overrides, key)) return overrides[key](url, req)
    switch (key) {
      case 'GET /youtube/v3/channels': return Response.json({ items: [channel] })
      case 'GET /youtube/v3/videoCategories': return Response.json({ items: [category] })
      case `POST ${uploadPath}`: return new Response(null, { headers: { location: uploadUrl } })
      case `PUT ${uploadPath}`: await collect(req.body); return submitted()
      default: assert.fail(`Unexpected mock request: ${key}`)
    }
  } })
  return { adapter, calls }
}

function videoDetails(uploadStatus, privacyStatus, owner = channelId, id = receiptId) {
  return { id, snippet: { channelId: owner }, status: { uploadStatus, privacyStatus } }
}

test('YouTube 桌面 OAuth：loopback、S256 PKCE 和刷新旧令牌', async () => {
  const token = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope, token_type: 'Bearer' }
  const { adapter, calls } = mockAdapter({
    'POST /token': (_, req) => Response.json(req.body.get('grant_type') === 'authorization_code' ? token : {
      access_token: 'new-access', expires_in: 3600, token_type: 'Bearer',
    }),
  }, { now: () => 1700000000000 })
  assert.equal(adapter.platform, 'youtube')
  const auth = new URL(adapter.authorizationUrl('state-token', { codeVerifier }))
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(auth.searchParams.get('redirect_uri'), config.redirectUri)
  assert.equal(auth.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(auth.searchParams.get('state'), 'state-token')
  assert.equal(auth.searchParams.get('access_type'), 'offline')
  assert.equal(auth.searchParams.get('scope'), scope)
  assert.equal(auth.searchParams.has('client_secret'), false)
  assert.throws(() => createYouTubeAdapter({ ...config, redirectUri: 'https://example.com/callback' }), { code: 'INVALID_YOUTUBE_OAUTH' })
  assert.throws(() => adapter.exchangeCode('auth-code', { codeVerifier: 'insecure' }), { code: 'INVALID_YOUTUBE_OAUTH' })
  const expiresAt = '2023-11-14T23:13:20.000Z'
  assert.deepEqual(await adapter.exchangeCode('auth-code', { codeVerifier }), { accessToken: 'access', refreshToken: 'refresh', expiresAt })
  assert.deepEqual(await adapter.refreshToken('refresh'), { accessToken: 'new-access', refreshToken: 'refresh', expiresAt })
  assert.equal(calls[0][1].body.get('code_verifier'), codeVerifier)
  assert.equal(calls[0][1].body.get('client_secret'), config.clientSecret)
  assert.equal(calls[1][1].body.get('refresh_token'), 'refresh')
  assert.ok(calls.every(([url, req]) => url.href === 'https://oauth2.googleapis.com/token' && req.redirect === 'error'))
})

test('YouTube 部分授权不返回可用于投稿的凭据', async () => {
  const { adapter } = mockAdapter({ 'POST /token': () => Response.json({
    access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.readonly', token_type: 'Bearer',
  }) })
  await assert.rejects(adapter.exchangeCode('auth-code', { codeVerifier }), { code: 'YOUTUBE_INSUFFICIENT_SCOPE', stage: 'auth' })
})

test('YouTube 直接流式上传本地字节，默认私密且不通知订阅者', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'md-youtube-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'test.mp4')
  await writeFile(path, bytes)
  const steps = []
  const { adapter, calls } = mockAdapter({
    [`POST ${uploadPath}`]: () => { steps.push('init'); return new Response(null, { headers: { location: uploadUrl } }) },
    [`PUT ${uploadPath}`]: async (_, req) => { steps.push('put'); assert.deepEqual(await collect(req.body), bytes); return submitted() },
    'GET /youtube/v3/videos': () => Response.json({ items: [videoDetails('processed', 'private')] }),
  })
  const receipt = await withLocalUploadSource(dir, path, { filename: 'test.mp4', mime: 'video/mp4' }, video =>
    adapter.submit({ ...base, video, beforeSubmit: async checkpoint => {
      assert.deepEqual(checkpoint, { privacyStatus: 'private' })
      steps.push('checkpoint')
    } }))
  assert.deepEqual(steps, ['init', 'checkpoint', 'put'])
  assert.deepEqual(receipt, { status: 'pending_review', receiptId })
  assert.deepEqual(await adapter.review({ ...base, ...receipt, privacyStatus: 'private' }), { status: 'published', receiptId, privacyStatus: 'private', platformState: 'processed' })
  assert.deepEqual(calls.map(([url, req]) => [url.pathname, req.method]), [
    ['/youtube/v3/channels', 'GET'], ['/youtube/v3/videoCategories', 'GET'], [uploadPath, 'POST'], [uploadPath, 'PUT'], ['/youtube/v3/videos', 'GET'],
  ])
  assert.ok(calls.every(([url, req]) => url.origin === 'https://www.googleapis.com' && req.headers.authorization === 'Bearer access-token' && req.redirect === 'error'))
  const [[chan], [cat], [init, initReq], [put, putReq], [review]] = calls
  assert.equal(chan.searchParams.get('mine'), 'true')
  assert.equal(cat.searchParams.get('id'), draft.categoryId)
  assert.equal(init.searchParams.get('uploadType'), 'resumable')
  assert.equal(init.searchParams.get('notifySubscribers'), 'false')
  assert.deepEqual(JSON.parse(initReq.body), {
    snippet: { title: '首条视频', description: '原样保留话题 #测试', tags: ['测试', 'two words'], categoryId: '22' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  })
  assert.equal(initReq.headers['x-upload-content-length'], String(bytes.length))
  assert.equal(initReq.headers['x-upload-content-type'], source.mime)
  assert.equal(put.href, uploadUrl)
  assert.equal(putReq.headers['content-length'], String(bytes.length))
  assert.equal(putReq.headers['content-type'], source.mime)
  assert.equal(putReq.duplex, 'half')
  assert.equal(review.searchParams.get('id'), receiptId)
})

test('YouTube 仅返回可用分区；未知频道、无效分区不创建上传会话', async () => {
  const disabled = { id: '99', snippet: { assignable: false, title: '不可投' } }
  const { adapter, calls } = mockAdapter({ 'GET /youtube/v3/videoCategories': () => Response.json({ items: [category, disabled] }) })
  assert.deepEqual(await adapter.account(base.accessToken), { channelId, title: channel.snippet.title })
  assert.deepEqual(await adapter.categories(base.accessToken, 'US'), [{ id: '22', title: category.snippet.title }])
  assert.equal(calls[1][0].searchParams.get('regionCode'), 'US')
  await assert.rejects(adapter.submit({ ...base, channelId: 'another-channel' }), { code: 'YOUTUBE_CHANNEL_MISMATCH' })
  await assert.rejects(adapter.submit({ ...base, draft: { ...draft, categoryId: '99' } }), { code: 'INVALID_YOUTUBE_DRAFT' })
  assert.ok(calls.every(([url]) => url.pathname !== uploadPath))
  const multiple = mockAdapter({ 'GET /youtube/v3/channels': () => Response.json({ items: [channel], nextPageToken: 'more' }) })
  await assert.rejects(multiple.adapter.submit(base), { code: 'YOUTUBE_CHANNEL_UNCONFIRMED' })
  assert.equal(multiple.calls.length, 1)
})

test('YouTube 不接受外链素材、超限文案或未实现的发布选项', async () => {
  const { adapter, calls } = mockAdapter()
  await assert.rejects(adapter.submit({ ...base, beforeSubmit: undefined }), /checkpoint/)
  for (const input of [
    { video: { url: 'https://example.com/video.mp4' } }, { cover: {} },
    { draft: { ...draft, selfDeclaredMadeForKids: undefined } }, { draft: { ...draft, publishAt: '2030-12-01T00:00:00Z' } },
    { draft: { ...draft, description: '中'.repeat(1667) } }, { draft: { ...draft, topics: [`a ${'b'.repeat(497)}`] } },
  ]) await assert.rejects(adapter.submit({ ...base, ...input }), { code: 'INVALID_YOUTUBE_DRAFT' })
  assert.deepEqual(calls, [])
})

test('YouTube 不向非预期会话地址发送素材；写检查点失败不发 PUT', async () => {
  for (const location of [null, 'https://example.com/upload/youtube/v3/videos?upload_id=secret', 'https://www.googleapis.com/other?upload_id=secret', 'https://www.googleapis.com/upload/youtube/v3/videos']) {
    const { adapter, calls } = mockAdapter({ [`POST ${uploadPath}`]: () => new Response(null, { headers: location ? { location } : {} }) })
    await assert.rejects(adapter.submit({ ...base, beforeSubmit: assert.fail }), { code: 'YOUTUBE_INVALID_RESPONSE', stage: 'upload_init', outcome: 'failed' })
    assert.ok(calls.every(([, req]) => req.method !== 'PUT'))
  }
  const { adapter, calls } = mockAdapter()
  await assert.rejects(adapter.submit({ ...base, beforeSubmit: async () => { throw new Error('disk failure') } }), /disk failure/)
  assert.ok(calls.every(([, req]) => req.method !== 'PUT'))
})

test('YouTube 提交后断线、超时、308 或回执缺失不会重传', async t => {
  const cases = {
    'network error': () => { throw new Error('raw secret & opaque upload_id') },
    'timeout': (_, req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('raw timeout')), { once: true })),
    'resume incomplete': () => new Response(null, { status: 308 }),
    'server unavailable': () => Response.json({ error: { message: 'raw secret' } }, { status: 503 }),
    'generic JSON 404': () => Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 }),
    'non-API 404': () => new Response('<h1>Upload session not found</h1>', { status: 404 }),
    'session message on 503': () => Response.json({ error: { code: 404, message: 'Upload session not found' } }, { status: 503 }),
    'invalid JSON': () => new Response('raw secret', { status: 201 }),
    'missing ID': () => Response.json({}, { status: 201 }),
  }
  for (const [name, reply] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { adapter, calls } = mockAdapter({ [`PUT ${uploadPath}`]: reply }, { uploadTimeoutMs: 10 })
      await assert.rejects(adapter.submit(base), error => error.code === 'YOUTUBE_SUBMISSION_UNCONFIRMED' && error.stage === 'submit' && error.outcome === 'unknown' && !/raw|secret|upload_id/.test(error.message))
      assert.equal(calls.filter(([, req]) => req.method === 'PUT').length, 1)
    })
  }
  const { adapter } = mockAdapter({ [`PUT ${uploadPath}`]: () => submitted(receiptId, 'different-channel') })
  assert.deepEqual(await adapter.submit(base), { status: 'unknown', receiptId })
})

test('YouTube 明确确认本次新会话已失效时返回失败，但不重投', async () => {
  for (const message of ['Upload session not found', 'The upload session has expired.']) {
    const { adapter, calls } = mockAdapter({
      [`PUT ${uploadPath}`]: () => Response.json({ error: { code: 404, message, extra: 'secret upload_id' } }, { status: 404 }),
    })
    await assert.rejects(adapter.submit(base), {
      code: 'YOUTUBE_UPLOAD_SESSION_EXPIRED', stage: 'submit', outcome: 'failed', httpStatus: 404,
      message: 'YouTube 上传会话已失效，本次上传未完成',
    })
    assert.deepEqual(calls.filter(([url]) => url.pathname === uploadPath).map(([, req]) => req.method), ['POST', 'PUT'])
  }
})

test('YouTube 回查必须使用投稿检查点的预期可见性', async () => {
  const { adapter, calls } = mockAdapter({ 'GET /youtube/v3/videos': () => Response.json({ items: [videoDetails('processed', 'private')] }) })
  let checkpoint
  const receipt = await adapter.submit({ ...base, draft: { ...draft, privacyStatus: 'public' }, beforeSubmit: async value => { checkpoint = value } })
  await assert.rejects(adapter.review({ ...base, ...receipt }), {
    code: 'YOUTUBE_INVALID_REVIEW', stage: 'review', outcome: 'unknown',
  })
  assert.equal(calls.some(([url]) => url.pathname === '/youtube/v3/videos'), false)
  assert.deepEqual(checkpoint, { privacyStatus: 'public' })
  assert.deepEqual(await adapter.review({ ...base, ...receipt, ...checkpoint }), {
    status: 'unknown', receiptId, privacyStatus: 'private', platformState: 'processed',
  })
})

test('YouTube 回查请求失败不等于远端投稿失败', async () => {
  for (const [reply, code, httpStatus] of [
    [() => { throw new Error('raw secret') }, 'YOUTUBE_RESPONSE_UNAVAILABLE', undefined],
    [() => Response.json({}, { status: 503 }), 'YOUTUBE_REQUEST_FAILED', 503],
    [() => new Response('not JSON'), 'YOUTUBE_INVALID_RESPONSE', 200],
    [() => Response.json({}), 'YOUTUBE_INVALID_RESPONSE', undefined],
  ]) {
    const { adapter, calls } = mockAdapter({ 'GET /youtube/v3/videos': reply })
    await assert.rejects(adapter.review({ ...base, receiptId, privacyStatus: 'private' }), {
      code, stage: 'review', outcome: 'unknown', httpStatus,
    })
    assert.deepEqual(calls.map(([url, req]) => [url.pathname, req.method]), [['/youtube/v3/videos', 'GET']])
  }
})

test('YouTube 仅在回查确认频道、处理状态和可见性后标交付成功', async () => {
  for (const [items, status] of [
    [[], 'unknown'], [[videoDetails('processed', 'public', 'different-channel')], 'unknown'],
    [[videoDetails('processed', 'private')], 'unknown'], [[videoDetails('uploaded', 'public')], 'pending_review'],
    [[videoDetails('failed', 'private')], 'failed'], [[videoDetails('rejected', 'private')], 'rejected'],
    [[videoDetails('processed', 'public')], 'published'],
  ]) {
    const { adapter } = mockAdapter({ 'GET /youtube/v3/videos': () => Response.json({ items }) })
    const result = await adapter.review({ ...base, receiptId, privacyStatus: 'public' })
    assert.equal(result.status, status)
    assert.equal(result.url, status === 'published' ? `https://www.youtube.com/watch?v=${receiptId}` : undefined)
  }
})
