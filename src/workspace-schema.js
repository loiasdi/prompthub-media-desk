import { playableVideo } from './inspiration-source.js'
import { emptyCoverDesign, sanitizeCoverDesign } from './cover-design-schema.js'
import { MAX_PROMPT_TEXT } from './video-prompt-document.js'

// 内容工作区的文件登记与字段校验。浏览器和 Host 共用文件身份规则。
export const WORKSPACE_SCHEMA = 1
export const ROLE_NAMES = { reference: '参考素材', cover: '封面', figure: '配图', storyboard: '分镜图', final: '视频成片', source: '制作素材', voice: '配音', music: '背景音乐', clip: '视频片段' }
export const fileId = src => `file:${src}`
export const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const string = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : ''
const list = (value, max = 2000) => Array.isArray(value) ? value.slice(0, max) : []
const refs = (value, available) => [...new Set(list(value).filter(id => typeof id === 'string' && available.has(id)))]

export function sourceAssets(item) {
  const rows = []
  const add = (asset, name, role, type = 'image', nameKey = '', nameVars = {}) => {
    if (!asset?.src || rows.some(row => row.src === asset.src)) return
    rows.push({ name, role, type, origin: 'generated', folder: '', ...asset, nameKey, nameVars, id: fileId(asset.src) })
  }
  add(item.production?.cover, '封面原图', 'cover', 'image', '封面原图')
  item.production?.images?.forEach((a, i) => add(a, a.caption || `配图 ${i + 1}`, 'figure', 'image', a.caption ? '' : '配图 {n}', { n: i + 1 }))
  item.production?.shots?.forEach((a, i) => add(a, `分镜 ${i + 1}`, 'storyboard', 'image', '分镜 {n}', { n: i + 1 }))
  for (const media of item.mediaItems || []) add(media, media.name || item.title, 'reference', media.kind === 'video' ? 'video' : 'image')
  add(item.media, item.title, 'reference', playableVideo(item) ? 'video' : 'image')
  if (item.sample) {
    add({ src: 'media-desk/assets/v-ink.mp4', poster: 'media-desk/assets/v-ink-poster.jpg' }, '成片预览.mp4', 'final', 'video', '成片预览.mp4')
    add({ src: 'media-desk/assets/ink.jpg' }, '封面备选.jpg', 'cover', 'image', '封面备选.jpg')
    add({ src: 'media-desk/assets/stairs.jpg' }, '场景参考.jpg', 'reference', 'image', '场景参考.jpg')
  }
  return rows
}

export function sourceCopy(item) {
  return { title: item.production?.title || item.title, description: item.production?.description ?? (item.production?.article || item.body || ''), tags: item.production?.topics ?? (item.tags || []).map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' '), platform: item.platform || '小红书' }
}

export function emptyWorkspace(item) {
  const assets = sourceAssets(item)
  return {
    schemaVersion: WORKSPACE_SCHEMA, revision: 0, assets, hidden: [], trash: [], edits: {}, folders: [],
    selectedVideo: item.sample ? assets.find(a => a.type === 'video')?.id || '' : '', selectedCover: assets.find(a => a.role === 'cover')?.id || '', imageIds: [], segments: [],
    ideaText: null, outlineText: '', promptText: null, coverPromptText: null, coverDesign: emptyCoverDesign(item.production?.title || item.title),
    promptSettings: { model: 'general', ratio: '9:16', duration: '30', style: '', referenceIds: [] },
    publish: { ...sourceCopy(item), format: 'video', mode: 'manual', when: '', visibility: 'public' }, publishEdited: {}, publishSource: sourceCopy(item),
  }
}

// 在 Store 写入时登记生成结果，重画后仍可在素材中找到上一版文件。
export function registerWorkspaceSources(item) {
  if (!item.workspace) return
  const ws = item.workspace
  const known = new Map((ws.assets || []).map(a => [a.id, a]))
  for (const asset of sourceAssets(item)) known.set(asset.id, { ...known.get(asset.id), ...asset })
  ws.assets = [...known.values()]
}

