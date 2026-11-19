import { articleImageIds, articleImageSyntaxIssue } from './article-images.js'

export const PUBLISH_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
export const WECHAT_COVER_BYTES = 10_000_000
export const WECHAT_DECLARATION_MANUAL = '需要公众号原生 AI 标识或原创声明的文章，请改用微信公众平台完成声明后发表。'
export const THREADS_REPLY = Object.freeze({ everyone: '所有人可回复', accounts_you_follow: '关注的账号可回复', mentioned_only: '提及的账号可回复', followers_only: '关注者可回复' })
export const PUBLISH_COVER_MIME = new Set(['image/jpeg', 'image/png'])
export const YOUTUBE_COVER_BYTES = 50_000_000
export function youtubeCoverIssue(cover) {
  return cover && (!PUBLISH_COVER_MIME.has(cover.mime) || !Number.isSafeInteger(cover.sizeBytes) || cover.sizeBytes <= 0 || cover.sizeBytes > YOUTUBE_COVER_BYTES) ? 'YouTube 缩略图须为不超过 50 MB 的本地 JPEG 或 PNG' : ''
}
export const FACEBOOK_IMAGE_BYTES = 10_000_000
export const FACEBOOK_FEED_AI_VERSION = 'Facebook AI 动态需要在 Host 将 Graph API 版本设为 v27.0 并重新核对账号；旧版本请使用官方发布器。'
export const FACEBOOK_STORY_VERSION = 'Facebook 快拍需要在 Host 将 Graph API 版本设为 v27.0 并重新核对账号；旧版本请使用普通动态/Reels 或官方发布器。'

export function facebookImagesIssue(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 10) return 'Facebook 图文请选择 1 至 10 张本地图片'
  if (images.some(image => !PUBLISH_COVER_MIME.has(image?.mime) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > FACEBOOK_IMAGE_BYTES)) return 'Facebook 发布图片须为不超过 10 MB 的 JPEG 或 PNG'
  return ''
}
export const PUBLISH_COVER_BYTES = 10 * 1024 * 1024 // Local memory bound, not a claim about the platform limit.
export const PINTEREST_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024 // Local bound for inline Base64 and JSON allocation.
export const X_IMAGE_BYTES = 5_000_000
export const BLUESKY_IMAGE_BYTES = 2_000_000
export function blueskyImagesIssue(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) return 'Bluesky 图文请选择 1 至 4 张本地图片'
  if (images.some(image => !PUBLISH_COVER_MIME.has(image?.mime) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 1 || image.sizeBytes > BLUESKY_IMAGE_BYTES)) return 'Bluesky 图片须为不超过 2 MB 的 JPEG 或 PNG'
  return ''
}
export function xImagesIssue(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) return 'X 图文请选择 1 至 4 张本地图片'
  if (images.some(image => !PUBLISH_COVER_MIME.has(image?.mime) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > X_IMAGE_BYTES)) return 'X 发布图片须为不超过 5 MB 的 JPEG 或 PNG'
  return ''
}
export function linkedInImagesIssue(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 20) return 'LinkedIn 图文请选择 1 至 20 张本地图片'
  if (images.some(image => !PUBLISH_COVER_MIME.has(image?.mime) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > PUBLISH_COVER_BYTES)) return 'LinkedIn 发布图片须为不超过 10 MiB 的 JPEG 或 PNG'
  if (images.some(image => image.width > 0 && image.height > 0 && image.width * image.height >= 36_152_320)) return 'LinkedIn 每张图片须少于 36,152,320 像素'
  return ''
}
export function pinterestImagesIssue(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 5) return 'Pinterest 图文请选择 1 至 5 张本地图片'
  if (images.some(image => !PUBLISH_COVER_MIME.has(image?.mime) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > PUBLISH_COVER_BYTES)) return 'Pinterest 发布图片须为不超过 10 MiB 的 JPEG 或 PNG'
  if (images.reduce((total, image) => total + image.sizeBytes, 0) > PINTEREST_IMAGE_TOTAL_BYTES) return 'Pinterest 发布图片合计不能超过 20 MiB'
  return ''
}

export const META_REEL_MIME = new Set(['video/mp4', 'video/quicktime'])
export const TIKTOK_VISIBILITY = Object.freeze({ public: 'PUBLIC_TO_EVERYONE', friends: 'MUTUAL_FOLLOW_FRIENDS', followers: 'FOLLOWER_OF_CREATOR', private: 'SELF_ONLY' })
export function tikTokVideoIssue({ mime, duration, frameRate, width, height }) {
  if (!PUBLISH_VIDEO_MIME.has(mime)) return 'TikTok 请选择 MP4、MOV 或 WebM 成片'
  if (!Number.isFinite(duration) || duration < 3 || (frameRate > 0 && (frameRate < 23 || frameRate > 60))) return 'TikTok 需读取有效时长，成片至少 3 秒且符合当前账号时长权限，帧率为 23 至 60'
  if ((width > 0 && (width < 360 || width > 4096)) || (height > 0 && (height < 360 || height > 4096))) return 'TikTok 视频宽高须在 360 至 4096 像素之间'
  return ''
}
export function pinterestVideoIssue({ mime, duration }) {
  if (!META_REEL_MIME.has(mime)) return 'Pinterest 请选择 MP4 或 MOV 成片'
  if (duration > 0 && (duration < 4 || duration > 900)) return 'Pinterest 成片时长须为 4 秒至 15 分钟'
  return ''
}
export function xVideoIssue({ mime, duration, width, height, frameRate }) {
  if (mime !== 'video/mp4') return 'X 请选择 MP4 成片'
  if ((duration > 0 && (duration < 0.5 || duration > 1200)) || frameRate > 60 ||
      (width > 0 && height > 0 && (width < 32 || height < 32 || Math.max(width, height) > 1280 || Math.min(width, height) > 1024 || width / height < 1 / 3 || width / height > 3))) return 'X 请选择 0.5 秒至 20 分钟、最高 60 帧/秒、32 至 1280 像素的合规成片'
  return ''
}
export function linkedInVideoIssue({ mime, sizeBytes, duration }) {
  if (mime !== 'video/mp4') return 'LinkedIn 请选择 MP4 成片'
  if (sizeBytes < 75 * 1024 || (duration > 0 && (duration < 3 || duration > 1800))) return 'LinkedIn 成片至少 75 KiB，时长为 3 秒至 30 分钟'
  return ''
}

