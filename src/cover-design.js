import { storedAssetPath, validAssetPath } from './asset-storage.js'
import { assertUploadRoot } from './asset-upload.js'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { callModel, extractJson } from './ai.js'
import { COVER_RATIOS } from './cover-design-schema.js'
import { ContentAssets } from './content-assets.js'
import { fail } from './workspace-schema.js'
import { tr } from './i18n.js'
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

const compact = value => value.replace(/\s+/g, '')

function checkCoverPrompt(value, title, ratio) {
  if (typeof value !== 'string' || !value.trim()) return { reason: '缺少提示词' }
  const prompt = value.trim()
  const exactTitle = prompt.includes(title)
  if (!exactTitle && !compact(prompt).includes(compact(title))) return { reason: '封面标题未原样保留' }
  // 标题里的方括号或「待定」是用户文字，不当成模板占位符。
  const withoutTitle = (exactTitle ? prompt.replaceAll(title, '') : compact(prompt).replaceAll(compact(title), ''))
  if (/由模型决定|待定|\[[^\]\n]+\]/.test(withoutTitle)) return { reason: '提示词仍有模板占位符' }
  // JSON 的键标识版本，不要求正文重复同样的 ASCII 画幅字样；存档时补齐画幅与原始标题。
  // 如果正文明确写成了另一个支持的画幅，不用加前缀来掩盖冲突。
  const ratios = new Set(withoutTitle.match(/(?<!\d)(?:3\s*[:：]\s*4|4\s*[:：]\s*3|16\s*[:：]\s*9)(?!\d)/g)?.map(value => compact(value).replace('：', ':')) || [])
  if (ratios.size && !ratios.has(ratio)) return { reason: '提示词画幅不匹配' }
  const normalized = [ratios.has(ratio) && withoutTitle.includes(ratio) ? '' : `封面画幅：${ratio}`, exactTitle ? '' : `完整封面文字：${title}`, prompt].filter(Boolean).join('\n')
  return normalized.length > 50000 ? { reason: '提示词过长' } : { prompt: normalized }
}

export async function coverPromptAction(ctx, store, desk, body) {
  const assets = desk.assets ??= new ContentAssets(store)
  const ws = await assets.read(body.id)
  if (ws.revision !== body.revision) throw fail('工作区版本已更新，请合并或重新加载后再保存', 409)
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
  const title = d.title.trim()
  const brief = { title, style: d.style, colors: d.colors || '无固定用色', requirements: d.requirements, references: refs.map((r, i) => ({ number: i + 1, name: r.name, role: r.role })), description: item.production?.description || '', topics: item.production?.topics || '', article: (item.production?.article || item.body || '').slice(0, 20000) }
  const signal = AbortSignal.timeout(240000)
  const variants = {}
  let pending = ratios
  let problems = []
  // 一版不合格只补做这一版，模型服务本身报错则原样返回，不盲目重试。
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const schema = JSON.stringify({ variants: Object.fromEntries(pending.map(ratio => [ratio, '完整提示词'])) })
    const contract = `本次是工作台的非交互式「生成封面提示词」步骤。只写提示词，不生图、不调用工具、不追问，不输出 Markdown 或说明。即使补充要求里提到生图工具或接口，实际出图也由工作台在下一步处理。封面标题不可改写或翻译。只返回合法 JSON，包含下列全部且仅这些画幅键，值均为完整的提示词字符串：${schema}`
    let text
    try {
      ({ text } = await callModel(ctx, {
        system: `${contract}\n\n${skill}\n\n${contract}\n五步信息已由表单收集。未填的风格与用色由你具体决定；只有参考图中已出现的人物才可使用，不额外添加人物。用户明确的本次要求高于模板默认项（但不改变当前步骤和输出格式）。为每个选中比例独立构图，使用指定画幅，保留完整标题的文字和标点。输出前执行 Skill 的内部复核，不留占位符。`,
        user: JSON.stringify({ ...brief, ratios: pending, ...(attempt ? { repair: problems } : {}) }),
        images, maxTokens: 1500 + pending.length * 1500, signal,
      }))
    } catch (err) {
      if (signal.aborted) throw fail(tr('生成封面提示词超时，请先尝试只选一个比例'), 504)
      throw err
    }
    let parsed
    try { parsed = extractJson(text) }
    catch {
      problems = pending.map(ratio => ({ ratio, reason: '模型没有返回有效 JSON' }))
      continue
    }
    problems = []
    for (const ratio of pending) {
      const result = checkCoverPrompt(parsed?.variants?.[ratio], title, ratio)
      if (result.reason) problems.push({ ratio, reason: result.reason })
      else variants[ratio] = result.prompt
    }
    pending = problems.map(({ ratio }) => ratio)
  }
  if (pending.length) {
    const details = problems.map(({ ratio, reason }) => `${ratio} · ${tr(reason)}`).join(' / ')
    throw fail(tr('模型未返回完整封面提示词（{details}）。可只选一个比例重试，或复制到 Skill 对话。', { details }), 502)
  }
  return { variants: Object.fromEntries(ratios.map(ratio => [ratio, variants[ratio]])) }
}

