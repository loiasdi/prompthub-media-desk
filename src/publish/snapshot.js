import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { assetSignature } from '../content-assets.js'
import { fail } from '../workspace-schema.js'
import { assetFileName, MAX_ASSET_BYTES, MEDIA_MIME } from '../asset-rules.js'
import { PUBLISH_COVER_BYTES } from './media-rules.js'
import { withLocalUploadSource } from './local-source.js'

function assetPath(root, itemId, src) {
  const name = assetFileName(src)
  if (!name) throw fail('请选择本工作台中的本地素材，不能直接发布外链')
  const parts = name.split('/')
  if (parts.length === 2 && parts[0] !== itemId) throw fail('素材不属于当前稿件')
  // Even legacy flat URLs must already have a physical copy archived under this draft.
  return join(root, '内容', itemId, '素材', parts.at(-1))
}

export async function inspectSelection(root, itemId, ws, id, type, snapshotDir, imageIndex, { maxBytes, beforeCopy } = {}) {
  if (imageIndex !== undefined && (type !== 'image' || !Number.isInteger(imageIndex) || imageIndex < 0)) throw fail('本地图片序号无效')
  if (!id || ws.hidden.includes(id) || ws.trash.some(row => row.assetId === id)) throw fail(type === 'video' ? '请选择可用的本地成片' : '请选择可用的本地图片')
  const asset = ws.assets.find(row => row.id === id && row.type === type)
  if (!asset) throw fail('未找到这篇稿件的已选素材')
  const path = assetPath(root, itemId, asset.src)
  const ext = extname(path).toLowerCase()
  const mime = MEDIA_MIME[ext]
  if (!mime?.startsWith(`${type}/`)) throw fail('本地素材类型不受支持')
  const label = ws.edits[id]?.name || asset.name || basename(path)
  const filename = label.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 230)
  const destination = snapshotDir && join(snapshotDir, `${type}${imageIndex === undefined ? '' : `-${imageIndex}`}${ext}`)
  try {
    return await withLocalUploadSource(root, path, { filename, mime }, async source => {
      const limit = maxBytes ?? (type === 'video' ? MAX_ASSET_BYTES : PUBLISH_COVER_BYTES)
      if (!Number.isSafeInteger(limit) || limit <= 0 || source.sizeBytes > limit) throw fail(type === 'video' ? '发布成片不能超过 250 MB' : maxBytes === undefined ? '发布图片不能超过 10 MiB' : '发布图片超过当前平台的大小限制')
      if (destination) await beforeCopy?.({ sizeBytes: source.sizeBytes })
      const hash = createHash('sha256')
      let header = Buffer.alloc(0)
      const add = chunk => {
        hash.update(chunk)
        if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)])
      }
      if (destination) {
        const meter = new Transform({ transform(chunk, _, done) { add(chunk); done(null, chunk) } })
        await pipeline(source.stream(), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      } else {
        for await (const chunk of source.stream()) add(chunk)
      }
      const digest = hash.digest('hex')
      if (!assetSignature(header, ext) || (asset.sha256 && asset.sha256 !== digest) || (asset.bytes && asset.bytes !== source.sizeBytes)) throw fail('选定的素材已变化或格式无效，请重新导入')
      return { id, filename, mime, width: asset.width, height: asset.height, duration: asset.duration, frameRate: asset.frameRate, sizeBytes: source.sizeBytes, digest, destination, stream: source.stream }
    })
  } catch (err) {
    if (err.status) throw err
    if (err.code === 'ENOSPC') throw fail('磁盘空间不足，无法固定发布素材', 507)
    throw fail('本地素材无法读取，请重新选材或导入')
  }
}

export const assetSummary = ({ id, filename, mime, sizeBytes, digest }) => ({ id, filename, mime, sizeBytes, digest })
