import { PublishError } from '../errors.js'

export const validTikTokReceipt = value => typeof value === 'string' && /^[A-Za-z0-9_.:~=-]{1,64}$/.test(value)
const problem = (stage, code, message, details) => new PublishError(`TIKTOK_${code}`, message, { stage, outcome: ['submit', 'upload', 'review'].includes(stage) ? 'unknown' : 'failed', ...details })
const hosts = new Set(['open-upload.tiktokapis.com', 'upload.us.tiktokapis.com'])

function uploadTarget(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && hosts.has(url.hostname) && !url.port && !url.username && !url.password && !url.hash && url.pathname === '/video/' && url.searchParams.get('upload_id') && url.searchParams.get('upload_token') && [...url.searchParams.keys()].every(key => ['upload_id', 'upload_token'].includes(key)) && [...url.searchParams.keys()].length === 2) return url
  } catch {}
  throw problem('upload', 'UNSAFE_UPLOAD', 'TikTok 未返回可信的官方视频上传地址，请先查询投稿状态')
}

export function createTikTokClient({ openId }, { fetchImpl = fetch, timeoutMs = 30_000, uploadTimeoutMs = 5 * 60_000 } = {}) {
  if (typeof openId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openId)) throw new TypeError('Invalid TikTok account ID')
  async function request(path, stage, accessToken, { method = 'POST', json = {}, signal } = {}) {
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) throw problem(stage, 'INVALID_TOKEN', 'TikTok 授权令牌无效', { outcome: 'failed' })
    const deadline = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
    if (requestSignal.aborted) throw problem(stage, 'ABORTED', 'TikTok 请求已取消', { outcome: 'failed' })
    let response, payload
    try {
      response = await fetchImpl(new URL('/v2' + path, 'https://open.tiktokapis.com'), { method, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' }, ...(method !== 'GET' && { body: JSON.stringify(json) }), signal: requestSignal, redirect: 'error' })
      const text = await response.text()
      payload = JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token))
    } catch { throw problem(stage, 'NO_RESPONSE', '未收到可确认的 TikTok 响应，请先核对投稿记录') }
    if (response.status === 200 && payload?.error?.code === 'ok' && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data
    const rejected = stage === 'submit' && !payload?.data?.publish_id && [400, 401, 403, 404, 422].includes(response.status) && typeof payload?.error?.code === 'string' && payload.error.code !== 'ok'
    throw problem(stage, 'REQUEST_FAILED', `TikTok 未确认请求成功（HTTP ${response.status}）`, { httpStatus: response.status, ...(rejected && { outcome: 'failed' }) })
  }
  return Object.freeze({
    openId,
    async identity(accessToken, signal) {
      const data = await request('/user/info/?fields=open_id,display_name', 'account', accessToken, { method: 'GET', signal })
      if (data.user?.open_id !== openId) throw problem('account', 'ACCOUNT_MISMATCH', 'TikTok 令牌与配置账号不一致')
      return { id: openId, name: typeof data.user.display_name === 'string' && data.user.display_name.trim() ? data.user.display_name.slice(0, 150) : 'TikTok' }
    },
    async creator(accessToken, signal) {
      let data
      try { data = await request('/post/publish/creator_info/query/', 'account', accessToken, { signal }) }
      catch { throw problem('account', 'CREATOR_UNAVAILABLE', 'TikTok 暂时无法提供创作者发布权限，请稍后重试') }
      if (typeof data.creator_username !== 'string' || !/^[A-Za-z0-9_.]{1,100}$/.test(data.creator_username) || typeof data.creator_nickname !== 'string' || !data.creator_nickname.trim() || !Array.isArray(data.privacy_level_options) || !data.privacy_level_options.length || data.privacy_level_options.some(value => !['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(value)) || ['comment_disabled', 'duet_disabled', 'stitch_disabled'].some(key => typeof data[key] !== 'boolean') || !Number.isInteger(data.max_video_post_duration_sec) || data.max_video_post_duration_sec < 3 || data.max_video_post_duration_sec > 2_147_483_647) throw problem('account', 'INVALID_CREATOR', 'TikTok 未返回完整的创作者发布权限，请稍后重新核对')
      return { username: data.creator_username, nickname: data.creator_nickname.slice(0, 150), privacyLevels: [...new Set(data.privacy_level_options)], commentDisabled: data.comment_disabled, duetDisabled: data.duet_disabled, stitchDisabled: data.stitch_disabled, maxDuration: data.max_video_post_duration_sec }
    },
    async initialize(accessToken, postInfo, sourceInfo, signal) {
      const data = await request('/post/publish/video/init/', 'submit', accessToken, { json: { post_info: postInfo, source_info: sourceInfo }, signal })
      if (!validTikTokReceipt(data.publish_id)) throw problem('submit', 'INVALID_RECEIPT', 'TikTok 未返回可确认的投稿回执，请到 TikTok 核对')
      return { id: data.publish_id, uploadUrl: data.upload_url }
    },
    async upload(session, video, chunkSize, chunkCount, signal) {
      const url = uploadTarget(session.uploadUrl)
      for (let index = 0; index < chunkCount; index++) {
        const start = index * chunkSize
        const end = index === chunkCount - 1 ? video.sizeBytes - 1 : start + chunkSize - 1
        const deadline = AbortSignal.timeout(uploadTimeoutMs)
        const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
        if (requestSignal.aborted) throw problem('upload', 'ABORTED', 'TikTok 上传已取消，请先查询投稿状态')
        const body = video.stream({ start, end })
        try {
          const response = await fetchImpl(url, { method: 'PUT', headers: { 'content-type': video.mime, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${video.sizeBytes}` }, body, signal: requestSignal, redirect: 'error', duplex: 'half' })
          if (response.status !== (index === chunkCount - 1 ? 201 : 206)) throw problem('upload', 'UPLOAD_FAILED', 'TikTok 未确认视频分片上传完成，请先查询投稿状态')
        } catch (err) {
          if (err instanceof PublishError) throw err
          throw problem('upload', 'UPLOAD_UNKNOWN', 'TikTok 视频上传结果不确定，请先查询投稿状态')
        } finally { body.destroy?.() }
      }
    },
    async status(accessToken, receiptId, signal) {
      if (!validTikTokReceipt(receiptId)) throw problem('review', 'INVALID_RECEIPT', 'TikTok 投稿回执无效')
      return request('/post/publish/status/fetch/', 'review', accessToken, { json: { publish_id: receiptId }, signal })
    },
  })
}
