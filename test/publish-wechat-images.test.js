import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ContentAssets } from '../src/content-assets.js'
import { assetFileName } from '../src/asset-rules.js'
import { articleImageIds, articleImageMarker, articleImageSyntaxIssue } from '../src/publish/article-images.js'
import { weChatArticleHtml, weChatCopyIssue } from '../src/publish/draft-copy.js'
import { weChatBodyImagesIssue } from '../src/publish/media-rules.js'
import { Publishing } from '../src/publish/service.js'
import { createWeChatAdapter } from '../src/publish/wechat/index.js'
import { createWeChatClient } from '../src/publish/wechat/client.js'
import { weChatImageUrl } from '../src/publish/wechat/links.js'
import { Store } from '../src/store.js'

const id = 'wechat-body-images', appId = 'wx1234567890abcdef', secret = 'a'.repeat(32)
const token = 'mock-server-token', publishId = '100000001'
const options = { privacyStatus: 'public', allowComment: false, onlyFansComment: false, requiresNativeDeclaration: false }
const png = Buffer.from('89504e470d0a1a0a', 'hex'), jpeg = Buffer.from('ffd8ff', 'hex')
const imageUrl = index => `https://mmbiz.qpic.cn/mmbiz_png/mock_${index}/0?wx_fmt=png`

