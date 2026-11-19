// Adapted from AiToEarn's youtube-publish.provider.ts at 11dd1957 (MIT; see UPSTREAM-LICENSE.txt).
import { setTimeout as delay } from 'node:timers/promises'
import { youtubeCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { PUBLISH_VIDEO_MIME, youtubeCoverIssue } from '../media-rules.js'

const PRIVACY = new Set(['private', 'public', 'unlisted'])
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/
const CATEGORY_ID = /^[1-9]\d{0,9}$/
const WORK_ID = /^[A-Za-z0-9_-]{11}$/
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value)
const invalid = message => new PublishError('INVALID_YOUTUBE_DRAFT', message, { stage: 'check' })
const badResponse = stage => new PublishError('YOUTUBE_INVALID_RESPONSE', 'YouTube 未返回有效回执', { stage, outcome: stage === 'review' ? 'unknown' : 'failed' })

function categoryItems(data) {
  if (!Array.isArray(data.items)) throw badResponse('categories')
  return data.items.filter(item => item?.snippet?.assignable === true && matches(CATEGORY_ID, item.id) && typeof item.snippet.title === 'string')
    .map(item => ({ id: item.id, title: item.snippet.title }))
}

function metadata(draft) {
  const { title, description = '', topics = [], categoryId, privacyStatus = 'private', selfDeclaredMadeForKids, containsSyntheticMedia, notifySubscribers = false, publishAt } = draft ?? {}
  if (publishAt != null) throw invalid('YouTube 投稿适配器暂不支持预约发布')
  const copyIssue = youtubeCopyIssue({ title, description, topics })
  if (copyIssue) throw invalid(copyIssue)
  if (!matches(CATEGORY_ID, categoryId)) throw invalid('请选择 YouTube 投稿分区')
  if (!PRIVACY.has(privacyStatus) || typeof selfDeclaredMadeForKids !== 'boolean' || typeof notifySubscribers !== 'boolean' || (containsSyntheticMedia !== undefined && typeof containsSyntheticMedia !== 'boolean')) throw invalid('请选择 YouTube 可见性、受众及内容声明')
  const tags = [...new Set(topics.map(tag => tag.trim()))]
  return {
    snippet: { title: title.trim(), description, categoryId, ...(tags.length && { tags }) },
    status: { privacyStatus, selfDeclaredMadeForKids, ...(containsSyntheticMedia !== undefined && { containsSyntheticMedia }) },
    notifySubscribers,
  }
}

