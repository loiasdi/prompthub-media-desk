import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const compiled = await build({ stdin: { contents: "export { MaitianPrepare } from './client/maitian-prepare.jsx'; export { MaitianExport, useMaitianBundle, MaitianExportConsole } from './client/maitian-publish.jsx'; export { PublishMethod, publishMethod } from './client/publish-method.jsx'; export { PublishPage } from './client/content-workspace.jsx'; export { setLanguagePreference } from './client/i18n.js'", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'], plugins: [{ name: 'workspace-actions', setup(build) {
    build.onResolve({ filter: /^\.\/workspace\.js$/ }, args => /\/client\/maitian-(?:prepare|publish)\.jsx$/.test(args.importer) ? { path: 'workspace', namespace: 'maitian-form-test' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'maitian-form-test' }, () => ({ contents: `export const prepareMaitianPublish = (...a) => globalThis.__form.prepare(...a); export const flushWorkspace = (...a) => globalThis.__form.flush(...a); export const exportMaitianProject = (...a) => globalThis.__form.export(...a); export const formatBytes = n => n + ' bytes';` }))
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { MaitianPrepare, MaitianExport, useMaitianBundle, MaitianExportConsole, PublishMethod, publishMethod, PublishPage, setLanguagePreference } = module.exports
const digest = 'a'.repeat(64), taskId = 'aabbccdd-0000-4000-8000-112233445566'
const text = renderer => JSON.stringify(renderer.toJSON())
const button = (renderer, label) => renderer.root.findAllByType('button').find(node => node.children.includes(label))
const nodeText = node => typeof node === 'string' ? node : node.children.map(nodeText).join('')
const input = (renderer, label, type = 'input') => renderer.root.findAllByType('label').find(node => nodeText(node).includes(label)).findByType(type)
const fill = (renderer, label, value) => act(async () => input(renderer, label).props.onChange({ target: { value, checked: value } }))
const props = () => ({ item: { id: 'piece' }, draft: { selectedVideo: 'video', selectedCover: '', imageIds: [], publishChanges: [], publish: { provider: 'maitian', mode: 'now', platform: '小红书', format: 'video', title: '当前草稿', description: '草稿正文', tags: '#话题', browser: { profileId: 'default', covers: {}, shortTitle: '' } } },
  assets: [{ id: 'video', type: 'video', src: 'media-desk/files/piece/video.mp4', bytes: 100, sha256: digest }], platform: 'xhs',
  config: { enabled: true, profileId: 'default', implementation: { prepare: true, directFill: true } },
  preflight: { operationId: taskId, platform: 'xhs', ok: true, checkedAt: new Date().toISOString() }, disabled: false, locked: false, statusKnown: true })
const preparation = (extra = {}) => ({ preparation: { provider: 'maitian', status: 'prepared', taskId, projectDigest: digest, platform: 'xhs', profileId: 'default', engineVersion: '1.2.3', expiresAt: Date.now() + 180_000,
  account: { label: '人工账号', verification: 'user-confirmed', identityLimitAcknowledged: true }, draft: { title: '服务端固定标题', description: '服务端固定正文', tags: '#服务端话题', shortTitle: '短标题', mode: 'now' },
  assets: [{ id: 'video', filename: '成片.mp4', sizeBytes: 100, digest }], warnings: ['上游原始中文提示'], limits: { fillTimeoutMinutes: 360 }, ...extra } })

function BundleView(props) {
  const bundle = useMaitianBundle(props)
  return React.createElement(MaitianExportConsole, { bundle })
}
async function render(t, initial = props()) {
  const before = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  const calls = [], errors = []
  globalThis.__form = { prepare: async (...a) => { calls.push(['prepare', ...a]); return preparation() }, flush: async (...a) => { calls.push(['flush', ...a]) } }
  let renderer
  const value = { ...initial, request: async (...a) => calls.push(['request', ...a]), refresh: async () => { calls.push(['refresh']) },
    perform: async (_op, action) => { try { await action(() => true) } catch (error) { errors.push(error.message) } } }
  await act(async () => { renderer = TestRenderer.create(React.createElement(MaitianPrepare, value)) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before; delete globalThis.__form; setLanguagePreference('zh') })
  return { renderer, value, calls, errors, update: async patch => { Object.assign(value, patch); await act(async () => renderer.update(React.createElement(MaitianPrepare, value))) } }
}

test('选择视频号时短标题为必填，填写后才允许生成工程', async t => {
  const initial = props()
  const value = { ...initial, publishing: { lockedPlatforms: {} }, update() {} }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(BundleView, value)) })
  t.after(async () => act(async () => renderer.unmount()))
  assert.equal(button(renderer, '校验并生成麦田工程包').props.disabled, true)
  assert.match(text(renderer), /勾选视频号时请填写短标题/)
  const draft = { ...value.draft, publish: { ...value.draft.publish, browser: { ...value.draft.publish.browser, shortTitle: '视频号标题' } } }
  await act(async () => renderer.update(React.createElement(BundleView, { ...value, draft })))
  assert.equal(button(renderer, '校验并生成麦田工程包').props.disabled, false)
})

