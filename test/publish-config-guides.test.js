import assert from 'node:assert/strict'
import test from 'node:test'
import { PUBLISH_CONFIG_FIELDS } from '../src/publish/config-schema.js'
import { PUBLISH_CONFIG_GUIDES, PUBLISH_GUIDE_EN } from '../src/publish/config-guides.js'

test('每个发布平台都有获取步骤、官方入口、完整字段说明与英文引导', () => {
  assert.deepEqual(Object.keys(PUBLISH_CONFIG_GUIDES).sort(), Object.keys(PUBLISH_CONFIG_FIELDS).sort())
  const officialDomains = new Set(['developers.facebook.com', 'developers.google.com', 'console.cloud.google.com', 'open.bilibili.com', 'open.douyin.com', 'developer.open-douyin.com', 'open.kuaishou.com', 'www.linkedin.com', 'learn.microsoft.com', 'developer.x.com', 'docs.x.com', 'developers.pinterest.com', 'developers.tiktok.com', 'mp.weixin.qq.com', 'developers.weixin.qq.com', 'bsky.app', 'atproto.com'])
  for (const [platform, fields] of Object.entries(PUBLISH_CONFIG_FIELDS)) {
    const guide = PUBLISH_CONFIG_GUIDES[platform]
    assert.ok(guide.steps.length >= 3, platform)
    assert.ok(guide.links.length >= 1, platform)
    assert.deepEqual(Object.keys(guide.fields).sort(), fields.map(field => field.key).sort(), platform)
    for (const value of [...guide.steps, ...Object.values(guide.fields), guide.warning]) {
      assert.ok(value.length > 10, platform)
      assert.ok(PUBLISH_GUIDE_EN[value]?.length > 10, `${platform}: missing English guide`)
    }
    for (const link of guide.links) {
      const url = new URL(link.href)
      assert.equal(url.protocol, 'https:')
      assert.ok(officialDomains.has(url.hostname), url.hostname)
      assert.equal(url.username + url.password + url.search, '')
    }
  }
})
