import { assertPublicUrl } from './harvest.js'
import { imageBuffer, readImageResponse } from './images.js'
import { tr } from './i18n.js'
export { imageBuffer }

// 封面参考图通过标准 Images edits 上传；无参考图使用 generations。
export async function generateCoverHttpImage(image, prompt, refs, ratio, fetchImpl = fetch) {
  if (!image.baseUrl || !image.model || !image.apiKey) throw new Error(tr('请先在设置中配置生图接口'))
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
  const signal = AbortSignal.timeout(300000)
  try {
    const response = await fetchImpl(`${image.baseUrl}/${refs.length ? 'images/edits' : 'images/generations'}`, { method: 'POST', headers, body, signal, redirect: 'error' })
    const result = await readImageResponse(response, image, fetchImpl, signal, { strictDownload: true })
    return imageBuffer(result.buffer)
  } catch (err) {
    if (signal.aborted) throw new Error(tr('生图超时，可以重试'))
    if (err.name === 'TypeError') throw new Error(tr('连不上生图服务：{reason}', { reason: err.cause?.code ?? 'HTTP' }))
    throw err
  }
}
