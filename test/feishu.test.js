import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { FeishuConfig } from '../src/feishu/config.js'
import { FeishuAPI } from '../src/feishu/api.js'
import { FeishuSync, FIELDS } from '../src/feishu/sync.js'

class FakeAPI {
  constructor() { this.tableFields = []; this.files = new Map([['root', []]]); this.documents = new Map(); this.records = new Map(); this.uploads = 0; this.imageUploads = 0; this.next = 1; this.failRecord = false }
  tablePath() { return '/table' }
  async url(token, type) { return `https://test.feishu.cn/${type}/${token}` }
  async fields() { return structuredClone(this.tableFields) }
  async listFiles(folder) { return structuredClone(this.files.get(folder) || []) }
  async record(id) { if (!this.records.has(id)) throw Error('记录已删除'); return { record: structuredClone(this.records.get(id)) } }
  async findRecord(key) { return structuredClone([...this.records.values()].find(r => r.fields['工作台ID'] === key) || null) }
  async doc(id) { const d = this.documents.get(id); if (!d) throw Error('文档已删除'); return { document: { document_id: id, title: d.title, revision_id: d.revision } } }
  async blocks(id) { return structuredClone(this.documents.get(id).blocks) }
  async uploadImage() { this.imageUploads++; return 'imageToken' + this.next++ }
  async upload(path, name, size, folder, checkpoint, progress) {
    this.uploads++; const token = 'file' + this.next++
    this.files.get(folder).push({ token, name, type: 'file', url: 'https://www.feishu.cn/file/' + token })
    await checkpoint(token); progress(100); return token
  }
  async call(path, { method, data }) {
    if (path === '/table/fields') { this.tableFields.push({ field_name: data.field_name, type: data.type }); return {} }
    if (path.endsWith('/create_folder')) { const token = 'folder' + this.next++; this.files.set(token, []); this.files.get(data.folder_token).push({ token, name: data.name, type: 'folder' }); return { token } }
    if (path === '/docx/v1/documents') { const id = 'doc' + this.next++; this.documents.set(id, { title: data.title, revision: 1, blocks: [] }); this.files.get(data.folder_token).push({ token: id, name: data.title, type: 'docx' }); return { document: { document_id: id } } }
    if (path.includes('/children')) {
      const id = path.split('/')[4], doc = this.documents.get(id)
      assert.equal(Number(new URL('https://x'+path).searchParams.get('document_revision_id')), doc.revision)
      let children
      if (method === 'POST') { children = data.children.map(b => ({ ...b, block_id: 'block' + this.next++ })); doc.blocks.splice(data.index === -1 ? doc.blocks.length : data.index, 0, ...children) }
      else doc.blocks.splice(data.start_index, data.end_index - data.start_index)
      doc.revision++; return { document_revision_id: doc.revision, children }
    }
    if (path.includes('/blocks/') && method === 'PATCH') {
      const id = path.split('/')[4], doc = this.documents.get(id), blockId = path.split('/')[6].split('?')[0]
      assert.equal(Number(new URL('https://x'+path).searchParams.get('document_revision_id')), doc.revision)
      const target = doc.blocks.find(b => b.block_id === blockId)
      if (data.replace_image) target.image = { token: data.replace_image.token }
      if (data.update_text_elements) target.text = data.update_text_elements
      doc.revision++; return { document_revision_id: doc.revision }
    }
    if (path.startsWith('/table/records')) {
      if (this.failRecord) { this.failRecord = false; throw Error('模拟表格写入失败') }
      const id = method === 'PUT' ? path.split('/').pop() : 'rec' + this.next++
      const record = { record_id: id, fields: structuredClone(data.fields) }; this.records.set(id, record); return { record }
    }
    throw Error('未知测试路径 '+path)
  }
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'desk-feishu-'))
  try {
    const config = new FeishuConfig(join(root, 'private'))
    await config.save({ appId: 'cli_test', appSecret: 'secret-value', folderToken: 'root', appToken: 'base', tableId: 'table' })
    const store = new Store(join(root, 'content'))
    await store.mutate('', s => { s.items = [{ id: 'piece', title: '稿件', status: 'draft', production: { title: '我的标题', article: '正文', description: '简介', topics: '#AI' }, workspace: { schemaVersion: 1, revision: 0, promptText: '全局参数\n视频提示词', hidden: [], coverDesign: { variants: { '3:4': { prompt: '封面词' } } }, assets: [{ id: 'image', src: 'media-desk/files/a.png', name: '参考图.png', type: 'image' }, { id: 'video', src: 'media-desk/files/v.mp4', name: '视频.mp4', type: 'video' }] } }] }, { undoable: false })
    await writeFile(join(store.filesDir, 'a.png'), 'image bytes'); await writeFile(join(store.filesDir, 'v.mp4'), 'video bytes')
    const api = new FakeAPI(), sync = new FeishuSync(store, { config, apiFactory: () => api })
    const run = async (p, ids = ['image','video'], overwrite = false) => {
      const job = sync.start({ token: p.token, assetIds: ids, overwrite })
      while (job.status === 'running') await new Promise(resolve => setTimeout(resolve, 5))
      return job
    }
    await fn({ root, config, store, api, sync, run })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('飞书配置在独立目录保存，密钥不返回浏览器且不被空值清除', () => fixture(async ({ config }) => {
  assert.equal(config.public(await config.read()).hasSecret, true)
  assert.equal(JSON.stringify(config.public(await config.read())).includes('secret-value'), false)
  assert.equal((await stat(config.file)).mode & 0o777, 0o600)
  await config.save({ appSecret: '', folderToken: 'root' })
  assert.equal((await config.read()).appSecret, 'secret-value')
  await assert.rejects(config.save({ tableId: 'https://bad.example/' }), /格式无效/)
}))

test('飞书首次同步、同内容复用、只改文案不重传视频、改名复用和文件变化重传', () => fixture(async ({ sync, run, api, store }) => {
  let preview = await sync.preview('piece')
  assert.equal(api.documents.size, 0); assert.equal(api.uploads, 0); assert.equal(preview.missingFields.length, 6)
  assert.equal((await run(preview)).status, 'done')
  assert.equal(api.uploads, 2); assert.equal(api.records.size, 1); assert.equal(api.documents.size, 1)
  preview = await sync.preview('piece')
  assert.equal(preview.remoteEdited, false); assert.equal(preview.textAction, 'reuse'); assert.ok(preview.assets.every(a => a.action === 'reuse'))
  await store.mutate('', s => { s.items[0].production.description = '新简介'; s.items[0].workspace.assets[1].name = '视频改名.mp4' }, { undoable: false })
  preview = await sync.preview('piece')
  assert.equal((await run(preview)).status, 'done'); assert.equal(api.uploads, 2); assert.equal(api.records.size, 1)
  assert.ok([...api.documents.values()][0].blocks.some(b => b.text?.elements[0]?.text_run.content.includes('新简介')))
  await writeFile(join(store.filesDir, 'v.mp4'), 'new video bytes')
  preview = await sync.preview('piece'); assert.equal(preview.assets.find(a => a.id === 'video').action, 'update')
  const job = await run(preview); assert.equal(job.status, 'done'); assert.equal(job.uploaded, 1); assert.equal(job.reused, 1); assert.equal(api.uploads, 3)
}))

test('飞书预览后本地变化与远端变化均拒绝执行，外部编辑需明确覆盖', () => fixture(async ({ sync, run, api, store }) => {
  let preview = await sync.preview('piece')
  await store.mutate('', s => { s.items[0].production.article = '新正文' }, { undoable: false })
  let job = await run(preview); assert.equal(job.status, 'error'); assert.match(job.message, /内容已变化/); assert.equal(api.uploads, 0)
  assert.equal((await run(await sync.preview('piece'))).status, 'done')
  preview = await sync.preview('piece')
  const doc = [...api.documents.values()][0]; doc.revision++; doc.blocks.push({ block_id: 'external', block_type: 2, text: { elements: [{ text_run: { content: '飞书手动编辑' } }] } })
  job = await run(preview); assert.equal(job.status, 'error'); assert.match(job.message, /内容已变化/)
  preview = await sync.preview('piece'); assert.equal(preview.remoteEdited, true); assert.ok(preview.document.text.includes('飞书手动编辑'))
  job = await run(preview); assert.equal(job.status, 'error'); assert.match(job.message, /确认覆盖/)
  job = await run(await sync.preview('piece'), ['image','video'], true); assert.equal(job.status, 'done'); assert.equal(api.uploads, 2)
}))

test('失败重试与服务重建复用已上传文件，不重复创建文档或记录', () => fixture(async ({ sync, run, api, config, store }) => {
  api.failRecord = true
  let job = await run(await sync.preview('piece')); assert.equal(job.status, 'error'); assert.equal(api.uploads, 2)
  const next = new FeishuSync(store, { config, apiFactory: () => api })
  const p = await next.preview('piece')
  assert.ok(p.assets.every(a => a.action === 'reuse'))
  job = next.start({ token: p.token, assetIds: ['image','video'] })
  while (job.status === 'running') await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(job.status, 'done'); assert.equal(api.uploads, 2); assert.equal(api.documents.size, 1); assert.equal(api.records.size, 1)
}))

test('飞书拒绝不兼容字段类型，只同步勾选素材，远端文件缺失重新上传', () => fixture(async ({ sync, run, api }) => {
  api.tableFields = [{ field_name: '标题', type: 3 }]
  await assert.rejects(sync.preview('piece'), /多行文本/)
  api.tableFields = []
  assert.equal((await run(await sync.preview('piece'), ['image'])).status, 'done'); assert.equal(api.uploads, 1)
  const folder = [...api.files.keys()].find(k => k !== 'root')
  api.files.set(folder, api.files.get(folder).filter(f => f.type !== 'file'))
  const p = await sync.preview('piece'); assert.equal(p.assets.find(a => a.id === 'image').action, 'update')
  assert.equal((await run(p, ['image'], true)).status, 'done'); assert.equal(api.uploads, 2)
}))

test('飞书官方分片接口使用认证、分页、空分片响应和限流重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-api-'))
  const calls = []; let limited = true; let savedToken
  try {
    const path = join(root, 'video.mp4'); await writeFile(path, 'abcdefgh')
    const api = new FeishuAPI({ appId: 'cli', appSecret: 'secret' }, { wait: async () => {}, fetchImpl: async (url, opts) => {
      calls.push([url, opts]); const u = new URL(url)
      if (u.pathname.endsWith('/internal')) return Response.json({ code: 0, tenant_access_token: 'tenant', expire: 7200 })
      assert.equal(opts.headers.Authorization, 'Bearer tenant')
      if (u.pathname.endsWith('/upload_prepare')) return Response.json({ code: 0, data: { upload_id: 'upload', block_size: 4, block_num: 2 } })
      if (u.pathname.endsWith('/upload_part')) {
        assert.ok(opts.body instanceof FormData); assert.equal(opts.body.get('size'), '4')
        if (limited) { limited = false; return Response.json({ code: 99991400 }, { status: 429 }) }
        return Response.json({})
      }
      if (u.pathname.endsWith('/upload_finish')) return Response.json({ code: 0, data: { file_token: 'token' } })
      if (u.pathname.endsWith('/files')) return Response.json({ code: 0, data: { files: [{ token: u.searchParams.has('page_token') ? 'second' : 'first' }], has_more: !u.searchParams.has('page_token'), next_page_token: 'next' } })
      throw Error('未知接口 '+url)
    } })
    assert.equal(await api.upload(path, 'video.mp4', 8, 'folder', async token => { savedToken = token }), 'token')
    assert.equal(savedToken, 'token')
    assert.equal((await api.listFiles('folder')).length, 2)
    assert.equal(calls.filter(([url]) => url.endsWith('/internal')).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('飞书接口支持预览与任务查询，配置不会暴露密钥，跨站写入被拒绝', () => fixture(async ({ store, sync }) => {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const { route } = await import('../src/host.js')
  const server = createServer((req, res) => { route({}, store, { feishu: sync }, req, res).catch(err => { res.statusCode = err.status || 500; res.end(JSON.stringify({ error: err.message })) }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/media-desk/feishu/`
  try {
    const config = await (await fetch(base+'config')).json()
    assert.equal(config.hasSecret, true); assert.equal(config.appSecret, undefined)
    const denied = await fetch(base+'config', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 403)
    const preview = await (await fetch(base+'preview', { method: 'POST', body: JSON.stringify({ id: 'piece' }) })).json()
    assert.ok(preview.token); assert.equal(preview.assets.length, 2)
    const started = await fetch(base+'sync', { method: 'POST', body: JSON.stringify({ token: preview.token, assetIds: [] }) })
    assert.equal(started.status, 202)
    let job = await started.json()
    while(job.status === 'running') { await new Promise(r => setTimeout(r,5)); job = await(await fetch(base+'job?id='+job.id)).json() }
    assert.equal(job.status, 'done'); assert.equal(job.uploaded, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))

test('飞书认证错误不回显密钥；接口超时不自动重试创建请求', async () => {
  const api = new FeishuAPI({ appId: 'cli', appSecret: 'private-secret' }, { fetchImpl: async () => Response.json({ code: 1, msg: 'bad private-secret' }) })
  await assert.rejects(api.token(), err => !err.message.includes('private-secret') && /认证失败/.test(err.message))
  let writes = 0
  const broken = new FeishuAPI({}, { wait: async () => {}, fetchImpl: async (url) => {
    if(url.endsWith('/internal')) return Response.json({ code: 0, tenant_access_token:'token', expire:7200 })
    writes++; throw Error('network timeout')
  } })
  await assert.rejects(broken.call('/docx/v1/documents', { method: 'POST', data: { title:'test' } }), /timeout/)
  assert.equal(writes, 1)
})

test('飞书同步文档部分写入失败不删旧正文，重试修复后不重复上传', () => fixture(async ({ sync, run, api, store }) => {
  assert.equal((await run(await sync.preview('piece'))).status, 'done')
  const original = api.call.bind(api); let fail = true
  api.call = async (path, opts) => {
    if (path.includes('/batch_delete') && fail) { fail = false; throw Error('模拟文档替换失败') }
    return original(path,opts)
  }
  await store.mutate('', s => { s.items[0].production.article = '新版本正文' }, { undoable: false })
  let job = await run(await sync.preview('piece')); assert.equal(job.status, 'error')
  const doc = [...api.documents.values()][0]
  assert.equal(doc.blocks.filter(b => b.text).length,3); assert.ok(doc.blocks.some(b => b.text?.elements[0]?.text_run.content.includes('正文')))
  job = await run(await sync.preview('piece'),['image','video'],true)
  assert.equal(job.status,'done'); assert.equal(doc.blocks.filter(b => b.block_type === 27).length,1); assert.ok(doc.blocks.some(b => b.text?.elements[0]?.text_run.content.includes('新版本正文')))
  assert.equal(api.uploads,2)
}))


test('飞书默认主字段使用稿件标题，重命名后的主字段也支持且其他列保留', () => fixture(async ({ sync, run, api }) => {
  api.tableFields = [{ field_name: '文本', type: 1, is_primary: true }]
  assert.equal((await run(await sync.preview('piece'), [])).status, 'done')
  const record = [...api.records.values()][0]
  assert.equal(record.fields['文本'], '我的标题')
  api.tableFields[0].field_name = '内容名称'
  assert.equal((await run(await sync.preview('piece'), [])).status, 'done')
  assert.equal([...api.records.values()][0].fields['内容名称'], '我的标题')
}))

test('图片直接内嵌文档，文字更新和文件改名保留图片块且不重复上传', () => fixture(async ({ sync, run, api, store }) => {
  assert.equal((await run(await sync.preview('piece'))).status, 'done')
  const doc = [...api.documents.values()][0]
  const original = doc.blocks.find(b => b.block_type === 27)
  assert.ok(original.image.token)
  assert.equal(api.imageUploads,1)
  await store.mutate('',s => { s.items[0].production.article = '改稿后正文'; s.items[0].workspace.assets[0].name = '新的图片名.png' }, {undoable:false})
  assert.equal((await run(await sync.preview('piece'))).status, 'done')
  const images = doc.blocks.filter(b => b.block_type === 27)
  assert.equal(images.length,1); assert.equal(images[0].block_id,original.block_id)
  assert.equal(api.imageUploads,1); assert.equal(api.uploads,2)
  assert.ok(doc.blocks.some(b => b.text?.elements[0]?.text_run.content.includes('新的图片名.png')))
  assert.ok(doc.blocks[0].text.elements[0].text_run.content.includes('改稿后正文'))
  await writeFile(join(store.filesDir,'a.png'),'changed image')
  assert.equal((await run(await sync.preview('piece'))).status, 'done')
  assert.equal(doc.blocks.filter(b => b.block_type === 27).length,1)
  assert.notEqual(doc.blocks.find(b => b.block_type === 27).block_id,original.block_id)
  assert.equal(api.imageUploads,2); assert.equal(api.uploads,3)
}))

test('文档图片绑定失败可恢复，已上传图片 token 和旧图片都保留', () => fixture(async ({ sync, run, api, store }) => {
  assert.equal((await run(await sync.preview('piece'))).status, 'done')
  const doc = [...api.documents.values()][0], oldId = doc.blocks.find(b=>b.block_type===27).block_id
  await writeFile(join(store.filesDir,'a.png'),'new image bytes')
  const original = api.call.bind(api); let fail = true
  api.call = async (path,options) => { if(options.data?.replace_image && fail) { fail=false; throw Error('绑定图片失败') } return original(path,options) }
  assert.equal((await run(await sync.preview('piece'))).status,'error')
  assert.ok(doc.blocks.some(b=>b.block_id===oldId && b.image.token))
  assert.equal(api.imageUploads,2)
  assert.equal((await run(await sync.preview('piece'),['image','video'],true)).status,'done')
  assert.equal(api.imageUploads,2)
  assert.equal(doc.blocks.filter(b=>b.block_type===27).length,1)
}))

test('飞书图片上传使用 docx_image 和实际图片块 ID，不复用云空间文件 token', async () => {
  const root=await mkdtemp(join(tmpdir(),'feishu-image-'))
  try {
    const path=join(root,'cover.png');await writeFile(path,'image bytes')
    const api=new FeishuAPI({}, {wait:async()=>{},fetchImpl:async(url,options)=>{
      if(url.endsWith('/internal'))return Response.json({code:0,tenant_access_token:'token',expire:7200})
      assert.ok(url.endsWith('/drive/v1/medias/upload_all'))
      assert.equal(options.body.get('parent_type'),'docx_image')
      assert.equal(options.body.get('parent_node'),'image-block-id')
      assert.equal(options.body.get('size'),'11')
      return Response.json({code:0,data:{file_token:'doc-image-token'}})
    }})
    assert.equal(await api.uploadImage(path,'cover.png',11,'image-block-id'),'doc-image-token')
  }finally{await rm(root,{recursive:true,force:true})}
})
