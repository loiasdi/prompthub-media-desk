import { setTimeout as delay } from 'node:timers/promises'
import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { linkedInCommentary, linkedInCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { linkedInImagesIssue, linkedInVideoIssue } from '../media-rules.js'
import { validImageUrn } from './client.js'

const invalid = message => new PublishError('INVALID_LINKEDIN_DRAFT', message, { stage: 'check' })
const postUrl = receiptId => `https://www.linkedin.com/feed/update/${receiptId}/`

export function createLinkedInPublisher(client, { wait = (ms, signal) => delay(ms, undefined, { signal }), pollIntervalMs = 10_000, pollAttempts = 30 } = {}) {
  function check({ draft, video, cover, images = [] }) {
    const copyIssue = linkedInCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (draft.privacyStatus !== 'public') throw invalid('请确认 LinkedIn 公开发布到个人动态')
    if (!Array.isArray(images)) throw invalid('请检查 LinkedIn 发布图片')
    const format = draft.format || 'video' // Existing video plans predate explicit non-video formats.
    if (format === 'text') {
      if (video || cover || images.length) throw invalid('LinkedIn 纯文字不能混入素材')
      return linkedInCommentary(draft)
    }
    if (format === 'images') {
      if (video || cover) throw invalid('LinkedIn 图文不能混发视频或独立封面')
      const issue = linkedInImagesIssue(images)
      if (issue) throw invalid(issue)
      if (images.some(image => typeof image.stream !== 'function')) throw invalid('LinkedIn 需要有效的本地发布图片')
      return linkedInCommentary(draft)
    }
    if (format !== 'video' || images.length) throw invalid('请检查 LinkedIn 发布类型，不支持混合素材')
    if (cover || !Number.isSafeInteger(video?.sizeBytes) || video.sizeBytes < 1 || video.sizeBytes > MAX_ASSET_BYTES || typeof video.stream !== 'function') throw invalid('LinkedIn 需要有效的本地视频，不上传独立封面')
    const mediaIssue = linkedInVideoIssue(video)
    if (mediaIssue) throw invalid(mediaIssue)
    return linkedInCommentary(draft)
  }
  return Object.freeze({
    account: client.account,
    check,
    async submit({ accessToken, channelId, draft, video, cover, images = [], beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.owner) throw invalid('LinkedIn 当前账号与投稿确认单不一致')
      const commentary = check({ draft, video, cover, images })
      if (draft.format === 'text' || draft.format === 'images') {
        const mediaIds = []
        for (const image of images) {
          const session = await client.initializeImage(accessToken, signal)
          if (mediaIds.includes(session.image)) throw new PublishError('LINKEDIN_DUPLICATE_IMAGE', 'LinkedIn 返回了重复图片标识，未发送发布请求', { stage: 'upload' })
          await client.uploadImage(accessToken, session, image, signal)
          mediaIds.push(session.image)
        }
        // Versioned Images GET is unavailable to normal w_member_social tokens.
        // Upload completion is not proof of processing; do not add a failing read gate.
        await client.account(accessToken, signal)
        await beforeSubmit()
        const receiptId = mediaIds.length ? await client.createImages(accessToken, mediaIds, commentary, signal) : await client.createText(accessToken, commentary, signal)
        return { status: mediaIds.length ? 'pending_review' : 'published', receiptId, ...(mediaIds.length ? { mediaIds } : {}), url: postUrl(receiptId), privacyStatus: 'public' }
      }
      const session = await client.initialize(accessToken, video.sizeBytes, signal)
      const partIds = []
      for (const part of session.parts) partIds.push(await client.upload(part, video, signal))
      await client.finalize(accessToken, session, partIds, signal)
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        if (attempt) await wait(pollIntervalMs, signal)
        const state = await client.videoStatus(accessToken, session.video, signal)
        if (state === 'AVAILABLE') {
          await beforeSubmit()
          const receiptId = await client.create(accessToken, session.video, commentary, signal)
          return { status: 'published', receiptId, workId: session.video, url: postUrl(receiptId), privacyStatus: 'public' }
        }
        if (!['PROCESSING', 'WAITING_UPLOAD'].includes(state)) throw new PublishError('LINKEDIN_PROCESSING_FAILED', 'LinkedIn 未确认视频可用，未发送发布请求', { stage: 'processing' })
      }
      throw new PublishError('LINKEDIN_PROCESSING_TIMEOUT', 'LinkedIn 未在等待时间内处理完成，未发送发布请求', { stage: 'processing' })
    },
    async review({ accessToken, channelId, receiptId, workId, mediaIds, format = 'video', signal }) {
      if (channelId !== client.owner) throw invalid('LinkedIn 当前账号与投稿确认单不一致')
      const post = await client.post(accessToken, receiptId, signal)
      let matches = false
      if (format === 'text') matches = (post.content == null || (typeof post.content === 'object' && !Array.isArray(post.content) && !Object.keys(post.content).length)) && !post.reshareContext
      else if (format === 'images' && Array.isArray(mediaIds) && mediaIds.length > 0 && mediaIds.length <= 20 && mediaIds.every(validImageUrn)) {
        matches = mediaIds.length === 1 ? post.content?.media?.id === mediaIds[0] && !post.content?.multiImage
          : !post.content?.media && Array.isArray(post.content?.multiImage?.images) && post.content.multiImage.images.length === mediaIds.length && post.content.multiImage.images.every((image, index) => image.id === mediaIds[index])
      } else if (format === 'video') matches = post.content?.media?.id === workId
      if (!matches) throw new PublishError('LINKEDIN_POST_MEDIA_MISMATCH', 'LinkedIn 未确认帖子的素材类型或顺序，已保留原记录', { stage: 'review', outcome: 'unknown' })
      const platformState = post.lifecycleState
      if (platformState === 'PUBLISHED' && post.visibility === 'PUBLIC') return { status: 'published', platformState, receiptId, privacyStatus: 'public', url: postUrl(receiptId) }
      if (['PROCESSING', 'PUBLISH_REQUESTED'].includes(platformState)) return { status: 'pending_review', platformState, receiptId }
      if (platformState === 'PUBLISH_FAILED') return { status: 'rejected', platformState, receiptId }
      return { status: 'unknown', receiptId }
    },
  })
}
