import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_PUBLISH_FIELDS, publishOptions, publishReadiness } from '../client/publish-readiness.js'
import { MAX_ASSET_BYTES } from '../src/asset-rules.js'
import { PUBLISH_COVER_BYTES } from '../src/publish/media-rules.js'
import { articleImageMarker } from '../src/publish/article-images.js'

const video = { type: 'video', src: 'media-desk/files/piece/local.mp4', bytes: 100 }
const cover = { type: 'image', src: '/media-desk/files/piece/cover.png', bytes: 30 }
const publish = { title: '准备发布的稿件', description: '正文', tags: '#标签', format: 'video', mode: 'now' }
const remote = { configured: true, known: true, locked: false, options: { account: '测试账号', categories: [{ id: '22', title: '生活' }] } }
const input = platform => ({
  itemId: 'piece', publish, video, images: [], publishing: { ...remote, platform },
  fields: { ...INITIAL_PUBLISH_FIELDS, categoryId: '22', ...(platform === 'bilibili' ? { copyright: '1' } : { kids: 'no' }) },
})
const row = (result, text) => result.checks.find(row => row.text === text)

test('浏览器 now 不复用 API 准备条件，即使平台 API 参数齐全也不能调用 API 投稿', () => {
  const props = input('bilibili')
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, provider: 'maitian' } }).canPrepare, false)
})

test('Bluesky 发布入口：公开确认、文字与图文准备条件一致', () => {
  const props = input('bluesky')
  props.video = undefined
  props.publish = { ...publish, format: 'text', tags: '' }
  props.publishing.options = { account: 'author.bsky.social', categories: [] }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.blueskyAudience = 'public'
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '本地成片'), undefined)
  props.publish = { ...props.publish, format: 'images' }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.images = [cover]
  assert.equal(publishReadiness(props).canPrepare, true)
  for (const images of [Array(5).fill(cover), [{ ...cover, bytes: 2_000_001 }], [{ ...cover, src: '/media-desk/files/other/image.png' }], [{ ...cover, src: '/media-desk/files/piece/image.webp' }]]) {
    assert.equal(publishReadiness({ ...props, images }).canPrepare, false)
  }
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'video' } }).canPrepare, false)
})

test('快手发布入口：视频、必选封面、公开及 AI 声明确认齐全才可准备', () => {
  const props = input('kuaishou')
  props.publish = { ...publish, format: 'video', tags: '#话题' }
  props.video = { ...video, duration: 60 }
  props.cover = { ...cover, src: '/media-desk/files/piece/cover.jpg' }
  props.publishing.options = { account: '测试快手账号', categories: [] }
  props.fields.kuaishouAudience = 'public'
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.kuaishouAi = 'no'
  assert.equal(publishReadiness(props).canPrepare, true)
  for (const patch of [
    { cover: undefined }, { cover: { ...props.cover, bytes: 10_000_000 } }, { cover },
    { video: { ...video, duration: 1801 } }, { video: { ...video, bytes: 100_000_001, duration: 60 } },
    { fields: { ...props.fields, kuaishouAudience: '' } }, { fields: { ...props.fields, kuaishouAi: 'yes' } },
  ]) assert.equal(publishReadiness({ ...props, ...patch }).canPrepare, false)
})

test('Pinterest 图文按数量、类型、大小及归属检查；不依赖视频或独立封面', () => {
  const props = input('pinterest')
  props.publish = { ...publish, format: 'images' }
  props.video = undefined
  props.cover = { type: 'image', src: 'https://example.invalid/unused.png' }
  Object.assign(props.fields, { pinterestAudience: 'public', pinterestOriginal: 'yes', pinterestAi: 'yes', pinterestPerformer: 'no' })
  assert.equal(publishReadiness(props).canPrepare, false)
  props.images = [cover]
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '本地成片'), undefined)
  assert.equal(row(ready, '发布封面'), undefined)
  assert.equal(row(ready, '发布图片（按选择顺序）').done, true)
  for (const images of [[], Array(6).fill(cover), [{ ...cover, src: 'https://example.invalid/a.png' }], [{ ...cover, src: '/media-desk/files/another/a.png' }], [{ ...cover, src: '/media-desk/files/piece/a.gif' }], [{ ...cover, bytes: PUBLISH_COVER_BYTES + 1 }], Array(3).fill({ ...cover, bytes: 8 * 1024 * 1024 })]) {
    assert.equal(publishReadiness({ ...props, images }).canPrepare, false)
  }
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'text' } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publishing: { ...props.publishing, platform: 'x' } }).canPrepare, false)
})

