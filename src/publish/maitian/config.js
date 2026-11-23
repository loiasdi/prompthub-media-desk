import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHome } from '../../store.js'
import { MaitianError } from './errors.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = new Set(['enabled', 'source', 'localComponentDir', 'exportComponentDir', 'chromePath', 'nodePath', 'profileId', 'port', 'fillTimeoutMinutes'])
export class MaitianConfig {
  constructor(root = join(dshHome(), 'media-desk-publishing', 'maitian')) {
    this.root = root
    this.file = join(root, 'config.json')
    this.queue = Promise.resolve()
  }
  read() {
    let saved
    try { saved = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new MaitianError('INVALID_CONFIG', '麦田配置无法读取，请检查本机配置文件')
      saved = {}
    }
    return this.validate({ enabled: false, source: 'store', localComponentDir: '', exportComponentDir: '', chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', nodePath: '', profileId: 'default', port: 9333, fillTimeoutMinutes: 360, ...saved })
  }
  validate(value) {
    if (!object(value) || Object.keys(value).some(key => !keys.has(key)) || typeof value.enabled !== 'boolean' || !['store', 'local'].includes(value.source) || !/^[a-zA-Z0-9_-]{1,60}$/.test(value.profileId) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new MaitianError('INVALID_CONFIG', '麦田配置字段无效', 400)
    if (!Number.isInteger(value.fillTimeoutMinutes) || value.fillTimeoutMinutes < 1 || value.fillTimeoutMinutes > 1440) throw new MaitianError('INVALID_CONFIG', '填写保护时限须为 1 至 1440 分钟的整数', 400)
    for (const key of ['localComponentDir', 'exportComponentDir', 'chromePath', 'nodePath']) {
      if (typeof value[key] !== 'string' || value[key].length > 4096 || /[\x00-\x1f\x7f]/.test(value[key]) || value[key] && !isAbsolute(value[key])) throw new MaitianError('INVALID_CONFIG', '执行器和组件路径必须是绝对路径', 400)
    }
    if (value.source === 'local' && !value.localComponentDir) throw new MaitianError('INVALID_CONFIG', '本地模式需要原版组件目录', 400)
    return value
  }
  resolve(value = this.read()) {
    return { ...value, nodePath: value.nodePath || process.execPath, profileDir: join(this.root, 'profiles', value.profileId) }
  }
  public() {
    const value = this.read()
    return {
      enabled: value.enabled, source: value.source, profileId: value.profileId, port: value.port,
      fillTimeoutMinutes: value.fillTimeoutMinutes,
      chromeConfigured: Boolean(value.chromePath), nodeConfigured: Boolean(value.nodePath), localComponentConfigured: Boolean(value.localComponentDir), exportComponentConfigured: Boolean(value.exportComponentDir || value.localComponentDir),
      executionLocation: 'host-machine',
    }
  }
  save(patch) {
    const pending = this.queue.then(async () => {
      if (!object(patch) || Object.keys(patch).some(key => !keys.has(key))) throw new MaitianError('INVALID_CONFIG', '麦田配置字段无效', 400)
      const next = this.validate({ ...this.read(), ...patch })
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const temporary = join(this.root, `.config-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.file)
      } finally { await rm(temporary, { force: true }) }
      return this.public()
    })
    this.queue = pending.catch(() => {})
    return pending
  }
}
