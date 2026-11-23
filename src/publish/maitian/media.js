import { open } from 'node:fs/promises'
import { inspectMedia } from '../../content-assets.js'
import { MaitianError } from './errors.js'

// Walk MP4 top-level boxes with bounded reads, including extended sizes and large padding boxes.
export async function checkFaststart(file) {
  const descriptor = await open(file, 'r')
  try {
    const { size } = await descriptor.stat()
    let offset = 0, moov = false, mdat = false
    for (let boxes = 0; offset < size && boxes < 10000; boxes++) {
      const header = Buffer.alloc(16)
      const { bytesRead } = await descriptor.read(header, 0, Math.min(16, size - offset), offset)
      if (bytesRead < 8) throw new Error('truncated')
      let length = header.readUInt32BE(0)
      const type = header.toString('ascii', 4, 8)
      let headerSize = 8
      if (length === 1) {
        if (bytesRead < 16) throw new Error('truncated')
        const extended = header.readBigUInt64BE(8)
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('overflow')
        length = Number(extended); headerSize = 16
      } else if (length === 0) length = size - offset
      if (length < headerSize || offset + length > size) throw new Error('invalid box')
      if (type === 'moov') { if (mdat) throw new Error('not faststart'); moov = true }
      if (type === 'mdat') { if (!moov) throw new Error('not faststart'); mdat = true }
      offset += length
    }
    if (!moov || !mdat || offset !== size) throw new Error('incomplete')
  } catch { throw new MaitianError('INVALID_FASTSTART', 'MP4 结构无法确认或不是 faststart，请重新封装为新素材后再试', 422) }
  finally { await descriptor.close() }
}

export async function inspectSnapshot(file, type, ratio) {
  const metadata = await inspectMedia(file, type)
  if (metadata.metadataStatus !== 'ready' || !Number.isFinite(metadata.width) || !Number.isFinite(metadata.height)) throw new MaitianError('METADATA_UNAVAILABLE', '麦田工程需要 ffprobe 读取实际素材尺寸，请先安装或检查 ffprobe', 422)
  if (ratio) {
    const [width, height] = ratio.split('x').map(Number)
    if (Math.abs(metadata.width / metadata.height - width / height) > 0.01) throw new MaitianError('COVER_RATIO_MISMATCH', `实际封面尺寸不符合 ${ratio}，请重新选择`, 422)
  }
  if (type === 'video' && (!Number.isFinite(metadata.duration) || metadata.duration <= 0)) throw new MaitianError('INVALID_DURATION', '无法读取实际视频时长', 422)
  return metadata
}
