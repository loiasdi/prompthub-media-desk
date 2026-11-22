import assert from 'node:assert/strict'
import test from 'node:test'
import { setLanguagePreference } from '../client/i18n.js'
import { contentAssets, createWorkspaceDraft, patchWorkspaceDraft, promptDocument, resolveWorkspaceDraft, workspaceAssets, workspaceContentPresence } from '../client/workspace.js'
import { emptyWorkspace, sanitizeWorkspace } from '../src/workspace-schema.js'
import { applyOps } from '../src/ops.js'
import { COVER_STYLES } from '../src/cover-design-schema.js'

const idea = () => ({ id: 'content-1', title: '原始灵感', body: '原始笔记', platform: '小红书' })
const produced = () => ({ ...idea(), production: { title: '正式标题', article: '正式正文', cover: { src: 'media-desk/files/cover-a.png' }, images: [{ src: 'media-desk/files/figure-a.png', caption: '场景 A' }] } })

test('导航绿点：默认字段不算内容，修改内容或稿件标题不误亮封面', () => {
  const original = { id: 'presence', title: '原始标题' }
  const stored = createWorkspaceDraft(original)
  const presence = item => workspaceContentPresence(item, resolveWorkspaceDraft(item, stored), [])
  assert.deepEqual(presence(original), { idea: true, outline: false, article: false, prompts: false, cover: false, assets: false, publish: false })
  assert.equal(presence({ ...original, title: '修改后的选题标题' }).cover, false)
  assert.equal(presence({ ...original, production: { title: '修改后的稿件标题', article: '' } }).cover, false)
  // 旧工作区没有标题编辑记录，不能把保留的旧默认标题认作手动输入。
  delete stored.coverDesign.titleEdited
  assert.equal(presence({ ...original, title: '另一个标题' }).cover, false)
})

test('导航绿点：正文为空时，独立填写稿件标题、描述或话题也算内容', () => {
  for (const patch of [{ title: '单独编辑的稿件标题' }, { description: '单独填写的描述' }, { topics: '#单独话题' }]) {
    const item = { id: 'metadata-presence', title: '选题', body: '' }
    assert.deepEqual(applyOps({ items: [item] }, [{ op: 'update_production', id: item.id, ...patch }]).errors, [])
    const presence = () => workspaceContentPresence(item, resolveWorkspaceDraft(item, createWorkspaceDraft(item)), [])
    assert.equal(item.production.article, '')
    assert.equal(presence().article, true)
    applyOps({ items: [item] }, [{ op: 'update_production', id: item.id, title: item.title, description: '  ', topics: '\n' }])
    assert.equal(presence().article, false)
  }
})

test('导航绿点：手改封面标题经过保存、改稿和清空后保留正确状态', () => {
  const item = { id: 'cover-presence', title: '选题' }
  const current = emptyWorkspace(item)
  const initial = createWorkspaceDraft(item)
  const edited = patchWorkspaceDraft(item, initial, { coverDesign: { ...initial.coverDesign, title: '独立封面标题' } })
  const saved = sanitizeWorkspace(item, edited, current)
  const renamed = { ...item, production: { title: '新稿件标题' } }
  const reopened = resolveWorkspaceDraft(renamed, { ...createWorkspaceDraft(renamed), ...saved })
  assert.equal(workspaceContentPresence(renamed, reopened, []).cover, true)
  const cleared = patchWorkspaceDraft(renamed, reopened, { coverDesign: { ...reopened.coverDesign, title: '  ' } })
  const clearedSaved = sanitizeWorkspace(renamed, cleared, saved)
  assert.equal(workspaceContentPresence(renamed, resolveWorkspaceDraft(renamed, clearedSaved), []).cover, false)
})

