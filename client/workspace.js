import { emptyCoverDesign, sanitizeCoverDesign } from '../src/cover-design-schema.js'
// 内容制作草稿与服务端工作区的同步，以及页面所需的素材投影。
import React from 'react'
import { lang, t } from './i18n.js'
import { sourceAssets, sourceCopy, ROLE_NAMES } from '../src/workspace-schema.js'
import { createWorkspaceStore } from './workspace-store.js'

let sequence = 0
export const workspaceId = () => `work_${Date.now().toString(36)}_${++sequence}`
export const ASSET_ROLE_NAMES = ROLE_NAMES

const PUBLISH_SOURCE_FIELDS = ['title', 'description', 'platform', 'tags']
const publishSource = sourceCopy

const localizeAsset = asset => ({ ...asset, name: asset.nameKey ? t(asset.nameKey, asset.nameVars) : asset.name })
export function contentAssets(item) {
  return sourceAssets(item).map(localizeAsset)
}

export function createWorkspaceDraft(item) {
  const assets = contentAssets(item)
  return {
    assets: [], hidden: [], trash: [], edits: {}, folders: [],
    selectedVideo: item.sample ? assets.find(a => a.type === 'video')?.id || '' : '',
    selectedCover: assets.find(a => a.role === 'cover')?.id || '',
    imageIds: [], segments: item.sample ? segmentsFromShots(item) : [],
    ideaText: null, outlineText: '', promptText: null, coverPromptText: null, coverDesign: emptyCoverDesign(item.production?.title || item.title),
    promptSettings: { model: 'general', ratio: '9:16', duration: '30', style: '', referenceIds: [] },
    publish: { ...publishSource(item), format: 'video', mode: 'manual', when: '', visibility: 'public' },
    publishEdited: {}, publishSource: publishSource(item),
  }
}

export function workspaceAssets(item, draft) {
  const hidden = new Set(draft.hidden)
  return [...new Map([...sourceAssets(item), ...draft.assets].map(a => [a.id, a])).values()].filter(a => !hidden.has(a.id)).map(a => ({ ...localizeAsset(a), ...draft.edits[a.id] }))
}

// 从最新内容投影默认文案，不在 getSnapshot 中反复写回旧 item 的状态。
export function resolveWorkspaceDraft(item, stored, assets = workspaceAssets(item, stored)) {
  const source = publishSource(item)
  const available = new Set(assets.map(a => a.id))
  const sources = new Set(assets.map(a => a.src))
  const publish = { ...stored.publish }
  const publishEdited = { ...stored.publishEdited }
  // 老版本话题未记录编辑标记，非空文案按手动编辑保留。
  if (publishEdited.tags === undefined && publish.tags && stored.publishSource.tags === undefined) publishEdited.tags = true
  for (const field of PUBLISH_SOURCE_FIELDS) if (!publishEdited[field]) publish[field] = source[field]
  return {
    ...stored, publish, publishEdited,
    coverDesign: sanitizeCoverDesign(stored.coverDesign, assets, item.production?.title || item.title),
    publishChanges: PUBLISH_SOURCE_FIELDS.filter(field => publishEdited[field] && (field !== 'tags' || stored.publishSource.tags !== undefined) && stored.publishSource[field] !== source[field]),
    selectedVideo: available.has(stored.selectedVideo) ? stored.selectedVideo : '',
    selectedCover: available.has(stored.selectedCover) ? stored.selectedCover : '',
    imageIds: stored.imageIds.filter(id => available.has(id)),
    segments: stored.segments.map(segment => ({ ...segment, image: sources.has(segment.image) ? segment.image : '' })),
    promptSettings: { ...stored.promptSettings, referenceIds: stored.promptSettings.referenceIds.filter(id => available.has(id)) },
  }
}

export function patchWorkspaceDraft(item, stored, patch) {
  const before = resolveWorkspaceDraft(item, stored)
  const changes = typeof patch === 'function' ? patch(before) : patch
  const next = { ...before, ...changes, publish: { ...before.publish, ...changes.publish }, publishEdited: { ...before.publishEdited, ...changes.publishEdited }, publishSource: { ...before.publishSource } }
  const source = publishSource(item)
  for (const field of PUBLISH_SOURCE_FIELDS) {
    if (changes.publish && Object.hasOwn(changes.publish, field) && changes.publish[field] !== before.publish[field]) {
      next.publishEdited[field] = changes.publishEdited?.[field] ?? (changes.publish[field] !== source[field])
      next.publishSource[field] = source[field]
    }
  }
  return next
}

