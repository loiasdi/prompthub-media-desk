import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reviewOperation } from '../src/publish/maitian/review-operation.mjs'
import { BrowserOperations } from '../src/publish/maitian/browser-operations.js'
import { acquireProfileLock } from '../src/publish/maitian/profile-lock.js'
import { inspectEngine } from '../src/publish/maitian/engine-loader.mjs'
import { invalidateAccount } from '../src/publish/maitian/account-state.js'
import { completedTaskFixture } from './helpers/maitian-task.js'

async function fixture(t) {
  const f = await completedTaskFixture(t), engineRef = await inspectEngine(f.original), options = f.config.resolve(), runId = randomUUID()
  let queries = 0, closed = 0
  const calls = [], journal = new BrowserOperations(f.config.root)
  const request = { op: 'collect-links', taskId: f.record.taskId, runId, platform: 'xhs', engineRef, contractVersion: f.record.contractVersion, accountEpoch: 'initial',
    expectedProfileDir: await realpath(options.profileDir), projectRef: { projectId: f.record.projectId, data: { ...f.record.plan.data, schedule: '2020-01-01T00:00:00Z' } },
    browser: { root: f.config.root, profileDir: options.profileDir, profileId: 'default', chromePath: options.chromePath, port: options.port } }
  const deps = {
    async launch() {
      await assert.rejects(acquireProfileLock(options.profileDir, join(f.config.root, 'locks')), error => error.code === 'PROFILE_BUSY')
      return { instanceId: 'browser-a', websocketURL: 'ws://fixture.invalid' }
    },
    async connect() { return { close() { closed++ }, async send(method, params) {
      calls.push({ method, params })
      if (method === 'Target.createTarget') return { targetId: 'query-target' }
      return {}
    } } },
    async load(_reference, chrome) {
      return {
        bundle: { PLATFORMS: { xhs: { fields: {} } }, validate() { assert.fail('A query must not revalidate an expired upload schedule') } },
        publish: { ADAPTERS: { xhs: { links: { url: 'https://example.invalid/manage' } } },
          run() { assert.fail('A query must never upload or fill') }, preflight() { assert.fail('No new upload preflight required to query an old task') },
          async collectLinks(project, ids, opts) {
            queries++
            assert.deepEqual(project, { dir: f.record.projectId, data: request.projectRef.data })
            assert.deepEqual(ids, ['xhs']); assert.deepEqual(opts, {})
            const tab = await chrome.tabs.create({ url: 'https://example.invalid/manage' })
            assert.equal((await journal.read(runId)).targets[0].targetId, 'query-target')
            await chrome.tabs.remove(tab.id)
            return { xhs: { status: '已发布', url: 'https://www.xiaohongshu.com/explore/work-a', note: f.original + ' ws://127.0.0.1:9333/devtools/browser/secret', cookie: 'secret-cookie' } }
          },
        },
      }
    },
  }
  return { ...f, request, deps, calls, journal, get queries() { return queries }, get closed() { return closed } }
}

test('结果查询仅调用原版 collectLinks({dir,data}, ids, {})；无快照或过期预约仍可查询', async t => {
  const f = await fixture(t)
  await rm(join(f.config.root, 'runs'), { recursive: true })
  const result = await reviewOperation(f.request, f.deps)
  assert.equal(result.result.normalizedStatus, 'published')
  assert.equal(result.result.workId, undefined)
  assert.equal(f.queries, 1); assert.equal(f.closed, 1)
  assert.equal((await f.journal.read(f.request.runId)).op, 'collect-links')
  assert.equal(f.calls.filter(call => call.method === 'Target.closeTarget').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /secret|secret-cookie|\/original/)
  assert.equal((await inspectEngine(f.original)).fingerprint, f.request.engineRef.fingerprint)
})

test('查询过程中组件改变、结果契约退化或账号 epoch 变化时停止接受结果，释放 profile 锁', async t => {
  for (const mode of ['engine', 'result', 'account']) {
    const f = await fixture(t), original = f.deps.load
    f.deps.load = async (...args) => {
      const engine = await original(...args)
      engine.publish.collectLinks = async () => {
        if (mode === 'engine') await writeFile(join(f.original, 'lib/init.js'), 'export const changed = true')
        if (mode === 'account') await invalidateAccount(f.request.browser.profileDir, 'xhs')
        return mode === 'result' ? { xhs: { status: true } } : { xhs: { status: '已发布' } }
      }
      return engine
    }
    await assert.rejects(reviewOperation(f.request, f.deps), error => ({ engine: 'COMPONENT_CHANGED', result: 'INCOMPATIBLE_LINK_RESULT', account: 'ACCOUNT_CHANGED' })[mode] === error.code)
    const lock = await acquireProfileLock(f.request.browser.profileDir, join(f.config.root, 'locks')); await lock.release()
    assert.equal(f.closed, 1)
  }
})

test('旧任务工程协议不兼容、其他 profile 或缺少查询能力时，不调用原版作品查询', async t => {
  const f = await fixture(t)
  await assert.rejects(reviewOperation({ ...f.request, contractVersion: 'unknown' }, f.deps), error => error.code === 'INCOMPATIBLE_QUERY_PROJECT')
  await assert.rejects(reviewOperation({ ...f.request, expectedProfileDir: '/different-profile' }, f.deps), error => error.code === 'ACCOUNT_CHANGED')
  const original = f.deps.load
  f.deps.load = async (...args) => { const engine = await original(...args); delete engine.publish.collectLinks; return engine }
  await assert.rejects(reviewOperation(f.request, f.deps), error => error.code === 'MISSING_COLLECT_LINKS')
  assert.equal(f.queries, 0)
})
