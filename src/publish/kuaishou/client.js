import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { assertPublicUrl } from '../../harvest.js'
import { PublishError } from '../errors.js'
import { KUAISHOU_COVER_BYTES, KUAISHOU_VIDEO_BYTES, KUAISHOU_VIDEO_MIME } from '../media-rules.js'

const API = 'https://open.kuaishou.com'
const ENDPOINT_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*gifshow\.com$/i
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const fail = (stage, suffix, message, outcome) => new PublishError(`KUAISHOU_${suffix}`, message, { stage, outcome: outcome || (['submit', 'review'].includes(stage) ? 'unknown' : 'failed') })
const credentialId = (openId, accessToken) => `${openId}:${createHash('sha256').update(accessToken).digest('base64url')}`

function assertAccountConfig({ appId, openId }) {
  if (typeof appId !== 'string' || !ID_RE.test(appId) || typeof openId !== 'string' || !ID_RE.test(openId)) throw new TypeError('Invalid Kuaishou account configuration')
}

export function createKuaishouClient({ appId, openId }, {
  fetchImpl = fetch, validatePublicUrl = assertPublicUrl, allowInsecureUpload = false,
  timeoutMs = 30_000, uploadTimeoutMs = 5 * 60_000,
} = {}) {
  assertAccountConfig({ appId, openId })

  async function jsonRequest(path, { accessToken, query = {}, method = 'GET', form, signal, stage }) {
    if (!TOKEN_RE.test(accessToken || '')) throw fail(stage, 'INVALID_TOKEN', '快手授权令牌无效', 'failed')
    const url = new URL(path, API)
    url.search = new URLSearchParams({ app_id: appId, access_token: accessToken, ...query }).toString()
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    try {
      const response = await fetchImpl(url, { method, ...(form && { body: form }), redirect: 'error', signal: requestSignal })
      let data
      try { data = await response.json() } catch { throw fail(stage, 'INVALID_RESPONSE', '快手未返回可确认的响应') }
      if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data) || data.result !== 1) {
        const explicit = response.ok && data && Number.isInteger(data.result) && data.result !== 1
        const error = fail(stage, 'REQUEST_FAILED', `快手接口未确认成功（HTTP ${response.status}）`, explicit ? 'failed' : undefined)
        if (Number.isInteger(data?.result)) error.platformResult = data.result
        throw error
      }
      return data
    } catch (error) {
      if (error instanceof PublishError) throw error
      throw fail(stage, 'NO_RESPONSE', '未收到可确认的快手响应')
    }
  }

  function uploaderUrl(endpoint, path, query) {
    if (!allowInsecureUpload) throw fail('upload', 'HTTP_DISABLED', '快手官方上传网关使用未加密 HTTP；请在可信网络下显式启用此上传方式')
    if (typeof endpoint !== 'string' || !ENDPOINT_RE.test(endpoint) || endpoint.length > 253) throw fail('upload', 'INVALID_ENDPOINT', '快手返回的上传域名不在允许范围内')
    const url = new URL(path, `http://${endpoint}`)
    url.search = new URLSearchParams(query).toString()
    return url
  }

  async function uploaderRequest(endpoint, path, query, source, signal) {
    const url = uploaderUrl(endpoint, path, query)
    const deadline = AbortSignal.timeout(uploadTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    let stream
    try {
      await validatePublicUrl(url.href)
      const headers = { 'content-type': source.mime, 'content-length': String(source.sizeBytes) }
      stream = source.stream({ start: source.start, end: source.end })
      const response = await fetchImpl(url, { method: 'POST', headers, body: stream, duplex: 'half', redirect: 'error', signal: requestSignal })
      let data
      try { data = await response.json() } catch { throw fail('upload', 'INVALID_RESPONSE', '快手未确认视频分片上传') }
      if (!response.ok || data?.result !== 1) throw fail('upload', 'REQUEST_FAILED', `快手视频上传未确认成功（HTTP ${response.status}）`, 'failed')
      return data
    } catch (error) {
      if (error instanceof PublishError) throw error
      throw fail('upload', 'NO_RESPONSE', '未收到可确认的快手视频上传响应', 'failed')
    } finally {
      if (stream instanceof Readable) stream.destroy()
    }
  }

  return Object.freeze({
    openId,
    credentialId: accessToken => credentialId(openId, accessToken),
    async account(accessToken, signal) {
      const data = await jsonRequest('/openapi/user_info', { accessToken, signal, stage: 'account' })
      const info = data.user_info
      if (!info || typeof info.name !== 'string' || !info.name.trim()) throw fail('account', 'INVALID_ACCOUNT', '快手未返回有效的授权账号信息', 'failed')
      return { id: credentialId(openId, accessToken), name: info.name.trim() }
    },
    async startUpload(accessToken, signal) {
      const data = await jsonRequest('/openapi/photo/start_upload', { accessToken, method: 'POST', signal, stage: 'upload_init' })
      if (typeof data.upload_token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.upload_token) || typeof data.endpoint !== 'string') throw fail('upload_init', 'INVALID_RESPONSE', '快手未返回有效的视频上传凭据', 'failed')
      uploaderUrl(data.endpoint, '/api/upload/fragment', { upload_token: data.upload_token, fragment_id: '0' })
      return { uploadToken: data.upload_token, endpoint: data.endpoint }
    },
    async uploadFragment(endpoint, uploadToken, fragmentId, video, start, end, signal) {
      if (!Number.isSafeInteger(fragmentId) || fragmentId < 0 || !KUAISHOU_VIDEO_MIME.has(video?.mime) || !Number.isSafeInteger(video?.sizeBytes) || video.sizeBytes > KUAISHOU_VIDEO_BYTES || start < 0 || end < start || end >= video.sizeBytes) throw fail('upload', 'INVALID_MEDIA', '快手视频分片参数无效', 'failed')
      const sizeBytes = end - start + 1
      return uploaderRequest(endpoint, '/api/upload/fragment', { upload_token: uploadToken, fragment_id: String(fragmentId) }, { ...video, sizeBytes, start, end }, signal)
    },
    async completeUpload(endpoint, uploadToken, fragmentCount, signal) {
      if (!Number.isSafeInteger(fragmentCount) || fragmentCount < 1) throw fail('upload_complete', 'INVALID_FRAGMENT_COUNT', '快手视频分片数量无效', 'failed')
      const url = uploaderUrl(endpoint, '/api/upload/complete', { upload_token: uploadToken, fragment_count: String(fragmentCount) })
      try {
        await validatePublicUrl(url.href)
        const response = await fetchImpl(url, { method: 'POST', headers: { 'content-length': '0' }, body: Readable.from([]), duplex: 'half', redirect: 'error', signal: signal ? AbortSignal.any([AbortSignal.timeout(uploadTimeoutMs), signal]) : AbortSignal.timeout(uploadTimeoutMs) })
        const data = await response.json()
        if (!response.ok || data?.result !== 1) throw fail('upload_complete', 'REQUEST_FAILED', `快手未确认视频分片合并（HTTP ${response.status}）`, 'failed')
      } catch (error) {
        if (error instanceof PublishError) throw error
        throw fail('upload_complete', 'NO_RESPONSE', '未收到可确认的视频合并响应', 'failed')
      }
    },
    async publish(accessToken, uploadToken, caption, cover, signal) {
      if (typeof caption !== 'string' || !caption.trim() || cover?.mime !== 'image/jpeg' || !Number.isSafeInteger(cover?.sizeBytes) || cover.sizeBytes < 1 || cover.sizeBytes >= KUAISHOU_COVER_BYTES || typeof cover.stream !== 'function') throw fail('submit', 'INVALID_MEDIA', '快手发布文案或必选 JPEG 封面无效', 'failed')
      const chunks = []
      let length = 0
      for await (const chunk of cover.stream()) {
        length += chunk.length
        if (length > cover.sizeBytes || length >= KUAISHOU_COVER_BYTES) throw fail('submit', 'INVALID_COVER_SIZE', '快手封面大小发生变化', 'failed')
        chunks.push(chunk)
      }
      if (length !== cover.sizeBytes) throw fail('submit', 'INVALID_COVER_SIZE', '快手封面大小发生变化', 'failed')
      const form = new FormData()
      form.set('caption', caption)
      form.set('cover', new Blob(chunks, { type: cover.mime }), 'cover.jpg')
      const data = await jsonRequest('/openapi/photo/publish', { accessToken, query: { upload_token: uploadToken }, method: 'POST', form, signal, stage: 'submit' })
      const photo = data.video_info
      if (!photo || typeof photo.photo_id !== 'string' || !ID_RE.test(photo.photo_id)) throw fail('submit', 'INVALID_RECEIPT', '快手未返回有效作品回执，请先在创作者中心核对')
      return { photoId: photo.photo_id, pending: photo.pending !== false }
    },
    async videoInfo(accessToken, photoId, signal) {
      if (typeof photoId !== 'string' || !ID_RE.test(photoId)) throw fail('review', 'INVALID_RECEIPT', '快手作品回执无效', 'failed')
      let data
      try {
        data = await jsonRequest('/openapi/photo/info', { accessToken, query: { photo_id: photoId }, signal, stage: 'review' })
      } catch (error) {
        if (error instanceof PublishError && error.code === 'KUAISHOU_REQUEST_FAILED' && error.platformResult === 100120003) return { photoId, failed: true }
        throw error
      }
      const video = data.video_info
      if (!video || video.photo_id !== photoId || typeof video.pending !== 'boolean') throw fail('review', 'INVALID_RESPONSE', '快手未返回可确认的作品状态')
      return { photoId, pending: video.pending }
    },
  })
}
