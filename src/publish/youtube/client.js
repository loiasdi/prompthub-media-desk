// Adapted from AiToEarn's youtube.service.ts at 11dd1957 (MIT; see UPSTREAM-LICENSE.txt).
import { createHash } from 'node:crypto'
import { PublishError } from '../errors.js'

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/youtube/v3/'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos'
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
const isToken = value => typeof value === 'string' && value.length > 0 && !/[^\x21-\x7e]/.test(value)
const isVerifier = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value)
const invalidOAuth = () => new PublishError('INVALID_YOUTUBE_OAUTH', 'YouTube OAuth 配置、授权码或 PKCE 参数无效', { stage: 'auth' })

function callbackUri(value) {
  let url
  try { url = new URL(value) } catch { throw invalidOAuth() }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) throw invalidOAuth()
  return url.href
}

function uploadLocation(value) {
  let url
  try { url = new URL(value) } catch { return null }
  // Only the documented API's upload endpoint may receive an access token and media bytes.
  const endpoint = new URL(UPLOAD)
  if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || url.hash) return null
  const ids = url.searchParams.getAll('upload_id')
  return ids.length === 1 && isToken(ids[0]) ? url : null
}

async function isExpiredUploadSession(response) {
  // The upload protocol documents 404 for expiry. A generic 404 is not enough
  // to distinguish an invalid session from a gateway or routing error.
  try {
    const { error } = await response.json()
    return error?.code === 404 && typeof error.message === 'string'
      && /^(?:the )?upload session (?:(?:was )?not found|(?:(?:has )?expired|is expired))\.?$/i.test(error.message.trim())
  } catch {
    return false
  }
}

