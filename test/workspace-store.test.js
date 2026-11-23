import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkspaceStore } from '../client/workspace-store.js'
import { createWorkspaceDraft, patchWorkspaceDraft, resolveWorkspaceDraft, workspaceAssets } from '../client/workspace.js'
import { emptyWorkspace, registerWorkspaceSources } from '../src/workspace-schema.js'

const item = () => ({ id: 'piece', title: '稿件标题', body: '稿件正文', platform: '小红书' })
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const options = { create: createWorkspaceDraft, resolve: resolveWorkspaceDraft, patch: patchWorkspaceDraft, debounceMs: 60000 }
const fakeWorkspace = (draft, revision) => ({ ...structuredClone(draft), revision, schemaVersion: 1 })

test('保存队列：慢请求期间的后续输入会再次保存，不被旧响应覆盖', async () => {
  const first = deferred()
  const started = deferred()
  const calls = []
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    calls.push(structuredClone(body))
    if (calls.length === 1) { started.resolve(); await first.promise }
    return { workspace: fakeWorkspace(body.draft, body.revision + 1) }
  } })
  const content = item()
  store.get(content)
  store.update(content, { publish: { title: '第一版' } })
  const pending = store.flush(content.id)
  await started.promise
  store.update(content, { publish: { title: '第二版', description: '新的正文' } })
  first.resolve()
  await pending
  await store.flush(content.id)
  assert.deepEqual(calls.map(call => call.draft.publish.title), ['第一版', '第二版'])
  assert.deepEqual(calls.map(call => call.revision), [0, 1])
  assert.equal(store.get(content).draft.publish.description, '新的正文')
  assert.equal(store.get(content).status, 'saved')
})

test('导入与编辑交错：导入结果、新文件夹和用户文案都被保留', async () => {
  const uploading = deferred()
  const imported = deferred()
  let backend
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    backend = fakeWorkspace(body.draft, body.revision + 1)
    return { workspace: backend }
  }, uploadFile: async (_id, file, _folder, revision, progress) => {
    uploading.resolve(); await imported.promise
    progress(95)
    backend = { ...backend, revision: revision + 1, assets: [{ id: 'new-file', name: file.name, type: 'audio', src: 'media-desk/files/a.wav' }], folders: [{ id: 'import_folder', type: 'audio', name: '目录' }] }
    return { workspace: backend }
  } })
  const content = item()
  store.get(content)
  store.update(content, { publish: { title: '导入前' } })
  const task = store.importFiles(content.id, [{ name: 'a.wav' }])
  await uploading.promise
  store.update(content, { publish: { title: '导入期间修改' }, folders: [{ id: 'manual_folder', type: 'video', name: '成片' }] })
  imported.resolve()
  await task
  await store.flush(content.id)
  const entry = store.get(content)
  assert.equal(entry.draft.publish.title, '导入期间修改')
  assert.equal(entry.draft.assets[0].name, 'a.wav')
  assert.deepEqual(entry.draft.folders.map(row => row.id), ['import_folder', 'manual_folder'])
  assert.equal(backend.publish.title, '导入期间修改')
  assert.equal(entry.imports[0].status, 'done')
  assert.equal(entry.imports[0].progress, 100)
})

test('版本冲突保留未保存编辑；用户重新加载后采用服务器版本', async () => {
  let conflict = true
  const content = item()
  const remote = fakeWorkspace(createWorkspaceDraft(content), 4)
  remote.publish.title = '另一窗口标题'
  const store = createWorkspaceStore({ ...options, api: async (path, body) => {
    if (path.startsWith('workspace?')) return { workspace: remote }
    if (conflict) throw Object.assign(new Error('conflict'), { status: 409 })
    return { workspace: fakeWorkspace(body.draft, body.revision + 1) }
  } })
  store.get(content)
  store.update(content, { publish: { title: '本窗口未保存标题' } })
  await assert.rejects(store.flush(content.id), /conflict/)
  assert.equal(store.get(content).draft.publish.title, '本窗口未保存标题')
  assert.equal(store.get(content).conflict, true)
  await store.reload(content.id)
  assert.equal(store.get(content).draft.publish.title, '另一窗口标题')
  assert.equal(store.get(content).revision, 4)
  assert.equal(store.get(content).status, 'saved')
  conflict = false
  store.update(content, { publish: { title: '重新编辑' } })
  await store.flush(content.id)
  assert.equal(store.get(content).revision, 5)
})

