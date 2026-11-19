import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { PublishError } from '../errors.js'
import { weChatImageUrl } from './links.js'
import { WECHAT_BODY_IMAGE_BYTES } from '../media-rules.js'

export const validWeChatMediaId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
export const validWeChatPublishId = value => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)
const problem = (stage, code, message, details) => new PublishError(`WECHAT_${code}`, message, { stage, outcome: ['submit', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })

export function createWeChatClient({ clientId: appId, clientSecret }, { fetchImpl = fetch, timeoutMs = 30_000, now = Date.now } = {}) {
  if (typeof appId !== 'string' || !/^wx[a-z0-9]{16}$/.test(appId) || typeof clientSecret !== 'string' || !/^[A-Za-z0-9]{32}$/.test(clientSecret)) throw new TypeError('Invalid WeChat app credentials')
  let token, pendingToken
  async function request(path, stage, { method = 'POST', json, media, accessToken, signal, query } = {}) {
    const url = new URL('/cgi-bin/' + path, 'https://api.weixin.qq.com')
    if (accessToken) url.searchParams.set('access_token', accessToken)
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value)
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw problem(stage, 'ABORTED', '微信请求已取消', { outcome: 'failed' })
    let response, data
    try {
      response = await fetchImpl(url, { method, headers: media?.headers || (json !== undefined ? { 'content-type': 'application/json; charset=UTF-8' } : {}), body: media?.body || (json === undefined ? undefined : JSON.stringify(json)), redirect: 'error', signal: requestSignal, ...(media && { duplex: 'half' }) })
      data = await response.json()
    } catch { throw problem(stage, 'NO_RESPONSE', '未收到可确认的微信公众号响应，请先核对投稿记录') }
    finally { media?.body.destroy() }
    if ([200, 201].includes(response.status) && data && typeof data === 'object' && !Array.isArray(data) && (data.errcode === undefined || data.errcode === 0)) return data
    if ([40014, 42001].includes(data?.errcode)) token = undefined
    const rejected = stage === 'submit' && !data?.publish_id && [200, 400, 401, 403, 404, 422].includes(response.status) && Number.isInteger(data?.errcode) && data.errcode > 0
    throw problem(stage, 'REQUEST_FAILED', `微信公众号未确认请求成功（HTTP ${response.status}）`, { httpStatus: response.status, ...(rejected && { outcome: 'failed' }) })
  }
  async function accessToken(signal) {
    if (token && token.expiresAt > now()) return token.value
    if (!pendingToken) pendingToken = (async () => {
      const data = await request('stable_token', 'account', { json: { grant_type: 'client_credential', appid: appId, secret: clientSecret, force_refresh: false }, signal })
      if (typeof data.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(data.access_token) || !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 7200) throw problem('account', 'INVALID_TOKEN', '微信未返回有效的公众号后台令牌')
      token = { value: data.access_token, expiresAt: now() + (data.expires_in - Math.min(300, data.expires_in / 10)) * 1000 }
      return token.value
    })().finally(() => { pendingToken = undefined })
    return pendingToken
  }
  async function authorized(path, stage, options) { return request(path, stage, { ...options, accessToken: await accessToken(options?.signal) }) }
  return Object.freeze({
    appId,
    async account(_unused, signal) {
      const data = await authorized('material/get_materialcount', 'account', { method: 'GET', signal })
      if (!['image_count', 'news_count', 'voice_count', 'video_count'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)) throw problem('account', 'INVALID_ACCOUNT', '微信未确认该 AppID 的公众号素材读取权限')
      return { id: appId, name: `微信公众号 (${appId})` }
    },
    async cover(source, signal) {
      const boundary = `media-desk-${randomUUID()}`
      const extension = source.mime === 'image/png' ? 'png' : 'jpg'
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="cover.${extension}"\r\nContent-Type: ${source.mime}\r\n\r\n`)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      const body = Readable.from((async function* () { yield prefix; yield* source.stream(); yield suffix })(), { objectMode: false })
      let data
      try { data = await authorized('material/add_material', 'upload', { media: { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + source.sizeBytes + suffix.length) } }, query: { type: 'image' }, signal }) }
      finally { body.destroy() }
      if (!validWeChatMediaId(data.media_id)) throw problem('upload', 'INVALID_COVER', '微信未返回有效的永久封面素材标识')
      return data.media_id
    },
    async draft(article, signal) {
      const data = await authorized('draft/add', 'initialize', { json: { articles: [article] }, signal })
      if (!validWeChatMediaId(data.media_id)) throw problem('initialize', 'INVALID_DRAFT', '微信未返回有效的草稿回执，未发送发表请求')
      return data.media_id
    },
    // AiToEarn's uploadImage flow, with local streaming instead of a cloud URL.
    async image(source, signal) {
      const boundary = `media-desk-${randomUUID()}`
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg' }[source.mime]
      if (!extension || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0 || source.sizeBytes >= WECHAT_BODY_IMAGE_BYTES) throw problem('upload', 'INVALID_IMAGE', '公众号正文配图须为小于 1 MB 的本地 JPEG 或 PNG')
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="image.${extension}"\r\nContent-Type: ${source.mime}\r\n\r\n`)
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
      const stream = source.stream()
      const body = Readable.from((async function* () { yield prefix; yield* stream; yield suffix })(), { objectMode: false })
      let data
      try { data = await authorized('media/uploadimg', 'upload', { media: { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + source.sizeBytes + suffix.length) } }, signal }) }
      finally { body.destroy(); stream.destroy() }
      const url = weChatImageUrl(data.url)
      if (!url) throw problem('upload', 'INVALID_IMAGE_URL', '微信未返回可信的正文图片地址，未创建文章草稿')
      return url
    },
    async publish(mediaId, signal) {
      const data = await authorized('freepublish/submit', 'submit', { json: { media_id: mediaId }, signal })
      if (!validWeChatPublishId(data.publish_id)) throw problem('submit', 'INVALID_RECEIPT', '微信未返回可确认的发表回执，请到公众平台核对')
      return data.publish_id
    },
    async status(receiptId, signal) {
      if (!validWeChatPublishId(receiptId)) throw problem('review', 'INVALID_RECEIPT', '微信公众号发表回执无效')
      const data = await authorized('freepublish/get', 'review', { json: { publish_id: receiptId }, signal })
      if (data.publish_id !== receiptId || !Number.isInteger(data.publish_status) || data.publish_status < 0 || data.publish_status > 6) throw problem('review', 'INVALID_STATE', '微信未返回可确认的发表状态')
      return data
    },
  })
}
