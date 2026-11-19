import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { PublishError } from './errors.js'

const GRAPH = 'https://graph.facebook.com'
const RUPLOAD = 'https://rupload.facebook.com'
export const isGraphId = value => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)
export const validGraphVersion = value => typeof value === 'string' && /^v[1-9]\d?\.0$/.test(value)

// A token accompanies the bytes. Accept only the exact documented URL for this
// upload type, Graph version and ID; never follow redirects or change hosts.
export function metaUploadTarget(value, kind, version, id, allowUnversioned = false) {
  if (!isGraphId(id)) return null
  const base = `${RUPLOAD}/${kind}/`
  if (value !== `${base}${version}/${id}` && (!allowUnversioned || value !== `${base}${id}`)) return null
  return new URL(value)
}

export function createMetaTransport(name, version, { fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 25 * 60_000 } = {}) {
  async function request(url, { accessToken, stage, method = 'GET', form, source, photo, signal }) {
    const outcome = stage === 'submit' || stage === 'review' ? 'unknown' : 'failed'
    const error = (code, message, details) => new PublishError(`${name.toUpperCase()}_${code}`, `${name} ${message}`, { stage, outcome, ...details })
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) throw error('INVALID_TOKEN', '访问令牌无效')
    const deadline = AbortSignal.timeout(source || photo ? uploadTimeoutMs : timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    if (requestSignal.aborted) throw error('ABORTED', '请求已取消')
    const headers = { authorization: `${source ? 'OAuth' : 'Bearer'} ${accessToken}` }
    let media, photoStream
    try {
      if (photo) {
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png' }[photo.mime]
        if (!extension || !Number.isSafeInteger(photo.sizeBytes) || photo.sizeBytes <= 0) throw error('INVALID_PHOTO', '本地图片无效')
        const boundary = `media-desk-${randomUUID()}`
        // Unlike rupload, Graph photo uploads use Bearer auth and multipart.
        // Unpublished media must never become a separate public photo post.
        const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="published"\r\n\r\nfalse\r\n--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="image.${extension}"\r\nContent-Type: ${photo.mime}\r\n\r\n`)
        const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
        Object.assign(headers, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + photo.sizeBytes + suffix.length) })
        photoStream = photo.stream()
        media = Readable.from((async function* () { yield prefix; yield* photoStream; yield suffix })(), { objectMode: false })
      } else if (source) {
        const size = String(source.sizeBytes)
        Object.assign(headers, { 'content-type': 'application/octet-stream', 'content-length': size, offset: '0', file_size: size })
        media = source.stream()
      }
      let response, data
      try {
        response = await fetchImpl(url, { method, headers, body: media || form, redirect: 'error', signal: requestSignal, ...(media && { duplex: 'half' }) })
        data = await response.json()
      } catch {
        throw error('RESPONSE_UNAVAILABLE', '未返回可确认的响应')
      }
      if (!response.ok || data?.error) throw error('REQUEST_FAILED', `请求未成功（HTTP ${response.status}）`, { httpStatus: response.status })
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('INVALID_RESPONSE', '未返回有效回执')
      return data
    } finally { media?.destroy(); photoStream?.destroy() }
  }
  function graph(path) { return new URL(`${GRAPH}/${version}/${path}`) }
  return Object.freeze({
    get(path, fields, accessToken, stage, signal) {
      const url = graph(path)
      if (fields) url.searchParams.set('fields', fields)
      return request(url, { accessToken, stage, signal })
    },
    post(path, fields, accessToken, stage, signal) {
      return request(graph(path), { accessToken, stage, method: 'POST', form: new URLSearchParams(fields), signal })
    },
    upload(url, source, accessToken, signal) {
      return request(url, { accessToken, stage: 'upload', method: 'POST', source, signal })
    },
    postPhoto(path, photo, accessToken, signal) {
      return request(graph(path), { accessToken, stage: 'upload', method: 'POST', photo, signal })
    },
  })
}