export function createYouTubePublisher(client, { wait = (ms, signal) => delay(ms, undefined, { signal }), pollAttempts = 10, pollIntervalMs = 60_000 } = {}) {
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 30 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || typeof wait !== 'function') throw new TypeError('Invalid YouTube processing policy')
  function check({ draft, video, cover }) {
    if (cover != null) {
      const issue = youtubeCoverIssue(cover)
      if (issue || typeof cover.stream !== 'function') throw invalid(issue || 'YouTube 缩略图需要有效的本地图片素材')
    }
    if (!video || !PUBLISH_VIDEO_MIME.has(video.mime) || typeof video.stream !== 'function' || !Number.isSafeInteger(video.sizeBytes) || video.sizeBytes < 1) throw invalid('YouTube 投稿需要有效的本地视频素材')
    return metadata(draft)
  }
  async function account(accessToken, signal) {
    const { items, nextPageToken } = await client.channels(accessToken, signal)
    if (!Array.isArray(items)) throw badResponse('account')
    // videos.insert targets the channel associated with the token; a channel ID cannot override it.
    if (items.length !== 1 || nextPageToken) throw new PublishError('YOUTUBE_CHANNEL_UNCONFIRMED', '无法确认此授权对应唯一的 YouTube 频道', { stage: 'account' })
    const channel = items[0]
    if (!matches(CHANNEL_ID, channel?.id) || typeof channel.snippet?.title !== 'string') throw badResponse('account')
    return { channelId: channel.id, title: channel.snippet.title }
  }

  // Video delivery and thumbnail replacement are separate official operations.
  // Never turn a thumbnail problem into a retryable video-upload failure.
  async function setCover({ accessToken, channelId, id, privacyStatus, cover, signal }) {
    const notSet = message => ({ status: 'not_set', message })
    try {
      const read = async () => {
        const { items } = await client.processing(accessToken, id, signal)
        const video = Array.isArray(items) && items.length === 1 ? items[0] : null
        return video?.id === id && video.snippet?.channelId === channelId && video.status?.privacyStatus === privacyStatus ? video : null
      }
      const complete = video => video?.status.uploadStatus === 'processed' && video.processingDetails?.processingStatus === 'succeeded'
      let ready = false
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        if (attempt) await wait(pollIntervalMs, signal)
        const video = await read()
        if (!video || ['failed', 'rejected', 'deleted'].includes(video.status.uploadStatus) || ['failed', 'terminated'].includes(video.processingDetails?.processingStatus)) break
        if (complete(video)) { ready = true; break }
        if (!['uploaded', 'processed'].includes(video.status.uploadStatus)) break
      }
      if (!ready) return notSet('视频回执已保存，未确认处理完成或归属与可见性，尚未设置缩略图；请在 YouTube Studio 补设，不要重新上传视频。')
      if ((await account(accessToken, signal)).channelId !== channelId || !complete(await read())) return notSet('视频回执已保存，但账号或视频状态已变化，未设置缩略图；请在 YouTube Studio 核对。')
    } catch {
      return notSet('视频回执已保存，处理状态检查未完成，未发送缩略图；请在 YouTube Studio 补设，不要重新上传视频。')
    }
    try {
      const data = await client.thumbnail(accessToken, id, cover, signal)
      const details = Array.isArray(data.items) && data.items.length === 1 ? data.items[0] : null
      const confirmed = details && ['default', 'medium', 'high', 'standard', 'maxres'].some(key => {
        const image = details[key]
        return typeof image?.url === 'string' && /^https:\/\//.test(image.url) && Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0
      })
      if (!confirmed) return { status: 'unknown', message: '视频回执已保存，但缩略图未返回有效回执；请在 YouTube Studio 核对，不要重新上传视频。' }
      return { status: 'set', message: 'YouTube 已确认设置自定义缩略图。' }
    } catch (err) {
      return err instanceof PublishError && err.outcome === 'failed'
        ? notSet('视频回执已保存，缩略图未设置成功；请检查频道权限并在 YouTube Studio 补设，不要重新上传视频。')
        : { status: 'unknown', message: '视频回执已保存，但缩略图设置结果未确认；请在 YouTube Studio 核对，不要重新上传视频。' }
    }
  }

  return Object.freeze({
    account,
    check,
    async categories(accessToken, regionCode, signal) {
      if (!matches(/^[A-Z]{2}$/, regionCode)) throw invalid('请选择 YouTube 投稿地区')
      return categoryItems(await client.categories(accessToken, { regionCode }, signal))
    },
    async submit({ accessToken, channelId, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (!matches(CHANNEL_ID, channelId)) throw invalid('请先选择 YouTube 投稿频道')
      const { notifySubscribers, ...body } = check({ draft, video, cover })
      const active = await account(accessToken, signal)
      if (active.channelId !== channelId) throw new PublishError('YOUTUBE_CHANNEL_MISMATCH', 'YouTube 授权频道和已确认频道不一致', { stage: 'account' })
      const category = categoryItems(await client.categories(accessToken, { id: body.snippet.categoryId }, signal))
      if (!category.some(item => item.id === body.snippet.categoryId)) throw invalid('所选 YouTube 投稿分区不可用')
      const location = await client.init(accessToken, video, body, notifySubscribers, signal)
      if (signal?.aborted) throw new PublishError('ABORTED', 'YouTube 请求已取消', { stage: 'submit' })
      await beforeSubmit({ privacyStatus: body.status.privacyStatus })
      const { id, snippet } = await client.submit(accessToken, location, video, signal)
      if (!matches(WORK_ID, id)) throw new PublishError('YOUTUBE_SUBMISSION_UNCONFIRMED', 'YouTube 未返回可查询的投稿回执，请先核对视频', { stage: 'submit', outcome: 'unknown' })
      const result = { status: snippet?.channelId === channelId ? 'pending_review' : 'unknown', receiptId: id }
      if (!cover) return result
      await beforeSubmit({ receiptId: id, coverResult: { status: 'pending' } })
      if (snippet?.channelId !== channelId) return { ...result, coverResult: { status: 'not_set', message: '视频回执已保存，但未确认视频归属，未发送缩略图；请在 YouTube Studio 核对。' } }
      return { ...result, coverResult: await setCover({ accessToken, channelId, id, privacyStatus: body.status.privacyStatus, cover, signal }) }
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
