import { randomInt } from 'node:crypto'
import { Readable } from 'node:stream'
import { assertPublicUrl } from '../../harvest.js'
import { PublishError } from '../errors.js'
import { blueskyCaption, blueskyFacets } from '../draft-copy.js'

const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,200}$/
const HANDLE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const TID_CHARS = '234567abcdefghijklmnopqrstuvwxyz'
const POST_COLLECTION = 'app.bsky.feed.post'
const invalid = stage => new PublishError(`BLUESKY_INVALID_${stage.toUpperCase()}`, 'Bluesky 账号或投稿信息无效', { stage, outcome: 'failed' })

export function validBlueskyDid(value) { return typeof value === 'string' && DID_RE.test(value) }
export function validBlueskyHandle(value) { return typeof value === 'string' && HANDLE_RE.test(value) }

export function createBlueskyRecordKey(now = Date.now(), clockId = randomInt(1024)) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(clockId) || clockId < 0 || clockId > 1023) throw new TypeError('Invalid Bluesky TID input')
  let value = (BigInt(now * 1000) << 10n) | BigInt(clockId)
  let result = ''
  for (let i = 0; i < 13; i++) { result = TID_CHARS[Number(value & 31n)] + result; value >>= 5n }
  return result
}

function sanitizePds(raw) {
  let url
  try { url = new URL(raw || 'https://bsky.social') } catch { throw new TypeError('Invalid Bluesky PDS URL') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new TypeError('Invalid Bluesky PDS URL')
  return url.origin
}

export function createBlueskyClient({ did, handle, appPassword, pdsUrl = 'https://bsky.social' }, {
  fetchImpl = fetch, validatePds = assertPublicUrl, timeoutMs = 30_000, uploadTimeoutMs = 3 * 60_000,
} = {}) {
  if (!validBlueskyDid(did) || !validBlueskyHandle(handle) || typeof appPassword !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(appPassword)) throw new TypeError('Invalid Bluesky account configuration')
  const host = sanitizePds(pdsUrl)
  function endpoint(method) { return new URL(`/xrpc/${method}`, host) }
  async function request(method, { accessJwt, json, source, query, signal, stage }) {
    const headers = {}
    if (accessJwt) headers.authorization = `Bearer ${accessJwt}`
    let body, stream
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json) }
    if (source) {
      if (!['image/jpeg', 'image/png'].includes(source.mime) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 2_000_000 || typeof source.stream !== 'function') throw invalid('upload')
      headers['content-type'] = source.mime
      headers['content-length'] = String(source.sizeBytes)
      stream = source.stream()
      body = stream
    }
    const url = endpoint(method)
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value)
    const deadline = AbortSignal.timeout(source ? uploadTimeoutMs : timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    try {
      await validatePds(`${host}/`)
      const response = await fetchImpl(url, { method: json !== undefined || source ? 'POST' : 'GET', headers, ...(body !== undefined && { body }), redirect: 'error', signal: requestSignal, ...(stream && { duplex: 'half' }) })
      let data
      try { data = await response.json() } catch { throw new PublishError('BLUESKY_INVALID_RESPONSE', 'Bluesky 未返回可确认的响应', { stage, outcome: 'unknown' }) }
      if (!response.ok) throw new PublishError('BLUESKY_REQUEST_UNCONFIRMED', `Bluesky 请求未确认成功（HTTP ${response.status}）`, { stage, outcome: stage === 'submit' ? 'unknown' : 'failed', httpStatus: response.status })
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PublishError('BLUESKY_INVALID_RESPONSE', 'Bluesky 未返回有效回执', { stage, outcome: 'unknown' })
      return data
    } catch (error) {
      if (error instanceof PublishError) throw error
      throw new PublishError('BLUESKY_NO_RESPONSE', '未收到可确认的 Bluesky 响应', { stage, outcome: stage === 'submit' ? 'unknown' : 'failed' })
    } finally { if (stream instanceof Readable) stream.destroy() }
  }
  async function session(signal) {
    const data = await request('com.atproto.server.createSession', { json: { identifier: handle, password: appPassword }, signal, stage: 'account' })
    if (data.did !== did || !validBlueskyHandle(data.handle) || typeof data.accessJwt !== 'string' || !data.accessJwt) throw new PublishError('BLUESKY_ACCOUNT_MISMATCH', 'Bluesky 当前凭据与配置 DID 不一致或会话无效', { stage: 'account', outcome: 'failed' })
    return { accessJwt: data.accessJwt, did: data.did, handle: data.handle }
  }
  return Object.freeze({
    did,
    async account(signal) {
      const auth = await session(signal)
      const profile = await request('app.bsky.actor.getProfile', { accessJwt: auth.accessJwt, query: { actor: did }, signal, stage: 'account' })
      if (profile.did !== did || !validBlueskyHandle(profile.handle || auth.handle)) throw new PublishError('BLUESKY_ACCOUNT_MISMATCH', 'Bluesky 返回的账号资料与配置 DID 不一致', { stage: 'account', outcome: 'failed' })
      return { id: did, name: `${profile.displayName || profile.handle || auth.handle} (@${profile.handle || auth.handle})`, handle: profile.handle || auth.handle }
    },
    async createPost(draft, images, recordKey, signal) {
      const auth = await session(signal)
      const uploaded = []
      for (const image of images) {
        const data = await request('com.atproto.repo.uploadBlob', { accessJwt: auth.accessJwt, source: image, signal, stage: 'upload' })
        if (!data.blob || data.blob.mimeType !== image.mime || data.blob.size !== image.sizeBytes) throw new PublishError('BLUESKY_INVALID_BLOB', 'Bluesky 返回的图片回执与本地素材不一致', { stage: 'upload', outcome: 'failed' })
        uploaded.push({ alt: '', image: data.blob })
      }
      const text = blueskyCaption(draft)
      const facets = blueskyFacets(text)
      const record = { $type: POST_COLLECTION, text, createdAt: new Date().toISOString(), ...(facets.length && { facets }), ...(uploaded.length && { embed: { $type: 'app.bsky.embed.images', images: uploaded } }) }
      return request('com.atproto.repo.createRecord', { accessJwt: auth.accessJwt, json: { repo: did, collection: POST_COLLECTION, rkey: recordKey, record }, signal, stage: 'submit' })
    },
    async getPost(recordKey, signal) {
      const auth = await session(signal)
      return request('com.atproto.repo.getRecord', { accessJwt: auth.accessJwt, query: { repo: did, collection: POST_COLLECTION, rkey: recordKey }, signal, stage: 'review' })
    },
  })
}
