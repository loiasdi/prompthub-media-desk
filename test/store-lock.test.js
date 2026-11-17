import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../src/store.js'

const storeUrl = new URL('../src/store.js', import.meta.url).href
const launch = (root, code) => spawn(process.execPath, ['--input-type=module', '-e', `import { Store } from ${JSON.stringify(storeUrl)}; const store = new Store(process.argv[1]); ${code}`, root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
const result = child => {
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  return once(child, 'exit').then(([code, signal]) => ({ code, signal, errors }))
}

test('失效锁恢复竞争：多个 Store 只能串行进入临界区，不留下临时锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-lock-race-'))
  const dead = launch(root, 'process.exit(0)')
  await result(dead)
  try {
    for (let round = 0; round < 5; round++) {
      const lock = join(root, '.state-lock')
      await mkdir(lock)
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: dead.pid }))
      let active = 0
      let max = 0
      await Promise.all(Array.from({ length: 12 }, () => new Store(root).run(async () => {
        active++
        max = Math.max(max, active)
        await delay(3)
        active--
      })))
      assert.equal(max, 1, `第 ${round + 1} 轮不能同时取得锁`)
      assert.deepEqual(await readdir(root), [])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('真实 Host 进程崩溃后并发恢复：多进程写入不重叠，全部计数保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-lock-processes-'))
  const children = []
  try {
    const store = new Store(root)
    await store.mutate('', state => { state.lockTestCount = 0 }, { undoable: false })
    const owner = launch(root, 'await store.run(async () => { process.send("locked"); await new Promise(() => { setInterval(() => {}, 1000) }) });')
    children.push(owner)
    const ownerResult = result(owner)
    assert.equal((await once(owner, 'message'))[0], 'locked')
    owner.kill('SIGKILL')
    assert.equal((await ownerResult).signal, 'SIGKILL')
    const workers = Array.from({ length: 6 }, () => {
      const worker = launch(root, `
        import { mkdir, rmdir } from 'node:fs/promises';
        import { join } from 'node:path';
        import { setTimeout as delay } from 'node:timers/promises';
        for (let turn = 0; turn < 4; turn++) await store.mutate('', async state => {
          const marker = join(store.root, 'inside-critical-section');
          await mkdir(marker);
          try { await delay(5); state.lockTestCount++; } finally { await rmdir(marker); }
        }, { undoable: false });
        process.disconnect();
      `)
      children.push(worker)
      return result(worker)
    })
    for (const completed of await Promise.all(workers)) assert.equal(completed.code, 0, completed.errors)
    assert.equal((await new Store(root).read()).lockTestCount, 24)
    assert.ok(!(await readdir(root)).some(name => name.startsWith('.state-lock')))
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})
