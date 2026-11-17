import { storedAssetPath, validAssetPath } from './asset-storage.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { callModel, extractJson } from './ai.js'
import { COVER_RATIOS } from './cover-design-schema.js'
import { ContentAssets } from './content-assets.js'
import { fail } from './workspace-schema.js'
import { imageBuffer, generateCoverHttpImage } from './cover-image-http.js'
import { generateToolImage } from './image-tool.js'

const skillFile = new URL('./skills/atutun-xhs-cover.md', import.meta.url)
const bundledAssets = new URL('../assets/', import.meta.url)

export async function coverReferences(store, ws) {
  const d = ws.coverDesign
  const rows = [...d.personIds.map(id => [id, '人物']), ...d.materialIds.map(id => [id, '参考素材（根据画面判断用途）']), ...d.colorIds.map(id => [id, '标题用色参考'])]
  const result = []
  for (const [id, role] of rows) {
    const asset = ws.assets.find(a => a.id === id && a.type === 'image' && !ws.hidden.includes(id))
    if (!asset) throw fail('封面参考图片不存在', 400)
    let root, name
    if (asset.src?.startsWith('media-desk/files/') && validAssetPath(asset.src.slice(17))) { root = store.root; name = relative(store.root, await storedAssetPath(store.filesDir, asset.src.slice(17))) }
    else if (/^media-desk\/assets\/[\w.-]+$/.test(asset.src)) { root = bundledAssets; name = asset.src.split('/').pop() }
    else throw fail('参考图需先导入素材库', 400)
    const base = await realpath(root)
    const path = await realpath(join(base, name))
    if (relative(base, path).startsWith('..')) throw fail('参考图片路径无效', 400)
    if ((await stat(path)).size > 10000000) throw fail('参考图过大，请压缩后再试', 400)
    const data = await readFile(path)
    if (data.length > 10000000 || result.reduce((n, r) => n + r.data.length, 0) + data.length > 20000000) throw fail('参考图过大，请压缩后再试', 400)
    const { ext } = imageBuffer(data)
    result.push({ name: asset.name, role, path, data, mediaType: ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}` })
  }
  return result
}

export async function coverPromptAction(ctx, store, desk, body) {
  const assets = desk.assets ??= new ContentAssets(store)
  const ws = await assets.read(body.id)
  if (ws.revision !== body.revision) throw fail('内容已在其他窗口更新，请重新加载后再保存', 409)
  const item = (await store.read()).items.find(row => row.id === body.id)
  const d = ws.coverDesign
  if (!body.titles && !d?.title?.trim()) throw fail('请先填写封面标题')
  const refs = await coverReferences(store, ws)
  const attachments = ctx.get?.('attachments')
  if (refs.length && typeof attachments?.saveImage !== 'function') throw fail('当前宿主不支持参考图片输入，可复制设计任务到支持图片的对话中使用')
  const images = []
  for (const ref of refs) images.push({ type: 'image', attachment: await attachments.saveImage({ data: ref.data, mediaType: ref.mediaType, name: ref.name }) })
  const skill = await readFile(skillFile, 'utf8')
  const ratios = COVER_RATIOS.filter(r => d.ratios.includes(r))
  if (!body.titles && !ratios.length) throw fail('请至少选择一个比例')
  if (body.titles) {
    const { text } = await callModel(ctx, { system: `${skill}\n五步信息已由表单收集。本次只根据素材和稿件提供三个候选封面标题，仅输出 JSON：{"titles":["标题1","标题2","标题3"]}。不要生成图片，不要追问。`, user: JSON.stringify({ description: item.production?.description || '', topics: item.production?.topics || '', article: (item.production?.article || item.body || item.title).slice(0, 20000), requirements: d.requirements, references: refs.map((r, i) => ({ number: i + 1, role: r.role, name: r.name })) }), images, maxTokens: 1500, signal: AbortSignal.timeout(90000) })
    const { titles } = extractJson(text)
    if (!Array.isArray(titles) || titles.length !== 3 || titles.some(title => typeof title !== 'string' || !title.trim() || title.length > 100)) throw fail('模型未返回三个有效标题，请重试', 502)
    return { titles }
  }
  const { text } = await callModel(ctx, {
    system: `${skill}\n\n当前为工作台设计任务，用户已提供参考图、标题与补充要求。未填的风格与用色由你具体决定；只有参考图中已出现的人物才可使用，不额外添加人物。用户明确的本次要求高于模板默认项，包括不添加真人、文字居中和指定多个比例。不要再次提问。为每个明确选中的比例重新设计构图。仅输出 JSON：{"variants":{"3:4":"完整提示词"}}，键仅包含用户选择的比例。标题必须原样出现。输出前执行 Skill 的内部复核；不要在最终提示词中留占位符。`,
    user: JSON.stringify({ title: d.title, style: d.style, colors: d.colors || '无固定用色', requirements: d.requirements, ratios, references: refs.map((r, i) => ({ number: i + 1, name: r.name, role: r.role })), description: item.production?.description || '', topics: item.production?.topics || '', article: (item.production?.article || item.body || '').slice(0, 20000) }),
    images, maxTokens: 10000, signal: AbortSignal.timeout(240000),
  })
  const parsed = extractJson(text)
  const variants = {}
  for (const ratio of ratios) {
    const prompt = parsed.variants?.[ratio]
    if (typeof prompt !== 'string' || prompt.length > 50000 || !prompt.includes(d.title) || !prompt.includes(ratio) || /由模型决定|待定|\[[^\]\n]+\]/.test(prompt)) throw fail('模型未返回完整封面提示词，请重试', 502)
    variants[ratio] = prompt
  }
  return { variants }
}

export async function coverImageAction(ctx, store, desk, body) {
  const assets = desk.assets ??= new ContentAssets(store)
  const ws = await assets.read(body.id)
  if (ws.revision !== body.revision) throw fail('内容已在其他窗口更新，请重新加载后再保存', 409)
  if (!COVER_RATIOS.includes(body.ratio)) throw fail('封面比例无效')
  const savedPrompt = ws.coverDesign?.variants[body.ratio]?.prompt
  const prompt = savedPrompt?.trim() ? `${savedPrompt}\n严格 ${body.ratio} 画幅，按目标画幅原生构图，不拉伸人物。` : ''
  if (!prompt?.trim()) throw fail('请先生成或填写当前比例的提示词')
  const refs = await coverReferences(store, ws)
  const settings = await desk.settings.read()
  let result
  if (settings.image.source === 'tool') {
    if (refs.length) throw fail('当前 DSH 生图接入尚不支持参考图，请使用支持图片编辑的 HTTP 接口，或复制任务到 ImageGen 对话中生成')
    result = await generateToolImage(ctx, { ...settings.image, toolSize: 'auto' }, prompt)
  } else result = await generateCoverHttpImage(settings.image, prompt, refs, body.ratio)
  const checked = imageBuffer(result.buffer)
  return assets.import(body.id, Readable.from([checked.buffer]), { name: `cover-${body.ratio.replace(':', 'x')}-${Date.now()}${checked.ext}`, revision: body.revision })
}
