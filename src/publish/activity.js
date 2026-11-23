import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { processIdentity } from './maitian/profile-lock.js'
import { fail } from '../workspace-schema.js'

const NAME = /^activity-([1-9]\d*)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json$/
let ownIdentity
const identity = () => ownIdentity ??= ['darwin', 'linux'].includes(process.platform) ? processIdentity(process.pid) : Promise.resolve(null)
const busy = () => fail('有发布操作正在进行，请完成后重试', 409)

async function alive(owner) {
  try { process.kill(owner.pid, 0) }
  catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
  // A live PID is retained conservatively on other systems, rather than expired by age.
  if (typeof owner.identity === 'string' && ['darwin', 'linux'].includes(process.platform)) return await processIdentity(owner.pid) === owner.identity
  return true
}

// Call under Store.run. An expired timestamp alone never clears a live operation.
export async function assertNoPublishActivities(root, { exceptToken } = {}) {
  const folder = join(root, '.publish-activities')
  let info
  try { info = await lstat(folder) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!info.isDirectory()) throw busy()
  const entries = await readdir(folder)
  if (entries.length > 10_000) throw busy()
  for (const name of entries) {
    const match = NAME.exec(name)
    if (!match) throw busy()
    const file = join(folder, name)
    let owner
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > 16_000) throw busy()
      owner = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) { if (error.code === 'ENOENT') continue; throw busy() }
    if (owner?.version !== 1 || owner.pid !== Number(match[1]) || owner.token !== match[2]) throw busy()
    if (owner.token === exceptToken && owner.pid === process.pid && owner.identity === await identity()) continue
    if (await alive(owner)) throw busy()
    // The filename is a unique owner token, so a successor cannot be removed by an old observation.
    await rm(file, { force: true })
  }
}

// Cover network work before a prepared record exists and queries after a terminal record exists.
export async function withPublishActivity(store, kind, run) {
  if (typeof kind !== 'string' || !/^[a-z-]{1,60}$/.test(kind)) throw fail('发布操作类型无效')
  const token = randomUUID()
  const owner = { version: 1, token, pid: process.pid, identity: await identity(), kind, startedAt: new Date().toISOString() }
  let file
  try {
    const root = await store.run(async () => {
      await store.refresh()
      const root = store.root
      const folder = join(root, '.publish-activities')
      await mkdir(folder, { recursive: true, mode: 0o700 })
      if (!(await lstat(folder)).isDirectory()) throw busy()
      file = join(folder, `activity-${process.pid}-${token}.json`)
      await writeFile(file, JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
      return root
    })
    return await run({ root, token })
  } finally { if (file) await rm(file, { force: true }) }
}
