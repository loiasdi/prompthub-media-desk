import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Store } from '../src/store.js'
import { ContentAssets } from '../src/content-assets.js'
import { coverPromptAction, coverImageAction } from '../src/cover-design.js'
import { generateCoverHttpImage } from '../src/cover-image-http.js'
import { sanitizeCoverDesign, emptyCoverDesign } from '../src/cover-design-schema.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'cover-design-'))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [{ id: 'piece', title: '稿件', body: '自拍视频动作素材' }] }, { undoable: false })
  const assets = new ContentAssets(store, { inspect: async () => ({ width: 1, height: 1 }) })
  try { await run({ store, assets }) } finally { await rm(root, { recursive: true, force: true }) }
}
function context(reply, captured) {
  return { get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'vision' }) }
    if (name === 'attachments') return { saveImage: async input => { captured.attachments = [...captured.attachments || [], input]; return { attachmentId: String(captured.attachments.length), mediaType: input.mediaType } } }
    if (name === 'llm') return { prepareCall: async () => ({ config: {}, async *stream(input) {
      captured.input = input
      const index = (captured.calls ??= []).push(input) - 1
      const result = typeof reply === 'function' ? reply(index) : reply
      yield { type: 'text-delta', text: typeof result === 'string' ? result : JSON.stringify(result) }
    } }) }
  } }
}

test('封面 Skill 使用真实参考图、固定标题与选中比例，提示词不直接覆盖草稿', () => fixture(async ({ store, assets }) => {
  let result = await assets.import('piece', Readable.from([PNG]), { name: '截图.png', revision: 0 })
  const design = emptyCoverDesign()
  design.title = '200+自拍动作素材上新'
  design.requirements = '不添加真人，文字居中'
  design.materialIds = [result.asset.id]
  design.ratios = ['3:4', '16:9', '4:3']
  const ws = await assets.save('piece', result.workspace.revision, { ...result.workspace, coverDesign: design })
  const captured = {}
  const variants = Object.fromEntries(design.ratios.map(r => [r, `${r} 封面，标题：${design.title}，奶油白背景与珊瑚橙文字。`]))
  const answer = await coverPromptAction(context({ variants }, captured), store, { assets }, { id: 'piece', revision: ws.revision })
  assert.deepEqual(answer.variants, variants)
  assert.ok(captured.input.system.includes('阿囤囤小红书封面 Skill'))
  assert.ok(captured.input.system.includes('用户明确的本次要求高于模板默认项'))
  assert.ok(captured.input.messages[0].content[0].text.includes('不添加真人，文字居中'))
  assert.equal(captured.input.messages[0].content[1].type, 'image')
  assert.deepEqual(Buffer.from(captured.attachments[0].data), PNG)
  assert.equal((await assets.read('piece')).coverDesign.variants['3:4'].prompt, '')
  const saved = await assets.save('piece', ws.revision, { ...ws, coverDesign: { ...design, variants: Object.fromEntries(design.ratios.map(r => [r, { prompt: variants[r], imageIds: [] }])) } })
  assert.deepEqual((await new ContentAssets(new Store(store.root)).read('piece')).coverDesign, saved.coverDesign)
}))

test('拒绝错误比例、改写标题、过期请求和不支持的参考图生图', () => fixture(async ({ store, assets }) => {
  const current = await assets.read('piece')
  const d = { ...emptyCoverDesign(), title: '固定标题', requirements: '不添加真人', ratios: ['3:4'] }
  let ws = await assets.save('piece', 0, { ...current, coverDesign: d })
  await assert.rejects(coverPromptAction(context({ variants: { '3:4': '3:4 新标题' } }, {}), store, { assets }, { id: 'piece', revision: ws.revision }), /未返回完整/)
  await assert.rejects(coverPromptAction(context({}, {}), store, { assets }, { id: 'piece', revision: 0 }), /其他窗口/)
  const result = await assets.import('piece', Readable.from([PNG]), { name: '人物.png', revision: ws.revision })
  d.personIds = [result.asset.id]
  d.variants['3:4'].prompt = '3:4 固定标题'
  ws = await assets.save('piece', result.workspace.revision, { ...result.workspace, coverDesign: d })
  await assert.rejects(coverImageAction(context({}, {}), store, { assets, settings: { read: async () => ({ image: { source: 'tool' } }) } }, { id: 'piece', revision: ws.revision, ratio: '3:4' }), /尚不支持参考图/)
  const titles = await coverPromptAction(context({ titles: ['自拍不重样', '200+自拍动作', '拍照直接抄'] }, {}), store, { assets }, { id: 'piece', revision: ws.revision, titles: true })
  assert.equal(titles.titles.length, 3)
}))

