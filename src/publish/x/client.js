import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { PublishError } from '../errors.js'

export const validXId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
const failure = (stage, code, message, details) => new PublishError(`X_${code}`, message, { stage, outcome: ['submit', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })

function multipart(source, start, end, segmentIndex) {
  const boundary = `media-desk-${randomUUID()}`
  const filename = source.mime === 'image/jpeg' ? 'image.jpg' : source.mime === 'image/png' ? 'image.png' : 'video.mp4'
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="segment_index"\r\n\r\n${segmentIndex}\r\n--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${source.mime}\r\n\r\n`)
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Readable.from((async function* () {
    yield prefix
    yield* source.stream({ start, end })
    yield suffix
  })(), { objectMode: false })
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + end - start + 1 + suffix.length) } }
}

export function createXClient({ userId }, { fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 3 * 60_000 } = {}) {
  if (!validXId(userId)) throw new TypeError('Invalid X user ID')
  async function request(path, stage, accessToken, { json, file, signal, method = 'GET' } = {}) {
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) throw failure(stage, 'INVALID_TOKEN', 'X 授权令牌无效', { outcome: 'failed' })
    const deadline = AbortSignal.timeout(file ? uploadTimeoutMs : timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw failure(stage, 'ABORTED', 'X 请求已取消', { outcome: 'failed' })
    const headers = { authorization: `Bearer ${accessToken}` }
    const media = file && multipart(...file)
    if (media) Object.assign(headers, media.headers)
    else if (json !== undefined) headers['content-type'] = 'application/json'
    try {
      let response, payload
      try {
        response = await fetchImpl(new URL(path, 'https://api.x.com'), { method, headers, body: media?.body ?? (json === undefined ? undefined : JSON.stringify(json)), signal: requestSignal, redirect: 'error', ...(media && { duplex: 'half' }) })
        payload = await response.json()
      } catch { throw failure(stage, 'NO_RESPONSE', '未收到可确认的 X 响应') }
      const data = payload?.data
      if (response.ok && data && typeof data === 'object' && !Array.isArray(data) && (payload.errors === undefined || (Array.isArray(payload.errors) && payload.errors.length === 0))) return { data, status: response.status }
      const rejected = stage === 'submit' && !data?.id && [400, 401, 403, 404, 413, 415, 422].includes(response.status)
      throw failure(stage, 'REQUEST_FAILED', `X 未确认请求成功（HTTP ${response.status}）`, { httpStatus: response.status, ...(rejected && { outcome: 'failed' }) })
    } finally { media?.body.destroy() }
  }
  function mediaId(id, stage) {
    if (!validXId(id)) throw failure(stage, 'INVALID_MEDIA_ID', 'X 未返回有效的素材标识')
    return id
  }
  return Object.freeze({
    userId,
    async account(accessToken, signal) {
      const { data } = await request('/2/users/me?user.fields=id,name,username,protected', 'account', accessToken, { signal })
      if (data.id !== userId || typeof data.name !== 'string' || !data.name.trim() || typeof data.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(data.username)) throw failure('account', 'ACCOUNT_MISMATCH', 'X 令牌与配置账号不一致，或未返回有效账号')
      if (data.protected !== false) throw failure('account', 'PROTECTED_ACCOUNT', '此入口仅支持 X 公开账号，请在 X 核对账号可见性')
      return { id: userId, name: `${data.name} (@${data.username})` }
    },
    async initialize(accessToken, sizeBytes, signal, mime = 'video/mp4') {
      if (!['video/mp4', 'image/jpeg', 'image/png'].includes(mime)) throw failure('initialize', 'INVALID_MEDIA_TYPE', 'X 素材类型无效')
      const { data } = await request('/2/media/upload/initialize', 'initialize', accessToken, { method: 'POST', json: { media_type: mime, total_bytes: sizeBytes, media_category: mime.startsWith('image/') ? 'tweet_image' : 'tweet_video' }, signal })
      const id = mediaId(data.id, 'initialize')
      if (data.expires_after_secs !== undefined && (!Number.isSafeInteger(data.expires_after_secs) || data.expires_after_secs <= 0 || data.expires_after_secs > 31_536_000)) throw failure('initialize', 'INVALID_EXPIRY', 'X 素材上传会话有效期无效')
      return { id, expiresAt: data.expires_after_secs === undefined ? undefined : Date.now() + data.expires_after_secs * 1000 }
    },
    async append(accessToken, id, source, start, end, segmentIndex, signal) {
      mediaId(id, 'upload')
      await request(`/2/media/upload/${id}/append`, 'upload', accessToken, { method: 'POST', file: [source, start, end, segmentIndex], signal })
    },
    async finalize(accessToken, id, signal) {
      mediaId(id, 'finalize')
      const { data } = await request(`/2/media/upload/${id}/finalize`, 'finalize', accessToken, { method: 'POST', signal })
      if (data.id !== id) throw failure('finalize', 'MEDIA_MISMATCH', 'X 未确认完成该素材上传')
      return data.processing_info
    },
    async processing(accessToken, id, signal) {
      mediaId(id, 'processing')
      const { data } = await request(`/2/media/upload?media_id=${id}&command=STATUS`, 'processing', accessToken, { signal })
      if (data.id !== id || !data.processing_info) throw failure('processing', 'INVALID_STATUS', 'X 未返回可确认的素材处理状态')
      return data.processing_info
    },
    async create(accessToken, id, metadata, signal) {
      const mediaIds = id === undefined ? [] : Array.isArray(id) ? id : [id]
      if (mediaIds.length > 4 || new Set(mediaIds).size !== mediaIds.length) throw failure('submit', 'INVALID_MEDIA_IDS', 'X 发布素材数量无效或重复', { outcome: 'failed' })
      mediaIds.forEach(value => mediaId(value, 'submit'))
      const { data, status } = await request('/2/tweets', 'submit', accessToken, { method: 'POST', json: { text: metadata.text, made_with_ai: metadata.isAiGenerated, paid_partnership: metadata.isPaidPartnership, ...(mediaIds.length && { media: { media_ids: mediaIds } }) }, signal })
      if (status !== 201 || !validXId(data.id)) throw failure('submit', 'INVALID_RECEIPT', 'X 未返回可确认的帖子回执，请到 X 核对')
      return data.id
    },
    async post(accessToken, receiptId, signal) {
      if (!validXId(receiptId)) throw failure('review', 'INVALID_RECEIPT', 'X 帖子回执无效')
      const { data } = await request(`/2/tweets/${receiptId}?tweet.fields=id,author_id`, 'review', accessToken, { signal })
      if (data.id !== receiptId || data.author_id !== userId) throw failure('review', 'POST_MISMATCH', 'X 未确认该帖子属于原投稿账号')
      return data
    },
  })
}
