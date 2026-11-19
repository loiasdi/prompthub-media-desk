import { PublishError } from '../errors.js'

export function readFacebookStatus(data, receiptId, { story = false } = {}) {
  const status = data?.id === receiptId && data.status
  const video = status?.video_status
  const phase = status?.publishing_phase
  const publishStatus = phase?.publish_status
  if (!video || typeof video !== 'string') throw new PublishError('FACEBOOK_INVALID_STATUS', 'Facebook 未返回可确认的发布状态', { stage: 'review', outcome: 'unknown' })
  const baseline = { receiptId, platformState: video }
  // Expiry is not a rejected upload and must not reopen publication.
  if (story && video === 'expired') return { ...baseline, status: 'unknown' }
  const phases = [status.uploading_phase, status.processing_phase, phase]
  if (['error', 'expired', 'upload_failed'].includes(video) || phases.some(row => row?.status === 'error' || Boolean(row?.error)) || ['error', 'rejected'].includes(publishStatus)) return { ...baseline, status: 'rejected' }
  if (['complete', 'completed'].includes(phase?.status) && publishStatus === 'published') {
    return { ...baseline, status: 'published', privacyStatus: 'public', ...(!story && { url: `https://www.facebook.com/reel/${receiptId}` }) }
  }
  if (['draft', 'scheduled'].includes(publishStatus)) return { status: 'unknown', receiptId }
  // Encoding readiness alone does not prove either a Reel or a Story is public.
  if (['processing', 'ready', 'uploading', 'upload_complete'].includes(video) || ['in_progress', 'not_started'].includes(phase?.status)) return { ...baseline, status: 'pending_review' }
  return { status: 'unknown', receiptId }
}

function postId(value, pageId) {
  const id = Number.isSafeInteger(value) && value > 0 ? String(value) : value
  return typeof id === 'string' && (/^[1-9]\d{0,31}$/.test(id) || id.startsWith(`${pageId}_`) && new RegExp(`^${pageId}_[1-9]\\d{0,31}$`).test(id)) ? id : null
}

function storyUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && ['facebook.com', 'www.facebook.com'].includes(url.hostname) && /^\/stories\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?\/?$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash) return url.href
  } catch { /* An absent or untrusted URL is not a publish failure. */ }
  return undefined
}

export function readFacebookStoryList(data, receiptId, { pageId, workId, mediaType }) {
  if (!Array.isArray(data?.data) || !/^[1-9]\d{0,31}$/.test(receiptId) || !/^[1-9]\d{0,31}$/.test(pageId) || !['photo', 'video'].includes(mediaType)) {
    throw new PublishError('FACEBOOK_INVALID_STORIES', 'Facebook 未返回可确认的快拍列表', { stage: 'review', outcome: 'unknown' })
  }
  const matches = data.data.filter(row => row?.media_id === receiptId && row.media_type === mediaType)
  if (!matches.length) return { status: 'pending_review', receiptId }
  if (matches.length !== 1) return { status: 'unknown', receiptId }
  const story = matches[0]
  const id = postId(story.post_id, pageId)
  if (!id || (workId && id !== workId)) return { status: 'unknown', receiptId }
  if (story.status === 'PUBLISHED') return { status: 'published', receiptId, publicId: id, privacyStatus: 'public', ...(storyUrl(story.url) && { url: storyUrl(story.url) }) }
  if (story.status === 'ARCHIVED') return { status: 'unknown', receiptId, workId: id, privacyStatus: 'public', platformState: 'ARCHIVED' }
  return { status: 'unknown', receiptId, workId: id }
}