test('HTTP 生图实际上传参考图，并要求精确目标尺寸', async () => {
  const refs = [{ name: 'ref.png', mediaType: 'image/png', data: PNG }]
  let called
  const result = await generateCoverHttpImage({ baseUrl: 'https://example.com/v1', model: 'image', apiKey: 'test' }, '封面', refs, '16:9', async (url, request) => {
    called = { url, request }
    return Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
  })
  assert.equal(called.url, 'https://example.com/v1/images/edits')
  assert.equal(called.request.body.get('size'), '1536x864')
  assert.deepEqual(Buffer.from(await called.request.body.get('image[]').arrayBuffer()), PNG)
  assert.deepEqual(result.buffer, PNG)
})

test('封面成图使用保存的图片 API 与当前比例；图片链接下载后进入素材库', async t => fixture(async ({ store, assets }) => {
  const current = await assets.read('piece')
  const coverDesign = current.coverDesign
  coverDesign.variants['16:9'].prompt = '中间放白色标题，背景是橙色灯光。'
  const ws = await assets.save('piece', current.revision, { ...current, coverDesign })
  const image = { source: 'http', baseUrl: 'https://example.com', model: 'custom-image-model', apiKey: 'test-key', size: '1536x1024' }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options })
    if (options.method === 'POST') return Response.json({ data: [{ url: '/files/cover.png' }] })
    return new Response(PNG)
  })
  const ctx = { get() { throw new Error('不应调用 DSH 工具或文字模型') } }
  const result = await coverImageAction(ctx, store, { assets, settings: { read: async () => ({ image }) } }, { id: 'piece', revision: ws.revision, ratio: '16:9' })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://example.com/images/generations')
  assert.deepEqual(JSON.parse(requests[0].options.body), { model: image.model, prompt: `${coverDesign.variants['16:9'].prompt}\n严格 16:9 画幅，按目标画幅原生构图，不拉伸人物。`, n: 1, size: '1536x864' })
  assert.equal(requests[1].url, 'https://example.com/files/cover.png')
  assert.equal(requests[1].options.headers.authorization, 'Bearer test-key')
  assert.equal(requests[1].options.redirect, 'error')
  assert.equal(result.asset.type, 'image')
  assert.match(result.asset.name, /^cover-16x9-\d+\.png$/)
  assert.equal((await assets.read('piece')).assets.find(asset => asset.id === result.asset.id)?.coverResult, true)
}))

test('图片 API 不向异源图片地址转发密钥，不下载内网地址，失败不重复生图', async () => {
  const image = { baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'private-key' }
  let calls = 0
  await generateCoverHttpImage(image, '封面', [], '3:4', async (url, options) => {
    calls++
    if (options.method === 'POST') return Response.json({ images: [{ url: 'https://example.org/image.png' }] })
    assert.equal(String(url), 'https://example.org/image.png')
    assert.equal(options.headers, undefined)
    assert.equal(options.redirect, 'error')
    return new Response(PNG)
  })
  assert.equal(calls, 2)
  await assert.rejects(generateCoverHttpImage(image, '封面', [], '3:4', async (_url, options) => {
    assert.equal(options.method, 'POST')
    return Response.json({ data: [{ url: 'http://127.0.0.1/img.png' }] })
  }), /内网/)
  calls = 0
  await assert.rejects(generateCoverHttpImage(image, '封面', [], '3:4', async () => {
    calls++
    return Response.json({ error: { message: `size unsupported (${image.apiKey})` } }, { status: 400 })
  }), err => /size unsupported/.test(err.message) && !err.message.includes(image.apiKey))
  assert.equal(calls, 1)
})

