import { join } from 'node:path'
import { browserOptions } from './browser-operation.mjs'
import { acquireProfileLock } from './profile-lock.js'
import { ensureBrowser } from './browser.mjs'
import { CDPConnection, createChromeShim } from './chrome-shim.mjs'
import { BrowserOperations } from './browser-operations.js'
import { loadEngine, verifyEngine } from './engine-loader.mjs'
import { inspectContract, preflightResult, validationResult } from './contract.js'
import { accountEpoch } from './account-state.js'
import { TASK_ID, verifyTaskProject } from './task-project.js'
import { TaskControls } from './task-controls.js'
import { fillState } from './fill-state.js'
import { MaitianError } from './errors.js'

export async function fillOperation(request, { authorize, emit = async () => {}, shouldStop = () => false }, {
  launch = ensureBrowser, load = loadEngine,
  connect = async (url, onEvent) => {
    const connection = new CDPConnection(url, { onEvent })
    try { await connection.connect(); return connection }
    catch (error) { connection.close(); throw error }
  },
} = {}) {
  const { taskId, runId, engineRef, platform, projectRef } = request
  if (![taskId, runId].every(id => TASK_ID.test(id || '')) || !['xhs', 'channels'].includes(platform) || typeof authorize !== 'function') throw new MaitianError('INVALID_TASK_REQUEST', '浏览器填写请求无效', 400)
  const options = browserOptions(request.browser)
  const lock = await acquireProfileLock(options.profileDir, join(options.root, 'locks'))
  const journal = new BrowserOperations(options.root), controls = new TaskControls(options.root)
  const record = { version: 1, operationId: runId, op: 'fill', taskId, runId, platform, profileId: options.profileId, profileDir: lock.profileDir,
    startedAt: new Date().toISOString(), targets: [], engineVersion: engineRef?.version, engineFingerprint: engineRef?.fingerprint }
  let connection, shim, cancelled = false, controlError, progressError, progress = Promise.resolve(), controlCheck = Promise.resolve(), events = 0
  const checkStop = async () => {
    cancelled ||= shouldStop() || await controls.cancelled(taskId, runId)
    if (cancelled) throw new MaitianError('RUNNER_CANCELLED', '已停止浏览器填写；请核对平台是否已有上传内容')
  }
  const timer = setInterval(() => {
    controlCheck = controlCheck.then(checkStop).catch(error => { cancelled = true; controlError = error })
  }, 250)
  timer.unref()
  try {
    await journal.write(record)
    await checkStop()
    const fixed = await verifyTaskProject(join(options.root, 'runs'), projectRef)
    if (!fixed.project.data.platforms[platform]) throw new MaitianError('INVALID_TASK_REQUEST', '固定工程与目标平台不符', 400)
    if (await accountEpoch(lock.profileDir, platform) !== request.accountEpoch) throw new MaitianError('ACCOUNT_CHANGED', '登录状态已变化，请重新预检并核对账号')
    await verifyEngine(engineRef)
    const browser = await launch(options)
    shim = createChromeShim({
      instanceId: browser.instanceId, send: (...args) => connection.send(...args),
      onTarget: async target => {
        if (record.targets.length >= 100) throw new MaitianError('TARGET_LIMIT', '组件打开页面过多，已停止浏览器操作')
        record.targets.push({ ...target, taskId, runId, platform, createdAt: new Date().toISOString() })
        await journal.write(record)
      },
    })
    connection = await connect(browser.websocketURL, (...args) => shim.event(...args))
    const engine = await load(engineRef, shim.chrome)
    const contract = inspectContract(engine)
    if (!['validate', 'preflight', 'fill'].every(op => contract.operations[op]) || !contract.platforms[platform]?.mapped) throw new MaitianError('UNSUPPORTED_OPERATION', '当前麦田组件缺少填写或校验能力，请更新组件或连接层')
    const validation = validationResult(await engine.bundle.validate(fixed.project.data, new Set(fixed.files)))
    if (validation.errors.length) throw new MaitianError('UPSTREAM_VALIDATION', validation.errors.join('\n'), 422)
    const preflight = preflightResult(await engine.publish.preflight([platform], { keepTabs: true }), platform)
    if (preflight.tabId !== undefined) record.preflightTargetId = shim.targetOf(preflight.tabId).targetId
    record.preflight = { ...preflight.summary, checkedAt: new Date().toISOString() }
    await journal.write(record)
    if (!preflight.summary.ok) throw new MaitianError('PREFLIGHT_FAILED', '原版登录预检未通过，请打开专用 Chrome 核对账号')
    await verifyEngine(engineRef)
    await checkStop()
    // The Host must persist executionIntentAt before authorising this gate.
    await authorize()
    await checkStop()
    await verifyTaskProject(join(options.root, 'runs'), projectRef)
    await verifyEngine(engineRef)
    if (await accountEpoch(lock.profileDir, platform) !== request.accountEpoch) throw new MaitianError('ACCOUNT_CHANGED', '登录状态已变化，请重新预检并核对账号')
    record.enteredRunAt = new Date().toISOString()
    await journal.write(record)
    const onChange = state => {
      try {
        if (++events > 10_000) throw new MaitianError('RUNNER_EVENT_LIMIT', '组件进度事件过多，已请求停止后续操作')
        const normalized = fillState(state, platform)
        const target = normalized.raw.tabId === null ? null : shim.targetOf(normalized.raw.tabId)
        if (target) record.selectedTargetId = target.targetId
        record.lastState = normalized.raw
        progress = progress.then(async () => {
          await journal.write(record)
          await emit('progress', { state: normalized.raw, phase: normalized.phase })
        }).catch(error => { progressError = error; cancelled = true })
      } catch (error) { progressError = error; cancelled = true }
    }
    // Never call adapter.fill or implement any platform steps in this connector.
    const states = await engine.publish.run(fixed.project, {
      rootPath: join(options.root, 'runs'), platforms: [platform], onChange,
      shouldStop: () => cancelled || shouldStop(),
    })
    await progress
    await controlCheck
    if (progressError) throw progressError
    if (controlError && controlError.code !== 'RUNNER_CANCELLED') throw controlError
    const final = fillState(states?.[platform], platform)
    if (final.raw.tabId !== null) record.selectedTargetId = shim.targetOf(final.raw.tabId).targetId
    record.lastState = final.raw
    await checkStop()
    await verifyEngine(engineRef)
    record.completedAt = new Date().toISOString()
    await journal.write(record)
    return { operationId: runId, state: final.raw, filled: final.filled, warnings: validation.warnings }
  } finally {
    clearInterval(timer)
    await progress
    await controlCheck
    connection?.close()
    await lock.release()
  }
}
