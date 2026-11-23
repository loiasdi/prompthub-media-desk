import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MaitianError } from './errors.js'
import { RUNNER_OPERATIONS } from './contract.js'
import { TASK_ID } from './task-project.js'

const RUNNER = fileURLToPath(new URL('./runner.mjs', import.meta.url))
export function runComponent({ nodePath = process.execPath, engineRef, op, data, files, browser, platform, operationId, pageOperationId,
  taskId, runId, projectRef, accountEpoch, contractVersion, expectedProfileDir, onSpawn, onReady, onEvent, onTimeout,
  timeoutMs = op === 'fill' ? 4 * 3600_000 + 120_000 : op === 'collect-links' ? 180_000 : op === 'preflight' ? 120_000 : 30_000,
  heartbeatMs = 30_000, stopGraceMs = 30_000, signal } = {}, { runnerFile = RUNNER } = {}) {
  return new Promise((resolve, reject) => {
    if (!RUNNER_OPERATIONS.includes(op)) return reject(new MaitianError('UNSUPPORTED_OPERATION', '组件操作尚未支持', 400))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 || !Number.isSafeInteger(stopGraceMs) || stopGraceMs < 0 || stopGraceMs > 60_000) return reject(new MaitianError('INVALID_TIMEOUT', '组件进程保护时限无效', 400))
    const filling = op === 'fill', task = filling || op === 'collect-links'
    if (task && (![taskId, runId].every(id => TASK_ID.test(id || '')) || filling && typeof onReady !== 'function')) return reject(new MaitianError('INVALID_TASK_REQUEST', '浏览器任务请求无效', 400))
    if (signal?.aborted) return reject(new MaitianError('RUNNER_CANCELLED', '组件操作已取消'))
    const requestId = randomUUID()
    let child, sequence = 0, controlSeq = 0, settled = false, outcome, logBytes = 0, lastHeartbeat = Date.now(), events = Promise.resolve(), ready = false
    let timeoutFailure, forceTimer, timeoutEvent
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(forceTimer); clearInterval(watchdog)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error); else resolve(result)
    }
    const stop = error => {
      outcome = { error }
      child?.kill('SIGKILL')
    }
    const control = type => {
      if (!child.connected) return
      child.send({ protocolVersion: 1, requestId, taskId, runId, controlSeq: ++controlSeq, type }, error => { if (error) stop(new MaitianError('RUNNER_SEND_FAILED', '无法连接组件执行器')) })
    }
    // Fill uses upstream shouldStop; its current step can continue. Forced stop is timeout-only.
    const cancel = () => filling ? control('cancel') : stop(new MaitianError('RUNNER_CANCELLED', '组件操作已取消'))
    const timer = setTimeout(() => {
      timeoutFailure = new MaitianError('RUNNER_TIMEOUT', filling ? '已达到本地填写保护时限，执行器已停止；请核对原平台页面，上传可能仍在继续' : '组件操作超时，请检查专用 Chrome、Node 与组件安装')
      if (!filling) return stop(timeoutFailure)
      // Give upstream shouldStop a bounded opportunity, while retaining the lease until child close.
      control('cancel')
      timeoutEvent = Promise.resolve().then(() => onTimeout?.()).catch(() => stop(timeoutFailure))
      forceTimer = setTimeout(() => stop(timeoutFailure), stopGraceMs)
      forceTimer.unref()
    }, timeoutMs)
    timer.unref()
    const watchdog = setInterval(() => {
      if (!outcome && Date.now() - lastHeartbeat > heartbeatMs) stop(new MaitianError('RUNNER_HEARTBEAT_LOST', '组件执行器心跳中断，请核对原页面'))
    }, Math.min(5000, heartbeatMs))
    watchdog.unref()
    try {
      child = fork(runnerFile, [], { execPath: nodePath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', windowsHide: true })
    } catch { return finish(new MaitianError('RUNNER_START_FAILED', '无法启动组件执行器，请检查 Node 路径')) }
    signal?.addEventListener('abort', cancel, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      logBytes += chunk.length
      if (logBytes > 256_000) stop(new MaitianError('RUNNER_OUTPUT_LIMIT', '组件输出过多，已停止操作'))
    })
    child.on('message', message => {
      if (outcome || !message || JSON.stringify(message).length > 1_000_000 || message.protocolVersion !== 1 || message.requestId !== requestId ||
          task && (message.taskId !== taskId || message.runId !== runId) || !Number.isSafeInteger(message.seq) || message.seq <= sequence) return
      sequence = message.seq
      lastHeartbeat = Date.now()
      events = events.then(async () => {
        if (outcome) return
        if (message.type === 'ready') {
          if (!filling || ready) throw new MaitianError('INVALID_PROTOCOL', '组件执行器重复请求执行，请核对原页面')
          ready = true
          if (timeoutFailure) { control('cancel'); return }
          await onReady()
          control(timeoutFailure || signal?.aborted ? 'cancel' : 'execute')
        } else if (['heartbeat', 'progress', 'warning'].includes(message.type)) await onEvent?.(message)
        else if (message.type === 'result') outcome = { result: message.result }
        else if (message.type === 'error') {
          const err = message.error
          outcome = { error: new MaitianError(typeof err?.code === 'string' ? err.code.slice(0, 100) : 'RUNNER_FAILED', typeof err?.message === 'string' ? err.message.slice(0, 1000) : '组件操作失败', [400, 409, 422, 502].includes(err?.status) ? err.status : 502) }
        }
      }).catch(stop)
    })
    child.once('error', () => {
      const error = new MaitianError('RUNNER_START_FAILED', '无法启动组件执行器，请检查 Node 路径')
      if (child.pid) stop(error); else finish(error)
    })
    child.once('close', async () => {
      await events
      await timeoutEvent
      finish(timeoutFailure || outcome?.error || (!outcome ? new MaitianError('RUNNER_EXITED', '组件执行器提前退出') : undefined), outcome?.result)
    })
    void (async () => {
      try {
        if (child.pid) await onSpawn?.({ pid: child.pid })
        if (settled || outcome) return
        if (timeoutFailure) { stop(timeoutFailure); return }
        if (signal?.aborted) throw new MaitianError('RUNNER_CANCELLED', '组件操作已取消')
        lastHeartbeat = Date.now()
        // Bootstrap may inspect login and fixed bytes; only execute authorises publish.run.
        child.send({ protocolVersion: 1, requestId, op: filling ? 'prepare-fill' : op, engineRef, data, files, browser, platform, operationId, pageOperationId,
          taskId, runId, projectRef, accountEpoch, contractVersion, expectedProfileDir }, error => { if (error) stop(new MaitianError('RUNNER_SEND_FAILED', '无法连接组件执行器')) })
      } catch (error) { stop(error) }
    })()
  })
}