// Video geometry, duration and frame rate from Meta's Reels guide. When old imports
// lack metadata, leave dimensional/encoding checks to Meta rather than guess.
export function facebookVideoIssue({ mime, width, height, duration, frameRate }) {
  if (!META_REEL_MIME.has(mime)) return 'Facebook Reels 请选择 MP4 或 MOV 成片'
  if ((width > 0 && height > 0 && (width < 540 || height < 960 || width * 16 !== height * 9)) ||
      (duration > 0 && (duration < 3 || duration > 90)) || (frameRate > 0 && (frameRate < 24 || frameRate > 60))) {
    return 'Facebook Reels 请选择 9:16、至少 540×960、24–60 帧/秒、3–90 秒的成片'
  }
  return ''
}

export function facebookStoryVideoIssue(video) {
  if (video?.mime !== 'video/mp4' || !Number.isFinite(video.duration) || video.duration < 3 || video.duration > 60) return 'Facebook 视频快拍请选择 3–60 秒的本地 MP4 成片，需先读取有效时长。'
  if (![video.width, video.height, video.frameRate].every(value => Number.isFinite(value) && value > 0)) return 'Facebook 视频快拍需要有效的宽高和帧率媒体信息，请重新导入成片。'
  return facebookVideoIssue(video) ? 'Facebook 视频快拍请选择 9:16、至少 540×960、24–60 帧/秒的成片。' : ''
}

export function instagramVideoIssue({ mime, width, height, duration, frameRate }) {
  if (!META_REEL_MIME.has(mime)) return 'Instagram Reels 请选择 MP4 或 MOV 成片'
  if (width > 1920 || (width > 0 && height > 0 && (width / height < 0.01 || width / height > 10)) ||
      (duration > 0 && (duration < 3 || duration > 900)) || (frameRate > 0 && (frameRate < 23 || frameRate > 60))) {
    return 'Instagram Reels 请选择宽度不超过 1920 像素、23–60 帧/秒、3 秒至 15 分钟的成片'
  }
  return ''
}

// The upload and multipart docs state different total limits; use the lower
// published limit for this adapter until a live authorized test proves more.
export const DOUYIN_MAX_BYTES = 100_000_000
export const KUAISHOU_VIDEO_BYTES = 100_000_000
export const KUAISHOU_COVER_BYTES = 10_000_000
export const KUAISHOU_VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm'])
export function kuaishouVideoIssue({ mime, duration, sizeBytes }) {
  if (!KUAISHOU_VIDEO_MIME.has(mime)) return '快手请选择 MP4、MOV 或 WebM 成片'
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > KUAISHOU_VIDEO_BYTES) return '快手投稿支持不超过 100 MB 的成片'
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) return '快手成片时长须大于 0 且不超过 30 分钟'
  return ''
}
export const DOUYIN_VISIBILITY = Object.freeze({ public: 0, private: 1, friends: 2 })
export const DOUYIN_AI_MANUAL = '需要 AI 标识的内容，请改用抖音官方发布器并完成声明。'
export function douyinVideoIssue({ mime, duration, sizeBytes }) {
  if (!['video/mp4', 'video/webm'].includes(mime)) return '抖音请选择 MP4 或 WebM 成片'
  if (sizeBytes > DOUYIN_MAX_BYTES) return '抖音投稿入口支持不超过 100 MB 的成片'
  if (duration > 900) return '抖音成片时长不能超过 15 分钟'
  return ''
}
export const WECHAT_BODY_IMAGE_BYTES = 1_000_000
export function weChatBodyImagesIssue(description, images) {
  const syntax = articleImageSyntaxIssue(description)
  if (syntax) return syntax
  const ids = articleImageIds(description)
  if (ids.length > 20) return '公众号正文最多引用 20 张不同的本地配图'
  if (!Array.isArray(images) || images.length !== ids.length || images.some((image, index) => image?.id !== ids[index])) return '正文配图缺失或顺序不一致，请在本篇稿件中重新插入配图。'
  if (images.some(image => !PUBLISH_COVER_MIME.has(image?.mime) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 1 || image.sizeBytes >= WECHAT_BODY_IMAGE_BYTES)) return '公众号正文配图须为小于 1 MB 的本地 JPEG 或 PNG'
  return ''
}
