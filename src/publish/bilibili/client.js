// Adapted from AiToEarn's bilibili.service.ts at 11dd1957 (MIT; see UPSTREAM-LICENSE.txt).
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { PublishError } from '../errors.js'

const ACCOUNT = 'https://account.bilibili.com/pc/account-pc/auth/oauth'
const OAUTH = 'https://api.bilibili.com/x/account-oauth2/v1/'
const MEMBER = 'https://member.bilibili.com/arcopen/fn/'
const UPLOAD = 'https://openupos.bilivideo.com/video/v2/part/upload'
const TOKEN = value => typeof value === 'string' && value.length > 0 && !/[^\x21-\x7e]/.test(value)

export function signedHeaders({ clientId, clientSecret, accessToken, body = '', timestamp, nonce }) {
  const fields = {
    'x-bili-accesskeyid': clientId,
    'x-bili-content-md5': createHash('md5').update(body).digest('hex'),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': nonce,
    'x-bili-signature-version': '2.0',
    'x-bili-timestamp': String(timestamp),
  }
  const payload = Object.entries(fields).map(([key, value]) => `${key}:${value}`).join('\n')
  return { ...fields, accept: 'application/json', 'access-token': accessToken, authorization: createHmac('sha256', clientSecret).update(payload).digest('hex') }
}

export function createBilibiliClient({ clientId, clientSecret, redirectUri }, {
  fetchImpl = globalThis.fetch, now = Date.now, nonce = randomUUID, timeoutMs = 120_000,
} = {}) {
  if (!TOKEN(clientId) || !TOKEN(clientSecret)) throw new PublishError('INVALID_APP', '哔哩哔哩开放平台应用凭据无效')

  async function request(base, { stage, method = 'GET', query, body, headers, signal, stream = false, optionalData = false }) {
    const submit = stage === 'submit'
    const error = (code, message, details = {}) => new PublishError(code, message, {
      stage, outcome: submit ? 'unknown' : 'failed', ...details,
    })
    if (signal?.aborted) {
      if (stream) body.destroy()
      throw error('ABORTED', 'B 站请求已取消', { outcome: 'failed' })
    }
    const url = new URL(base)
    if (query) url.search = new URLSearchParams(query).toString()
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, timeoutMs)
    try {
      let response, result
      try {
        response = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: controller.signal, ...(stream ? { duplex: 'half' } : {}) })
        result = await response.json()
      } catch {
        throw error(controller.signal.aborted ? 'ABORTED' : 'BILIBILI_RESPONSE_UNAVAILABLE', '未收到可确认的 B 站响应')
      }
      const candidate = result?.code
      const code = (typeof candidate === 'number' || typeof candidate === 'string' && /^-?\d+$/.test(candidate)) && Number.isSafeInteger(Number(candidate)) ? Number(candidate) : undefined
      const httpStatus = response.status
      if (code !== undefined && code !== 0) {
        const details = { httpStatus, platformCode: code }
        // Only a known pre-submission permission rejection proves no archive was created.
        const permissionDenied = code === -403 && (response.ok || httpStatus === 403)
        if (submit && !permissionDenied) {
          throw error('BILIBILI_SUBMISSION_UNCONFIRMED', '无法确认 B 站是否已接收稿件，请先核对作品', details)
        }
        if (response.ok || (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408)) {
          throw error('BILIBILI_REJECTED', `B 站拒绝了请求（代码 ${code}）`, { ...details, outcome: 'failed' })
        }
      }
      if (!response.ok || code !== 0 || (!optionalData && result.data == null)) {
        throw error('BILIBILI_INVALID_RESPONSE', 'B 站未返回有效回执', { httpStatus })
      }
      return result.data
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (stream && !body.destroyed) body.destroy()
    }
  }

  function signed(path, { stage, accessToken, json, form, ...options }) {
    if (!TOKEN(accessToken)) throw new PublishError('INVALID_TOKEN', 'B 站账号凭据无效', { stage })
    const body = json === undefined ? '' : JSON.stringify(json)
    const headers = signedHeaders({ clientId, clientSecret, accessToken, body, timestamp: Math.floor(now() / 1000), nonce: nonce() })
    if (!form) headers['content-type'] = 'application/json'
    // fetch sets the multipart boundary. The upstream signs the empty body for multipart.
    return request(MEMBER + path, { stage, ...options, headers, body: form ?? (body || undefined) })
  }

  async function oauth(path, fields, signal) {
    const data = await request(OAUTH + path, {
      stage: 'auth', method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
    })
    const expiresIn = Number(data.expires_in)
    if (!TOKEN(data.access_token) || !TOKEN(data.refresh_token) || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || !Number.isFinite(new Date(now() + expiresIn * 1000).getTime())) {
      throw new PublishError('BILIBILI_INVALID_RESPONSE', 'B 站未返回有效授权凭据', { stage: 'auth' })
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(now() + expiresIn * 1000).toISOString() }
  }

  return Object.freeze({
    authorizationUrl(state) {
      if (!TOKEN(state) || typeof redirectUri !== 'string') throw new PublishError('INVALID_OAUTH', 'B 站授权回调配置无效')
      let redirect
      try { redirect = new URL(redirectUri) } catch { throw new PublishError('INVALID_OAUTH', 'B 站授权回调配置无效') }
      if (redirect.username || redirect.password || redirect.hash || !(redirect.protocol === 'https:' || redirect.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(redirect.hostname))) {
        throw new PublishError('INVALID_OAUTH', 'B 站授权回调配置无效')
      }
      const url = new URL(ACCOUNT)
      url.search = new URLSearchParams({ client_id: clientId, gourl: redirectUri, state }).toString()
      return url.toString()
    },
    exchangeCode(code, signal) {
      if (!TOKEN(code)) throw new PublishError('INVALID_OAUTH', 'B 站授权码无效')
      return oauth('token', { grant_type: 'authorization_code', code }, signal)
    },
    refreshToken(refreshToken, signal) {
      if (!TOKEN(refreshToken)) throw new PublishError('INVALID_TOKEN', 'B 站刷新凭据无效')
      return oauth('refresh_token', { grant_type: 'refresh_token', refresh_token: refreshToken }, signal)
    },
    account: (accessToken, signal) => signed('user/account/info', { stage: 'account', accessToken, signal }),
    categories: (accessToken, signal) => signed('archive/type/list', { stage: 'categories', accessToken, signal }),
    init: (accessToken, filename, signal) => signed('archive/video/init', { stage: 'upload_init', method: 'POST', accessToken, json: { name: filename, utype: '0' }, signal }),
    part: (uploadToken, number, source, start, end, signal) => request(UPLOAD, {
      stage: 'upload_part', method: 'POST', query: { upload_token: uploadToken, part_number: number },
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(end - start + 1) },
      body: source.stream({ start, end }), stream: true, optionalData: true, signal,
    }),
    complete: (accessToken, uploadToken, signal) => signed('archive/video/complete', { stage: 'upload_complete', method: 'POST', accessToken, query: { upload_token: uploadToken }, optionalData: true, signal }),
    cover: (accessToken, form, signal) => signed('archive/cover/upload', { stage: 'cover', method: 'POST', accessToken, form, signal }),
    submit: (accessToken, uploadToken, json, signal) => signed('archive/add-by-utoken', { stage: 'submit', method: 'POST', accessToken, query: { upload_token: uploadToken }, json, signal }),
    detail: (accessToken, receiptId, signal) => signed('archive/view', { stage: 'review', accessToken, query: { resource_id: receiptId }, signal }),
  })
}
