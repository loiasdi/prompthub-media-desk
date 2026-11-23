import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MaitianError } from './errors.js'

const exec = promisify(execFile)
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { timeout: 3000, maxBuffer: 64_000 })
    return stdout.trim() || null
  } catch (error) {
    if (error.code === 1) return null
    throw new MaitianError('PROCESS_CHECK_FAILED', '无法核对执行进程，请稍后重试')
  }
}

const busy = () => new MaitianError('PROFILE_BUSY', '专用 Chrome 正在执行其他操作，请稍后重试')
// The owner file is prepared before acquisition. Never delete a successor's lock based on an old observation.
export async function acquireProfileLock(profileDir, locksRoot) {
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const canonical = await realpath(profileDir)
  await mkdir(locksRoot, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(canonical).digest('hex')
  const lock = join(locksRoot, key)
  const token = randomUUID()
  const name = `owner-${process.pid}-${token}.json`
  const temporary = join(locksRoot, `.pending-${token}`)
  const identity = await processIdentity(process.pid)
  await mkdir(temporary, { mode: 0o700 })
  try {
    await writeFile(join(temporary, name), JSON.stringify({ pid: process.pid, identity, token, acquiredAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await rename(temporary, lock); break }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        const entries = await readdir(lock).catch(() => [])
        if (entries.length !== 1 || !/^owner-\d+-[a-f0-9-]+\.json$/.test(entries[0])) throw busy()
        let previous
        try { previous = JSON.parse(await readFile(join(lock, entries[0]), 'utf8')) } catch { throw busy() }
        if (!Number.isInteger(previous.pid) || typeof previous.identity !== 'string' || !previous.identity) throw busy()
        const current = await processIdentity(previous.pid)
        if (current === previous.identity) throw busy()
        // Remove only the uniquely named observed owner, then remove the directory only if still empty.
        await rm(join(lock, entries[0]), { force: true })
        await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error })
        if (attempt === 1) throw busy()
      }
    }
    let released = false
    return {
      profileDir: canonical, token,
      async release() {
        if (released) return
        released = true
        await rm(join(lock, name), { force: true })
        await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error })
      },
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
