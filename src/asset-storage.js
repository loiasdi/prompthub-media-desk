import { mkdir, realpath, readdir, stat } from 'node:fs/promises'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { validAssetPath } from './asset-rules.js'

const safePart = value => typeof value === 'string' && /^[\w-]+$/.test(value)
export { validAssetPath }

export async function contentAssetDirectory(root, id) {
  if (!safePart(id)) throw new Error('内容 ID 无效')
  const folder = join(root, '内容', id, '素材')
  await mkdir(folder, { recursive: true })
  const base = await realpath(root)
  if (await realpath(folder) !== join(base, '内容', id, '素材')) throw new Error('素材目录不能是符号链接')
  return folder
}

// 旧版扁平 URL 保持有效；实体文件可搬到所属稿件中，无需改变素材 ID 和选材关联。
export async function storedAssetPath(filesDir, name) {
  if (!validAssetPath(name)) throw new Error('素材路径无效')
  const root = dirname(filesDir)
  const parts = name.split('/')
  const candidates = parts.length === 2
    ? [join(root, '内容', parts[0], '素材', parts[1])]
    : [join(filesDir, name), ...(await readdir(join(root, '内容')).catch(e => { if (e.code === 'ENOENT') return []; throw e })).filter(safePart).map(id => join(root, '内容', id, '素材', name))]
  const base = await realpath(root)
  for (const path of candidates) {
    let actual
    try { actual = await realpath(path) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    const rel = relative(base, actual)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('素材路径无效')
    if ((await stat(actual)).isFile()) return path
  }
  throw Object.assign(new Error('素材文件不存在'), { code: 'ENOENT', status: 404 })
}