test('公众号文章必须有本地封面，标题/话题/作者/摘要和评论/原生声明齐全后才可准备', () => {
  const props = input('wechat')
  props.publish = { ...publish, format: 'article', tags: '' }
  props.video = undefined
  props.publishing.options = { account: '公众号 AppID', categories: [] }
  Object.assign(props.fields, { wechatAudience: 'public', wechatComment: 'no', wechatDeclaration: 'no' })
  assert.equal(publishReadiness(props).canPrepare, false)
  assert.equal(row(publishReadiness(props), '发布封面').optional, false)
  props.cover = cover
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '本地成片'), undefined)
  assert.deepEqual(publishOptions('wechat', props.fields), { privacyStatus: 'public', author: '', digest: '', allowComment: false, onlyFansComment: false, requiresNativeDeclaration: false })
  for (const patch of [{ wechatAudience: '' }, { wechatComment: '' }, { wechatDeclaration: '' }, { wechatDeclaration: 'yes' }, { wechatAuthor: '字'.repeat(17) }, { wechatDigest: '字'.repeat(121) }, { wechatComment: 'yes' }]) assert.equal(publishReadiness({ ...props, fields: { ...props.fields, ...patch } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, fields: { ...props.fields, wechatComment: 'yes', wechatFansComment: 'yes' } }).canPrepare, true)
  assert.equal(publishReadiness({ ...props, cover: { ...cover, bytes: 10_000_001 } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, tags: '#话题' } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'video' } }).canPrepare, false)
})

test('公众号正文配图：无标记可不选图，有标记必须核对每张本地文件与 1 MB 限制', () => {
  const props = input('wechat')
  props.publish = { ...publish, format: 'article', tags: '' }
  props.cover = cover
  props.publishing.options = { account: '公众号 AppID', categories: [] }
  Object.assign(props.fields, { wechatAudience: 'public', wechatComment: 'no', wechatDeclaration: 'no' })
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '正文配图').optional, true)
  const image = { ...cover, id: 'file:media-desk/files/piece/cover.png' }
  props.publish.description += '\n\n' + articleImageMarker(image.id)
  assert.equal(publishReadiness(props).canPrepare, false)
  assert.equal(row(publishReadiness(props), '正文配图').optional, false)
  props.images = [image]
  assert.equal(publishReadiness(props).canPrepare, true)
  for (const images of [[{ ...image, bytes: 1_000_000 }], [{ ...image, src: 'https://example.invalid/a.png' }], [{ ...image, id: 'other' }], [{ ...image, src: 'media-desk/files/piece/a.webp' }]]) assert.equal(publishReadiness({ ...props, images }).canPrepare, false)
  props.publish.description += '\n\n' + articleImageMarker(image.id)
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, description: '[[image:%bad]]' } }).canPrepare, false)
})

