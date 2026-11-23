import { MaitianError } from './errors.js'

export const CONTRACT_VERSION = 'maitian-direct-v1'
export const RUNNER_OPERATIONS = ['hello', 'validate', 'open-install', 'open-login', 'preflight', 'open-page', 'open-management', 'fill', 'collect-links']
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const platformId = value => /^[a-z][a-z0-9_-]{0,49}$/.test(value)

export function inspectContract({ bundle, publish }) {
  if (!plain(bundle.PLATFORMS) || !plain(publish.ADAPTERS)) throw new MaitianError('INCOMPATIBLE_CONTRACT', '麦田组件的平台接口已变化，需要更新连接层')
  const operations = Object.fromEntries([
    ['validate', typeof bundle.validate === 'function'],
    ['preflight', typeof publish.preflight === 'function'],
    ['fill', typeof publish.run === 'function'],
    ['collect-links', typeof publish.collectLinks === 'function'],
  ])
  const platforms = {}
  for (const id of Object.keys(publish.ADAPTERS).filter(platformId).slice(0, 100)) {
    const spec = bundle.PLATFORMS[id]
    if (!plain(spec) || !plain(spec.fields)) continue
    const fields = {}
    for (const [name, range] of Object.entries(spec.fields).slice(0, 30)) {
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(name) && Array.isArray(range) && range.length === 2 && range.every(n => Number.isSafeInteger(n) && n >= 0) && range[0] <= range[1]) fields[name] = range
    }
    platforms[id] = {
      name: typeof spec.name === 'string' ? spec.name.slice(0, 100) : id,
      fields,
      mapped: ['xhs', 'channels'].includes(id),
      // An adapter's presence does not prove form behaviour or a live platform test.
      liveVerified: false,
      canOpenLogin: typeof publish.ADAPTERS[id]?.url === 'string',
      canCollectLinks: Boolean(operations['collect-links'] && publish.ADAPTERS[id]?.links),
    }
  }
  return { contractVersion: CONTRACT_VERSION, operations, platforms }
}

export function preflightResult(value, platform) {
  const row = plain(value) ? value[platform] : null
  if (!plain(row) || typeof row.ok !== 'boolean' ||
      row.reason !== undefined && (typeof row.reason !== 'string' || row.reason.length > 2000) ||
      row.tabId !== undefined && (!Number.isSafeInteger(row.tabId) || row.tabId < 0)) throw new MaitianError('INCOMPATIBLE_PREFLIGHT_RESULT', '麦田组件的登录预检结果格式已变化，需要更新连接层')
  // No identity is inferred from page readiness, adapter names, or process-local tab IDs.
  return { summary: { ok: row.ok, ...(row.reason && { reason: row.reason }) }, tabId: row.tabId }
}

export function validationResult(value) {
  if (!plain(value) || !Array.isArray(value.errors) || !Array.isArray(value.warnings) ||
      [...value.errors, ...value.warnings].some(row => typeof row !== 'string') || value.errors.length + value.warnings.length > 2000 ||
      [...value.errors, ...value.warnings].some(row => row.length > 20_000)) throw new MaitianError('INCOMPATIBLE_RESULT', '麦田组件的校验结果格式已变化，需要更新连接层')
  return { errors: value.errors, warnings: value.warnings }
}

export function probeChrome() {
  const unavailable = () => { throw new MaitianError('PROBE_SIDE_EFFECT', '组件探测尝试操作浏览器，已停止') }
  const api = new Proxy({}, { get: () => unavailable })
  return {
    runtime: { id: 'media-desk-maitian-probe' },
    debugger: { onDetach: { addListener() {} }, attach: unavailable, detach: unavailable, sendCommand: unavailable },
    tabs: api, scripting: api, storage: api,
  }
}
