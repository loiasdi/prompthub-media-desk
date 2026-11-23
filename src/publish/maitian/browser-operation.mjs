import { isAbsolute, join } from 'node:path'
import { acquireProfileLock } from './profile-lock.js'
import { ensureBrowser } from './browser.mjs'
import { CDPConnection, createChromeShim } from './chrome-shim.mjs'
import { BrowserOperations } from './browser-operations.js'
import { loadEngine, STORE_URL, verifyEngine } from './engine-loader.mjs'
import { inspectContract, preflightResult } from './contract.js'
import { MaitianError } from './errors.js'
import { accountEpoch, invalidateAccount } from './account-state.js'

export const BROWSER_OPERATIONS = ['open-install', 'open-login', 'preflight', 'open-page', 'open-management']
const needsEngine = op => ['open-login', 'preflight', 'open-management'].includes(op)

export function browserOptions(value) {
  if (!value || Object.keys(value).some(key => !['profileDir', 'root', 'chromePath', 'profileId', 'port'].includes(key)) ||
      ['profileDir', 'root', 'chromePath'].some(key => typeof value[key] !== 'string' || !isAbsolute(value[key]) || /[\x00-\x1f\x7f]/.test(value[key])) ||
      !/^[a-zA-Z0-9_-]{1,60}$/.test(value.profileId || '') || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new MaitianError('INVALID_BROWSER_REQUEST', '专用浏览器请求无效', 400)
  return value
}

// Dependencies are injected only by transport tests, never by HTTP or IPC requests.
export async function browserOperation(request, {
  launch = ensureBrowser, connect = async (url, onEvent) => {
    const connection = new CDPConnection(url, { onEvent })
    try { await connection.connect(); return connection }
    catch (error) { connection.close(); throw error }
  }, load = loadEngine,
} = {}) {
  const { op, engineRef, platform, operationId } = request
  if (!BROWSER_OPERATIONS.includes(op)) throw new MaitianError('UNSUPPORTED_OPERATION', '浏览器操作尚未支持', 400)
  if (needsEngine(op) && !['xhs', 'channels'].includes(platform)) throw new MaitianError('INVALID_TARGET', '当前浏览器入口仅接入小红书和视频号', 400)
  const options = browserOptions(request.browser)
  const journal = new BrowserOperations(options.root)
  journal.file(operationId)
  const previous = op === 'open-page' ? await journal.read(request.pageOperationId) : null
  if (previous && previous.profileId !== options.profileId) throw new MaitianError('PROFILE_CHANGED', '浏览器资料已变化，无法打开原页面')
  const previousTarget = previous?.targets.find(row => row.targetId === previous.selectedTargetId)
  if (previous && (!previousTarget || typeof previousTarget.browserInstanceId !== 'string' || typeof previousTarget.targetId !== 'string')) throw new MaitianError('PAGE_REFERENCE_LOST', '没有可恢复的原页面记录，请在专用 Chrome 中核对')
  const lock = await acquireProfileLock(options.profileDir, join(options.root, 'locks'))
  let connection, shim
  const record = {
    version: 1, operationId, op, profileId: options.profileId, profileDir: lock.profileDir,
    platform: needsEngine(op) ? platform : null, startedAt: new Date().toISOString(), targets: [],
    ...(engineRef && needsEngine(op) && { engineVersion: engineRef.version, engineFingerprint: engineRef.fingerprint }),
    ...(previous && { pageOperationId: previous.operationId }),
  }
  try {
    if (previous && previous.profileDir !== lock.profileDir) throw new MaitianError('PROFILE_CHANGED', '浏览器资料已变化，无法打开原页面')
    if (needsEngine(op)) await verifyEngine(engineRef)
    if (op === 'open-login') await invalidateAccount(lock.profileDir, platform)
    if (needsEngine(op)) record.accountEpoch = await accountEpoch(lock.profileDir, platform)
    await journal.write(record)
    // Reopening an original target must not launch a replacement browser.
    const browser = await launch({ ...options, existingOnly: op === 'open-page' })
    shim = createChromeShim({
      instanceId: browser.instanceId, send: (...args) => connection.send(...args),
      onTarget: async target => {
        if (record.targets.length >= 100) throw new MaitianError('TARGET_LIMIT', '组件打开页面过多，已停止浏览器操作')
        record.targets.push({ ...target, createdAt: new Date().toISOString() })
        await journal.write(record)
      },
    })
    connection = await connect(browser.websocketURL, (...args) => shim.event(...args))
    let result
    if (op === 'open-page') {
      await shim.openOriginal(previousTarget)
      result = { operationId: previous.operationId, canOpenPage: true }
    } else if (op === 'open-install') {
      const tab = await shim.chrome.tabs.create({ url: STORE_URL, active: true })
      record.selectedTargetId = shim.targetOf(tab.id).targetId
      result = { operationId, canOpenPage: true, opened: 'extension-store' }
    } else {
      const engine = await load(engineRef, shim.chrome)
      const contract = inspectContract(engine)
      if (!contract.platforms[platform]?.mapped) throw new MaitianError('UNSUPPORTED_PLATFORM', '当前麦田组件缺少此平台的工程能力')
      if (op === 'open-login' || op === 'open-management') {
        let url
        try { url = new URL(op === 'open-management' ? engine.publish.ADAPTERS[platform]?.links?.url : engine.publish.ADAPTERS[platform]?.url) } catch {}
        if (!url || url.protocol !== 'https:' || url.username || url.password) throw new MaitianError(op === 'open-management' ? 'INCOMPATIBLE_MANAGEMENT_URL' : 'INCOMPATIBLE_LOGIN_URL', op === 'open-management' ? '麦田组件未提供有效的作品管理入口，请在平台人工打开' : '麦田组件未提供有效的平台入口，需要更新连接层')
        const tab = await shim.chrome.tabs.create({ url: url.href, active: true })
        record.selectedTargetId = shim.targetOf(tab.id).targetId
        result = { operationId, canOpenPage: true, opened: op === 'open-login' ? 'platform-login' : 'platform-management', platform }
      } else {
        if (!contract.operations.preflight) throw new MaitianError('MISSING_PREFLIGHT', '当前麦田组件不提供登录预检，请更新连接层')
        const { summary, tabId } = preflightResult(await engine.publish.preflight([platform], { keepTabs: true }), platform)
        if (tabId !== undefined) record.selectedTargetId = shim.targetOf(tabId).targetId
        result = { operationId, platform, ...summary, canOpenPage: Boolean(record.selectedTargetId), checkedAt: new Date().toISOString(), accountVerification: 'login-only' }
        record.preflight = { ...summary, checkedAt: result.checkedAt }
      }
      await verifyEngine(engineRef)
      result.engineVersion = engineRef.version
    }
    record.completedAt = new Date().toISOString()
    await journal.write(record)
    return result
  } finally {
    // Disconnecting leaves the original tabs and the dedicated browser available to the user.
    connection?.close()
    await lock.release()
  }
}
