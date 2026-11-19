// Reels publishing flow adapted from AiToEarn's facebook.service.ts at 11dd1957 (MIT).
import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { facebookCaption, facebookCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { facebookVideoIssue } from '../media-rules.js'
import { isGraphId } from '../meta-client.js'
import { createFacebookFeedPublisher } from './feed.js'
import { createFacebookStoryPublisher } from './story.js'
import { readFacebookStatus } from './status.js'
export { readFacebookStatus } from './status.js'

const invalid = message => new PublishError('INVALID_FACEBOOK_DRAFT', message, { stage: 'check' })

export function createFacebookPublisher(client) {
  const verifyAccount = async (accessToken, signal) => verifyPage((await client.account(accessToken, signal))?.id)
  const feed = createFacebookFeedPublisher(client, verifyAccount)
  const story = createFacebookStoryPublisher(client, verifyAccount)
  function check({ draft, video, cover, images }) {
    if (['story', 'photo_story'].includes(draft?.destination)) return story.check({ draft, video, cover, images })
    if (draft?.destination !== undefined && draft.destination !== 'reels') throw invalid('请重新选择 Facebook 视频发布位置。')
    if (['text', 'images'].includes(draft?.format)) return feed.check({ draft, video, cover, images })
    if (draft?.format !== undefined && draft.format !== 'video') throw invalid('Facebook API 入口支持视频、图文或纯文字，请选择对应类型。')
    const copyIssue = facebookCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (draft.privacyStatus !== 'public' || typeof draft.isAiGenerated !== 'boolean') throw invalid('请确认 Facebook Reels 公开发布并声明是否由 AI 生成')
    if (cover || !video || !Number.isSafeInteger(video.sizeBytes) || video.sizeBytes < 1 || video.sizeBytes > MAX_ASSET_BYTES || typeof video.stream !== 'function') throw invalid('Facebook Reels 需要有效的本地视频，不上传独立封面')
    const mediaIssue = facebookVideoIssue(video)
    if (mediaIssue) throw invalid(mediaIssue)
    return { title: draft.title, description: facebookCaption(draft), is_ai_generated: String(draft.isAiGenerated) }
  }
  function verifyPage(channelId) {
    if (!isGraphId(channelId) || channelId !== client.pageId) throw new PublishError('FACEBOOK_WRONG_PAGE', 'Facebook 当前令牌与配置的公共主页不一致', { stage: 'account' })
  }
  return Object.freeze({
    check,
    async account(accessToken, signal) {
      const page = await client.account(accessToken, signal)
      verifyPage(page?.id)
      return { ...page, constraints: { feedAiSupported: client.feedAiSupported, storySupported: client.storySupported } }
    },
    async submit({ accessToken, channelId, draft, video, cover, images, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      verifyPage(channelId)
      if (['story', 'photo_story'].includes(draft?.destination)) return story.submit({ accessToken, draft, video, cover, images, beforeSubmit, signal })
      if (['text', 'images'].includes(draft?.format)) return feed.submit({ accessToken, channelId, draft, video, cover, images, beforeSubmit, signal })
      const metadata = check({ draft, video, cover })
      const session = await client.initialize(accessToken, signal)
      const result = await client.upload(accessToken, session, video, signal)
      if (result.success !== true) throw new PublishError('FACEBOOK_UPLOAD_UNCONFIRMED', 'Facebook 未确认收到视频，未发送发布请求', { stage: 'upload' })
      await beforeSubmit(session.videoId)
      const receipt = await client.finish(accessToken, session.videoId, metadata, signal)
      if (receipt.success !== true) throw new PublishError('FACEBOOK_FINISH_UNCONFIRMED', '无法确认 Facebook 是否已提交 Reel，请先回查', { stage: 'submit', outcome: 'unknown' })
      return { status: 'pending_review', receiptId: session.videoId }
    },
    async review({ accessToken, channelId, receiptId, workId, format, destination, signal }) {
      verifyPage(channelId)
      if (['story', 'photo_story'].includes(destination)) return story.review({ accessToken, receiptId, workId, destination, signal })
      if (['text', 'images'].includes(format)) return feed.review({ accessToken, channelId, receiptId, signal })
      return readFacebookStatus(await client.status(accessToken, receiptId, signal), receiptId)
    },
  })
}
