import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withLocalUploadSource } from '../local-source.js'
import { MaitianError } from './errors.js'

export const TASK_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const invalid = () => new MaitianError('PROJECT_CHANGED', '固定发布工程已变化或无法读取，请重新检查并确认')

async function jsonFile(root, path, filename) {
  return withLocalUploadSource(root, path, { filename, mime: 'application/json' }, async source => {
    if (source.sizeBytes > 1_000_000) throw invalid()
    const chunks = []
    for await (const chunk of source.stream()) chunks.push(chunk)
    try { return JSON.parse(Buffer.concat(chunks)) } catch { throw invalid() }
  })
}

// Both Host and runner verify the same independently fixed bytes. No frontend paths are accepted.
export async function verifyTaskProject(root, reference) {
  if (!reference || !TASK_ID.test(reference.projectId || '') || !/^[a-f0-9]{64}$/.test(reference.projectDigest || '')) throw invalid()
  try {
    const dir = reference.projectId, base = join(root, dir)
    const manifest = await jsonFile(root, join(base, 'media-desk-manifest.json'), 'media-desk-manifest.json')
    const data = await jsonFile(root, join(base, 'publish.json'), 'publish.json')
    if (manifest.version !== 1 || manifest.kind !== 'task' || manifest.snapshotId !== dir || manifest.projectDigest !== reference.projectDigest ||
        !Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 10 ||
        createHash('sha256').update(JSON.stringify({ data, assets: manifest.assets })).digest('hex') !== reference.projectDigest ||
        reference.data && JSON.stringify(reference.data) !== JSON.stringify(data)) throw invalid()
    const files = new Set(['publish.json'])
    for (const asset of manifest.assets) {
      if (typeof asset.file !== 'string' || !/^(?:video\.(?:mp4|mov|m4v)|cover-(?:3x4|4x3)\.(?:jpg|jpeg|png))$/.test(asset.file) ||
          files.has(asset.file) || !/^[a-f0-9]{64}$/.test(asset.digest || '') || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) throw invalid()
      await withLocalUploadSource(root, join(base, asset.file), { filename: asset.file, mime: asset.mime }, async source => {
        if (source.sizeBytes !== asset.sizeBytes) throw invalid()
        const hash = createHash('sha256')
        for await (const chunk of source.stream()) hash.update(chunk)
        if (hash.digest('hex') !== asset.digest) throw invalid()
      })
      files.add(asset.file)
    }
    if (!files.has(data.video) || !data.platforms || Object.keys(data.platforms).length !== 1 || !['xhs', 'channels'].includes(Object.keys(data.platforms)[0]) ||
        Object.values(data.covers || {}).some(file => !files.has(file)) ||
        Object.values(data.platforms).some(row => row.video && !files.has(row.video))) throw invalid()
    return { project: { dir, data }, files: [...files], manifest }
  } catch (error) {
    if (error instanceof MaitianError) throw error
    throw invalid()
  }
}
