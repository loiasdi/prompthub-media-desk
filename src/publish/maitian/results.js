import { MaitianError } from './errors.js'
import { stampSnapshotTerminal } from '../record-policy.js'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const STATES = { '已发布': 'published', '审核中': 'pending_review', '定时': 'scheduled', '审核不通过': 'rejected', '已拒绝': 'rejected', published: 'published', pending_review: 'pending_review', scheduled: 'scheduled', rejected: 'rejected' }
const HOSTS = { xhs: new Set(['www.xiaohongshu.com', 'xiaohongshu.com', 'creator.xiaohongshu.com']), channels: new Set(['channels.weixin.qq.com']) }

export function workURL(platform, value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) throw new MaitianError('INVALID_WORK_URL', '作品链接必须是目标平台的 HTTPS 地址', 400)
  let url
  try { url = new URL(value) } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !Object.hasOwn(HOSTS, platform) || !HOSTS[platform].has(url.hostname)) throw new MaitianError('INVALID_WORK_URL', '作品链接必须是目标平台的 HTTPS 地址', 400)
  if ([...url.searchParams.keys()].some(key => /^(?:cookie|authorization|access[_-]?token|refresh[_-]?token|password|session(?:id)?|credential)$/i.test(key))) throw new MaitianError('INVALID_WORK_URL', '作品链接包含凭证字段，请使用平台公开作品链接', 400)
  return url.href
}

export function workId(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)) throw new MaitianError('INVALID_WORK_ID', '平台作品 ID 无效', 400)
  return value
}

function text(value, limit, privatePaths) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new MaitianError('INCOMPATIBLE_LINK_RESULT', '麦田组件的查询结果格式已变化，请在平台人工核对')
  let result = value
  const paths = privatePaths.filter(path => typeof path === 'string' && path.length > 1).flatMap(path => {
    // macOS commonly reports both /var and its canonical /private/var alias.
    const alias = path.startsWith('/private/') ? path.slice(8) : /^\/(?:var|tmp)(?:\/|$)/.test(path) ? `/private${path}` : null
    return alias ? [path, alias] : [path]
  })
  for (const path of [...new Set(paths)].sort((a, b) => b.length - a.length)) result = result.split(path).join('[本机路径]')
  return result.replace(/(?:wss?|https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?[^\s]*/gi, '[本机调试地址]')
    .replace(/(?:Cookie|Authorization)\s*[:=][^\r\n]+/gi, '[凭证已省略]')
    .replace(/<html\b[\s\S]*|<body\b[\s\S]*/gi, '[页面内容已省略]')
}

// An explicit future workId is consumed as an identifier, never derived from a URL or title.
// It still cannot establish the first association with this task.
export function linkResult(value, platform, { privatePaths = [] } = {}) {
  const row = plain(value) ? value[platform] : null
  if (!plain(row) || typeof row.status !== 'string' || !row.status || row.status.length > 2000) throw new MaitianError('INCOMPATIBLE_LINK_RESULT', '麦田组件的查询结果格式已变化，请在平台人工核对')
  const rejectedFields = []
  let url = null, id = null
  try { url = workURL(platform, row.url) } catch { rejectedFields.push('url') }
  try { id = workId(row.workId) } catch { rejectedFields.push('workId') }
  const status = text(row.status, 2000, privatePaths)
  const result = { status, url, time: text(row.time, 2000, privatePaths), note: text(row.note, 5000, privatePaths),
    ...(id && { workId: id }), normalizedStatus: Object.hasOwn(STATES, status) ? STATES[status] : null,
    ...(rejectedFields.length && { rejectedFields }),
  }
  if (row.candidateCount !== undefined) {
    if (!Number.isSafeInteger(row.candidateCount) || row.candidateCount < 0 || row.candidateCount > 100_000) throw new MaitianError('INCOMPATIBLE_LINK_RESULT', '麦田组件的候选数量格式已变化，请在平台人工核对')
    result.candidateCount = row.candidateCount
  }
  // time remains raw: the baseline does not distinguish publication from scheduling time.
  return result
}

export function applyReview(record, review) {
  const candidate = review.result, association = record.association
  const sameWork = Boolean(association?.source === 'manual-confirmed' && association.workId && candidate.workId === association.workId)
  const canUpdate = sameWork && candidate.normalizedStatus && !candidate.rejectedFields?.length && candidate.candidateCount !== 0
  review.needsConfirmation = Boolean(candidate.normalizedStatus && !canUpdate)
  review.matchedAssociatedId = sameWork
  if (canUpdate) {
    record.status = candidate.normalizedStatus
    record.evidenceSource = 'upstream-matched-id'
    record.url = candidate.url || association.url || null
    record.message = '麦田查询结果与已人工关联的作品 ID 一致'
  } else record.message = candidate.normalizedStatus ? '麦田返回了候选结果，请在平台核对并人工关联；不会据此认定本次发布成功' : '麦田尚未返回可确认的发布结果；保留当前状态和防重'
  record.lastReview = review
  stampSnapshotTerminal(record, review.queriedAt)
  record.reviews = [...(record.reviews || []), review].slice(-20)
}