export async function coverImageAction(ctx, store, desk, body) {
  const assets = desk.assets ??= new ContentAssets(store)
  const root = store.root
  const ws = await assets.read(body.id)
  assertUploadRoot(store, root)
  if (ws.revision !== body.revision) throw fail('工作区版本已更新，请合并或重新加载后再保存', 409)
  const ratios = body.ratios === undefined ? [body.ratio] : body.ratios
  if (!Array.isArray(ratios) || !ratios.length || ratios.length > COVER_RATIOS.length || new Set(ratios).size !== ratios.length || ratios.some(ratio => !COVER_RATIOS.includes(ratio))) throw fail('封面比例无效')
  const prompts = ratios.map(ratio => {
    const savedPrompt = ws.coverDesign?.variants[ratio]?.prompt
    if (!savedPrompt?.trim()) throw fail(`${ratio}：${tr('请先生成或填写当前比例的提示词')}`)
    return `${savedPrompt}\n严格 ${ratio} 画幅，按目标画幅原生构图，不拉伸人物。`
  })
  const refs = await coverReferences(store, ws)
  const settings = await desk.settings.read()
  assertUploadRoot(store, root)
  if (settings.image.source === 'tool' && refs.length) throw fail('当前 DSH 生图接入尚不支持参考图，请在 API 设置选择支持图片编辑的图片 API')
  const generated = await Promise.allSettled(ratios.map(async (ratio, index) => {
    const result = settings.image.source === 'tool'
      ? await generateToolImage(ctx, { ...settings.image, toolSize: 'auto' }, prompts[index])
      : await generateCoverHttpImage(settings.image, prompts[index], refs, ratio)
    return imageBuffer(result.buffer)
  }))
  let workspace = ws
  const results = [], errors = []
  for (const [index, result] of generated.entries()) {
    const ratio = ratios[index]
    try {
      if (result.status === 'rejected') throw result.reason
      const checked = result.value
      assertUploadRoot(store, root)
      const saved = await assets.import(body.id, Readable.from([checked.buffer]), { name: `cover-${ratio.replace(':', 'x')}-${Date.now()}${checked.ext}`, revision: workspace.revision, coverRatio: ratio, mergeCoverResult: true })
      workspace = saved.workspace
      results.push({ ratio, asset: saved.asset })
    } catch (error) {
      if (ratios.length === 1) throw error
      errors.push({ ratio, error: error.message })
    }
  }
  if (!results.length) throw fail(errors.map(row => `${row.ratio}：${row.error}`).join('\n'), 502)
  return { workspace, results, errors, ...(ratios.length === 1 ? { asset: results[0].asset } : {}) }
}
