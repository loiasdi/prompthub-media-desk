import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { COVER_RATIOS, emptyCoverDesign } from '../src/cover-design-schema.js'

const source = await readFile(new URL('../client/content-workspace.jsx', import.meta.url), 'utf8')
const compiled = await build({
  stdin: { contents: source + '\nexport { CoverDesignPage, AssetsPage }; export { setDesk, getDesk } from "./desk.js";', resolveDir: process.cwd() + '/client', loader: 'jsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
  plugins: [{ name: 'cover-action', setup(build) {
    build.onLoad({ filter: /\/client\/workspace\.js$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(
      'export const runCoverAction = (item, path, body) => workspaceStore.action(item.id, path, body)',
      'export const runCoverAction = (...args) => globalThis.__coverAction(...args)',
    ).replace('export const flushWorkspace = id => workspaceStore.flush(id)', 'export const flushWorkspace = id => globalThis.__coverFlush(id)') }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { CoverDesignPage, AssetsPage, setDesk, getDesk } = module.exports
const button = (renderer, label) => renderer.root.findAllByType('button').find(node => node.children.includes(label))

test('素材库封面卡片显示比例，切换列表后仍显示标签', async t => {
  const asset = { id: 'cover', name: '自定义封面.png', src: 'cover.png', type: 'image', role: 'cover', coverRatio: '3:4', coverResult: true, bytes: 1024 }
  const draft = { assets: [asset], hidden: [], edits: {}, folders: [], imageIds: [] }
  let renderer
  await act(async () => { renderer = TestRenderer.create(React.createElement(AssetsPage, { item: { id: 'piece' }, draft, assets: [asset], update() {}, persistence: { imports: [] } })) })
  t.after(async () => act(async () => renderer.unmount()))
  const caption = () => renderer.root.findByProps({ className: 'md-asset-caption' })
  const purpose = () => caption().findAllByType('span')[0].children.join('')
  assert.equal(purpose(), '封面 · 3:4')
  await act(async () => renderer.root.findByProps({ title: '列表' }).props.onClick())
  assert.equal(purpose(), '封面 · 3:4')
})

async function render(t, { prompts = COVER_RATIOS, previous = false, action, save = async () => {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  setDesk({ toast: null, progressToast: null, settings: { imageReady: true, image: { source: 'http', model: 'image' } }, model: null })
  const design = emptyCoverDesign('标题')
  for (const ratio of prompts) design.variants[ratio].prompt = `${ratio} 提示词`
  const assets = previous ? COVER_RATIOS.map(ratio => ({ id: `old-${ratio}`, name: `old-${ratio}`, src: `old-${ratio}.png`, type: 'image', coverResult: true })) : []
  if (previous) for (const ratio of COVER_RATIOS) design.variants[ratio].imageIds = [`old-${ratio}`]
  let renderer
  const value = { item: { id: 'piece', title: '标题' }, draft: { coverDesign: design, selectedCover: previous ? 'old-3:4' : '' }, assets,
    update: patch => { value.draft = { ...value.draft, ...(typeof patch === 'function' ? patch(value.draft) : patch) }; renderer.update(React.createElement(CoverDesignPage, value)) } }
  const calls = []
  globalThis.__coverFlush = save
  globalThis.__coverAction = async (item, path, body) => {
    calls.push({ item, path, body })
    const result = await action?.(body) || { results: (body.ratios || [body.ratio]).map(ratio => ({ ratio, asset: { id: `new-${calls.length}-${ratio}`, name: `new-${ratio}`, src: `new-${calls.length}-${ratio}.png`, type: 'image', coverResult: true } })), errors: [] }
    value.assets = [...value.assets, ...(result.results || (result.asset ? [{ asset: result.asset }] : [])).map(row => row.asset)]
    renderer.update(React.createElement(CoverDesignPage, value))
    return result
  }
  await act(async () => { renderer = TestRenderer.create(React.createElement(CoverDesignPage, value)) })
  t.after(async () => { await act(async () => renderer.unmount()); delete globalThis.__coverAction; delete globalThis.__coverFlush })
  return { get renderer() { return renderer }, value, calls, remount: async () => { await act(async () => renderer.unmount()); await act(async () => { renderer = TestRenderer.create(React.createElement(CoverDesignPage, value)) }) } }
}

test('生成期间返回封面页仍禁用入口，连续调用不会重复生图', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const f = await render(t, { previous: true, action: async () => { await pending } })
  let first, duplicate
  await act(async () => {
    const click = button(f.renderer, '重新生成当前比例（1 张）').props.onClick
    first = click(); duplicate = click()
  })
  await f.remount()
  assert.equal(f.renderer.root.findByType('fieldset').props.disabled, true)
  assert.equal(f.calls.length, 1)
  await act(async () => { finish(); await Promise.all([first, duplicate]) })
  assert.equal(f.renderer.root.findByType('fieldset').props.disabled, false)
  assert.equal(f.calls.length, 1)
  assert.equal(f.value.assets.length, 4)
  assert.deepEqual(f.renderer.root.findAllByType('img').map(node => node.props.src), ['new-1-3:4.png'])
})

test('图片入库后的保存失败显示准确 toast，不误报生成失败或继续旧接口批量任务', async t => {
  const f = await render(t, { previous: true, action: async body => {
    if (body.ratios) throw Object.assign(new Error('封面比例无效'), { status: 400 })
    return { asset: { id: 'new', type: 'image', src: 'new.png' } }
  }, save: async () => { throw new Error('保存连接中断') } })
  await act(async () => button(f.renderer, '重新生成三种比例（3 张）').props.onClick())
  assert.equal(f.calls.length, 2)
  assert.match(getDesk().toast.text, /图片已加入素材库，但封面关联保存失败：保存连接中断/)
  assert.equal(getDesk().toast.error, true)
  assert.equal(f.value.assets.length, 4)
  assert.equal(f.value.draft.coverDesign.variants['3:4'].imageIds[0], 'new')
  assert.equal(getDesk().progressToast, null)
  assert.equal(f.renderer.root.findByType('fieldset').props.disabled, false)
})

test('单张和三张入口分别传当前比例和全部比例，重新生成只展示新图，旧图仍在素材库', async t => {
  const { renderer, value, calls } = await render(t, { previous: true })
  await act(async () => { await button(renderer, '重新生成当前比例（1 张）').props.onClick() })
  assert.deepEqual(calls[0].body, { ratio: '3:4' })
  assert.deepEqual(renderer.root.findAllByType('img').map(node => node.props.src), ['new-1-3:4.png'])
  assert.equal(value.assets.length, 4)
  assert.equal(value.draft.selectedCover, 'old-3:4')
  await act(async () => { await button(renderer, '重新生成三种比例（3 张）').props.onClick() })
  assert.equal(calls[1].path, 'cover/image')
  assert.deepEqual(calls[1].body.ratios, COVER_RATIOS)
  assert.equal(value.assets.length, 7)
  for (const ratio of COVER_RATIOS) {
    await act(async () => button(renderer, ratio).props.onClick())
    assert.deepEqual(renderer.root.findAllByType('img').map(node => node.props.src), [`new-2-${ratio}.png`])
    assert.deepEqual(value.draft.coverDesign.variants[ratio].imageIds, [`new-2-${ratio}`])
  }
})

test('缺少其他比例提示词时仍可单张生成，三张入口禁用；未配置生图时全部禁用', async t => {
  const { renderer } = await render(t, { prompts: ['16:9'] })
  assert.equal(button(renderer, '生成当前比例（1 张）').props.disabled, false)
  assert.equal(button(renderer, '同时生成三种比例（3 张）').props.disabled, true)
  await act(async () => setDesk({ settings: { imageReady: false } }))
  assert.equal(button(renderer, '生成当前比例（1 张）').props.disabled, true)
})

test('生成中禁用表单，部分失败显示原因并保留失败比例的原图', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const { renderer, value } = await render(t, { previous: true, action: async () => { await pending; return {
    results: [{ ratio: '3:4', asset: { id: 'new', name: 'new', src: 'new.png', type: 'image', coverResult: true } }],
    errors: [{ ratio: '16:9', error: '服务暂不可用' }, { ratio: '4:3', error: '超时' }],
  } } })
  let task
  await act(async () => { task = button(renderer, '重新生成三种比例（3 张）').props.onClick() })
  assert.equal(renderer.root.findByType('fieldset').props.disabled, true)
  await act(async () => { finish(); await task })
  assert.equal(renderer.root.findByType('fieldset').props.disabled, false)
  assert.match(getDesk().toast.text, /已生成 1 张封面，其余比例失败：16:9：服务暂不可用；4:3：超时/)
  assert.equal(getDesk().toast.error, true)
  assert.equal(getDesk().progressToast, null)
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
  assert.deepEqual(value.draft.coverDesign.variants['16:9'].imageIds, ['old-16:9'])
  assert.deepEqual(renderer.root.findAllByType('img').map(node => node.props.src), ['new.png'])
})


test('重新生成失败使用错误 toast，原图和重试入口保留，进度提示结束', async t => {
  const { renderer, value, calls } = await render(t, { previous: true, action: async () => { throw new Error('图片服务暂不可用') } })
  await act(async () => button(renderer, '重新生成当前比例（1 张）').props.onClick())
  assert.equal(calls.length, 1, '真实生成错误不重试')
  assert.equal(getDesk().toast.text, '图片服务暂不可用')
  assert.equal(getDesk().toast.error, true)
  assert.equal(getDesk().progressToast, null)
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0, '页面不再展示内嵌错误')
  assert.equal(renderer.root.findByType('fieldset').props.disabled, false)
  assert.deepEqual(value.draft.coverDesign.variants['3:4'].imageIds, ['old-3:4'])
  assert.deepEqual(renderer.root.findAllByType('img').map(node => node.props.src), ['old-3:4.png'])
})

test('生成封面提示词失败也使用 toast，原提示词保留', async t => {
  const { renderer, value } = await render(t, { action: async () => { throw new Error('文字模型超时') } })
  await act(async () => setDesk({ model: { model: 'text' } }))
  await act(async () => button(renderer, '生成封面提示词').props.onClick())
  assert.equal(getDesk().toast.text, '文字模型超时')
  assert.equal(getDesk().toast.error, true)
  assert.equal(getDesk().progressToast, null)
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
  assert.equal(value.draft.coverDesign.variants['3:4'].prompt, '3:4 提示词')
})