test('导入部分失败不会阻止后续文件，取消只停止剩余队列', async () => {
  const content = item()
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => ({ workspace: fakeWorkspace(body.draft, body.revision + 1) }), uploadFile: async (_id, file, _folder, revision) => {
    calls++
    if (file.name === 'bad.wav') throw new Error('bad file')
    entered.resolve(); await release.promise
    return { workspace: { ...createWorkspaceDraft(content), revision: revision + 1, assets: [{ id: 'ok', name: file.name, src: 'media-desk/files/ok.wav', type: 'audio' }] } }
  } })
  store.get(content)
  const task = store.importFiles(content.id, [{ name: 'bad.wav' }, { name: 'ok.wav' }, { name: 'later.wav' }])
  await entered.promise
  store.cancelImport(content.id)
  release.resolve()
  const rows = await task
  assert.equal(calls, 2)
  assert.deepEqual(rows.map(row => row.status), ['failed', 'done', 'cancelled'])
  assert.equal(store.get(content).importing, false)
})

test('持久化草稿初次打开能恢复，来源改动仍只同步未手改字段', () => {
  const content = item()
  content.workspace = fakeWorkspace(createWorkspaceDraft(content), 3)
  content.workspace.publish.title = '手改发布标题'
  content.workspace.publishEdited.title = true
  content.workspace.segments = [{ id: 'clip', title: '片段', seconds: 5, voice: '', prompt: '完整提示词', image: '' }]
  const store = createWorkspaceStore(options)
  const entry = store.get(content)
  const updated = { ...content, production: { title: '新版稿件', article: '新版正文' } }
  const current = resolveWorkspaceDraft(updated, store.get(updated).draft)
  assert.equal(entry.revision, 3)
  assert.equal(current.publish.title, '手改发布标题')
  assert.equal(current.publish.description, '新版正文')
  assert.deepEqual(current.publishChanges, ['title'])
  assert.equal(current.segments[0].prompt, '完整提示词')
  assert.strictEqual(store.get(updated), store.get(updated), 'getSnapshot 引用保持稳定')
})

test('重新加载期间的新输入保留为未保存草稿，中止本次加载后可再次重试', async () => {
  const content = item()
  const started = deferred()
  const response = deferred()
  const remote = fakeWorkspace(createWorkspaceDraft(content), 4)
  remote.publish.title = '另一窗口标题'
  let slow = true
  const store = createWorkspaceStore({ ...options, api: async path => {
    assert.ok(path.startsWith('workspace?'))
    if (slow) { started.resolve(); await response.promise }
    return { workspace: remote }
  } })
  store.get(content)
  store.update(content, { publish: { title: '加载前编辑' } })
  const task = store.reload(content.id)
  await started.promise
  store.update(content, { publish: { title: '加载期间的新输入' } })
  response.resolve()
  await assert.rejects(task, /已保留草稿/)
  const entry = store.get(content)
  assert.equal(entry.draft.publish.title, '加载期间的新输入')
  assert.notEqual(entry.version, entry.savedVersion)
  assert.equal(entry.status, 'error')
  assert.equal(entry.conflict, true)
  assert.equal(entry.revision, 0)
  slow = false
  await store.reload(content.id)
  assert.equal(store.get(content).draft.publish.title, '另一窗口标题')
  assert.equal(store.get(content).status, 'saved')
})

