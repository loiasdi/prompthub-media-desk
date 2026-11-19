import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { PublishConfig } from '../src/publish/config.js'
import { PUBLISH_CONFIG_FIELDS, publishConfigPlatforms } from '../src/publish/config-schema.js'
import { PUBLISH_PLATFORMS } from '../src/publish/capabilities.js'
import { route } from '../src/host.js'
import { Publishing } from '../src/publish/service.js'
import { validatePublishConfigResponse } from '../client/publish-config-response.js'

async function fixture(context, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'md-publish-config-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return new PublishConfig(root, env)
}

test('发布账号配置覆盖全部已注册平台，私有保存并隐藏密钥', async context => {
  const config = await fixture(context)
  assert.deepEqual(publishConfigPlatforms.sort(), Object.keys(PUBLISH_CONFIG_FIELDS).sort())
  assert.equal(publishConfigPlatforms.length, Object.keys(PUBLISH_PLATFORMS).length)
  const saved = await config.save({ platform: 'x', enabled: true, fields: { USER_ID: '123', ACCESS_TOKEN: 'private-token-value' } })
  assert.strictEqual(validatePublishConfigResponse(saved), saved)
  assert.equal(saved.platforms.x.configured, true)
  assert.equal(saved.platforms.x.secrets.ACCESS_TOKEN, true)
  assert.equal(JSON.stringify(saved).includes('private-token-value'), false)
  assert.equal((await stat(config.file)).mode & 0o777, 0o600)
  assert.equal((await stat(config.root)).mode & 0o777, 0o700)
  assert.equal(JSON.parse(await readFile(config.file, 'utf8')).x.fields.ACCESS_TOKEN, 'private-token-value')
  assert.ok(config.resolve('x'))
  const publishing = new Publishing({})
  publishing.config = config
  assert.equal(publishing.platform('x').accessToken, 'private-token-value')
  assert.strictEqual(config.resolve('x'), config.resolve('x'))
  await config.save({ platform: 'x', enabled: true, fields: { ACCESS_TOKEN: '' } })
  assert.equal(config.environment('x').MEDIA_DESK_X_ACCESS_TOKEN, 'private-token-value')
  const restarted = new PublishConfig(config.root, {})
  assert.ok(restarted.resolve('x'))
  await restarted.save({ platform: 'x', enabled: false, fields: {}, clearSecrets: ['ACCESS_TOKEN'] })
  assert.equal(restarted.resolve('x'), null)
  assert.equal(restarted.public().platforms.x.secrets.ACCESS_TOKEN, false)
  publishing.config = restarted
  assert.equal(publishing.platform('x', false), null)
})

test('发布账号保留环境配置，页面显式停用或清除优先且不更改进程环境', async context => {
  const env = { MEDIA_DESK_X_PUBLISH: '1', MEDIA_DESK_X_USER_ID: '123', MEDIA_DESK_X_ACCESS_TOKEN: 'environment-secret' }
  const config = await fixture(context, env)
  assert.ok(config.resolve('x'))
  assert.equal(JSON.stringify(config.public()).includes('environment-secret'), false)
  await config.save({ platform: 'x', enabled: false, fields: {}, clearSecrets: ['ACCESS_TOKEN'] })
  assert.equal(config.resolve('x'), null)
  assert.equal(config.public().platforms.x.secrets.ACCESS_TOKEN, false)
  assert.equal(env.MEDIA_DESK_X_ACCESS_TOKEN, 'environment-secret')
  await assert.rejects(config.save({ platform: 'x', enabled: true, fields: {} }), /参数不完整/)
})

test('可选 API 版本留空时恢复适配器默认值，更新凭据使缓存失效', async context => {
  const config = await fixture(context)
  await config.save({ platform: 'linkedin', enabled: true, fields: { MEMBER_ID: 'member', ACCESS_TOKEN: 'first-token', API_VERSION: '' } })
  const first = config.resolve('linkedin')
  assert.ok(first)
  await config.save({ platform: 'linkedin', enabled: true, fields: { ACCESS_TOKEN: 'second-token', API_VERSION: '' } })
  assert.notStrictEqual(config.resolve('linkedin'), first)
  assert.equal(config.resolve('linkedin').accessToken, 'second-token')
  await config.save({ platform: 'facebook', enabled: true, fields: { PAGE_ID: '123', ACCESS_TOKEN: 'token', GRAPH_VERSION: '' } })
  assert.ok(config.resolve('facebook'))
})

test('发布账号拒绝非法字段、不完整启用与未同意快手明文上传', async context => {
  const config = await fixture(context)
  await assert.rejects(config.save({ platform: '__proto__', enabled: true, fields: {} }), /配置无效/)
  await assert.rejects(config.save({ platform: 'x', enabled: false, fields: { NOT_ALLOWED: 'value' } }), /字段无效/)
  await assert.rejects(config.save({ platform: 'x', enabled: false, fields: { USER_ID: 'value\n' } }), /格式无效/)
  await assert.rejects(config.save({ platform: 'x', enabled: true, fields: {} }), /参数不完整/)
  const patch = { platform: 'kuaishou', enabled: true, fields: { APP_ID: 'app', OPEN_ID: 'open', ACCESS_TOKEN: 'token' } }
  await assert.rejects(config.save(patch), /HTTP/)
  await config.save({ ...patch, allowInsecureUpload: true })
  assert.ok(config.resolve('kuaishou'))
  await Promise.all([
    config.save({ platform: 'x', enabled: false, fields: { USER_ID: '123' } }),
    config.save({ platform: 'threads', enabled: false, fields: { USER_ID: '456' } }),
  ])
  assert.equal(config.public().platforms.x.fields.USER_ID, '123')
  assert.equal(config.public().platforms.threads.fields.USER_ID, '456')
})

test('发布配置 HTTP 入口隐藏秘密、阻止跨站写入，验证只返回账号名称', async context => {
  const config = await fixture(context)
  const desk = { publishing: { config } }
  const server = createServer((request, response) => route({}, {}, desk, request, response).catch(() => { response.statusCode = 500; response.end('{}') }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/media-desk/publish/`
  const patch = { platform: 'x', enabled: true, fields: { USER_ID: '123', ACCESS_TOKEN: 'private-access-token' } }
  const post = (path, body, site = 'same-origin') => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: JSON.stringify(body) })
  assert.equal((await post('config', patch, 'cross-site')).status, 403)
  const saved = await post('config', patch)
  assert.equal(saved.status, 200)
  assert.equal((await saved.text()).includes('private-access-token'), false)
  const response = await fetch(url + 'config')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.text()).includes('private-access-token'), false)
  config.resolve = () => ({ accessToken: 'private-access-token', adapter: { account: async () => ({ id: '123', name: '测试用户' }) } })
  const verified = await post('test', { platform: 'x' })
  assert.deepEqual(await verified.json(), { account: '测试用户' })
  config.resolve = () => { throw new Error('private-access-token') }
  const failed = await post('test', { platform: 'x' })
  assert.equal(failed.status, 500)
  assert.equal((await failed.text()).includes('private-access-token'), false)
})
