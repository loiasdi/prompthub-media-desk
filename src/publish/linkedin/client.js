import { PublishError } from '../errors.js'

export const DEFAULT_LINKEDIN_VERSION = '202611'
export const validMemberId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
export const validVideoUrn = value => typeof value === 'string' && /^urn:li:video:[A-Za-z0-9_-]{1,200}$/.test(value)
export const validImageUrn = value => typeof value === 'string' && /^urn:li:image:[A-Za-z0-9_-]{1,200}$/.test(value)
export const validPostUrn = value => typeof value === 'string' && /^urn:li:(?:share|ugcPost):[1-9]\d{0,31}$/.test(value)
const tokenValid = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value)
const error = (stage, code, message, details) => new PublishError(`LINKEDIN_${code}`, message, { stage, outcome: ['submit', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })

function uploadTarget(value) {
  try {
    const url = new URL(value)
    if (url.origin === 'https://www.linkedin.com' && !url.username && !url.password && !url.hash && /^\/dms-uploads\/[A-Za-z0-9_./-]+$/.test(url.pathname)) return url
  } catch {}
  throw error('upload', 'UNSAFE_TARGET', 'LinkedIn 未返回可信的官方素材上传地址')
}

export function createLinkedInClient({ memberId, apiVersion = DEFAULT_LINKEDIN_VERSION }, { fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 3 * 60_000 } = {}) {
  if (!validMemberId(memberId) || typeof apiVersion !== 'string' || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(apiVersion)) throw new TypeError('Invalid LinkedIn configuration')
  const owner = `urn:li:person:${memberId}`
  async function request(url, stage, { accessToken, json, body, headers = {}, signal, method = 'GET', upload = false } = {}) {
    if (!upload && !tokenValid(accessToken)) throw error(stage, 'TOKEN_INVALID', 'LinkedIn 授权令牌无效', { outcome: 'failed' })
    const deadline = AbortSignal.timeout(upload ? uploadTimeoutMs : timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw error(stage, 'ABORTED', 'LinkedIn 请求已取消', { outcome: 'failed' })
    const requestHeaders = { ...headers, ...(!upload && { authorization: `Bearer ${accessToken}` }) }
    if (!upload && url.pathname.startsWith('/rest/')) Object.assign(requestHeaders, { 'Linkedin-Version': apiVersion, 'X-Restli-Protocol-Version': '2.0.0' })
    if (json !== undefined) requestHeaders['content-type'] = 'application/json'
    let response
    try {
      response = await fetchImpl(url, { method, headers: requestHeaders, body: body ?? (json === undefined ? undefined : JSON.stringify(json)), signal: requestSignal, redirect: 'error', ...(body && { duplex: 'half' }) })
    } catch { throw error(stage, 'NO_RESPONSE', '未收到可确认的 LinkedIn 响应') }
    if (!response.ok) {
      const message = stage === 'review' && response.status === 403 ? 'LinkedIn 回查需要额外获批的 r_member_social 权限，请通过帖子链接核对。' : `LinkedIn 未确认请求成功（HTTP ${response.status}）`
      const rejected = stage === 'submit' && [400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)
      throw error(stage, 'REQUEST_FAILED', message, { httpStatus: response.status, ...(rejected && { outcome: 'failed' }) })
    }
    return response
  }
  const api = (path, stage, accessToken, options) => request(new URL(path, 'https://api.linkedin.com'), stage, { ...options, accessToken })
  async function object(response, stage) {
    try {
      const value = await response.json()
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
    throw error(stage, 'INVALID_RESPONSE', 'LinkedIn 未返回可确认的数据')
  }
  async function createPost(accessToken, content, commentary, signal) {
    const response = await api('/rest/posts', 'submit', accessToken, { method: 'POST', json: {
      author: owner, commentary, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content && { content }), lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    }, signal })
    const id = response.headers.get('x-restli-id')
    if (response.status !== 201 || !validPostUrn(id)) throw error('submit', 'INVALID_RECEIPT', 'LinkedIn 未返回可确认的帖子回执，请到 LinkedIn 核对')
    return id
  }
  return Object.freeze({
    owner,
    async account(accessToken, signal) {
      const data = await object(await api('/v2/userinfo', 'account', accessToken, { signal }), 'account')
      const name = data.name || [data.given_name, data.family_name].filter(value => typeof value === 'string').join(' ')
      if (data.sub !== memberId || typeof name !== 'string' || !name.trim()) throw error('account', 'ACCOUNT_MISMATCH', 'LinkedIn 令牌与配置的个人账号不一致，或未返回有效账号')
      return { id: owner, name }
    },
    async initialize(accessToken, sizeBytes, signal) {
      const data = await object(await api('/rest/videos?action=initializeUpload', 'initialize', accessToken, { method: 'POST', json: { initializeUploadRequest: { owner, fileSizeBytes: sizeBytes, uploadCaptions: false, uploadThumbnail: false } }, signal }), 'initialize')
      const session = data.value
      if (!validVideoUrn(session?.video) || typeof session.uploadToken !== 'string' || session.uploadToken.length > 16_384 || !Array.isArray(session.uploadInstructions) || !session.uploadInstructions.length || session.uploadInstructions.length > 1024) throw error('initialize', 'INVALID_SESSION', 'LinkedIn 未返回完整的分片上传信息')
      if (session.uploadUrlsExpireAt !== undefined && (!Number.isSafeInteger(session.uploadUrlsExpireAt) || session.uploadUrlsExpireAt <= Date.now())) throw error('initialize', 'SESSION_EXPIRED', 'LinkedIn 视频上传地址已过期')
      let offset = 0
      const parts = session.uploadInstructions.map(part => {
        if (!Number.isSafeInteger(part?.firstByte) || !Number.isSafeInteger(part.lastByte) || part.firstByte !== offset || part.lastByte < part.firstByte || part.lastByte >= sizeBytes) throw error('initialize', 'INVALID_RANGES', 'LinkedIn 分片范围不完整，未上传素材')
        const url = uploadTarget(part.uploadUrl)
        offset = part.lastByte + 1
        return { firstByte: part.firstByte, lastByte: part.lastByte, url }
      })
      if (offset !== sizeBytes) throw error('initialize', 'INVALID_RANGES', 'LinkedIn 分片范围不完整，未上传素材')
      return { video: session.video, uploadToken: session.uploadToken, parts }
    },
    async upload(part, source, signal) {
      const url = uploadTarget(part.url?.href)
      const stream = source.stream({ start: part.firstByte, end: part.lastByte })
      try {
        const response = await request(url, 'upload', { upload: true, method: 'PUT', body: stream, headers: { 'content-type': 'application/octet-stream', 'content-length': String(part.lastByte - part.firstByte + 1) }, signal })
        const raw = response.headers.get('etag')
        const etag = raw?.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
        if (!etag || etag.length > 16_384 || /[\x00-\x20\x7f"]/u.test(etag)) throw error('upload', 'MISSING_ETAG', 'LinkedIn 未确认收到完整分片，未发送发布请求')
        return etag
      } finally { stream.destroy() }
    },
    async finalize(accessToken, session, uploadedPartIds, signal) {
      await api('/rest/videos?action=finalizeUpload', 'finalize', accessToken, { method: 'POST', json: { finalizeUploadRequest: { video: session.video, uploadToken: session.uploadToken, uploadedPartIds } }, signal })
    },
    async videoStatus(accessToken, video, signal) {
      if (!validVideoUrn(video)) throw error('processing', 'INVALID_VIDEO', 'LinkedIn 视频标识无效')
      const data = await object(await api(`/rest/videos/${encodeURIComponent(video)}`, 'processing', accessToken, { signal }), 'processing')
      if (data.id !== video || data.owner !== owner) throw error('processing', 'VIDEO_MISMATCH', 'LinkedIn 未确认视频归属，未发送发布请求')
      return data.status
    },
    async initializeImage(accessToken, signal) {
      const data = await object(await api('/rest/images?action=initializeUpload', 'initialize', accessToken, { method: 'POST', json: { initializeUploadRequest: { owner } }, signal }), 'initialize')
      const session = data.value
      if (!validImageUrn(session?.image) || !Number.isSafeInteger(session.uploadUrlExpiresAt) || session.uploadUrlExpiresAt <= Date.now()) throw error('initialize', 'INVALID_IMAGE_SESSION', 'LinkedIn 未返回有效的图片上传信息')
      return { image: session.image, url: uploadTarget(session.uploadUrl) }
    },
    async uploadImage(accessToken, session, source, signal) {
      if (!validImageUrn(session.image)) throw error('upload', 'INVALID_IMAGE', 'LinkedIn 图片标识无效')
      if (!tokenValid(accessToken)) throw error('upload', 'TOKEN_INVALID', 'LinkedIn 授权令牌无效')
      const url = uploadTarget(session.url?.href)
      const stream = source.stream()
      try {
        // Official image upload instructions require OAuth; video upload does not.
        // The upload target is pinned to LinkedIn and redirects remain disabled.
        await request(url, 'upload', { upload: true, method: 'PUT', body: stream, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/octet-stream', 'content-length': String(source.sizeBytes) }, signal })
      } finally { stream.destroy() }
    },
    create: (accessToken, video, commentary, signal) => createPost(accessToken, { media: { id: video } }, commentary, signal),
    createText: (accessToken, commentary, signal) => createPost(accessToken, undefined, commentary, signal),
    createImages(accessToken, images, commentary, signal) {
      if (!Array.isArray(images) || images.length < 1 || images.length > 20 || !images.every(validImageUrn) || new Set(images).size !== images.length) throw error('submit', 'INVALID_IMAGES', 'LinkedIn 图片标识无效或重复', { outcome: 'failed' })
      const content = images.length === 1 ? { media: { id: images[0] } } : { multiImage: { images: images.map(id => ({ id })) } }
      return createPost(accessToken, content, commentary, signal)
    },
    async post(accessToken, receiptId, signal) {
      if (!validPostUrn(receiptId)) throw error('review', 'INVALID_RECEIPT', 'LinkedIn 帖子回执无效')
      const data = await object(await api(`/rest/posts/${encodeURIComponent(receiptId)}?viewContext=AUTHOR`, 'review', accessToken, { signal }), 'review')
      if (data.id !== receiptId || data.author !== owner) throw error('review', 'POST_MISMATCH', 'LinkedIn 未确认该帖子属于原投稿账号')
      return data
    },
  })
}
