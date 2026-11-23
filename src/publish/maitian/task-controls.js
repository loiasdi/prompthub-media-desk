import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { TASK_ID } from './task-project.js'
import { MaitianError } from './errors.js'

// Separate from the runner's page journal: two Hosts may request cancellation concurrently.
export class TaskControls {
  constructor(root) { this.root = join(root, 'task-controls') }
  file(runId) {
    if (!TASK_ID.test(runId || '')) throw new MaitianError('INVALID_TASK', '浏览器任务标识无效', 400)
    return join(this.root, `${runId}.json`)
  }
  async cancel(taskId, runId) {
    if (!TASK_ID.test(taskId || '')) throw new MaitianError('INVALID_TASK', '浏览器任务标识无效', 400)
    const file = this.file(runId)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, taskId, runId, cancel: true }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  }
  async cancelled(taskId, runId) {
    try {
      const text = await readFile(this.file(runId), 'utf8')
      if (text.length > 16_000) throw Error('invalid')
      const value = JSON.parse(text)
      if (value.version !== 1 || value.taskId !== taskId || value.runId !== runId || value.cancel !== true) throw Error('invalid')
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw new MaitianError('INVALID_TASK_CONTROL', '无法读取停止请求，执行器已停止后续操作')
    }
  }
}
