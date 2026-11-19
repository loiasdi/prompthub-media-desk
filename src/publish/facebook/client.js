// Reels API request sequence adapted from AiToEarn (MIT; see UPSTREAM-LICENSE.txt).
import { PublishError } from '../errors.js'
import { createMetaTransport, isGraphId, metaUploadTarget, validGraphVersion } from '../meta-client.js'

export const DEFAULT_GRAPH_VERSION = 'v25.0'
export const validFacebookPostId = (value, pageId) => typeof value === 'string' && value.startsWith(`${pageId}_`) && /^[1-9]\d{0,31}_[1-9]\d{0,31}$/.test(value)

export function createFacebookClient({ pageId, graphVersion = DEFAULT_GRAPH_VERSION }, options) {
  if (!isGraphId(pageId) || !validGraphVersion(graphVersion)) throw new TypeError('Invalid Facebook Page configuration')
  const http = createMetaTransport('Facebook', graphVersion, options)
  const reels = `${pageId}/video_reels`
  // The guide documents both the versioned and unversioned paths.
  const target = (value, id) => metaUploadTarget(value, 'video-upload', graphVersion, id, true)
  // Verified in the v27 Page Post update reference, not the older v25 schema.
  const feedAiSupported = Number(graphVersion.slice(1, -2)) >= 27
  const storySupported = Number(graphVersion.slice(1, -2)) >= 27
  async function initializeVideo(edge, accessToken, signal, allowUnversioned = true) {
    const { video_id: videoId, upload_url: rawUrl } = await http.post(edge, { upload_phase: 'start' }, accessToken, 'initialize', signal)
    const url = metaUploadTarget(rawUrl, 'video-upload', graphVersion, videoId, allowUnversioned)
    if (!url) throw new PublishError('FACEBOOK_UNSAFE_UPLOAD', 'Facebook 未返回可信的视频上传地址', { stage: 'initialize' })
    return { videoId, url }
  }
  return Object.freeze({
    pageId,
    feedAiSupported,
    storySupported,
    account: (accessToken, signal) => http.get('me', 'id,name', accessToken, 'account', signal),
    async initialize(accessToken, signal) {
      return initializeVideo(reels, accessToken, signal)
    },
    initializeStory: (accessToken, signal) => initializeVideo(`${pageId}/video_stories`, accessToken, signal, false),
    async upload(accessToken, { videoId, url }, source, signal) {
      const validated = target(url?.href, videoId)
      if (!validated) throw new PublishError('FACEBOOK_UNSAFE_UPLOAD', 'Facebook 未返回可信的视频上传地址', { stage: 'upload' })
      return http.upload(validated, source, accessToken, signal)
    },
    finish(accessToken, videoId, metadata, signal) {
      if (!isGraphId(videoId)) throw new TypeError('Invalid Facebook video ID')
      return http.post(reels, { ...metadata, upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED' }, accessToken, 'submit', signal)
    },
    finishStory(accessToken, videoId, isAiGenerated, signal) {
      if (!isGraphId(videoId) || typeof isAiGenerated !== 'boolean' || !storySupported) throw new TypeError('Invalid Facebook Story parameters')
      return http.post(`${pageId}/video_stories`, { upload_phase: 'finish', video_id: videoId, is_ai_generated: String(isAiGenerated) }, accessToken, 'submit', signal)
    },
    finishPhotoStory(accessToken, photoId, signal) {
      if (!isGraphId(photoId) || !storySupported) throw new TypeError('Invalid Facebook photo Story parameters')
      return http.post(`${pageId}/photo_stories`, { photo_id: photoId }, accessToken, 'submit', signal)
    },
    stories(accessToken, signal) {
      return http.get(`${pageId}/stories`, '', accessToken, 'review', signal)
    },
    status(accessToken, videoId, signal) {
      if (!isGraphId(videoId)) throw new PublishError('FACEBOOK_INVALID_RECEIPT', 'Facebook 投稿回执无效', { stage: 'review', outcome: 'unknown' })
      return http.get(videoId, 'id,status', accessToken, 'review', signal)
    },
    async uploadPhoto(accessToken, source, signal) {
      const data = await http.postPhoto(`${pageId}/photos`, source, accessToken, signal)
      if (!isGraphId(data.id)) throw new PublishError('FACEBOOK_INVALID_PHOTO', 'Facebook 未确认收到图片，未发送发布请求', { stage: 'upload' })
      return data.id
    },
    async createFeedDraft(accessToken, message, photoIds, signal) {
      if (!Array.isArray(photoIds) || photoIds.some(id => !isGraphId(id)) || new Set(photoIds).size !== photoIds.length) throw new TypeError('Invalid Facebook photo IDs')
      const fields = { message, published: 'false' }
      photoIds.forEach((id, index) => { fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id }) })
      const data = await http.post(`${pageId}/feed`, fields, accessToken, 'initialize', signal)
      if (!validFacebookPostId(data.id, pageId)) throw new PublishError('FACEBOOK_INVALID_DRAFT', 'Facebook 未返回归属当前公共主页的动态草稿，未发送发布请求', { stage: 'initialize' })
      return data.id
    },
    publishFeed(accessToken, postId, isAiGenerated, signal) {
      if (!validFacebookPostId(postId, pageId)) throw new TypeError('Invalid Facebook post ID')
      if (typeof isAiGenerated !== 'boolean' || (isAiGenerated && !feedAiSupported)) throw new TypeError('Unsupported Facebook AI declaration')
      return http.post(postId, { is_published: 'true', ...(feedAiSupported && { is_ai_generated: String(isAiGenerated) }) }, accessToken, 'submit', signal)
    },
    feedStatus(accessToken, postId, signal) {
      if (!validFacebookPostId(postId, pageId)) throw new PublishError('FACEBOOK_INVALID_RECEIPT', 'Facebook 动态投稿回执无效', { stage: 'review', outcome: 'unknown' })
      return http.get(postId, 'id,from,is_published,is_hidden', accessToken, 'review', signal)
    },
  })
}
