import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { generateCoverImages } from '../client/cover-generation.js'
import { createWorkspaceStore } from '../client/workspace-store.js'
import { createWorkspaceDraft, resolveWorkspaceDraft, patchWorkspaceDraft } from '../client/workspace.js'
import { Store } from '../src/store.js'
import { ContentAssets } from '../src/content-assets.js'
import { generateCoverHttpImage } from '../src/cover-image-http.js'
import { COVER_RATIOS } from '../src/cover-design-schema.js'
import { route } from '../src/host.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
async function fixture(t, { legacy = false, failingSizes = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cover-generation-http-'))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '标题', body: '正文' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ width: 1, height: 1 }) })
  let ws = await assets.read('piece')
  for (const ratio of COVER_RATIOS) {
    ws = (await assets.import('piece', Readable.from([PNG]), { revision: ws.revision, name: `old-${ratio.replace(':', 'x')}.png`, coverRatio: ratio })).workspace
  }
  for (const ratio of COVER_RATIOS) ws.coverDesign.variants[ratio].prompt = `${ratio} 封面提示词`
  ws = await assets.save('piece', ws.revision, ws)
  const previous = ws.assets.map(asset => asset.id)
  const desk = { assets, settings: { read: async () => ({ image: { source: 'http', baseUrl: 'https://example.com', model: 'image', apiKey: 'test' } }) } }
  const payloads = [], sizes = []
  const nativeFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { size } = JSON.parse(options.body)
    sizes.push(size)
    return failingSizes.includes(size) ? Response.json({ error: { message: '模型服务暂不可用' } }, { status: 503 }) : Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
  })
  const server = createServer(async (req, res) => {
    try {
      if (legacy && req.url.endsWith('/cover/image')) {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        // 旧 Host 只导入文件，不写当前成图关联；不能借用新版 coverImageAction。
        if (!COVER_RATIOS.includes(body.ratio)) throw Object.assign(new Error('封面比例无效'), { status: 400 })
        const before = await assets.read(body.id)
        if (before.revision !== body.revision) throw Object.assign(new Error('修订冲突'), { status: 409 })
        const image = await generateCoverHttpImage((await desk.settings.read()).image, before.coverDesign.variants[body.ratio].prompt, [], body.ratio)
        const { workspace, asset } = await assets.import(body.id, Readable.from([image.buffer]), { name: `cover-${body.ratio.replace(':', 'x')}-${Date.now()}.png`, revision: body.revision, coverResult: true })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ workspace, asset }))
      } else await route({}, store, desk, req, res)
    } catch (error) { res.writeHead(error.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const content = { ...(await store.read()).items[0] }
  const frontend = createWorkspaceStore({ create: createWorkspaceDraft, resolve: resolveWorkspaceDraft, patch: patchWorkspaceDraft, api: async (path, body) => {
    if (path === 'cover/image') payloads.push(body)
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/media-desk/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status })
    return data
  } })
  frontend.get(content)
  const request = body => frontend.action('piece', 'cover/image', body)
  const generate = ratios => generateCoverImages(ratios, request, { onResult: async result => {
    frontend.update(content, draft => ({ coverDesign: { ...draft.coverDesign, variants: { ...draft.coverDesign.variants, ...Object.fromEntries(result.results.map(row => [row.ratio, { ...draft.coverDesign.variants[row.ratio], imageIds: [row.asset.id] }])) } } }))
    await frontend.flush(content.id)
  } })
  return { assets, content, frontend, payloads, sizes, previous, revision: ws.revision, request, generate }
}

for (const legacy of [false, true]) {
  test(`单张重新生成通过真实 HTTP ${legacy ? '旧' : '当前'}接口，保留旧图并归一化结果`, async t => {
    const f = await fixture(t, { legacy })
    const result = await f.generate(['16:9'])
    assert.equal(f.payloads.length, 1)
    assert.equal(f.payloads[0].ratio, '16:9')
    assert.equal(f.payloads[0].ratios, undefined)
    assert.deepEqual(f.sizes, ['1536x864'])
    assert.equal(result.results[0].ratio, '16:9')
    assert.deepEqual(result.errors, [])
    const reopened = await f.assets.read('piece')
    assert.equal(reopened.assets.length, 4)
    assert.ok(f.previous.every(id => reopened.assets.some(asset => asset.id === id)))
    assert.deepEqual(reopened.coverDesign.variants['16:9'].imageIds, [result.results[0].asset.id])
    assert.equal(f.frontend.get(f.content).draft.revision, reopened.revision)
  })
}

test('三张重新生成走当前批量接口，每种比例只调用一次，原图保留', async t => {
  const f = await fixture(t)
  const result = await f.generate(COVER_RATIOS)
  assert.equal(f.payloads.length, 1)
  assert.deepEqual(f.payloads[0].ratios, COVER_RATIOS)
  assert.deepEqual(result.results.map(row => row.ratio), COVER_RATIOS)
  assert.equal(f.sizes.length, 3)
  assert.equal((await f.assets.read('piece')).assets.length, 6)
})

const generated = ratio => ({ ratio, asset: { id: `new-${ratio}`, type: 'image', src: `new-${ratio}.png` } })
const legacyError = () => Object.assign(new Error('封面比例无效'), { status: 400 })

