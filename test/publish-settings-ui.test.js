import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { PUBLISH_CONFIG_FIELDS } from '../src/publish/config-schema.js'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: "export { PublishSettingsDialog, openPublishSettings } from './client/publish-settings.jsx'; export { setDesk } from './client/desk.js'; export { SettingsDialog } from './client/settings.jsx'", resolveDir: process.cwd(), loader: 'js' },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports)
const { PublishSettingsDialog, openPublishSettings, setDesk, SettingsDialog } = module.exports
const response = () => ({ platforms: Object.fromEntries(Object.entries(PUBLISH_CONFIG_FIELDS).map(([platform, fields]) => [platform, {
  enabled: false, configured: false,
  fields: Object.fromEntries(fields.filter(field => !field.secret).map(field => [field.key, ''])),
  secrets: Object.fromEntries(fields.filter(field => field.secret).map(field => [field.key, false])),
}])) })

async function render(context, fetchImpl, platform = 'facebook') {
  context.mock.method(globalThis, 'fetch', fetchImpl)
  const previousWindow = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  let renderer
  await act(async () => {
    openPublishSettings(platform)
    renderer = TestRenderer.create(React.createElement(PublishSettingsDialog))
  })
  context.after(async () => {
    await act(async () => { renderer.unmount(); setDesk({ publishSettingsOpen: false }) })
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  return renderer
}

const text = renderer => JSON.stringify(renderer.toJSON())
const button = (renderer, label) => renderer.root.findAllByType('button').find(node => node.children.includes(label))

test('配置请求失败后切换平台仍显示错误和字段，不再只剩下拉框', async context => {
  const renderer = await render(context, async () => Response.json({ error: 'Host 配置读取失败' }, { status: 500 }))
  assert.match(text(renderer), /Host 配置读取失败/)
  assert.match(text(renderer), /Page ID/)
  assert.match(text(renderer), /Access Token/)
  await act(async () => { renderer.root.findByType('select').props.onChange({ target: { value: 'youtube' } }) })
  assert.match(text(renderer), /Host 配置读取失败/)
  assert.match(text(renderer), /Client ID \/ App ID/)
  assert.equal(button(renderer, '保存账号配置').props.disabled, true)
  assert.equal(renderer.root.findAll(node => node.props?.role === 'status').length, 0)
})

test('空响应明确报错，重试成功后可以填写并保存 Facebook 账号', async context => {
  let reads = 0, posted
  const renderer = await render(context, async (_url, options) => {
    if (options.method === 'POST') { posted = JSON.parse(options.body); return Response.json(response()) }
    reads++
    return Response.json(reads === 1 ? {} : response())
  })
  assert.match(text(renderer), /接口返回不完整/)
  await act(async () => { button(renderer, '重试').props.onClick() })
  assert.equal(renderer.root.findAll(node => node.props?.role === 'alert').length, 0)
  const inputs = renderer.root.findAllByType('input')
  assert.equal(inputs.length, 4)
  assert.ok(inputs.every(input => !input.props.disabled))
  await act(async () => {
    inputs[0].props.onChange({ target: { checked: true } })
    inputs[1].props.onChange({ target: { value: '123' } })
    inputs[2].props.onChange({ target: { value: 'test-page-token' } })
  })
  await act(async () => { button(renderer, '保存账号配置').props.onClick() })
  assert.equal(posted.platform, 'facebook')
  assert.equal(posted.enabled, true)
  assert.equal(posted.fields.PAGE_ID, '123')
  assert.equal(posted.fields.ACCESS_TOKEN, 'test-page-token')
  assert.match(text(renderer), /已保存，立即生效/)
})

test('配置加载期间显示对应字段，加载异常后重试恢复', async context => {
  let settle
  const renderer = await render(context, () => new Promise(resolve => { settle = resolve }), 'youtube')
  assert.match(text(renderer), /正在读取配置/)
  assert.match(text(renderer), /Client ID \/ App ID/)
  assert.equal(button(renderer, '重试').props.disabled, true)
  await act(async () => { settle(Response.json(response())) })
  assert.equal(renderer.root.findAll(node => node.props?.role === 'status').length, 0)
  assert.equal(button(renderer, '保存账号配置').props.disabled, false)
})

test('配置失败仍能阅读获取引导，切换平台同步切换步骤、字段说明和官方链接', async context => {
  const renderer = await render(context, async () => Response.json({}, { status: 500 }))
  assert.match(text(renderer), /如何获取配置/)
  assert.match(text(renderer), /me\/accounts\?fields=id,name,access_token/)
  assert.match(text(renderer), /Page Access Token/)
  assert.equal(renderer.root.findByType('details').props.open, true)
  for (const node of renderer.root.findAllByType('a')) {
    assert.equal(node.props.target, '_blank')
    assert.equal(node.props.rel, 'noopener noreferrer')
    assert.ok(node.props.href.startsWith('https://'))
  }
  await act(async () => { renderer.root.findByType('select').props.onChange({ target: { value: 'youtube' } }) })
  assert.match(text(renderer), /Google Cloud/)
  assert.match(text(renderer), /youtube.upload/)
  assert.equal(renderer.root.findAllByType('a').some(node => node.props.href.includes('facebook.com')), false)
  await act(async () => { renderer.root.findByType('select').props.onChange({ target: { value: 'bluesky' } }) })
  assert.match(text(renderer), /App Passwords/)
  assert.match(text(renderer), /不要使用主账号密码/)
  assert.ok(renderer.root.findAllByType('a').some(node => node.props.href === 'https://bsky.app/settings/app-passwords'))
})

test('发布配置分离引导和表单，操作栏不随正文滚动，复选框使用独立布局', async context => {
  const renderer = await render(context, async () => Response.json(response()), 'bilibili')
  const byClass = name => renderer.root.find(node => typeof node.type === 'string' && node.props.className?.split(' ').includes(name))
  assert.equal(byClass('md-publish-settings').props.role, 'dialog')
  const grid = byClass('md-publish-settings-grid')
  assert.equal(grid.findAllByType('details').length, 1)
  assert.ok(byClass('md-publish-credentials').findAllByType('input').length > 0)
  assert.equal(byClass('md-publish-settings-scroll').findAll(node => node.props.className?.includes('md-publish-actions')).length, 0)
  assert.equal(byClass('md-publish-actions').findAllByType('button').length, 3)
  assert.equal(byClass('md-publish-check').findByType('input').props.type, 'checkbox')
})

test('配置接口 405 显示本地加载故障，不冒充平台凭据验证结果', async context => {
  const renderer = await render(context, async () => Response.json({ error: '不支持的方法' }, { status: 405 }))
  assert.match(text(renderer), /本地发布配置接口不可用/)
  assert.match(text(renderer), /这不是平台凭据验证结果/)
  assert.doesNotMatch(text(renderer), /不支持的方法/)
  assert.equal(button(renderer, '验证已保存账号').props.disabled, true)
})


test('发布账号入口位于设置分类面板内，不再放在 Tab 上方', async context => {
  const previousWindow = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  let renderer
  await act(async () => {
    setDesk({ settingsOpen: true, settings: { image: {} } })
    renderer = TestRenderer.create(React.createElement(SettingsDialog))
  })
  context.after(async () => {
    await act(async () => { renderer.unmount(); setDesk({ settingsOpen: false }) })
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  assert.equal(button(renderer, '配置发布账号'), undefined)
  const tabs = renderer.root.findAll(node => node.props?.role === 'tab')
  assert.equal(tabs.length, 3)
  await act(async () => { tabs.find(node => node.children.includes('发布账号')).props.onClick() })
  const panel = renderer.root.find(node => node.props?.role === 'tabpanel')
  assert.equal(panel.props.id, 'md-settings-panel-publishing')
  assert.ok(panel.findAllByType('button').some(node => node.children.includes('配置发布账号')))
  assert.equal(button(renderer, '保存'), undefined)
  await act(async () => { button(renderer, '配置发布账号').props.onClick() })
})

test('切换平台保留独立草稿，保存其他平台不会覆盖，关闭后清理未保存凭据', async context => {
  let saved = response(), posted
  const renderer = await render(context, async (_url, options) => {
    if (options.method === 'POST') {
      posted = JSON.parse(options.body)
      const row = saved.platforms[posted.platform]
      row.fields = Object.fromEntries(Object.entries(posted.fields).filter(([key]) => !Object.hasOwn(row.secrets, key)))
      row.enabled = posted.enabled
      return Response.json(saved)
    }
    return Response.json(saved)
  }, 'youtube')
  const switchTo = async platform => act(async () => renderer.root.findByType('select').props.onChange({ target: { value: platform } }))
  const inputs = () => renderer.root.findAllByType('input')
  await act(async () => {
    inputs()[0].props.onChange({ target: { checked: true } })
    inputs()[1].props.onChange({ target: { value: 'youtube-client' } })
    inputs()[2].props.onChange({ target: { value: 'unsaved-youtube-token' } })
  })
  await switchTo('facebook')
  await act(async () => { inputs()[1].props.onChange({ target: { value: '123' } }) })
  await act(async () => { button(renderer, '保存账号配置').props.onClick() })
  assert.equal(posted.platform, 'facebook')
  await switchTo('youtube')
  assert.equal(inputs()[0].props.checked, true)
  assert.equal(inputs()[1].props.value, 'youtube-client')
  assert.equal(inputs()[2].props.value, 'unsaved-youtube-token')
  await act(async () => { button(renderer, '关闭').props.onClick() })
  await act(async () => { openPublishSettings('youtube') })
  assert.equal(inputs()[0].props.checked, false)
  assert.equal(inputs()[1].props.value, '')
  assert.equal(inputs()[2].props.value, '')
})

test('平台草稿保留清除凭据选择与快手上传风险确认', async context => {
  const data = response()
  data.platforms.facebook.secrets.ACCESS_TOKEN = true
  const renderer = await render(context, async () => Response.json(data))
  const switchTo = async platform => act(async () => renderer.root.findByType('select').props.onChange({ target: { value: platform } }))
  const checks = () => renderer.root.findAllByType('input').filter(node => node.props.type === 'checkbox')
  await act(async () => { checks()[1].props.onChange({ target: { checked: true } }) })
  await switchTo('kuaishou')
  await act(async () => { checks()[1].props.onChange({ target: { checked: true } }) })
  await switchTo('facebook')
  assert.equal(checks()[1].props.checked, true)
  await switchTo('kuaishou')
  assert.equal(checks()[1].props.checked, true)
})

test('从设置进入发布账号再返回，保留原 Tab 和普通设置、API 密钥草稿', async context => {
  const previousWindow = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  context.mock.method(globalThis, 'fetch', async () => Response.json(response()))
  let renderer
  await act(async () => {
    setDesk({ settingsOpen: true, publishSettingsOpen: false, settings: { image: {}, documentDir: '/old' } })
    renderer = TestRenderer.create(React.createElement(React.Fragment, null, React.createElement(SettingsDialog), React.createElement(PublishSettingsDialog)))
  })
  context.after(async () => {
    await act(async () => { renderer.unmount(); setDesk({ settingsOpen: false, publishSettingsOpen: false }) })
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  const tab = label => renderer.root.findAll(node => node.props?.role === 'tab').find(node => node.children.includes(label))
  await act(async () => { renderer.root.findAllByType('input').find(node => node.props.value === '/old').props.onChange({ target: { value: '/draft' } }) })
  await act(async () => { tab('API 设置').props.onClick() })
  await act(async () => { renderer.root.findAllByType('input').find(node => node.props.type === 'password').props.onChange({ target: { value: 'unsaved-image-key' } }) })
  await act(async () => { tab('发布账号').props.onClick() })
  await act(async () => { button(renderer, '配置发布账号').props.onClick() })
  assert.equal(renderer.root.findAll(node => node.props?.role === 'dialog').length, 1)
  assert.equal(renderer.root.find(node => node.props?.role === 'dialog').props['aria-label'], '发布账号')
  await act(async () => { button(renderer, '关闭').props.onClick() })
  assert.equal(tab('发布账号').props['aria-selected'], true)
  await act(async () => { tab('普通设置').props.onClick() })
  assert.ok(renderer.root.findAllByType('input').some(node => node.props.value === '/draft'))
  await act(async () => { tab('API 设置').props.onClick() })
  assert.equal(renderer.root.findAllByType('input').find(node => node.props.type === 'password').props.value, 'unsaved-image-key')
})

test('打开与迁移并列于设置底部，默认提交只打开已有工作台', async context => {
  let posted, reloaded = 0, renderer
  const previousWindow = globalThis.window, previousDocument = globalThis.document
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { reload: () => { reloaded++ } } }
  globalThis.document = { addEventListener() {} }
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'media-desk/settings')
    posted = JSON.parse(options.body)
    return Response.json({ storage: { opened: true } })
  })
  context.after(async () => {
    await act(async () => { renderer?.unmount(); setDesk({ settingsOpen: false }) })
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  })
  await act(async () => {
    setDesk({ settingsOpen: true, publishSettingsOpen: false, settings: { image: {}, documentDir: '/current', canOpenDocumentDir: true } })
    renderer = TestRenderer.create(React.createElement(SettingsDialog))
  })
  const changeFolder = value => act(async () => {
    renderer.root.findByProps({ 'aria-labelledby': 'md-document-directory-label' }).props.onChange({ target: { value } })
  })
  assert.equal(button(renderer, '打开已有工作台').props.disabled, true)
  assert.match(text(renderer), /这就是当前工作台的目录/)
  assert.match(text(renderer), /成稿导出目录/)
  assert.match(text(renderer), /不影响稿件的日常保存/)
  assert.equal(button(renderer, '保存').props.type, 'submit')
  await changeFolder('   ')
  assert.equal(button(renderer, '打开已有工作台').props.disabled, true)
  assert.match(text(renderer), /请输入已有工作台的目录路径/)
  await changeFolder('/Obsidian Vault/自媒体工作台')
  assert.equal(button(renderer, '保存并迁移').props.type, 'submit')
  const open = button(renderer, '打开已有工作台')
  const migrate = button(renderer, '保存并迁移')
  assert.equal(open.parent, migrate.parent)
  assert.match(open.parent.props.className, /md-settings-foot/)
  assert.match(open.props.className, /is-primary/)
  assert.doesNotMatch(migrate.props.className, /is-primary/)
  assert.equal(open.props.type, 'submit')
  assert.equal(open.props.disabled, false)
  assert.deepEqual(open.parent.findAllByType('button').filter(node => node.props.type === 'submit').map(node => node.props.value), ['open', 'save'])
  await act(async () => { await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }) })
  assert.deepEqual(posted, { documentDir: '/Obsidian Vault/自媒体工作台', documentDirMode: 'open' })
  assert.equal(reloaded, 1)
})
