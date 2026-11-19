import { parseSharedLink, sourceKind } from './inspiration-source.js'
import { PACKAGE_NAME } from './brand.js'
import { openStorage, relocateStorage } from './storage-management.js'
import { FeishuSync } from './feishu/sync.js'
import { storedAssetPath, validAssetPath } from './asset-storage.js'
import { assertUploadRoot, withAssetUpload } from './asset-upload.js'
import { coverPromptAction, coverImageAction } from './cover-design.js'
// PromptHub MediaDesk host 半片：/media-desk/* 接口、文件服务和模型调用。
import { createReadStream, createWriteStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { assistantModelOverride, callModel, chatPrompts, defaultSelection, extractJson, modelInfo, modelStatus, setAssistantModel } from './ai.js'
import { defaultExportDir, resolveExportDir, saveProduction } from './export.js'
import { harvest, harvestText } from './harvest.js'
import { generateImage } from './images.js'
import { generateToolImage, imageTool } from './image-tool.js'
import { localIntent } from './intents.js'
import { computeInsights, exportSkill, proposeRules } from './learn.js'
import { createMonidRunner, fetchAccount, importPosts, monidStatus, postsToMaterial, resolveAccount, saveCovers } from './monid.js'
import { applyOps, newId } from './ops.js'
import { applyRevision, Producer } from './produce.js'
import { publicSettings, Settings, imageReady } from './settings.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { dshHome, Store } from './store.js'
import { currentLang, platformName, tr, withLang } from './i18n.js'
import { localizeSamples, samplesNeedLocale } from './seed.js'
import { ContentAssets, MEDIA_MIME } from './content-assets.js'
import { Publishing } from './publish/service.js'
import { PublishError } from './publish/errors.js'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const MAX_JSON = 4_000_000
const MIME = MEDIA_MIME
const UPLOAD_EXT = Object.fromEntries(Object.entries(MIME).filter(([ext, type]) => ext !== '.jpeg' && !type.startsWith('audio/')).map(([ext, type]) => [type, ext]))

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBuffer(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error(tr('内容太大')), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = await readBuffer(req, MAX_JSON)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error(tr('请求不是有效的 JSON')), { status: 400 })
  }
}

/** 支持 Range，视频才能正常拖动和循环。 */
async function sendFile(req, res, file) {
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return json(res, 404, { error: tr('不支持的文件类型') })
  let info
  try {
    info = await stat(file)
  } catch {
    return json(res, 404, { error: tr('文件不存在') })
  }
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.setHeader('x-content-type-options', 'nosniff')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    if (req.method === 'HEAD') return res.end()
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  return createReadStream(file).pipe(res)
}

function engineLabel(ctx) {
  const info = modelInfo(ctx)
  return info ? info.label : null
}

/** 同一次故障只提醒一次，用人话说。原始错误放在模型状态的提示里。 */
function outageNotice(ctx, wasDown, fallback) {
  if (wasDown) return null
  return modelInfo(ctx) ? tr('模型暂时用不了，{fallback}。可以到设置里检查账号或密钥。', { fallback }) : tr('当前没有连接模型，{fallback}。', { fallback })
}

