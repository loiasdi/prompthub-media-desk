import { weChatArticleHtml, weChatCopyIssue, weChatHtmlIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { WECHAT_DECLARATION_MANUAL, WECHAT_COVER_BYTES, PUBLISH_COVER_MIME, weChatBodyImagesIssue } from '../media-rules.js'
import { validWeChatLink } from './links.js'

const invalid = message => new PublishError('INVALID_WECHAT_DRAFT', message, { stage: 'check' })

export function createWeChatPublisher(client) {
  function check({ draft, video, cover, images = [] }) {
    const copyIssue = weChatCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (video || draft.privacyStatus !== 'public' || typeof draft.allowComment !== 'boolean' || typeof draft.onlyFansComment !== 'boolean' || (!draft.allowComment && draft.onlyFansComment) || draft.requiresNativeDeclaration !== false) throw invalid(draft.requiresNativeDeclaration === true ? WECHAT_DECLARATION_MANUAL : '请确认公众号发表范围、评论权限和 AI 标识需求')
    if (!Number.isSafeInteger(cover?.sizeBytes) || cover.sizeBytes <= 0 || cover.sizeBytes > WECHAT_COVER_BYTES || !PUBLISH_COVER_MIME.has(cover.mime) || typeof cover.stream !== 'function') throw invalid('公众号文章必须选择不超过 10 MB 的本地 JPEG 或 PNG 封面')
    const imagesIssue = weChatBodyImagesIssue(draft.description, images)
    if (imagesIssue) throw invalid(imagesIssue)
    if (images.some(image => typeof image.stream !== 'function')) throw invalid('公众号正文配图需要有效的本地文件')
    return { article_type: 'news', title: draft.title, content: weChatArticleHtml(draft.description), ...(draft.author && { author: draft.author }), ...(draft.digest && { digest: draft.digest }), need_open_comment: draft.allowComment ? 1 : 0, only_fans_can_comment: draft.onlyFansComment ? 1 : 0 }
  }
  return Object.freeze({
    account: (...args) => client.account(...args), check,
    async submit({ accessToken, channelId, draft, video, cover, images = [], beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.appId) throw invalid('微信公众号 AppID 与投稿确认单不一致')
      const metadata = check({ draft, video, cover, images })
      await client.account(accessToken, signal)
      const mediaId = await client.cover(cover, signal)
      if (images.length) {
        const urls = new Map()
        for (const image of images) urls.set(image.id, { url: await client.image(image, signal), filename: image.filename })
        metadata.content = weChatArticleHtml(draft.description, urls)
        const issue = weChatHtmlIssue(metadata.content)
        if (issue) throw invalid(issue)
      }
      const draftId = await client.draft({ ...metadata, thumb_media_id: mediaId }, signal)
      await client.account(accessToken, signal)
      await beforeSubmit()
      const receiptId = await client.publish(draftId, signal)
      return { status: 'pending_review', receiptId }
    },
    async review({ accessToken, channelId, receiptId, signal }) {
      if (channelId !== client.appId) throw invalid('微信公众号 AppID 与投稿确认单不一致')
      await client.account(accessToken, signal)
      const data = await client.status(receiptId, signal)
      if (data.publish_status === 1) return { status: 'pending_review', platformState: 'processing', receiptId }
      if ([2, 3, 4].includes(data.publish_status)) return { status: 'rejected', platformState: 'rejected', receiptId }
      if ([5, 6].includes(data.publish_status)) return { status: 'unknown', platformState: 'unavailable', receiptId }
      if (data.article_detail?.count !== 1 || !Array.isArray(data.article_detail.item) || data.article_detail.item.length !== 1 || ![0, 1].includes(data.article_detail.item[0]?.idx) || typeof data.article_id !== 'string' || !data.article_id) throw new PublishError('WECHAT_INVALID_ARTICLE', '微信报告发表完成，但未返回可确认的单篇文章详情，请在公众平台核对', { stage: 'review', outcome: 'unknown' })
      const link = data.article_detail.item[0].article_url
      return { status: 'published', platformState: 'available', receiptId, privacyStatus: 'public', url: validWeChatLink(link) ? link : undefined }
    },
  })
}