test('多平台面板在保存归一化重排字段后仍接收迟到导出结果', async t => {
  const initial = props()
  initial.draft.publish.browser.shortTitle = '有效视频号短标题'
  const value = { ...initial, publishing: { lockedPlatforms: {} }, update() {} }
  let settle, renderer
  globalThis.__form = { export: () => new Promise(resolve => { settle = resolve }) }
  await act(async () => { renderer = TestRenderer.create(React.createElement(BundleView, value)) })
  t.after(async () => { await act(async () => renderer.unmount()); delete globalThis.__form })
  await act(async () => { button(renderer, '校验并生成麦田工程包').props.onClick() })
  const normalized = { ...value.draft, publish: Object.fromEntries(Object.entries(value.draft.publish).reverse()) }
  await act(async () => renderer.update(React.createElement(BundleView, { ...value, draft: normalized })))
  await act(async () => settle({ downloadPath: '/normalized-bundle', warnings: [] }))
  assert.equal(renderer.root.findByType('a').props.href, '/normalized-bundle')
})
async function confirmAccount(renderer) {
  await fill(renderer, '目标账号标签', '人工账号')
  await fill(renderer, '我已在专用 Chrome 核对本次目标账号', true)
  await fill(renderer, '我理解登录预检不能验证账号身份', true)
}

test('发布方式区分 provider 与时间，旧手动草稿不自动变为 API，预约浏览器不被覆盖', async t => {
  assert.equal(publishMethod({ mode: 'manual' }), 'manual')
  assert.equal(publishMethod({ mode: 'now' }), 'api')
  assert.equal(publishMethod({ mode: 'scheduled', provider: 'maitian' }), 'maitian')
  const initial = props().draft.publish, changes = []
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(PublishMethod, { id: 'piece', publish: { ...initial, mode: 'scheduled' }, patch: value => changes.push(value) })) })
  t.after(async () => act(async () => renderer.unmount()))
  const radio = value => renderer.root.findAllByType('input').find(node => node.props.value === value)
  await act(async () => radio('maitian').props.onChange())
  assert.deepEqual(changes.at(-1), { provider: 'maitian', mode: 'scheduled' })
  await act(async () => radio('api').props.onChange())
  assert.deepEqual(changes.at(-1), { provider: 'api', mode: 'now' })
  await act(async () => radio('manual').props.onChange())
  assert.deepEqual(changes.at(-1), { provider: 'api', mode: 'manual' })
  await act(async () => renderer.update(React.createElement(PublishMethod, { id: 'piece', publish: { ...initial, platform: 'B站' }, patch() {} })))
  assert.equal(radio('maitian').props.disabled, false)
  await act(async () => renderer.update(React.createElement(PublishMethod, { id: 'piece', publish: { ...initial, platform: '快手' }, patch() {} })))
  assert.equal(radio('maitian').props.disabled, true)
})

