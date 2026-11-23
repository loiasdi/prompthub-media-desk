import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: "export { MaitianExport } from './client/maitian-publish.jsx'; export { setLanguagePreference } from './client/i18n.js'; export { PublishHistory, usePublishing } from './client/publish.jsx'", resolveDir: process.cwd(), loader: 'js' },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
  plugins: [{ name: 'workspace-action', setup(build) {
    build.onResolve({ filter: /^\.\/workspace\.js$/ }, args => args.importer.endsWith('/client/maitian-publish.jsx') ? { path: 'workspace', namespace: 'maitian-test' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'maitian-test' }, () => ({ contents: 'export const exportMaitianProject = (...args) => globalThis.__maitianUIExport(...args)', loader: 'js' }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports)
const { MaitianExport, setLanguagePreference, PublishHistory, usePublishing } = module.exports
const config = (extra = {}) => ({ enabled: false, source: 'store', port: 9333, profileId: 'default', diagnostic: { message: '尚未检测麦田组件' }, implementation: { directFill: false }, ...extra })
const props = () => ({
  item: { id: 'draft' }, assets: [], update() {},
  draft: { selectedVideo: 'video', publish: { platform: '小红书', format: 'video', mode: 'manual', title: '标题', browser: { covers: {}, shortTitle: '' } } },
})
const text = renderer => JSON.stringify(renderer.toJSON())
const button = (renderer, label) => renderer.root.findAllByType('button').find(node => node.children.includes(label))
const nodeText = node => typeof node === 'string' ? node : node.children.map(nodeText).join('')
const input = (renderer, label) => renderer.root.findAllByType('label').find(node => nodeText(node).includes(label)).findByType('input')
async function render(t, handler, initial = props()) {
  t.mock.method(globalThis, 'fetch', handler)
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(MaitianExport, initial)) })
  t.after(async () => { await act(async () => renderer.unmount()); setLanguagePreference('zh'); delete globalThis.__maitianUIExport })
  return renderer
}
const expand = async renderer => { await act(async () => button(renderer, '配置与导出').props.onClick()) }

test('折叠面板不访问 Host；预览拒绝请求或不完整响应不会显示可执行发布入口', async t => {
  let reads = 0
  const renderer = await render(t, async () => { reads++; return Response.json({ error: '独立预览不连接发布平台，请在 DSH 中使用' }, { status: 409 }) })
  assert.equal(reads, 0)
  await expand(renderer)
  assert.equal(reads, 1)
  assert.match(text(renderer), /独立预览不连接发布平台/)
  assert.equal(button(renderer, '在专用 Chrome 安装麦田组件'), undefined)
  assert.equal(button(renderer, '导出麦田工程').props.disabled, false)
  assert.doesNotMatch(text(renderer), /工程导出校验组件目录/)
  await act(async () => button(renderer, '收起').props.onClick())
  t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  await expand(renderer)
  assert.match(text(renderer), /麦田配置响应不完整/)
})

test('未保存的专用浏览器配置阻止浏览器操作，但不阻止工程导出', async t => {
  let saved = config(), posted
  const renderer = await render(t, async (_url, options) => {
    if (options.method === 'POST') { posted = JSON.parse(options.body); saved = config(posted) }
    return Response.json(saved)
  })
  await expand(renderer)
  assert.equal(button(renderer, '在专用 Chrome 安装麦田组件').props.disabled, true)
  await act(async () => input(renderer, '启用本机专用 Chrome').props.onChange({ target: { checked: true } }))
  await act(async () => input(renderer, '独立 Node 可执行文件').props.onChange({ target: { value: '/private/node' } }))
  assert.equal(button(renderer, '在专用 Chrome 安装麦田组件').props.disabled, true)
  assert.equal(button(renderer, '导出麦田工程').props.disabled, false)
  assert.match(text(renderer), /配置有未保存的修改/)
  await act(async () => button(renderer, '保存组件配置').props.onClick())
  assert.equal(posted.enabled, true)
  assert.equal(posted.nodePath, '/private/node')
  assert.equal(input(renderer, '独立 Node 可执行文件').props.value, '')
  assert.equal(button(renderer, '在专用 Chrome 安装麦田组件').props.disabled, false)
})

test('预检结果说明身份限制；打开原页只传操作标识，切换平台清除旧结果', async t => {
  const calls = [], operationId = '00000000-0000-0000-0000-000000000001'
  const initial = props()
  const renderer = await render(t, async (url, options) => {
    calls.push({ url, body: options.body && JSON.parse(options.body) })
    if (url.endsWith('config')) return Response.json(config({ enabled: true }))
    return Response.json({ operationId, canOpenPage: true, ok: true, accountVerification: 'login-only' })
  }, initial)
  await expand(renderer)
  await act(async () => button(renderer, '检查平台登录').props.onClick())
  assert.deepEqual(calls.at(-1).body, { platform: 'xhs' })
  assert.match(text(renderer), /页面可用，请在 Chrome 中核对目标账号/)
  assert.match(text(renderer), /登录预检不验证账号身份/)
  await act(async () => button(renderer, '打开刚才的原页面').props.onClick())
  assert.deepEqual(calls.at(-1).body, { operationId })
  assert.ok(calls.at(-1).url.endsWith('open-page'))
  await act(async () => renderer.update(React.createElement(MaitianExport, { ...initial, draft: { ...initial.draft, publish: { ...initial.draft.publish, platform: '视频号' } } })))
  assert.equal(button(renderer, '打开刚才的原页面'), undefined)
  assert.ok(input(renderer, '视频号短标题'))
  assert.equal(calls.length, 3)
})

test('填写保护时限可配置，未保存时阻断浏览器操作并说明本地限制', async t => {
  let saved = config({ enabled: true, fillTimeoutMinutes: 360 }), posted
  const renderer = await render(t, async (_url, options) => {
    if (options.method === 'POST') { posted = JSON.parse(options.body); saved = config({ ...saved, ...posted }) }
    return Response.json(saved)
  })
  await expand(renderer)
  assert.equal(input(renderer, '填写保护时限（分钟）').props.value, 360)
  assert.match(text(renderer), /并非平台上传时限/)
  await act(async () => input(renderer, '填写保护时限（分钟）').props.onChange({ target: { value: '480' } }))
  assert.equal(button(renderer, '检查平台登录').props.disabled, true)
  await act(async () => button(renderer, '保存组件配置').props.onClick())
  assert.equal(posted.fillTimeoutMinutes, 480)
  assert.equal(button(renderer, '检查平台登录').props.disabled, false)
})

test('稿件变更后丢弃迟到的导出结果；工程写入项目导出目录并支持打开文件夹和下载', async t => {
  const initial = props()
  const requests = []
  const renderer = await render(t, async (url, options) => { requests.push({ url, options }); return Response.json(config()) }, initial)
  await expand(renderer)
  let settle, exportArgs
  globalThis.__maitianUIExport = (...args) => { exportArgs = args; return new Promise(resolve => { settle = resolve }) }
  await act(async () => { button(renderer, '导出麦田工程').props.onClick() })
  assert.deepEqual(exportArgs, ['draft', 'xhs', false])
  const updated = { ...initial, draft: { ...initial.draft, publish: { ...initial.draft.publish, title: '新标题' } } }
  await act(async () => renderer.update(React.createElement(MaitianExport, updated)))
  await act(async () => settle({ downloadPath: '/stale-archive', warnings: ['旧结果'] }))
  assert.equal(renderer.root.findAllByType('a').length, 0)
  globalThis.__maitianUIExport = async () => ({ exportId: 'new', downloadPath: 'media-desk/publish/maitian/download?exportId=new', warnings: ['上游原始校验提示'] })
  await act(async () => button(renderer, '导出麦田工程').props.onClick())
  assert.equal(renderer.root.findByType('a').props.href, 'media-desk/publish/maitian/download?exportId=new')
  assert.match(text(renderer), /项目设置的成稿导出目录/)
  assert.match(text(renderer), /无需下载/)
  assert.match(text(renderer), /备份或转移/)
  assert.match(text(renderer), /上游原始校验提示/)
  assert.match(text(renderer), /项目设置的成稿导出目录/)
  await act(async () => button(renderer, '打开所在文件夹').props.onClick())
  assert.equal(requests.at(-1).url, 'media-desk/publish/maitian/reveal')
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { exportId: 'new' })
})

