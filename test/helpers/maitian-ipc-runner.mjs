import { readFile, writeFile } from 'node:fs/promises'

// Protocol test peer, never used by the product and contains no browser/platform implementation.
process.once('message', request => {
  const envelope = { protocolVersion: 1, requestId: request.requestId, taskId: request.taskId, runId: request.runId }
  const send = message => process.send({ ...envelope, ...message })
  if (request.op === 'collect-links') {
    send({ seq: 99, type: 'result', runId: 'old-query-run', result: { status: 'spoof' } })
    send({ seq: 1, type: 'result', result: { result: { status: '未找到', url: null } } })
    setTimeout(() => process.disconnect(), 100)
    return
  }
  if (request.op !== 'prepare-fill') throw Error('No fill instruction before durable authorisation')
  if (request.projectRef.mode === 'silent') { setInterval(() => {}, 1000); return }
  send({ seq: 99, type: 'progress', runId: 'wrong-run', state: { status: 'spoof' } })
  send({ seq: 1, type: 'ready' })
  send({ seq: 1, type: 'ready' })
  const heartbeat = setInterval(() => send({ seq: Date.now(), type: 'heartbeat' }), 5000)
  let done = false
  process.on('message', async message => {
    if (message.requestId !== request.requestId || message.runId !== request.runId || done) return
    if (message.type === 'cancel') {
      if (request.projectRef.mode === 'timeout-ignore') return
      done = true
      await writeFile(request.projectRef.marker, 'cancel-observed')
      setTimeout(() => { clearInterval(heartbeat); process.disconnect() }, 200)
    } else if (message.type === 'execute') {
      if (request.projectRef.mode?.startsWith('timeout-')) {
        await writeFile(request.projectRef.marker, 'execution-began')
        return
      }
      done = true
      const marker = await readFile(request.projectRef.marker, 'utf8')
      send({ seq: 2, type: 'progress', state: { status: marker } })
      send({ seq: 3, type: 'result', result: { marker } })
      setTimeout(() => { clearInterval(heartbeat); process.disconnect() }, 150)
    }
  })
})
