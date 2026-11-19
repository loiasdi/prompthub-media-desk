// Upload and create requests adapted from AiToEarn's douyin.service.ts (MIT).
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { PublishError } from '../errors.js'

const API = 'https://open.douyin.com'
const VIDEO = '/api/douyin/v1/video/'
export const validOpenId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
export const validVideoId = value => typeof value === 'string' && /^[1-9]\d{0,23}$/.test(value)
const opaqueId = value => typeof value === 'string' && /^[@A-Za-z0-9_+\/=-]{1,512}$/.test(value)
const tokenValid = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value)
const rejectedCreate = new Set([2100005, 2114006, 2114007, 2190007, 28001003, 28001007, 28001008, 28001014, 28001016, 28001018, 28001019, 28003017])

// Do not build a Blob of the whole video; each multipart range streams from the
// private snapshot. The only dynamic filename component is a fixed extension.
function multipart(field, source, start = 0, end = source.sizeBytes - 1) {
  const boundary = `media-desk-${randomUUID()}`
  const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png' }[source.mime]
  if (!ext) throw new TypeError('Invalid Douyin upload format')
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${field}.${ext}"\r\nContent-Type: ${source.mime}\r\n\r\n`)
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Readable.from((async function* () {
    yield prefix
    yield* source.stream({ start, end })
    yield suffix
  })(), { objectMode: false })
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + end - start + 1 + suffix.length) } }
}

function replyError(stage, suffix, message, details) {
  return new PublishError(`DOUYIN_${suffix}`, message, { stage, outcome: ['submit', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })
}

export function createDouyinClient({ openId }, { fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 3 * 60_000 } = {}) {
  if (!validOpenId(openId)) throw new TypeError('Invalid Douyin open_id')

  async function request(path, stage, { accessToken, query, json, form, emptyJson, file, signal, method = 'POST' } = {}) {
    const publicRead = stage === 'review'
    if (!publicRead && !tokenValid(accessToken)) throw replyError(stage, 'INVALID_TOKEN', '抖音授权令牌无效', { outcome: 'failed' })
    const deadline = AbortSignal.timeout(file ? uploadTimeoutMs : timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw replyError(stage, 'ABORTED', '抖音请求已取消', { outcome: stage === 'review' ? 'unknown' : 'failed' })
    const url = new URL(path, API)
    if (query) url.search = new URLSearchParams(query).toString()
    const headers = publicRead || form ? {} : { 'access-token': accessToken }
    let media
    try {
      if (file) {
        const { body, headers: content } = multipart(...file)
        media = body
        Object.assign(headers, content)
      } else if (json !== undefined || emptyJson) headers['content-type'] = 'application/json'
      let response, payload
      try {
        response = await fetchImpl(url, { method, headers, signal: requestSignal, redirect: 'error', body: media ?? form ?? (json === undefined ? undefined : JSON.stringify(json)), ...(media && { duplex: 'half' }) })
        payload = await response.json()
      } catch { throw replyError(stage, 'RESPONSE_UNAVAILABLE', '未收到可确认的抖音响应') }
      const data = payload?.data
      const envelopeCode = form || publicRead ? payload?.err_no : data?.error_code
      const extraCode = payload?.extra?.error_code
      if (publicRead && response.ok && envelopeCode === 0 && typeof data?.iframe_code === 'string' && data.iframe_code.trim()) return true
      const accountCode = form && data?.error_code !== undefined ? String(data.error_code) : '0'
      if (response.ok && !publicRead && envelopeCode === 0 && (extraCode === undefined || extraCode === 0) && accountCode === '0' && data && typeof data === 'object' && !Array.isArray(data)) return data
      const code = [envelopeCode, extraCode].find(candidate => Number.isSafeInteger(candidate) && candidate > 0)
      const explicitRejection = !data?.item_id && !data?.video_id && stage === 'submit' && response.ok && rejectedCreate.has(envelopeCode) && (extraCode === undefined || extraCode === 0 || extraCode === envelopeCode)
      throw replyError(stage, 'REQUEST_FAILED', code ? `抖音接口未确认成功（错误码 ${code}）` : `抖音接口未返回有效结果（HTTP ${response.status}）`, { platformCode: code, httpStatus: response.status, ...(explicitRejection && { outcome: 'failed' }) })
    } finally { media?.destroy() }
  }
  const videoRequest = (endpoint, stage, accessToken, { query, ...rest }) => request(VIDEO + endpoint + '/', stage, { ...rest, query: { open_id: openId, ...query }, accessToken })
  const verifyMediaId = (value, stage) => {
    if (!opaqueId(value)) throw replyError(stage, 'INVALID_ID', '抖音未返回有效的上传标识')
    return value
  }
  return Object.freeze({
    openId,
    async account(accessToken, signal) {
      const data = await request('/oauth/userinfo/', 'account', { accessToken, signal, form: new URLSearchParams({ open_id: openId, access_token: accessToken }) })
      if (data.open_id !== openId || typeof data.nickname !== 'string' || !data.nickname.trim()) throw replyError('account', 'ACCOUNT_MISMATCH', '抖音令牌与配置账号不一致，或未返回有效账号')
      return { id: openId, name: data.nickname }
    },
    async uploadVideo(accessToken, source, signal) {
      const data = await videoRequest('upload_video', 'upload', accessToken, { file: ['video', source], signal })
      return verifyMediaId(data.video?.video_id, 'upload')
    },
    async initParts(accessToken, signal) {
      const data = await videoRequest('init_video_part_upload', 'upload', accessToken, { emptyJson: true, signal })
      return verifyMediaId(data.upload_id, 'upload')
    },
    part(accessToken, uploadId, partNumber, source, start, end, signal) {
      return videoRequest('upload_video_part', 'upload', accessToken, { query: { upload_id: uploadId, part_number: partNumber }, file: ['video', source, start, end], signal })
    },
    async completeParts(accessToken, uploadId, signal) {
      const data = await videoRequest('complete_video_part_upload', 'upload', accessToken, { query: { upload_id: uploadId }, emptyJson: true, signal })
      return verifyMediaId(data.video?.video_id, 'upload')
    },
    async uploadCover(accessToken, source, signal) {
      const data = await videoRequest('upload_image', 'upload', accessToken, { file: ['image', source], signal })
      return verifyMediaId(data.image?.image_id, 'upload')
    },
    async create(accessToken, json, signal) {
      const data = await videoRequest('create_video', 'submit', accessToken, { json, signal })
      if (!opaqueId(data.item_id)) throw replyError('submit', 'INVALID_RECEIPT', '抖音未返回可确认的投稿回执，请去创作中心核对')
      return { receiptId: data.item_id, workId: validVideoId(data.video_id) ? data.video_id : undefined }
    },
    verifyPublic(workId, signal) {
      if (!validVideoId(workId)) throw replyError('review', 'MISSING_WORK_ID', '此回执没有可查询的公开视频 ID，请去抖音创作中心核对')
      return request(VIDEO + 'get_iframe_by_video', 'review', { method: 'GET', query: { video_id: workId }, signal })
    },
  })
}