test('保存归一化只改变对象字段顺序时保留迟到的导出结果', async t => {
  const initial = props()
  const renderer = await render(t, async () => Response.json(config()), initial)
  await expand(renderer)
  let settle
  globalThis.__maitianUIExport = () => new Promise(resolve => { settle = resolve })
  await act(async () => { button(renderer, '导出麦田工程').props.onClick() })
  const publish = initial.draft.publish
  const reordered = Object.fromEntries(Object.entries(publish).reverse())
  await act(async () => renderer.update(React.createElement(MaitianExport, { ...initial, draft: { ...initial.draft, publish: reordered } })))
  await act(async () => settle({ downloadPath: '/normalized-result', warnings: [] }))
  assert.equal(renderer.root.findByType('a').props.href, '/normalized-result')
})

test('英文界面翻译配置、登录预检和原页面动作，保留上游原始原因', async t => {
  setLanguagePreference('en')
  const renderer = await render(t, async url => Response.json(url.endsWith('config') ? config({ enabled: true, diagnostic: { detectedVersion: '1.2.3' } }) : { operationId: 'id', ok: false, reason: '上游登录提示', canOpenPage: true }))
  await act(async () => button(renderer, 'Setup and export').props.onClick())
  assert.ok(button(renderer, 'Install Maitian in dedicated Chrome'))
  await act(async () => button(renderer, 'Check platform login').props.onClick())
  assert.match(text(renderer), /page not ready/)
  assert.match(text(renderer), /does not verify account identity/)
  assert.match(text(renderer), /上游登录提示/)
  assert.ok(button(renderer, 'Open the original page'))
})

