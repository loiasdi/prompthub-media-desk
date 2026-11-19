import { assetFileName, MAX_ASSET_BYTES, MEDIA_MIME } from '../src/asset-rules.js'
import { bilibiliCopyIssue, blueskyCopyIssue, douyinCopyIssue, facebookCopyIssue, instagramCopyIssue, kuaishouCopyIssue, linkedInCopyIssue, pinterestCopyIssue, splitPublishTopics, threadsCopyIssue, tikTokCopyIssue, weChatCopyIssue, xCopyIssue, youtubeCopyIssue } from '../src/publish/draft-copy.js'
import { blueskyImagesIssue, DOUYIN_AI_MANUAL, DOUYIN_VISIBILITY, douyinVideoIssue, KUAISHOU_COVER_BYTES, kuaishouVideoIssue, linkedInImagesIssue, linkedInVideoIssue, pinterestImagesIssue, pinterestVideoIssue, THREADS_REPLY, TIKTOK_VISIBILITY, tikTokVideoIssue, WECHAT_COVER_BYTES, WECHAT_DECLARATION_MANUAL, xImagesIssue, xVideoIssue, PUBLISH_COVER_BYTES, PUBLISH_COVER_MIME, FACEBOOK_FEED_AI_VERSION, facebookImagesIssue, facebookVideoIssue, instagramVideoIssue, PUBLISH_VIDEO_MIME } from '../src/publish/media-rules.js'

import { PUBLISH_PLATFORMS, publishFormatIssue, publishFormats, publishUsesArticleImages, publishUsesCover } from '../src/publish/capabilities.js'
import { articleImageIds } from '../src/publish/article-images.js'
import { weChatBodyImagesIssue } from '../src/publish/media-rules.js'
import { youtubeCoverIssue } from '../src/publish/media-rules.js'
import { FACEBOOK_STORY_VERSION, facebookStoryVideoIssue } from '../src/publish/media-rules.js'

export const API_PLATFORMS = Object.fromEntries(Object.entries(PUBLISH_PLATFORMS).map(([key, info]) => [info.name, key]))
export const INITIAL_PUBLISH_FIELDS = { categoryId: '', copyright: '', source: '', privacyStatus: 'private', kids: '', synthetic: '', blueskyAudience: '', kuaishouAudience: '', kuaishouAi: '', facebookAudience: '', facebookAi: '', facebookDestination: 'reels', facebookImageDestination: 'feed', instagramShare: '', instagramAi: '', douyinPrivacy: '', douyinOriginal: '', douyinDownload: '', douyinAi: '', linkedinAudience: '', xAudience: '', xAi: '', xPaid: '', pinterestAudience: '', pinterestOriginal: '', pinterestAi: '', pinterestPerformer: '', tiktokPrivacy: '', tiktokOriginal: '', tiktokAi: '', tiktokComment: false, tiktokDuet: false, tiktokStitch: false, tiktokCommercial: false, tiktokOwnBrand: false, tiktokBranded: false, tiktokMusicConsent: false, tiktokBrandedConsent: false, threadsAudience: '', threadsReply: '', threadsAi: '', wechatAudience: '', wechatAuthor: '', wechatDigest: '', wechatComment: '', wechatFansComment: '', wechatDeclaration: '' }

