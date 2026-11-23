import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const compiled = await build({ stdin: { contents: "export { ApiInterruptionRecovery, ApiInterruptionOverview } from './client/api-recovery.jsx'; export { PublishHistory } from './client/publish.jsx'; export { setLanguagePreference } from './client/i18n.js'", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] })
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports)
const { ApiInterruptionRecovery, ApiInterruptionOverview, PublishHistory, setLanguagePreference } = module.exports
const job = extra => ({ taskId: 'task', title: '原稿件', account: '原账号', status: 'unknown', platform: 'youtube', canRecoverInterrupted: true, recoveryRecordDigest: 'a'.repeat(64), ...extra })
const button = (renderer, label) => renderer.root.findAllByType('button').find(node => node.children.includes(label))
const nodeText = node => typeof node === 'string' ? node : node.children.map(nodeText).join('')
const fill = (renderer, label, value, type = 'input') => act(async () => renderer.root.findAllByType('label').find(node => nodeText(node).includes(label)).findByType(type).props.onChange({ target: { value, checked: value } }))
const text = renderer => JSON.stringify(renderer.toJSON())
async function render(t, Component, props) {
  const before = globalThis.window; globalThis.window = { addEventListener() {}, removeEventListener() {} }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before; setLanguagePreference('zh') })
  return renderer
}
async function confirm(renderer) {
  await act(async () => button(renderer, '核对中断的 API 投稿').props.onClick())
  await fill(renderer, '核对操作者', '人工核对者')
  await fill(renderer, '核对原因与证据', '旧进程已停，平台仍待确认', 'textarea')
  await fill(renderer, '我已确认其他 Host 和旧版发布进程完全停止', true)
  await fill(renderer, '我已在原账号检查平台结果', true)
}

test('中断核对要求操作者、原因和两个确认，只发送原任务与摘要并保留未知语义', async t => {
  const calls = [], renderer = await render(t, ApiInterruptionRecovery, { id: 'piece', job: job(), request: async (...args) => calls.push(args), refresh: async () => {} })
  await act(async () => button(renderer, '核对中断的 API 投稿').props.onClick())
  assert.equal(button(renderer, '确认停止并保留未知结果').props.disabled, true)
  await fill(renderer, '核对操作者', '人工核对者'); await fill(renderer, '核对原因与证据', '旧进程已停，平台仍待确认', 'textarea')
  await fill(renderer, '我已确认其他 Host 和旧版发布进程完全停止', true)
  assert.equal(button(renderer, '确认停止并保留未知结果').props.disabled, true)
  await fill(renderer, '我已在原账号检查平台结果', true)
  assert.match(text(renderer), /保留回执和防重/)
  await act(async () => button(renderer, '确认停止并保留未知结果').props.onClick())
  assert.deepEqual(calls, [['recover-interrupted', { id: 'piece', taskId: 'task', recordDigest: 'a'.repeat(64), actor: '人工核对者', reason: '旧进程已停，平台仍待确认', confirmed: true, oldHostsStopped: true, platformChecked: true }]])
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
})

test('核对处理中重复点击不重复请求；任务/摘要切换后迟到失败不污染当前记录', async t => {
  let reject, requests = 0
  const props = { id: 'piece', job: job(), request: () => { requests++; return new Promise((_, failure) => { reject = failure }) }, refresh: async () => {} }
  const renderer = await render(t, ApiInterruptionRecovery, props)
  await confirm(renderer)
  const submit = button(renderer, '确认停止并保留未知结果').props.onClick
  await act(async () => { submit(); submit() })
  assert.equal(requests, 1)
  await act(async () => renderer.update(React.createElement(ApiInterruptionRecovery, { ...props, job: job({ taskId: 'new-task', recoveryRecordDigest: 'b'.repeat(64) }) })))
  await act(async () => { reject(Error('旧任务错误')); await Promise.resolve() })
  assert.doesNotMatch(text(renderer), /旧任务错误/)
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
})

test('已核对状态只展示审计，英文文案完整；浏览器任务不出现 API 核对按钮', async t => {
  setLanguagePreference('en')
  const renderer = await render(t, PublishHistory, { id: 'piece', publishing: { jobs: [job({ canRecoverInterrupted: false, interruptionRecovery: { actor: '人工核对者', at: '2026-11-23' } }), job({ provider: 'maitian', taskId: 'browser' })], refresh: async () => {} } })
  assert.match(text(renderer), /Old Hosts were confirmed stopped/)
  assert.equal(button(renderer, 'Review interrupted API submission'), undefined)
  assert.match(text(renderer), /人工核对者/)
})

test('升级总览按需读取整个工作区，包含其他稿件；刷新与核对请求不使用麦田执行接口', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options])
    if (options.method === 'GET') return Response.json({ jobs: calls.some(([, options]) => options.method === 'POST') ? [] : [job({ itemId: 'deleted-piece' })] })
    return Response.json({ job: { status: 'unknown' } })
  })
  const renderer = await render(t, ApiInterruptionOverview, {})
  assert.equal(calls.length, 0)
  await act(async () => button(renderer, '检查升级前的 API 投稿').props.onClick())
  assert.match(text(renderer), /deleted-piece/)
  await confirm(renderer)
  await act(async () => button(renderer, '确认停止并保留未知结果').props.onClick())
  assert.equal(JSON.parse(calls[1][1].body).id, 'deleted-piece')
  assert.ok(calls.every(([url]) => !url.includes('maitian/')))
  assert.match(text(renderer), /当前没有阻止升级的旧 API 执行记录/)
})

test('失败或不完整的总览响应显示诊断，继续保留当前数据；摘要变化使确认失效', async t => {
  let response = Response.json({ jobs: [] })
  t.mock.method(globalThis, 'fetch', async () => response.clone())
  const renderer = await render(t, ApiInterruptionOverview, {})
  await act(async () => button(renderer, '检查升级前的 API 投稿').props.onClick())
  response = Response.json({ error: '发布记录无法安全读取' }, { status: 500 })
  await act(async () => button(renderer, '检查升级前的 API 投稿').props.onClick())
  assert.match(text(renderer), /发布记录无法安全读取/)
  response = Response.json({})
  await act(async () => button(renderer, '检查升级前的 API 投稿').props.onClick())
  assert.match(text(renderer), /投稿记录响应不完整/)
})
