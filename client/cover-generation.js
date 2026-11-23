import { COVER_RATIOS } from '../src/cover-design-schema.js'
import { t } from './i18n.js'

export function normalizeCoverImageResult(result, ratios, { revision } = {}) {
  const invalid = () => { throw new Error(t('封面生成响应不完整，请先检查素材库，避免重复生成')) }
  if (!result || typeof result !== 'object') invalid()
  const results = result.results === undefined && ratios.length === 1 && result.asset ? [{ ratio: ratios[0], asset: result.asset }] : result.results
  const errors = result.errors === undefined ? [] : result.errors
  if (!Array.isArray(results) || !Array.isArray(errors)) invalid()
  const seen = new Set()
  for (const row of [...results, ...errors]) {
    if (!row || !ratios.includes(row.ratio) || seen.has(row.ratio)) invalid()
    seen.add(row.ratio)
  }
  if (seen.size !== ratios.length || results.some(row => row.asset?.type !== 'image' || typeof row.asset.id !== 'string' || !row.asset.id || typeof row.asset.src !== 'string' || !row.asset.src) || errors.some(row => typeof row.error !== 'string' || !row.error)) invalid()
  if (new Set(results.map(row => row.asset.id)).size !== results.length) invalid()
  if (!results.length) throw new Error(errors.map(row => `${row.ratio}：${row.error}`).join('\n'))
  if (revision !== undefined) {
    const workspace = result.workspace
    if (!workspace || !Number.isInteger(workspace.revision) || workspace.revision <= revision || !workspace.coverDesign?.variants || !['assets', 'folders', 'hidden', 'trash'].every(key => Array.isArray(workspace[key]))) invalid()
    if (results.some(({ asset }) => !workspace.assets.some(row => row.id === asset.id && row.src === asset.src && row.type === 'image'))) invalid()
  }
  return { ...result, results, errors }
}

// 单张沿用原接口字段；兼容尚未重载的 Host 返回 { asset, workspace }。
export async function generateCoverImages(ratios, request, { onResult } = {}) {
  if (!Array.isArray(ratios) || !ratios.length || ratios.length > COVER_RATIOS.length || new Set(ratios).size !== ratios.length || [...ratios].some(ratio => !COVER_RATIOS.includes(ratio))) throw new Error(t('封面比例无效'))
  ratios = [...ratios]
  const accept = async result => {
    await onResult?.(result)
    return result
  }
  const single = async ratio => normalizeCoverImageResult(await request({ ratio }), [ratio])
  if (ratios.length === 1) return accept(await single(ratios[0]))
  let batch
  try { batch = await request({ ratios }) }
  catch (error) {
    // 旧 Host 会在调用生图接口前拒绝 ratios。仅对此明确的校验错误降级，
    // 模型失败、超时或保存冲突都不自动重发，避免重复生图和扣费。
    if (error?.status !== 400 || error.message !== '封面比例无效') throw error
    return legacy()
  }
  return accept(normalizeCoverImageResult(batch, ratios))

  async function legacy() {
    const results = [], errors = []
    let workspace, failure
    // 每张结果立即交给草稿，下一次通过保存队列提交关联并取得最新修订。
    for (const [index, ratio] of ratios.entries()) {
      let result
      try { result = await single(ratio) }
      catch (error) {
        failure ||= error
        errors.push({ ratio, error: error?.message || String(error) })
        // 断网、异常响应、修订冲突及存储/权限问题后，不再继续付费请求。
        if (!error?.status || [401, 403, 404, 409, 507].includes(error.status)) {
          errors.push(...ratios.slice(index + 1).map(ratio => ({ ratio, error: t('已停止后续生成，请检查素材库和保存状态后重试') })))
          break
        }
        continue
      }
      workspace = result.workspace
      results.push(...result.results)
      await accept(result)
    }
    if (!results.length) throw Object.assign(new Error(errors.map(row => `${row.ratio}：${row.error}`).join('\n')), { status: failure?.status })
    return { workspace, results, errors }
  }
}