test('Threads 纯文字不依赖成片或封面，确认账号隐私、回复及 AI 后可准备；视频/图文不能误发文字', () => {
  const props = input('threads')
  props.video = undefined
  props.cover = { type: 'image', src: 'https://example.invalid/cover.png' }
  props.publish = { ...publish, format: 'text' }
  props.publishing.options = { account: '@author', categories: [] }
  assert.equal(publishReadiness(props).canPrepare, false)
  Object.assign(props.fields, { threadsAudience: 'account', threadsReply: 'everyone', threadsAi: 'yes' })
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '本地成片'), undefined)
  assert.equal(row(ready, '发布封面'), undefined)
  assert.deepEqual(publishOptions('threads', props.fields), { privacyStatus: 'account', replyControl: 'everyone', isAiGenerated: true })
  for (const key of ['threadsAudience', 'threadsReply', 'threadsAi']) assert.equal(publishReadiness({ ...props, fields: { ...props.fields, [key]: '' } }).canPrepare, false)
  for (const format of ['video', 'images']) {
    const result = publishReadiness({ ...props, publish: { ...props.publish, format } })
    assert.equal(result.canPrepare, false)
    assert.match(row(result, '发布类型').issue, /仅支持纯文字/)
  }
  assert.equal(publishReadiness({ ...props, publishing: { ...props.publishing, platform: 'youtube' } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, tags: '#a #b' } }).canPrepare, false)
  const manual = publishReadiness({ ...props, publish: { ...props.publish, mode: 'manual' } })
  assert.equal(manual.checks.length, 1)
  assert.equal(manual.checks[0].done, true)
})

test('TikTok 可见性无默认值、互动默认关闭、实时权限与原创/AI/政策声明齐全后才可准备', () => {
  const props = input('tiktok')
  props.video = { ...video, duration: 12 }
  props.publishing.options = { account: '测试作者', categories: [], constraints: { privacyLevels: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], commentDisabled: false, duetDisabled: true, stitchDisabled: true, maxDuration: 300 } }
  assert.equal(props.fields.tiktokPrivacy, '')
  assert.equal(props.fields.tiktokComment, false)
  assert.equal(props.fields.tiktokDuet, false)
  assert.equal(props.fields.tiktokStitch, false)
  assert.equal(props.fields.tiktokCommercial, false)
  assert.equal(publishReadiness(props).canPrepare, false)
  Object.assign(props.fields, { tiktokPrivacy: 'public', tiktokOriginal: 'yes', tiktokAi: 'no', tiktokMusicConsent: true })
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '发布分区'), undefined)
  assert.equal(row(publishReadiness(props), '发布封面'), undefined)
  for (const patch of [{ tiktokPrivacy: 'followers' }, { tiktokDuet: true }, { tiktokMusicConsent: false }, { tiktokAi: '' }, { tiktokOriginal: '' }, { tiktokCommercial: true }]) assert.equal(publishReadiness({ ...props, fields: { ...props.fields, ...patch } }).canPrepare, false)
  Object.assign(props.fields, { tiktokCommercial: true, tiktokBranded: true })
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.tiktokBrandedConsent = true
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(publishOptions('tiktok', props.fields).brandedContent, true)
  props.fields.tiktokPrivacy = 'private'
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.tiktokCommercial = false
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(publishOptions('tiktok', props.fields).brandedContent, false)
  assert.equal(publishReadiness({ ...props, video: { ...props.video, duration: undefined } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, video: { ...props.video, duration: 301 } }).canPrepare, false)
})