test('浏览器准备需要近期预检、两项账号确认、防重已知及无已有任务；改账号需重新确认', async t => {
  const { renderer, update } = await render(t)
  assert.equal(button(renderer, '检查并准备浏览器填写').props.disabled, true)
  await confirmAccount(renderer)
  assert.equal(button(renderer, '检查并准备浏览器填写').props.disabled, false)
  for (const patch of [{ locked: true }, { statusKnown: false }, { disabled: true }, { preflight: { ...props().preflight, checkedAt: new Date(Date.now() - 301_000).toISOString() } }]) {
    const fresh = props()
    await update(patch)
    assert.equal(button(renderer, '检查并准备浏览器填写').props.disabled, true)
    await update({ ...fresh }); await confirmAccount(renderer)
  }
  await fill(renderer, '目标账号标签', '另一账号')
  assert.equal(input(renderer, '我已在专用 Chrome 核对本次目标账号').props.checked, false)
  assert.equal(button(renderer, '检查并准备浏览器填写').props.disabled, true)
})

test('确认单显示服务端固定内容、实际字节摘要及上游原文，明确确认后先保存再发送任务与摘要', async t => {
  const { renderer, calls, errors } = await render(t)
  await confirmAccount(renderer)
  await act(async () => button(renderer, '检查并准备浏览器填写').props.onClick())
  assert.deepEqual(calls[0], ['prepare', 'piece', 'xhs', { label: '人工账号', confirmed: true, identityLimitAcknowledged: true, preflightOperationId: taskId }])
  assert.match(text(renderer), /服务端固定标题/)
  assert.match(text(renderer), /服务端固定正文/)
  assert.match(text(renderer), /上游原始中文提示/)
  assert.match(text(renderer), /SHA-256/)
  assert.equal(button(renderer, '确认并开始填写').props.disabled, true)
  await fill(renderer, '我已核对以上内容', true)
  assert.equal(button(renderer, '确认并开始填写').props.disabled, false)
  await act(async () => button(renderer, '确认并开始填写').props.onClick())
  assert.deepEqual(calls.slice(-3), [['flush', 'piece'], ['request', 'start', { id: 'piece', taskId, projectDigest: digest, confirmed: true }], ['refresh']])
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.deepEqual(errors, [])
})

test('尚未通过真实平台验收时可准备但不能启动；预约展示原时区、UTC及平台提交限制', async t => {
  const initial = props()
  initial.config.implementation.directFill = false
  initial.draft.publish.mode = 'scheduled'
  const { renderer, calls } = await render(t, initial)
  globalThis.__form.prepare = async () => preparation({ draft: { title: '服务端标题', description: '正文', tags: '', mode: 'scheduled', when: '2026-12-01T19:00', timezone: 'Asia/Shanghai', schedule: '2026-12-01T11:00:00.000Z' } })
  await confirmAccount(renderer)
  await act(async () => button(renderer, '检查并准备浏览器填写').props.onClick())
  assert.match(text(renderer), /尚未通过真实平台验收/)
  assert.match(text(renderer), /2026-12-01T19:00/)
  assert.match(text(renderer), /Asia\/Shanghai/)
  assert.match(text(renderer), /2026-12-01T11:00:00.000Z/)
  assert.match(text(renderer), /仍需在平台确认提交/)
  await fill(renderer, '我已核对以上内容', true)
  await act(async () => button(renderer, '确认并开始填写').props.onClick())
  assert.equal(button(renderer, '确认并开始填写').props.disabled, true)
  assert.equal(calls.some(row => row[0] === 'request'), false)
})

test('稿件、组件配置或媒体变化使确认失效；准备期间迟到结果不能重新打开旧确认单', async t => {
  const { renderer, value, update, calls } = await render(t)
  await confirmAccount(renderer)
  await act(async () => button(renderer, '检查并准备浏览器填写').props.onClick())
  await update({ assets: value.assets.map(asset => ({ ...asset, sha256: 'b'.repeat(64) })) })
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.equal(input(renderer, '我已在专用 Chrome 核对本次目标账号').props.checked, false)
  await confirmAccount(renderer)
  let release
  globalThis.__form.prepare = () => new Promise(resolve => { release = resolve })
  let pending
  await act(async () => { pending = button(renderer, '检查并准备浏览器填写').props.onClick() })
  await update({ config: { ...value.config, fillTimeoutMinutes: 480 } })
  await act(async () => { release(preparation()); await pending })
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.equal(calls.some(row => row[0] === 'request'), false)
})

