// Container readiness and final publication adapted from AiToEarn at 11dd1957 (MIT).
import { setTimeout as delay } from 'node:timers/promises'
import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { instagramCaption, instagramCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { instagramVideoIssue } from '../media-rules.js'

const invalid = message => new PublishError('INVALID_INSTAGRAM_DRAFT', message, { stage: 'check' })
const terminalError = state => state === 'ERROR' || state === 'EXPIRED'

function reelUrl(media, workId) {
  if (media.id !== workId || media.media_product_type !== 'REELS' || typeof media.permalink !== 'string') return undefined
  const match = /^https:\/\/www\.instagram\.com\/(reel|p)\/([A-Za-z0-9_-]{4,32})\/?$/.exec(media.permalink)
  return match && `https://www.instagram.com/${match[1]}/${match[2]}/`
}

export function createInstagramPublisher(client, { wait = (ms, signal) => delay(ms, undefined, { signal }), pollIntervalMs = 60_000, pollAttempts = 5 } = {}) {
  function check({ draft, video, cover }) {
    const copyIssue = instagramCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (typeof draft.shareToFeed !== 'boolean' || typeof draft.isAiGenerated !== 'boolean') throw invalid('请选择 Instagram Reels 是否分享到动态并声明是否使用 AI')
    if (cover || !video || !Number.isSafeInteger(video.sizeBytes) || video.sizeBytes < 1 || video.sizeBytes > MAX_ASSET_BYTES || typeof video.stream !== 'function') throw invalid('Instagram Reels 需要有效的本地视频，不上传独立封面')
    const mediaIssue = instagramVideoIssue(video)
    if (mediaIssue) throw invalid(mediaIssue)
    return { caption: instagramCaption(draft), shareToFeed: draft.shareToFeed, isAiGenerated: draft.isAiGenerated }
  }

  return Object.freeze({
    account: client.account,
    check,
    async submit({ accessToken, channelId, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      const metadata = check({ draft, video, cover })
      const session = await client.initialize(accessToken, channelId, metadata, signal)
      const uploaded = await client.upload(accessToken, session, video, signal)
      if (uploaded.success !== true) throw new PublishError('INSTAGRAM_UPLOAD_UNCONFIRMED', 'Instagram 未确认收到视频，未发送发布请求', { stage: 'upload' })
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        if (attempt) await wait(pollIntervalMs, signal)
        const state = await client.status(accessToken, session.id, 'processing', signal)
        if (state === 'FINISHED') {
          await beforeSubmit(session.id)
          const workId = await client.finish(accessToken, channelId, session.id, signal)
          return { status: 'pending_review', receiptId: session.id, workId }
        }
        if (state === 'PUBLISHED') {
          // Unexpected on a newly created container, but do not send another publish.
          await beforeSubmit(session.id)
          return { status: 'pending_review', receiptId: session.id }
        }
        if (terminalError(state)) throw new PublishError('INSTAGRAM_PROCESSING_FAILED', 'Instagram 处理失败或容器已过期，未发送发布请求', { stage: 'processing' })
        if (state !== 'IN_PROGRESS') throw new PublishError('INSTAGRAM_INVALID_STATUS', 'Instagram 未返回可确认的处理状态，未发送发布请求', { stage: 'processing' })
      }
      throw new PublishError('INSTAGRAM_PROCESSING_TIMEOUT', 'Instagram 未在等待时间内处理完成，未发送发布请求', { stage: 'processing' })
    },
    async review({ accessToken, receiptId, workId, signal }) {
      // Acknowledged media survives independently of its ephemeral container.
      // A lost finish response may leave us only the container ID.
      const media = workId && await client.media(accessToken, workId, signal).catch(() => null)
      if (media && media.id === workId && media.media_product_type === 'REELS') {
        return { status: 'published', platformState: 'PUBLISHED', receiptId, url: reelUrl(media, workId) || undefined }
      }
      const platformState = await client.status(accessToken, receiptId, 'review', signal)
      if (platformState === 'PUBLISHED') return { status: 'published', platformState, receiptId }
      if (!workId && terminalError(platformState)) return { status: 'rejected', platformState, receiptId }
      if (workId && (platformState === 'FINISHED' || platformState === 'IN_PROGRESS')) return { status: 'pending_review', platformState, receiptId }
      // An expired container alone cannot disprove an acknowledged media ID.
      return { status: 'unknown', receiptId }
    },
  })
}
