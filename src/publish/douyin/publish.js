// Metadata composition follows AiToEarn's douyin.service.ts at 11dd1957 (MIT).
import { douyinCaption, douyinCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { PUBLISH_COVER_BYTES, PUBLISH_COVER_MIME, DOUYIN_AI_MANUAL, DOUYIN_VISIBILITY, douyinVideoIssue } from '../media-rules.js'

export const DOUYIN_SINGLE_BYTES = 50_000_000
export const DOUYIN_PART_BYTES = 20_000_000
const invalid = message => new PublishError('INVALID_DOUYIN_DRAFT', message, { stage: 'check' })
const usable = media => Number.isSafeInteger(media?.sizeBytes) && media.sizeBytes > 0 && typeof media.stream === 'function'

export function createDouyinPublisher(client, { singleBytes = DOUYIN_SINGLE_BYTES, partBytes = DOUYIN_PART_BYTES } = {}) {
  if (!Number.isSafeInteger(singleBytes) || singleBytes < 1 || !Number.isSafeInteger(partBytes) || partBytes < 1) throw new TypeError('Invalid Douyin part size')
  function check({ draft, video, cover }) {
    const issue = douyinCopyIssue(draft ?? {})
    if (issue) throw invalid(issue)
    if (draft.requiresAiLabel !== false) throw invalid(DOUYIN_AI_MANUAL)
    if (draft.original !== true || !Object.hasOwn(DOUYIN_VISIBILITY, draft.privacyStatus) || typeof draft.allowDownload !== 'boolean') throw invalid('请确认抖音原创内容、可见范围与下载权限')
    if (!usable(video)) throw invalid('抖音投稿需要有效的本地成片')
    const mediaIssue = douyinVideoIssue(video)
    if (mediaIssue) throw invalid(mediaIssue)
    if (cover && (!usable(cover) || !PUBLISH_COVER_MIME.has(cover.mime) || cover.sizeBytes > PUBLISH_COVER_BYTES)) throw invalid('抖音投稿需要不超过 10 MiB 的 JPEG 或 PNG 封面')
    return { text: douyinCaption(draft), private_status: DOUYIN_VISIBILITY[draft.privacyStatus], download_type: draft.allowDownload ? 0 : 1 }
  }

  async function uploadVideo(token, video, signal) {
    if (video.sizeBytes <= singleBytes) return client.uploadVideo(token, video, signal)
    const uploadId = await client.initParts(token, signal)
    // Equalize sizes so the last part is not smaller than the platform minimum.
    const count = Math.ceil(video.sizeBytes / partBytes)
    const width = Math.ceil(video.sizeBytes / count)
    for (let start = 0, part = 1; start < video.sizeBytes; start += width, part++) {
      await client.part(token, uploadId, part, video, start, Math.min(video.sizeBytes, start + width) - 1, signal)
    }
    return client.completeParts(token, uploadId, signal)
  }
  return Object.freeze({
    account: client.account,
    check,
    async submit({ accessToken, channelId, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.openId) throw invalid('抖音当前账号与投稿确认单不一致')
      const metadata = check({ draft, video, cover })
      const videoId = await uploadVideo(accessToken, video, signal)
      const coverId = cover && await client.uploadCover(accessToken, cover, signal)
      await beforeSubmit()
      const result = await client.create(accessToken, { ...metadata, video_id: videoId, ...(coverId && { custom_cover_image_url: coverId }) }, signal)
      return { status: 'pending_review', ...result }
    },
    async review({ channelId, receiptId, workId, privacyStatus, signal }) {
      if (channelId !== client.openId) throw invalid('抖音当前账号与投稿确认单不一致')
      if (privacyStatus !== 'public') throw new PublishError('DOUYIN_NONPUBLIC', '仅自己或好友可见的作品，请在抖音创作中心核对。', { stage: 'review', outcome: 'unknown' })
      // This read-only endpoint only succeeds for public videos. Never render
      // the returned iframe or infer rejection from unavailable public data.
      await client.verifyPublic(workId, signal)
      return { status: 'published', platformState: 'public', receiptId, privacyStatus: 'public', url: `https://www.douyin.com/video/${workId}` }
    },
  })
}