test('导航绿点：选择封面风格或调整比例算内容，恢复默认后取消标记', () => {
  const item = { id: 'style-presence', title: '选题' }
  let stored = createWorkspaceDraft(item)
  const presence = () => workspaceContentPresence(item, resolveWorkspaceDraft(item, stored), []).cover
  stored = patchWorkspaceDraft(item, stored, { coverDesign: { ...stored.coverDesign, style: '教程清单风' } })
  assert.equal(presence(), true)
  stored = patchWorkspaceDraft(item, stored, { coverDesign: { ...stored.coverDesign, style: COVER_STYLES[0] } })
  assert.equal(presence(), false)
  stored = patchWorkspaceDraft(item, stored, { coverDesign: { ...stored.coverDesign, ratios: ['16:9'] } })
  assert.equal(presence(), true)
  stored = patchWorkspaceDraft(item, stored, { coverDesign: { ...stored.coverDesign, ratios: [...createWorkspaceDraft(item).coverDesign.ratios].reverse() } })
  assert.equal(presence(), false)
})

test('发布草稿：先显示卡片再成稿，未编辑文案持续跟随稿件更新', () => {
  const stored = createWorkspaceDraft(idea())
  const item = produced()
  const first = resolveWorkspaceDraft(item, stored)
  assert.equal(first.publish.title, '正式标题')
  assert.equal(first.publish.description, '正式正文')
  const updated = { ...item, platform: '抖音', production: { ...item.production, title: '改后标题', article: '改后正文' } }
  const next = resolveWorkspaceDraft(updated, stored)
  assert.equal(next.publish.title, '改后标题')
  assert.equal(next.publish.description, '改后正文')
  assert.equal(next.publish.platform, '抖音')
  assert.deepEqual(next.publishChanges, [])
  assert.equal(stored.publish.title, '原始灵感') // 投影不修改共享快照。
})

test('发布草稿：保留手改字段，只提示这些字段的来源变化', () => {
  const item = produced()
  let stored = patchWorkspaceDraft(item, createWorkspaceDraft(item), { publish: { title: '发布专用标题', tags: '#创作' } })
  const updated = { ...item, production: { ...item.production, title: '新版稿件标题', article: '新版正文' } }
  let current = resolveWorkspaceDraft(updated, stored)
  assert.equal(current.publish.title, '发布专用标题')
  assert.equal(current.publish.description, '新版正文')
  assert.equal(current.publish.tags, '#创作')
  assert.deepEqual(current.publishChanges, ['title'])
  stored = patchWorkspaceDraft(updated, stored, d => ({ publish: { ...d.publish, mode: 'scheduled' } }))
  current = resolveWorkspaceDraft(updated, stored)
  assert.deepEqual(current.publishChanges, ['title'])
  assert.equal(current.publish.mode, 'scheduled')
})

test('发布草稿：同步变化字段后恢复自动跟随，同时保留其他手改内容', () => {
  const item = produced()
  let stored = patchWorkspaceDraft(item, createWorkspaceDraft(item), { publish: { title: '独立标题', description: '独立简介' } })
  const updated = { ...item, production: { ...item.production, title: '新版稿件标题' } }
  assert.deepEqual(resolveWorkspaceDraft(updated, stored).publishChanges, ['title'])
  stored = patchWorkspaceDraft(updated, stored, { publish: { title: '新版稿件标题' }, publishEdited: { title: false } })
  assert.deepEqual(resolveWorkspaceDraft(updated, stored).publishChanges, [])
  const newer = { ...updated, production: { ...updated.production, title: '第三版标题' } }
  const current = resolveWorkspaceDraft(newer, stored)
  assert.equal(current.publish.title, '第三版标题')
  assert.equal(current.publish.description, '独立简介')
  assert.equal(current.publishEdited.description, true)
})

