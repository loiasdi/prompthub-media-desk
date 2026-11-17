import { assertPublicUrl } from './harvest.js'
import { imageBuffer } from './images.js'
export { imageBuffer }

// 封面参考图通过标准 Images edits 上传；无参考图使用 generations。
export async function generateCoverHttpImage(image, prompt, refs, ratio, fetchImpl = fetch) {
  if (!image.baseUrl || !image.model || !image.apiKey) throw new Error('请先在设置中配置生图接口')
  await assertPublicUrl(image.baseUrl)
  const size = { '3:4': '1152x1536', '16:9': '1536x864', '4:3': '1536x1152' }[ratio]
  let body, headers = { authorization: `Bearer ${image.apiKey}` }
  const extra = image.extra ? JSON.parse(image.extra) : {}
  const request = { ...extra, model: image.model, prompt, n: 1, size, ...(image.quality ? { quality: image.quality } : {}) }
  if (refs.length) {
    body = new FormData()
    for (const [key, value] of Object.entries(request)) body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    for (const ref of refs) body.append('image[]', new Blob([ref.data], { type: ref.mediaType }), ref.name)
  } else { headers['content-type'] = 'application/json'; body = JSON.stringify(request) }
  const response = await fetchImpl(`${image.baseUrl}/${refs.length ? 'images/edits' : 'images/generations'}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(300000), redirect: 'error' })
  const data = await response.json()
  if (!response.ok) throw new Error(`封面生图失败（${response.status}），请检查模型是否支持${refs.length ? '参考图编辑' : '图片生成'}`)
  const entry = data.data?.[0] || data.images?.[0]
  if (!entry?.b64_json) throw new Error('封面接口需返回 b64_json 图片，请在附加参数中设置 response_format: b64_json（若模型支持）')
  return imageBuffer(Buffer.from(entry.b64_json, 'base64'))
}
