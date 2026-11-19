import assert from 'node:assert/strict'
import test from 'node:test'
import { preferredCoverRatio } from '../client/cover.js'
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
