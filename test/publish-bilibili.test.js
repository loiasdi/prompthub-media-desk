import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createBilibiliAdapter } from '../src/publish/bilibili/index.js'
import { signedHeaders } from '../src/publish/bilibili/client.js'
import { readBilibiliStatus } from '../src/publish/bilibili/publish.js'
import { withLocalUploadSource } from '../src/publish/local-source.js'

const config = { clientId: 'app-id', clientSecret: 'app-secret', redirectUri: 'http://127.0.0.1:4311/callback' }
const draft = { title: '首条视频', description: '简介', categoryId: 20, topics: ['创作', '创作', '测试'], copyright: 1 }
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }
const ok = data => Response.json({ code: 0, data })
const video = { filename: 'video.mp4', mime: 'video/mp4', sizeBytes: 1, stream: () => Readable.from([Buffer.from('x')]) }
const base = { accessToken: 'access-token', draft, video, beforeSubmit: async () => {} }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'md-bilibili-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function mockSubmit(overrides = {}) {
  const callPaths = []
  const fetchImpl = async (url, req) => {
    callPaths.push(url.pathname)
    if (Object.hasOwn(overrides, url.pathname)) return overrides[url.pathname](url, req)
    switch (url.pathname) {
      case '/arcopen/fn/archive/video/init': return ok({ upload_token: 'upload' })
      case '/video/v2/part/upload': await collect(req.body); return ok()
      case '/arcopen/fn/archive/video/complete': return ok()
      default: assert.fail(`Unexpected mock request: ${url.pathname}`)
    }
  }
  return { adapter: createBilibiliAdapter(config, { fetchImpl }), callPaths }
}

test('B 站签名固定向量：只签约定字段和实际 JSON 字节', () => {
  const actual = signedHeaders({ ...config, accessToken: 'token', body: '{}', timestamp: 1700000000, nonce: 'request-id' })
  const payload = 'x-bili-accesskeyid:app-id\nx-bili-content-md5:99914b932bd37a50b983c5e7c90ae93b\nx-bili-signature-method:HMAC-SHA256\nx-bili-signature-nonce:request-id\nx-bili-signature-version:2.0\nx-bili-timestamp:1700000000'
  assert.equal(actual.authorization, createHmac('sha256', 'app-secret').update(payload).digest('hex'))
  assert.equal(actual['access-token'], 'token')
})

