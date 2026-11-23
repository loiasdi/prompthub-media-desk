import { COVER_RATIOS, sanitizeCoverDesign } from './cover-design-schema.js'
import { contentAssetDirectory } from './asset-storage.js'
import { assertUploadRoot, withAssetUpload } from './asset-upload.js'
import { MEDIA_MIME } from './asset-rules.js'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { emptyWorkspace, fail, fileId, registerWorkspaceSources, sanitizeWorkspace } from './workspace-schema.js'

const exec = promisify(execFile)
export { MEDIA_MIME }
const typeFor = ext => MEDIA_MIME[ext]?.split('/')[0]

export function assetSignature(header, ext) {
  const ascii = (start, end) => header.toString('latin1', start, end)
  if (ext === '.png') return header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (['.jpg', '.jpeg'].includes(ext)) return header[0] === 255 && header[1] === 216 && header[2] === 255
  if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
  if (ext === '.webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
  if (ext === '.wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
  if (['.mp4', '.m4v', '.m4a', '.mov'].includes(ext)) return ascii(4, 8) === 'ftyp' || (ext === '.mov' && ['moov', 'mdat', 'wide'].includes(ascii(4, 8)))
  if (ext === '.webm') return header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
  if (ext === '.ogg') return ascii(0, 4) === 'OggS'
  if (ext === '.mp3') return ascii(0, 3) === 'ID3' || (header[0] === 255 && (header[1] & 0xe0) === 0xe0)
  if (ext === '.aac') return header[0] === 255 && (header[1] & 0xf6) === 0xf0
  return false
}

export async function inspectMedia(file, type, posterFile, run = exec) {
  let info
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height,duration,avg_frame_rate:stream_side_data=rotation', '-of', 'json', file], { timeout: 20000, maxBuffer: 1_000_000 })
    info = JSON.parse(stdout)
  } catch (err) {
    if (err.code === 'ENOENT') return { metadataStatus: 'unavailable', metadataWarning: '本机未安装 ffprobe，无法读取媒体信息' }
    throw fail('媒体文件损坏、格式不匹配或无法读取', 422)
  }
  const video = info.streams?.find(s => s.codec_type === 'video')
  const audio = info.streams?.find(s => s.codec_type === 'audio')
  if (type === 'audio' ? !audio : !video) throw fail('媒体内容与文件类型不匹配', 415)
  const metadata = { metadataStatus: 'ready' }
  const duration = Number(info.format?.duration || video?.duration || audio?.duration)
  if (Number.isFinite(duration) && duration > 0) metadata.duration = duration
  if (video) {
    const rotation = video.side_data_list?.find(row => Number.isFinite(row.rotation))?.rotation || 0
    const rotated = Math.abs(rotation) % 180 === 90
    const rate = /^(\d+)\/(\d+)$/.exec(video.avg_frame_rate || '')
    const fps = rate && Number(rate[1]) / Number(rate[2])
    if (Number.isFinite(fps) && fps > 0) metadata.frameRate = fps
    metadata.width = rotated ? video.height : video.width
    metadata.height = rotated ? video.width : video.height
  }
  if (type === 'video' && posterFile) {
    try {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-y', posterFile], { timeout: 20000, maxBuffer: 1_000_000 })
      metadata.hasPoster = true
    } catch {
      await rm(posterFile, { force: true })
      metadata.metadataWarning = '视频已保存，缩略图生成失败或本机未安装 ffmpeg'
    }
  }
  return metadata
}

function getItem(state, id) {
  const item = state.items.find(i => i.id === id)
  if (!item) throw fail('内容不存在', 404)
  return item
}

export function currentWorkspace(item) {
  if (item.workspace && item.workspace.schemaVersion !== 1) throw fail('工作区数据版本较新，请更新应用后再编辑', 409)
  const copy = { ...item, workspace: structuredClone(item.workspace || emptyWorkspace(item)) }
  registerWorkspaceSources(copy)
  copy.workspace.coverDesign = sanitizeCoverDesign(copy.workspace.coverDesign, copy.workspace.assets, item.production?.title || item.title)
  return copy.workspace
}

function expectRevision(ws, revision) {
  if (!Number.isInteger(revision) || revision !== ws.revision) throw fail('工作区版本已更新，请合并或重新加载后再保存', 409)
}

export class ContentAssets {
  constructor(store, { inspect = inspectMedia } = {}) {
    this.store = store
    this.inspect = inspect
  }

  async read(id) {
    return currentWorkspace(getItem(await this.store.read(), id))
  }

  async save(id, revision, input) {
    return this.store.mutate('保存内容工作区', state => {
      const item = getItem(state, id)
      const current = currentWorkspace(item)
      expectRevision(current, revision)
      const next = sanitizeWorkspace(item, input, current)
      next.revision++
      next.updatedAt = new Date().toISOString()
      item.workspace = next
      return structuredClone(next)
    }, { undoable: false })
  }

  async recycle(id, revision, assetId, restore = false) {
    return this.store.mutate(restore ? '恢复素材' : '移到回收站', state => {
      const item = getItem(state, id)
      const ws = currentWorkspace(item)
      expectRevision(ws, revision)
      if (!ws.assets.some(a => a.id === assetId)) throw fail('素材不存在', 404)
      if (restore) {
        ws.hidden = ws.hidden.filter(value => value !== assetId)
        ws.trash = ws.trash.filter(row => row.assetId !== assetId)
      } else {
        if (!ws.hidden.includes(assetId)) ws.hidden.push(assetId)
        if (!ws.trash.some(row => row.assetId === assetId)) ws.trash.push({ assetId, deletedAt: new Date().toISOString() })
        if (ws.selectedVideo === assetId) ws.selectedVideo = ''
        if (ws.selectedCover === assetId) ws.selectedCover = ''
        ws.selectedCoverIds = ws.selectedCoverIds.filter(id => id !== assetId)
        ws.selectedCover ||= ws.selectedCoverIds[0] || ''
        if (ws.publish?.browser?.covers) ws.publish.browser.covers = Object.fromEntries(Object.entries(ws.publish.browser.covers).filter(([, id]) => id !== assetId))
        ws.imageIds = ws.imageIds.filter(value => value !== assetId)
        ws.promptSettings.referenceIds = ws.promptSettings.referenceIds.filter(value => value !== assetId)
        const src = ws.assets.find(a => a.id === assetId).src
        ws.segments = ws.segments.map(segment => segment.image === src ? { ...segment, image: '' } : segment)
      }
      ws.revision++
      ws.updatedAt = new Date().toISOString()
      item.workspace = ws
      return structuredClone(ws)
    }, { undoable: false })
  }

  async import(id, stream, { name, folder = '', relativePath = '', revision, coverResult = false, coverRatio, mergeCoverResult = false } = {}) {
    if (coverRatio !== undefined && !COVER_RATIOS.includes(coverRatio)) throw fail('封面比例无效')
    const ext = extname(String(name)).toLowerCase()
    const type = typeFor(ext)
    if (!type) throw fail('不支持的媒体文件类型', 415)
    // 仅供已通过初始修订检查的内部生图任务使用，HTTP 上传不开放此选项。
    // 生图期间允许编辑，入库在写锁内只追加文件和关联，不保存旧的整份草稿。
    const mergeCover = mergeCoverResult === true && type === 'image' && COVER_RATIOS.includes(coverRatio)
    const cleanName = basename(String(name).replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '').slice(0, 240)
    if (!cleanName || cleanName.startsWith('.')) throw fail('文件名无效')
    return withAssetUpload(this.store, async ({ root, dir, token, state }) => {
      const initial = currentWorkspace(getItem(state, id))
      if (!mergeCover) expectRevision(initial, revision)
      const filename = `asset_${token}${ext}`
      const posterName = `asset_${token}-poster.jpg`
      const pending = join(dir, filename)
      const pendingPoster = join(dir, posterName)
      let bytes = 0
      let header = Buffer.alloc(0)
      const hash = createHash('sha256')
      const meter = new Transform({ transform: (chunk, encoding, callback) => {
        bytes += chunk.length
        hash.update(chunk)
        if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)])
        callback(null, chunk)
      } })
      await pipeline(stream, meter, createWriteStream(pending, { flags: 'wx', mode: 0o600 }))
      if (!bytes || !assetSignature(header, ext)) throw fail('文件内容与扩展名不匹配', 415)
      const metadata = await this.inspect(pending, type, type === 'video' ? pendingPoster : null)
      const src = `media-desk/files/${id}/${filename}`
      const asset = { id: fileId(src), src, name: cleanName, type, role: 'source', folder: '', origin: 'imported', bytes, sha256: hash.digest('hex'), importedAt: new Date().toISOString(), relativePath: String(relativePath).replaceAll('\\', '/').split('/').filter(p => p && p !== '.' && p !== '..').join('/').slice(0, 1000), ...metadata }
      if ((coverResult === true || coverRatio) && type === 'image') {
        asset.coverResult = true
        asset.role = 'cover'
        if (coverRatio) asset.coverRatio = coverRatio
      }
      const hasPoster = asset.hasPoster
      if (hasPoster) asset.poster = `media-desk/files/${id}/${posterName}`
      delete asset.hasPoster
      const moved = []
      try {
        return await this.store.mutate('导入内容素材', async state => {
          assertUploadRoot(this.store, root)
          const item = getItem(state, id)
          const ws = currentWorkspace(item)
          if (!mergeCover) expectRevision(ws, revision)
          if (ws.assets.length >= 2000) throw fail('这篇内容的素材数量已达上限')
          if (folder && ws.folders.some(f => f.id === folder && f.type === type)) asset.folder = folder
          else if (asset.relativePath.includes('/')) {
            const label = asset.relativePath.slice(0, asset.relativePath.lastIndexOf('/')).slice(0, 120)
            let parent = ws.folders.find(f => f.name === label && f.type === type)
            if (!parent) {
              if (ws.folders.length >= 200) throw fail('文件夹数量已达上限')
              parent = { id: `folder_${randomUUID()}`, name: label, type }
              ws.folders.push(parent)
            }
            asset.folder = parent.id
          }
          const assetDir = await contentAssetDirectory(root, id)
          const file = join(assetDir, filename)
          await rename(pending, file)
          moved.push(file)
          if (hasPoster) {
            const poster = join(assetDir, posterName)
            await rename(pendingPoster, poster)
            moved.push(poster)
          }
          ws.assets.push(asset)
          if (coverRatio && type === 'image') {
            // 旧图仍在素材库；当前画幅只指向本轮结果，关联和文件入库一次保存。
            const variant = ws.coverDesign.variants[coverRatio]
            for (const previous of ws.assets) {
              if (variant.imageIds.includes(previous.id)) {
                previous.coverResult = true
                previous.coverRatio ||= coverRatio
              }
            }
            variant.imageIds = [asset.id]
          }
          ws.revision++
          ws.updatedAt = new Date().toISOString()
          item.workspace = ws
          return { asset, workspace: structuredClone(ws) }
        }, { undoable: false })
      } catch (err) {
        await Promise.all(moved.map(path => rm(path, { force: true })))
        throw err
      }
    })
  }
}
