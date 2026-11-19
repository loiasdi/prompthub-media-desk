import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '../workspace-schema.js'

// Operations are called under the same cross-Host Store lock used for revisions and directory migration.
export const activeRecord = record => record?.status === 'publishing' && Date.now() < record.deadline
export function visibleRecord(record) {
  const result = record?.status === 'publishing' && !activeRecord(record)
    ? { ...record, status: 'unknown', message: '投稿中断，无法确认结果。请先在平台创作中心核对。' } : record
  return result?.coverResult?.status === 'pending' && !activeRecord(record)
    ? { ...result, coverResult: { status: 'unknown', message: '视频回执已保存，但缩略图设置结果未确认，请在平台创作中心核对；不要重新上传视频。' } } : result
}

export async function readPublishRecords(root) {
  const path = join(root, '.publish-records.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 20_000_000) throw fail('发布记录无法安全读取', 500)
    const data = JSON.parse(await readFile(path, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.records)) throw fail('发布记录格式无法读取', 500)
    return data.records
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw fail('发布记录无法安全读取', 500)
  }
}

export async function writePublishRecords(root, records) {
  const path = join(root, '.publish-records.json')
  const temp = join(root, `.state-lock-publish-${randomUUID()}.tmp`)
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ version: 1, records }))
      await file.sync()
    } finally { await file.close() }
    await rename(temp, path)
    if (process.platform !== 'win32') {
      const dir = await open(root, 'r')
      try { await dir.sync() } finally { await dir.close() }
    }
  } finally { await rm(temp, { force: true }) }
}