async function chatTurn(ctx, store, desk, body) {
  const message = String(body.message || '').trim()
  if (!message) throw Object.assign(new Error(tr('消息为空')), { status: 400 })
  const focusId = typeof body.focusId === 'string' ? body.focusId : undefined
  const stage = ['idea', 'outline', 'article'].includes(body.stage) ? body.stage : undefined
  const state = await store.read()
  const snapshot = JSON.parse(JSON.stringify(state))
  let plan
  let engine = 'local'
  let notice = null
  const wasDown = modelStatus.ok === false
  try {
    const history = snapshot.chat.filter(row => (row.itemId ?? null) === (focusId ?? null))
    const { system, user } = chatPrompts(snapshot, message, { focusId, stage, history })
    const editing = snapshot.items.find(row => row.id === focusId)?.production?.status === 'done'
    const { text, model } = await callModel(ctx, { system, user, maxTokens: editing || stage ? 8000 : 2000, light: true, signal: AbortSignal.timeout(editing ? 240_000 : 90_000) })
    engine = model
    try {
      plan = extractJson(text)
      if (typeof plan.reply !== 'string') plan.reply = tr('处理好了。')
    } catch {
      // 模型只回了一段话时，当成普通回答，不算失败
      plan = { reply: text.trim().slice(0, 1200) || tr('我没有听懂，可以换个说法吗？'), ops: [] }
    }
  } catch {
    notice = outageNotice(ctx, wasDown, tr('先用本地规则处理'))
    plan = stage ? { reply: tr('当前模型不可用，无法继续创作讨论。请在设置中连接模型后重试；你的灵感、大纲和稿件已保留。'), ops: [], actions: [] } : localIntent(snapshot, message, { focusId })
  }
  const settings = await desk.settings.read()
  const canDraw = desk.producer.ready(settings)
  // 只把真正改了数据的那一步放进撤销；问一句话不占撤销位
  const changed = await store.mutate(tr('对话：{text}', { text: message.slice(0, 18) }), (draft) => {
    const target = focusId ? draft.items.find(row => row.id === focusId) : null
    const production = target?.production?.status === 'done' ? target.production : null
    // 本地规则只会改灵感标题；有成稿时要改的是成稿标题
    const ops = (Array.isArray(plan.ops) ? plan.ops : []).filter(op => !stage || op && ['update_planning', 'update_production'].includes(op.op) && op.id === focusId).map((op) => {
      if (op?.op === 'update_planning' && op.id === focusId) return { ...op, revision: snapshot.items.find(row => row.id === focusId)?.workspace?.revision || 0 }
      if (production && op?.op === 'update_item' && op.id === focusId && typeof op.title === 'string') return { op: 'update_production', id: focusId, title: op.title }
      return op
    })
    const { receipts, errors } = applyOps(draft, ops)
    let targets = []
    if (production && plan.revise) {
      // 没接生图时，图不会重画，回执要说实话
      const revision = applyRevision(production, stage ? Object.fromEntries(Object.entries(plan.revise).filter(([key]) => ['title', 'description', 'topics', 'article', 'edits'].includes(key))) : plan.revise, { canDraw: !stage && canDraw })
      receipts.push(...revision.receipts.map(text => ({ text })))
      errors.push(...revision.errors)
      targets = canDraw ? revision.targets : []
    }
    return { receipts, errors, targets, done: Boolean(production) }
  })
  const result = await store.mutate('对话记录', (draft) => {
    const { receipts, errors, targets, done } = changed
    const at = new Date().toISOString()
    const itemId = focusId ?? undefined
    // 已经做好的成稿不会因为一句话被整篇重做，要重做请点「重新成稿」
    const actions = (Array.isArray(plan.actions) ? plan.actions : [])
      .filter(a => !stage && a && ['produce', 'open', 'nav'].includes(a.type))
      .filter(a => !(a.type === 'produce' && (done && a.id === focusId || draft.items.find(row => row.id === a.id)?.production?.status === 'done')))
    draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId })
    const answer = { id: newId('c'), at, role: 'assistant', text: plan.reply, receipts, errors, engine, notice, undoable: receipts.length > 0, itemId }
    draft.chat.push(answer)
    draft.chat = draft.chat.slice(-300)
    return { answer, actions, targets, state: draft, modelOk: modelStatus.ok, modelError: modelStatus.error }
  }, { undoable: false })
  if (canDraw) {
    await Promise.all(result.targets.map(target => desk.producer.regenerate(focusId, target).catch(() => {})))
    return { ...result, state: await store.read() }
  }
  return result
}