export function createYouTubeClient({ clientId, clientSecret, redirectUri }, {
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 30_000, uploadTimeoutMs = 20 * 60_000,
} = {}) {
  if (!isToken(clientId) || (clientSecret !== undefined && !isToken(clientSecret))) throw invalidOAuth()
  const redirect = callbackUri(redirectUri)
  if (![timeoutMs, uploadTimeoutMs].every(value => Number.isInteger(value) && value >= 1 && value <= 2_147_483_647)) throw new TypeError('Invalid YouTube request timeout')

  async function request(url, { stage, signal, method = 'GET', accessToken, headers, body, stream, readLocation } = {}) {
    const submit = stage === 'submit'
    const requestError = (code, message, details) => new PublishError(code, message, {
      stage, outcome: stage === 'review' ? 'unknown' : 'failed', ...details,
    })
    if (signal?.aborted) throw requestError('ABORTED', 'YouTube 请求已取消')
    if (accessToken !== undefined) {
      if (!isToken(accessToken)) throw requestError('INVALID_TOKEN', 'YouTube 账号凭据无效')
      headers = { ...headers, authorization: `Bearer ${accessToken}` }
    } else if (stage !== 'auth') {
      throw requestError('INVALID_TOKEN', 'YouTube 账号凭据无效')
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, submit ? uploadTimeoutMs : timeoutMs)
    let httpStatus, media
    const unconfirmed = () => requestError('YOUTUBE_SUBMISSION_UNCONFIRMED', '无法确认 YouTube 是否已接收视频，请先在 YouTube Studio 核对', { outcome: 'unknown', httpStatus })
    try {
      if (stream) {
        try { media = stream() } catch { throw requestError('INVALID_LOCAL_MEDIA', '无法读取本地发布素材') }
      }
      let response
      try {
        response = await fetchImpl(url, { method, headers, body: media ?? body, redirect: 'error', signal: controller.signal, ...(stream && { duplex: 'half' }) })
        httpStatus = response.status
      } catch {
        if (submit) throw unconfirmed()
        throw requestError(controller.signal.aborted ? 'ABORTED' : 'YOUTUBE_RESPONSE_UNAVAILABLE', '未收到可确认的 YouTube 响应')
      }
      if (!response.ok) {
        // submit() only sends the first PUT to a newly initialized session, never to a reused one.
        if (submit && httpStatus === 404) {
          if (await isExpiredUploadSession(response)) {
            throw requestError('YOUTUBE_UPLOAD_SESSION_EXPIRED', 'YouTube 上传会话已失效，本次上传未完成', { httpStatus })
          }
        } else {
          void response.body?.cancel().catch(() => {})
        }
        if (submit) throw unconfirmed()
        throw requestError('YOUTUBE_REQUEST_FAILED', `YouTube 请求未成功（HTTP ${httpStatus}）`, { httpStatus })
      }
      if (readLocation) {
        const location = uploadLocation(response.headers.get('location'))
        void response.body?.cancel().catch(() => {})
        if (location) return location
      } else {
        let data
        try { data = await response.json() } catch { /* Raw response is never included in an error. */ }
        if (data && typeof data === 'object' && !Array.isArray(data) && !data.error) return data
      }
      if (submit) throw unconfirmed()
      throw requestError('YOUTUBE_INVALID_RESPONSE', 'YouTube 未返回有效回执', { httpStatus })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      media?.destroy()
    }
  }

  function api(path, stage, accessToken, query, signal) {
    const url = new URL(API + path)
    url.search = new URLSearchParams(query).toString()
    return request(url, { stage, accessToken, signal })
  }

  async function oauth(fields, signal, savedRefreshToken) {
    const data = await request(new URL(TOKEN), {
      stage: 'auth', method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...(clientSecret !== undefined && { client_secret: clientSecret }), ...fields }),
    })
    const refreshToken = data.refresh_token ?? savedRefreshToken
    const expiresAt = new Date(now() + data.expires_in * 1000)
    if (!isToken(data.access_token) || !isToken(refreshToken) || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || !Number.isFinite(expiresAt.getTime())) {
      throw new PublishError('YOUTUBE_INVALID_RESPONSE', 'YouTube 未返回有效授权凭据', { stage: 'auth' })
    }
    if (!savedRefreshToken || data.scope !== undefined) {
      const granted = typeof data.scope === 'string' ? data.scope.split(/\s+/) : []
      if (!SCOPES.every(scope => granted.includes(scope))) throw new PublishError('YOUTUBE_INSUFFICIENT_SCOPE', 'YouTube 未授予所需的上传和查询权限', { stage: 'auth' })
    }
    return { accessToken: data.access_token, refreshToken, expiresAt: expiresAt.toISOString() }
  }

  return Object.freeze({
    authorizationUrl(state, { codeVerifier } = {}) {
      if (!isToken(state) || !isVerifier(codeVerifier)) throw invalidOAuth()
      const url = new URL(AUTH)
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
        state, access_type: 'offline', prompt: 'consent',
        code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },
    exchangeCode(code, { codeVerifier, signal } = {}) {
      if (!isToken(code) || !isVerifier(codeVerifier)) throw invalidOAuth()
      return oauth({ grant_type: 'authorization_code', redirect_uri: redirect, code, code_verifier: codeVerifier }, signal)
    },
    refreshToken(refreshToken, signal) {
      if (!isToken(refreshToken)) throw new PublishError('INVALID_TOKEN', 'YouTube 刷新凭据无效', { stage: 'auth' })
      return oauth({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal, refreshToken)
    },
    channels: (accessToken, signal) => api('channels', 'account', accessToken, { part: 'snippet', mine: 'true', maxResults: '2' }, signal),
    categories: (accessToken, filter, signal) => api('videoCategories', 'categories', accessToken, { part: 'snippet', ...filter }, signal),
    detail: (accessToken, id, signal) => api('videos', 'review', accessToken, { part: 'snippet,status', id }, signal),
    init(accessToken, video, metadata, notifySubscribers, signal) {
      const url = new URL(UPLOAD)
      url.search = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: String(notifySubscribers) }).toString()
      return request(url, {
        stage: 'upload_init', method: 'POST', accessToken, signal, readLocation: true, body: JSON.stringify(metadata),
        headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': video.mime, 'x-upload-content-length': String(video.sizeBytes) },
      })
    },
    submit: (accessToken, location, video, signal) => request(location, {
      stage: 'submit', method: 'PUT', accessToken, signal, stream: () => video.stream(),
      headers: { 'content-type': video.mime, 'content-length': String(video.sizeBytes) },
    }),
  })
}
