import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const compiled = await build({ stdin: { contents: "export { MaitianTaskActions } from './client/maitian-history.jsx'; export { PublishHistory } from './client/publish.jsx'; export { setLanguagePreference } from './client/i18n.js'", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'] })
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports)
const { MaitianTaskActions, PublishHistory, setLanguagePreference } = module.exports
const text = renderer => JSON.stringify(renderer.toJSON())
const button = (renderer, label) => renderer.root.findAllByType('button').find(node => node.children.includes(label))
const nodeText = node => typeof node === 'string' ? node : node.children.map(nodeText).join('')
const field = (renderer, label, type = 'input') => renderer.root.findAllByType('label').find(node => nodeText(node).includes(label)).findByType(type)
const fill = (renderer, label, value, type = 'input') => act(async () => field(renderer, label, type).props.onChange({ target: { value, checked: value } }))
const job = (extra = {}) => ({ provider: 'maitian', taskId: 'task-a', title: '本次稿件', account: '原任务账号', platform: 'xhs', status: 'awaiting_user', canReview: true,
  canLocatePage: true, canOpenManagement: true, canAssociate: true, canArchive: true, canConfirmNotSubmitted: true, ...extra })
async function render(t, value, request = async () => ({})) {
  const before = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  let renderer
  const props = { id: 'piece', job: value, request, refresh() {} }
  await act(async () => { renderer = TestRenderer.create(React.createElement(MaitianTaskActions, props)) })
  t.after(async () => { await act(async () => renderer.unmount()); globalThis.window = before; setLanguagePreference('zh') })
  return { renderer, props }
}

test('浏览器查询先人工核对账号及身份限制，只发送任务标识和确认，不走 API review', async t => {
  const calls = []
  const { renderer } = await render(t, job(), async (...args) => { calls.push(args); return {} })
  await act(async () => button(renderer, '查询发布结果').props.onClick())
  assert.equal(button(renderer, '确认账号并查询').props.disabled, true)
  await fill(renderer, '我已在专用 Chrome 核对原任务账号', true)
  assert.equal(button(renderer, '确认账号并查询').props.disabled, true)
  await fill(renderer, '我理解登录预检不能验证账号身份', true)
  await act(async () => button(renderer, '确认账号并查询').props.onClick())
  assert.deepEqual(calls, [['maitian/review', { id: 'piece', taskId: 'task-a', account: { label: '原任务账号', confirmed: true, identityLimitAcknowledged: true } }]])
})

test('候选原文不变，不虚构 ID/数量/实际预约；人工关联需要操作者、原因和平台确认', async t => {
  const calls = []
  const candidate = { reviewId: 'review-a', source: 'maitian-query', queriedAt: '2026-11-23T10:00:00Z', needsConfirmation: true,
    result: { status: '定时', normalizedStatus: 'scheduled', url: null, time: '上游模糊时间', note: '上游原始提示' } }
  const { renderer } = await render(t, job({ platform: 'channels', lastReview: candidate }), async (...args) => calls.push(args))
  assert.match(text(renderer), /上游时间原文（含义与时区未核实）/)
  assert.match(text(renderer), /候选可能对应旧作品/)
  assert.doesNotMatch(text(renderer), /上游返回的候选数量/)
  assert.equal(renderer.root.findAllByType('a').length, 0)
  await act(async () => button(renderer, '人工关联作品').props.onClick())
  await fill(renderer, '核对操作者', '我')
  await fill(renderer, '核对原因与证据', '在作品管理页核对了这一条', 'textarea')
  assert.equal(button(renderer, '确认核对').props.disabled, true)
  await fill(renderer, '我已在平台核对这条作品及其状态', true)
  await fill(renderer, '平台实际预约时间（可选）', '2026-12-01T19:00')
  await act(async () => button(renderer, '确认核对').props.onClick())
  const [path, request] = calls[0]
  assert.equal(path, 'maitian/reconcile')
  assert.equal(request.action, 'associate')
  assert.equal(request.reviewId, 'review-a')
  assert.deepEqual(request.evidence, { status: 'scheduled', workId: null, url: null, actualWhen: '2026-12-01T19:00', actualTimezone: 'Asia/Shanghai' })
})

test('确认未提交与归档各自要求全部核对项，归档明确保留防重', async t => {
  const calls = []
  const { renderer } = await render(t, job({ status: 'unknown' }), async (...args) => calls.push(args))
  await act(async () => button(renderer, '确认未提交').props.onClick())
  await fill(renderer, '核对操作者', '我'); await fill(renderer, '核对原因与证据', '已核对无提交并清理残留', 'textarea')
  for (const label of ['我已确认自动执行流程停止', '我已检查平台作品管理页，没有本次提交', '我已检查原上传页面']) await fill(renderer, label, true)
  assert.equal(button(renderer, '确认核对').props.disabled, true)
  await fill(renderer, '我已处理残留上传或草稿，可以重新准备', true)
  await act(async () => button(renderer, '确认核对').props.onClick())
  assert.equal(calls[0][1].action, 'confirmed-not-submitted')
  assert.equal(calls[0][1].residualsCleared, true)
  await act(async () => button(renderer, '归档任务').props.onClick())
  assert.match(text(renderer), /归档会释放本机任务副本，并继续保留投稿防重记录/)
  await fill(renderer, '核对操作者', '我'); await fill(renderer, '核对原因与证据', '本次任务已经核对并处理原页', 'textarea')
  for (const label of ['我已确认自动执行流程停止', '我已核对并处理原页面与平台结果', '我同意释放本机任务副本，保留防重记录']) await fill(renderer, label, true)
  await act(async () => button(renderer, '确认核对').props.onClick())
  assert.equal(calls[1][1].action, 'archive')
  assert.equal(calls[1][1].snapshotReleaseConfirmed, true)
})

test('候选更新会使旧人工确认失效，危险链接不成为可点击作品', async t => {
  const original = job({ lastReview: { reviewId: 'old', needsConfirmation: true, result: { status: '已发布', normalizedStatus: 'published', url: 'javascript:alert(1)' } } })
  const { renderer, props } = await render(t, original)
  assert.equal(renderer.root.findAllByType('a').length, 0)
  await act(async () => button(renderer, '人工关联作品').props.onClick())
  await fill(renderer, '我已在平台核对这条作品及其状态', true)
  await act(async () => renderer.update(React.createElement(MaitianTaskActions, { ...props, job: { ...original, lastReview: { ...original.lastReview, reviewId: 'new' } } })))
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
  await act(async () => button(renderer, '人工关联作品').props.onClick())
  assert.equal(field(renderer, '我已在平台核对这条作品及其状态').props.checked, false)
})

test('停止响应不冒充已停止，原页操作只传任务 ID；API 查询按钮不会接管浏览器任务', async t => {
  const calls = []
  const { renderer, props } = await render(t, job({ status: 'filling', executionActive: true, canReview: false, canCancel: true, canLocatePage: false, canOpenManagement: false, canAssociate: false, canArchive: false, canConfirmNotSubmitted: false }), async (...args) => calls.push(args))
  await act(async () => button(renderer, '请求停止填写').props.onClick())
  assert.deepEqual(calls[0], ['maitian/cancel', { id: 'piece', taskId: 'task-a' }])
  await act(async () => renderer.update(React.createElement(MaitianTaskActions, { ...props, job: { ...props.job, cancelRequested: true } })))
  assert.match(text(renderer), /当前步骤可能继续/)
  assert.equal(button(renderer, '请求停止填写').props.disabled, true)
  await act(async () => renderer.update(React.createElement(MaitianTaskActions, { ...props, job: job() })))
  await act(async () => button(renderer, '打开原发布页').props.onClick())
  assert.deepEqual(calls[1], ['maitian/open-page', { id: 'piece', taskId: 'task-a' }])
  let history
  await act(async () => { history = TestRenderer.create(React.createElement(PublishHistory, { id: 'piece', publishing: { jobs: [job()], refresh() {} } })) })
  t.after(async () => act(async () => history.unmount()))
  assert.equal(button(history, '查询平台状态'), undefined)
  assert.ok(button(history, '查询发布结果'))
})

test('英文界面翻译核对操作与限制，保留原版候选状态和原因原文', async t => {
  setLanguagePreference('en')
  const { renderer } = await render(t, job({ lastReview: { reviewId: 'a', needsConfirmation: true, result: { status: '上游状态原文', time: '上游时间原文', note: '上游原因原文' } } }))
  assert.ok(button(renderer, 'Check publishing results'))
  assert.match(text(renderer), /Maitian query candidate/)
  assert.match(text(renderer), /上游原因原文/)
  await act(async () => button(renderer, 'Check publishing results').props.onClick())
  assert.match(text(renderer), /cannot verify account identity/)
  assert.equal(button(renderer, 'Confirm account and query').props.disabled, true)
})
