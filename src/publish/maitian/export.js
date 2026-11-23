import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, rename, rm, writeFile, readFile, lstat, realpath, readdir } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { currentWorkspace } from '../../content-assets.js'
import { withAssetUpload } from '../../asset-upload.js'
import { sourceCopy } from '../../workspace-schema.js'
import { inspectSelection, assetSummary } from '../snapshot.js'
import { blocksDuplicate, readPublishRecords } from '../records.js'
import { createProject, COVER_RATIOS, MAPPED_PLATFORMS, normalizePlatforms } from './project.js'
import { checkFaststart, inspectSnapshot } from './media.js'
import { MaitianError } from './errors.js'

const exec = promisify(execFile)
const ID = /^[\w-]{1,160}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

export async function rememberExportLocation(configRoot, exportId, exportsRoot) {
  if (!UUID.test(exportId)) throw new MaitianError('INVALID_EXPORT', '导出标识无效', 400)
  const directory = await realpath(exportsRoot)
  const index = join(configRoot, 'export-locations')
  await mkdir(index, { recursive: true, mode: 0o700 })
  const file = join(index, `${exportId}.json`)
  const temporary = join(index, `.${exportId}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, exportId, exportsRoot: directory }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export async function rememberedExportLocation(configRoot, exportId) {
  if (!UUID.test(exportId)) throw new MaitianError('INVALID_EXPORT', '导出标识无效', 400)
  try {
    const record = JSON.parse(await readFile(join(configRoot, 'export-locations', `${exportId}.json`), 'utf8'))
    if (record.version !== 1 || record.exportId !== exportId || typeof record.exportsRoot !== 'string' || !isAbsolute(record.exportsRoot)) return null
    return await realpath(record.exportsRoot)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    return null
  }
}

function resolveTargets(platform, platforms) {
  try { return normalizePlatforms(platform, platforms) }
  catch { throw new MaitianError('INVALID_TARGET', '稿件或目标平台无效', 400) }
}

export function captureProject(store, id, revision, platform, platforms) {
  if (!ID.test(id || '')) throw new MaitianError('INVALID_TARGET', '稿件或目标平台无效', 400)
  resolveTargets(platform, platforms)
  const item = store.state.items.find(row => row.id === id)
  if (!item || item.sample || item.trashedAt) throw new MaitianError('INVALID_ITEM', '请选择非示例且不在回收站的稿件', 400)
  const workspace = currentWorkspace(item)
  if (!Number.isInteger(revision) || workspace.revision !== revision) throw new MaitianError('REVISION_CHANGED', '发布信息已变化，请保存后重新检查')
  const copy = { ...workspace.publish }
  const source = sourceCopy(item)
  for (const field of ['title', 'description', 'platform', 'tags']) if (!workspace.publishEdited?.[field]) copy[field] = source[field]
  if (!Array.isArray(platforms)) copy.platform = MAPPED_PLATFORMS[platform]
  return { workspace, copy }
}

export async function snapshotProject({ store, projectsRoot, engineRef, contract, validate, id, revision, platform, platforms, confirmExisting = false, inspect = inspectSnapshot, kind = 'task', snapshotId, replaceExisting = false, onCapture = async () => {}, onReserve = async () => {}, beforeCopy, onReady = async () => {}, beforeCommit = async () => {}, onCommit = async () => {} }) {
  let targets
  try { targets = normalizePlatforms(platform, platforms) }
  catch { throw new MaitianError('UNSUPPORTED_PROJECT', '当前组件不支持此工程的映射与校验') }
  if (validate && (!contract?.operations?.validate || targets.some(target => !contract.platforms[target]?.mapped))) throw new MaitianError('UNSUPPORTED_PROJECT', '当前组件不支持此工程的映射与校验')
  const exportId = snapshotId || randomUUID()
  const staging = join(projectsRoot, `.pending-${exportId}`)
  const destination = join(projectsRoot, exportId)
  let previousDestination
  let published = false
  try {
    await mkdir(projectsRoot, { recursive: true, mode: 0o700 })
    return await withAssetUpload(store, async ({ root }) => {
      await onReserve({ root, snapshotId: exportId })
      await mkdir(staging, { mode: 0o700 })
      const captured = await store.run(async () => {
        await store.refresh()
        if (store.root !== root) throw new MaitianError('WORKSPACE_CHANGED', '工作台目录已变化，请重新导出')
        const current = captureProject(store, id, revision, platform, platforms)
        const existing = (await readPublishRecords(root)).some(row => row.itemId === id && targets.includes(row.platform) && blocksDuplicate(row))
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
      const ratios = [...new Set(targets.flatMap(target => COVER_RATIOS[target]))]
      for (const [index, ratio] of ratios.entries()) {
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
      const data = createProject({ id: `${id}-${exportId}`, copy, ...(Array.isArray(platforms) ? { platforms: targets } : { platform: targets[0] }), video: assets[0].file, covers, durationSec: media.duration })
      const files = ['publish.json', ...assets.map(asset => asset.file)]
      const validation = validate ? await validate({ engineRef, data, files }) : { errors: [], warnings: [] }
      if (validation.errors.length) throw new MaitianError('UPSTREAM_VALIDATION', validation.errors.join('\n'), 422)
      const projectDigest = createHash('sha256').update(JSON.stringify({ data, assets })).digest('hex')
      const manifest = {
        version: 1, provider: 'maitian', itemId: id, revision, snapshotId: exportId, kind,
        ...(kind === 'export' && { exportId }), platform: targets[0], platforms: targets, projectDigest,
        generatedAt: new Date().toISOString(), timezone: copy.mode === 'scheduled' ? copy.timezone : null,
        ...(engineRef && { engineVersion: engineRef.version, engineFingerprint: engineRef.fingerprint }),
        ...(contract?.contractVersion && { contractVersion: contract.contractVersion }), assets, warnings: validation.warnings,
      }
      await writeFile(join(staging, 'publish.json'), JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
      await writeFile(join(staging, 'media-desk-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
      await beforeCommit({ manifest, data })
      await onReady({ manifest })
      await store.run(async () => {
        await store.refresh()
        if (store.root !== root || JSON.stringify(captureProject(store, id, revision, platform, platforms)) !== JSON.stringify(captured)) throw new MaitianError('REVISION_CHANGED', '发布信息或选材已变化，请重新导出')
        const existing = (await readPublishRecords(root)).some(row => row.itemId === id && targets.includes(row.platform) && blocksDuplicate(row))
        if (existing && confirmExisting !== true) throw new MaitianError('EXISTING_PUBLICATION', '文件准备期间出现已有投稿，请先核对平台结果')
        if (replaceExisting) {
          let previous
          try { previous = await lstat(destination) }
          catch (error) { if (error.code !== 'ENOENT') throw error }
          if (previous) {
            if (!previous.isDirectory() || previous.isSymbolicLink()) throw new MaitianError('EXPORT_CONFLICT', '现有工程目录无法安全更新')
            const oldManifest = JSON.parse(await readFile(join(destination, 'media-desk-manifest.json'), 'utf8'))
            if (oldManifest.version !== 1 || oldManifest.provider !== 'maitian' || oldManifest.kind !== 'export' || oldManifest.itemId !== id) throw new MaitianError('EXPORT_CONFLICT', '目标目录已被其他内容占用，未覆盖')
            previousDestination = join(projectsRoot, `.previous-${exportId}-${randomUUID()}`)
            await rename(destination, previousDestination)
          }
        }
        await rename(staging, destination)
        published = true
        await onCommit({ root, manifest, data, files, ...captured })
      })
      return { snapshotId: exportId, projectDigest, manifest, data, files, previousDestination }
    })
  } catch (error) {
    if (published) await rm(destination, { recursive: true, force: true })
    if (previousDestination) await rename(previousDestination, destination).catch(() => {})
    throw error
  } finally { await rm(staging, { recursive: true, force: true }) }
}

async function reusableExportId(exportsRoot, stableId, itemId) {
  const matchesManifest = async exportId => {
    try {
      const directory = join(exportsRoot, exportId)
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
      const manifest = JSON.parse(await readFile(join(directory, 'media-desk-manifest.json'), 'utf8'))
      return manifest.version === 1 && manifest.provider === 'maitian' && manifest.kind === 'export' && manifest.exportId === exportId && manifest.itemId === itemId
    } catch { return false }
  }
  const deterministicId = `${stableId.slice(0, 8)}-${stableId.slice(8, 12)}-${stableId.slice(12, 16)}-${stableId.slice(16, 20)}-${stableId.slice(20)}`
  if (await matchesManifest(deterministicId)) return deterministicId
  const entries = await readdir(exportsRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  const matches = []
  for (const entry of entries) {
    if (entry.isDirectory() && UUID.test(entry.name) && await matchesManifest(entry.name)) matches.push(entry.name)
  }
  return matches.length === 1 ? matches[0] : deterministicId
}

export async function exportProject({ exportsRoot, ...options }) {
  const stableId = createHash('sha256').update(JSON.stringify([options.store.root, options.id])).digest('hex').slice(0, 32)
  const exportId = await reusableExportId(exportsRoot, stableId, options.id)
  const snapshot = await snapshotProject({ ...options, snapshotId: exportId, replaceExisting: true, projectsRoot: exportsRoot, kind: 'export' })
  if (snapshot.previousDestination) await rm(snapshot.previousDestination, { recursive: true, force: true }).catch(() => {})
  return { exportId, projectDigest: snapshot.projectDigest, platform: snapshot.manifest.platform, platforms: snapshot.manifest.platforms,
    warnings: snapshot.manifest.warnings, files: [...snapshot.files, 'media-desk-manifest.json'],
    downloadPath: `media-desk/publish/maitian/download?exportId=${exportId}` }
}

async function exportManifest(exportsRoot, exportId) {
  if (typeof exportId !== 'string' || !UUID.test(exportId)) throw new MaitianError('INVALID_EXPORT', '导出标识无效', 400)
  try {
    const directory = join(exportsRoot, exportId)
    const [directoryInfo, manifestInfo] = await Promise.all([lstat(directory), lstat(join(directory, 'media-desk-manifest.json'))])
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > 1_000_000) throw new Error('invalid')
    const manifest = JSON.parse(await readFile(join(directory, 'media-desk-manifest.json'), 'utf8'))
    if (manifest.exportId !== exportId || manifest.provider !== 'maitian' || manifest.kind !== 'export') throw new Error('invalid')
    return manifest
  } catch { throw new MaitianError('EXPORT_NOT_FOUND', '导出文件不存在或无法读取', 404) }
}

export async function createExportArchive(exportsRoot, exportId, beforeArchive = async () => {}) {
  const manifest = await exportManifest(exportsRoot, exportId)
  const temporaryArchive = join(exportsRoot, `.pending-${exportId}-${randomUUID()}.tar.gz`)
  const archive = join(exportsRoot, `${exportId}.tar.gz`)
  try {
    await beforeArchive({ sizeBytes: manifest.assets.reduce((total, asset) => total + asset.sizeBytes, 0) })
    await exec('/usr/bin/tar', ['-czf', temporaryArchive, '-C', exportsRoot, exportId], { timeout: 120_000, maxBuffer: 256_000, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    await chmod(temporaryArchive, 0o600)
    await rename(temporaryArchive, archive)
    const info = await lstat(archive)
    return { file: archive, size: info.size }
  } catch (error) {
    await rm(temporaryArchive, { force: true })
    throw error
  }
}

export async function exportedArchive(exportsRoot, exportId) {
  await exportManifest(exportsRoot, exportId)
  const file = join(exportsRoot, `${exportId}.tar.gz`)
  try {
    const info = await lstat(file)
    if (!info.isFile()) throw new Error('invalid')
    return { file, size: info.size }
  } catch { throw new MaitianError('EXPORT_NOT_FOUND', '导出压缩包不存在或无法读取', 404) }
}

export async function exportedProjectDirectory(exportsRoot, exportId) {
  const root = await realpath(exportsRoot)
  await exportManifest(root, exportId)
  const directory = join(root, exportId)
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid')
    const resolved = await realpath(directory)
    if (dirname(resolved) !== root) throw new Error('invalid')
    return resolved
  } catch { throw new MaitianError('EXPORT_NOT_FOUND', '导出工程目录不存在或无法读取', 404) }
}
