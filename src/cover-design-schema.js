export const COVER_RATIOS = ['3:4', '16:9', '4:3']
export const COVER_STYLES = ['交给模型推荐', '爆款大字压顶风', '巨字拆分冲击风', '小白科普问答风', '教程清单风', '产品测评榜单风', '种草推荐风', '贴纸拼贴入门风', '黑底效率工作流风']
export function emptyCoverDesign(title = '') {
  return { illustrations: [], step: 0, personIds: [], materialIds: [], colorIds: [], title: String(title || '').slice(0, 2000), titleEdited: false, style: COVER_STYLES[0], colors: '', requirements: '', ratios: [...COVER_RATIOS], variants: Object.fromEntries(COVER_RATIOS.map(ratio => [ratio, { prompt: '', imageIds: [] }])) }
}

export function coverReferenceImages(design, assets) {
  // 新成图入库时有标记；旧成图从各画幅的结果记录识别，不依赖当前画幅或素材用途。
  const resultIds = new Set(COVER_RATIOS.flatMap(ratio => {
    const ids = design?.variants?.[ratio]?.imageIds
    return Array.isArray(ids) ? ids : []
  }))
  return assets.filter(asset => asset.type === 'image' && asset.coverResult !== true && !resultIds.has(asset.id))
}

export function sanitizeCoverDesign(value, assets, defaultTitle = '') {
  const defaults = emptyCoverDesign(defaultTitle)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const images = new Set(assets.filter(a => a.type === 'image').map(a => a.id))
  const references = new Set(coverReferenceImages(value, assets).map(a => a.id))
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''
  const refs = (value, allowed = images) => [...new Set(Array.isArray(value) ? value.filter(id => allowed.has(id)) : [])].slice(0, 20)
  const seen = new Set()
  const illustrations = (Array.isArray(value.illustrations) ? value.illustrations : []).filter(row => row && typeof row === 'object' && typeof row.id === 'string' && /^[\w-]{1,100}$/.test(row.id) && !seen.has(row.id) && seen.add(row.id)).slice(0, 50).map(row => ({ id: row.id, title: text(row.title, 2000), requirements: text(row.requirements, 20000), prompt: text(row.prompt, 50000), ratio: COVER_RATIOS.includes(row.ratio) ? row.ratio : '3:4', imageIds: refs(row.imageIds) }))
  return { illustrations, step: Math.max(0, Math.min(5, Math.floor(Number(value.step) || 0))), personIds: refs(value.personIds, references), materialIds: refs(value.materialIds, references), colorIds: refs(value.colorIds, references), title: text(value.title, 2000) || defaults.title, titleEdited: value.titleEdited === true && Boolean(text(value.title, 2000).trim()), style: COVER_STYLES.includes(value.style) ? value.style : defaults.style, colors: text(value.colors, 10000), requirements: text(value.requirements, 20000), ratios: COVER_RATIOS.filter(r => Array.isArray(value.ratios) && value.ratios.includes(r)), variants: Object.fromEntries(COVER_RATIOS.map(ratio => [ratio, { prompt: text(value.variants?.[ratio]?.prompt, 50000), imageIds: refs(value.variants?.[ratio]?.imageIds) }])) }
}