async function fixture(t, count = 4) {
  const root = await mkdtemp(join(tmpdir(), 'md-wechat-body-images-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id, title: '正文配图测试', body: '正文', tags: [], platform: '公众号' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({}) })
  let ws = await assets.read(id)
  const images = [], bytes = []
  for (let index = 0; index < count; index++) {
    const payload = Buffer.concat([index % 2 ? jpeg : png, Buffer.from([index])])
    const row = await assets.import(id, Readable.from([payload]), { revision: ws.revision, name: `${index + 1}.${index % 2 ? 'jpg' : 'png'}` })
    images.push(row.asset); bytes.push(payload); ws = row.workspace
  }
  const description = `开头 <script>不执行</script>\n\n${articleImageMarker(images[1].id)}\n\n中间 & 正文\n\n${articleImageMarker(images[0].id)}\n\n${articleImageMarker(images[1].id)}\n\n结尾`
  ws = await assets.save(id, ws.revision, { ...ws, selectedCover: images[2].id, imageIds: images.map(image => image.id), selectedVideo: 'unused-video', publish: { ...ws.publish, format: 'article', mode: 'now', description }, publishEdited: { description: true } })
  return { root, store, assets, ws, images, bytes, description, path: image => join(root, '内容', id, '素材', assetFileName(image.src).split('/').at(-1)), input: { id, revision: ws.revision, platform: 'wechat', options } }
}

function mock() {
  const calls = [], uploads = [], state = {}
  const adapter = createWeChatAdapter({ clientId: appId, clientSecret: secret }, { fetchImpl: async (url, request) => {
    assert.equal(url.origin, 'https://api.weixin.qq.com')
    assert.equal(request.redirect, 'error')
    calls.push(request.method + ' ' + url.pathname)
    if (url.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: token, expires_in: 7200 })
    assert.equal(url.searchParams.get('access_token'), token)
    if (url.pathname === '/cgi-bin/material/get_materialcount') return Response.json({ image_count: 1, news_count: 0, video_count: 0, voice_count: 0 })
    if (['/cgi-bin/material/add_material', '/cgi-bin/media/uploadimg'].includes(url.pathname)) {
      const cover = url.pathname.includes('add_material')
      assert.equal(request.method, 'POST')
      assert.equal(request.duplex, 'half')
      const chunks = []; for await (const chunk of request.body) chunks.push(chunk)
      const body = Buffer.concat(chunks), boundary = request.headers['content-type'].split('boundary=')[1]
      assert.equal(body.length, Number(request.headers['content-length']))
      const prefix = body.subarray(0, body.indexOf('\r\n\r\n') + 4), suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      assert.match(prefix.toString(), new RegExp(`name="media"; filename="${cover ? 'cover' : 'image'}\\.(?:png|jpg)"`))
      assert.match(prefix.toString(), /Content-Type: image\/(?:png|jpeg)/)
      assert.deepEqual(body.subarray(-suffix.length), suffix)
      const bytes = body.subarray(prefix.length, -suffix.length)
      if (cover) { state.cover = bytes; await state.onCover?.(); return Response.json({ media_id: 'cover-media-id' }) }
      uploads.push(bytes)
      if (state.failImage) return Response.json({ errcode: 45009, errmsg: token })
      return Response.json({ url: state.returnUrl ?? imageUrl(uploads.length).replace('https:', 'http:') })
    }
    if (url.pathname === '/cgi-bin/draft/add') { state.draft = JSON.parse(request.body); return Response.json({ media_id: 'draft-media-id' }) }
    if (url.pathname === '/cgi-bin/freepublish/submit') {
      assert.deepEqual(JSON.parse(request.body), { media_id: 'draft-media-id' })
      await state.beforeSubmit?.()
      if (state.lostPublish) throw new Error(token)
      return Response.json({ publish_id: publishId })
    }
    if (url.pathname === '/cgi-bin/freepublish/get') return Response.json({ publish_id: publishId, publish_status: 0, article_id: 'article-1', article_detail: { count: 1, item: [{ idx: 1, article_url: 'https://mp.weixin.qq.com/s/mock_AbC123' }] } })
    assert.fail('Unexpected WeChat mock endpoint: ' + url.pathname)
  } })
  return { adapter, calls, uploads, state, resolvePlatform: platform => platform === 'wechat' ? { adapter } : null }
}

async function finished(publishing) {
  for (let index = 0; index < 150; index++) {
    const job = (await publishing.status(id)).jobs[0]
    if (job && job.status !== 'publishing') return job
    await delay(10)
  }
  assert.fail('Article mock never completed')
}

async function start(f, remote) {
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const preparation = await publishing.prepare(f.input)
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  return { publishing, preparation, payload, job: await finished(publishing) }
}

test('公众号正文配图：仅上传标记引用的文件，封面与配图一起快照，顺序正确且重复引用只上传一次', async t => {
  const f = await fixture(t), remote = mock()
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  const preparation = await publishing.prepare(f.input)
  assert.deepEqual(preparation.images.map(image => image.id), [f.images[1].id, f.images[0].id])
  assert.equal(preparation.cover.id, f.images[2].id)
  assert.equal(preparation.video, null)
  assert.ok(remote.calls.every(call => ['POST /cgi-bin/stable_token', 'GET /cgi-bin/material/get_materialcount'].includes(call)))
  remote.state.beforeSubmit = async () => assert.equal(JSON.parse(await readFile(join(f.root, '.publish-records.json'), 'utf8')).records[0].submissionStarted, true)
  // The upload runs from private snapshots, not the original files changed now.
  remote.state.onCover = async () => { await writeFile(f.path(f.images[0]), Buffer.concat([png, Buffer.from('changed')])) }
  const payload = { id, taskId: preparation.taskId, confirmed: true }
  await publishing.start(payload)
  assert.equal((await finished(publishing)).status, 'pending_review')
  assert.deepEqual(remote.state.cover, f.bytes[2])
  assert.deepEqual(remote.uploads, [f.bytes[1], f.bytes[0]])
  const expected = new Map([[f.images[1].id, { url: imageUrl(1), filename: '2.jpg' }], [f.images[0].id, { url: imageUrl(2), filename: '1.png' }]])
  assert.equal(remote.state.draft.articles[0].content, weChatArticleHtml(f.description, expected))
  assert.equal(remote.state.draft.articles[0].thumb_media_id, 'cover-media-id')
  assert.equal((remote.state.draft.articles[0].content.match(/<img /g) || []).length, 3)
  assert.equal(remote.state.draft.articles[0].content.includes('[[image:'), false)
  assert.equal(remote.state.draft.articles[0].content.includes('<script>'), false)
  assert.equal(remote.state.draft.articles[0].content.includes('http://'), false)
  assert.equal((await publishing.review({ id, taskId: preparation.taskId })).status, 'published')
  await publishing.start(payload)
  assert.equal(remote.calls.filter(call => call.endsWith('/freepublish/submit')).length, 1)
})

test('公众号无配图标记：已有图文选择不发送，也不读取缺失的历史图片', async t => {
  const f = await fixture(t), remote = mock()
  const ws = await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, description: '纯文字正文' }, publishEdited: { description: true } })
  f.input.revision = ws.revision
  for (const image of [f.images[0], f.images[1], f.images[3]]) await rm(f.path(image))
  const { preparation, job } = await start(f, remote)
  assert.equal(preparation.images, undefined)
  assert.equal(job.status, 'pending_review')
  assert.equal(remote.uploads.length, 0)
  assert.equal(remote.state.draft.articles[0].content, '<p>纯文字正文</p>')
})

