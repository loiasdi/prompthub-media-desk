// 每篇内容独立的保存队列：编辑、导入和回收站操作不会互相覆盖。
import { lang, t } from './i18n.js'
import { sourceAssets } from '../src/workspace-schema.js'

function mergeAssets(...lists) {
  return [...new Map(lists.flat().map(asset => [asset.id, asset])).values()]
}

async function request(path, body) {
  const response = await fetch(`media-desk/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error || t('保存失败')), { status: response.status })
  return data
}

function upload(id, file, folder, revision, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = new URLSearchParams({ id, name: file.name, folder, relativePath: file.webkitRelativePath || '', revision: String(revision) })
    xhr.open('POST', `media-desk/content-assets/import?${query}`)
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-media-desk-lang', lang())
    xhr.upload.onprogress = event => onProgress(event.lengthComputable ? Math.min(95, Math.round(event.loaded / event.total * 95)) : 0)
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status < 200 || xhr.status >= 300) throw Object.assign(new Error(data.error || t('导入失败')), { status: xhr.status })
        resolve(data)
      } catch (err) { reject(err) }
    }
    xhr.onerror = () => reject(new Error(t('网络连接失败，请重试')))
    xhr.onabort = () => reject(Object.assign(new Error(t('已取消导入')), { name: 'AbortError' }))
    const abort = () => xhr.abort()
    signal?.addEventListener('abort', abort, { once: true })
    xhr.onloadend = () => signal?.removeEventListener('abort', abort)
    if (signal?.aborted) { reject(Object.assign(new Error(t('已取消导入')), { name: 'AbortError' })); return }
    xhr.send(file)
  })
}

export function createWorkspaceStore({ create, resolve, patch, api = request, uploadFile = upload, debounceMs = 350 }) {
  const entries = new Map()
  const listeners = new Set()
  const timers = new Map()
  const queues = new Map()
  const controllers = new Map()
  const checkedAssets = new Map()
  const emit = () => listeners.forEach(fn => fn())
  const set = (id, changes) => { entries.set(id, { ...entries.get(id), ...changes }); emit() }
  const get = item => {
    let entry = entries.get(item.id)
    if (!entry) {
      const draft = { ...create(item), ...item.workspace }
      entry = { item, draft, revision: item.workspace?.revision || 0, version: 0, savedVersion: 0, status: 'saved', error: '', conflict: false, imports: [], importing: false }
      entries.set(item.id, entry)
    } else {
      // item 不是快照的一部分，否则父组件每次刷新会使订阅快照不稳定。
      entry.item = item
      if (item.workspace?.revision > entry.revision && entry.version === entry.savedVersion && !entry.importing && entry.status !== 'saving') {
        entry = { ...entry, revision: item.workspace.revision, draft: { ...create(item), ...item.workspace }, error: '', conflict: false }
        entries.set(item.id, entry)
      }
    }
    // 生成结果的登记不改变可编辑草稿的修订号，仍需持续接收并保留每一版文件。
    // React 会为同一次键入多次读取快照。只在素材输入真正改变时合并、比较。
    const registered = item.workspace?.revision >= entry.revision ? item.workspace.assets : undefined
    const inputs = [registered, item.production?.cover, item.production?.images, item.production?.shots, item.mediaItems, item.media, item.title, item.sample]
    const checked = checkedAssets.get(item.id)
    if (checked?.assets === entry.draft.assets && inputs.every((value, index) => value === checked.inputs[index])) return entry
    const assets = mergeAssets(entry.draft.assets, registered || [], sourceAssets(item))
    if (JSON.stringify(assets) !== JSON.stringify(entry.draft.assets)) {
      entry = { ...entry, draft: { ...entry.draft, assets } }
      entries.set(item.id, entry)
    }
    checkedAssets.set(item.id, { assets: entry.draft.assets, inputs })
    return entry
  }
  const enqueue = (id, run) => {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(run)
    queues.set(id, next)
    return next
  }
  const adopt = (id, workspace, version) => {
    const entry = entries.get(id)
    workspace = { ...workspace, assets: mergeAssets(entry.draft.assets, workspace.assets, sourceAssets(entry.item)) }
    const dirty = entry.version !== version
    const draft = dirty ? {
      ...entry.draft, assets: workspace.assets, hidden: workspace.hidden, trash: workspace.trash,
      folders: [...new Map([...workspace.folders, ...entry.draft.folders].map(row => [row.id, row])).values()],
      revision: workspace.revision,
    } : workspace
    set(id, { draft, revision: workspace.revision, savedVersion: version, status: dirty ? 'pending' : 'saved', error: '', conflict: false })
  }
  const saveNow = async id => {
    while (entries.get(id).version !== entries.get(id).savedVersion) {
      const entry = entries.get(id)
      const version = entry.version
      set(id, { status: 'saving', error: '' })
      try {
        const submitted = resolve(entry.item, entry.draft)
        const { workspace } = await api('workspace/save', { id, revision: entry.revision, draft: submitted })
        // 旧后端可能返回成功但丢弃新字段；确认原文落库前不可覆盖本地输入。
        if (typeof submitted.promptText === 'string' && workspace.promptText !== submitted.promptText) {
          set(id, { revision: workspace.revision })
          throw new Error(t('服务端未完整保存视频提示词，已保留输入。请更新或重启服务后重试保存'))
        }
        if (typeof submitted.coverPromptText === 'string' && workspace.coverPromptText !== submitted.coverPromptText) {
          set(id, { revision: workspace.revision })
          throw new Error(t('服务端未完整保存封面提示词，已保留输入。请更新或重启服务后重试保存'))
        }
        if (submitted.coverDesign && JSON.stringify(workspace.coverDesign) !== JSON.stringify(submitted.coverDesign)) {
          set(id, { revision: workspace.revision })
          throw new Error(t('服务端未完整保存封面设计，已保留输入。请更新或重启服务后重试保存'))
        }
        adopt(id, workspace, version)
      } catch (err) {
        set(id, { status: 'error', error: err.message, conflict: err.status === 409 })
        throw err
      }
    }
  }
  const flush = id => {
    clearTimeout(timers.get(id))
    return entries.has(id) ? enqueue(id, () => saveNow(id)) : Promise.resolve()
  }
  const flushAll = () => Promise.all([...entries.keys()].map(flush))
  const update = (item, changes) => {
    const entry = get(item)
    set(item.id, { draft: patch(item, entry.draft, changes), version: entry.version + 1, status: 'pending' })
    clearTimeout(timers.get(item.id))
    timers.set(item.id, setTimeout(() => { flush(item.id).catch(() => {}) }, debounceMs))
  }
  const reload = id => {
    const version = entries.get(id).version
    return enqueue(id, async () => {
      clearTimeout(timers.get(id))
      try {
        const { workspace } = await api(`workspace?id=${encodeURIComponent(id)}`)
        if (entries.get(id).version !== version) throw Object.assign(new Error(t('重新加载期间有新修改，已保留草稿，请重试')), { status: 409 })
        adopt(id, workspace, version)
      } catch (err) {
        set(id, { status: 'error', error: err.message, conflict: err.status === 409 })
        throw err
      }
    })
  }
  const recycle = (id, assetId, restore = false) => enqueue(id, async () => {
    await saveNow(id)
    const entry = entries.get(id)
    try {
      const { workspace } = await api(`content-assets/${restore ? 'restore' : 'trash'}`, { id, assetId, revision: entry.revision })
      adopt(id, workspace, entry.version)
      // 不能把操作过程中输入的旧选择写回回收站。
      if (entries.get(id).version !== entry.version) set(id, { draft: resolve(entry.item, entries.get(id).draft) })
      await saveNow(id)
    } catch (err) {
      set(id, { status: 'error', error: err.message, conflict: err.status === 409 })
      throw err
    }
  })
  const importFiles = (id, files, folder = '') => {
    if (entries.get(id).importing) return Promise.reject(new Error(t('请等待当前导入完成')))
    const controller = new AbortController()
    controllers.set(id, controller)
    const rows = files.map((file, index) => ({ id: index, name: file.name, progress: 0, status: 'queued', error: '' }))
    set(id, { importing: true, imports: rows })
    const progress = (index, changes) => set(id, { imports: entries.get(id).imports.map(row => row.id === index ? { ...row, ...changes } : row) })
    return enqueue(id, async () => {
      try {
        await saveNow(id)
        for (const [index, file] of files.entries()) {
          if (controller.signal.aborted) { progress(index, { status: 'cancelled' }); continue }
          progress(index, { status: 'uploading' })
          const entry = entries.get(id)
          try {
            // 取消只停止剩余队列；已发出的文件等待服务器确认，避免“已入库但界面当作失败”。
            const { workspace } = await uploadFile(id, file, folder, entry.revision, value => progress(index, { progress: value, status: value >= 95 ? 'processing' : 'uploading' }))
            adopt(id, workspace, entry.version)
            progress(index, { status: 'done', progress: 100 })
            await saveNow(id)
          } catch (err) {
            // 入库确认后的草稿保存失败不能把已导入文件改成失败，避免用户重复上传。
            if (entries.get(id).imports[index].status !== 'done') progress(index, { status: err.name === 'AbortError' ? 'cancelled' : 'failed', error: err.message })
            if (err.status === 409 || entries.get(id).status === 'error') {
              set(id, { status: 'error', error: err.message, conflict: err.status === 409 })
              for (const row of entries.get(id).imports.filter(row => row.status === 'queued')) progress(row.id, { status: 'cancelled' })
              break
            }
          }
        }
      } catch (err) {
        for (const row of entries.get(id).imports) progress(row.id, { status: 'failed', error: err.message })
      } finally {
        set(id, { importing: false })
        controllers.delete(id)
      }
      return entries.get(id).imports
    })
  }
  const action = (id, path, body) => enqueue(id, async () => {
    await saveNow(id)
    const entry = entries.get(id)
    const result = await api(path, { ...body, id, revision: entry.revision })
    if (result.workspace) adopt(id, result.workspace, entry.version)
    return result
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', event => {
      if ([...entries.values()].some(entry => entry.version !== entry.savedVersion || entry.importing)) { event.preventDefault(); event.returnValue = '' }
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') for (const id of entries.keys()) flush(id).catch(() => {})
    })
  }
  return { get, update, flush, flushAll, reload, recycle, importFiles, action, cancelImport: id => controllers.get(id)?.abort(), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
}
