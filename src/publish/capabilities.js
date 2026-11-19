// Public platform capabilities; safe to include in the browser bundle.
import { validWeChatLink } from './wechat/links.js'
import { YOUTUBE_COVER_BYTES } from './media-rules.js'
export const PUBLISH_PLATFORMS = Object.freeze({
  bluesky: { name: 'Bluesky', formats: ['images', 'text'], maxImages: 4, category: false, cover: false, studio: 'https://bsky.app/', studioLabel: '打开 Bluesky', workUrl: /^https:\/\/bsky\.app\/profile\/[a-z0-9][a-z0-9.-]{0,251}\/(?:post)\/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/ },
  kuaishou: { name: '快手', cover: true, coverRequired: true, coverBytes: 10_000_000, studio: 'https://cp.kuaishou.com/article/publish/video', studioLabel: '打开快手创作者中心', workUrl: /^https:\/\/www\.kuaishou\.com\/short-video\/[A-Za-z0-9_-]{1,128}$/ },
  wechat: { name: '公众号', formats: ['article'], articleImages: true, maxImages: 20, category: false, cover: true, coverRequired: true, studio: 'https://mp.weixin.qq.com/', studioLabel: '打开微信公众平台', workUrl: { test: validWeChatLink } },
  threads: { name: 'Threads', formats: ['text'], category: false, cover: false, studio: 'https://www.threads.com/', studioLabel: '打开 Threads', workUrl: /^https:\/\/www\.threads\.(?:com|net)\/@[A-Za-z0-9_.]{1,100}\/post\/[A-Za-z0-9_-]{4,64}\/?$/ },
  tiktok: { name: 'TikTok', category: false, cover: false, studio: 'https://www.tiktok.com/tiktokstudio/content', studioLabel: '打开 TikTok', workUrl: /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9_.]{1,100}\/video\/[1-9]\d{0,31}$/ },
  pinterest: { name: 'Pinterest', formats: ['video', 'images'], maxImages: 5, category: true, categoryLabel: '发布画板', cover: true, coverFormats: ['video'], studio: 'https://www.pinterest.com/', studioLabel: '打开 Pinterest', workUrl: /^https:\/\/www\.pinterest\.com\/pin\/[1-9]\d{0,31}\/$/ },
  x: { name: 'X', formats: ['video', 'images', 'text'], maxImages: 4, category: false, cover: false, studio: 'https://x.com/home', studioLabel: '打开 X', workUrl: /^https:\/\/x\.com\/i\/web\/status\/[1-9]\d{0,18}$/ },
  linkedin: { name: 'LinkedIn', formats: ['video', 'images', 'text'], maxImages: 20, category: false, cover: false, studio: 'https://www.linkedin.com/feed/', studioLabel: '打开 LinkedIn', workUrl: /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:share|ugcPost):[1-9]\d{0,31}\/$/ },
  bilibili: { name: 'B站', category: true, cover: true, studio: 'https://member.bilibili.com/', workUrl: /^https:\/\/www\.bilibili\.com\/video\/(?:bv[a-z0-9]+|av\d+)$/i },
  youtube: { name: 'YouTube', category: true, cover: true, coverBytes: YOUTUBE_COVER_BYTES, studio: 'https://studio.youtube.com/', workUrl: /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/ },
  facebook: { name: 'Facebook', formats: ['video', 'images', 'text'], maxImages: 10, category: false, cover: false, studio: 'https://business.facebook.com/', workUrl: /^https:\/\/www\.facebook\.com\/(?:reel\/[1-9]\d{0,31}|[1-9]\d{0,31}\/posts\/[1-9]\d{0,31})$/ },
  instagram: { name: 'Instagram', category: false, cover: false, studio: 'https://www.instagram.com/', studioLabel: '打开 Instagram', workUrl: /^https:\/\/www\.instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]{4,32}\/$/ },
  douyin: { name: '抖音', category: false, cover: true, studio: 'https://creator.douyin.com/', workUrl: /^https:\/\/www\.douyin\.com\/video\/[1-9]\d{0,23}$/ },
})

export const publishFormats = platform => PUBLISH_PLATFORMS[platform]?.formats || ['video']
export const publishUsesCover = (platform, format) => Boolean(PUBLISH_PLATFORMS[platform]?.cover && (!PUBLISH_PLATFORMS[platform].coverFormats || PUBLISH_PLATFORMS[platform].coverFormats.includes(format)))
export const publishUsesArticleImages = (platform, format) => Boolean(PUBLISH_PLATFORMS[platform]?.articleImages && format === 'article')
const formatNames = { video: '视频', images: '图文', text: '纯文字', article: '文章' }
const formatIssues = {
  facebook: 'Facebook API 入口支持视频、图文或纯文字，请选择对应类型。',
  wechat: '公众号 API 入口仅支持单篇文章，请切换为文章。',
  threads: 'Threads API 入口仅支持纯文字；视频和图文请使用手动发布。',
  pinterest: 'Pinterest API 入口支持视频或图文，请选择对应类型。',
  linkedin: 'LinkedIn API 入口支持视频、图文或纯文字，请选择对应类型。',
  x: 'X API 入口支持视频、图文或纯文字，请选择对应类型。',
}
export const publishFormatIssue = platform => formatIssues[platform] || 'API 投稿仅支持视频，请切换为视频。'
export const publishSelectionIssue = platform => `请在发布页选择 ${PUBLISH_PLATFORMS[platform]?.name || '对应平台'}、${publishFormats(platform).map(format => formatNames[format]).join('/')}和 API 投稿`