test('异常成功响应不能显示成功、清除旧关联或触发付费降级', async () => {
  for (const result of [undefined, null, {}, { asset: {} }, { asset: generated('3:4').asset, results: null }, { results: [] }, { results: [], errors: [] },
    { results: [generated('16:9')] }, { results: [generated('3:4'), generated('3:4')] },
    { results: [generated('3:4')], errors: [{ ratio: '3:4', error: '重复结果' }] }]) {
    let calls = 0, accepted = 0
    await assert.rejects(generateCoverImages(['3:4'], async () => { calls++; return result }, { onResult: () => { accepted++ } }), /响应不完整/)
    assert.equal(calls, 1)
    assert.equal(accepted, 0)
  }
  let calls = 0
  await assert.rejects(generateCoverImages(COVER_RATIOS, async () => { calls++; return { results: [generated('3:4')], errors: [] } }), /响应不完整/)
  assert.equal(calls, 1)
  await assert.rejects(generateCoverImages(COVER_RATIOS, async () => ({ results: COVER_RATIOS.map(ratio => ({ ratio, asset: generated('3:4').asset })) })), /响应不完整/)
})

test('成功 HTTP 响应包含全部失败时仍报错，不误报生成成功', async () => {
  let accepted = false
  await assert.rejects(generateCoverImages(COVER_RATIOS, async () => ({ results: [], errors: COVER_RATIOS.map(ratio => ({ ratio, error: '模型失败' })) }), { onResult: () => { accepted = true } }), /3:4：模型失败/)
  assert.equal(accepted, false)
})

test('旧接口每张先处理成功结果，随后断网或冲突时停止且保留成功结果', async () => {
  for (const failure of [new TypeError('断网'), Object.assign(new Error('修订冲突'), { status: 409 }), Object.assign(new Error('磁盘已满'), { status: 507 }), Object.assign(new Error('登录已失效'), { status: 401 })]) {
    const calls = [], accepted = []
    const result = await generateCoverImages(COVER_RATIOS, async body => {
      calls.push(body)
      if (body.ratios) throw legacyError()
      if (body.ratio === '3:4') return { asset: generated('3:4').asset }
      assert.deepEqual(accepted, ['3:4'])
      throw failure
    }, { onResult: result => { accepted.push(...result.results.map(row => row.ratio)) } })
    assert.equal(calls.length, 3)
    assert.deepEqual(result.results.map(row => row.ratio), ['3:4'])
    assert.deepEqual(result.errors.map(row => row.ratio), ['16:9', '4:3'])
    assert.equal(result.errors[0].error, failure.message)
    assert.match(result.errors[1].error, /已停止后续生成/)
  }
})

test('结果已入库但关联保存失败时停止，保存错误不作为模型失败重试', async () => {
  const calls = []
  const failure = Object.assign(new Error('封面比例无效'), { status: 400 })
  await assert.rejects(generateCoverImages(COVER_RATIOS, async body => {
    calls.push(body)
    if (body.ratios) throw legacyError()
    return { asset: generated(body.ratio).asset }
  }, { onResult: () => { throw failure } }), error => error === failure)
  assert.equal(calls.length, 2)
  let modernCalls = 0
  await assert.rejects(generateCoverImages(COVER_RATIOS, async () => { modernCalls++; return { results: COVER_RATIOS.map(generated) } }, { onResult: () => { throw failure } }), error => error === failure)
  assert.equal(modernCalls, 1)
})

test('旧 Host 明确拒绝数组后按单张接口依次生成，修订递增且不重复生图', async t => {
  const f = await fixture(t, { legacy: true })
  const result = await f.generate(COVER_RATIOS)
  assert.equal(f.payloads.length, 4)
  assert.deepEqual(f.payloads[0].ratios, COVER_RATIOS)
  assert.deepEqual(f.payloads.slice(1).map(body => body.ratio), COVER_RATIOS)
  assert.deepEqual(f.payloads.slice(1).map(body => body.revision), [f.revision, f.revision + 2, f.revision + 4])
  assert.equal(f.sizes.length, 3, '数组校验失败发生在生图前，不会多扣一次')
  assert.deepEqual(result.results.map(row => row.ratio), COVER_RATIOS)
  assert.equal((await f.assets.read('piece')).assets.length, 6)
})

test('旧 Host 部分比例失败仍保留成功图，失败比例保持原图且不重试模型', async t => {
  const f = await fixture(t, { legacy: true, failingSizes: ['1536x864'] })
  const before = (await f.assets.read('piece')).coverDesign.variants['16:9'].imageIds
  const result = await f.generate(COVER_RATIOS)
  assert.deepEqual(result.results.map(row => row.ratio), ['3:4', '4:3'])
  assert.deepEqual(result.errors.map(row => row.ratio), ['16:9'])
  assert.match(result.errors[0].error, /模型服务暂不可用/)
  assert.equal(f.sizes.length, 3)
  assert.deepEqual((await f.assets.read('piece')).coverDesign.variants['16:9'].imageIds, before)
})

test('网络、上游、冲突及无效输入不触发兼容降级或重复请求', async () => {
  for (const error of [new Error('网络连接失败'), Object.assign(new Error('封面比例无效'), { status: 502 }), Object.assign(new Error('修订冲突'), { status: 409 }), Object.assign(new Error('模型服务暂不可用'), { status: 400 })]) {
    let calls = 0
    await assert.rejects(generateCoverImages(COVER_RATIOS, async () => { calls++; throw error }), thrown => thrown === error)
    assert.equal(calls, 1)
  }
  for (const ratios of [undefined, null, '3:4', [], Array(1), ['3:4', '3:4'], ['1:1', '3:4'], [...COVER_RATIOS, '3:4']]) {
    let calls = 0
    await assert.rejects(generateCoverImages(ratios, async () => { calls++; throw Object.assign(new Error('封面比例无效'), { status: 400 }) }), /封面比例无效/)
    assert.equal(calls, 0)
  }
})
