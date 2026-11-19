import { setTimeout as delay } from 'node:timers/promises'
import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { xCaption, xCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { xImagesIssue, xVideoIssue } from '../media-rules.js'

export const X_PART_BYTES = 5_000_000
const invalid = message => new PublishError('INVALID_X_DRAFT', message, { stage: 'check' })
const urlOf = receiptId => `https://x.com/i/web/status/${receiptId}`

export function createXPublisher(client, { partBytes = X_PART_BYTES, wait = (ms, signal) => delay(ms, undefined, { signal }), pollAttempts = 60 } = {}) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > X_PART_BYTES) throw new TypeError('Invalid X part size')
  function check({ draft, video, cover, images = [] }) {
    const copyIssue = xCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (draft.privacyStatus !== 'public' || typeof draft.isAiGenerated !== 'boolean' || typeof draft.isPaidPartnership !== 'boolean') throw invalid('请确认 X 公开发布、AI 使用与商业合作声明')
    if (!Array.isArray(images)) throw invalid('请检查 X 发布图片')
    const format = draft.format || 'video'
    if (format === 'text') {
      if (video || cover || images.length) throw invalid('X 纯文字不能混入素材')
    } else if (format === 'images') {
      if (video || cover) throw invalid('X 图文不能混发视频或独立封面')
      const mediaIssue = xImagesIssue(images)
      if (mediaIssue) throw invalid(mediaIssue)
      if (images.some(image => typeof image.stream !== 'function')) throw invalid('X 需要有效的本地发布图片')
    } else {
      if (format !== 'video' || images.length) throw invalid('请检查 X 发布类型，不支持混合素材')
      if (cover || !Number.isSafeInteger(video?.sizeBytes) || video.sizeBytes < 1 || video.sizeBytes > MAX_ASSET_BYTES || typeof video.stream !== 'function') throw invalid('X 需要有效的本地视频，不上传独立封面')
      const mediaIssue = xVideoIssue(video)
      if (mediaIssue) throw invalid(mediaIssue)
    }
    return { text: xCaption(draft), isAiGenerated: draft.isAiGenerated, isPaidPartnership: draft.isPaidPartnership }
  }
  const unexpired = session => {
    if (session.expiresAt !== undefined && Date.now() >= session.expiresAt) throw new PublishError('X_MEDIA_EXPIRED', 'X 素材上传会话已过期，未发送发布请求', { stage: 'upload' })
  }
  async function upload(accessToken, source, signal) {
    const session = await client.initialize(accessToken, source.sizeBytes, signal, source.mime)
    for (let start = 0, part = 0; start < source.sizeBytes; start += partBytes, part++) {
      unexpired(session)
      await client.append(accessToken, session.id, source, start, Math.min(start + partBytes, source.sizeBytes) - 1, part, signal)
    }
    unexpired(session)
    let info = await client.finalize(accessToken, session.id, signal)
    for (let attempt = 0; info !== undefined && info?.state !== 'succeeded'; attempt++) {
      if (attempt >= pollAttempts || !['pending', 'in_progress'].includes(info?.state)) throw new PublishError('X_PROCESSING_UNCONFIRMED', 'X 未确认素材处理完成，未发送发布请求', { stage: 'processing' })
      const seconds = info.check_after_secs === undefined ? 5 : info.check_after_secs
      if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 60) throw new PublishError('X_PROCESSING_DELAY', 'X 返回的处理等待时间无效，未发送发布请求', { stage: 'processing' })
      await wait(Math.max(1, seconds) * 1000, signal)
      unexpired(session)
      info = await client.processing(accessToken, session.id, signal)
    }
    unexpired(session)
    return session
  }
  return Object.freeze({
    account: client.account,
    check,
    async submit({ accessToken, channelId, draft, video, cover, images = [], beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.userId) throw invalid('X 当前账号与投稿确认单不一致')
      const metadata = check({ draft, video, cover, images })
      const sessions = []
      for (const source of video ? [video] : images) {
        const session = await upload(accessToken, source, signal)
        if (sessions.some(previous => previous.id === session.id)) throw new PublishError('X_DUPLICATE_MEDIA', 'X 返回重复的素材标识，未发送发布请求', { stage: 'upload' })
        sessions.push(session)
      }
      await client.account(accessToken, signal)
      sessions.forEach(unexpired)
      await beforeSubmit()
      const receiptId = await client.create(accessToken, sessions.length ? sessions.map(session => session.id) : undefined, metadata, signal)
      return { status: 'published', receiptId, url: urlOf(receiptId), privacyStatus: 'public' }
    },
    async review({ accessToken, channelId, receiptId, signal }) {
      if (channelId !== client.userId) throw invalid('X 当前账号与投稿确认单不一致')
      await client.post(accessToken, receiptId, signal)
      return { status: 'published', platformState: 'available', receiptId, url: urlOf(receiptId), privacyStatus: 'public' }
    },
  })
}
