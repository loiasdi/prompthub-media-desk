import { MaitianError } from './errors.js'
import { MAPPED_PLATFORMS, COVER_RATIOS } from './platforms.js'

export { MAPPED_PLATFORMS, COVER_RATIOS } from './platforms.js'
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

export function normalizePlatforms(platform, platforms) {
  if (Array.isArray(platforms)) {
    const unique = [...new Set(platforms)]
    if (!unique.length || unique.some(item => typeof item !== 'string' || !Object.hasOwn(MAPPED_PLATFORMS, item))) {
      throw new MaitianError('UNMAPPED_PLATFORM', '请选择麦田支持的视频分发平台', 400)
    }
    return unique
  }
  if (typeof platform === 'string' && Object.hasOwn(MAPPED_PLATFORMS, platform)) return [platform]
  throw new MaitianError('UNMAPPED_PLATFORM', '请选择麦田支持的视频分发平台', 400)
}

export function createProject({ id, copy, platform, platforms, video, covers = {}, durationSec }) {
  const targets = normalizePlatforms(platform, platforms)
  const singleLegacy = !Array.isArray(platforms)
  if ((singleLegacy && copy?.platform !== MAPPED_PLATFORMS[targets[0]]) || copy?.format !== 'video') throw new MaitianError('UNMAPPED_PLATFORM', '稿件平台须与目标一致，麦田工程仅支持单篇视频', 400)
  if (!/^[\w-]{1,200}$/.test(id) || !validFile(video)) throw new MaitianError('INVALID_PROJECT', '工程标识或视频文件名无效', 400)
  if (typeof copy.title !== 'string' || typeof copy.description !== 'string' || copy.title.length > 2000 || copy.description.length > 200000) throw new MaitianError('INVALID_COPY', '发布文案无效', 400)
  const allowedRatios = new Set(targets.flatMap(target => COVER_RATIOS[target]))
  const chosen = {}
  for (const [ratio, file] of Object.entries(covers)) {
    if (!allowedRatios.has(ratio) || !validFile(file) || !/\.(?:png|jpe?g)$/i.test(file)) throw new MaitianError('INVALID_COVER', '工程封面无效', 400)
    chosen[ratio] = file
  }
  const topics = topicsOf(copy.tags || '')
  const platformEntries = {}
  const caption = [copy.title, copy.description, topics.map(topic => `#${topic}`).join(' ')].filter(value => value.trim()).join('\n\n')
  for (const target of targets) {
    let fields
    if (target === 'channels') {
      const shortTitle = typeof copy.browser?.shortTitle === 'string' ? copy.browser.shortTitle.trim() : ''
      if (!shortTitle) throw new MaitianError('INVALID_COPY', '选择视频号时必须填写视频号短标题', 400)
      fields = { shortTitle, body: copy.description, topics }
    }
    else if (target === 'bilibili' || target === 'youtube') fields = { title: copy.title, desc: copy.description, tags: topics }
    else if (target === 'x') fields = { text: caption }
    else if (target === 'instagram') fields = { caption }
    else fields = { title: copy.title, body: copy.description, topics }
    const selectedCovers = COVER_RATIOS[target].filter(ratio => Object.hasOwn(chosen, ratio))
    platformEntries[target] = { ...fields, covers: target === 'instagram' ? selectedCovers.slice(0, 1) : selectedCovers }
  }
  const data = {
    version: 1, id, name: copy.title, video, requiredTags: [], covers: chosen,
    platforms: platformEntries,
  }
  if (Number.isFinite(durationSec) && durationSec > 0) data.durationSec = durationSec
  if (copy.mode === 'scheduled') {
    if (copy.timezone !== 'Asia/Shanghai') throw new MaitianError('UNSUPPORTED_FORM_TIMEZONE', '当前只开放已约定的北京时间预约工程', 400)
    data.schedule = scheduleISO(copy.when, copy.timezone)
  } else if (!['manual', 'now'].includes(copy.mode)) throw new MaitianError('INVALID_MODE', '发布方式无效', 400)
  return data
}
