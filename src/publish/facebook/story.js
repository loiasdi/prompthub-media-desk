// Local-file adaptation of AiToEarn facebook.service.ts::publishVideoStory at
// 11dd1957 (MIT; see UPSTREAM-LICENSE.txt). No remote media URL is fetched.
import { MAX_ASSET_BYTES } from '../../asset-rules.js'
import { facebookCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { FACEBOOK_IMAGE_BYTES, FACEBOOK_STORY_VERSION, facebookStoryVideoIssue, PUBLISH_COVER_MIME } from '../media-rules.js'
import { isGraphId } from '../meta-client.js'
import { validFacebookPostId } from './client.js'
import { readFacebookStoryList } from './status.js'

const invalid = message => new PublishError('INVALID_FACEBOOK_DRAFT', message, { stage: 'check' })
function storyPostId(value, pageId) {
  // The guide uses a small JSON number; never round a large numeric ID.
  const id = Number.isSafeInteger(value) && value > 0 ? String(value) : value
  return isGraphId(id) || validFacebookPostId(id, pageId) ? id : null
}

export function createFacebookStoryPublisher(client, verifyAccount) {
  function check({ draft, video, cover, images = [] }) {
    if (!client.storySupported) throw invalid(FACEBOOK_STORY_VERSION)
    if (!['story', 'photo_story'].includes(draft?.destination)) throw invalid('请选择 Facebook 快拍发布位置。')
    if (draft.destination === 'photo_story') {
      if (draft.format !== 'images') throw invalid('Facebook 照片快拍需要选择图文发布类型。')
      if (draft.privacyStatus !== 'public' || typeof draft.isAiGenerated !== 'boolean') throw invalid('请确认 Facebook 照片快拍公开发布并声明是否由 AI 生成。')
      if (draft.isAiGenerated) throw invalid('Facebook 照片快拍接口不提供 AI 声明字段；AI 生成照片请改用官方发布器。')
      if (video || cover || !Array.isArray(images) || images.length !== 1 || !PUBLISH_COVER_MIME.has(images[0]?.mime) || !Number.isSafeInteger(images[0].sizeBytes) || images[0].sizeBytes < 1 || images[0].sizeBytes > FACEBOOK_IMAGE_BYTES || typeof images[0].stream !== 'function') throw invalid('Facebook 照片快拍只支持一张不超过 10 MB 的本地 JPEG 或 PNG，不发送视频或独立封面。')
      const copyIssue = facebookCopyIssue(draft)
      if (copyIssue) throw invalid(copyIssue)
      return
    }
    if (draft.format !== undefined && draft.format !== 'video') throw invalid('Facebook 视频快拍仅支持视频，请重新选择发布位置。')
    const copyIssue = facebookCopyIssue(draft)
    if (copyIssue) throw invalid(copyIssue)
    if (draft.privacyStatus !== 'public' || typeof draft.isAiGenerated !== 'boolean') throw invalid('请确认 Facebook 视频快拍公开发布并声明是否由 AI 生成。')
    if (cover || !Array.isArray(images) || images.length || !video || typeof video.stream !== 'function' || !Number.isSafeInteger(video.sizeBytes) || video.sizeBytes < 1 || video.sizeBytes > MAX_ASSET_BYTES) throw invalid('Facebook 视频快拍需要有效的本地成片，不发送图片或独立封面。')
    const issue = facebookStoryVideoIssue(video)
    if (issue) throw invalid(issue)
  }
  return Object.freeze({
    check,
    async submit({ accessToken, draft, video, cover, images, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      check({ draft, video, cover, images })
      await verifyAccount(accessToken, signal)
      if (draft.destination === 'photo_story') {
        const photoId = await client.uploadPhoto(accessToken, images[0], signal)
        await verifyAccount(accessToken, signal)
        await beforeSubmit(photoId)
        const receipt = await client.finishPhotoStory(accessToken, photoId, signal)
        const workId = storyPostId(receipt.post_id, client.pageId)
        if (receipt.success !== true || !workId) throw new PublishError('FACEBOOK_STORY_UNCONFIRMED', '无法确认 Facebook 是否已提交照片快拍，请先回查或在公共主页核对。', { stage: 'submit', outcome: 'unknown' })
        return { status: 'pending_review', receiptId: photoId, workId }
      }
      // Every attempt creates fresh media: Stories cannot reuse media already posted.
      const session = await client.initializeStory(accessToken, signal)
      const upload = await client.upload(accessToken, session, video, signal)
      if (upload.success !== true) throw new PublishError('FACEBOOK_UPLOAD_UNCONFIRMED', 'Facebook 未确认收到快拍视频，未发送发布请求', { stage: 'upload' })
      await verifyAccount(accessToken, signal)
      await beforeSubmit(session.videoId)
      const receipt = await client.finishStory(accessToken, session.videoId, draft.isAiGenerated, signal)
      const postId = storyPostId(receipt.post_id, client.pageId)
      if (receipt.success !== true || !postId) throw new PublishError('FACEBOOK_STORY_UNCONFIRMED', '无法确认 Facebook 是否已提交视频快拍，请先回查或在公共主页核对。', { stage: 'submit', outcome: 'unknown' })
      return { status: 'pending_review', receiptId: session.videoId, workId: postId }
    },
    async review({ accessToken, receiptId, workId, destination, signal }) {
      await verifyAccount(accessToken, signal)
      return readFacebookStoryList(await client.stories(accessToken, signal), receiptId, {
        pageId: client.pageId, workId, mediaType: destination === 'photo_story' ? 'photo' : 'video',
      })
    },
  })
}
