// 分享文案的链接提取和来源判断；不把平台页面当作可播放的视频文件。
export function parseSharedLink(input) {
  const raw = String(input || '').trim()
  const match = raw.match(/https?:\/\/[^\s<>"）】]+/i)
  const url = (match?.[0] || raw).replace(/[),，。；;！!\]]+$/, '')
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('请输入完整的 http 或 https 链接，或包含链接的分享文案') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http 和 https 链接')
  return { url: parsed.href, text: raw === url || raw === parsed.href ? '' : raw }
}
export function sourceKind(item) {
  if (['image', 'video', 'quote', 'note'].includes(item.kind)) return item.kind
  try {
    const url = new URL(item.url)
    if (/(^|\.)(douyin\.com|iesdouyin\.com|kuaishou\.com|gifshow\.com|bilibili\.com|b23\.tv|tiktok\.com|youtu\.be|youtube\.com)$/.test(url.hostname)) return 'video'
    if (/\.(mp4|webm|mov)$/i.test(url.pathname)) return 'video'
    if (/\.(png|jpe?g|webp|gif)$/i.test(url.pathname)) return 'image'
  } catch { /* 没有链接的旧数据按原类型显示 */ }
  return item.kind || 'note'
}
export function playableVideo(item) {
  const src = item.media?.src || ''
  return sourceKind(item) === 'video' && (/^media-desk\/files\//.test(src) || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(src))
}
export function sourceImage(item) {
  if (playableVideo(item)) return item.media?.poster || ''
  return item.media?.poster || item.media?.src || ''
}