test('公众号上游 20 张正文配图：共用统一快照与顺序流，封面独立保留', async t => {
  const f = await fixture(t, 21), remote = mock()
  const referenced = f.images.slice(0, 20).toReversed()
  const description = '20 张正文配图\n\n' + referenced.map(image => articleImageMarker(image.id)).join('\n\n')
  const ws = await f.assets.save(id, f.ws.revision, { ...f.ws, selectedCover: f.images[20].id, publish: { ...f.ws.publish, description }, publishEdited: { description: true } })
  f.input.revision = ws.revision
  const { job, preparation } = await start(f, remote)
  assert.equal(job.status, 'pending_review')
  assert.equal(preparation.images.length, 20)
  assert.equal(preparation.cover.id, f.images[20].id)
  assert.deepEqual(remote.uploads, f.bytes.slice(0, 20).toReversed())
  assert.deepEqual(remote.state.cover, f.bytes[20])
  assert.equal((remote.state.draft.articles[0].content.match(/<img /g) || []).length, 20)
})

test('公众号引用图片被回收：不静默漏图，准备被阻止且不产生远端写入', async t => {
  const f = await fixture(t), remote = mock()
  const ws = await f.assets.recycle(id, f.ws.revision, f.images[0].id)
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  await assert.rejects(publishing.prepare({ ...f.input, revision: ws.revision }), /本地图片|素材/)
  assert.ok(remote.calls.every(call => !call.endsWith('/media/uploadimg') && !call.endsWith('/material/add_material') && !call.endsWith('/draft/add')))
})

for (const kind of ['missing', 'malformed', 'too-many', 'changed']) test(`公众号 ${kind} 配图：准备/确认核验失败，不上传也不创建远端草稿`, async t => {
  const f = await fixture(t), remote = mock()
  const publishing = new Publishing(f.store, { resolvePlatform: remote.resolvePlatform, snapshotRoot: f.root })
  if (kind === 'changed') {
    const prep = await publishing.prepare(f.input)
    await writeFile(f.path(f.images[0]), Buffer.concat([png, Buffer.from('changed')]))
    await assert.rejects(publishing.start({ id, taskId: prep.taskId, confirmed: true }), /变化|重新导入|素材/)
  } else {
    const description = kind === 'missing' ? '正文\n' + articleImageMarker('missing-image') : kind === 'malformed' ? '正文 [[image:../../bad]]' : Array.from({ length: 21 }, (_, index) => articleImageMarker('asset-' + index)).join('\n')
    const ws = await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, description }, publishEdited: { description: true } })
    await assert.rejects(publishing.prepare({ ...f.input, revision: ws.revision }), /配图|图片|素材/)
  }
  assert.ok(remote.calls.every(call => !call.endsWith('/media/uploadimg') && !call.endsWith('/material/add_material') && !call.endsWith('/draft/add')))
})

for (const returnUrl of ['https://evil.invalid/image.png', 'https://mmbiz.qpic.cn.evil.invalid/image.png', 'https://user:pass@mmbiz.qpic.cn/image.png', 'https://mmbiz.qpic.cn:444/image.png', 'javascript:alert(1)', 'https://mmbiz.qpic.cn/image.png#script', 'https://mmbiz.qpic.cn/image.png?access_token=mock-server-token']) test(`公众号拒绝不可信图片响应 ${returnUrl}`, async t => {
  const f = await fixture(t), remote = mock()
  remote.state.returnUrl = returnUrl
  const { job } = await start(f, remote)
  assert.equal(job.status, 'failed')
  assert.match(job.message, /可信/)
  assert.equal(remote.calls.some(call => call.endsWith('/draft/add') || call.endsWith('/freepublish/submit')), false)
})

test('公众号正文图片上传失败：不建草稿，不将错误响应中的令牌暴露到记录', async t => {
  const f = await fixture(t), remote = mock()
  remote.state.failImage = true
  const { job } = await start(f, remote)
  assert.equal(job.status, 'failed')
  assert.equal(JSON.stringify(job).includes(token), false)
  assert.equal(remote.calls.some(call => call.endsWith('/draft/add')), false)
})

test('公众号 URL 替换后再次检查最终 HTML 长度，不把超限正文发送给草稿接口', async t => {
  const f = await fixture(t), remote = mock()
  const ws = await f.assets.save(id, f.ws.revision, { ...f.ws, publish: { ...f.ws.publish, description: '字'.repeat(8000) + f.description }, publishEdited: { description: true } })
  f.input.revision = ws.revision
  remote.state.returnUrl = 'https://mmbiz.qpic.cn/' + 'a'.repeat(4000)
  const { job } = await start(f, remote)
  assert.equal(job.status, 'failed')
  assert.match(job.message, /20,000/)
  assert.equal(remote.calls.some(call => call.endsWith('/draft/add')), false)
})

