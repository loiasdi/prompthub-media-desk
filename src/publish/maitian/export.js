import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, rename, rm, writeFile, readFile, lstat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { currentWorkspace } from '../../content-assets.js'
import { withAssetUpload } from '../../asset-upload.js'
import { sourceCopy } from '../../workspace-schema.js'
import { inspectSelection, assetSummary } from '../snapshot.js'
import { blocksDuplicate, readPublishRecords } from '../records.js'
import { createProject, COVER_RATIOS, MAPPED_PLATFORMS } from './project.js'
import { checkFaststart, inspectSnapshot } from './media.js'
import { MaitianError } from './errors.js'

const exec = promisify(execFile)
const ID = /^[\w-]{1,160}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

export function captureProject(store, id, revision, platform) {
  if (!ID.test(id || '') || !Object.hasOwn(MAPPED_PLATFORMS, platform)) throw new MaitianError('INVALID_TARGET', '稿件或目标平台无效', 400)
  const item = store.state.items.find(row => row.id === id)
  if (!item || item.sample || item.trashedAt) throw new MaitianError('INVALID_ITEM', '请选择非示例且不在回收站的稿件', 400)
  const workspace = currentWorkspace(item)
  if (!Number.isInteger(revision) || workspace.revision !== revision) throw new MaitianError('REVISION_CHANGED', '发布信息已变化，请保存后重新检查')
  const copy = { ...workspace.publish }
  const source = sourceCopy(item)
  for (const field of ['title', 'description', 'platform', 'tags']) if (!workspace.publishEdited?.[field]) copy[field] = source[field]
  return { workspace, copy }
}