const copyChecks = { bilibili: bilibiliCopyIssue, bluesky: blueskyCopyIssue, douyin: douyinCopyIssue, kuaishou: kuaishouCopyIssue, youtube: youtubeCopyIssue, facebook: facebookCopyIssue, instagram: instagramCopyIssue, linkedin: linkedInCopyIssue, pinterest: pinterestCopyIssue, threads: threadsCopyIssue, tiktok: tikTokCopyIssue, wechat: weChatCopyIssue, x: xCopyIssue }
const imageChecks = { bluesky: blueskyImagesIssue, pinterest: pinterestImagesIssue, linkedin: linkedInImagesIssue, x: xImagesIssue, facebook: facebookImagesIssue }
const check = (text, done, issue = '', optional = false) => ({ text, done: Boolean(done), issue, optional })
function mediaIssue(itemId, asset, type, platform, destination) {
  const video = type === 'video'
  const name = assetFileName(asset?.src)
  if (asset?.type !== type || !name || (name.includes('/') && !name.startsWith(`${itemId}/`))) {
    return video ? '请选择这篇稿件中的本地成片。' : '封面必须是这篇稿件中的本地素材。'
  }
  const mime = MEDIA_MIME[name.slice(name.lastIndexOf('.')).toLowerCase()]
  if (!video && platform === 'kuaishou') return mime !== 'image/jpeg' || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes >= KUAISHOU_COVER_BYTES ? '快手封面须为小于 10 MB 的本地 JPEG' : ''
  if (!video && platform === 'youtube') return youtubeCoverIssue({ mime, sizeBytes: asset.bytes })
  const limit = video ? MAX_ASSET_BYTES : PUBLISH_COVER_BYTES
  if (!(video ? PUBLISH_VIDEO_MIME : PUBLISH_COVER_MIME).has(mime) || asset.bytes > limit) {
    return video ? '请选择不超过 250 MB 的 MP4、MOV 或 WebM 成片。' : '请选择不超过 10 MiB 的 JPEG 或 PNG 封面。'
  }
  if (video && platform === 'facebook') return (destination === 'story' ? facebookStoryVideoIssue : facebookVideoIssue)({ ...asset, mime })
  if (video && platform === 'douyin') return douyinVideoIssue({ ...asset, sizeBytes: asset.bytes, mime })
  if (video && platform === 'kuaishou') return kuaishouVideoIssue({ ...asset, sizeBytes: asset.bytes, mime })
  if (video && platform === 'instagram') return instagramVideoIssue({ ...asset, mime })
  if (video && platform === 'linkedin') return linkedInVideoIssue({ ...asset, sizeBytes: asset.bytes, mime })
  if (video && platform === 'x') return xVideoIssue({ ...asset, mime })
  if (video && platform === 'pinterest') return pinterestVideoIssue({ ...asset, mime })
  if (video && platform === 'tiktok') return tikTokVideoIssue({ ...asset, mime })
  if (!video && platform === 'wechat' && asset.bytes > WECHAT_COVER_BYTES) return '公众号文章必须选择不超过 10 MB 的本地 JPEG 或 PNG 封面'
  return ''
}

export function publishAccountIssue({ platform, configured, known, statusError, options, apiMode }) {
  if (statusError) return statusError
  if (!platform) return '此平台使用手动发布'
  if (!known) return '正在检查投稿配置'
  if (!configured) return '请先配置并启用此平台发布账号'
  if (options?.error) return options.error
  if (options?.account) return ''
  return apiMode ? '正在核对授权账号…' : '选择 API 投稿后核对授权账号'
}

