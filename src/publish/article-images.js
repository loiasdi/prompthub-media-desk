// Explicit local-asset references, never URLs or arbitrary HTML. Shared by the
// editor, readiness checks and Host so they agree on order and missing assets.
const pattern = () => /\[\[image:([A-Za-z0-9_.%~-]{1,6144})\]\]/g
function decode(value) {
  try {
    const id = decodeURIComponent(value)
    return id && id.length <= 2048 && !/[\x00-\x1f\x7f]/.test(id) ? id : null
  } catch { return null }
}
// Workspace IDs are file:<local src>, not UUIDs. Encoding preserves the exact
// identity without turning a marker into an HTML tag or a remotely fetched URL.
export const articleImageMarker = id => `[[image:${encodeURIComponent(id)}]]`
export const articleImageIds = text => [...new Set([...String(text).matchAll(pattern())].map(match => decode(match[1])).filter(Boolean))]
export const articleImageSyntaxIssue = text => String(text).replace(pattern(), (marker, id) => decode(id) ? '' : marker).includes('[[image:') ? '正文配图标记无效，请重新插入配图。' : ''
export const replaceArticleImages = (text, replace) => text.replace(pattern(), (marker, id) => decode(id) ? replace(decode(id)) : marker)
export function articleImageParts(text) {
  const parts = [], matches = [...text.matchAll(pattern())]
  let offset = 0
  for (const match of matches) {
    const id = decode(match[1])
    if (!id) throw new TypeError('Invalid article image reference')
    parts.push({ text: text.slice(offset, match.index) }, { imageId: id })
    offset = match.index + match[0].length
  }
  parts.push({ text: text.slice(offset) })
  return parts
}