test('Pinterest 画板、公开、原创和两项 AI 声明齐全才可准备，封面可选默认首帧', () => {
  const props = input('pinterest')
  const boardId = '1880028106020515840'
  props.publishing.options = { account: '@author', categories: [{ id: boardId, title: '原创作品' }] }
  props.video = { ...video, duration: 12 }
  assert.equal(publishReadiness(props).canPrepare, false)
  assert.equal(publishOptions('pinterest', props.fields).syntheticPerformer, undefined)
  Object.assign(props.fields, { categoryId: boardId, pinterestAudience: 'public', pinterestOriginal: 'yes', pinterestAi: 'no', pinterestPerformer: 'yes' })
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '发布画板').done, true)
  assert.equal(row(ready, '发布分区'), undefined)
  assert.equal(row(ready, '发布封面').optional, true)
  assert.deepEqual(publishOptions('pinterest', props.fields), { categoryId: boardId, privacyStatus: 'public', original: true, isAiGenerated: false, syntheticPerformer: true })
  for (const key of ['categoryId', 'pinterestAudience', 'pinterestOriginal', 'pinterestAi', 'pinterestPerformer']) assert.equal(publishReadiness({ ...props, fields: { ...props.fields, [key]: '' } }).canPrepare, false)
  for (const patch of [{ duration: 3 }, { duration: 901 }, { src: 'media-desk/files/piece/local.webm' }]) assert.equal(publishReadiness({ ...props, video: { ...props.video, ...patch } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, cover }).canPrepare, true)
  assert.equal(publishReadiness({ ...props, cover: { ...cover, bytes: PUBLISH_COVER_BYTES + 1 } }).canPrepare, false)
  assert.match(row(publishReadiness({ ...props, publish: { ...props.publish, title: '字'.repeat(101) } }), '发布文案').issue, /100/)
  const noBoards = publishReadiness({ ...props, publishing: { ...props.publishing, options: { account: '@author', categories: [] } } })
  assert.equal(noBoards.canPrepare, false)
  assert.match(row(noBoards, '发布画板').issue, /公开画板/)
})

test('X 纯文字和图文必须确认声明；校验 1–4 张本地 JPEG/PNG 和 5 MB 上限', () => {
  const props = input('x')
  props.publish = { ...publish, format: 'text' }
  props.video = undefined
  props.cover = { ...cover, src: 'https://example.invalid/unused.png' }
  assert.equal(publishReadiness(props).canPrepare, false)
  Object.assign(props.fields, { xAudience: 'public', xAi: 'yes', xPaid: 'no' })
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '本地成片'), undefined)
  assert.equal(row(publishReadiness(props), '发布封面'), undefined)
  for (const key of ['xAudience', 'xAi', 'xPaid']) assert.equal(publishReadiness({ ...props, fields: { ...props.fields, [key]: '' } }).canPrepare, false)
  props.publish = { ...props.publish, format: 'images' }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.images = [cover]
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(publishReadiness({ ...props, images: Array(4).fill({ ...cover, bytes: 5_000_000 }) }).canPrepare, true)
  for (const images of [[], Array(5).fill(cover), [{ ...cover, bytes: 5_000_001 }], [{ ...cover, src: 'https://example.invalid/image.png' }], [{ ...cover, src: '/media-desk/files/another/image.png' }], [{ ...cover, src: '/media-desk/files/piece/image.gif' }]]) {
    assert.equal(publishReadiness({ ...props, images }).canPrepare, false)
  }
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, title: '文'.repeat(141) } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'article' } }).canPrepare, false)
})

test('X 公开、AI 和付费合作声明齐全才可准备，校验加权文字与 MP4', () => {
  const props = input('x')
  props.video = { ...video, duration: 12, width: 720, height: 1280, frameRate: 30 }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.xAudience = 'public'
  props.fields.xAi = 'yes'
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.xPaid = 'no'
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '发布分区'), undefined)
  assert.equal(row(publishReadiness(props), '发布封面'), undefined)
  assert.deepEqual(publishOptions('x', props.fields), { privacyStatus: 'public', isAiGenerated: true, isPaidPartnership: false })
  assert.equal(publishOptions('x', INITIAL_PUBLISH_FIELDS).isAiGenerated, undefined)
  assert.equal(publishOptions('x', INITIAL_PUBLISH_FIELDS).isPaidPartnership, undefined)
  for (const patch of [{ duration: 0.1 }, { duration: 1201 }, { frameRate: 61 }, { width: 1920 }, { src: 'media-desk/files/piece/video.mov' }]) assert.equal(publishReadiness({ ...props, video: { ...props.video, ...patch } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, title: '文'.repeat(141) } }).canPrepare, false)
})

