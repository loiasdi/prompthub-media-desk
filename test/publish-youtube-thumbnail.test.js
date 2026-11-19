import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createYouTubeAdapter } from '../src/publish/youtube/index.js'
import { visibleRecord } from '../src/publish/records.js'

const channelId = 'UCaBcD123456789012345678'
const receiptId = 'DshUpload12'
const videoBytes = Buffer.from('0000ftypabcde')
const coverBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const source = (bytes, mime) => ({ mime, sizeBytes: bytes.length, stream: () => Readable.from([bytes]) })
const video = source(videoBytes, 'video/mp4')
const cover = source(coverBytes, 'image/png')
const draft = { title: '缩略图测试', description: '', categoryId: '22', privacyStatus: 'private', selfDeclaredMadeForKids: false }
const details = (uploadStatus = 'processed', changes = {}) => ({ id: receiptId, snippet: { channelId }, status: { uploadStatus, privacyStatus: 'private' }, processingDetails: { processingStatus: uploadStatus === 'processed' ? 'succeeded' : 'processing' }, ...changes })
const collect = async body => { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks) }
const validThumbnail = () => Response.json({ kind: 'youtube#thumbnailSetResponse', items: [{ high: { url: `https://i.ytimg.com/vi/${receiptId}/hqdefault.jpg`, width: 480, height: 360 } }] })

function fixture(options = {}) {
  const events = [], requests = [], checkpoints = []
  let accountReads = 0, processingReads = 0
  const adapter = createYouTubeAdapter({ clientId: 'mock-client', redirectUri: 'http://127.0.0.1:4311/callback' }, {
    pollAttempts: 2, pollIntervalMs: 1, wait: async () => { events.push('wait') }, ...options.policy,
    fetchImpl: async (url, req) => {
      requests.push([url, req]); events.push(req.method + ' ' + url.pathname)
      assert.equal(url.origin, 'https://www.googleapis.com')
      assert.equal(req.redirect, 'error')
      assert.equal(req.headers.authorization, 'Bearer mock-token')
      if (url.pathname === '/youtube/v3/channels') {
        accountReads++
        return Response.json({ items: [{ id: accountReads > 1 && options.changedAccount ? 'another-channel' : channelId, snippet: { title: '频道' } }] })
      }
      if (url.pathname === '/youtube/v3/videoCategories') return Response.json({ items: [{ id: '22', snippet: { title: '生活', assignable: true } }] })
      if (url.pathname === '/upload/youtube/v3/videos') {
        if (req.method === 'POST') return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=mock-session' } })
        assert.deepEqual(await collect(req.body), videoBytes)
        return Response.json({ id: receiptId, snippet: { channelId: options.submittedOwner || channelId } })
      }
      if (url.pathname === '/youtube/v3/videos') {
        processingReads++
        if (options.processing) return options.processing(processingReads, url)
        return Response.json({ items: [details()] })
      }
      if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
        assert.equal(req.method, 'POST')
        assert.equal(url.searchParams.get('videoId'), receiptId)
        assert.equal(url.searchParams.get('uploadType'), 'media')
        assert.equal(req.headers['content-type'], 'image/png')
        assert.equal(req.headers['content-length'], String(coverBytes.length))
        assert.equal(req.duplex, 'half')
        assert.deepEqual(await collect(req.body), coverBytes)
        assert.deepEqual(checkpoints.at(-1), { receiptId, coverResult: { status: 'pending' } })
        return options.thumbnail ? options.thumbnail(url, req) : validThumbnail()
      }
      assert.fail('Unexpected mock request')
    },
  })
  const input = { accessToken: 'mock-token', channelId, draft, video, cover, beforeSubmit: async checkpoint => {
    checkpoints.push(checkpoint); events.push('checkpoint')
    await options.checkpoint?.(checkpoint)
  } }
  return { adapter, input, requests, events, checkpoints }
}

test('YouTube 缩略图：本地真实 MIME/字节，视频回执先持久化，再处理检查和直传', async () => {
  const { adapter, input, requests, events, checkpoints } = fixture({ processing: (n, url) => {
    assert.equal(url.searchParams.get('part'), n <= 3 ? 'snippet,status,processingDetails' : 'snippet,status')
    return Response.json({ items: [details(n === 1 ? 'uploaded' : 'processed')] })
  } })
  const result = await adapter.submit(input)
  assert.equal(result.status, 'pending_review')
  assert.equal(result.receiptId, receiptId)
  assert.equal(result.coverResult.status, 'set')
  assert.equal(checkpoints.length, 2)
  assert.deepEqual(checkpoints[0], { privacyStatus: 'private' })
  assert.deepEqual(events, [
    'GET /youtube/v3/channels', 'GET /youtube/v3/videoCategories', 'POST /upload/youtube/v3/videos',
    'checkpoint', 'PUT /upload/youtube/v3/videos', 'checkpoint', 'GET /youtube/v3/videos', 'wait',
    'GET /youtube/v3/videos', 'GET /youtube/v3/channels', 'GET /youtube/v3/videos', 'POST /upload/youtube/v3/thumbnails/set',
  ])
  const reviewed = await adapter.review({ accessToken: input.accessToken, channelId, receiptId, privacyStatus: 'private' })
  assert.equal(reviewed.status, 'published')
  assert.equal(reviewed.url, undefined)
  assert.equal(requests.filter(([url]) => url.pathname.includes('thumbnails')).length, 1, '回查只读，不能重设封面')
})

