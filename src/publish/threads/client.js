import { PublishError } from '../errors.js'

export const validThreadsId = value => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)
export const validThreadsLink = value => typeof value === 'string' && /^https:\/\/www\.threads\.(?:com|net)\/@[A-Za-z0-9_.]{1,100}\/post\/[A-Za-z0-9_-]{4,64}\/?$/.test(value)
const problem = (stage, code, message, details) => new PublishError(`THREADS_${code}`, message, { stage, outcome: ['submit', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })

export function createThreadsClient({ userId }, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (!validThreadsId(userId)) throw new TypeError('Invalid Threads account ID')
  async function request(path, stage, accessToken, { method = 'GET', fields, form, signal } = {}) {
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) throw problem(stage, 'INVALID_TOKEN', 'Threads 授权令牌无效', { outcome: 'failed' })
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw problem(stage, 'ABORTED', 'Threads 请求已取消', { outcome: 'failed' })
    const url = new URL('/v1.0/' + path, 'https://graph.threads.com')
    if (fields) url.searchParams.set('fields', fields)
    let response, data
    try {
      response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${accessToken}`, ...(form && { 'content-type': 'application/x-www-form-urlencoded' }) }, body: form ? new URLSearchParams(form) : undefined, redirect: 'error', signal: requestSignal })
      data = await response.json()
    } catch { throw problem(stage, 'NO_RESPONSE', '未收到可确认的 Threads 响应，请先核对投稿记录') }
    if ([200, 201].includes(response.status) && data && typeof data === 'object' && !Array.isArray(data) && !data.error) return data
    const rejected = stage === 'submit' && !data?.id && [400, 401, 403, 404, 422].includes(response.status) && Number.isInteger(data?.error?.code)
    throw problem(stage, 'REQUEST_FAILED', `Threads 未确认请求成功（HTTP ${response.status}）`, { httpStatus: response.status, ...(rejected && { outcome: 'failed' }) })
  }
  return Object.freeze({
    userId,
    async account(accessToken, signal) {
      const data = await request('me', 'account', accessToken, { fields: 'id,username,name', signal })
      if (data.id !== userId || typeof data.username !== 'string' || !/^[A-Za-z0-9_.]{1,100}$/.test(data.username)) throw problem('account', 'ACCOUNT_MISMATCH', 'Threads 令牌与配置账号不一致，或未返回有效账号')
      return { id: userId, name: typeof data.name === 'string' && data.name.trim() ? `${data.name} (@${data.username})` : `@${data.username}` }
    },
    async create(accessToken, metadata, signal) {
      const data = await request(`${userId}/threads`, 'initialize', accessToken, { method: 'POST', form: { ...metadata, media_type: 'TEXT', is_carousel_item: 'false', auto_publish_text: 'false' }, signal })
      if (!validThreadsId(data.id)) throw problem('initialize', 'INVALID_CONTAINER', 'Threads 未返回有效文字容器，未发送发布请求')
      return data.id
    },
    async container(accessToken, id, signal) {
      if (!validThreadsId(id)) throw problem('review', 'INVALID_CONTAINER', 'Threads 文字容器标识无效')
      const data = await request(id, 'review', accessToken, { fields: 'id,status', signal })
      if (data.id !== id || !['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(data.status)) throw problem('review', 'INVALID_STATE', 'Threads 未返回可确认的文字容器状态')
      return data.status
    },
    async publish(accessToken, id, signal) {
      const data = await request(`${userId}/threads_publish`, 'submit', accessToken, { method: 'POST', form: { creation_id: id }, signal })
      if (!validThreadsId(data.id)) throw problem('submit', 'INVALID_RECEIPT', 'Threads 未返回可确认的帖子回执，请到 Threads 核对')
      return data.id
    },
    async post(accessToken, id, signal) {
      if (!validThreadsId(id)) throw problem('review', 'INVALID_RECEIPT', 'Threads 投稿回执无效')
      const data = await request(id, 'review', accessToken, { fields: 'id,owner,media_type,permalink', signal })
      const owner = typeof data.owner === 'string' ? data.owner : data.owner?.id
      if (data.id !== id || owner !== userId || data.media_type !== 'TEXT_POST') throw problem('review', 'POST_MISMATCH', 'Threads 未确认该文字帖子属于原投稿账号')
      return { url: validThreadsLink(data.permalink) ? data.permalink : undefined }
    },
  })
}