test('LinkedIn 纯文字和图文：无需成片或封面，校验 1–20 张本地图片及已知像素', () => {
  const props = input('linkedin')
  props.publish = { ...publish, format: 'text' }
  props.video = undefined
  props.cover = { ...cover, src: 'https://example.invalid/unused-cover.png' }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.linkedinAudience = 'public'
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.equal(row(publishReadiness(props), '本地成片'), undefined)
  assert.equal(row(publishReadiness(props), '发布封面'), undefined)
  props.publish = { ...props.publish, format: 'images' }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.images = [cover]
  assert.equal(publishReadiness(props).canPrepare, true)
  for (const images of [[], Array(21).fill(cover), [{ ...cover, src: 'https://example.invalid/image.png' }], [{ ...cover, src: '/media-desk/files/another/image.png' }], [{ ...cover, bytes: PUBLISH_COVER_BYTES + 1 }], [{ ...cover, width: 10_000, height: 10_000 }]]) {
    assert.equal(publishReadiness({ ...props, images }).canPrepare, false)
  }
  assert.equal(publishReadiness({ ...props, images: Array(20).fill(cover) }).canPrepare, true)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'article' } }).canPrepare, false)
})

test('LinkedIn 准备入口要求明确公开、有效 MP4 和完整说明，不要求分区或封面', () => {
  const props = input('linkedin')
  props.video = { ...video, bytes: 80_000, duration: 12 }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.linkedinAudience = 'public'
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '发布分区'), undefined)
  assert.equal(row(ready, '发布封面'), undefined)
  assert.deepEqual(publishOptions('linkedin', props.fields), { privacyStatus: 'public' })
  for (const patch of [{ bytes: 70_000 }, { duration: 2 }, { duration: 1801 }, { src: 'media-desk/files/piece/local.mov' }]) assert.equal(publishReadiness({ ...props, video: { ...props.video, ...patch } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...publish, description: '文'.repeat(3000) } }).canPrepare, false)
})

test('B 站原创不要求封面，转载必填来源；已选封面必须符合格式和大小要求', () => {
  const props = input('bilibili')
  let result = publishReadiness(props)
  assert.equal(result.canPrepare, true)
  assert.equal(row(result, '发布封面').optional, true)
  assert.equal(publishReadiness({ ...props, cover }).canPrepare, true)
  result = publishReadiness({ ...props, cover: { ...cover, src: 'media-desk/files/piece/cover.webp' } })
  assert.equal(result.canPrepare, false)
  assert.match(row(result, '发布封面').issue, /JPEG 或 PNG/)
  assert.equal(publishReadiness({ ...props, cover: { ...cover, bytes: PUBLISH_COVER_BYTES + 1 } }).canPrepare, false)
  props.fields.copyright = '2'
  assert.equal(row(publishReadiness(props), '转载来源').done, false)
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.source = ' 转发自作者主页 '
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.deepEqual(publishOptions('bilibili', props.fields), { categoryId: '22', copyright: 2, source: props.fields.source })
})

test('YouTube 明确声明受众后才可准备，不将可选封面计入待处理项', () => {
  const props = input('youtube')
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '发布封面').optional, true)
  assert.deepEqual(publishOptions('youtube', props.fields), { categoryId: '22', privacyStatus: 'private', selfDeclaredMadeForKids: false })
  props.fields.kids = ''
  const missing = publishReadiness(props)
  assert.equal(row(missing, '是否面向儿童').done, false)
  assert.equal(missing.canPrepare, false)
})

test('YouTube 已选缩略图必须为有效本地 JPEG/PNG，50 MB 边界与 Host 一致', () => {
  const props = input('youtube')
  for (const bytes of [1, PUBLISH_COVER_BYTES + 1, 50_000_000]) {
    assert.equal(publishReadiness({ ...props, cover: { ...cover, bytes } }).canPrepare, true)
  }
  for (const invalid of [{ ...cover, src: 'https://example.invalid/a.png' }, { ...cover, src: '/media-desk/files/another/a.png' }, { ...cover, src: '/media-desk/files/piece/a.gif' }, ...[0, 50_000_001, undefined, NaN].map(bytes => ({ ...cover, bytes }))]) {
    assert.equal(publishReadiness({ ...props, cover: invalid }).canPrepare, false)
  }
})

