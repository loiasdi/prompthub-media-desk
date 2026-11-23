import { MaitianError } from './errors.js'

export const MAPPED_PLATFORMS = { xhs: '小红书', channels: '视频号' }
export const COVER_RATIOS = { xhs: ['3x4'], channels: ['3x4', '4x3'] }
const validFile = value => typeof value === 'string' && value.length <= 240 && /^[^/\\\x00-\x1f]+\.(?:mp4|mov|m4v|png|jpg|jpeg)$/i.test(value) && !value.startsWith('.')

export function topicsOf(value) {
  if (typeof value !== 'string') throw new MaitianError('INVALID_TOPICS', '话题格式无效', 400)
  return [...new Set(value.split(/[\s,，]+/u).map(topic => topic.replace(/^#+/, '')).filter(Boolean))]
}

// Convert wall time without consulting the Host's default timezone. Reject both DST gaps and folds.
export function scheduleISO(when, timezone) {
  if (typeof when !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) || typeof timezone !== 'string' || timezone.length > 100) throw new MaitianError('INVALID_TIME', '请确认完整预约时间与时区', 400)
  let formatter
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  catch { throw new MaitianError('INVALID_TIMEZONE', '预约时区无效', 400) }
  const wall = instant => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
  }
  const nominal = Date.parse(when + ':00Z')
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 16) !== when) throw new MaitianError('INVALID_TIME', '预约日期无效', 400)
  const offsets = new Set()
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const time = nominal + hours * 3600_000
    offsets.add(Date.parse(wall(time) + ':00Z') - time)
  }
  const matches = [...offsets].map(offset => nominal - offset).filter(time => wall(time) === when)
  if (matches.length !== 1) throw new MaitianError('AMBIGUOUS_TIME', '该本地时间不存在或重复，请选择无歧义的预约时间', 400)
  return new Date(matches[0]).toISOString()
}

export function createProject({ id, copy, platform, video, covers = {}, durationSec }) {
  if (!Object.hasOwn(MAPPED_PLATFORMS, platform) || copy?.platform !== MAPPED_PLATFORMS[platform] || copy.format !== 'video') throw new MaitianError('UNMAPPED_PLATFORM', '当前麦田工程只支持小红书或视频号单篇视频', 400)
  if (!/^[\w-]{1,200}$/.test(id) || !validFile(video)) throw new MaitianError('INVALID_PROJECT', '工程标识或视频文件名无效', 400)
  if (typeof copy.title !== 'string' || typeof copy.description !== 'string' || copy.title.length > 2000 || copy.description.length > 200000) throw new MaitianError('INVALID_COPY', '发布文案无效', 400)
  const chosen = {}
  for (const [ratio, file] of Object.entries(covers)) {
    if (!COVER_RATIOS[platform].includes(ratio) || !validFile(file) || !/\.(?:png|jpe?g)$/i.test(file)) throw new MaitianError('INVALID_COVER', '工程封面无效', 400)
    chosen[ratio] = file
  }
  const fields = platform === 'xhs' ? { title: copy.title, body: copy.description } : { shortTitle: copy.browser?.shortTitle || '', body: copy.description }
  const data = {
    version: 1, id, name: copy.title, video, requiredTags: [], covers: chosen,
    platforms: { [platform]: { ...fields, topics: topicsOf(copy.tags || ''), covers: Object.keys(chosen) } },
  }
  if (Number.isFinite(durationSec) && durationSec > 0) data.durationSec = durationSec
  if (copy.mode === 'scheduled') {
    if (copy.timezone !== 'Asia/Shanghai') throw new MaitianError('UNSUPPORTED_FORM_TIMEZONE', '当前只开放已约定的北京时间预约工程', 400)
    data.schedule = scheduleISO(copy.when, copy.timezone)
  } else if (!['manual', 'now'].includes(copy.mode)) throw new MaitianError('INVALID_MODE', '发布方式无效', 400)
  return data
}