export function publishReadiness({ itemId, publish, video, cover, images, publishing, fields }) {
  const title = publish.title.trim()
  if (publish.mode !== 'now') return {
    checks: [
      check('发布标题', title),
      ...(['text', 'article'].includes(publish.format) ? [] : [publish.format === 'video' ? check('发布视频', video) : check('发布图片', images.length)]),
      ...(publish.format === 'text' ? [] : [check('发布封面', cover, '', true)]),
    ],
    canPrepare: false,
  }

  const { platform, locked, options } = publishing
  const copyIssue = title && platform ? copyChecks[platform]({ title, description: publish.description, topics: splitPublishTopics(publish.tags), format: publish.format, ...(platform === 'wechat' && { author: fields.wechatAuthor, digest: fields.wechatDigest }) }) : ''
  const supported = publishFormats(platform).includes(publish.format)
  const videoIssue = !supported ? publishFormatIssue(platform) : publish.format === 'video' ? mediaIssue(itemId, video, 'video', platform, fields.facebookDestination) : ''
  const accountIssue = publishAccountIssue({ ...publishing, apiMode: true })
  const checks = [
    check('发布文案', title && !copyIssue, !title ? '请填写发布标题。' : copyIssue),
    ...(!supported || publish.format === 'video' ? [check(['threads', 'wechat'].includes(platform) ? '发布类型' : '本地成片', !videoIssue, videoIssue)] : []),
    check('发布账号', !accountIssue, accountIssue),
  ]
  if (supported && publish.format === 'images') {
    const imageIssue = images.map(image => mediaIssue(itemId, image, 'image', platform)).find(Boolean) || (imageChecks[platform] ? imageChecks[platform](images.map(image => ({ sizeBytes: image.bytes, width: image.width || image.w, height: image.height || image.h, mime: MEDIA_MIME['.' + assetFileName(image.src)?.split('.').at(-1)?.toLowerCase()] }))) : '此平台暂不支持 API 图文投稿')
    checks.push(check('发布图片（按选择顺序）', !imageIssue, imageIssue))
  }
  if (supported && publishUsesArticleImages(platform, publish.format)) {
    const ids = articleImageIds(publish.description)
    const imageIssue = images.map(image => mediaIssue(itemId, image, 'image', platform)).find(Boolean) || weChatBodyImagesIssue(publish.description, images.map(image => ({ id: image.id, sizeBytes: image.bytes, mime: MEDIA_MIME['.' + assetFileName(image.src)?.split('.').at(-1)?.toLowerCase()] })))
    checks.push(check('正文配图', ids.length && !imageIssue, imageIssue, !ids.length && !imageIssue))
  }
  if (PUBLISH_PLATFORMS[platform]?.category) checks.push(check(PUBLISH_PLATFORMS[platform].categoryLabel || '发布分区', options?.categories?.some(row => row.id === fields.categoryId), options && !options.error && !options.categories?.length ? platform === 'pinterest' ? '该账号没有可用的自有公开画板。' : '该账号没有可用的发布分区。' : ''))
  if (platform === 'bilibili') {
    checks.push(check('稿件类型', ['1', '2'].includes(fields.copyright)))
    if (fields.copyright === '2') checks.push(check('转载来源', fields.source.trim()))
  } else if (platform === 'youtube') {
    checks.push(check('可见性', ['private', 'unlisted', 'public'].includes(fields.privacyStatus)))
    checks.push(check('是否面向儿童', ['yes', 'no'].includes(fields.kids)))
  } else if (platform === 'facebook') {
    const photoStory = publish.format === 'images' && fields.facebookImageDestination === 'photo_story'
    if (publish.format === 'video' || publish.format === 'images') {
      const destination = publish.format === 'video' ? fields.facebookDestination : fields.facebookImageDestination
      checks.push(check(publish.format === 'video' ? '视频发布位置' : '图片发布位置', publish.format === 'video' ? ['reels', 'story'].includes(destination) && (destination !== 'story' || options?.constraints?.storySupported === true) : ['feed', 'photo_story'].includes(destination) && (!photoStory || options?.constraints?.storySupported === true), photoStory && options?.constraints?.storySupported !== true || publish.format === 'video' && destination === 'story' && options?.constraints?.storySupported !== true ? FACEBOOK_STORY_VERSION : ''))
      if (photoStory) checks.push(check('Facebook 照片快拍仅支持 1 张图片', images.length === 1, images.length === 1 ? '' : 'Facebook 照片快拍必须且只能选择 1 张本地图片。'))
    }
    checks.push(check('可见性', fields.facebookAudience === 'public'))
    const aiIssue = photoStory && fields.facebookAi === 'yes' ? 'Facebook 照片快拍接口不提供 AI 声明字段；AI 生成照片请改用官方发布器。' : ['text', 'images'].includes(publish.format) && fields.facebookAi === 'yes' && options?.constraints?.feedAiSupported === false ? FACEBOOK_FEED_AI_VERSION : ''
    checks.push(check('是否使用 AI 生成或编辑', ['yes', 'no'].includes(fields.facebookAi) && !aiIssue, aiIssue))
  } else if (platform === 'instagram') {
    checks.push(check('分享到 Instagram 动态', ['yes', 'no'].includes(fields.instagramShare)))
    checks.push(check('是否使用 AI 生成或编辑', ['yes', 'no'].includes(fields.instagramAi)))
  } else if (platform === 'bluesky') {
    checks.push(check('可见性', fields.blueskyAudience === 'public'))
  } else if (platform === 'kuaishou') {
    checks.push(check('可见性', fields.kuaishouAudience === 'public'))
    checks.push(check('是否需要快手原生 AI 标识', fields.kuaishouAi === 'no', fields.kuaishouAi === 'yes' ? '此 API 入口不提供原生 AI 标识，请改用快手官方发布器。' : ''))
  } else if (platform === 'wechat') {
    checks.push(check('可见性', fields.wechatAudience === 'public'))
    checks.push(check('允许评论', ['yes', 'no'].includes(fields.wechatComment)))
    if (fields.wechatComment === 'yes') checks.push(check('仅粉丝可评论', ['yes', 'no'].includes(fields.wechatFansComment)))
    checks.push(check('是否需要原生 AI 标识或原创声明', fields.wechatDeclaration === 'no', fields.wechatDeclaration === 'yes' ? WECHAT_DECLARATION_MANUAL : ''))
  } else if (platform === 'threads') {
    checks.push(check('可见性', fields.threadsAudience === 'account'))
    checks.push(check('回复范围', Object.hasOwn(THREADS_REPLY, fields.threadsReply)))
    checks.push(check('是否使用 AI 生成或编辑', ['yes', 'no'].includes(fields.threadsAi)))
  } else if (platform === 'tiktok') {
    const constraints = options?.constraints
    checks.push(check('可见性', constraints?.privacyLevels?.includes(TIKTOK_VISIBILITY[fields.tiktokPrivacy]) && !(fields.tiktokCommercial && fields.tiktokBranded && fields.tiktokPrivacy === 'private'), fields.tiktokCommercial && fields.tiktokBranded && fields.tiktokPrivacy === 'private' ? 'TikTok 付费合作不能设为仅自己可见。' : ''))
    checks.push(check('创作者时长与互动权限', constraints && video?.duration <= constraints.maxDuration && !(constraints.commentDisabled && fields.tiktokComment) && !(constraints.duetDisabled && fields.tiktokDuet) && !(constraints.stitchDisabled && fields.tiktokStitch), '请按当前 TikTok 账号权限选择时长和互动。'))
    checks.push(check('确认原创投稿', fields.tiktokOriginal === 'yes'))
    checks.push(check('是否使用 AI 生成或编辑', ['yes', 'no'].includes(fields.tiktokAi)))
    checks.push(check('商业内容声明', !fields.tiktokCommercial || fields.tiktokOwnBrand || fields.tiktokBranded))
    checks.push(check('同意音乐使用确认', fields.tiktokMusicConsent))
    if (fields.tiktokCommercial && fields.tiktokBranded) checks.push(check('同意品牌内容政策', fields.tiktokBrandedConsent))
  } else if (platform === 'pinterest') {
    checks.push(check('可见性', fields.pinterestAudience === 'public'))
    checks.push(check('确认原创投稿', fields.pinterestOriginal === 'yes'))
    checks.push(check('是否使用 AI 生成或编辑', ['yes', 'no'].includes(fields.pinterestAi)))
    checks.push(check('是否包含合成表演者', ['yes', 'no'].includes(fields.pinterestPerformer)))
  } else if (platform === 'x') {
    checks.push(check('可见性', fields.xAudience === 'public'))
    checks.push(check('是否使用 AI 生成或编辑', ['yes', 'no'].includes(fields.xAi)))
    checks.push(check('是否为付费商业合作', ['yes', 'no'].includes(fields.xPaid)))
  } else if (platform === 'linkedin') {
    checks.push(check('可见性', fields.linkedinAudience === 'public'))
  } else if (platform === 'douyin') {
    checks.push(check('可见性', Object.hasOwn(DOUYIN_VISIBILITY, fields.douyinPrivacy)))
    checks.push(check('确认原创投稿', fields.douyinOriginal === 'yes'))
    checks.push(check('允许下载', ['yes', 'no'].includes(fields.douyinDownload)))
    checks.push(check('是否需要 AI 标识', fields.douyinAi === 'no', fields.douyinAi === 'yes' ? DOUYIN_AI_MANUAL : ''))
  }
  if (publishUsesCover(platform, publish.format)) {
    const coverIssue = cover && mediaIssue(itemId, cover, 'image', platform)
    checks.push(check('发布封面', cover && !coverIssue, coverIssue, !cover && !PUBLISH_PLATFORMS[platform].coverRequired))
  }
  return { checks, canPrepare: Boolean(platform) && !locked && checks.every(row => row.optional || row.done) }
}

