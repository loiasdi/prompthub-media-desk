import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_ID } from './task-project.js'
import { MaitianError } from './errors.js'

// Called after holding the profile lock and persisting an explicit snapshot-release intent.
export async function releaseTaskSnapshot(root, record) {
  if (!TASK_ID.test(record.projectId || '')) throw new MaitianError('INVALID_PROJECT', '任务快照标识无效')
  const runs = join(root, 'runs'), directory = join(runs, record.projectId)
  try {
    if (!(await lstat(runs)).isDirectory() || await realpath(runs) !== join(await realpath(root), 'runs') || !(await lstat(directory)).isDirectory()) throw Error('unsafe')
    const file = join(directory, 'media-desk-manifest.json'), info = await lstat(file)
    if (!info.isFile() || info.size > 1_000_000) throw Error('unsafe')
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    if (manifest.version !== 1 || manifest.kind !== 'task' || manifest.snapshotId !== record.projectId || manifest.projectDigest !== record.projectDigest) throw Error('wrong project')
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { await lstat(directory) } catch (missing) { if (missing.code === 'ENOENT') return }
    }
    throw new MaitianError('SNAPSHOT_RELEASE_FAILED', '无法安全释放原任务快照，尚未完成归档')
  }
}