test('准备入口拦截缺失分区、未配置/出错的账号、已有投稿记录', () => {
  for (const platform of ['bilibili', 'youtube']) {
    const props = input(platform)
    assert.equal(publishReadiness({ ...props, fields: { ...props.fields, categoryId: '99' } }).canPrepare, false)
    for (const extra of [{ platform: undefined }, { configured: false }, { statusError: '网络不可用' }, { options: { error: '账号核验失败' } }, { locked: true }]) {
      assert.equal(publishReadiness({ ...props, publishing: { ...props.publishing, ...extra } }).canPrepare, false)
    }
  }
})

test('API 准备校验发布文案、视频类型和本地素材归属，手动发布保留图文', () => {
  const props = input('bilibili')
  for (const source of [undefined, { ...video, src: 'https://example.invalid/video.mp4' }, { ...video, src: 'media-desk/files/other/local.mp4' }, { ...video, bytes: MAX_ASSET_BYTES + 1 }]) {
    const result = publishReadiness({ ...props, video: source })
    assert.equal(result.canPrepare, false)
    assert.equal(row(result, '本地成片').done, false)
  }
  const b = publishReadiness({ ...props, publish: { ...publish, title: '标'.repeat(80) } })
  assert.match(row(b, '发布文案').issue, /长度/)
  const y = publishReadiness({ ...input('youtube'), publish: { ...publish, description: '文'.repeat(1700) } })
  assert.equal(y.canPrepare, false)
  assert.match(row(y, '发布文案').issue, /YouTube/)
  const imagePost = { ...props, publish: { ...publish, format: 'images' }, images: [cover] }
  assert.match(row(publishReadiness(imagePost), '本地成片').issue, /仅支持视频/)
  assert.equal(row(publishReadiness({ ...imagePost, publish: { ...imagePost.publish, mode: 'manual' } }), '发布图片').done, true)
})

test('Facebook Reels 不需要分区或封面，必须显式选公开和声明 AI，有效成片才可准备', () => {
  const props = input('facebook')
  props.publishing.options = { account: '公共主页', categories: [] }
  props.video = { ...video, width: 1080, height: 1920, frameRate: 30, duration: 20 }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.facebookAudience = 'public'
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.facebookAi = 'no'
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '发布分区'), undefined)
  assert.equal(row(ready, '发布封面'), undefined)
  assert.deepEqual(publishOptions('facebook', props.fields), { privacyStatus: 'public', isAiGenerated: false })
  for (const extra of [{ width: 1920 }, { frameRate: 12 }, { duration: 95 }, { src: 'media-desk/files/piece/local.webm' }]) {
    assert.equal(publishReadiness({ ...props, video: { ...props.video, ...extra } }).canPrepare, false)
  }
})

test('Facebook 视频快拍：发布位置、Host 版本、公开与 AI 声明、3–60 秒本地 MP4', () => {
  const props = input('facebook')
  props.publishing.options = { account: '公共主页', categories: [], constraints: { storySupported: true } }
  props.video = { ...video, width: 1080, height: 1920, frameRate: 30, duration: 20 }
  Object.assign(props.fields, { facebookAudience: 'public', facebookAi: 'yes', facebookDestination: 'story' })
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.deepEqual(publishOptions('facebook', props.fields, 'video'), { privacyStatus: 'public', isAiGenerated: true, destination: 'story' })
  for (const duration of [3, 60]) assert.equal(publishReadiness({ ...props, video: { ...props.video, duration } }).canPrepare, true)
  for (const patch of [{ duration: undefined }, { duration: 0 }, { duration: 2.9 }, { duration: 60.1 }, { frameRate: undefined }, { frameRate: 12 }, { width: undefined }, { width: 1920 }, { height: undefined }, { src: '/media-desk/files/piece/local.mov' }, { src: 'https://example.invalid/video.mp4' }]) assert.equal(publishReadiness({ ...props, video: { ...props.video, ...patch } }).canPrepare, false)
  for (const storySupported of [undefined, false]) {
    const result = publishReadiness({ ...props, publishing: { ...props.publishing, options: { ...props.publishing.options, constraints: { storySupported } } } })
    assert.equal(result.canPrepare, false)
    assert.match(row(result, '视频发布位置').issue, /v27/)
  }
  for (const fields of [{ facebookDestination: 'invalid' }, { facebookDestination: '' }, { facebookAudience: '' }, { facebookAi: '' }]) assert.equal(publishReadiness({ ...props, fields: { ...props.fields, ...fields } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'text' } }).canPrepare, true, '切换为纯文字时，残留的视频位置不影响动态入口')
})

