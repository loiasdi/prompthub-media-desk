// Adapted from AiToEarn's Bilibili service and publish provider at 11dd1957 (MIT).
import { bilibiliCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { PUBLISH_COVER_BYTES, PUBLISH_COVER_MIME, PUBLISH_VIDEO_MIME } from '../media-rules.js'

const CHUNK_BYTES = 100 * 1024 * 1024 // Upstream protocol baseline; verify with a granted app before enablement.
const PUBLIC_ID = /^(?:BV[0-9A-Z]+|av\d+)$/i
const invalid = message => new PublishError('INVALID_BILIBILI_DRAFT', message, { stage: 'check' })
const usefulString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500

function checkSource(source, allowed, limit = Number.MAX_SAFE_INTEGER) {
  if (!source || !allowed.has(source.mime) || !usefulString(source.filename) || /[\\/\x00-\x1f\x7f]/.test(source.filename) || typeof source.stream !== 'function' || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > limit) {
    throw invalid('B 站投稿素材类型、文件名或大小无效')
  }
}

function postBody({ title, description = '', topics = [], categoryId, copyright, noReprint = false, source = '' }) {
  const copyIssue = bilibiliCopyIssue({ title, description, topics })
  if (copyIssue) throw invalid(copyIssue)
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) throw invalid('请选择 B 站投稿分区')
  if (![1, 2].includes(copyright) || typeof noReprint !== 'boolean' || typeof source !== 'string' || source.length > 500 || (copyright === 2 && !source.trim())) throw invalid('请选择原创或转载；转载稿件必须填写来源')
  return {
    title: title.trim(), tid: categoryId, tag: [...new Set(topics.map(tag => tag.trim()))].join(','),
    copyright, no_reprint: noReprint ? 1 : 0, desc: description,
    ...(source.trim() && { source: source.trim() }),
  }
}

// The receipt returned by submit is not a public work ID, even if it resembles one.
export function readBilibiliStatus(data, receiptId) {
  if (!Number.isInteger(data?.addit_info?.state)) throw new PublishError('BILIBILI_INVALID_RESPONSE', 'B 站未返回可确认的审核状态', { stage: 'review' })
  const platformState = data.addit_info.state
  const publicId = typeof data.resource_id === 'string' && PUBLIC_ID.test(data.resource_id) ? data.resource_id : null
  if (platformState === 0 && publicId) return { status: 'published', receiptId, publicId, url: `https://www.bilibili.com/video/${publicId}`, platformState }
  // Only map verified upstream review states. Do not infer rejection from undocumented codes.
  return { status: platformState === 0 || platformState === -1 ? 'pending_review' : 'unknown', receiptId, platformState }
}

async function coverForm(source) {
  const chunks = []
  let length = 0
  for await (const chunk of source.stream()) {
    length += chunk.length
    if (length > PUBLISH_COVER_BYTES || length > source.sizeBytes) throw invalid('上传前封面文件大小发生变化')
    chunks.push(chunk)
  }
  if (length !== source.sizeBytes) throw invalid('上传前封面文件大小发生变化')
  const form = new FormData()
  form.set('file', new Blob(chunks, { type: source.mime }), source.filename)
  return form
}

/** Host-only adapter. The integration must validate credentials and take a private immutable snapshot first. */
export function createBilibiliPublisher(client, { chunkBytes = CHUNK_BYTES } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError('Invalid Bilibili part size')
  function check({ draft, video, cover }) {
    const body = postBody(draft)
    checkSource(video, PUBLISH_VIDEO_MIME)
    if (cover) checkSource(cover, PUBLISH_COVER_MIME, PUBLISH_COVER_BYTES)
    return body
  }
  return Object.freeze({
    check,
    async submit({ accessToken, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      const body = check({ draft, video, cover })
      let form
      if (cover) {
        form = await coverForm(cover)
      }
      const { upload_token: uploadToken } = await client.init(accessToken, video.filename, signal)
      if (!usefulString(uploadToken)) throw new PublishError('BILIBILI_INVALID_RESPONSE', 'B 站未返回有效上传凭据', { stage: 'upload_init' })
      for (let start = 0, index = 1; start < video.sizeBytes; start += chunkBytes, index++) {
        await client.part(uploadToken, index, video, start, Math.min(start + chunkBytes, video.sizeBytes) - 1, signal)
      }
      await client.complete(accessToken, uploadToken, signal)
      if (form) {
        const { url } = await client.cover(accessToken, form, signal)
        if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url)) throw new PublishError('BILIBILI_INVALID_RESPONSE', 'B 站未返回有效封面回执', { stage: 'cover' })
        body.cover = url // This is Bilibili's own upload receipt, not a user-supplied URL.
      }
      signal?.throwIfAborted()
      await beforeSubmit()
      const { resource_id: receiptId } = await client.submit(accessToken, uploadToken, body, signal)
      if (!usefulString(receiptId)) throw new PublishError('BILIBILI_INVALID_RESPONSE', 'B 站未返回可查询的投稿回执，请先核对作品', { stage: 'submit', outcome: 'unknown' })
      return { status: 'pending_review', receiptId }
    },
    async review({ accessToken, receiptId, signal }) {
      if (!usefulString(receiptId)) throw invalid('没有可查询的 B 站投稿回执')
      return readBilibiliStatus(await client.detail(accessToken, receiptId, signal), receiptId)
    },
  })
}
