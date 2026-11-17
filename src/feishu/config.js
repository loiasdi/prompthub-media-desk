import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from '../store.js'

export const failure = (message, status = 400) => Object.assign(new Error(message), { status })
export class FeishuConfig {
  constructor(root = join(dshHome(), 'media-desk-feishu')) { this.root = root; this.file = join(root, 'config.json') }
  async read() {
    try { return JSON.parse(await readFile(this.file, 'utf8')) }
    catch (e) { if (e.code !== 'ENOENT') throw e; return {} }
  }
  public(value) { const { appSecret, ...rest } = value; return { ...rest, hasSecret: Boolean(appSecret), ready: Boolean(value.appId && appSecret && value.folderToken && value.appToken && value.tableId) } }
  async save(patch) {
    const value = await this.read()
    for (const key of ['appId', 'folderToken', 'appToken', 'tableId']) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'string' || !/^[\w-]{0,200}$/.test(patch[key].trim())) throw failure(`${key} 格式无效，请填写标识而非链接`)
        value[key] = patch[key].trim()
      }
    }
    if (typeof patch.appSecret === 'string' && patch.appSecret.trim()) value.appSecret = patch.appSecret.trim().slice(0, 1000)
    if (patch.clearSecret === true) value.appSecret = ''
    await this.write(this.file, value)
    return this.public(value)
  }
  async write(path, value) {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temp, path)
  }
}
