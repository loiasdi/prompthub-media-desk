import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dshHome } from '../store.js'
import { fail } from '../workspace-schema.js'
import { configuredPlatform, accountOf } from './platforms.js'
import { PUBLISH_CONFIG_FIELDS, publishConfigPlatforms } from './config-schema.js'

export class PublishConfig {
  constructor(root = join(dshHome(), 'media-desk-publishing'), env = process.env) {
    this.root = root
    this.file = join(root, 'config.json')
    this.env = env
    this.queue = Promise.resolve()
    this.cache = new Map()
  }

  read() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  }

  environment(platform, value = this.read()) {
    const env = { ...this.env }
    const row = value[platform]
    if (!row) return env
    const prefix = `MEDIA_DESK_${platform.toUpperCase()}_`
    env[`${prefix}PUBLISH`] = row.enabled ? '1' : '0'
    for (const { key, optional } of PUBLISH_CONFIG_FIELDS[platform]) {
      if (!Object.hasOwn(row.fields, key)) continue
      if (optional && !row.fields[key]) delete env[prefix + key]
      else env[prefix + key] = row.fields[key]
    }
    if (platform === 'kuaishou') env[`${prefix}ALLOW_INSECURE_UPLOAD`] = row.allowInsecureUpload ? '1' : '0'
    return env
  }

  resolve(platform) {
    if (!Object.hasOwn(PUBLISH_CONFIG_FIELDS, platform)) return null
    const env = this.environment(platform)
    const prefix = `MEDIA_DESK_${platform.toUpperCase()}_`
    const signature = JSON.stringify(Object.entries(env).filter(([key]) => key.startsWith(prefix)))
    const cached = this.cache.get(platform)
    if (cached?.signature === signature) return cached.config
    const config = configuredPlatform(platform, env)
    this.cache.set(platform, { signature, config })
    return config
  }

  public() {
    const value = this.read()
    return { platforms: Object.fromEntries(publishConfigPlatforms.map(platform => {
      const env = this.environment(platform, value)
      const prefix = `MEDIA_DESK_${platform.toUpperCase()}_`
      const fields = Object.fromEntries(PUBLISH_CONFIG_FIELDS[platform].filter(field => !field.secret).map(({ key }) => [key, env[prefix + key] || '']))
      const secrets = Object.fromEntries(PUBLISH_CONFIG_FIELDS[platform].filter(field => field.secret).map(({ key }) => [key, Boolean(env[prefix + key])]))
      return [platform, { enabled: env[`${prefix}PUBLISH`] === '1', configured: Boolean(configuredPlatform(platform, env)), fields, secrets, allowInsecureUpload: env[`${prefix}ALLOW_INSECURE_UPLOAD`] === '1' }]
    })) }
  }

  save(patch) {
    const run = this.queue.then(async () => {
      const { platform, enabled, fields, clearSecrets = [], allowInsecureUpload = false } = patch
      if (!Object.hasOwn(PUBLISH_CONFIG_FIELDS, platform) || typeof enabled !== 'boolean' || !fields || typeof fields !== 'object' || Array.isArray(fields) || !Array.isArray(clearSecrets) || typeof allowInsecureUpload !== 'boolean') throw fail('发布账号配置无效')
      const schema = PUBLISH_CONFIG_FIELDS[platform]
      if (Object.keys(fields).some(key => !schema.some(field => field.key === key)) || clearSecrets.some(key => !schema.some(field => field.key === key && field.secret))) throw fail('发布账号字段无效')
      const value = this.read()
      const row = { enabled, allowInsecureUpload, fields: { ...value[platform]?.fields } }
      for (const { key, secret } of schema) {
        if (!Object.hasOwn(fields, key)) continue
        if (typeof fields[key] !== 'string' || fields[key].length > 4096 || /[\x00-\x1f\x7f]/.test(fields[key])) throw fail('发布账号字段格式无效')
        const text = fields[key].trim()
        if (!secret || text) row.fields[key] = text
      }
      for (const key of clearSecrets) row.fields[key] = ''
      value[platform] = row
      if (enabled && !configuredPlatform(platform, this.environment(platform, value))) throw fail('账号参数不完整或格式无效；快手还需明确同意 HTTP 上传风险')
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
      await rename(temporary, this.file)
      return this.public()
    })
    this.queue = run.catch(() => {})
    return run
  }

  async test(platform) {
    const config = this.resolve(platform)
    if (!config) throw fail('请先保存并启用此平台账号', 409)
    const account = await accountOf(platform, config, AbortSignal.timeout(30_000))
    return { account: account.name }
  }
}
