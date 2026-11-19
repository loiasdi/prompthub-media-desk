// Feed/attached_media flow adapted from AiToEarn's facebook.service.ts at
// 11dd1957 (MIT). Remote URLs are replaced with unpublished local photo uploads.
import { facebookCaption, facebookCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { FACEBOOK_FEED_AI_VERSION, facebookImagesIssue } from '../media-rules.js'
import { validFacebookPostId } from './client.js'

const invalid = message => new PublishError('INVALID_FACEBOOK_DRAFT', message, { stage: 'check' })
const uncertain = message => new PublishError('FACEBOOK_FEED_UNCONFIRMED', message, { stage: 'review', outcome: 'unknown' })

function verifyPost(data, postId, pageId) {
  if (!validFacebookPostId(postId, pageId) || data?.id !== postId || data.from?.id !== pageId || typeof data.is_published !== 'boolean' || typeof data.is_hidden !== 'boolean') throw uncertain('Facebook 未返回归属当前公共主页的完整动态状态')
}

export function readFacebookFeedStatus(data, postId, pageId) {
  verifyPost(data, postId, pageId)
  if (!data.is_published || data.is_hidden) return { status: 'unknown', receiptId: postId, platformState: data.is_published ? 'hidden' : 'unpublished' }
  return { status: 'published', receiptId: postId, platformState: 'published', privacyStatus: 'public', url: `https://www.facebook.com/${pageId}/posts/${postId.split('_')[1]}` }
}

export function createFacebookFeedPublisher(client, verifyAccount) {
  function check({ draft, video, cover, images = [] }) {
    if (draft?.destination !== undefined) throw invalid('Facebook 动态不能使用视频发布位置，请重新选择发布类型。')
    const issue = facebookCopyIssue(draft || {})
    if (issue) throw invalid(issue)
    if (!['text', 'images'].includes(draft.format) || draft.privacyStatus !== 'public' || typeof draft.isAiGenerated !== 'boolean') throw invalid('请确认 Facebook 动态公开发布并声明是否由 AI 生成')
    if (draft.isAiGenerated && !client.feedAiSupported) throw invalid(FACEBOOK_FEED_AI_VERSION)
    if (video || cover) throw invalid('Facebook 动态不发送视频或独立封面')
    if (draft.format === 'images') {
      const imageIssue = facebookImagesIssue(images)
      if (imageIssue) throw invalid(imageIssue)
      if (images.some(image => typeof image.stream !== 'function')) throw invalid('Facebook 图文需要有效的本地图片')
    } else if (!Array.isArray(images) || images.length) throw invalid('Facebook 纯文字动态不发送图片')
    return { message: facebookCaption(draft) }
  }
  return Object.freeze({
    check,
    async submit({ accessToken, channelId, draft, video, cover, images = [], beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      const { message } = check({ draft, video, cover, images })
      const photoIds = []
      for (const image of images) {
        const id = await client.uploadPhoto(accessToken, image, signal)
        if (photoIds.includes(id)) throw new PublishError('FACEBOOK_DUPLICATE_PHOTO', 'Facebook 返回重复图片回执，未发送发布请求', { stage: 'upload' })
        photoIds.push(id)
      }
      const postId = await client.createFeedDraft(accessToken, message, photoIds, signal)
      // Persist the recoverable post ID before any request can make it public.
      await beforeSubmit(postId)
      const state = await client.feedStatus(accessToken, postId, signal)
      verifyPost(state, postId, channelId)
      if (state.is_published || state.is_hidden) throw uncertain('Facebook 未确认动态草稿未公开且可发布，请先到公共主页核对')
      await verifyAccount(accessToken, signal)
      // AI declaration and publication share one update, never a later label patch.
      const receipt = await client.publishFeed(accessToken, postId, draft.isAiGenerated, signal)
      if (receipt.success !== true) throw uncertain('无法确认 Facebook 是否已公开动态，请先回查')
      return { status: 'pending_review', receiptId: postId, ...(photoIds.length && { mediaIds: photoIds }) }
    },
    async review({ accessToken, channelId, receiptId, signal }) {
      return readFacebookFeedStatus(await client.feedStatus(accessToken, receiptId, signal), receiptId, channelId)
    },
  })
}
