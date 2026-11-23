// Public Maitian video-project protocol. Shared by the editor and Host so saved
// selections and exported fields use the same platform IDs and cover ratios.
export const MAITIAN_PLATFORMS = [
  { id: 'bilibili', name: 'B站', ratios: ['4x3'], desc: '标题 · 简介 · 标签 · 4:3 封面' },
  { id: 'xhs', name: '小红书', ratios: ['3x4'], desc: '标题 · 正文 · 话题 · 3:4 封面' },
  { id: 'douyin', name: '抖音', ratios: ['3x4', '4x3'], desc: '标题 · 正文 · 话题 · 3:4 与 4:3 封面' },
  { id: 'channels', name: '视频号', ratios: ['3x4', '4x3'], desc: '短标题 · 正文 · 话题 · 3:4 与 4:3 封面' },
  { id: 'youtube', name: 'YouTube', ratios: ['16x9'], desc: '标题 · 简介 · 标签 · 16:9 封面' },
  { id: 'x', name: 'X', ratios: [], desc: '标题与正文 · 话题标签 · 视频' },
  { id: 'instagram', name: 'Instagram', ratios: ['16x9', '4x3'], desc: '配文 · 话题标签 · 16:9 或 4:3 封面' },
]
export const MAPPED_PLATFORMS = Object.fromEntries(MAITIAN_PLATFORMS.map(p => [p.id, p.name]))
export const COVER_RATIOS = Object.fromEntries(MAITIAN_PLATFORMS.map(p => [p.id, p.ratios]))
export const MAITIAN_COVER_RATIOS = ['3x4', '4x3', '16x9']
