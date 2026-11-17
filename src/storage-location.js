import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'

export function storageLocation(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  let config = {}
  try { config = JSON.parse(readFileSync(join(home, 'media-desk-storage.json'), 'utf8')) }
  catch (err) { if (err.code !== 'ENOENT') throw err }
  const root = env.MEDIA_DESK_DATA_DIR || config.root
  if (root && !isAbsolute(root)) throw new Error('工作台数据目录必须是绝对路径')
  return { root: root || join(home, 'media-desk'), configured: Boolean(root), markdown: env.MEDIA_DESK_MARKDOWN === '1' || config.markdown === true }
}