test('Facebook 照片快拍：v27、单张本地图、公开及非 AI 声明；AI 标识不静默省略', () => {
  const props = input('facebook')
  props.publish = { ...publish, format: 'images' }
  props.video = undefined
  props.images = [cover]
  props.publishing.options = { account: '公共主页', categories: [], constraints: { storySupported: true, feedAiSupported: true } }
  Object.assign(props.fields, { facebookAudience: 'public', facebookAi: 'no', facebookImageDestination: 'photo_story' })
  assert.equal(publishReadiness(props).canPrepare, true)
  assert.deepEqual(publishOptions('facebook', props.fields, 'images'), { privacyStatus: 'public', isAiGenerated: false, destination: 'photo_story' })
  assert.equal(publishReadiness({ ...props, images: [] }).canPrepare, false)
  assert.equal(row(publishReadiness({ ...props, images: [] }), 'Facebook 照片快拍仅支持 1 张图片').done, false)
  for (const storySupported of [undefined, false]) assert.equal(publishReadiness({ ...props, publishing: { ...props.publishing, options: { ...props.publishing.options, constraints: { storySupported } } } }).canPrepare, false)
  assert.equal(publishReadiness({ ...props, fields: { ...props.fields, facebookAi: 'yes' } }).canPrepare, false)
  assert.match(row(publishReadiness({ ...props, fields: { ...props.fields, facebookAi: 'yes' } }), '是否使用 AI 生成或编辑').issue, /AI 声明字段/)
  assert.equal(publishReadiness({ ...props, fields: { ...props.fields, facebookImageDestination: 'feed' } }).canPrepare, true)
  assert.deepEqual(publishOptions('facebook', { ...props.fields, facebookDestination: 'story' }, 'images'), { privacyStatus: 'public', isAiGenerated: false, destination: 'photo_story' })
  assert.deepEqual(publishOptions('facebook', { ...props.fields, facebookImageDestination: 'photo_story' }, 'video'), { privacyStatus: 'public', isAiGenerated: false })
})

test('Facebook 动态：文字不读取残留选材，图文校验顺序素材，AI 声明按 Host 版本限制', () => {
  const props = input('facebook')
  props.publish = { ...publish, format: 'text' }
  props.video = { ...video, src: 'https://example.invalid/unused.mp4' }
  props.cover = { ...cover, src: 'https://example.invalid/unused.png' }
  props.publishing.options = { account: '公共主页', categories: [], constraints: { feedAiSupported: false } }
  Object.assign(props.fields, { facebookAudience: 'public', facebookAi: 'no' })
  let readiness = publishReadiness(props)
  assert.equal(readiness.canPrepare, true)
  assert.equal(row(readiness, '本地成片'), undefined)
  assert.equal(row(readiness, '发布封面'), undefined)
  assert.equal(row(readiness, '发布分区'), undefined)
  props.fields.facebookAi = 'yes'
  readiness = publishReadiness(props)
  assert.equal(readiness.canPrepare, false)
  assert.match(row(readiness, '是否使用 AI 生成或编辑').issue, /v27\.0/)
  props.publishing.options.constraints.feedAiSupported = true
  assert.equal(publishReadiness(props).canPrepare, true)
  props.publish = { ...props.publish, format: 'images' }
  assert.equal(publishReadiness(props).canPrepare, false)
  props.images = [cover, { ...cover, src: '/media-desk/files/piece/two.jpg', bytes: 10_000_000 }]
  assert.equal(publishReadiness(props).canPrepare, true)
  for (const images of [Array(11).fill(cover), [{ ...cover, bytes: 10_000_001 }], [{ ...cover, src: '/media-desk/files/other/image.png' }], [{ ...cover, src: '/media-desk/files/piece/image.webp' }]]) {
    assert.equal(publishReadiness({ ...props, images }).canPrepare, false)
  }
  const long = publishReadiness({ ...props, publish: { ...props.publish, title: '长'.repeat(1000), description: 'x'.repeat(13500), tags: '' } })
  assert.equal(long.canPrepare, false)
  assert.match(row(long, '发布文案').issue, /16000/)
  assert.equal(publishReadiness({ ...props, publish: { ...props.publish, format: 'article' } }).canPrepare, false)
})

