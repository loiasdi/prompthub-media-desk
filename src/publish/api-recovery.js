import { createHash } from 'node:crypto'
import { withPublishActivity, assertNoPublishActivities } from './activity.js'
import { activeRecord, backupPublishRecords, providerOf, readPublishRecords, writePublishRecords } from './records.js'
import { fail } from '../workspace-schema.js'

const FIELDS = ['id', 'taskId', 'recordDigest', 'actor', 'reason', 'confirmed', 'oldHostsStopped', 'platformChecked']
const text = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
export const apiRecordDigest = record => createHash('sha256').update(JSON.stringify(record)).digest('hex')
export const interruptedApiRecord = record => providerOf(record) === 'api' && record.status === 'publishing' && Number.isFinite(record.deadline) && record.deadline <= Date.now()

// Legacy API tasks have no process identity. Require explicit confirmation of every old Host,
// and reject any live operation known to this version. Elapsed time is only UI eligibility.
export async function recoverApiTask(store, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !FIELDS.includes(key)) ||
      typeof request.id !== 'string' || !/^[\w-]{1,160}$/.test(request.id) || typeof request.taskId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.taskId) || typeof request.recordDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.recordDigest) ||
      !text(request.actor, 200) || !text(request.reason, 2000) || !['confirmed', 'oldHostsStopped', 'platformChecked'].every(key => request[key] === true)) throw fail('请填写核对操作者和原因，并确认旧 Host 已停止且已检查平台', 400)
  return withPublishActivity(store, 'api-recover', ({ root: capturedRoot, token }) => store.run(async () => {
    await store.refresh()
    if (store.root !== capturedRoot) throw fail('工作台目录已变化，请重新读取投稿记录', 409)
    await assertNoPublishActivities(capturedRoot, { exceptToken: token })
    const records = await readPublishRecords(capturedRoot)
    const record = records.find(row => providerOf(row) === 'api' && row.itemId === request.id && row.taskId === request.taskId)
    if (!record) throw fail('找不到投稿记录', 404)
    if (record.status === 'unknown' && record.interruptionRecovery?.sourceRecordDigest === request.recordDigest) return record
    if (apiRecordDigest(record) !== request.recordDigest) throw fail('投稿记录已变化，请重新读取并核对', 409)
    if (!interruptedApiRecord(record) || records.some(activeRecord)) throw fail('投稿仍在执行或不需要中断核对，请等待并重新读取记录', 409)
    const backup = await backupPublishRecords(capturedRoot)
    const at = new Date().toISOString()
    record.interruptionRecovery = {
      action: 'interrupted-api-confirmed', at, actor: request.actor.trim(), reason: request.reason.trim(),
      oldHostsStopped: true, platformChecked: true, sourceRecordDigest: request.recordDigest,
      previousStatus: record.status, previousDeadline: record.deadline, ...backup,
    }
    record.status = 'unknown'; record.updatedAt = at
    record.message = '已人工确认旧 Host 停止；投稿结果仍待核对，原回执与防重继续保留，可继续升级发布记录'
    await writePublishRecords(capturedRoot, records)
    return record
  }))
}
