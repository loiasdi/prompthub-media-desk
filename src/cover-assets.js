import { COVER_RATIOS } from './cover-design-schema.js'

export function selectedCoverIds(draft) {
  // 兼容旧调用方只清空默认封面的操作，避免从残留多选数组重新选回。
  if (draft.selectedCover === '') return []
  return [...new Set([draft.selectedCover, ...(Array.isArray(draft.selectedCoverIds) ? draft.selectedCoverIds : [])].filter(id => typeof id === 'string' && id))]
}

export function coverAssetRatio(asset) {
  if (!asset || asset.type !== 'image') return ''
  if (COVER_RATIOS.includes(asset.coverRatio)) return asset.coverRatio
  const filename = asset.coverResult && /^cover-(3x4|16x9|4x3)-\d+\./.exec(asset.name || '')
  if (filename) return filename[1].replace('x', ':')
  const width = Number(asset.width || asset.w), height = Number(asset.height || asset.h)
  if (!(width > 0 && height > 0)) return ''
  return COVER_RATIOS.find(ratio => {
    const [w, h] = ratio.split(':').map(Number)
    return Math.abs(width / height - w / h) <= 0.01
  }) || ''
}

// 根据生成标记与旧版本关联补齐元数据；归档后的图片不依赖当前版本记录。
export function normalizeCoverAssets(assets, design) {
  const linked = new Map(COVER_RATIOS.flatMap(ratio => {
    const ids = design?.variants?.[ratio]?.imageIds
    return (Array.isArray(ids) ? ids : []).map(id => [id, ratio])
  }))
  return assets.map(asset => {
    if (asset.type !== 'image' || (!asset.coverResult && !linked.has(asset.id))) return asset
    const ratio = COVER_RATIOS.includes(asset.coverRatio) ? asset.coverRatio : linked.get(asset.id) || coverAssetRatio(asset)
    return { ...asset, coverResult: true, role: !asset.role || asset.role === 'source' ? 'cover' : asset.role, ...(ratio ? { coverRatio: ratio } : {}) }
  })
}

export function coverChoices(assets, ratio) {
  const target = ratio?.replace('x', ':')
  const rank = asset => (target && coverAssetRatio(asset) === target ? 2 : 0) + (asset.role === 'cover' ? 1 : 0)
  return assets.filter(asset => asset.type === 'image').toSorted((a, b) => rank(b) - rank(a))
}

export function generatedCoverSelections(assets) {
  return Object.fromEntries(assets.filter(asset => asset.type === 'image' && asset.coverResult && asset.role === 'cover' && coverAssetRatio(asset))
    .map(asset => [coverAssetRatio(asset).replace(':', 'x'), asset.id]))
}