const workspaceStore = createWorkspaceStore({ create: createWorkspaceDraft, resolve: resolveWorkspaceDraft, patch: patchWorkspaceDraft })
export const flushWorkspace = id => workspaceStore.flush(id)
export const flushAllWorkspaces = () => workspaceStore.flushAll()
export const importWorkspaceFiles = (id, files, folder) => workspaceStore.importFiles(id, files, folder)
export const recycleWorkspaceAsset = (id, assetId, restore) => workspaceStore.recycle(id, assetId, restore)
export const runCoverAction = (item, path, body) => workspaceStore.action(item.id, path, body)
export const prepareWorkspacePublish = (id, platform, options) => workspaceStore.action(id, 'publish/prepare', { platform, options })
export const cancelWorkspaceImport = id => workspaceStore.cancelImport(id)

export function useWorkspace(item) {
  const entry = React.useSyncExternalStore(workspaceStore.subscribe, () => workspaceStore.get(item))
  const locale = lang()
  const { assets: files, hidden, edits } = entry.draft
  const assets = React.useMemo(() => workspaceAssets(item, { assets: files, hidden, edits }), [item, files, hidden, edits, locale])
  const draft = React.useMemo(() => resolveWorkspaceDraft(item, entry.draft, assets), [item, entry.draft, assets])
  const update = patch => workspaceStore.update(item, patch)
  const syncPublish = () => update(d => {
    const source = publishSource(item)
    return { publish: { ...d.publish, ...Object.fromEntries(d.publishChanges.map(field => [field, source[field]])) }, publishEdited: Object.fromEntries(d.publishChanges.map(field => [field, false])) }
  })
  return { draft, update, assets, syncPublish, persistence: entry, retrySave: () => workspaceStore.flush(item.id), reloadWorkspace: () => workspaceStore.reload(item.id) }
}

export function segmentsFromShots(item) {
  const shots = item.production?.shots || []
  if (shots.length) return shots.map((shot, index) => ({
    id: workspaceId(), title: shot.visual || t('片段 {n}', { n: index + 1 }), seconds: shot.seconds || 5,
    voice: shot.voice || '', prompt: shot.prompt || shot.visual || '', image: shot.src || '',
  }))
  if (!item.sample) return []
  const en = lang() === 'en'
  return [
    [en ? 'Open with a detail' : '开场 · 从一个细节开始', 'stairs.jpg', 'Slow push-in on a concrete staircase in afternoon light. A person enters the frame, pauses, and looks up. Hold on the quiet moment. Natural ambient sound.'],
    [en ? 'Show the change' : '推进 · 让变化被看见', 'ink.jpg', 'Medium shot of a person at a desk, comparing two sketches. The camera moves gently from the first sketch to the second. Keep the same wardrobe and soft window light.'],
    [en ? 'Leave a moment to linger' : '收尾 · 留下一个停顿', 'hills.jpg', 'Wide static shot of rolling hills in the late afternoon. A small figure walks along the ridge. Let the wind and the unhurried movement carry the ending. No on-screen text.'],
  ].map(([title, file, prompt]) => ({ id: workspaceId(), title, seconds: 10, voice: '', prompt, image: `media-desk/assets/${file}` }))
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}

export function downloadText(text, name, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name.replace(/[\\/:*?"<>|]/g, '-')
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function promptDocument(item, draft) {
  if (typeof draft.promptText === 'string') return draft.promptText
  const settings = draft.promptSettings
  const assets = workspaceAssets(item, draft)
  const types = { image: '图片', video: '视频', audio: '音频' }
  const references = settings.referenceIds.map(id => assets.find(a => a.id === id)).filter(Boolean)
  const referenceText = references.length
    ? `${references.map((asset, index) => `${index + 1}. ${asset.name}（${t(types[asset.type])} · ${t('素材用途')}：${t(ASSET_ROLE_NAMES[asset.role] || '制作素材')}）`).join('\n')}\n\n${t('请在视频工具中上传这些参考文件，导出文本不包含附件')}`
    : t('未选择参考素材')
  return `# ${item.production?.title || item.title}\n\n${t('目标模型')}：${settings.model}\n${t('画面比例')}：${settings.ratio}\n${t('目标时长')}：${settings.duration} ${t('秒')}\n\n${settings.style}\n\n## ${t('参考素材')}\n\n${referenceText}\n\n${draft.segments.map((s, i) => `## ${i + 1}. ${s.title} · ${s.seconds}s\n\n${s.prompt}${s.voice ? `\n\n${t('旁白')}：${s.voice}` : ''}`).join('\n\n')}`
}
