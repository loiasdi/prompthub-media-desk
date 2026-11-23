import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { processIdentity } from '../src/publish/maitian/profile-lock.js'

const runnerFile = fileURLToPath(new URL('./helpers/maitian-ipc-runner.mjs', import.meta.url))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-task-ipc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { op: 'fill', taskId: randomUUID(), runId: randomUUID(), projectRef: { marker: join(root, 'intent') }, timeoutMs: 2000 }
}

test('真实 IPC 子进程等待落盘授权，拒绝旧 run 和重复 seq，确认退出后才兑现结果', async t => {
  const request = await fixture(t)
  const events = []
  let pid, authorizations = 0
  const start = Date.now()
  const result = await runComponent({ ...request,
    onSpawn: async spawned => { pid = spawned.pid; assert.ok(await processIdentity(pid)) },
    onReady: async () => { authorizations++; await writeFile(request.projectRef.marker, 'durable-intent') },
    onEvent: async event => { events.push(event); assert.ok(await processIdentity(pid)) },
  }, { runnerFile })
  assert.deepEqual(result, { marker: 'durable-intent' })
  assert.equal(authorizations, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].seq, 2)
  assert.equal(events[0].state.status, 'durable-intent')
  assert.equal(await processIdentity(pid), null)
  assert.ok(Date.now() - start >= 140, 'A result message does not release the process slot before close')
})

test('取消经 IPC 协作传递，不能将发出请求当作子进程已停止', async t => {
  const request = await fixture(t), controller = new AbortController()
  let pid, requestedAt
  await assert.rejects(runComponent({ ...request, signal: controller.signal,
    onSpawn: async spawned => { pid = spawned.pid },
    onReady: async () => { requestedAt = Date.now(); controller.abort(); assert.ok(await processIdentity(pid)) },
  }, { runnerFile }), error => error.code === 'RUNNER_EXITED')
  assert.equal(await readFile(request.projectRef.marker, 'utf8'), 'cancel-observed')
  assert.ok(Date.now() - requestedAt >= 190)
  assert.equal(await processIdentity(pid), null)
})

test('执行器心跳中断先结束实际子进程；授权落盘失败不会发 execute', async t => {
  const request = await fixture(t)
  let pid
  await assert.rejects(runComponent({ ...request, projectRef: { ...request.projectRef, mode: 'silent' }, heartbeatMs: 80,
    onSpawn: async spawned => { pid = spawned.pid }, onReady: async () => assert.fail('No ready message'),
  }, { runnerFile }), error => error.code === 'RUNNER_HEARTBEAT_LOST')
  assert.equal(await processIdentity(pid), null)
  await assert.rejects(runComponent({ ...request, onReady: async () => { throw Error('disk failure') } }, { runnerFile }), /disk failure/)
  await assert.rejects(readFile(request.projectRef.marker), { code: 'ENOENT' })
})

test('只读查询使用独立 task/run IPC 标识，不需要填写授权且不接受旧查询结果', async t => {
  const request = await fixture(t)
  let pid
  const result = await runComponent({ ...request, op: 'collect-links',
    onSpawn: async spawned => { pid = spawned.pid }, onReady: async () => assert.fail('Queries never request fill authorisation'),
  }, { runnerFile })
  assert.deepEqual(result, { result: { status: '未找到', url: null } })
  assert.equal(await processIdentity(pid), null)
})

test('填写保护时限先协作停止，等待真实退出；即使正常结束也返回超时待核对', async t => {
  const request = await fixture(t)
  let pid, timeoutCalls = 0, timedOutAt
  await assert.rejects(runComponent({ ...request, timeoutMs: 500, stopGraceMs: 1000,
    projectRef: { ...request.projectRef, mode: 'timeout-cooperate' },
    onSpawn: async spawned => { pid = spawned.pid }, onReady: async () => {},
    onTimeout: async () => { timeoutCalls++; timedOutAt = Date.now(); assert.ok(await processIdentity(pid)) },
  }, { runnerFile }), error => error.code === 'RUNNER_TIMEOUT')
  assert.equal(timeoutCalls, 1)
  assert.equal(await readFile(request.projectRef.marker, 'utf8'), 'cancel-observed')
  assert.ok(Date.now() - timedOutAt >= 190)
  assert.equal(await processIdentity(pid), null)
})

test('上游不响应停止时宽限期后终止执行器；超时期间 ready 不得再发送执行授权', async t => {
  const request = await fixture(t)
  let pid, timedOutAt
  await assert.rejects(runComponent({ ...request, timeoutMs: 500, stopGraceMs: 120,
    projectRef: { ...request.projectRef, mode: 'timeout-ignore' },
    onSpawn: async spawned => { pid = spawned.pid }, onReady: async () => {},
    onTimeout: async () => { timedOutAt = Date.now() },
  }, { runnerFile }), error => error.code === 'RUNNER_TIMEOUT')
  assert.ok(Date.now() - timedOutAt >= 100)
  assert.equal(await readFile(request.projectRef.marker, 'utf8'), 'execution-began')
  assert.equal(await processIdentity(pid), null)
  await assert.rejects(runComponent({ ...request, timeoutMs: 300, stopGraceMs: 1000,
    onReady: async () => { await new Promise(resolve => setTimeout(resolve, 450)) },
  }, { runnerFile }), error => error.code === 'RUNNER_TIMEOUT')
  assert.equal(await readFile(request.projectRef.marker, 'utf8'), 'cancel-observed')
})