test('上传确认后草稿保存失败：保留导入成功状态，停止剩余文件，重试仅保存草稿', async () => {
  const content = item()
  const started = deferred()
  const response = deferred()
  let failSave = true
  let uploads = 0
  let backend
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    if (failSave) throw Object.assign(new Error('保存暂不可用'), { status: 503 })
    backend = fakeWorkspace(body.draft, body.revision + 1)
    return { workspace: backend }
  }, uploadFile: async () => { uploads++; started.resolve(); return response.promise } })
  store.get(content)
  const task = store.importFiles(content.id, [{ name: 'ok.wav' }, { name: 'later.wav' }])
  await started.promise
  store.update(content, { publish: { title: '导入期间输入' } })
  response.resolve({ workspace: { ...createWorkspaceDraft(content), revision: 1, assets: [{ id: 'imported', name: 'ok.wav', src: 'media-desk/files/ok.wav', type: 'audio' }] } })
  const rows = await task
  assert.deepEqual(rows.map(row => row.status), ['done', 'cancelled'])
  assert.equal(rows[0].progress, 100)
  assert.equal(rows[0].error, '')
  assert.equal(store.get(content).draft.assets.length, 1)
  assert.equal(store.get(content).status, 'error')
  failSave = false
  await store.flush(content.id)
  assert.equal(uploads, 1)
  assert.equal(backend.publish.title, '导入期间输入')
  assert.equal(backend.assets.length, 1)
})

test('连续重画同一修订号：合并轮询登记，保留所有历史文件和未保存的编辑', async () => {
  const content = { ...item(), production: { cover: { src: 'media-desk/files/a.png' } } }
  content.workspace = emptyWorkspace(content)
  content.workspace.revision = 1
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => ({ workspace: fakeWorkspace(body.draft, body.revision + 1) }) })
  store.get(content)
  store.update(content, { publish: { title: '未保存的发布标题' } })
  for (const version of ['b', 'c']) {
    content.production = { cover: { src: `media-desk/files/${version}.png` } }
    registerWorkspaceSources(content)
    const entry = store.get({ ...content, workspace: structuredClone(content.workspace) })
    assert.equal(entry.draft.publish.title, '未保存的发布标题')
    assert.equal(entry.revision, 1)
    assert.strictEqual(store.get(content), store.get(content), '重复快照保持稳定')
  }
  const entry = store.get(content)
  assert.deepEqual(workspaceAssets(content, entry.draft).map(asset => asset.src).sort(), ['a', 'b', 'c'].map(v => `media-desk/files/${v}.png`))
  await store.flush(content.id)
  assert.equal(store.get(content).draft.assets.length, 3)
})

test('轮询跨过一个生成版本时仍接收完整素材登记', () => {
  const content = { ...item(), production: { cover: { src: 'media-desk/files/a.png' } } }
  content.workspace = emptyWorkspace(content)
  const store = createWorkspaceStore(options)
  store.get(content)
  for (const version of ['b', 'c']) {
    content.production = { cover: { src: `media-desk/files/${version}.png` } }
    registerWorkspaceSources(content)
  }
  const entry = store.get(content)
  assert.equal(entry.draft.assets.length, 3)
  assert.equal(entry.status, 'saved')
})

test('旧后端成功响应丢弃提示词时保留输入并报错，更新服务后可按新修订重试', async () => {
  const content = item()
  let outdated = true
  const revisions = []
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    revisions.push(body.revision)
    const workspace = fakeWorkspace(body.draft, body.revision + 1)
    if (outdated) delete workspace.promptText
    return { workspace }
  } })
  const promptText = '全局视频参数：\n角色设定：关关\n\n【第1段 - 13.3秒】\n镜头一：|近景|3.8秒|画面|台词|音效'
  store.update(content, { promptText })
  await assert.rejects(store.flush(content.id), /已保留输入/)
  assert.equal(store.get(content).draft.promptText, promptText)
  assert.equal(store.get(content).status, 'error')
  assert.notEqual(store.get(content).version, store.get(content).savedVersion)
  outdated = false
  await store.flush(content.id)
  assert.deepEqual(revisions, [0, 1])
  assert.equal(store.get(content).draft.promptText, promptText)
  assert.equal(store.get(content).status, 'saved')
})

