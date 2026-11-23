import { loadEngine, verifyEngine } from './engine-loader.mjs'
import { inspectContract, probeChrome, validationResult, RUNNER_OPERATIONS } from './contract.js'
import { browserOperation, BROWSER_OPERATIONS } from './browser-operation.mjs'
import { MaitianError, publicFailure } from './errors.js'
import { fillOperation } from './fill-operation.mjs'
import { reviewOperation } from './review-operation.mjs'

const PROTOCOL_VERSION = 1
let received = false
let cancelled = false, activeRequest, controlSequence = 0, releaseGate
process.on('message', message => {
  if (!activeRequest || message?.protocolVersion !== 1 || message.requestId !== activeRequest.requestId ||
      message.taskId !== activeRequest.taskId || message.runId !== activeRequest.runId ||
      !Number.isSafeInteger(message.controlSeq) || message.controlSeq <= controlSequence) return
  controlSequence = message.controlSeq
  if (message.type === 'cancel') { cancelled = true; releaseGate?.(false) }
  else if (message.type === 'execute') releaseGate?.(!cancelled)
})
process.once('message', async request => {
  if (received) return
  received = true
  let seq = 0
  const send = (type, payload) => new Promise(resolve => {
    if (!process.connected) return resolve()
    process.send({ protocolVersion: PROTOCOL_VERSION, requestId: request?.requestId,
      ...(['prepare-fill', 'collect-links'].includes(request?.op) && { taskId: request.taskId, runId: request.runId }), seq: ++seq, type, ...payload }, () => resolve())
  })
  const heartbeat = setInterval(() => { void send('heartbeat', {}) }, 5000)
  heartbeat.unref()
  try {
    if (request?.protocolVersion !== PROTOCOL_VERSION || !(request.op === 'prepare-fill' || request.op !== 'fill' && RUNNER_OPERATIONS.includes(request.op)) || typeof request.requestId !== 'string') throw new MaitianError('INVALID_PROTOCOL', '执行器请求无效', 400)
    if (!['hello', 'validate'].includes(request.op) && (typeof globalThis.WebSocket !== 'function' || typeof globalThis.fetch !== 'function')) throw new MaitianError('UNSUPPORTED_RUNTIME', '浏览器操作需要支持 WebSocket 和 fetch 的独立 Node 环境')
    if (request.op === 'collect-links') {
      await send('result', { result: await reviewOperation(request) })
      return
    }
    if (request.op === 'prepare-fill') {
      activeRequest = request
      const result = await fillOperation(request, {
        emit: send, shouldStop: () => cancelled,
        authorize: async () => {
          const gate = new Promise(resolve => { releaseGate = resolve })
          await send('ready', {})
          if (cancelled || !await gate) throw new MaitianError('RUNNER_CANCELLED', '已停止浏览器填写；请核对平台是否已有上传内容')
          releaseGate = undefined
        },
      })
      await send('result', { result })
      return
    }
    if (BROWSER_OPERATIONS.includes(request.op)) {
      const result = await browserOperation(request)
      await send('result', { result })
      return
    }
    const engine = await loadEngine(request.engineRef, probeChrome())
    const contract = inspectContract(engine)
    let result
    if (request.op === 'hello') result = {
      compatibility: 'structural-compatible', version: request.engineRef.version,
      fingerprint: request.engineRef.fingerprint, runtimeVersion: process.version, ...contract,
    }
    else {
      if (!contract.operations.validate) throw new MaitianError('MISSING_VALIDATE', '当前麦田组件不提供工程校验，请更新连接层')
      if (!Array.isArray(request.files) || request.files.length > 100 || request.files.some(file => typeof file !== 'string') || !request.data || typeof request.data !== 'object') throw new MaitianError('INVALID_PROJECT', '工程数据无效', 400)
      result = validationResult(await engine.bundle.validate(request.data, new Set(request.files)))
    }
    await verifyEngine(request.engineRef)
    await send('result', { result })
  } catch (error) { await send('error', { error: publicFailure(error) }) }
  finally { clearInterval(heartbeat); process.disconnect?.() }
})
process.on('disconnect', () => { process.exit(0) })
