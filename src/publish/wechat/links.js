export function validWeChatLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return false
  try {
    const url = new URL(value)
    if (url.origin !== 'https://mp.weixin.qq.com' || url.username || url.password || url.hash) return false
    if (/^\/s\/[A-Za-z0-9_-]{6,128}$/.test(url.pathname)) return !url.search
    if (url.pathname !== '/s') return false
    const keys = [...url.searchParams.keys()]
    return keys.length === new Set(keys).size && keys.every(key => ['__biz', 'mid', 'idx', 'sn', 'chksm'].includes(key)) && /^[A-Za-z0-9+/=]{1,256}$/.test(url.searchParams.get('__biz') || '') && /^[1-9]\d{0,31}$/.test(url.searchParams.get('mid') || '') && url.searchParams.get('idx') === '1' && /^[a-f0-9]{32}$/i.test(url.searchParams.get('sn') || '') && (!url.searchParams.has('chksm') || /^[a-f0-9]{16,128}$/i.test(url.searchParams.get('chksm')))
  } catch { return false }
}
// uploadimg historically returns http://mmbiz.qpic.cn/... . Only that fixed
// official image CDN is accepted; HTML always uses HTTPS, never plaintext.
export function weChatImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'mmbiz.qpic.cn' || url.port || url.username || url.password || url.hash || url.pathname === '/') return null
    if ([...url.searchParams.keys()].some(key => /^(?:access_token|app_secret|appsecret|secret|authorization)$/i.test(key))) return null
    url.protocol = 'https:'
    return url.href
  } catch { return null }
}
