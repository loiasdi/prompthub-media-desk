import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MaitianError } from './errors.js'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const missing = () => new MaitianError('PAGE_REFERENCE_LOST', '原页面记录不存在或无法读取，请在专用 Chrome 中核对')

// Private browser metadata, separate from publication records. It contains no page content or credentials.
export class BrowserOperations {
  constructor(root) { this.root = join(root, 'browser-operations'); this.queue = Promise.resolve() }
  file(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new MaitianError('INVALID_OPERATION', '浏览器操作标识无效', 400)
    return join(this.root, `${id}.json`)
  }
  write(value) {
    const file = this.file(value.operationId)
    const payload = JSON.stringify(value)
    const pending = this.queue.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, payload, { flag: 'wx', mode: 0o600 })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
    })
    this.queue = pending.catch(() => {})
    return pending
  }
  async read(id) {
    const file = this.file(id)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > 256_000) throw missing()
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (value.version !== 1 || value.operationId !== id || typeof value.profileDir !== 'string' || !Array.isArray(value.targets) || value.targets.length > 100) throw missing()
      return value
    } catch (error) {
      if (error instanceof MaitianError) throw error
      throw missing()
    }
  }
}
