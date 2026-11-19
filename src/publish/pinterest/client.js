import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { PublishError } from '../errors.js'

export const validPinterestId = value => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)
const problem = (stage, code, message, details) => new PublishError(`PINTEREST_${code}`, message, { stage, outcome: ['submit', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })
const uploadFields = new Set(['Content-Type', 'key', 'policy', 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-security-token', 'x-amz-signature'])
const requiredFields = ['key', 'policy', 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-signature']

function uploadTarget(value) {
  try {
    const url = new URL(value)
    if (url.origin === 'https://pinterest-media-upload.s3-accelerate.amazonaws.com' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) return url
  } catch {}
  throw problem('initialize', 'UNSAFE_UPLOAD', 'Pinterest 未返回可信的官方视频上传地址')
}

function multipart(source, parameters) {
  const boundary = `media-desk-${randomUUID()}`
  const fields = Object.entries(parameters).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('')
  const extension = source.mime === 'video/quicktime' ? 'mov' : 'mp4'
  const prefix = Buffer.from(`${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.${extension}"\r\nContent-Type: ${source.mime}\r\n\r\n`)
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    body: Readable.from((async function* () { yield prefix; yield* source.stream(); yield suffix })(), { objectMode: false }),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + source.sizeBytes + suffix.length) },
  }
}

export function createPinterestClient({ userId }, { fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 5 * 60_000 } = {}) {
  if (!validPinterestId(userId)) throw new TypeError('Invalid Pinterest account ID')
  async function request(path, stage, accessToken, { method = 'GET', json, signal } = {}) {
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) throw problem(stage, 'INVALID_TOKEN', 'Pinterest 授权令牌无效', { outcome: 'failed' })
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw problem(stage, 'ABORTED', 'Pinterest 请求已取消', { outcome: 'failed' })
    let response, payload
    try {
      response = await fetchImpl(new URL('/v5' + path, 'https://api.pinterest.com'), { method, headers: { authorization: `Bearer ${accessToken}`, ...(json !== undefined && { 'content-type': 'application/json' }) }, body: json === undefined ? undefined : JSON.stringify(json), signal: requestSignal, redirect: 'error' })
      payload = await response.json()
    } catch { throw problem(stage, 'NO_RESPONSE', '未收到可确认的 Pinterest 响应') }
    if (response.ok && (stage !== 'submit' || [200, 201].includes(response.status)) && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.code === undefined && payload.errors === undefined) return payload
    const rejected = stage === 'submit' && !payload?.id && [400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)
    throw problem(stage, 'REQUEST_FAILED', `Pinterest 未确认请求成功（HTTP ${response.status}）`, { httpStatus: response.status, ...(rejected && { outcome: 'failed' }) })
  }
  function boardValid(board, username, id) {
    return validPinterestId(board?.id) && (!id || board.id === id) && typeof board.name === 'string' && board.name.trim() && board.privacy === 'PUBLIC' && board.is_ads_only !== true && typeof board.owner?.username === 'string' && board.owner.username.toLowerCase() === username.toLowerCase()
  }
  return Object.freeze({
    userId,
    async account(accessToken, signal) {
      const data = await request('/user_account', 'account', accessToken, { signal })
      if (data.id !== userId || typeof data.username !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(data.username)) throw problem('account', 'ACCOUNT_MISMATCH', 'Pinterest 令牌与配置账号不一致，或未返回有效账号')
      return { id: userId, name: typeof data.business_name === 'string' && data.business_name.trim() ? `${data.business_name} (@${data.username})` : `@${data.username}`, username: data.username }
    },
    async boards(accessToken, signal) {
      const { username } = await this.account(accessToken, signal)
      const rows = []
      const seen = new Set()
      let bookmark
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ page_size: '100', privacy: 'PUBLIC', ...(bookmark && { bookmark }) })
        const data = await request('/boards?' + query, 'boards', accessToken, { signal })
        if (!Array.isArray(data.items) || data.items.length > 100) throw problem('boards', 'INVALID_BOARDS', 'Pinterest 未返回有效的画板列表')
        for (const row of data.items) if (boardValid(row, username) && !rows.some(board => board.id === row.id)) rows.push({ id: row.id, title: row.name })
        if (data.bookmark === undefined || data.bookmark === null || data.bookmark === '') return rows
        if (typeof data.bookmark !== 'string' || data.bookmark.length > 4096 || seen.has(data.bookmark)) throw problem('boards', 'INVALID_BOOKMARK', 'Pinterest 画板列表分页无效，请稍后重试')
        bookmark = data.bookmark
        seen.add(bookmark)
      }
      throw problem('boards', 'TOO_MANY_BOARDS', 'Pinterest 画板列表过长，未完成核对')
    },
    async board(accessToken, id, username, signal) {
      if (!validPinterestId(id)) throw problem('boards', 'INVALID_BOARD', '请选择有效的 Pinterest 画板')
      const data = await request(`/boards/${id}`, 'boards', accessToken, { signal })
      if (!boardValid(data, username, id)) throw problem('boards', 'BOARD_CHANGED', 'Pinterest 画板不是此账号的公开画板，或已变更，请重新检查')
      return data
    },
    async initialize(accessToken, signal) {
      const data = await request('/media', 'initialize', accessToken, { method: 'POST', json: { media_type: 'video' }, signal })
      const parameters = data.upload_parameters
      if (!validPinterestId(data.media_id) || data.media_type !== 'video' || !parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
          Object.entries(parameters).some(([key, value]) => !uploadFields.has(key) || typeof value !== 'string' || value.length > 32_768 || /[\x00-\x1f\x7f]/.test(value)) || requiredFields.some(key => !Object.hasOwn(parameters, key) || !parameters[key]) || parameters['x-amz-algorithm'] !== 'AWS4-HMAC-SHA256') throw problem('initialize', 'INVALID_SESSION', 'Pinterest 未返回完整的视频上传参数')
      return { id: data.media_id, url: uploadTarget(data.upload_url), parameters }
    },
    async upload(session, source, signal) {
      const url = uploadTarget(session.url?.href)
      const media = multipart(source, session.parameters)
      const deadline = AbortSignal.timeout(uploadTimeoutMs)
      const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
      try {
        let response
        try { response = await fetchImpl(url, { method: 'POST', ...media, signal: requestSignal, redirect: 'error', duplex: 'half' }) }
        catch { throw problem('upload', 'NO_UPLOAD_RESPONSE', 'Pinterest 未确认收到视频，未发送发布请求') }
        if (![200, 201, 204].includes(response.status)) throw problem('upload', 'UPLOAD_FAILED', 'Pinterest 未确认收到视频，未发送发布请求')
      } finally { media.body.destroy() }
    },
    async status(accessToken, id, signal) {
      if (!validPinterestId(id)) throw problem('processing', 'INVALID_MEDIA', 'Pinterest 视频标识无效')
      const data = await request(`/media/${id}`, 'processing', accessToken, { signal })
      if (data.media_id !== id || data.media_type !== 'video') throw problem('processing', 'INVALID_MEDIA', 'Pinterest 未确认该视频的处理状态')
      return data.status
    },
    async create(accessToken, body, signal) {
      const data = await request('/pins', 'submit', accessToken, { method: 'POST', json: body, signal })
      if (!validPinterestId(data.id) || data.board_id !== body.board_id) throw problem('submit', 'INVALID_RECEIPT', 'Pinterest 未返回可确认的 Pin 回执，请到 Pinterest 核对')
      return data.id
    },
    async pin(accessToken, id, signal, imageCount = 0) {
      if (!validPinterestId(id)) throw problem('review', 'INVALID_RECEIPT', 'Pinterest Pin 回执无效')
      const data = await request(`/pins/${id}`, 'review', accessToken, { signal })
      const mediaType = imageCount === 0 ? 'video' : imageCount === 1 ? 'image' : 'multiple_images'
      if (data.id !== id || data.is_owner !== true || data.media?.media_type !== mediaType) throw problem('review', 'PIN_MISMATCH', 'Pinterest 未确认该 Pin 类型或所属账号与原投稿一致')
      return data
    },
  })
}