test('封面数据按图片身份校验，隐藏素材与不存在的版本引用不保留', () => {
  const d = { ...emptyCoverDesign(), personIds: ['image', 'ref', 'missing'], materialIds: ['image', 'video', 'new-result'], colorIds: ['new-result', 'image', 'ref'], ratios: ['bad', '4:3'] }
  d.variants['4:3'] = { prompt: '独立横版提示词', imageIds: ['missing', 'image'] }
  const cleaned = sanitizeCoverDesign(d, [{ id: 'image', type: 'image' }, { id: 'ref', type: 'image' }, { id: 'new-result', type: 'image', coverResult: true }, { id: 'video', type: 'video' }])
  assert.deepEqual(cleaned.personIds, ['ref'])
  assert.deepEqual(cleaned.materialIds, [])
  assert.deepEqual(cleaned.colorIds, ['ref'])
  assert.deepEqual(cleaned.ratios, ['4:3'])
  assert.deepEqual(cleaned.variants['4:3'].imageIds, ['image'])
})

test('旧稿已误选的成图不会作为生成提示词的附件', () => fixture(async ({ store, assets }) => {
  const reference = await assets.import('piece', Readable.from([PNG]), { name: '参考.png', revision: 0 })
  const result = await assets.import('piece', Readable.from([PNG]), { name: '旧封面.png', revision: reference.workspace.revision })
  await store.mutate('', state => {
    const design = state.items[0].workspace.coverDesign
    design.ratios = ['4:3']
    design.variants['16:9'].imageIds = [result.asset.id]
    design.materialIds = [result.asset.id, reference.asset.id]
  }, { undoable: false })
  const captured = {}
  await coverPromptAction(context({ variants: { '4:3': '4:3 稿件，使用白色大标题。' } }, captured), store, { assets }, { id: 'piece', revision: result.workspace.revision })
  assert.deepEqual(captured.attachments.map(asset => asset.name), ['参考.png'])
  assert.deepEqual((await assets.read('piece')).coverDesign.variants['16:9'].imageIds, [result.asset.id])
}))

test('简化封面流程：只填标题即可生成三种比例，不强制人物分类与补充要求', () => fixture(async ({ store, assets }) => {
  const d = { ...emptyCoverDesign(), title: '自拍动作上新' }
  assert.deepEqual(d.ratios, ['3:4', '16:9', '4:3'])
  const current = await assets.read('piece')
  const ws = await assets.save('piece', current.revision, { ...current, coverDesign: d })
  const variants = Object.fromEntries(d.ratios.map(r => [r, `${r} 自拍动作上新，居中粗体标题、奶油白背景，不添加人物。`]))
  const captured = {}
  const answer = await coverPromptAction(context({ variants }, captured), store, { assets }, { id: 'piece', revision: ws.revision })
  assert.deepEqual(answer.variants, variants)
  assert.ok(captured.input.system.includes('不额外添加人物'))
}))