export function sanitizeWorkspace(item, input, current) {
  if (!object(input)) throw fail('工作区数据无效')
  const ws = structuredClone(current)
  const live = new Map(ws.assets.filter(a => !ws.hidden.includes(a.id)).map(a => [a.id, a]))
  const all = new Map(ws.assets.map(a => [a.id, a]))
  const folders = list(input.folders, 200).filter(f => object(f) && /^[\w-]{1,100}$/.test(f.id) && ['video', 'image', 'audio'].includes(f.type) && typeof f.name === 'string' && f.name.trim()).map(f => ({ id: f.id, name: f.name.trim().slice(0, 120), type: f.type }))
  if (new Set(folders.map(f => f.id)).size !== folders.length) throw fail('文件夹标识重复')
  const folderFor = (id, type) => folders.some(f => f.id === id && f.type === type) ? id : ''
  ws.folders = folders
  ws.edits = Object.fromEntries(Object.entries(object(input.edits) ? input.edits : {}).filter(([id]) => all.has(id)).map(([id, edit]) => {
    const asset = all.get(id)
    return [id, { name: string(edit?.name, 240).trim() || asset.name, role: Object.hasOwn(ROLE_NAMES, edit?.role) ? edit.role : asset.role, folder: folderFor(edit?.folder, asset.type) }]
  }))
  ws.selectedVideo = live.get(input.selectedVideo)?.type === 'video' ? input.selectedVideo : ''
  ws.selectedCover = live.get(input.selectedCover)?.type === 'image' ? input.selectedCover : ''
  ws.imageIds = refs(input.imageIds, new Set([...live.values()].filter(a => a.type === 'image').map(a => a.id)))
  for (const field of ['ideaText', 'outlineText']) {
    if (input[field] !== undefined) {
      if (input[field] !== null && (typeof input[field] !== 'string' || input[field].length > 200000)) throw fail('灵感或大纲内容无效或超过 200000 字符')
      ws[field] = input[field]
    }
  }
  if (input.promptText !== undefined) {
    if (input.promptText !== null && (typeof input.promptText !== 'string' || input.promptText.length > MAX_PROMPT_TEXT)) throw fail('视频提示词文档无效或超过 500000 字符')
    ws.promptText = input.promptText
  }
  if (input.coverPromptText !== undefined) {
    if (input.coverPromptText !== null && (typeof input.coverPromptText !== 'string' || input.coverPromptText.length > MAX_PROMPT_TEXT)) throw fail('封面提示词无效或超过 500000 字符')
    ws.coverPromptText = input.coverPromptText
  }
  ws.coverDesign = sanitizeCoverDesign(input.coverDesign ?? current.coverDesign, [...live.values()], item.production?.title || item.title)
  const settings = input.promptSettings || {}
  ws.promptSettings = { model: ['general', 'seedance', 'sora', 'veo'].includes(settings.model) ? settings.model : 'general', ratio: ['9:16', '16:9', '1:1'].includes(settings.ratio) ? settings.ratio : '9:16', duration: ['15', '30', '60', '90', '180'].includes(String(settings.duration)) ? String(settings.duration) : '30', style: string(settings.style, 10000), referenceIds: refs(settings.referenceIds, new Set(live.keys())) }
  const sources = new Set([...live.values()].map(a => a.src))
  const seen = new Set()
  ws.segments = list(input.segments, 300).filter(s => object(s) && /^[\w-]{1,100}$/.test(s.id) && !seen.has(s.id) && seen.add(s.id)).map(s => ({ id: s.id, title: string(s.title, 1000), seconds: Math.max(1, Math.min(180, Number(s.seconds) || 5)), voice: string(s.voice, 10000), prompt: string(s.prompt, 30000), image: sources.has(s.image) ? s.image : '' }))
  const publish = input.publish || {}
  ws.publish = { title: string(publish.title, 2000), description: string(publish.description, 200000), platform: ['公众号', '小红书', '抖音', 'B站', '视频号', 'TikTok', 'Instagram', 'YouTube', 'X'].includes(publish.platform) ? publish.platform : '小红书', format: publish.format === 'images' ? 'images' : 'video', tags: string(publish.tags, 10000), mode: ['manual', 'now', 'scheduled'].includes(publish.mode) ? publish.mode : 'manual', when: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(publish.when) ? publish.when : '', visibility: 'public' }
  ws.publishEdited = Object.fromEntries(['title', 'description', 'platform', 'tags'].map(key => [key, input.publishEdited?.[key] === true || key === 'tags' && input.publishEdited?.tags === undefined && Boolean(input.publish?.tags) && input.publishSource?.tags === undefined]))
  ws.publishSource = Object.fromEntries(['title', 'description', 'platform', 'tags'].map(key => [key, string(input.publishSource?.[key], key === 'description' ? 200000 : key === 'tags' ? 10000 : 2000)]))
  ws.schemaVersion = WORKSPACE_SCHEMA
  return ws
}
