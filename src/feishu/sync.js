import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from '../store.js'
import { storedAssetPath } from '../asset-storage.js'
import { FeishuConfig, failure } from './config.js'
import { FeishuAPI } from './api.js'

export const FIELDS = ['标题', '制作状态', '稿件文档', '素材链接', '最近同步时间', '工作台ID']
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const fileHash = async path => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex') }
const chunks = text => { const chars = Array.from(text); const result = []; for (let i = 0; i < chars.length; i += 1800) result.push(chars.slice(i, i + 1800).join('')); return result }
const block = content => ({ block_type: 2, text: { elements: [{ text_run: { content } }] } })
const blockText = b => Object.values(b).filter(v => v && typeof v === 'object' && v.elements).flatMap(v => v.elements.map(e => e.text_run?.content || '')).join('')

export class FeishuSync {
  constructor(store, { config = new FeishuConfig(), apiFactory = c => new FeishuAPI(c) } = {}) {
    this.store = store; this.config = config; this.apiFactory = apiFactory; this.previews = new Map(); this.jobs = new Map(); this.locker = new Store(config.root)
  }
  async configured() {
    const config = await this.config.read()
    if (!this.config.public(config).ready) throw failure('请先填写飞书应用、目标文件夹和多维表格配置')
    return config
  }
  target(config) { return hash([this.store.state?.storageIdentityRoot || this.store.root, config.appId, config.folderToken, config.appToken, config.tableId]) }
  async manifest(config) {
    const path = join(this.config.root, `sync-${this.target(config)}.json`)
    try { return { path, data: JSON.parse(await readFile(path, 'utf8')) } }
    catch (e) { if (e.code !== 'ENOENT') throw e; return { path, data: { items: {} } } }
  }
  async test() {
    const config = await this.configured(), api = this.apiFactory(config)
    const fields = await api.fields(), files = await api.listFiles(config.folderToken)
    this.checkFields(fields)
    return { ok: true, missingFields: FIELDS.filter(name => !fields.some(f => f.field_name === name || (name === '标题' && f.is_primary && f.type === 1))), files: files.map(f => ({ name: f.name, type: f.type, url: f.url })) }
  }
  checkFields(fields) {
    for (const f of fields) if (FIELDS.includes(f.field_name) && f.type !== 1) throw failure(`多维表格的「${f.field_name}」必须是多行文本类型，请调整后重试`)
  }
  async prepare(id, config, api) {
    const state = await this.store.read(), item = structuredClone(state.items.find(i => i.id === id))
    if (!item) throw failure('内容不存在', 404)
    const saved = await this.manifest(config), entry = saved.data.items[id] || { files: {} }
    entry.assetHashes ||= {}
    entry.images ||= {}
    const itemKey = `${hash(this.store.state?.storageIdentityRoot || this.store.root).slice(0, 12)}:${id}`
    const fields = await api.fields(); this.checkFields(fields)
    const missingFields = FIELDS.filter(name => !fields.some(f => f.field_name === name || (name === '标题' && f.is_primary && f.type === 1)))
    let record = entry.recordId ? (await api.record(entry.recordId)).record : null
    if (!record && !missingFields.includes('工作台ID')) record = await api.findRecord(itemKey)
    const rootFiles = await api.listFiles(config.folderToken)
    const remoteFiles = entry.folderToken ? await api.listFiles(entry.folderToken) : []
    const document = entry.documentId ? (await api.doc(entry.documentId)).document : null
    const blocks = document ? await api.blocks(entry.documentId) : []
    const visible = new Set(remoteFiles.map(f => f.token))
    const assets = []
    for (const a of item.workspace?.assets || []) {
      if (item.workspace.hidden?.includes(a.id) || !a.src?.startsWith('media-desk/files/')) continue
      const path = await storedAssetPath(this.store.filesDir, a.src.slice(17))
      const info = await stat(path)
      if (!info.size || info.size > 250000000) throw failure(`素材「${a.name}」大小超出同步范围（1 字节至 250 MB）`)
      const digest = await fileHash(path)
      const cached = entry.files[digest]
      const reused = cached && visible.has(cached.token)
      if (reused && !cached.url) cached.url = await api.url(cached.token, 'file')
      assets.push({ id: a.id, name: item.workspace.edits?.[a.id]?.name || a.name, type: a.type, size: info.size, path, hash: digest, action: reused ? 'reuse' : cached || entry.assetHashes[a.id] ? 'update' : 'new', remote: reused ? cached : null })
    }
    const remote = { record: record?.fields || null, document, blocks, files: remoteFiles.map(f => ({ token: f.token, name: f.name })).sort((a, b) => a.token.localeCompare(b.token)) }
    const remoteHash = hash(remote), localHash = hash([item, assets.map(a => [a.id, a.hash, a.name])])
    return { item, itemKey, config, saved, entry, api, fields, missingFields, record, rootFiles, remoteFiles, document, blocks, assets, localHash, remoteHash, remoteEdited: Boolean(entry.remoteHash && entry.remoteHash !== remoteHash), target: this.target(config) }
  }
  async preview(id) {
    const config = await this.configured()
    const p = await this.prepare(id, config, this.apiFactory(config))
    const token = hash([Date.now(), Math.random(), p.localHash, p.remoteHash])
    for (const [key, value] of this.previews) if (Date.now() - value.at > 600000) this.previews.delete(key)
    this.previews.set(token, { at: Date.now(), id, localHash: p.localHash, remoteHash: p.remoteHash, target: p.target })
    return { token, title: p.item.production?.title || p.item.title, missingFields: p.missingFields, remoteEdited: p.remoteEdited,
      document: p.document ? { title: p.document.title, url: p.entry.documentUrl, text: p.blocks.map(b => b.block_type === 27 ? '[图片]' : blockText(b)).join('\n') } : null,
      record: p.record?.fields || null,
      files: [...p.rootFiles, ...p.remoteFiles].map(f => ({ name: f.name, type: f.type, url: f.url })),
      assets: p.assets.map(({ id, name, type, size, action, remote }) => ({ id, name, type, size, action, url: remote?.url })),
      textAction: p.entry.localHash === p.localHash && p.entry.imageVersion === 1 && !p.remoteEdited ? 'reuse' : p.document ? 'update' : 'new',
      syncedAt: p.entry.syncedAt || null }
  }
  start({ token, assetIds, overwrite = false }) {
    const preview = this.previews.get(token)
    if (!preview || Date.now() - preview.at > 600000) throw failure('同步预览已过期，请重新预览', 409)
    if (!Array.isArray(assetIds) || assetIds.some(id => typeof id !== 'string')) throw failure('请选择要同步的素材')
    if ([...this.jobs.values()].some(j => j.status === 'running')) throw failure('已有同步任务正在进行，请等待完成', 409)
    if (this.jobs.size > 50) for (const [key, value] of this.jobs) if (value.status !== 'running') this.jobs.delete(key)
    const id = hash([token, Date.now()]).slice(0, 24)
    const job = { id, itemId: preview.id, status: 'running', message: '正在核对本地与飞书内容', percent: 0 }
    this.jobs.set(id, job)
    this.previews.delete(token)
    this.locker.run(() => this.execute(preview, assetIds, overwrite, job)).then(result => Object.assign(job, { status: 'done', message: '同步完成', percent: 100, ...result })).catch(e => Object.assign(job, { status: 'error', message: e.message }))
    return job
  }
  job(id) { const job = this.jobs.get(id); if (!job) throw failure('同步任务不存在；服务重启后请重新预览，已完成文件会复用', 404); return job }
  async execute(preview, selected, overwrite, job) {
    const config = await this.configured(), api = this.apiFactory(config)
    const p = await this.prepare(preview.id, config, api)
    if (p.target !== preview.target || p.localHash !== preview.localHash || p.remoteHash !== preview.remoteHash) throw failure('本地或飞书内容已变化，请重新预览后同步', 409)
    if (p.remoteEdited && !overwrite) throw failure('飞书内容已被编辑，请确认覆盖工作台管理的文档和字段')
    if (selected.some(id => !p.assets.some(a => a.id === id))) throw failure('素材选择无效')
    const { entry, saved } = p
    saved.data.items[p.item.id] = entry
    const checkpoint = () => this.config.write(saved.path, saved.data)
    for (const name of p.missingFields) await api.call(api.tablePath() + '/fields', { method: 'POST', data: { field_name: name, type: 1 } })
    if (!entry.folderToken) {
      job.message = '正在创建稿件文件夹'
      const folder = await api.call('/drive/v1/files/create_folder', { method: 'POST', data: { name: `${p.item.production?.title || p.item.title} [${p.item.id}]`.slice(0, 200), folder_token: config.folderToken } })
      if (!folder.token) throw failure('飞书未返回文件夹标识', 502)
      entry.folderToken = folder.token; await checkpoint()
    }
    const chosen = p.assets.filter(a => selected.includes(a.id))
    let uploaded = 0, reused = 0
    for (const [i, a] of chosen.entries()) {
      job.message = `正在同步素材 ${i + 1}/${chosen.length}：${a.name}`
      job.percent = Math.round(i / Math.max(1, chosen.length) * 70)
      const cached = entry.files[a.hash]
      if (a.action === 'reuse' || (cached && chosen.slice(0, i).some(b => b.hash === a.hash))) {
        cached.url ||= await api.url(cached.token, 'file'); entry.assetHashes[a.id] = a.hash; await checkpoint(); reused++; continue
      }
      await api.upload(a.path, a.name, a.size, entry.folderToken, async token => {
        entry.files[a.hash] = { token, name: a.name }; entry.assetHashes[a.id] = a.hash; await checkpoint()
        entry.files[a.hash].url = await api.url(token, 'file'); await checkpoint()
      }, percent => { job.percent = Math.round((i + percent / 100) / Math.max(1, chosen.length) * 70) })
      if (await fileHash(a.path) !== a.hash) { delete entry.files[a.hash]; delete entry.assetHashes[a.id]; await checkpoint(); throw failure('上传期间素材已变化，请重新预览') }
      uploaded++
    }
    const currentItem = (await this.store.read()).items.find(i => i.id === p.item.id)
    if (hash(currentItem) !== hash(p.item)) throw failure('上传期间本地稿件发生变化，请重新预览；已完成文件会复用')
    job.message = '正在更新稿件文档'; job.percent = 75
    if (!entry.documentId) {
      const result = await api.call('/docx/v1/documents', { method: 'POST', data: { title: p.item.production?.title || p.item.title, folder_token: entry.folderToken } })
      if (!result.document?.document_id) throw failure('飞书未返回文档标识', 502)
      entry.documentId = result.document.document_id; entry.managed = true; await checkpoint()
    }
    entry.documentUrl ||= await api.url(entry.documentId, 'docx'); await checkpoint()
    const links = p.assets.flatMap(a => { const file = entry.files[entry.assetHashes[a.id] || a.hash]; return file?.url ? [`${a.name}：${file.url}`] : [] }).join('\n')
    const prod = p.item.production || {}, ws = p.item.workspace || {}
    const content = [`标题：${prod.title || p.item.title}`, `描述：${prod.description || ''}`, `话题：${prod.topics ?? (p.item.tags || []).join(' ')}`, '\n原始灵感', ws.ideaText ?? p.item.body ?? '', '\n内容大纲', ws.outlineText || '', '\n稿件正文', prod.article ?? p.item.body ?? '', '\n视频提示词', ws.promptText || '', '\n封面设计', ws.coverDesign?.title || prod.title || p.item.title, ws.coverDesign?.requirements || '', ...Object.entries(ws.coverDesign?.variants || {}).map(([ratio, v]) => `${ratio}\n${v.prompt || ''}`), ws.coverPromptText || '', '\n正文配图', ...(ws.coverDesign?.illustrations || []).map(row => `${row.title || '未命名配图'} · ${row.ratio}\n${row.requirements || ''}\n${row.prompt || ''}`), '\n素材链接', links].join('\n\n')
    const images = p.assets.filter(a => a.type === 'image' && entry.assetHashes[a.id] === a.hash && entry.files[a.hash]).map(a => {
      const ratios = Object.entries(ws.coverDesign?.variants || {}).filter(([, v]) => v.imageIds?.includes(a.id)).map(([r]) => r)
      const illustrationNames = (ws.coverDesign?.illustrations || []).filter(row => row.imageIds?.includes(a.id)).map(row => row.title || '正文配图')
      if (illustrationNames.length && !ratios.length && a.id !== ws.selectedCover) return { ...a, caption: `正文配图 · ${illustrationNames.join(' / ')} · ${a.name}` }
      return { ...a, caption: `${illustrationNames.length ? '正文配图 · ' + illustrationNames.join(' / ') + ' · ' : ''}${ratios.length || a.id === ws.selectedCover || ws.edits?.[a.id]?.role === 'cover' ? '封面图片' : '参考图片'}${ratios.length ? ' · ' + ratios.join(' / ') : ''} · ${a.name}` }
    })
    const uniqueImages = [...new Map(images.map(a => [a.hash, a])).values()]
    for (const image of uniqueImages) if (image.size > 20000000) throw failure(`图片「${image.name}」超过文档内嵌上限 20 MB，请压缩后同步`)
    const contentHash = hash([content, uniqueImages.map(a => [a.hash, a.caption]), 1])
    if (entry.contentHash !== contentHash || p.remoteEdited || entry.pendingDoc) {
      if (!entry.managed) throw failure('此文档并非工作台创建，不能自动覆盖')
      await this.replaceDoc(api, entry, content, checkpoint, p.document)
      await this.syncImages(api, entry, uniqueImages, checkpoint, job)
      entry.imageVersion = 1
      entry.contentHash = contentHash; await checkpoint()
    }
    job.message = '正在更新多维表格'; job.percent = 90
    const fields = { '工作台ID': p.itemKey, '制作状态': p.item.status || 'draft', '稿件文档': entry.documentUrl, '素材链接': links, '最近同步时间': new Date().toISOString() }
    const primary = p.fields.find(f => f.is_primary && f.type === 1)
    fields[primary?.field_name || '标题'] = prod.title || p.item.title
    const record = p.record || await api.findRecord(p.itemKey)
    if (record && p.record && hash(record.fields) !== hash(p.record.fields)) throw failure('飞书表格在同步期间发生变化，请重新预览')
    if (record && p.record && hash((await api.record(record.record_id)).record?.fields) !== hash(p.record.fields)) throw failure('飞书表格在同步期间发生变化，请重新预览')
    if (!record) { entry.recordClientToken ||= randomUUID(); await checkpoint() }
    const result = await api.call(api.tablePath() + '/records' + (record ? '/' + record.record_id : '?client_token=' + entry.recordClientToken), { method: record ? 'PUT' : 'POST', data: { fields } })
    if (!result.record?.record_id) throw failure('飞书未返回表格记录标识', 502)
    entry.recordId = result.record.record_id; entry.syncedAt = fields['最近同步时间']; entry.localHash = p.localHash; await checkpoint()
    const final = await this.prepare(p.item.id, config, api)
    entry.remoteHash = final.remoteHash; await checkpoint()
    return { uploaded, reused, url: entry.documentUrl, syncedAt: entry.syncedAt }
  }
  async replaceDoc(api, entry, content, checkpoint, expectedDocument) {
    const id = entry.documentId, path = `/docx/v1/documents/${id}/blocks/${id}/children`
    const document = (await api.doc(id)).document
    if (expectedDocument && document.revision_id !== expectedDocument.revision_id) throw failure('飞书文档在同步期间发生变化，请重新预览')
    let revision = document.revision_id
    if (!Number.isInteger(revision)) throw failure('飞书未返回有效文档版本', 502)
    const blocks = await api.blocks(id)
    // 先完整追加新版，再移除旧块。中途失败保留正文；重试时以当前全部块为旧版本重做。
    entry.pendingDoc = true; await checkpoint()
    const protectedIds = new Set(Object.values(entry.images || {}).flatMap(image => [image.blockId, image.captionId]))
    const rows = chunks(content).map(block)
    for (let i = 0; i < rows.length; i += 50) {
      const result = await api.call(path + '?document_revision_id=' + revision, { method: 'POST', data: { children: rows.slice(i, i + 50), index: i } })
      revision = result.document_revision_id
      if (!Number.isInteger(revision)) throw failure('飞书未返回文档更新版本，请重新预览', 502)
    }
    for (let end = blocks.length; end > 0;) {
      if (protectedIds.has(blocks[end - 1].block_id)) { end--; continue }
      let start = end - 1
      while (start > 0 && !protectedIds.has(blocks[start - 1].block_id)) start--
      const result = await api.call(path + '/batch_delete?document_revision_id=' + revision, { method: 'DELETE', data: { start_index: rows.length + start, end_index: rows.length + end } })
      revision = result.document_revision_id; end = start
    }
    entry.pendingDoc = false; await checkpoint()
  }
  async syncImages(api, entry, images, checkpoint, job) {
    const id = entry.documentId, base = `/docx/v1/documents/${id}/blocks`
    let revision = (await api.doc(id)).document.revision_id
    const existing = await api.blocks(id), existingIds = new Set(existing.map(b => b.block_id))
    const desired = new Set(images.map(a => a.hash))
    for (const a of images) {
      job.message = `正在插入文档图片：${a.name}`
      let image = entry.images[a.hash]
      if (!image || !existingIds.has(image.blockId) || !existingIds.has(image.captionId)) {
        const result = await api.call(`${base}/${id}/children?document_revision_id=${revision}`, { method: 'POST', data: { children: [block(a.caption), { block_type: 27, image: {} }], index: -1 } })
        revision = result.document_revision_id
        if (!result.children?.[0]?.block_id || !result.children?.[1]?.block_id) throw failure('飞书未返回图片块标识', 502)
        image = entry.images[a.hash] = { captionId: result.children[0].block_id, blockId: result.children[1].block_id, caption: a.caption }
        await checkpoint()
      }
      if (image.caption !== a.caption) {
        const result = await api.call(`${base}/${image.captionId}?document_revision_id=${revision}`, { method: 'PATCH', data: { update_text_elements: block(a.caption).text } })
        revision = result.document_revision_id; image.caption = a.caption; await checkpoint()
      }
      if (!image.token) {
        if (await fileHash(a.path) !== a.hash) throw failure('图片内容发生变化，请重新预览')
        image.token = await api.uploadImage(a.path, a.name, a.size, image.blockId)
        if (await fileHash(a.path) !== a.hash) { delete image.token; await checkpoint(); throw failure('上传期间图片发生变化，请重新预览') }
        await checkpoint()
      }
      if (!image.attached) {
        const result = await api.call(`${base}/${image.blockId}?document_revision_id=${revision}`, { method: 'PATCH', data: { replace_image: { token: image.token } } })
        revision = result.document_revision_id; image.attached = true; await checkpoint()
      }
    }
    // 新图片全部可见后，再移除不再属于当前稿件的旧图片块，云空间原文件保留。
    const removeIds = new Set(Object.entries(entry.images).filter(([digest]) => !desired.has(digest)).flatMap(([, image]) => [image.blockId, image.captionId]))
    if (removeIds.size) {
      const blocks = await api.blocks(id)
      for (let i = blocks.length - 1; i >= 0; i--) if (removeIds.has(blocks[i].block_id)) {
        const result = await api.call(`${base}/${id}/children/batch_delete?document_revision_id=${revision}`, { method: 'DELETE', data: { start_index: i, end_index: i + 1 } })
        revision = result.document_revision_id
      }
      for (const digest of Object.keys(entry.images)) if (!desired.has(digest)) delete entry.images[digest]
      await checkpoint()
    }
  }

}