export function publishOptions(platform, fields, format) {
  if (platform === 'bluesky') return { privacyStatus: fields.blueskyAudience }
  if (platform === 'kuaishou') return { privacyStatus: fields.kuaishouAudience, requiresAiLabel: fields.kuaishouAi === 'yes' }
  if (platform === 'wechat') return {
    privacyStatus: fields.wechatAudience, author: fields.wechatAuthor, digest: fields.wechatDigest,
    allowComment: fields.wechatComment === '' ? undefined : fields.wechatComment === 'yes',
    onlyFansComment: fields.wechatComment === 'no' ? false : fields.wechatFansComment === '' ? undefined : fields.wechatFansComment === 'yes',
    requiresNativeDeclaration: fields.wechatDeclaration === '' ? undefined : fields.wechatDeclaration === 'yes',
  }
  if (platform === 'threads') return { privacyStatus: fields.threadsAudience, replyControl: fields.threadsReply, isAiGenerated: fields.threadsAi === '' ? undefined : fields.threadsAi === 'yes' }
  if (platform === 'tiktok') return {
    privacyStatus: fields.tiktokPrivacy, original: fields.tiktokOriginal === 'yes',
    isAiGenerated: fields.tiktokAi === '' ? undefined : fields.tiktokAi === 'yes',
    allowComment: fields.tiktokComment, allowDuet: fields.tiktokDuet, allowStitch: fields.tiktokStitch,
    commercialContent: fields.tiktokCommercial, ownBrand: fields.tiktokCommercial && fields.tiktokOwnBrand, brandedContent: fields.tiktokCommercial && fields.tiktokBranded,
    musicConsent: fields.tiktokMusicConsent, brandedConsent: fields.tiktokCommercial && fields.tiktokBranded && fields.tiktokBrandedConsent,
  }
  if (platform === 'pinterest') return {
    categoryId: fields.categoryId, privacyStatus: fields.pinterestAudience, original: fields.pinterestOriginal === 'yes',
    isAiGenerated: fields.pinterestAi === '' ? undefined : fields.pinterestAi === 'yes',
    syntheticPerformer: fields.pinterestPerformer === '' ? undefined : fields.pinterestPerformer === 'yes',
  }
  if (platform === 'x') return {
    privacyStatus: fields.xAudience,
    isAiGenerated: fields.xAi === '' ? undefined : fields.xAi === 'yes',
    isPaidPartnership: fields.xPaid === '' ? undefined : fields.xPaid === 'yes',
  }
  if (platform === 'linkedin') return { privacyStatus: fields.linkedinAudience }
  if (platform === 'douyin') return {
    privacyStatus: fields.douyinPrivacy, original: fields.douyinOriginal === 'yes',
    allowDownload: fields.douyinDownload === '' ? undefined : fields.douyinDownload === 'yes',
    requiresAiLabel: fields.douyinAi === '' ? undefined : fields.douyinAi === 'yes',
  }
  if (platform === 'instagram') return { shareToFeed: fields.instagramShare === 'yes', isAiGenerated: fields.instagramAi === 'yes' }
  if (platform === 'facebook') return { privacyStatus: fields.facebookAudience, isAiGenerated: fields.facebookAi === 'yes', ...(format === 'images' && fields.facebookImageDestination === 'photo_story' ? { destination: 'photo_story' } : format === 'video' && fields.facebookDestination === 'story' ? { destination: 'story' } : {}) }
  if (platform === 'bilibili') return { categoryId: fields.categoryId, copyright: Number(fields.copyright), source: fields.source }
  return {
    categoryId: fields.categoryId, privacyStatus: fields.privacyStatus, selfDeclaredMadeForKids: fields.kids === 'yes',
    ...(fields.synthetic && { containsSyntheticMedia: fields.synthetic === 'yes' }),
  }
}