test('B 站 OAuth、账号和分区只调用固定官方地址', async () => {
  const calls = []
  const adapter = createBilibiliAdapter(config, {
    now: () => 1700000000000,
    fetchImpl: async (url, req) => {
      calls.push([url, req])
      if (url.hostname === 'api.bilibili.com') return ok({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
      if (url.pathname.endsWith('/info')) return ok({ openid: 'account-1', name: '创作者' })
      return ok([{ id: 20 }])
    },
  })
  const authorization = new URL(adapter.authorizationUrl('state-token'))
  assert.equal(authorization.hostname, 'account.bilibili.com')
  assert.equal(authorization.searchParams.get('gourl'), config.redirectUri)
  assert.equal(authorization.searchParams.get('state'), 'state-token')
  assert.throws(() => createBilibiliAdapter({ ...config, redirectUri: 'http://example.com/callback' }).authorizationUrl('state'), { code: 'INVALID_OAUTH' })
  assert.deepEqual(await adapter.exchangeCode('oauth-code'), { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2023-11-14T23:13:20.000Z' })
  await adapter.refreshToken('old-refresh')
  assert.deepEqual(await adapter.account('access'), { openid: 'account-1', name: '创作者' })
  assert.deepEqual(await adapter.categories('access'), [{ id: 20 }])
  assert.deepEqual(calls.map(([url]) => url.host + url.pathname), [
    'api.bilibili.com/x/account-oauth2/v1/token', 'api.bilibili.com/x/account-oauth2/v1/refresh_token',
    'member.bilibili.com/arcopen/fn/user/account/info', 'member.bilibili.com/arcopen/fn/archive/type/list',
  ])
  assert.equal(calls[0][1].body.get('grant_type'), 'authorization_code')
  assert.equal(calls[1][1].body.get('refresh_token'), 'old-refresh')
  assert.ok(calls.every(([, req]) => req.redirect === 'error'))
})

test('B 站本地素材按区间上传：封面、检查点、投稿和审核顺序固定', async t => {
  const dir = await fixture(t)
  const videoPath = join(dir, 'video.mp4'), coverPath = join(dir, 'cover.jpg')
  await writeFile(videoPath, 'abcdefghij')
  await writeFile(coverPath, 'cover-test')
  const steps = []
  const adapter = createBilibiliAdapter(config, { chunkBytes: 4, fetchImpl: async (url, req) => {
    assert.equal(req.redirect, 'error')
    switch (url.pathname) {
      case '/arcopen/fn/archive/video/init':
        assert.equal(url.hostname, 'member.bilibili.com')
        steps.push('init')
        assert.deepEqual(JSON.parse(req.body), { name: '成片.mp4', utype: '0' })
        return ok({ upload_token: 'upload-token' })
      case '/video/v2/part/upload': {
        assert.equal(url.hostname, 'openupos.bilivideo.com')
        assert.equal(url.searchParams.get('upload_token'), 'upload-token')
        assert.equal(req.duplex, 'half')
        assert.equal(req.headers.authorization, undefined)
        assert.equal(req.headers['content-type'], 'application/octet-stream')
        const part = await collect(req.body)
        assert.equal(req.headers['content-length'], String(part.length))
        steps.push(`${url.searchParams.get('part_number')}:${part}`)
        return ok()
      }
      case '/arcopen/fn/archive/video/complete': steps.push('complete'); return ok()
      case '/arcopen/fn/archive/cover/upload': {
        steps.push('cover')
        assert.equal(req.headers['content-type'], undefined)
        const file = req.body.get('file')
        assert.equal(file.type, 'image/jpeg')
        assert.equal(await file.text(), 'cover-test')
        return ok({ url: 'https://i0.hdslb.com/cover.jpg' })
      }
      case '/arcopen/fn/archive/add-by-utoken':
        steps.push('submit')
        assert.equal(url.searchParams.get('upload_token'), 'upload-token')
        assert.deepEqual(JSON.parse(req.body), { title: '首条视频', tid: 20, tag: '创作,测试', copyright: 1, no_reprint: 0, desc: '简介', cover: 'https://i0.hdslb.com/cover.jpg' })
        return ok({ resource_id: 'upload-receipt' })
      case '/arcopen/fn/archive/view':
        steps.push('review')
        assert.equal(url.searchParams.get('resource_id'), 'upload-receipt')
        return ok({ resource_id: 'BV12345', addit_info: { state: 0 } })
      default: assert.fail(`Unsupported mock path: ${url.pathname}`)
    }
  } })
  const receipt = await withLocalUploadSource(dir, videoPath, { filename: '成片.mp4', mime: 'video/mp4' }, video =>
    withLocalUploadSource(dir, coverPath, { filename: '封面.jpg', mime: 'image/jpeg' }, cover =>
      adapter.submit({ ...base, video, cover, beforeSubmit: async () => { steps.push('checkpoint') } })))
  assert.deepEqual(receipt, { status: 'pending_review', receiptId: 'upload-receipt' })
  const result = await adapter.review({ accessToken: base.accessToken, receiptId: receipt.receiptId })
  assert.deepEqual(result, { status: 'published', platformState: 0, receiptId: 'upload-receipt', publicId: 'BV12345', url: 'https://www.bilibili.com/video/BV12345' })
  assert.deepEqual(steps, ['init', '1:abcd', '2:efgh', '3:ij', 'complete', 'cover', 'checkpoint', 'submit', 'review'])
})

test('没有检查点、转载来源或本地流时，不发起任何网络请求', async () => {
  const { adapter, callPaths } = mockSubmit()
  await assert.rejects(adapter.submit({ ...base, beforeSubmit: undefined }), /checkpoint/)
  await assert.rejects(adapter.submit({ ...base, draft: { ...draft, copyright: 2 } }), { code: 'INVALID_BILIBILI_DRAFT' })
  await assert.rejects(adapter.submit({ ...base, video: { url: 'https://example.com/video.mp4' } }), { code: 'INVALID_BILIBILI_DRAFT' })
  assert.deepEqual(callPaths, [])
})

test('持久检查点失败则不调用最终投稿接口', async () => {
  const { adapter, callPaths } = mockSubmit()
  await assert.rejects(adapter.submit({ ...base, beforeSubmit: async () => { throw new Error('disk failure') } }), /disk failure/)
  assert.ok(!callPaths.includes('/arcopen/fn/archive/add-by-utoken'))
})

test('提交响应不确定时不重发；平台明确拒绝时返回脱敏错误', async () => {
  const submitPath = '/arcopen/fn/archive/add-by-utoken'
  for (const submit of [() => { throw new Error('secret leak') }, () => ok({}), () => Response.json({ code: 99 }, { status: 503 })]) {
    const { adapter, callPaths } = mockSubmit({ [submitPath]: submit })
    await assert.rejects(adapter.submit(base), error => error.outcome === 'unknown' && error.stage === 'submit' && !error.message.includes('secret'))
    assert.equal(callPaths.filter(path => path === submitPath).length, 1)
  }
  const { adapter } = mockSubmit({ [submitPath]: () => Response.json({ code: '-403', message: 'raw secret leak' }) })
  await assert.rejects(adapter.submit(base), {
    code: 'BILIBILI_REJECTED', stage: 'submit', outcome: 'failed', platformCode: -403, httpStatus: 200,
    message: 'B 站拒绝了请求（代码 -403）',
  })
})

test('最终投稿的服务异常和未识别业务码一律先核对，不重投', async t => {
  const submitPath = '/arcopen/fn/archive/add-by-utoken'
  for (const [status, platformCode] of [[200, 4010], [200, '4011'], [200, 9999], [400, 9999], [503, -403]]) {
    await t.test(`HTTP ${status} / 业务码 ${platformCode}`, async () => {
      const { adapter, callPaths } = mockSubmit({
        [submitPath]: () => Response.json({ code: platformCode, message: 'raw secret leak' }, { status }),
      })
      await assert.rejects(adapter.submit(base), {
        code: 'BILIBILI_SUBMISSION_UNCONFIRMED', stage: 'submit', outcome: 'unknown',
        platformCode: Number(platformCode), httpStatus: status, message: '无法确认 B 站是否已接收稿件，请先核对作品',
      })
      assert.equal(callPaths.filter(path => path === submitPath).length, 1)
    })
  }
})

test('最终提交前的接口错误仍为明确失败，且不会调用投稿接口', async () => {
  const { adapter, callPaths } = mockSubmit({
    '/arcopen/fn/archive/video/complete': () => Response.json({ code: 4010 }),
  })
  await assert.rejects(adapter.submit(base), {
    code: 'BILIBILI_REJECTED', stage: 'upload_complete', outcome: 'failed', platformCode: 4010,
  })
  assert.ok(!callPaths.includes('/arcopen/fn/archive/add-by-utoken'))
})

test('待审、缺公开 ID、未知远端状态不标已发布', () => {
  assert.equal(readBilibiliStatus({ resource_id: 'BV12345', addit_info: { state: -1 } }, 'receipt').status, 'pending_review')
  assert.equal(readBilibiliStatus({ resource_id: 'not-a-public-id', addit_info: { state: 0 } }, 'receipt').status, 'pending_review')
  assert.equal(readBilibiliStatus({ resource_id: 'BV12345', addit_info: { state: -8 } }, 'receipt').status, 'unknown')
  assert.throws(() => readBilibiliStatus({ resource_id: 'BV12345' }, 'receipt'), { code: 'BILIBILI_INVALID_RESPONSE' })
})

test('本地数据源拒绝越界和符号链接，一次打开固定后续读取的文件', async t => {
  const root = await fixture(t), other = await fixture(t)
  const path = join(root, 'video'), outside = join(other, 'outside'), link = join(root, 'link')
  await writeFile(path, 'original')
  await writeFile(outside, 'outside')
  await symlink(path, link)
  const meta = { filename: 'video.mp4', mime: 'video/mp4' }
  await assert.rejects(withLocalUploadSource(root, outside, meta, assert.fail), { code: 'INVALID_LOCAL_MEDIA' })
  await assert.rejects(withLocalUploadSource(root, link, meta, assert.fail), { code: 'INVALID_LOCAL_MEDIA' })
  await withLocalUploadSource(root, path, meta, async source => {
    await rename(path, join(root, 'old-video'))
    await writeFile(path, 'replacement')
    assert.equal((await collect(source.stream())).toString(), 'original')
    assert.throws(() => source.stream({ start: 9 }), { code: 'INVALID_LOCAL_MEDIA' })
  })
})