test('素材重画：新文件不会继承旧文件的移除、名称、用途和发布选择', () => {
  const item = produced()
  const [cover, figure] = contentAssets(item)
  const stored = {
    ...createWorkspaceDraft(item), hidden: [cover.id],
    edits: { [cover.id]: { name: '旧封面', role: 'reference' }, [figure.id]: { name: '旧配图' } },
    imageIds: [figure.id],
    promptSettings: { model: 'general', ratio: '9:16', duration: '30', style: '', referenceIds: [figure.id] },
  }
  const nextItem = { ...item, production: { ...item.production, cover: { src: 'media-desk/files/cover-b.png' }, images: [{ src: 'media-desk/files/figure-b.png', caption: '场景 B' }] } }
  const assets = workspaceAssets(nextItem, stored)
  assert.equal(assets.length, 2)
  assert.equal(assets[0].name, '封面原图')
  assert.equal(assets[0].role, 'cover')
  assert.equal(assets[1].name, '场景 B')
  assert.notEqual(assets[0].id, cover.id)
  assert.notEqual(assets[1].id, figure.id)
  const current = resolveWorkspaceDraft(nextItem, stored)
  assert.equal(current.selectedCover, '')
  assert.deepEqual(current.imageIds, [])
  assert.deepEqual(current.promptSettings.referenceIds, [])
})

test('素材排序：同一文件调整位置后，名称与发布顺序仍跟随原文件', () => {
  const item = produced()
  item.production.images.push({ src: 'media-desk/files/figure-b.png', caption: '场景 B' })
  const images = contentAssets(item).filter(a => a.role === 'figure')
  const stored = { ...createWorkspaceDraft(item), edits: { [images[0].id]: { name: '已整理的 A' } }, imageIds: [images[1].id, images[0].id] }
  const reordered = { ...item, production: { ...item.production, images: [...item.production.images].reverse() } }
  const current = resolveWorkspaceDraft(reordered, stored)
  const assets = workspaceAssets(reordered, current)
  assert.deepEqual(current.imageIds.map(id => assets.find(a => a.id === id).src), ['media-desk/files/figure-b.png', 'media-desk/files/figure-a.png'])
  assert.equal(assets.find(a => a.src.endsWith('figure-a.png')).name, '已整理的 A')
})

test('素材替换：旧视频不会自动变成新视频，其他有效选择不受影响', () => {
  const item = { ...produced(), kind: 'video', media: { src: 'media-desk/files/video-a.mp4' } }
  const video = contentAssets(item).find(a => a.type === 'video')
  const stored = { ...createWorkspaceDraft(item), selectedVideo: video.id }
  const updated = { ...item, media: { src: 'media-desk/files/video-b.mp4' } }
  const current = resolveWorkspaceDraft(updated, stored)
  assert.equal(current.selectedVideo, '')
  assert.equal(current.selectedCover, stored.selectedCover)
})

test('提示词导出：包含目标时长、按选择顺序排列的参考文件和实际用途', () => {
  const item = produced()
  let stored = createWorkspaceDraft(item)
  const image = contentAssets(item).find(a => a.role === 'figure')
  stored = { ...stored, assets: [{ id: 'local-audio', src: 'blob:audio', name: '声音.wav', type: 'audio', role: 'source' }], edits: { [image.id]: { name: '参考场景.png', role: 'reference' }, 'local-audio': { role: 'music' } }, promptSettings: { model: 'seedance', ratio: '16:9', duration: '60', style: '自然光', referenceIds: ['local-audio', image.id] }, segments: [{ title: '开场', seconds: 5, prompt: '推进镜头', voice: '开场旁白' }] }
  const doc = promptDocument(item, stored)
  for (const text of ['目标模型：seedance', '画面比例：16:9', '目标时长：60 秒', '自然光', '声音.wav（音频 · 素材用途：背景音乐）', '参考场景.png（图片 · 素材用途：参考素材）', '5s', '推进镜头', '开场旁白', '导出文本不包含附件']) assert.ok(doc.includes(text), text)
  assert.ok(doc.indexOf('声音.wav') < doc.indexOf('参考场景.png'))
  assert.ok(!doc.includes('blob:audio'))
})

