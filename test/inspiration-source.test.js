import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSharedLink, sourceKind, sourceImage, playableVideo } from '../src/inspiration-source.js'
import { sourceAssets } from '../src/workspace-schema.js'

test('分享文案提取短视频链接，保留原文并识别旧网页收藏', () => {
  const text = '1.20 复制打开抖音，看看【金属笔小子的作品】上个鸟班 https://v.douyin.com/e0pPCEWa7bI/ zgb:/ 10/02'
  assert.deepEqual(parseSharedLink(text), { url: 'https://v.douyin.com/e0pPCEWa7bI/', text })
  assert.equal(sourceKind({ kind: 'web', url: parseSharedLink(text).url }), 'video')
  assert.equal(sourceKind({ kind: 'web', url: 'https://fake-douyin.com/video' }), 'web')
  assert.throws(() => parseSharedLink('javascript:alert(1)'), /http/)
})

test('视频封面按图片预览，上传的视频可播放，素材登记不会把封面当视频', () => {
  const shared = { kind: 'video', url: 'https://v.douyin.com/abc/', media: { src: 'https://example.com/cover.jpg' } }
  assert.equal(playableVideo(shared), false)
  assert.equal(sourceImage(shared), shared.media.src)
  assert.equal(sourceAssets(shared)[0].type, 'image')
  const uploaded = { kind: 'video', media: { src: 'media-desk/files/test.mp4' } }
  assert.equal(playableVideo(uploaded), true)
  assert.equal(sourceAssets(uploaded)[0].type, 'video')
  assert.equal(sourceKind({ kind: 'image', media: { src: 'media-desk/files/test.png' } }), 'image')
})
