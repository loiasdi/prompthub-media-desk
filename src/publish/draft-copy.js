// Pure copy checks shared by the release checklist and the Host adapters.
import parseTweet from 'twitter-text/dist/parseTweet.js'
import { articleImageIds, articleImageParts, articleImageSyntaxIssue } from './article-images.js'

const escapeArticle = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const plainArticleHtml = text => text.trim().replace(/\r\n?/g, '\n').split(/\n{2,}/).map(block => `<p>${escapeArticle(block).replace(/\n/g, '<br/>')}</p>`).join('')
export const weChatArticleHtml = (text, imageUrls) => imageUrls ? articleImageParts(text).map(part => {
  if (!part.imageId) return part.text.trim() ? plainArticleHtml(part.text) : ''
  const image = imageUrls.get(part.imageId)
  if (!image) throw new TypeError('Missing verified WeChat article image')
  return `<p><img src="${escapeArticle(image.url)}" alt="${escapeArticle(image.filename)}"/></p>`
}).join('') : plainArticleHtml(text)
export const weChatHtmlIssue = html => html.length >= 20_000 || new TextEncoder().encode(html).length >= 1_000_000 ? '公众号转换后的文章正文须少于 20,000 字符且小于 1 MB' : ''
export function weChatCopyIssue({ title, description, topics, author = '', digest = '' }) {
  if (typeof title !== 'string' || !title.trim() || [...title].length > 32 || typeof description !== 'string' || !description.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return '公众号标题须为 1 至 32 字，正文不能为空'
  if (!Array.isArray(topics) || topics.length) return '公众号文章不支持话题字段，请清空话题或自行写入正文'
  if (typeof author !== 'string' || [...author].length > 16 || typeof digest !== 'string' || [...digest].length > 120 || /[\x00-\x1f\x7f]/.test(author + digest)) return '公众号作者最多 16 字，摘要最多 120 字，不含控制字符'
  const syntax = articleImageSyntaxIssue(description)
  if (syntax) return syntax
  const ids = articleImageIds(description)
  // Encoded local IDs can be longer than the eventual CDN URLs. Check the text
  // and minimum image structure now, then the exact HTML after official upload.
  const placeholders = ids.length ? new Map(ids.map(id => [id, { url: '', filename: '' }])) : undefined
  return weChatHtmlIssue(weChatArticleHtml(description, placeholders))
}

export const threadsCaption = ({ title, description }) => [title.trim(), description.trim()].filter(Boolean).join('\n\n')
export const blueskyCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')
export const kuaishouCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n')
export function kuaishouCopyIssue({ title, description, topics }) {
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 30 || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return '快手标题须为 1 至 30 字，说明不能含控制字符'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !tag.trim() || /[\s#\x00-\x1f\x7f]/u.test(tag))) return '快手单个话题不能含空格或 #'
  if ([...kuaishouCaption({ title, description, topics })].length > 1000) return '快手标题、说明与话题合计不能超过 1,000 字符'
  return ''
}
export function blueskyFacets(text) {
  const entities = []
  const add = (start, end, feature) => {
    if (end <= start || entities.some(entity => start < entity.end && entity.start < end)) return
    entities.push({ start, end, feature })
  }
  for (const match of text.matchAll(/https?:\/\/[^\s]+/giu)) {
    let end = match.index + match[0].length
    while (end > match.index && /[.,;:!?"'”’。！？、，；：）】」』]$/u.test(text.slice(match.index, end))) end--
    while (end > match.index && text[end - 1] === ')') {
      const link = text.slice(match.index, end)
      if ((link.match(/\(/g)?.length || 0) >= (link.match(/\)/g)?.length || 0)) break
      end--
    }
    const url = text.slice(match.index, end)
    try { if (url) add(match.index, end, { $type: 'app.bsky.richtext.facet#link', uri: new URL(url).href }) } catch { /* Keep malformed links as plain text. */ }
  }
  for (const match of text.matchAll(/(^|\s)#([\p{L}\p{M}\p{N}_]+)/gu)) {
    const start = match.index + match[1].length
    const tag = match[2]
    if ([...tag].length <= 64) add(start, start + tag.length + 1, { $type: 'app.bsky.richtext.facet#tag', tag })
  }
  const byteOffset = index => new TextEncoder().encode(text.slice(0, index)).length
  return entities.sort((a, b) => a.start - b.start).map(({ start, end, feature }) => ({ index: { byteStart: byteOffset(start), byteEnd: byteOffset(end) }, features: [feature] }))
}
function graphemeCount(text) { return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length }
export function blueskyCopyIssue(draft) {
  const { title, description, topics } = draft
  if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return '请检查 Bluesky 标题与发布说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) return 'Bluesky 话题请使用文字、数字或下划线，不含空格'
  if (graphemeCount(blueskyCaption(draft)) > 300) return 'Bluesky 标题、说明与话题合计不能超过 300 个字素'
  return ''
}
export function threadsTextWeight(text) {
  const encoder = new TextEncoder()
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].reduce((size, { segment }) => size + (/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u.test(segment) ? encoder.encode(segment).length : [...segment].length), 0)
}
export function threadsCopyIssue({ title, description, topics }) {
  if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return '请检查 Threads 标题与发布正文'
  if (!Array.isArray(topics) || topics.length > 1 || topics.some(tag => typeof tag !== 'string' || !tag.trim() || [...tag].length > 50 || /[.#&@\x00-\x1f\x7f]/.test(tag))) return 'Threads 原生话题最多一个，须为 1 至 50 字符，不含句点、&、# 或 @'
  if (threadsTextWeight(threadsCaption({ title, description })) > 500) return 'Threads 标题与正文合计不能超过 500 加权字符，emoji 按 UTF-8 字节计'
  return ''
}

export const tikTokCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')
export function tikTokCopyIssue({ title, description, topics }) {
  if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return '请检查 TikTok 标题与发布说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) return 'TikTok 话题请使用文字、数字或下划线，不含空格'
  if (tikTokCaption({ title, description, topics }).length > 2200) return 'TikTok 标题、说明和话题合计不能超过 2,200 UTF-16 字符'
  return ''
}

export const pinterestCaption = ({ description, topics }) => [description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')
export function pinterestCopyIssue(draft) {
  const { title, description, topics } = draft
  if (typeof title !== 'string' || !title.trim() || [...title].length > 100 || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return 'Pinterest 标题须为 1 至 100 字符，请检查发布说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) return 'Pinterest 话题请使用文字、数字或下划线，不含空格'
  if ([...pinterestCaption(draft)].length > 800) return 'Pinterest 说明和话题合计不能超过 800 字符'
  return ''
}

export const xCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')
export function xCopyIssue(draft) {
  const { title, description, topics } = draft
  if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title + description)) return '请检查 X 标题与发布说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) return 'X 话题请使用文字、数字或下划线，不含空格'
  if (!parseTweet(xCaption(draft)).valid) return 'X 的标题、说明与话题须符合 280 加权字符限制'
  return ''
}
export const splitPublishTopics = value => [...new Set((value.includes('#') ? value.split(/\s*#\s*|[,，\n]+/) : value.split(/[,，\n]+/)).map(tag => tag.trim()).filter(Boolean))]
export const linkedInCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')
const littleText = value => value.replace(/[|{}@\[\]()<>#\\*_~]/g, char => `\\${char}`)
export const linkedInCommentary = ({ title, description, topics }) => [littleText(title.trim()), littleText(description.trim()), topics.map(tag => `{hashtag|\\#|${littleText(tag)}}`).join(' ')].filter(Boolean).join('\n\n')
export function linkedInCopyIssue(draft) {
  const { title, description, topics } = draft
  if (typeof title !== 'string' || !title.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(title) || typeof description !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) return '请检查 LinkedIn 标题与发布说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) return 'LinkedIn 话题请使用文字、数字或下划线，不含空格'
  if (linkedInCaption(draft).length > 3000) return 'LinkedIn 的标题、说明与话题合计不能超过 3,000 字符'
  return ''
}
const invalidYouTubeText = value => /[<>\x00]/.test(value)

export function bilibiliCopyIssue({ title, description, topics }) {
  if (typeof title !== 'string' || !title.trim() || [...title].length > 79 || typeof description !== 'string' || [...description].length > 249) return 'B 站投稿标题或简介不符合当前适配器长度限制'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 500 || /[,#\r\n]/.test(tag))) return '请将 B 站话题整理成独立的标签'
  return ''
}

export function youtubeCopyIssue({ title, description, topics }) {
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 100 || invalidYouTubeText(title) || typeof description !== 'string' || new TextEncoder().encode(description).length > 5000 || invalidYouTubeText(description)) return 'YouTube 投稿标题或简介不符合要求'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !tag.trim() || /[,<>\x00-\x1f\x7f]/.test(tag))) return '请将 YouTube 话题整理成独立的标签'
  const tags = [...new Set(topics.map(tag => tag.trim()))]
  if (tags.reduce((length, tag, i) => length + [...tag].length + (tag.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0) > 500) return 'YouTube 标签超出长度限制'
  return ''
}

export const facebookCaption = ({ title, description, topics, format }) => [...(['text', 'images'].includes(format) ? [title.trim()] : []), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')

export function facebookCopyIssue(draft) {
  const { title, description, topics } = draft
  const feed = ['text', 'images'].includes(draft.format)
  const story = draft.destination === 'story'
  if (typeof title !== 'string' || !title.trim() || title.length > 2000 || /\x00/.test(title) || typeof description !== 'string' || /\x00/.test(description)) return story ? '请检查 Facebook 视频快拍的本地记录文案' : feed ? '请检查 Facebook 动态的标题和正文' : '请检查 Facebook Reels 的标题和简介'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !tag || /[\s#,\x00-\x1f\x7f]/u.test(tag))) return story ? 'Facebook 视频快拍本地话题不能含空格' : feed ? 'Facebook 动态的单个话题不能含空格' : 'Facebook Reels 的单个话题不能含空格'
  // Local bound for caption payload; not a claim about the platform maximum.
  if (new TextEncoder().encode(facebookCaption(draft)).length > 16000) return story ? 'Facebook 视频快拍本地记录文案超过 16000 字节长度限制' : feed ? 'Facebook 动态文案超过本地 16000 字节长度限制' : 'Facebook Reels 简介和话题超过本地长度限制'
  return ''
}

// Instagram has no independent title field. The first caption line retains the
// workspace title, and the exact same final caption appears in confirmation.
export const instagramCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n\n')

export function instagramCopyIssue(draft) {
  const { title, description, topics } = draft
  if (typeof title !== 'string' || !title.trim() || /\x00/.test(title) || typeof description !== 'string' || /\x00/.test(description)) return '请检查 Instagram Reels 的标题和说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) return 'Instagram Reels 话题请使用文字、数字或下划线，不含空格'
  const caption = instagramCaption(draft)
  if ([...caption].length > 2200) return 'Instagram Reels 的完整说明不能超过 2,200 字符'
  if ((caption.match(/#[\p{L}\p{M}\p{N}_]+/gu)?.length || 0) > 30) return 'Instagram Reels 的完整说明不能超过 30 个话题'
  return ''
}

export const douyinCaption = ({ title, description, topics }) => [title.trim(), description.trim(), topics.map(tag => `#${tag}`).join(' ')].filter(Boolean).join('\n')
export function douyinCopyIssue(draft) {
  const { title, description, topics } = draft
  if (typeof title !== 'string' || !title.trim() || /\x00/.test(title) || typeof description !== 'string' || /\x00/.test(description)) return '请检查抖音标题与发布说明'
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !tag || /[\s#,@\x00-\x1f\x7f]/u.test(tag))) return '抖音单个话题不能含空格或 @'
  if ([...douyinCaption(draft)].length > 1000) return '抖音的标题、说明与话题合计不能超过 1,000 字符'
  return ''
}