test('过期确认单不能启动；开始前等待保存期间文案变化也不发送 start', async t => {
  const { renderer, value, update, calls, errors } = await render(t)
  globalThis.__form.prepare = async () => preparation({ expiresAt: Date.now() - 1 })
  await confirmAccount(renderer)
  await act(async () => button(renderer, '检查并准备浏览器填写').props.onClick())
  assert.match(text(renderer), /确认单已过期/)
  assert.equal(button(renderer, '确认并开始填写').props.disabled, true)
  await act(async () => button(renderer, '返回修改').props.onClick())
  globalThis.__form.prepare = async () => preparation()
  await act(async () => button(renderer, '检查并准备浏览器填写').props.onClick())
  await fill(renderer, '我已核对以上内容', true)
  let release, pending
  globalThis.__form.flush = () => new Promise(resolve => { release = resolve })
  await act(async () => { pending = button(renderer, '确认并开始填写').props.onClick() })
  await update({ draft: { ...value.draft, publish: { ...value.draft.publish, title: '保存期间改稿' } } })
  await act(async () => { release(); await pending })
  assert.equal(calls.some(row => row[0] === 'request'), false)
  assert.match(errors.at(-1), /发布信息已变化/)
})

test('不完整确认单响应不能显示开始按钮；英文界面保留上游原文', async t => {
  const { renderer, errors, update } = await render(t)
  await confirmAccount(renderer)
  globalThis.__form.prepare = async () => preparation({ platform: 'channels' })
  await act(async () => button(renderer, '检查并准备浏览器填写').props.onClick())
  assert.match(errors.at(-1), /确认单响应不完整/)
  assert.equal(button(renderer, '确认并开始填写'), undefined)
  globalThis.__form.prepare = async () => preparation()
  setLanguagePreference('en')
  await update({})
  await act(async () => button(renderer, 'Check and prepare browser filling').props.onClick())
  assert.match(text(renderer), /Target account \(user confirmed\)/)
  assert.match(text(renderer), /上游原始中文提示/)
  assert.ok(button(renderer, 'Confirm and start filling'))
})

test('真实发布页支持两步流程：麦田模式不读 API 账号参数，切到 API 后展示投稿入口', async t => {
  const calls = [], before = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url))
    if (url.includes('maitian/config')) return Response.json({ enabled: false, profileId: 'default', port: 9333, source: 'store', diagnostic: {}, implementation: { prepare: true, directFill: false } })
    if (url.includes('status?')) return Response.json({ platforms: { bilibili: true }, jobs: [], lockedPlatforms: {} })
    return Response.json({ account: 'API 测试账号', categories: [] })
  })
  const initial = props(), publish = { ...initial.draft.publish, platform: 'B站' }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(PublishPage, { ...initial, draft: { ...initial.draft, publish }, update() {}, onTab() {}, syncPublish() {} })) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before })
  assert.equal(calls.some(url => url.includes('options?')), false)
  assert.ok(button(renderer, '下一步：选择发布渠道'))
  await act(async () => button(renderer, '下一步：选择发布渠道').props.onClick())
  assert.equal(button(renderer, '检查并准备发布'), undefined)
  assert.doesNotMatch(text(renderer), /稿件类型/)
  assert.match(text(renderer), /选择麦田打包平台/)
  assert.ok(button(renderer, '麦田设置'))
  await act(async () => renderer.update(React.createElement(PublishPage, { ...initial, draft: { ...initial.draft, publish: { ...publish, provider: 'api' } }, update() {}, onTab() {}, syncPublish() {} })))
  assert.equal(calls.some(url => url.includes('options?platform=bilibili')), true)
  assert.ok(button(renderer, '检查并准备发布'))
})

