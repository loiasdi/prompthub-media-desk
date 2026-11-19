import { blueskyImagesIssue } from '../media-rules.js'
import { blueskyCaption, blueskyCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { createBlueskyRecordKey, validBlueskyDid } from './client.js'

const invalid = message => new PublishError('INVALID_BLUESKY_DRAFT', message, { stage: 'check', outcome: 'failed' })
const recordUri = (did, rkey) => `at://${did}/app.bsky.feed.post/${rkey}`
const validRkey = value => typeof value === 'string' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(value)
const safeLink = (handle, rkey) => `https://bsky.app/profile/${handle}/post/${rkey}`

export function createBlueskyPublisher(client) {
  function check({ draft, video, cover, images = [] }) {
    const copyIssue = blueskyCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (draft.privacyStatus !== 'public') throw invalid('请确认 Bluesky 帖子将公开发布')
    if (!['text', 'images'].includes(draft.format || 'text')) throw invalid('Bluesky API 入口仅支持纯文字或图文')
    if (draft.format === 'text') {
      if (video || cover || images.length) throw invalid('Bluesky 纯文字投稿不能包含素材')
    } else {
      if (video || cover) throw invalid('Bluesky 图文不能混发视频或独立封面')
      const issue = blueskyImagesIssue(images)
      if (issue) throw invalid(issue)
      if (images.some(image => typeof image.stream !== 'function')) throw invalid('Bluesky 需要有效的本地发布图片')
    }
    return blueskyCaption(draft)
  }
  return Object.freeze({
    check,
    account: (_token, signal) => client.account(signal),
    async submit({ channelId, draft, video, cover, images = [], beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.did) throw invalid('Bluesky 当前账号与投稿确认单不一致')
      check({ draft, video, cover, images })
      const account = await client.account(signal)
      const rkey = createBlueskyRecordKey()
      const receiptId = recordUri(client.did, rkey)
      await beforeSubmit(receiptId)
      const result = await client.createPost(draft, images, rkey, signal)
      if (result.uri !== receiptId || typeof result.cid !== 'string' || !result.cid) throw new PublishError('BLUESKY_POST_UNCONFIRMED', 'Bluesky 已接收投稿请求但回执不完整，请查询平台状态后再处理。', { stage: 'submit', outcome: 'unknown' })
      return { status: 'published', receiptId, url: safeLink(account.handle, rkey), privacyStatus: 'public' }
    },
    async review({ channelId, receiptId, signal }) {
      if (channelId !== client.did) throw invalid('Bluesky 当前账号与投稿记录不一致')
      const prefix = `at://${client.did}/app.bsky.feed.post/`
      const rkey = typeof receiptId === 'string' && receiptId.startsWith(prefix) ? receiptId.slice(prefix.length) : ''
      if (!validBlueskyDid(client.did) || !validRkey(rkey)) throw invalid('Bluesky 投稿回执无效')
      const account = await client.account(signal)
      const data = await client.getPost(rkey, signal)
      if (data.uri !== receiptId || data.value?.$type !== 'app.bsky.feed.post') return { status: 'unknown', receiptId }
      return { status: 'published', receiptId, url: safeLink(account.handle, rkey), privacyStatus: 'public' }
    },
  })
}
