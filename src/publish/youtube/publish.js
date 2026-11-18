// Adapted from AiToEarn's youtube-publish.provider.ts at 11dd1957 (MIT; see UPSTREAM-LICENSE.txt).
import { PublishError } from '../errors.js'

const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm'])
const PRIVACY = new Set(['private', 'public', 'unlisted'])
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/
const CATEGORY_ID = /^[1-9]\d{0,9}$/
const WORK_ID = /^[A-Za-z0-9_-]{11}$/
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value)
const invalid = message => new PublishError('INVALID_YOUTUBE_DRAFT', message, { stage: 'check' })
const badResponse = stage => new PublishError('YOUTUBE_INVALID_RESPONSE', 'YouTube 未返回有效回执', { stage, outcome: stage === 'review' ? 'unknown' : 'failed' })
const hasInvalidText = value => /[<>\x00]/.test(value)

function categoryItems(data) {
  if (!Array.isArray(data.items)) throw badResponse('categories')
  return data.items.filter(item => item?.snippet?.assignable === true && matches(CATEGORY_ID, item.id) && typeof item.snippet.title === 'string')
    .map(item => ({ id: item.id, title: item.snippet.title }))
}

function metadata(draft) {
  const { title, description = '', topics = [], categoryId, privacyStatus = 'private', selfDeclaredMadeForKids, containsSyntheticMedia, notifySubscribers = false, publishAt } = draft ?? {}
  if (publishAt != null) throw invalid('YouTube 投稿适配器暂不支持预约发布')
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 100 || hasInvalidText(title) || typeof description !== 'string' || Buffer.byteLength(description) > 5000 || hasInvalidText(description)) throw invalid('YouTube 投稿标题或简介不符合要求')
  if (!matches(CATEGORY_ID, categoryId)) throw invalid('请选择 YouTube 投稿分区')
  if (!PRIVACY.has(privacyStatus) || typeof selfDeclaredMadeForKids !== 'boolean' || typeof notifySubscribers !== 'boolean' || (containsSyntheticMedia !== undefined && typeof containsSyntheticMedia !== 'boolean')) throw invalid('请选择 YouTube 可见性、受众及内容声明')
  if (!Array.isArray(topics) || topics.some(tag => typeof tag !== 'string' || !tag.trim() || /[,<>\x00-\x1f\x7f]/.test(tag))) throw invalid('请将 YouTube 话题整理成独立的标签')
  const tags = [...new Set(topics.map(tag => tag.trim()))]
  if (tags.reduce((length, tag, i) => length + [...tag].length + (tag.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0) > 500) throw invalid('YouTube 标签超出长度限制')
  return {
    snippet: { title: title.trim(), description, categoryId, ...(tags.length && { tags }) },
    status: { privacyStatus, selfDeclaredMadeForKids, ...(containsSyntheticMedia !== undefined && { containsSyntheticMedia }) },
    notifySubscribers,
  }
}

export function createYouTubePublisher(client) {
  async function account(accessToken, signal) {
    const { items, nextPageToken } = await client.channels(accessToken, signal)
    if (!Array.isArray(items)) throw badResponse('account')
    // videos.insert targets the channel associated with the token; a channel ID cannot override it.
    if (items.length !== 1 || nextPageToken) throw new PublishError('YOUTUBE_CHANNEL_UNCONFIRMED', '无法确认此授权对应唯一的 YouTube 频道', { stage: 'account' })
    const channel = items[0]
    if (!matches(CHANNEL_ID, channel?.id) || typeof channel.snippet?.title !== 'string') throw badResponse('account')
    return { channelId: channel.id, title: channel.snippet.title }
  }

  return Object.freeze({
    account,
    async categories(accessToken, regionCode, signal) {
      if (!matches(/^[A-Z]{2}$/, regionCode)) throw invalid('请选择 YouTube 投稿地区')
      return categoryItems(await client.categories(accessToken, { regionCode }, signal))
    },
    async submit({ accessToken, channelId, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (!matches(CHANNEL_ID, channelId)) throw invalid('请先选择 YouTube 投稿频道')
      if (cover != null) throw invalid('YouTube 投稿适配器暂不支持自定义缩略图')
      if (!video || !VIDEO_MIME.has(video.mime) || typeof video.stream !== 'function' || !Number.isSafeInteger(video.sizeBytes) || video.sizeBytes < 1) throw invalid('YouTube 投稿需要有效的本地视频素材')
      const { notifySubscribers, ...body } = metadata(draft)
      const active = await account(accessToken, signal)
      if (active.channelId !== channelId) throw new PublishError('YOUTUBE_CHANNEL_MISMATCH', 'YouTube 授权频道和已确认频道不一致', { stage: 'account' })
      const category = categoryItems(await client.categories(accessToken, { id: body.snippet.categoryId }, signal))
      if (!category.some(item => item.id === body.snippet.categoryId)) throw invalid('所选 YouTube 投稿分区不可用')
      const location = await client.init(accessToken, video, body, notifySubscribers, signal)
      if (signal?.aborted) throw new PublishError('ABORTED', 'YouTube 请求已取消', { stage: 'submit' })
      await beforeSubmit({ privacyStatus: body.status.privacyStatus })
      const { id, snippet } = await client.submit(accessToken, location, video, signal)
      if (!matches(WORK_ID, id)) throw new PublishError('YOUTUBE_SUBMISSION_UNCONFIRMED', 'YouTube 未返回可查询的投稿回执，请先核对视频', { stage: 'submit', outcome: 'unknown' })
      return { status: snippet?.channelId === channelId ? 'pending_review' : 'unknown', receiptId: id }
    },
    async review({ accessToken, channelId, receiptId, privacyStatus, signal }) {
      if (!matches(CHANNEL_ID, channelId) || !matches(WORK_ID, receiptId) || !PRIVACY.has(privacyStatus)) {
        throw new PublishError('YOUTUBE_INVALID_REVIEW', 'YouTube 回查需要投稿时确认的频道、回执和可见性', { stage: 'review', outcome: 'unknown' })
      }
      const { items } = await client.detail(accessToken, receiptId, signal)
      if (!Array.isArray(items)) throw badResponse('review')
      const video = items.length === 1 ? items[0] : null
      if (video?.id !== receiptId || video.snippet?.channelId !== channelId) return { status: 'unknown', receiptId }
      const platformState = video.status?.uploadStatus
      const actualPrivacy = video.status?.privacyStatus
      if (!PRIVACY.has(actualPrivacy)) return { status: 'unknown', receiptId }
      const result = { receiptId, privacyStatus: actualPrivacy, platformState: typeof platformState === 'string' ? platformState : undefined }
      if (platformState === 'rejected') return { status: 'rejected', ...result }
      if (platformState === 'failed') return { status: 'failed', ...result }
      if (actualPrivacy !== privacyStatus) return { status: 'unknown', ...result }
      if (platformState === 'uploaded') return { status: 'pending_review', ...result }
      if (platformState !== 'processed') return { status: 'unknown', ...result }
      // Delivery succeeded at the requested visibility. Never expose a watch URL for a private work.
      return { status: 'published', ...result, ...(actualPrivacy !== 'private' && { publicId: receiptId, url: `https://www.youtube.com/watch?v=${receiptId}` }) }
    },
  })
}
