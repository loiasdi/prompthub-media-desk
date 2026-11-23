import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { acquireProfileLock, processIdentity } from '../src/publish/maitian/profile-lock.js'
import { createChromeShim, CDPConnection } from '../src/publish/maitian/chrome-shim.mjs'
import { ensureBrowser } from '../src/publish/maitian/browser.mjs'

test('profile 锁按实际目录互斥，别名不可绕过；释放不会删掉后继持有者', async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile'), locks = join(root, 'locks')
  const first = await acquireProfileLock(profile, locks)
  const alias = join(root, 'alias')
  await symlink(profile, alias)
  await assert.rejects(acquireProfileLock(alias, locks), error => error.code === 'PROFILE_BUSY')
  await first.release()
  const next = await acquireProfileLock(alias, locks)
  await first.release()
  await assert.rejects(acquireProfileLock(profile, locks), error => error.code === 'PROFILE_BUSY')
  await next.release()
  assert.deepEqual(await readdir(locks), [])
})

test('profile 锁恢复仅清理已终止进程的唯一 owner，不凭心跳超时抢活进程', async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile'), locks = join(root, 'locks')
  const first = await acquireProfileLock(profile, locks)
  const dir = join(locks, (await readdir(locks))[0])
  const owner = join(dir, (await readdir(dir))[0])
  const value = JSON.parse(await readFile(owner, 'utf8'))
  value.acquiredAt = '2000-01-01T00:00:00Z'
  await writeFile(owner, JSON.stringify(value))
  await assert.rejects(acquireProfileLock(profile, locks), error => error.code === 'PROFILE_BUSY')
  assert.ok(await processIdentity(process.pid))
  value.identity = 'a different process start identity'
  await writeFile(owner, JSON.stringify(value))
  const replacement = await acquireProfileLock(profile, locks)
  await first.release()
  await assert.rejects(acquireProfileLock(profile, locks), error => error.code === 'PROFILE_BUSY')
  await replacement.release()
})

function facade() {
  const pages = new Map(), calls = [], persisted = []
  let count = 0, shim
  const send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId })
    if (method === 'Target.createTarget') { const targetId = `target-${++count}`; pages.set(targetId, { targetId, type: 'page', url: params.url, title: '标题' }); return { targetId } }
    if (method === 'Target.getTargetInfo') { if (!pages.has(params.targetId)) throw Error('missing'); return { targetInfo: pages.get(params.targetId) } }
    if (method === 'Target.attachToTarget') return { sessionId: `session-${params.targetId}` }
    if (method === 'Target.closeTarget') { pages.delete(params.targetId); shim.event('Target.targetDestroyed', { targetId: params.targetId }); return { success: true } }
    if (method === 'Runtime.evaluate') return { result: { value: 42 } }
    return {}
  }
  shim = createChromeShim({ send, instanceId: 'browser-a', onTarget: async target => { persisted.push(target) } })
  return { shim, send, pages, calls, persisted }
}

test('Chrome shim 持久化 target 后交回原版；重连精确激活原页，不按相同 URL 猜测', async () => {
  const f = facade()
  const a = await f.shim.chrome.tabs.create({ url: 'https://example.invalid/upload' })
  const b = await f.shim.chrome.tabs.create({ url: 'https://example.invalid/upload' })
  assert.equal(f.persisted.length, 2)
  const target = f.shim.targetOf(a.id)
  assert.notEqual(target.targetId, f.shim.targetOf(b.id).targetId)
  const fresh = createChromeShim({ send: f.send, instanceId: 'browser-a' })
  await fresh.openOriginal(target)
  assert.deepEqual(f.calls.filter(call => call.method === 'Target.activateTarget').at(-1).params, { targetId: target.targetId })
  const other = createChromeShim({ send: f.send, instanceId: 'browser-b' })
  await assert.rejects(other.openOriginal(target), error => error.code === 'BROWSER_CHANGED')
  await f.shim.chrome.tabs.remove(a.id)
  await assert.rejects(fresh.openOriginal(target), /missing/)
  assert.equal(f.calls.filter(call => call.method === 'Target.createTarget').length, 2)
})

test('Chrome shim 共享单次 attach、转发文件上传 CDP、detach 不关闭页面', async () => {
  const f = facade()
  const tab = await f.shim.chrome.tabs.create({ url: 'about:blank', active: true })
  const notifications = []
  f.shim.chrome.debugger.onDetach.addListener(event => notifications.push(event))
  await Promise.all([f.shim.chrome.debugger.attach({ tabId: tab.id }), f.shim.chrome.debugger.attach({ tabId: tab.id })])
  assert.equal(f.calls.filter(call => call.method === 'Target.attachToTarget').length, 1)
  await f.shim.chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', { files: ['/controlled/video.mp4'] })
  assert.equal(f.calls.at(-1).sessionId, 'session-target-1')
  assert.deepEqual((await f.shim.chrome.tabs.query({ active: true })).map(row => row.id), [tab.id])
  await f.shim.chrome.debugger.detach({ tabId: tab.id })
  assert.equal(notifications.length, 1)
  assert.equal(f.pages.size, 1)
})

class Socket extends EventTarget {
  constructor() {
    super(); this.readyState = 0; this.sent = []; this.reply = true
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
  }
  send(message) {
    const value = JSON.parse(message); this.sent.push(value)
    if (this.reply) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: value.id, result: { value: value.method } }) })))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
test('CDP 连接关联请求回执、处理超时并在断开时拒绝未完成操作', async () => {
  const socket = new Socket()
  const connection = new CDPConnection('ws://test', { timeoutMs: 10, socketFactory: () => socket })
  await connection.connect()
  assert.deepEqual(await connection.send('Browser.getVersion'), { value: 'Browser.getVersion' })
  socket.reply = false
  await assert.rejects(connection.send('Runtime.evaluate'), error => error.code === 'CDP_COMMAND_TIMEOUT')
  const pending = connection.send('Page.navigate')
  socket.close()
  await assert.rejects(pending, error => error.code === 'CHROME_DISCONNECTED')
  assert.equal(connection.pending.size, 0)
})

test('已有调试端口没有本项目浏览器记录时拒绝连接，不尝试启动 Chrome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-browser-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/unknown' }))
  await assert.rejects(ensureBrowser({ profileDir: root, chromePath: '/never-run-this', port: 9333, headless: true }), error => error.code === 'CHROME_PORT_CONFLICT')
  assert.deepEqual(await readdir(root), [])
})

test('非浏览器进程占用调试端口时拒绝启动；恢复原页不会新建浏览器', async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-browser-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  await assert.rejects(ensureBrowser({ profileDir: root, chromePath: '/never-run-this', port, headless: true }), error => error.code === 'CHROME_PORT_CONFLICT')
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  await assert.rejects(ensureBrowser({ profileDir: root, chromePath: '/never-run-this', port, headless: true, existingOnly: true }), error => error.code === 'BROWSER_CHANGED')
  assert.deepEqual(await readdir(root), [])
})
