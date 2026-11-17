import { open, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { failure } from './config.js'

const BASE = 'https://open.feishu.cn/open-apis'
export class FeishuAPI {
  constructor(config, { fetchImpl = fetch, wait = delay } = {}) { this.config = config; this.fetch = fetchImpl; this.wait = wait; this.lastWrite = 0 }
  async token() {
    if (this.access && this.expire > Date.now()) return this.access
    const res = await this.fetch(`${BASE}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }), signal: AbortSignal.timeout(30000), redirect: 'error' })
    const body = await res.json()
    if (!res.ok || body.code !== 0 || !body.tenant_access_token) throw failure('飞书应用认证失败，请检查 App ID、App Secret 和应用发布状态', 502)
    this.access = body.tenant_access_token; this.expire = Date.now() + Math.max(0, (body.expire - 120) * 1000)
    return this.access
  }
  async call(path, { method = 'GET', data, form } = {}, attempt = 0) {
    const token = await this.token()
    if (method !== 'GET') { await this.wait(Math.max(0, 360 - (Date.now() - this.lastWrite))); this.lastWrite = Date.now() }
    const res = await this.fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, ...(form ? {} : { 'content-type': 'application/json' }) }, body: form || (data === undefined ? undefined : JSON.stringify(data)), signal: AbortSignal.timeout(120000), redirect: 'error' })
    const body = await res.json().catch(() => ({}))
    if ((res.status === 429 || body.code === 99991400) && attempt < 3) { await this.wait(Math.min(15000, 1000 * 2 ** attempt)); return this.call(path, { method, data, form }, attempt + 1) }
    if (!res.ok || (body.code !== 0 && !(path === '/drive/v1/files/upload_part' && body.code === undefined && Object.keys(body).length === 0))) throw failure(`飞书请求失败（${body.code ?? res.status}）：${String(body.msg || '接口未返回有效结果').slice(0, 250)}`, 502)
    return body.data || {}
  }
  async pages(path, key) {
    const rows = []; let token = ''
    do {
      const data = await this.call(`${path}${path.includes('?') ? '&' : '?'}page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`)
      rows.push(...data[key] || [])
      token = data.has_more ? data.page_token || data.next_page_token : ''
      if (data.has_more && !token) throw failure('飞书分页结果不完整，请重试', 502)
      if (rows.length > 20000) throw failure('飞书目录过大，请选择专用文件夹')
    } while (token)
    return rows
  }
  async url(token, type) {
    const result = await this.call('/drive/v1/metas/batch_query', { method: 'POST', data: { request_docs: [{ doc_token: token, doc_type: type }], with_url: true } })
    const raw = result.metas?.find(m => m.doc_token === token)?.url
    let url
    try { url = new URL(raw) } catch { throw failure('飞书未返回可访问链接，请检查文件元数据读取权限', 502) }
    if (url.protocol !== 'https:' || !(url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn'))) throw failure('飞书返回的文件链接无效', 502)
    return url.href
  }
  async listFiles(folder) {
    try { return await this.pages(`/drive/v1/files?folder_token=${encodeURIComponent(folder)}`, 'files') }
    catch (err) {
      if (/1061004|forbidden/i.test(err.message)) throw failure('目标文件夹未授权：请在飞书文件夹的分享设置中，为当前飞书应用或包含其机器人的群授予编辑权限（1061004）', 403)
      throw err
    }
  }
  fields() { return this.pages(this.tablePath() + '/fields', 'items') }
  tablePath() { return `/bitable/v1/apps/${this.config.appToken}/tables/${this.config.tableId}` }
  record(id) { return this.call(this.tablePath() + '/records/' + id) }
  async findRecord(itemKey) {
    const data = await this.call(this.tablePath() + '/records/search?page_size=2', { method: 'POST', data: { filter: { conjunction: 'and', conditions: [{ field_name: '工作台ID', operator: 'is', value: [itemKey] }] } } })
    if (data.has_more || data.items?.length > 1) throw failure('飞书存在重复工作台ID，请先在表格中核对')
    return data.items?.[0] || null
  }
  doc(id) { return this.call(`/docx/v1/documents/${id}`) }
  blocks(id) { return this.pages(`/docx/v1/documents/${id}/blocks/${id}/children`, 'items') }
  async uploadImage(path, name, size, blockId) {
    if (size > 20000000) throw failure('文档内图片不能超过 20 MB，请压缩后重新同步')
    const data = await readFile(path)
    if (data.length !== size) throw failure('图片在同步期间发生变化，请重新预览')
    const form = new FormData()
    form.set('file_name', name); form.set('parent_type', 'docx_image'); form.set('parent_node', blockId)
    form.set('size', String(data.length)); form.set('file', new Blob([data]), name)
    const result = await this.call('/drive/v1/medias/upload_all', { method: 'POST', form })
    if (!result.file_token) throw failure('飞书未返回文档图片标识', 502)
    return result.file_token
  }
  async upload(path, name, size, folder, checkpoint, progress) {
    // 分片仅在本次进程内续传；完成后的文件 token 立即持久化，失败重试不重传已完成文件。
    const prepared = await this.call('/drive/v1/files/upload_prepare', { method: 'POST', data: { file_name: name, parent_type: 'explorer', parent_node: folder, size } })
    if (!prepared.upload_id || !Number.isInteger(prepared.block_size) || prepared.block_size <= 0 || prepared.block_size > 20000000 || prepared.block_num !== Math.ceil(size / prepared.block_size)) throw failure('飞书上传分片参数无效', 502)
    const handle = await open(path, 'r')
    try {
      for (let seq = 0; seq < prepared.block_num; seq++) {
        const length = Math.min(prepared.block_size, size - seq * prepared.block_size)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, seq * prepared.block_size)
        if (bytesRead !== length) throw failure('上传时本地文件发生变化，请重新预览')
        const form = new FormData()
        form.set('upload_id', prepared.upload_id); form.set('seq', String(seq)); form.set('size', String(length)); form.set('file', new Blob([buffer]), 'chunk')
        await this.call('/drive/v1/files/upload_part', { method: 'POST', form })
        progress?.(Math.round((seq + 1) / prepared.block_num * 100))
      }
    } finally { await handle.close() }
    const result = await this.call('/drive/v1/files/upload_finish', { method: 'POST', data: { upload_id: prepared.upload_id, block_num: prepared.block_num } })
    if (!result.file_token) throw failure('飞书未返回上传文件标识', 502)
    await checkpoint(result.file_token)
    return result.file_token
  }
}