test('浏览器历史显示正确平台与待人工发布语义，不显示 API 回查按钮', async t => {
  let renderer
  const job = { provider: 'maitian', taskId: 'task', platform: 'xhs', status: 'awaiting_user', title: '已填写的稿件', account: '人工确认账号', canReview: false }
  await act(async () => { renderer = TestRenderer.create(React.createElement(PublishHistory, { id: 'draft', publishing: { jobs: [job], refresh() {} } })) })
  t.after(async () => act(async () => renderer.unmount()))
  assert.match(text(renderer), /小红书/)
  assert.match(text(renderer), /浏览器填写/)
  assert.match(text(renderer), /已填好，待你发布/)
  assert.doesNotMatch(text(renderer), /投稿完成/)
  assert.equal(button(renderer, '查询平台状态'), undefined)
})

test('浏览器执行活跃时轮询，待人工发布停止；原 API publishing 仍沿用轮询', async t => {
  let jobs = [{ provider: 'maitian', status: 'filling', executionActive: true }]
  let poll, intervals = 0, cleared = 0, publishing, renderer
  t.mock.method(globalThis, 'fetch', async () => Response.json({ platforms: {}, jobs, lockedPlatforms: {} }))
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { assert.equal(ms, 3000); poll = fn; intervals++; return intervals })
  t.mock.method(globalThis, 'clearInterval', () => { cleared++ })
  function Probe() { publishing = usePublishing('draft', '小红书', false); return null }
  await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)) })
  t.after(async () => act(async () => renderer.unmount()))
  assert.equal(intervals, 1)
  jobs = [{ provider: 'maitian', status: 'awaiting_user', executionActive: false }]
  await act(async () => { poll() })
  assert.equal(cleared, 1)
  assert.equal(intervals, 1)
  jobs = [{ status: 'publishing' }]
  await act(async () => publishing.refresh())
  assert.equal(intervals, 2)
  jobs = [{ status: 'unknown' }]
  await act(async () => { poll() })
  assert.equal(cleared, 2)
})