test('公众号发表响应不确定：有正文配图也不允许重投', async t => {
  const f = await fixture(t), remote = mock()
  remote.state.lostPublish = true
  const { publishing, job } = await start(f, remote)
  assert.equal(job.status, 'unknown')
  assert.equal(JSON.stringify(job).includes(token), false)
  await assert.rejects(publishing.prepare(f.input), /已有/)
  assert.equal(remote.calls.filter(call => call.endsWith('/freepublish/submit')).length, 1)
})

test('公众号配图规则、标记解析与 HTML 安全：小于 1 MB、只发被引用的本地 JPEG/PNG，按正文位置替换', () => {
  const description = '前\n' + articleImageMarker('a') + '\n中\n' + articleImageMarker('b') + '\n' + articleImageMarker('a')
  const sources = [{ id: 'a', mime: 'image/png', sizeBytes: 999_999 }, { id: 'b', mime: 'image/jpeg', sizeBytes: 3 }]
  assert.deepEqual(articleImageIds(description), ['a', 'b'])
  assert.equal(weChatBodyImagesIssue(description, sources), '')
  assert.equal(weChatBodyImagesIssue('无图', []), '')
  for (const images of [[], sources.toReversed(), [{ ...sources[0], sizeBytes: 1_000_000 }, sources[1]], [{ ...sources[0], mime: 'image/gif' }, sources[1]], [{ ...sources[0], sizeBytes: 0 }, sources[1]]]) assert.ok(weChatBodyImagesIssue(description, images))
  assert.match(weChatBodyImagesIssue(Array.from({ length: 21 }, (_, index) => articleImageMarker('a' + index)).join(''), []), /20/)
  assert.ok(articleImageSyntaxIssue('[[image:../../bad]]'))
  for (const encoded of ['%', '%FF', '%0A', '%C0%AF']) assert.ok(articleImageSyntaxIssue('[[image:' + encoded + ']]'))
  const localId = 'file:media-desk/files/piece/image.png'
  assert.deepEqual(articleImageIds(articleImageMarker(localId)), [localId])
  const longIds = Array.from({ length: 20 }, (_, index) => `file:media-desk/files/${'a'.repeat(160)}/image-${index}.png`)
  const nearLimit = 'x'.repeat(17_000) + longIds.map(articleImageMarker).join('\n')
  assert.ok(nearLimit.length > 20_000)
  assert.equal(weChatCopyIssue({ title: '标题', description: nearLimit, topics: [] }), '')
  assert.ok(weChatCopyIssue({ title: '标题', description: '[[image:]]', topics: [] }))
  const html = weChatArticleHtml('<script>x</script>\n\n' + articleImageMarker('a'), new Map([['a', { url: imageUrl(1) + '&a=b', filename: '" onerror="bad' }]]))
  assert.equal(html, `<p>&lt;script&gt;x&lt;/script&gt;</p><p><img src="${imageUrl(1)}&amp;a=b" alt="&quot; onerror=&quot;bad"/></p>`)
  assert.throws(() => weChatArticleHtml(description, new Map()), /Missing/)
  assert.equal(weChatImageUrl('http://mmbiz.qpic.cn/mmbiz_png/abc/0?wx_fmt=png'), 'https://mmbiz.qpic.cn/mmbiz_png/abc/0?wx_fmt=png')
})

test('公众号上传正文图片失败或取消时关闭本地流，非法格式/大小不读文件', async () => {
  let stream, calls = 0
  const client = createWeChatClient({ clientId: appId, clientSecret: secret }, { fetchImpl: async url => {
    calls++
    if (url.pathname.endsWith('/stable_token')) return Response.json({ access_token: token, expires_in: 7200 })
    throw new Error(token)
  } })
  const source = { sizeBytes: 8, mime: 'image/png', stream: () => { stream = Readable.from([png]); return stream } }
  await assert.rejects(client.image(source), error => error.stage === 'upload' && !error.message.includes(token))
  assert.equal(stream.destroyed, true)
  const previous = calls
  await assert.rejects(client.image({ ...source, sizeBytes: 1_000_000, stream: () => assert.fail('Invalid file should not open') }), /1 MB/)
  assert.equal(calls, previous)
  await assert.rejects(client.image(source, AbortSignal.abort()), /取消/)
  assert.equal(stream.destroyed, true)
})
