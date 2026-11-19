import { kuaishouCaption, kuaishouCopyIssue } from '../draft-copy.js'
import { KUAISHOU_COVER_BYTES, KUAISHOU_VIDEO_BYTES, KUAISHOU_VIDEO_MIME, kuaishouVideoIssue } from '../media-rules.js'
import { PublishError } from '../errors.js'

const invalid = message => new PublishError('INVALID_KUAISHOU_DRAFT', message, { stage: 'check', outcome: 'failed' })
const FRAGMENT_BYTES = 4_000_000
const usable = source => Number.isSafeInteger(source?.sizeBytes) && source.sizeBytes > 0 && typeof source.stream === 'function'
const photoIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const permalink = photoId => `https://www.kuaishou.com/short-video/${photoId}`

export function createKuaishouPublisher(client) {
  function check({ draft, video, cover }) {
    const copyIssue = kuaishouCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (draft.privacyStatus !== 'public') throw invalid('请确认快手作品将公开发布')
    if (draft.requiresAiLabel !== false) throw invalid('需要快手原生 AI 标识的内容，请改用官方发布器')
    if (!usable(video) || !KUAISHOU_VIDEO_MIME.has(video.mime) || video.sizeBytes > KUAISHOU_VIDEO_BYTES) throw invalid('快手投稿需要不超过 100 MB 的本地 MP4、MOV 或 WebM 成片')
    const videoIssue = kuaishouVideoIssue(video)
    if (videoIssue) throw invalid(videoIssue)
    if (!usable(cover) || cover.mime !== 'image/jpeg' || cover.sizeBytes >= KUAISHOU_COVER_BYTES) throw invalid('快手投稿必须选择小于 10 MB 的本地 JPEG 封面')
    return kuaishouCaption(draft)
  }

  async function upload(accessToken, video, signal) {
    const { uploadToken, endpoint } = await client.startUpload(accessToken, signal)
    const count = Math.ceil(video.sizeBytes / FRAGMENT_BYTES)
    for (let id = 0; id < count; id++) {
      const start = id * FRAGMENT_BYTES
      const end = Math.min(video.sizeBytes, start + FRAGMENT_BYTES) - 1
      await client.uploadFragment(endpoint, uploadToken, id, video, start, end, signal)
    }
    await client.completeUpload(endpoint, uploadToken, count, signal)
    return uploadToken
  }

  return Object.freeze({
    check,
    account: (...args) => client.account(...args),
    async submit({ accessToken, channelId, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.credentialId(accessToken)) throw invalid('快手当前账号与投稿确认单不一致')
      const caption = check({ draft, video, cover })
      const uploadToken = await upload(accessToken, video, signal)
      signal?.throwIfAborted()
      await beforeSubmit()
      const { photoId, pending } = await client.publish(accessToken, uploadToken, caption, cover, signal)
      if (!photoIdValid(photoId)) throw new PublishError('KUAISHOU_INVALID_RECEIPT', '快手未返回可确认的作品回执，请到创作者中心核对', { stage: 'submit', outcome: 'unknown' })
      return { status: pending ? 'pending_review' : 'published', receiptId: photoId, url: pending ? undefined : permalink(photoId), privacyStatus: 'public' }
    },
    async review({ accessToken, channelId, receiptId, signal }) {
      if (channelId !== client.credentialId(accessToken)) throw invalid('快手当前账号与投稿记录不一致')
      if (!photoIdValid(receiptId)) throw invalid('快手投稿回执无效')
      const result = await client.videoInfo(accessToken, receiptId, signal)
      if (result.failed) return { status: 'failed', receiptId }
      if (result.pending) return { status: 'pending_review', receiptId }
      return { status: 'published', receiptId, url: permalink(receiptId), privacyStatus: 'public' }
    },
  })
}
