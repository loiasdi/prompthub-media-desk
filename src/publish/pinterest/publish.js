import { setTimeout as delay } from 'node:timers/promises'
import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { pinterestCaption, pinterestCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { PUBLISH_COVER_BYTES, PUBLISH_COVER_MIME, pinterestImagesIssue, pinterestVideoIssue } from '../media-rules.js'
import { validPinterestId } from './client.js'

const invalid = message => new PublishError('INVALID_PINTEREST_DRAFT', message, { stage: 'check' })
const pinUrl = id => `https://www.pinterest.com/pin/${id}/`
const usable = source => Number.isSafeInteger(source?.sizeBytes) && source.sizeBytes > 0 && typeof source.stream === 'function'
async function inlineImage(source, signal) {
  const chunks = []
  let size = 0
  for await (const chunk of source.stream()) {
    signal?.throwIfAborted()
    size += chunk.length
    if (size > PUBLISH_COVER_BYTES || size > source.sizeBytes) throw invalid('Pinterest 图片大小已变化，请重新准备')
    chunks.push(chunk)
  }
  if (size !== source.sizeBytes) throw invalid('Pinterest 图片大小已变化，请重新准备')
  return { content_type: source.mime, data: Buffer.concat(chunks).toString('base64') }
}

export function createPinterestPublisher(client, { wait = (ms, signal) => delay(ms, undefined, { signal }), pollIntervalMs = 5000, pollAttempts = 60 } = {}) {
  function check({ draft, video, cover, images = [] }) {
    const copyIssue = pinterestCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (!validPinterestId(draft.categoryId) || draft.privacyStatus !== 'public' || draft.original !== true || typeof draft.isAiGenerated !== 'boolean' || typeof draft.syntheticPerformer !== 'boolean') throw invalid('请确认 Pinterest 画板、公开原创内容和两项 AI 声明')
    if (!Array.isArray(images)) throw invalid('Pinterest 图文请选择 1 至 5 张本地图片')
    if (images.length) {
      if (video || cover) throw invalid('Pinterest 图文不能混发视频或独立封面')
      const issue = pinterestImagesIssue(images)
      if (issue) throw invalid(issue)
      if (!images.every(usable)) throw invalid('Pinterest 需要有效的本地发布图片')
    } else {
      if (!usable(video) || video.sizeBytes > MAX_ASSET_BYTES) throw invalid('Pinterest 需要有效的本地成片')
      const mediaIssue = pinterestVideoIssue(video)
      if (mediaIssue) throw invalid(mediaIssue)
      if (cover && (!usable(cover) || cover.sizeBytes > PUBLISH_COVER_BYTES || !PUBLISH_COVER_MIME.has(cover.mime))) throw invalid('Pinterest 封面需要不超过 10 MiB 的 JPEG 或 PNG')
    }
    return { board_id: draft.categoryId, title: draft.title, description: pinterestCaption(draft), ai_disclosures: { values: [...(draft.isAiGenerated ? ['AI_MODIFIED'] : []), ...(draft.syntheticPerformer ? ['SYNTHETIC_PERFORMER'] : [])] } }
  }
  return Object.freeze({
    account: (...args) => client.account(...args),
    categories: (...args) => client.boards(...args),
    check,
    async submit({ accessToken, channelId, draft, video, cover, images = [], beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.userId) throw invalid('Pinterest 当前账号与投稿确认单不一致')
      const metadata = check({ draft, video, cover, images })
      const account = await client.account(accessToken, signal)
      await client.board(accessToken, draft.categoryId, account.username, signal)
      const create = async mediaSource => {
        const current = await client.account(accessToken, signal)
        await client.board(accessToken, draft.categoryId, current.username, signal)
        await beforeSubmit()
        const receiptId = await client.create(accessToken, { ...metadata, media_source: mediaSource }, signal)
        return { status: 'published', receiptId, workId: draft.categoryId, privacyStatus: 'public', url: pinUrl(receiptId) }
      }
      if (images.length) {
        const items = []
        for (const image of images) items.push(await inlineImage(image, signal))
        return create(items.length === 1 ? { source_type: 'image_base64', ...items[0] } : { source_type: 'multiple_image_base64', items, index: 0 })
      }
      const mediaSource = { source_type: 'video_id' }
      if (cover) {
        const image = await inlineImage(cover, signal)
        Object.assign(mediaSource, { cover_image_content_type: image.content_type, cover_image_data: image.data })
      } else mediaSource.cover_image_key_frame_time = 0
      const session = await client.initialize(accessToken, signal)
      await client.upload(session, video, signal)
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        if (attempt) await wait(pollIntervalMs, signal)
        const state = await client.status(accessToken, session.id, signal)
        if (state === 'succeeded') {
          return create({ ...mediaSource, media_id: session.id })
        }
        if (!['registered', 'processing'].includes(state)) throw new PublishError('PINTEREST_PROCESSING_FAILED', 'Pinterest 未确认视频处理成功，未发送发布请求', { stage: 'processing' })
      }
      throw new PublishError('PINTEREST_PROCESSING_TIMEOUT', 'Pinterest 未在等待时间内处理完成，未发送发布请求', { stage: 'processing' })
    },
    async review({ accessToken, channelId, receiptId, workId, images = [], signal }) {
      if (channelId !== client.userId) throw invalid('Pinterest 当前账号与投稿确认单不一致')
      const account = await client.account(accessToken, signal)
      const pin = await client.pin(accessToken, receiptId, signal, images.length)
      if (pin.board_id !== workId) throw new PublishError('PINTEREST_PIN_BOARD_CHANGED', 'Pinterest Pin 所在画板已变化，请在平台核对', { stage: 'review', outcome: 'unknown' })
      await client.board(accessToken, workId, account.username, signal)
      return { status: 'published', platformState: 'available', receiptId, privacyStatus: 'public', url: pinUrl(receiptId) }
    },
  })
}