export async function snapshotProject({ store, projectsRoot, engineRef, contract, validate, id, revision, platform, confirmExisting = false, inspect = inspectSnapshot, kind = 'task', onCapture = async () => {}, onReserve = async () => {}, beforeCopy, onReady = async () => {}, beforeCommit = async () => {}, onCommit = async () => {} }) {
  if (!contract.operations.validate || !contract.platforms[platform]?.mapped) throw new MaitianError('UNSUPPORTED_PROJECT', '当前组件不支持此工程的映射与校验')
  const exportId = randomUUID()
  const staging = join(projectsRoot, `.pending-${exportId}`)
  const destination = join(projectsRoot, exportId)
  let published = false
  try {
    await mkdir(projectsRoot, { recursive: true, mode: 0o700 })
    return await withAssetUpload(store, async ({ root }) => {
      await onReserve({ root, snapshotId: exportId })
      await mkdir(staging, { mode: 0o700 })
      const captured = await store.run(async () => {
        await store.refresh()
        if (store.root !== root) throw new MaitianError('WORKSPACE_CHANGED', '工作台目录已变化，请重新导出')
        const current = captureProject(store, id, revision, platform)
        const existing = (await readPublishRecords(root)).some(row => row.itemId === id && row.platform === platform && blocksDuplicate(row))
        if (existing && confirmExisting !== true) throw new MaitianError('EXISTING_PUBLICATION', '该稿件可能已经上传；请核对并明确确认后再导出，避免外部重复发布')
        await onCapture({ root, ...current })
        return current
      })
      const { workspace, copy } = captured
      const video = await inspectSelection(root, id, workspace, workspace.selectedVideo, 'video', staging, undefined, { beforeCopy })
      const videoExtension = extname(video.destination).toLowerCase()
      if (!['.mp4', '.mov', '.m4v'].includes(videoExtension)) throw new MaitianError('UNSUPPORTED_VIDEO', '麦田工程目前接受 MP4、MOV 或 M4V 成片', 422)
      if (['.mp4', '.m4v'].includes(videoExtension)) await checkFaststart(video.destination)
      const media = await inspect(video.destination, 'video')
      const covers = {}, assets = [{ ...assetSummary(video), file: `video${videoExtension}` }]
      for (const [index, ratio] of COVER_RATIOS[platform].entries()) {
        const selected = copy.browser?.covers?.[ratio]
        if (!selected) continue
        const image = await inspectSelection(root, id, workspace, selected, 'image', staging, index, { beforeCopy })
        const extension = extname(image.destination).toLowerCase()
        if (!['.jpg', '.jpeg', '.png'].includes(extension)) throw new MaitianError('UNSUPPORTED_COVER', '麦田工程封面只接受 JPEG 或 PNG', 422)
        await inspect(image.destination, 'image', ratio)
        const file = `cover-${ratio}${extension}`
        await rename(image.destination, join(staging, file))
        covers[ratio] = file
        assets.push({ ...assetSummary(image), file, ratio })
      }
      const data = createProject({ id: `${id}-${exportId}`, copy, platform, video: assets[0].file, covers, durationSec: media.duration })
      const files = ['publish.json', ...assets.map(asset => asset.file)]
      const validation = await validate({ engineRef, data, files })
      if (validation.errors.length) throw new MaitianError('UPSTREAM_VALIDATION', validation.errors.join('\n'), 422)
      const projectDigest = createHash('sha256').update(JSON.stringify({ data, assets })).digest('hex')
      const manifest = {
        version: 1, provider: 'maitian', itemId: id, revision, snapshotId: exportId, kind,
        ...(kind === 'export' && { exportId }), platform, projectDigest,
        generatedAt: new Date().toISOString(), timezone: copy.mode === 'scheduled' ? copy.timezone : null,
        engineVersion: engineRef.version, engineFingerprint: engineRef.fingerprint,
        contractVersion: contract.contractVersion, assets, warnings: validation.warnings,
      }
      await writeFile(join(staging, 'publish.json'), JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
      await writeFile(join(staging, 'media-desk-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
      await beforeCommit({ manifest, data })
      await onReady({ manifest })
      await store.run(async () => {
        await store.refresh()
        if (store.root !== root || JSON.stringify(captureProject(store, id, revision, platform)) !== JSON.stringify(captured)) throw new MaitianError('REVISION_CHANGED', '发布信息或选材已变化，请重新导出')
        const existing = (await readPublishRecords(root)).some(row => row.itemId === id && row.platform === platform && blocksDuplicate(row))
        if (existing && confirmExisting !== true) throw new MaitianError('EXISTING_PUBLICATION', '文件准备期间出现已有投稿，请先核对平台结果')
        await rename(staging, destination)
        published = true
        await onCommit({ root, manifest, data, files, ...captured })
      })
      return { snapshotId: exportId, projectDigest, manifest, data, files }
    })
  } catch (error) {
    if (published) await rm(destination, { recursive: true, force: true })
    throw error
  } finally { await rm(staging, { recursive: true, force: true }) }
}

export async function exportProject({ exportsRoot, beforeArchive = async () => {}, ...options }) {
  const snapshot = await snapshotProject({ ...options, projectsRoot: exportsRoot, kind: 'export' })
  const exportId = snapshot.snapshotId
  const archive = join(exportsRoot, `${exportId}.tar.gz`)
  try {
    await beforeArchive({ sizeBytes: snapshot.manifest.assets.reduce((total, asset) => total + asset.sizeBytes, 0) })
    // Archive a controlled, generated directory; no shell and no caller-supplied arguments.
    await exec('/usr/bin/tar', ['-czf', archive, '-C', exportsRoot, exportId], { timeout: 120_000, maxBuffer: 256_000, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    await chmod(archive, 0o600)
    return { exportId, projectDigest: snapshot.projectDigest, platform: snapshot.manifest.platform, engineVersion: snapshot.manifest.engineVersion,
      warnings: snapshot.manifest.warnings, files: [...snapshot.files, 'media-desk-manifest.json'], downloadPath: `media-desk/publish/maitian/download?exportId=${exportId}` }
  } catch (error) {
    await rm(archive, { force: true })
    await rm(join(exportsRoot, exportId), { recursive: true, force: true })
    throw error
  }
}

export async function exportedArchive(exportsRoot, exportId) {
  if (typeof exportId !== 'string' || !UUID.test(exportId)) throw new MaitianError('INVALID_EXPORT', '导出标识无效', 400)
  const file = join(exportsRoot, `${exportId}.tar.gz`)
  try {
    const [info, manifestInfo] = await Promise.all([lstat(file), lstat(join(exportsRoot, exportId, 'media-desk-manifest.json'))])
    if (!info.isFile() || !manifestInfo.isFile() || manifestInfo.size > 1_000_000) throw new Error('invalid')
    const manifest = JSON.parse(await readFile(join(exportsRoot, exportId, 'media-desk-manifest.json'), 'utf8'))
    if (manifest.exportId !== exportId || manifest.provider !== 'maitian') throw new Error('invalid')
    return { file, size: info.size }
  } catch { throw new MaitianError('EXPORT_NOT_FOUND', '导出文件不存在或无法读取', 404) }
}
