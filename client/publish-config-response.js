import { PUBLISH_CONFIG_FIELDS, publishConfigPlatforms } from '../src/publish/config-schema.js'

export function validatePublishConfigResponse(data) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  const valid = object(data?.platforms) && publishConfigPlatforms.every(platform => {
    const row = data.platforms[platform]
    return object(row) && typeof row.enabled === 'boolean' && typeof row.configured === 'boolean'
      && object(row.fields) && object(row.secrets)
      && PUBLISH_CONFIG_FIELDS[platform].every(field => field.secret ? typeof row.secrets[field.key] === 'boolean' : typeof row.fields[field.key] === 'string')
  })
  if (!valid) throw new Error('发布配置接口返回不完整，请更新并重启 DSH Host 后重试')
  return data
}