async function extractStyle(ctx, store, body) {
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(row => String(row).trim()).filter(Boolean).slice(0, 5)
  const parts = [String(body.text ?? '').trim()].filter(Boolean)
  const failures = []
  for (const url of urls) {
    try {
      const page = await harvestText(url)
      if (page.text.length >= 80) parts.push(`${page.title ?? ''}\n${page.text}`)
      else failures.push(tr('{url}：页面上几乎没有文字，可能需要登录', { url }))
    } catch (err) {
      failures.push(tr('{url}：{error}', { url, error: err.message }))
    }
  }
  const material = parts.join('\n\n---\n\n')
  if (material.length < 80) {
    throw Object.assign(new Error(failures.length ? tr('抓不到内容。{reason}。可以把内容直接贴进来。', { reason: failures[0] }) : tr('内容太少了，至少贴一段完整的文字')), { status: 400 })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
  const source = urls.length && parts.length === urls.length ? tr('链接') : urls.length ? tr('内容和链接') : tr('内容')
  return styleFromMaterial(ctx, store, { material, name, source, sourceUrls: urls, failures })
}

/** 提炼一张风格卡并设为当前风格。同一个账号再抓一次时更新原来那张。 */
async function styleFromMaterial(ctx, store, { material, name, source, sourceUrls = [], failures = [], accountKey = null }) {
  let style
  try {
    const { system, user } = stylePrompts(material, name)
    const { text } = await callModel(ctx, { system, user, maxTokens: 1500, light: true, signal: AbortSignal.timeout(120_000) })
    style = normalizeStyle(extractJson(text), name)
  } catch (err) {
    throw Object.assign(new Error(tr('提炼风格需要文字模型：{error}', { error: err.message })), { status: 502 })
  }
  return store.mutate(tr('提炼风格「{name}」', { name: style.name }), (draft) => {
    const existing = accountKey ? (draft.styles ?? []).find(row => row.accountKey === accountKey) : null
    const id = existing?.id ?? newId('st')
    const row = { id, ...style, source, sourceUrls, ...(accountKey ? { accountKey } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() }
    draft.styles = existing ? draft.styles.map(entry => (entry.id === id ? row : entry)) : [row, ...(draft.styles ?? [])]
    draft.activeStyleId = id
    return { id, failures, state: draft }
  })
}

/** 导入用户自己的账号。钱花在 Monid 上，所以先把内容存好，提炼失败也不会白花。 */
async function importAccountRoute(ctx, store, desk, body) {
  if (desk.importing) throw Object.assign(new Error(tr('上一个账号还在导入，等它结束再试')), { status: 409 })
  desk.importing = true
  try {
    const account = await resolveAccount(body.text)
    const { posts, profile, cost } = await fetchAccount(account, desk.monid)
    const covers = await saveCovers(posts, account.platform, await store.read(), store.filesDir)
    const added = await store.mutate(tr('导入{platform}账号', { platform: platformName(account.platform) }), draft => importPosts(draft, { account, profile, posts, covers }).added)
    const nickname = profile.nickname || platformName(account.platform)
    let styleError = null
    const material = postsToMaterial(posts)
    if (material.length >= 80) {
      try {
        await styleFromMaterial(ctx, store, { material, name: nickname, source: tr('{platform}账号', { platform: platformName(account.platform) }), sourceUrls: [account.url], accountKey: `${account.platform}:${account.id}` })
      } catch (err) {
        styleError = err.message
      }
    } else {
      styleError = tr('这个账号的文字太少，提炼不出风格')
    }
    return { platform: account.platform, nickname, count: posts.length, added, cost, styleName: styleError ? null : nickname, styleError, state: await store.read() }
  } finally {
    desk.importing = false
  }
}

async function addFromUrl(ctx, store, body) {
  const shared = parseSharedLink(body.url)
  const url = shared.url
  const parsed = new URL(url)
  const info = body.metadata === false ? { url: parsed.href, title: parsed.href, description: '', siteName: parsed.hostname } : await harvest(url)
  const kind = sourceKind({ kind: 'web', url: info.url })
  const originalKind = sourceKind({ kind: 'web', url })
  const resolvedKind = kind === 'web' ? originalKind : kind
  const direct = /\.(mp4|webm|mov|png|jpe?g|webp|gif)$/i.test(new URL(info.url).pathname)
  const op = {
    op: 'add_item', kind: resolvedKind, title: body.title || (info.title && info.title !== url ? info.title : shared.text?.split(/https?:/)[0].trim().slice(0, 100)) || info.title || url, body: [body.note || info.description || '', shared.text].filter(Boolean).join('\n\n'), url: info.url, source: info.siteName, tags: Array.isArray(body.tags) ? body.tags : [],
    media: direct ? { src: info.url, ...(info.image ? { poster: info.image } : {}) } : info.image ? { src: info.image } : null,
  }
  return store.mutate(tr('收藏《{title}》', { title: op.title.slice(0, 12) }), (draft) => {
    const { receipts, errors } = applyOps(draft, [op])
    return { receipts, errors, id: receipts[0]?.target, state: draft }
  })
}

async function refreshAccount(store, body) {
  const url = String(body.url || '').trim()
  const now = new Date().toISOString()
  let patch
  try {
    const info = await harvest(url)
    patch = { url: info.url, title: info.title ?? undefined, description: info.description ?? undefined, avatar: info.image ?? undefined, fetchedAt: now, fetchError: '', ...(info.followers ? { followers: info.followers } : {}) }
  } catch (err) {
    patch = { url, fetchedAt: now, fetchError: err.message }
  }
  return store.mutate(tr('更新账号档案'), (draft) => {
    const op = body.id ? { op: 'update_account', id: body.id, ...patch } : { op: 'add_account', platform: body.platform ?? '', handle: body.handle ?? '', ...patch }
    const { errors } = applyOps(draft, [op])
    return { state: draft, errors, fetchError: patch.fetchError || null }
  })
}

async function handleUpload(req, store, res) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = UPLOAD_EXT[type]
  if (!ext) return json(res, 415, { error: tr('不支持这种文件：{type}', { type: type || tr('未知') }) })
  const name = `${newId('f')}${ext}`
  await withAssetUpload(store, async ({ root, dir }) => {
    const pending = join(dir, name)
    await pipeline(req, createWriteStream(pending, { flags: 'wx', mode: 0o600 }))
    await store.run(async () => {
      assertUploadRoot(store, root)
      await rename(pending, join(store.filesDir, name))
    })
  })
  return json(res, 200, { src: `media-desk/files/${name}`, kind: type.startsWith('video/') ? 'video' : 'image' })
}

export async function route(ctx, store, desk, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/^\/media-desk\/?/, '')
  const method = req.method || 'GET'

  if (path.startsWith('publish/')) {
    const publishing = desk.publishing ??= new Publishing(store)
    res.setHeader('cache-control', 'no-store')
    try {
      if (method === 'GET' && path === 'publish/config') return json(res, 200, publishing.config.public())
      if (method === 'GET' && path === 'publish/status') return json(res, 200, await publishing.status(url.searchParams.get('id')))
      if (method === 'GET' && path === 'publish/options') return json(res, 200, await publishing.options(url.searchParams.get('platform')))
      if (method !== 'POST') return json(res, 405, { error: tr('不支持的方法') })
      const site = req.headers['sec-fetch-site']
      if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: tr('拒绝跨站请求') })
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: '发布操作需要 JSON 请求' })
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: '发布请求无效' })
      if (path === 'publish/config') return json(res, 200, await publishing.config.save(body))
      if (path === 'publish/test') return json(res, 200, await publishing.config.test(body.platform))
      if (path === 'publish/prepare') return json(res, 200, { preparation: await publishing.prepare(body) })
      if (path === 'publish/start') return json(res, 202, { job: await publishing.start(body) })
      if (path === 'publish/review') return json(res, 200, { job: await publishing.review(body) })
      return json(res, 404, { error: tr('接口不存在') })
    } catch (err) {
      const status = err.status || (err instanceof PublishError ? 502 : 500)
      return json(res, status, { error: (err.status || err instanceof PublishError) ? err.message : '暂时无法完成发布操作，请先查看投稿记录' })
    }
  }

  if (method === 'GET' && path.startsWith('feishu/')) {
    const sync = desk.feishu ??= new FeishuSync(store)
    if (path === 'feishu/config') return json(res, 200, sync.config.public(await sync.config.read()))
    if (path === 'feishu/job') return json(res, 200, sync.job(url.searchParams.get('id')))
    return json(res, 404, { error: '接口不存在' })
  }

  if ((method === 'GET' || method === 'HEAD') && path.startsWith('assets/')) {
    const name = path.slice('assets/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    return sendFile(req, res, join(ASSETS_DIR, name))
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('files/')) {
    const name = path.slice('files/'.length)
    if (!validAssetPath(name)) return json(res, 400, { error: tr('路径无效') })
    await store.read()
    return sendFile(req, res, await storedAssetPath(store.filesDir, name))
  }
  if (method === 'GET') {
    if (path === 'workspace') return json(res, 200, { workspace: await (desk.assets ??= new ContentAssets(store)).read(url.searchParams.get('id')) })
    if (path === 'state') {
      if (!desk.settled) { desk.settled = true; await desk.producer.settleAll().catch(() => {}) }
      let state = await store.read()
      // 示例数据跟着界面语言走；用户自己的内容不动
      if (samplesNeedLocale(state, currentLang())) state = await store.mutate('', draft => (localizeSamples(draft, currentLang()), draft), { undoable: false })
      return json(res, 200, { state, model: engineLabel(ctx), modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: store.undo.length > 0 })
    }
    if (path === 'production') {
      const id = url.searchParams.get('id') ?? ''
      await desk.producer.settle(id)
      const state = await store.read()
      const item = state.items.find(row => row.id === id)
      return json(res, 200, { production: item?.production ?? null, workspace: item?.workspace, status: item?.status, live: desk.producer.status(id) })
    }
    if (path === 'settings') { await store.read(); return json(res, 200, { ...publicSettings(await desk.settings.read(), Boolean(imageTool(ctx))), documentDir: store.root, canOpenDocumentDir: !process.env.MEDIA_DESK_DATA_DIR, defaultExportDir: defaultExportDir() }) }
    if (path === 'models') {
      // 列出 Harness 里已接的提供方和它们公布的模型，给工作台的助手模型选择器用
      const llm = ctx.get('llm')
      const providers = llm ? await llm.listProviders() : []
      const settled = await Promise.allSettled(providers.map(async p => ({
        provider: p.id, name: p.name,
        models: (await llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name || m.id })),
      })))
      return json(res, 200, {
        providers: settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(p => p.models.length),
        default: defaultSelection(ctx),
        current: assistantModelOverride(),
      })
    }
    if (path === 'insights') return json(res, 200, computeInsights(await store.read()))
    if (path === 'monid/status') return json(res, 200, await monidStatus(desk.monid))
    return json(res, 404, { error: tr('接口不存在') })
  }
  if (method !== 'POST') return json(res, 405, { error: tr('不支持的方法') })

  // 所有写操作都拒绝跨站请求
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: tr('拒绝跨站请求') })

  if (path === 'upload') return handleUpload(req, store, res)
  if (path === 'content-assets/import') {
    const result = await (desk.assets ??= new ContentAssets(store)).import(url.searchParams.get('id'), req, { name: url.searchParams.get('name'), folder: url.searchParams.get('folder') || '', relativePath: url.searchParams.get('relativePath') || '', revision: Number(url.searchParams.get('revision')) })
    return json(res, 200, result)
  }
  const body = await readJson(req)
  switch (path) {
    case 'feishu/config': return json(res, 200, await (desk.feishu ??= new FeishuSync(store)).config.save(body))
    case 'feishu/test': return json(res, 200, await (desk.feishu ??= new FeishuSync(store)).test())
    case 'feishu/preview': return json(res, 200, await (desk.feishu ??= new FeishuSync(store)).preview(body.id))
    case 'feishu/sync': return json(res, 202, (desk.feishu ??= new FeishuSync(store)).start(body))
    case 'cover/titles': return json(res, 200, await coverPromptAction(ctx, store, desk, { ...body, titles: true }))
    case 'cover/prompts': return json(res, 200, await coverPromptAction(ctx, store, desk, body))
    case 'cover/image': return json(res, 200, await coverImageAction(ctx, store, desk, body))
    case 'workspace/save': return json(res, 200, { workspace: await (desk.assets ??= new ContentAssets(store)).save(body.id, body.revision, body.draft) })
    case 'content-assets/trash':
    case 'content-assets/restore': return json(res, 200, { workspace: await (desk.assets ??= new ContentAssets(store)).recycle(body.id, body.revision, body.assetId, path.endsWith('/restore')) })
    case 'ops': {
      const label = typeof body.label === 'string' ? body.label : tr('操作')
      const result = await store.mutate(label, (draft) => {
        const applied = applyOps(draft, body.ops)
        return { ...applied, state: draft }
      }, { undoable: body.undoable !== false })
      return json(res, 200, result)
    }
    case 'undo': {
      const label = await store.undoLast()
      return json(res, 200, { label, state: await store.read(), canUndo: store.undo.length > 0 })
    }
    case 'chat': {
      desk.activeChats = (desk.activeChats || 0) + 1
      try { return json(res, 200, await chatTurn(ctx, store, desk, body)) }
      finally { desk.activeChats-- }
    }
    case 'chat/clear': {
      const state = await store.mutate('清空对话', (draft) => { draft.chat = []; return draft }, { undoable: false })
      return json(res, 200, { state })
    }
    case 'produce': {
      const started = await desk.producer.start(String(body.id))
      return json(res, 200, { started, state: await store.read() })
    }
    case 'produce/cancel':
      await desk.producer.cancel(String(body.id))
      return json(res, 200, { ok: true })
    case 'produce/regen':
      await desk.producer.regenerate(String(body.id), body.target)
      return json(res, 200, { state: await store.read() })
    case 'produce/save': {
      const settings = await desk.settings.read()
      const state = await store.read()
      const item = state.items.find(row => row.id === body.id)
      if (!item?.production?.article) return json(res, 400, { error: tr('还没有可以保存的成稿') })
      await store.read()
      // 视频封面由浏览器合成（画面叠大字），这里只接受 JPEG
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.videoCover ?? '')
      const videoCover = match ? Buffer.from(match[1], 'base64') : null
      if (videoCover && !(videoCover[0] === 0xff && videoCover[1] === 0xd8)) return json(res, 400, { error: tr('封面不是有效的图片') })
      const saved = await saveProduction(item.production, { filesDir: store.filesDir, exportDir: resolveExportDir(settings.exportDir), videoCover })
      const next = await store.mutate('保存成稿', (draft) => {
        const target = draft.items.find(row => row.id === body.id)
        if (target?.production) {
          target.production.savedPath = saved.path
          target.production.savedAt = new Date().toISOString()
        }
        return draft
      }, { undoable: false })
      return json(res, 200, { ...saved, state: next })
    }
    case 'produce/reveal': {
      // 路径只取自保存记录，不接受请求里传来的路径
      const state = await store.read()
      const path = state.items.find(row => row.id === body.id)?.production?.savedPath
      if (!path) return json(res, 400, { error: tr('还没有保存过') })
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      execFile(command, [path], () => {})
      return json(res, 200, { path })
    }
    case 'style/extract': return json(res, 200, await extractStyle(ctx, store, body))
    case 'monid/import': return json(res, 200, await importAccountRoute(ctx, store, desk, body))
    case 'settings': {
      if (body.documentDirMode !== undefined && body.documentDirMode !== 'open') return json(res, 400, { error: tr('无效的文档目录切换方式') })
      const opening = body.documentDirMode === 'open'
      if (!opening) {
        await store.read()
        await desk.settings.update(body, { validateOnly: true })
      }
      const before = modelInfo(ctx)
      let storage = null
      let updated
      if (opening || (typeof body.documentDir === 'string' && body.documentDir.trim() && body.documentDir.trim() !== store.root)) {
        if (desk.activeChats || desk.producer?.jobs?.size || desk.producer?.assets?.size || [...(desk.feishu?.jobs?.values() || [])].some(job => job.status === 'running')) throw Object.assign(new Error(tr('有对话、生成或同步任务正在进行，请完成后再更换目录')), { status: 409 })
        if (opening) {
          ({ storage, settings: updated } = await openStorage(store, body.documentDir))
          desk.settled = false
        } else {
          storage = await relocateStorage(store, body.documentDir, { settingsPatch: body })
        }
      }
      if (!opening) {
        updated = storage?.moved ? await desk.settings.read() : await desk.settings.update(body)
        await store.run(async () => { await store.refresh(); await store.cleanupTrash(true) })
      }
      setAssistantModel(updated.assistant)
      const after = modelInfo(ctx)
      // 换了模型，上一个模型的失败状态不再算数
      if (before?.provider !== after?.provider || before?.model !== after?.model) Object.assign(modelStatus, { ok: null, error: null })
      return json(res, 200, { ...publicSettings(updated, Boolean(imageTool(ctx))), documentDir: store.root, canOpenDocumentDir: !process.env.MEDIA_DESK_DATA_DIR, storage, defaultExportDir: defaultExportDir(), assistantEffective: modelInfo(ctx)?.label ?? null })
    }
    case 'settings/test': {
      const settings = await desk.settings.read()
      if (!desk.producer.ready(settings)) return json(res, 400, { error: tr(settings.image.source === 'tool' ? '未找到订阅生图工具，或默认执行器不支持直接调用；请检查插件和执行器后刷新工作台' : '先填好接口地址、模型和密钥') })
      await store.read()
      const { buffer, ext } = await desk.producer.generate(settings.image, 'A single paper boat on calm water, black and white pencil line art sketch, plain white paper background, no text.')
      const name = `${newId('t')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      return json(res, 200, { src: `media-desk/files/${name}` })
    }
    case 'capture-url': return json(res, 200, await addFromUrl(ctx, store, body))
    case 'account/refresh': return json(res, 200, await refreshAccount(store, body))
    case 'skills/learn': {
      const proposals = proposeRules(await store.read())
      if (!proposals.length) return json(res, 200, { added: 0, state: await store.read() })
      const state = await store.mutate(tr('从数据中学习'), (draft) => {
        // 只用示例数据算出来的建议也算示例，清空示例时一起清掉，也不会被导出
        const fromSamples = !draft.metrics.some(metric => !metric.sample)
        const { receipts } = applyOps(draft, proposals.map(row => ({ op: 'add_skill', ...row, status: 'proposed' })))
        if (fromSamples) for (const receipt of receipts) { const skill = draft.skills.find(row => row.id === receipt?.target); if (skill) skill.sample = true }
        return draft
      })
      return json(res, 200, { added: proposals.length, state })
    }
    case 'skills/export': {
      const state = await store.read()
      const result = await exportSkill(state, dshHome())
      const next = await store.mutate('导出 Skill', (draft) => {
        applyOps(draft, draft.skills.filter(s => !s.sample && s.status === 'active').map(s => ({ op: 'update_skill', id: s.id, status: 'exported' })))
        return draft
      }, { undoable: false })
      return json(res, 200, { ...result, state: next })
    }
    default: return json(res, 404, { error: tr('接口不存在') })
  }
}

/**
 * Web 服务不会替插件路由鉴权，所以每个请求都要自己走一遍 Host/Origin 和登录凭证检查。
 * 拿不到鉴权服务时一律拒绝。
 * @param {object} ctx - Cordis 上下文。
 * @param {{headers: object}} req - HTTP 请求。
 * @returns {number|undefined} 拒绝时的状态码；可以继续时为 undefined。
 */
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

export const name = PACKAGE_NAME

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const store = new Store()
    const settings = new Settings(store)
    const producer = new Producer({
      store, settings, callText: options => callModel(ctx, options),
      ready: saved => imageReady(saved, Boolean(imageTool(ctx))),
      generate: (image, prompt, options) => image.source === 'tool' ? generateToolImage(ctx, image, prompt, options) : generateImage(image, prompt, options),
    })
    const monid = createMonidRunner()
    const desk = { settings, producer, monid }
    ctx.effect(() => {
      const timer = setInterval(() => store.read().catch(err => console.error('回收站清理失败：', err.message)), 3600000)
      timer.unref?.()
      return () => clearInterval(timer)
    })
    // 启动时恢复用户在工作台里选过的助手模型
    settings.read().then(saved => setAssistantModel(saved.assistant)).catch(() => {})
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/media-desk',
      handler: async (req, res) => {
        try {
          const rejection = requestRejection(ctx, req)
          if (rejection) {
            json(res, rejection, { error: tr('未授权') })
            return
          }
          await withLang(req.headers['x-media-desk-lang'], () => route(ctx, store, desk, req, res))
        } catch (err) {
          if (res.headersSent) {
            res.end()
            return
          }
          json(res, err.status || 500, { error: err.message })
        }
      },
    }), 'prompthub-media-desk: /media-desk routes')
  },
}