test('提示词导出：不会包含已移除或未选的文件，英文说明可用', () => {
  const item = produced()
  const image = contentAssets(item).find(a => a.role === 'figure')
  const stored = createWorkspaceDraft(item)
  stored.hidden = [image.id]
  stored.promptSettings.referenceIds = [image.id, 'missing']
  setLanguagePreference('en')
  try {
    const doc = promptDocument(item, stored)
    assert.ok(doc.includes('Target duration：30'))
    assert.ok(doc.includes('No references selected'))
    assert.ok(!doc.includes('场景 A'))
    assert.ok(!doc.includes('missing'))
  } finally { setLanguagePreference('zh') }
})

test('稿件标题、描述和话题作为发布来源，手动编辑的三个字段不被覆盖', () => {
  const item = { ...produced(), production: { ...produced().production, description: '一句发布简介', topics: '#AI #创作' } }
  let stored = createWorkspaceDraft(item)
  assert.equal(stored.publish.description, '一句发布简介')
  assert.equal(stored.publish.tags, '#AI #创作')
  const updated = { ...item, production: { ...item.production, title: '更新标题', description: '更新简介', topics: '#更新话题' } }
  let current = resolveWorkspaceDraft(updated, stored)
  assert.equal(current.publish.title, '更新标题')
  assert.equal(current.publish.description, '更新简介')
  assert.equal(current.publish.tags, '#更新话题')
  stored = patchWorkspaceDraft(item, stored, { publish: { title: '手改标题', description: '手改简介', tags: '#手改话题' } })
  current = resolveWorkspaceDraft(updated, stored)
  assert.equal(current.publish.title, '手改标题')
  assert.equal(current.publish.description, '手改简介')
  assert.equal(current.publish.tags, '#手改话题')
  assert.deepEqual(current.publishChanges, ['title', 'description', 'tags'])
  stored = patchWorkspaceDraft(updated, stored, { publish: { tags: updated.production.topics }, publishEdited: { tags: false } })
  assert.equal(resolveWorkspaceDraft({ ...updated, production: { ...updated.production, topics: '' } }, stored).publish.tags, '')
})

test('旧版发布话题缺少编辑标记时保留，稿件话题可从灵感标签继承', () => {
  const item = { ...produced(), tags: ['AI', '#效率'] }
  const stored = createWorkspaceDraft(item)
  assert.equal(stored.publish.tags, '#AI #效率')
  stored.publish.tags = '#原有发布话题'
  delete stored.publishSource.tags
  const current = resolveWorkspaceDraft(item, stored)
  assert.equal(current.publish.tags, '#原有发布话题')
  assert.equal(current.publishEdited.tags, true)
})


test('灵感和大纲独立保存，更新正文不覆盖前期创作内容', async () => {
  const { emptyWorkspace, sanitizeWorkspace } = await import('../src/workspace-schema.js')
  const item = idea()
  const current = emptyWorkspace(item)
  const input = { ...current, ideaText: '想讲角色为什么千篇一律', outlineText: '开场痛点\n五块人设\n角色对比\n结尾预告' }
  const saved = sanitizeWorkspace(item, input, current)
  const next = { ...produced(), workspace: saved }
  const resolved = resolveWorkspaceDraft(next, { ...createWorkspaceDraft(next), ...saved })
  assert.equal(resolved.ideaText, input.ideaText)
  assert.equal(resolved.outlineText, input.outlineText)
  assert.equal(next.production.article, '正式正文')
  assert.equal(sanitizeWorkspace(item, { ...saved, promptText: '视频提示词' }, saved).outlineText, input.outlineText)
  assert.throws(() => sanitizeWorkspace(item, { ...saved, outlineText: {} }, saved), /大纲内容无效/)
})

test('Bluesky 发布平台通过工作区校验并保持选择', async () => {
  const { emptyWorkspace, sanitizeWorkspace } = await import('../src/workspace-schema.js')
  const item = idea()
  const current = emptyWorkspace(item)
  const saved = sanitizeWorkspace(item, { ...current, publish: { ...current.publish, platform: 'Bluesky' } }, current)
  assert.equal(saved.publish.platform, 'Bluesky')
})