test('YouTube 可选缩略图校验：50 MB 边界、JPEG/PNG、本地流及有效整数大小', () => {
  const { adapter, input } = fixture()
  for (const mime of ['image/jpeg', 'image/png']) {
    for (const sizeBytes of [1, 50_000_000]) assert.doesNotThrow(() => adapter.check({ ...input, cover: { ...cover, mime, sizeBytes } }))
  }
  for (const invalid of [{}, { ...cover, mime: 'image/gif' }, { ...cover, stream: undefined }, ...[0, -1, 50_000_001, 1.5, NaN, undefined].map(sizeBytes => ({ ...cover, sizeBytes }))]) {
    assert.throws(() => adapter.check({ ...input, cover: invalid }), { code: 'INVALID_YOUTUBE_DRAFT' })
  }
})

test('YouTube 无封面保持原上传协议，不等待处理或调用缩略图接口', async () => {
  const { adapter, input, requests, checkpoints } = fixture()
  const result = await adapter.submit({ ...input, cover: undefined })
  assert.deepEqual(result, { status: 'pending_review', receiptId })
  assert.equal(checkpoints.length, 1)
  assert.equal(requests.length, 4)
})

for (const [name, response, status] of [
  ['频道权限拒绝', () => Response.json({ error: { message: 'secret-raw-response' } }, { status: 403 }), 'not_set'],
  ['网络断线', () => { throw Error('secret-raw-response') }, 'unknown'],
  ['服务端错误', () => Response.json({}, { status: 503 }), 'unknown'],
  ['无回执', () => new Response('not-json'), 'unknown'],
  ['空回执', () => Response.json({}), 'unknown'],
  ['无缩略图项', () => Response.json({ items: [] }), 'unknown'],
  ['无尺寸缩略图项', () => Response.json({ items: [{ high: { url: 'https://example.invalid/' } }] }), 'unknown'],
]) {
  test(`YouTube 缩略图${name}：保留视频回执并独立报告，不重传或泄漏原始错误`, async () => {
    const { adapter, input, requests } = fixture({ thumbnail: response })
    const result = await adapter.submit(input)
    assert.equal(result.receiptId, receiptId)
    assert.equal(result.status, 'pending_review')
    assert.equal(result.coverResult.status, status)
    assert.equal(JSON.stringify(result).includes('secret-raw-response'), false)
    assert.equal(requests.filter(([url, req]) => url.pathname === '/upload/youtube/v3/videos' && req.method === 'PUT').length, 1)
    assert.equal(requests.filter(([url]) => url.pathname.includes('thumbnails')).length, 1)
  })
}

for (const [name, options] of [
  ['处理仍未结束', { processing: () => Response.json({ items: [details('uploaded')] }) }],
  ['视频被拒绝', { processing: () => Response.json({ items: [details('rejected')] }) }],
  ['视频处理失败', { processing: () => Response.json({ items: [details('uploaded', { processingDetails: { processingStatus: 'failed' } })] }) }],
  ['处理完成但缺少官方 succeeded 状态', { processing: () => Response.json({ items: [details('processed', { processingDetails: undefined })] }) }],
  ['返回其他视频', { processing: () => Response.json({ items: [details('processed', { id: 'OtherVideo1' })] }) }],
  ['视频所属频道改变', { processing: () => Response.json({ items: [details('processed', { snippet: { channelId: 'another-channel' } })] }) }],
  ['视频可见性改变', { processing: () => Response.json({ items: [details('processed', { status: { uploadStatus: 'processed', privacyStatus: 'public' } })] }) }],
  ['最终可见性改变', { processing: n => Response.json({ items: [details('processed', n > 1 ? { status: { uploadStatus: 'processed', privacyStatus: 'public' } } : {})] }) }],
  ['账号改变', { changedAccount: true }],
  ['无法读取处理状态', { processing: () => { throw Error('private-info') } }],
  ['上传回执归属不明', { submittedOwner: 'another-channel' }],
]) {
  test(`YouTube ${name}：不发送缩略图，但必须保留已接收视频ID`, async () => {
    const { adapter, input, requests } = fixture(options)
    const result = await adapter.submit(input)
    assert.equal(result.receiptId, receiptId)
    assert.equal(result.coverResult.status, 'not_set')
    assert.equal(requests.some(([url]) => url.pathname.includes('thumbnails')), false)
  })
}

test('YouTube 视频回执持久化失败，不发送缩略图', async () => {
  const { adapter, input, requests } = fixture({ checkpoint: checkpoint => { if (checkpoint.receiptId) throw Error('disk-full') } })
  await assert.rejects(adapter.submit(input), /disk-full/)
  assert.equal(requests.some(([url]) => url.pathname.includes('thumbnails')), false)
})

test('YouTube 缩略图上传超时：视频回执保留，缩略图结果未知，不重发请求', async () => {
  const { adapter, input, requests } = fixture({ policy: { uploadTimeoutMs: 20 }, thumbnail: async (_, req) => {
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(Error('mock-aborted'))
      else req.signal.addEventListener('abort', () => reject(Error('mock-aborted')), { once: true })
    })
  } })
  const result = await adapter.submit(input)
  assert.equal(result.receiptId, receiptId)
  assert.equal(result.coverResult.status, 'unknown')
  assert.equal(requests.filter(([url]) => url.pathname.includes('thumbnails')).length, 1)
})

test('YouTube 中断后将未确认缩略图投影为 unknown，保留视频回执；不修改磁盘记录', () => {
  const record = { status: 'publishing', deadline: 0, receiptId, coverResult: { status: 'pending' } }
  const result = visibleRecord(record)
  assert.equal(result.status, 'unknown')
  assert.equal(result.coverResult.status, 'unknown')
  assert.equal(result.receiptId, receiptId)
  assert.equal(record.coverResult.status, 'pending')
  assert.equal(visibleRecord({ ...record, deadline: Date.now() + 10000 }).coverResult.status, 'pending')
  assert.equal(visibleRecord({ ...record, status: 'published' }).coverResult.status, 'unknown')
})
