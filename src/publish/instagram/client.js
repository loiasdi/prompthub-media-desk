// Container + publish endpoints from AiToEarn (MIT). Local rupload uses Meta's
// Instagram API with Facebook Login for Business, not the hosted video_url flow.
import { PublishError } from '../errors.js'
import { createMetaTransport, isGraphId, metaUploadTarget, validGraphVersion } from '../meta-client.js'

export const INSTAGRAM_GRAPH_VERSION = 'v27.0'

export function createInstagramClient({ pageId, graphVersion = INSTAGRAM_GRAPH_VERSION }, options) {
  if (!isGraphId(pageId) || !validGraphVersion(graphVersion)) throw new TypeError('Invalid Instagram linked Facebook Page configuration')
  const http = createMetaTransport('Instagram', graphVersion, options)
  const target = (value, id) => metaUploadTarget(value, 'ig-api-upload', graphVersion, id, true)
  const requireId = (id, stage) => {
    if (!isGraphId(id)) throw new PublishError('INSTAGRAM_INVALID_ID', 'Instagram 投稿标识无效', { stage, outcome: stage === 'review' ? 'unknown' : 'failed' })
  }

  return Object.freeze({
    async account(accessToken, signal) {
      const { id, instagram_business_account: account } = await http.get(pageId, 'id,instagram_business_account{id,username}', accessToken, 'account', signal)
      if (id !== pageId || !isGraphId(account?.id) || typeof account.username !== 'string' || !/^[a-z0-9_.]{1,30}$/i.test(account.username)) {
        throw new PublishError('INSTAGRAM_ACCOUNT_UNCONFIRMED', '无法确认所配置公共主页关联的 Instagram 专业账号', { stage: 'account' })
      }
      return { id: account.id, name: `@${account.username}` }
    },
    async initialize(accessToken, accountId, draft, signal) {
      requireId(accountId, 'initialize')
      const { id, uri } = await http.post(`${accountId}/media`, {
        media_type: 'REELS', upload_type: 'resumable', caption: draft.caption,
        share_to_feed: String(draft.shareToFeed), is_ai_generated: String(draft.isAiGenerated),
      }, accessToken, 'initialize', signal)
      const url = target(uri, id)
      if (!url) throw new PublishError('INSTAGRAM_UNSAFE_UPLOAD', 'Instagram 未返回可信的 Reel 上传地址', { stage: 'initialize' })
      return { id, url }
    },
    upload(accessToken, { id, url }, source, signal) {
      const validated = target(url?.href, id)
      if (!validated) throw new PublishError('INSTAGRAM_UNSAFE_UPLOAD', 'Instagram 未返回可信的 Reel 上传地址', { stage: 'upload' })
      return http.upload(validated, source, accessToken, signal)
    },
    async status(accessToken, id, stage, signal) {
      requireId(id, stage)
      const result = await http.get(id, 'id,status_code', accessToken, stage, signal)
      if (result.id !== id || typeof result.status_code !== 'string') throw new PublishError('INSTAGRAM_INVALID_STATUS', 'Instagram 未返回可确认的容器状态', { stage, outcome: stage === 'review' ? 'unknown' : 'failed' })
      return result.status_code
    },
    async finish(accessToken, accountId, id, signal) {
      requireId(accountId, 'submit')
      requireId(id, 'submit')
      const result = await http.post(`${accountId}/media_publish`, { creation_id: id }, accessToken, 'submit', signal)
      if (!isGraphId(result.id)) throw new PublishError('INSTAGRAM_FINISH_UNCONFIRMED', '无法确认 Instagram 是否已发布 Reel，请先回查', { stage: 'submit', outcome: 'unknown' })
      return result.id
    },
    media(accessToken, id, signal) {
      requireId(id, 'review')
      return http.get(id, 'id,media_product_type,permalink', accessToken, 'review', signal)
    },
  })
}