test('完整麦田表单阻止重复准备与重复开始，切换稿件后不展示迟到确认单', async t => {
  const before = globalThis.window, calls = []
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  const initial = props()
  let release, startRelease, renderer, prepares = 0
  globalThis.__form = { prepare: () => { prepares++; return new Promise(resolve => { release = resolve }) }, flush: async () => {}, export: async () => ({}) }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url))
    if (url.endsWith('config')) return Response.json({ ...initial.config, source: 'store', port: 9333, diagnostic: {} })
    if (url.endsWith('start')) { await new Promise(resolve => { startRelease = resolve }); return Response.json({ job: { status: 'queued' } }) }
    return Response.json(initial.preflight)
  })
  const value = { ...initial, update() {}, publishing: { known: true, lockedPlatforms: {}, refresh: async () => {} } }
  await act(async () => { renderer = TestRenderer.create(React.createElement(MaitianExport, value)) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before; delete globalThis.__form })
  await act(async () => button(renderer, '检查平台登录').props.onClick())
  await confirmAccount(renderer)
  const prepare = button(renderer, '检查并准备浏览器填写').props.onClick
  let first, second
  await act(async () => { first = prepare(); second = prepare() })
  assert.equal(prepares, 1)
  await act(async () => { release(preparation()); await Promise.all([first, second]) })
  await fill(renderer, '我已核对以上内容', true)
  const start = button(renderer, '确认并开始填写').props.onClick
  await act(async () => { first = start(); second = start() })
  assert.equal(calls.filter(url => url.endsWith('start')).length, 1)
  await act(async () => { startRelease(); await Promise.all([first, second]) })
  const again = button(renderer, '检查并准备浏览器填写').props.onClick
  await act(async () => { first = again() })
  await act(async () => renderer.update(React.createElement(MaitianExport, { ...value, item: { id: 'other' } })))
  await act(async () => { release(preparation()); await first })
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
})

test('发布页展示七个麦田平台，勾选 YouTube 后选择 16:9 封面并连同平台列表导出', async t => {
  const before = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ platforms: {}, jobs: [], lockedPlatforms: {} }))
  const initial = props()
  initial.assets.push({ id: 'wide', type: 'image', name: '宽屏封面.jpg', src: 'wide.jpg' })
  let exported, renderer
  globalThis.__form = { export: async (...args) => { exported = args; return { downloadPath: '/bundle', warnings: [] } } }
  function Page() {
    const [draft, setDraft] = React.useState(initial.draft)
    return React.createElement(PublishPage, { ...initial, draft, initialStep: 'channel', update: patch => setDraft(previous => ({ ...previous, ...patch })), onTab() {}, syncPublish() {} })
  }
  await act(async () => { renderer = TestRenderer.create(React.createElement(Page)) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before; delete globalThis.__form })
  const platforms = renderer.root.findByProps({ className: 'md-maitian-platforms' }).findAllByType('label')
  assert.deepEqual(platforms.map(label => nodeText(label.findByType('strong'))), ['B站', '小红书', '抖音', '视频号', 'YouTube', 'X', 'Instagram'])
  await act(async () => platforms[4].findByType('input').props.onChange())
  const wide = renderer.root.findAllByType('label').find(label => /工程封面\s*16x9/.test(nodeText(label)))
  assert.ok(wide)
  await act(async () => wide.findByType('select').props.onChange({ target: { value: 'wide' } }))
  assert.equal(wide.findByType('select').props.value, 'wide')
  await act(async () => button(renderer, '校验并生成麦田工程包').props.onClick())
  assert.deepEqual(exported, ['piece', ['xhs', 'channels', 'youtube'], false])
  assert.ok(renderer.root.findByType('a'))
})

test('直驱目标平台可独立于稿件平台选择', async t => {
  const before = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  t.mock.method(globalThis, 'fetch', async url => url.includes('maitian/config')
    ? Response.json({ enabled: false, profileId: 'default', port: 9333, source: 'store', diagnostic: {}, implementation: { prepare: true, directFill: false } })
    : Response.json({ platforms: {}, jobs: [], lockedPlatforms: {} }))
  const initial = props(), updates = []
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(PublishPage, { ...initial, initialStep: 'channel', update: patch => updates.push(patch), onTab() {}, syncPublish() {} })) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before })
  const settingButton = button(renderer, '麦田设置')
  await act(async () => settingButton.props.onClick())
  const target = renderer.root.findAllByType('label').find(label => /直驱目标平台/.test(nodeText(label))).findByType('select')
  await act(async () => target.props.onChange({ target: { value: 'channels' } }))
  assert.equal(updates.length, 0)
  assert.match(text(renderer), /直驱快照会按选定目标平台生成，不会修改稿件的平台字段/)
})
