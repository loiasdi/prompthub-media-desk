import { join } from 'node:path'
import { browserOptions } from './browser-operation.mjs'
import { ensureBrowser } from './browser.mjs'
import { CDPConnection, createChromeShim } from './chrome-shim.mjs'
import { BrowserOperations } from './browser-operations.js'
import { acquireProfileLock } from './profile-lock.js'
import { loadEngine, verifyEngine } from './engine-loader.mjs'
import { accountEpoch } from './account-state.js'
import { inspectContract, CONTRACT_VERSION } from './contract.js'
import { TASK_ID } from './task-project.js'
import { linkResult } from './results.js'
import { MaitianError } from './errors.js'

// A result query uses stored project data, never new-upload rules or expiring snapshot bytes.
export async function reviewOperation(request, {
  launch = ensureBrowser, load = loadEngine,
  connect = async (url, onEvent) => {
    const connection = new CDPConnection(url, { onEvent })
    try { await connection.connect(); return connection }
    catch (error) { connection.close(); throw error }
  },
} = {}) {
  const { taskId, runId, platform, engineRef, projectRef } = request
  if (![taskId, runId, projectRef?.projectId].every(id => TASK_ID.test(id || '')) || !['xhs', 'channels'].includes(platform) ||
      request.contractVersion !== CONTRACT_VERSION || projectRef?.data?.version !== 1 || !projectRef.data.platforms?.[platform] ||
      Object.keys(projectRef.data.platforms).length !== 1) throw new MaitianError('INCOMPATIBLE_QUERY_PROJECT', '当前查询入口无法读取原任务工程，请在平台人工核对')
  const options = browserOptions(request.browser)
  const lock = await acquireProfileLock(options.profileDir, join(options.root, 'locks'))
  const journal = new BrowserOperations(options.root)
  const record = { version: 1, operationId: runId, op: 'collect-links', taskId, runId, platform, profileId: options.profileId, profileDir: lock.profileDir,
    startedAt: new Date().toISOString(), engineVersion: engineRef?.version, engineFingerprint: engineRef?.fingerprint, targets: [] }
  let connection, shim
  try {
    if (request.expectedProfileDir !== lock.profileDir || await accountEpoch(lock.profileDir, platform) !== request.accountEpoch) throw new MaitianError('ACCOUNT_CHANGED', '浏览器资料或已知登录状态已变化，请重新核对账号')
    await journal.write(record)
    await verifyEngine(engineRef)
    const browser = await launch(options)
    shim = createChromeShim({ instanceId: browser.instanceId, send: (...args) => connection.send(...args), onTarget: async target => {
      if (record.targets.length >= 100) throw new MaitianError('TARGET_LIMIT', '组件打开页面过多，已停止浏览器操作')
      record.targets.push({ ...target, taskId, runId, platform, createdAt: new Date().toISOString() })
      await journal.write(record)
    } })
    connection = await connect(browser.websocketURL, (...args) => shim.event(...args))
    const engine = await load(engineRef, shim.chrome), contract = inspectContract(engine)
    if (!contract.operations['collect-links'] || !contract.platforms[platform]?.canCollectLinks) throw new MaitianError('MISSING_COLLECT_LINKS', '当前麦田组件不支持此平台的结果查询，请在平台人工核对')
    const raw = await engine.publish.collectLinks({ dir: projectRef.projectId, data: projectRef.data }, [platform], {})
    const result = linkResult(raw, platform, { privatePaths: [options.root, options.profileDir, options.chromePath, engineRef.dir] })
    await verifyEngine(engineRef)
    if (await accountEpoch(lock.profileDir, platform) !== request.accountEpoch) throw new MaitianError('ACCOUNT_CHANGED', '查询期间已知登录状态变化，请重新核对账号')
    record.completedAt = new Date().toISOString()
    await journal.write(record)
    return { result, queriedAt: record.completedAt, engineVersion: engineRef.version, engineFingerprint: engineRef.fingerprint }
  } finally { connection?.close(); await lock.release() }
}
