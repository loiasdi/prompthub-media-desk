import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MaitianConfig } from './config.js'
import { discoverEngine } from './engine-loader.mjs'
import { runComponent } from './runner-client.js'
import { exportProject, createExportArchive, exportedProjectDirectory } from './export.js'
import { MaitianError, publicFailure } from './errors.js'
import { acquireProfileLock } from './profile-lock.js'
import { prepareTask } from './prepare.js'
import { startTask, cancelTask } from './tasks.js'
import { reviewTask } from './review.js'
import { reconcileTask, openTaskPage } from './reconcile.js'
import { TaskSnapshotStorage, checkSnapshotDisk } from './snapshot-storage.js'

export class MaitianPublishing {
  constructor(store, { config = new MaitianConfig(), run = runComponent, inspect, snapshots, directFillEnabled = false } = {}) {
    this.store = store
    this.config = config
    this.run = run
    this.inspect = inspect
    this.snapshots = snapshots || new TaskSnapshotStorage(config.root)
    this.directFillEnabled = directFillEnabled === true
    this.executions = new Map()
    this.diagnostic = { compatibility: 'unavailable', code: 'NOT_PROBED', message: '尚未检测麦田组件', platforms: {}, operations: {} }
  }
  public() {
    return { ...this.config.public(), diagnostic: this.diagnostic, implementation: { export: true, browserSetup: true, preflight: true, prepare: true, fillExecution: true, review: true, reconcile: true, directFillUI: true, directFill: this.directFillEnabled, liveVerified: false } }
  }
  async save(patch) {
    const current = this.config.resolve()
    const lock = await acquireProfileLock(current.profileDir, join(this.config.root, 'locks'))
    try { await this.config.save(patch) }
    finally { await lock.release() }
    this.diagnostic = { compatibility: 'unavailable', code: 'NOT_PROBED', message: '配置已变化，请重新检测组件', platforms: {}, operations: {} }
    return this.public()
  }
  async resolve() {
    const options = this.config.resolve()
    const engineRef = await discoverEngine(options)
    const contract = await this.run({ nodePath: options.nodePath, engineRef, op: 'hello' })
    this.diagnostic = { ...contract, detectedVersion: contract.version, probedAt: new Date().toISOString() }
    return { options, engineRef, contract }
  }
  async probe() {
    try { await this.resolve() }
    catch (error) {
      const failure = publicFailure(error)
      this.diagnostic = { compatibility: failure.code.startsWith('INCOMPATIBLE') ? 'incompatible' : 'unavailable', code: failure.code, message: failure.message, probedAt: new Date().toISOString(), platforms: {}, operations: {} }
    }
    return this.public()
  }
  async export(request, exportsRoot = join(this.config.root, 'exports')) {
    return exportProject({
      store: this.store, exportsRoot,
      id: request.id, revision: request.revision, platform: request.platform, platforms: request.platforms, confirmExisting: request.confirmExisting,
      beforeCopy: ({ sizeBytes }) => checkSnapshotDisk(exportsRoot, sizeBytes),
    })
  }
  async browser(op, { platform, operationId: pageOperationId } = {}) {
    if (!['open-install', 'open-login', 'preflight', 'open-page', 'open-management'].includes(op)) throw new MaitianError('UNSUPPORTED_OPERATION', '浏览器操作尚未支持', 400)
    let options = this.config.resolve(), engineRef
    if (!options.enabled) throw new MaitianError('BROWSER_DISABLED', '请先保存并启用专用浏览器设置')
    if (['open-login', 'preflight', 'open-management'].includes(op)) {
      if (!['xhs', 'channels'].includes(platform)) throw new MaitianError('INVALID_TARGET', '当前浏览器入口仅接入小红书和视频号', 400)
      const resolved = await this.resolve()
      options = resolved.options; engineRef = resolved.engineRef
      if (!options.enabled) throw new MaitianError('BROWSER_DISABLED', '专用浏览器设置已禁用')
      const capability = resolved.contract.platforms[platform]
      if (!capability?.mapped || op === 'preflight' && !resolved.contract.operations.preflight || op === 'open-login' && !capability.canOpenLogin) throw new MaitianError('UNSUPPORTED_OPERATION', '当前麦田组件缺少此操作，请更新组件或连接层')
    }
    return this.run({
      nodePath: options.nodePath, engineRef, op, platform, operationId: randomUUID(), pageOperationId,
      browser: { root: this.config.root, profileDir: options.profileDir, profileId: options.profileId, chromePath: options.chromePath, port: options.port },
    })
  }
  archive(exportId, exportsRoot = join(this.config.root, 'exports')) {
    return createExportArchive(exportsRoot, exportId, ({ sizeBytes }) => checkSnapshotDisk(exportsRoot, sizeBytes))
  }
  reveal(exportId, exportsRoot = join(this.config.root, 'exports')) { return exportedProjectDirectory(exportsRoot, exportId) }
  prepare(request) { return prepareTask(this, request) }
  start(request) { return startTask(this, request) }
  cancel(request) { return cancelTask(this, request) }
  review(request) { return reviewTask(this, request) }
  reconcile(request) { return reconcileTask(this, request) }
  openTaskPage(request) { return openTaskPage(this, request) }
  openManagement(request) { return openTaskPage(this, request, true) }
}