test('封面只生成文本，接受标题换行和画幅键，补做错误的比例而不重做有效版本', () => fixture(async ({ store, assets }) => {
  const title = 'AI 图看着廉价 问题在光上'
  const requirements = '生成提示词后，使用 ImageGen 按选定比例生成封面。'
  const current = await assets.read('piece')
  const ws = await assets.save('piece', current.revision, { ...current, coverDesign: { ...current.coverDesign, title, requirements } })
  const captured = {}
  const result = await coverPromptAction(context(index => index === 0 ? { variants: {
    '3:4': '超粗标题：AI 图看着廉价\n问题在光上，橙色文字居中。',
    '16:9': `16:9 横版，标题：${title}。`,
    '4:3': `3:4 竖版，标题：${title}。`,
  } } : { variants: { '4:3': `4：3 横版，标题：${title}。` } }, captured), store, { assets }, { id: 'piece', revision: ws.revision })
  assert.deepEqual(Object.keys(result.variants), ['3:4', '16:9', '4:3'])
  assert.ok(result.variants['3:4'].includes(`完整封面文字：${title}`))
  assert.ok(result.variants['3:4'].includes('AI 图看着廉价\n问题在光上'))
  assert.ok(result.variants['3:4'].startsWith('封面画幅：3:4'))
  assert.ok(result.variants['4:3'].startsWith('封面画幅：4:3'))
  assert.equal(captured.calls.length, 2)
  assert.match(captured.calls[0].system, /不生图、不调用工具、不追问/)
  assert.match(captured.calls[0].system, /"3:4":"完整提示词","16:9":"完整提示词","4:3":"完整提示词"/)
  assert.deepEqual(JSON.parse(captured.calls[1].messages[0].content[0].text).ratios, ['4:3'])
  assert.deepEqual(JSON.parse(captured.calls[1].messages[0].content[0].text).repair, [{ ratio: '4:3', reason: '提示词画幅不匹配' }])
}))

test('封面格式异常会补一次并返回明确原因，模型服务错误不重试', () => fixture(async ({ store, assets }) => {
  const current = await assets.read('piece')
  const ws = await assets.save('piece', current.revision, { ...current, coverDesign: { ...current.coverDesign, title: '[光影实验]', ratios: ['16:9'] } })
  const body = { id: 'piece', revision: ws.revision }
  const captured = {}
  const recovered = await coverPromptAction(context(index => index ? { variants: { '16:9': '标题：[光影实验]，白字黑描边。' } } : '```json\n{"variants":{\n```', captured), store, { assets }, body)
  assert.equal(recovered.variants['16:9'], '封面画幅：16:9\n标题：[光影实验]，白字黑描边。')
  assert.equal(captured.calls.length, 2)
  await assert.rejects(coverPromptAction(context('请先上传参考图', {}), store, { assets }, body), { status: 502, message: /16:9 · 模型没有返回有效 JSON/ })
  const serviceFailure = {}
  await assert.rejects(coverPromptAction(context(() => { throw new Error('模型服务不可用') }, serviceFailure), store, { assets }, body), /模型服务不可用/)
  assert.equal(serviceFailure.calls.length, 1)
}))

test('封面文字默认使用稿件标题，兼容已有空值并保留自定义封面文字', () => fixture(async ({ store, assets }) => {
  assert.equal((await assets.read('piece')).coverDesign.title, '稿件')
  const ws = await assets.read('piece')
  await assets.save('piece', ws.revision, { ...ws, coverDesign: { ...ws.coverDesign, title: '自定义封面' } })
  await store.mutate('', state => { state.items[0].production = { title: '正式标题' } }, { undoable: false })
  assert.equal((await assets.read('piece')).coverDesign.title, '自定义封面')
  await store.mutate('', state => { state.items[0].workspace.coverDesign.title = '' }, { undoable: false })
  assert.equal((await assets.read('piece')).coverDesign.title, '正式标题')
}))


test('正文配图兼容旧封面数据并保存独立提示词与成图关联', () => {
  assert.deepEqual(sanitizeCoverDesign({ title: '旧封面' }, []).illustrations, [])
  const result = sanitizeCoverDesign({ illustrations: [
    { id: 'pic-1', title: '三种角色对比', ratio: '16:9', requirements: '组合为一张图', prompt: '独立配图提示词', imageIds: ['img', 'video', 'missing'] },
    { id: 'pic-1', title: '重复' }, { id: '../bad' }, null,
  ] }, [{ id: 'img', type: 'image' }, { id: 'video', type: 'video' }])
  assert.deepEqual(result.illustrations, [{ id: 'pic-1', title: '三种角色对比', ratio: '16:9', requirements: '组合为一张图', prompt: '独立配图提示词', imageIds: ['img'] }])
  assert.deepEqual(sanitizeCoverDesign(result, [{ id: 'img', type: 'image' }]).illustrations, result.illustrations)
})