test('旧后端未保存浏览器发布方式时保留选择并提示更新服务', async () => {
  const content = item()
  let outdated = true
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    const workspace = fakeWorkspace(body.draft, body.revision + 1)
    if (outdated) workspace.publish.provider = 'api'
    return { workspace }
  } })
  store.update(content, { publish: { provider: 'maitian', mode: 'now' } })
  await assert.rejects(store.flush(content.id), /服务端未完整保存发布方式/)
  assert.equal(store.get(content).draft.publish.provider, 'maitian')
  assert.equal(store.get(content).draft.publish.mode, 'now')
  assert.equal(store.get(content).status, 'error')
  outdated = false
  await store.flush(content.id)
  assert.equal(store.get(content).draft.publish.provider, 'maitian')
  assert.equal(store.get(content).status, 'saved')
})

test('提示词保存遇到旧版截断或置空响应时也保留完整原文', async () => {
  for (const returned of [null, '', '全局视频参数：']) {
    const content = item()
    const store = createWorkspaceStore({ ...options, api: async (_path, body) => ({ workspace: { ...fakeWorkspace(body.draft, 1), promptText: returned } }) })
    const promptText = '全局视频参数：\n视觉风格：自然\n【第1段 - 13.3秒】\n镜头一：原文'
    store.update(content, { promptText })
    await assert.rejects(store.flush(content.id), /已保留输入/)
    assert.equal(store.get(content).draft.promptText, promptText)
  }
})

test('封面提示词独立保存，旧后端丢字段时保留原文并允许重试', async () => {
  const content = item()
  let outdated = true
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    const workspace = fakeWorkspace(body.draft, body.revision + 1)
    if (outdated) delete workspace.coverPromptText
    return { workspace }
  } })
  const coverPromptText = '竖版封面\n人物在右，左侧标题\n保留原始换行与标点。'
  store.update(content, { promptText: '视频提示词原文', coverPromptText })
  await assert.rejects(store.flush(content.id), /未完整保存封面提示词/)
  assert.equal(store.get(content).draft.coverPromptText, coverPromptText)
  assert.equal(store.get(content).draft.promptText, '视频提示词原文')
  outdated = false
  await store.flush(content.id)
  assert.equal(store.get(content).status, 'saved')
  const restarted = createWorkspaceStore(options)
  const reopened = restarted.get({ ...content, workspace: store.get(content).draft })
  assert.equal(reopened.draft.coverPromptText, coverPromptText)
  assert.equal(reopened.draft.promptText, '视频提示词原文')
  store.update(content, { coverPromptText: '' })
  await store.flush(content.id)
  assert.equal(store.get(content).draft.coverPromptText, '')
})

test('素材快照：普通编辑不重新扫描同一批文件，同修订号的素材更新仍会生效', async () => {
  const content = item()
  let reads = 0
  const asset = { id: 'img', type: 'image', get name() { reads++; return '原图' }, src: 'media-desk/files/first.png' }
  content.workspace = { ...emptyWorkspace(content), assets: [asset] }
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => ({ workspace: fakeWorkspace(body.draft, body.revision + 1) }) })
  store.get(content)
  store.update(content, { publish: { title: '正在输入' } })
  const before = reads
  const edited = store.get(content)
  assert.strictEqual(store.get(content), edited)
  assert.equal(reads, before, 'React 重读快照不重新遍历素材')
  const updated = { ...content, workspace: { ...content.workspace, assets: [{ ...asset, name: '更新的图片' }] } }
  const merged = store.get(updated)
  assert.equal(merged.draft.assets[0].name, '更新的图片')
  assert.equal(merged.draft.publish.title, '正在输入')
  await store.flush(content.id)
  assert.equal(store.get(updated).status, 'saved')
})

test('切换存储前立即写入所有待保存的稿件，不等待防抖计时器', async () => {
  const calls = []
  const store = createWorkspaceStore({ ...options, api: async (_path, body) => {
    calls.push(body.id)
    return { workspace: fakeWorkspace(body.draft, body.revision + 1) }
  } })
  const contents = [{ ...item(), id: 'edited-one' }, { ...item(), id: 'edited-two' }, { ...item(), id: 'unchanged' }]
  for (const content of contents) store.get(content)
  for (const content of contents.slice(0, 2)) store.update(content, { publish: { title: content.id } })
  await store.flushAll()
  assert.deepEqual(calls.sort(), ['edited-one', 'edited-two'])
  assert.ok(contents.every(content => store.get(content).status === 'saved'))
})
