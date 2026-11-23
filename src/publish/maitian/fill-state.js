import { MaitianError } from './errors.js'

// Interpret orchestration states only. Platform selectors and upload steps belong to upstream.
export function fillState(value, platform) {
  if (!value || typeof value !== 'object' || value.id !== platform || typeof value.status !== 'string' || value.status.length > 2000 ||
      typeof value.failed !== 'boolean' || !Array.isArray(value.logs) ||
      value.tabId !== null && value.tabId !== undefined && (!Number.isSafeInteger(value.tabId) || value.tabId < 0)) throw new MaitianError('INCOMPATIBLE_FILL_RESULT', '麦田组件的填写结果格式已变化，请核对原页面')
  const logs = value.logs.slice(-50).map(row => {
    if (!row || !['ok', 'info', 'err'].includes(row.kind) || typeof row.msg !== 'string' || row.msg.length > 20_000) throw new MaitianError('INCOMPATIBLE_FILL_RESULT', '麦田组件的填写日志格式已变化，请核对原页面')
    return { kind: row.kind, msg: row.msg }
  })
  const failed = value.failed || value.logs.some(row => row?.kind === 'err')
  const phase = value.status === '检查登录' ? 'preflighting' : value.status === '填写中' ? 'filling'
    : value.status === '上传中' || /上传.*\d+(?:\.\d+)?%/.test(value.status) ? 'uploading' : 'checking'
  return {
    raw: { id: platform, status: value.status, failed, logs, tabId: value.tabId ?? null }, phase,
    // A completed form is never a publication receipt. Unknown new statuses stay unresolved.
    filled: !failed && ['待你发布', '已填写'].includes(value.status),
  }
}