test('Instagram Reels 校验最终说明与视频，分享到动态和 AI 必须明确选择', () => {
  const props = input('instagram')
  props.publishing.options = { account: '@brand', categories: [] }
  props.fields.instagramShare = 'no'
  assert.equal(publishReadiness(props).canPrepare, false)
  props.fields.instagramAi = 'yes'
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '发布封面'), undefined)
  assert.equal(row(ready, '发布分区'), undefined)
  assert.deepEqual(publishOptions('instagram', props.fields), { shareToFeed: false, isAiGenerated: true })
  assert.match(row(publishReadiness({ ...props, publish: { ...publish, description: 'x'.repeat(2199) } }), '发布文案').issue, /2,200/)
  assert.match(row(publishReadiness({ ...props, publish: { ...publish, tags: '#多个 词' } }), '发布文案').issue, /空格/)
  assert.equal(publishReadiness({ ...props, video: { ...video, width: 1080, height: 1920, duration: 300, frameRate: 30 } }).canPrepare, true)
  assert.equal(publishReadiness({ ...props, video: { ...video, width: 2048, height: 4096, duration: 7, frameRate: 30 } }).canPrepare, false)
})

test('抖音只有本地素材和参数都齐全才可准备；AI 标识内容保留手动发布', () => {
  const props = input('douyin')
  props.publishing.options = { account: '抖音作者', categories: [] }
  assert.equal(publishReadiness(props).canPrepare, false)
  Object.assign(props.fields, { douyinPrivacy: 'friends', douyinOriginal: 'yes', douyinDownload: 'no', douyinAi: 'no' })
  const ready = publishReadiness(props)
  assert.equal(ready.canPrepare, true)
  assert.equal(row(ready, '发布分区'), undefined)
  assert.equal(row(ready, '发布封面').optional, true)
  assert.deepEqual(publishOptions('douyin', props.fields), { privacyStatus: 'friends', original: true, allowDownload: false, requiresAiLabel: false })
  assert.equal(publishReadiness({ ...props, cover }).canPrepare, true)
  assert.equal(publishReadiness({ ...props, cover: { ...cover, bytes: PUBLISH_COVER_BYTES + 1 } }).canPrepare, false)
  for (const patch of [{ bytes: 100_000_001 }, { duration: 901 }, { src: 'media-desk/files/piece/local.mov' }]) {
    assert.equal(publishReadiness({ ...props, video: { ...props.video, ...patch } }).canPrepare, false)
  }
  const ai = publishReadiness({ ...props, fields: { ...props.fields, douyinAi: 'yes' } })
  assert.equal(ai.canPrepare, false)
  assert.match(row(ai, '是否需要 AI 标识').issue, /官方发布器/)
  assert.match(row(publishReadiness({ ...props, publish: { ...props.publish, description: '文'.repeat(1000) } }), '发布文案').issue, /1,000/)
})
