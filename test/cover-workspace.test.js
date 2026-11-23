import assert from 'node:assert/strict'
import test from 'node:test'
import { coverAssetLabel, preferredCoverRatio, selectPublishCover, selectPublishCovers, coverSelectOptions } from '../client/cover.js'
import { coverAssetRatio, coverChoices, generatedCoverSelections, normalizeCoverAssets } from '../src/cover-assets.js'
import { createWorkspaceDraft, workspaceAssets } from '../client/workspace.js'
import { COVER_RATIOS, coverReferenceImages, emptyCoverDesign } from '../src/cover-design-schema.js'

test('封面页优先显示已选封面、成图、提示词，再回退到计划画幅', () => {
  const design = emptyCoverDesign()
  design.ratios = ['4:3']
  assert.equal(preferredCoverRatio(design, COVER_RATIOS), '4:3')
  design.variants['16:9'].prompt = '宽版已有提示词'
  assert.equal(preferredCoverRatio(design, COVER_RATIOS), '16:9')
  design.variants['4:3'].imageIds = ['latest']
  assert.equal(preferredCoverRatio(design, COVER_RATIOS), '4:3')
  design.variants['16:9'].imageIds = ['published']
  assert.equal(preferredCoverRatio(design, COVER_RATIOS, 'published'), '16:9')
})

test('已有封面按版本关联、文件名或尺寸补齐比例，普通参考图不被标记为封面', () => {
  const item = { id: 'piece', title: '稿件' }, draft = createWorkspaceDraft(item)
  draft.coverDesign.variants['3:4'].imageIds = ['linked']
  draft.assets = [
    { id: 'linked', type: 'image', role: 'source', name: '自定义名称.png' },
    { id: 'archived', type: 'image', role: 'source', coverResult: true, name: 'cover-16x9-1795412694453.png' },
    { id: 'renamed', type: 'image', role: 'cover', coverResult: true, name: '旧版封面.png', width: 1536, height: 1152 },
    { id: 'reference', type: 'image', role: 'reference', name: '参考图.png', width: 1920, height: 1080 },
  ]
  const projected = workspaceAssets(item, draft)
  assert.deepEqual(projected.slice(0, 3).map(asset => [asset.role, asset.coverRatio]), [['cover', '3:4'], ['cover', '16:9'], ['cover', '4:3']])
  assert.equal(projected[3].role, 'reference')
  assert.equal(projected[3].coverResult, undefined)
  assert.deepEqual(normalizeCoverAssets(projected, draft.coverDesign), projected)
  assert.equal(coverAssetLabel(projected[0]), '封面 · 3:4 · 自定义名称.png')
  assert.equal(coverAssetRatio({ ...projected[0], name: '重命名.png' }), '3:4')
})

test('发布按比例推荐封面，采用最新生成图，选作发布封面时同步对应比例并保留其他比例', () => {
  const assets = [
    { id: 'reference', type: 'image', role: 'reference', width: 1920, height: 1080 },
    { id: 'old', type: 'image', role: 'cover', coverResult: true, coverRatio: '16:9' },
    { id: 'portrait', type: 'image', role: 'cover', coverResult: true, coverRatio: '3:4' },
    { id: 'latest', type: 'image', role: 'cover', coverResult: true, coverRatio: '16:9' },
    { id: 'video', type: 'video' },
  ]
  assert.deepEqual(generatedCoverSelections(assets), { '16x9': 'latest', '3x4': 'portrait' })
  assert.deepEqual(coverChoices(assets, '16x9').map(asset => asset.id), ['old', 'latest', 'reference', 'portrait'])
  const draft = { publish: { title: '发布标题', browser: { profileId: 'custom', covers: { '3x4': 'manual' } } } }
  const selection = selectPublishCover(draft, assets[3])
  assert.equal(selection.selectedCover, 'latest')
  assert.equal(selection.publish.title, '发布标题')
  assert.deepEqual(selection.publish.browser, { profileId: 'custom', covers: { '3x4': 'manual', '16x9': 'latest' } })
  assert.deepEqual(selectPublishCover(draft, undefined), { selectedCover: '', selectedCoverIds: [], publish: draft.publish })
})

test('参考图候选排除所有画幅的封面结果，包括历史和刚入库的成图', () => {
  const design = emptyCoverDesign()
  design.ratios = ['4:3']
  design.variants['3:4'].imageIds = ['portrait-old', 'portrait']
  design.variants['16:9'].imageIds = ['wide']
  const assets = [
    { id: 'portrait-old' }, { id: 'portrait' }, { id: 'wide' },
    { id: 'new-result', coverResult: true },
    { id: 'style-sample', role: 'cover', origin: 'imported' },
    { id: 'reference', origin: 'generated' }, { id: 'video', type: 'video' },
  ].map(asset => ({ type: 'image', ...asset }))
  assert.deepEqual(coverReferenceImages(design, assets).map(asset => asset.id), ['style-sample', 'reference'])
  assert.deepEqual(design.variants['3:4'].imageIds, ['portrait-old', 'portrait'])
  assert.deepEqual(design.variants['16:9'].imageIds, ['wide'])
})


test('封面多选保留顺序、按比例映射，取消选择清理槽位并保留独立设置', () => {
  const wide = { id: 'wide', type: 'image', coverRatio: '16:9' }
  const portrait = { id: 'portrait', type: 'image', coverRatio: '3:4' }
  const wide2 = { ...wide, id: 'wide2' }
  const draft = { publish: { title: '标题', browser: { covers: { '4x3': 'manual' } } } }
  const first = selectPublishCovers(draft, [portrait, wide, wide2])
  assert.equal(first.selectedCover, 'portrait')
  assert.deepEqual(first.selectedCoverIds, ['portrait', 'wide', 'wide2'])
  assert.deepEqual(first.publish.browser.covers, { '4x3': 'manual', '3x4': 'portrait', '16x9': 'wide2' })
  const next = selectPublishCovers(first, [wide])
  assert.equal(next.selectedCover, 'wide')
  assert.deepEqual(next.selectedCoverIds, ['wide'])
  assert.deepEqual(next.publish.browser.covers, { '4x3': 'manual', '16x9': 'wide' })
  assert.deepEqual(selectPublishCovers(next, []).publish.browser.covers, { '4x3': 'manual' })
})

test('封面候选同时显示用途与比例，兼容普通图片尺寸和未知比例', () => {
  const options = coverSelectOptions([
    { id: 'cover', name: '封面.png', src: '/cover.png', type: 'image', role: 'cover', coverRatio: '3:4' },
    { id: 'square', name: '参考.png', type: 'image', role: 'reference', width: 1024, height: 1024 },
    { id: 'unknown', name: '旧图.png', type: 'image', role: 'figure' },
    { id: 'video', type: 'video' },
  ])
  assert.equal(options.length, 3)
  assert.deepEqual(options[0], { value: 'cover', label: '封面.png', thumbnail: '/cover.png', badges: ['封面', '3:4'] })
  assert.deepEqual(options[1].badges, ['参考素材', '1:1'])
  assert.deepEqual(options[2].badges, ['配图', '比例未知'])
})
