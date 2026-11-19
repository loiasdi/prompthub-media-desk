import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePublishConfigResponse } from '../client/publish-config-response.js'
import { PUBLISH_CONFIG_FIELDS } from '../src/publish/config-schema.js'

const response = () => ({ platforms: Object.fromEntries(Object.entries(PUBLISH_CONFIG_FIELDS).map(([platform, fields]) => [platform, {
  enabled: false, configured: false,
  fields: Object.fromEntries(fields.filter(field => !field.secret).map(field => [field.key, ''])),
  secrets: Object.fromEntries(fields.filter(field => field.secret).map(field => [field.key, false])),
}])) })

test('发布配置响应必须包含所有平台表单，不把空响应或旧后端当作成功', () => {
  const valid = response()
  assert.strictEqual(validatePublishConfigResponse(valid), valid)
  for (const invalid of [null, {}, [], { platforms: {} }, { error: 'old backend' }]) {
    assert.throws(() => validatePublishConfigResponse(invalid), /更新并重启 DSH Host/)
  }
  delete valid.platforms.youtube
  assert.throws(() => validatePublishConfigResponse(valid), /接口返回不完整/)
})

test('发布配置响应拒绝缺少字段或密钥状态的半成品响应', () => {
  const missingFields = response()
  delete missingFields.platforms.youtube.fields.CLIENT_ID
  assert.throws(() => validatePublishConfigResponse(missingFields), /接口返回不完整/)
  const missingSecrets = response()
  delete missingSecrets.platforms.youtube.secrets
  assert.throws(() => validatePublishConfigResponse(missingSecrets), /接口返回不完整/)
})
