import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { tikTokCaption, tikTokCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { TIKTOK_VISIBILITY, tikTokVideoIssue } from '../media-rules.js'

const invalid = message => new PublishError('INVALID_TIKTOK_DRAFT', message, { stage: 'check' })
const CHUNK_BYTES = 10_000_000

export function tikTokChunks(sizeBytes) {
  const chunkSize = Math.min(sizeBytes, CHUNK_BYTES)
  return { chunkSize, chunkCount: Math.max(1, Math.floor(sizeBytes / chunkSize)) }
}

export function createTikTokPublisher(client) {
  async function account(accessToken, signal) {
    const { id } = await client.identity(accessToken, signal)
    const constraints = await client.creator(accessToken, signal)
    return { id, name: `${constraints.nickname} (@${constraints.username})`, constraints }
  }
  function check({ draft, video, account }) {
    const copyIssue = tikTokCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (!Object.hasOwn(TIKTOK_VISIBILITY, draft.privacyStatus) || draft.original !== true || draft.musicConsent !== true || ['allowComment', 'allowDuet', 'allowStitch', 'isAiGenerated', 'commercialContent', 'ownBrand', 'brandedContent'].some(key => typeof draft[key] !== 'boolean')) throw invalid('请确认 TikTok 原创、可见范围、互动、AI 和发布声明')
    if (draft.commercialContent ? !draft.ownBrand && !draft.brandedContent : draft.ownBrand || draft.brandedContent) throw invalid('请选择 TikTok 商业内容的推广对象')
    if (draft.brandedContent && (draft.privacyStatus === 'private' || draft.brandedConsent !== true)) throw invalid('TikTok 付费合作不能设为仅自己可见，并须确认品牌内容政策')
    if (!Number.isSafeInteger(video?.sizeBytes) || video.sizeBytes < 1 || video.sizeBytes > MAX_ASSET_BYTES || typeof video.stream !== 'function') throw invalid('TikTok 需要不超过 250 MB 的本地成片')
    const mediaIssue = tikTokVideoIssue(video)
    if (mediaIssue) throw invalid(mediaIssue)
    const constraints = account?.constraints
    if (constraints && (!constraints.privacyLevels.includes(TIKTOK_VISIBILITY[draft.privacyStatus]) || video.duration > constraints.maxDuration || (constraints.commentDisabled && draft.allowComment) || (constraints.duetDisabled && draft.allowDuet) || (constraints.stitchDisabled && draft.allowStitch))) throw invalid('TikTok 创作者权限已变化，请重新核对可见范围、互动和视频时长')
    return { title: tikTokCaption(draft), privacy_level: TIKTOK_VISIBILITY[draft.privacyStatus], disable_comment: !draft.allowComment, disable_duet: !draft.allowDuet, disable_stitch: !draft.allowStitch, is_aigc: draft.isAiGenerated, brand_organic_toggle: draft.ownBrand, brand_content_toggle: draft.brandedContent, video_cover_timestamp_ms: 0 }
  }
  return Object.freeze({
    account, check,
    reviewAccount: (...args) => client.identity(...args),
    async submit({ accessToken, channelId, draft, video, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.openId) throw invalid('TikTok 当前账号与投稿确认单不一致')
      const current = await account(accessToken, signal)
      const postInfo = check({ draft, video, account: current })
      const { chunkSize, chunkCount } = tikTokChunks(video.sizeBytes)
      await beforeSubmit()
      const session = await client.initialize(accessToken, postInfo, { source: 'FILE_UPLOAD', video_size: video.sizeBytes, chunk_size: chunkSize, total_chunk_count: chunkCount }, signal)
      await beforeSubmit(session.id)
      await client.upload(session, video, chunkSize, chunkCount, signal)
      return { status: 'pending_review', receiptId: session.id, workId: current.constraints.username }
    },
    async review({ accessToken, channelId, receiptId, workId, signal }) {
      if (channelId !== client.openId) throw invalid('TikTok 当前账号与投稿确认单不一致')
      await client.identity(accessToken, signal)
      const result = await client.status(accessToken, receiptId, signal)
      if (result.status === 'FAILED') return { status: 'rejected', platformState: 'failed', receiptId }
      if (['PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD'].includes(result.status)) return { status: 'pending_review', platformState: result.status, receiptId }
      if (result.status !== 'PUBLISH_COMPLETE') throw new PublishError('TIKTOK_UNKNOWN_STATE', 'TikTok 未返回可确认的投稿状态，已保留原记录', { stage: 'review', outcome: 'unknown' })
      const ids = result.publicaly_available_post_id
      const id = Array.isArray(ids) && ids.length === 1 ? ids[0] : null
      const textId = typeof id === 'string' ? id : Number.isSafeInteger(id) ? String(id) : ''
      const url = /^[1-9]\d{0,31}$/.test(textId) && typeof workId === 'string' && /^[A-Za-z0-9_.]{1,100}$/.test(workId) ? `https://www.tiktok.com/@${workId}/video/${textId}` : undefined
      return { status: 'published', platformState: 'complete', receiptId, url }
    },
  })
}
