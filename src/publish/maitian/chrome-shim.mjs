import { MaitianError } from './errors.js'
import { STORE_ID } from './engine-loader.mjs'

// Application-owned Chrome API facade. All platform selectors and upload behaviour remain upstream.
export function createChromeShim({ send, instanceId, onTarget = async () => {} }) {
  const tabs = new Map(), targets = new Map(), detachListeners = new Set()
  let counter = 1000, activeTabId = null
  const tab = id => {
    const row = tabs.get(id)
    if (!row) throw new MaitianError('PAGE_LOST', '原发布页已关闭或无法定位，请先核对平台结果')
    return row
  }
  async function session(id) {
    const row = tab(id)
    if (!row.sessionId) await (row.attaching ??= (async () => {
      try {
        row.sessionId = (await send('Target.attachToTarget', { targetId: row.targetId, flatten: true })).sessionId
        await send('Page.enable', {}, row.sessionId)
      } finally { row.attaching = null }
    })())
    return row.sessionId
  }
  async function get(id) {
    const { targetInfo } = await send('Target.getTargetInfo', { targetId: tab(id).targetId })
    return { id, url: targetInfo.url, title: targetInfo.title, windowId: 1, active: id === activeTabId }
  }
  async function adopt(targetId) {
    const { targetInfo } = await send('Target.getTargetInfo', { targetId })
    if (targetInfo.type !== 'page') throw new MaitianError('PAGE_LOST', '原发布页已不存在')
    let id = targets.get(targetId)
    if (id === undefined) {
      id = counter++
      tabs.set(id, { targetId, sessionId: null }); targets.set(targetId, id)
    }
    return get(id)
  }
  const chrome = {
    runtime: { id: STORE_ID },
    tabs: {
      async create({ url = 'about:blank', active = false } = {}) {
        const { targetId } = await send('Target.createTarget', { url, background: !active })
        const id = counter++
        tabs.set(id, { targetId, sessionId: null }); targets.set(targetId, id)
        if (active) activeTabId = id
        // Persist target metadata before returning it to the upstream caller.
        await onTarget({ browserInstanceId: instanceId, targetId, tabId: id })
        return { id, url, windowId: 1, active }
      },
      get,
      async query({ active, windowId } = {}) {
        if (windowId && windowId !== 1) return []
        const ids = active ? (activeTabId === null ? [] : [activeTabId]) : [...tabs.keys()]
        return (await Promise.all(ids.map(id => get(id).catch(() => null)))).filter(Boolean)
      },
      async update(id, { active } = {}) {
        if (active) { await send('Target.activateTarget', { targetId: tab(id).targetId }); activeTabId = id }
        return get(id)
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          if (!tabs.has(id)) continue
          const row = tab(id)
          await send('Target.closeTarget', { targetId: row.targetId })
          targets.delete(row.targetId); tabs.delete(id)
          if (activeTabId === id) activeTabId = null
          for (const listener of detachListeners) listener({ tabId: id })
        }
      },
    },
    debugger: {
      onDetach: { addListener(fn) { detachListeners.add(fn) } },
      async attach({ tabId }) { await session(tabId) },
      async detach({ tabId }) {
        const row = tab(tabId)
        if (!row.sessionId) return
        const previous = row.sessionId; row.sessionId = null
        await send('Target.detachFromTarget', { sessionId: previous })
        for (const listener of detachListeners) listener({ tabId })
      },
      async sendCommand({ tabId }, method, params = {}) { return send(method, params, await session(tabId)) },
    },
    scripting: {
      async executeScript({ target, func, args = [] }) {
        if (typeof func !== 'function' || target?.allFrames) throw new MaitianError('UNSUPPORTED_CHROME_API', '当前连接层不支持组件请求的脚本调用')
        const expression = `(${func.toString()})(...${JSON.stringify(args)})`
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, await session(target.tabId))
        if (result.exceptionDetails) throw new MaitianError('SCRIPT_FAILED', '组件页面脚本执行失败')
        return [{ result: result.result?.value }]
      },
    },
  }
  return {
    chrome,
    targetOf(id) { return { browserInstanceId: instanceId, targetId: tab(id).targetId } },
    async openOriginal({ browserInstanceId, targetId }) {
      if (browserInstanceId !== instanceId) throw new MaitianError('BROWSER_CHANGED', '浏览器实例已更换，无法恢复原发布页')
      const result = await adopt(targetId)
      await chrome.tabs.update(result.id, { active: true })
      return result
    },
    event(method, params) {
      if (method !== 'Target.targetDestroyed') return
      const id = targets.get(params.targetId)
      if (id === undefined) return
      tabs.delete(id); targets.delete(params.targetId)
      if (activeTabId === id) activeTabId = null
      for (const listener of detachListeners) listener({ tabId: id })
    },
  }
}

export class CDPConnection {
  constructor(url, { onEvent = () => {}, timeoutMs = 180_000, socketFactory = url => new WebSocket(url) } = {}) {
    this.url = url; this.onEvent = onEvent; this.timeoutMs = timeoutMs; this.socketFactory = socketFactory
    this.pending = new Map(); this.sequence = 0
  }
  async connect() {
    const socket = this.socket = this.socketFactory(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new MaitianError('CDP_CONNECT_TIMEOUT', '连接专用 Chrome 超时')) }, 10_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new MaitianError('CDP_CONNECT_FAILED', '无法连接专用 Chrome')) }, { once: true })
    })
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) pending.reject(new MaitianError('CDP_COMMAND_FAILED', '组件的浏览器操作失败，请检查原页面'))
        else pending.resolve(message.result)
      } else if (message.method) this.onEvent(message.method, message.params, message.sessionId)
    })
    socket.addEventListener('close', () => this.failAll(new MaitianError('CHROME_DISCONNECTED', '专用 Chrome 连接已中断，请核对平台结果')))
    await this.send('Target.setDiscoverTargets', { discover: true })
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== 1) return reject(new MaitianError('CHROME_DISCONNECTED', '专用 Chrome 尚未连接'))
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MaitianError('CDP_COMMAND_TIMEOUT', '组件的浏览器操作超时，请核对原页面'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })) }
      catch { this.pending.delete(id); clearTimeout(timer); reject(new MaitianError('CHROME_DISCONNECTED', '专用 Chrome 连接已中断')) }
    })
  }
  failAll(error) {
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error) }
    this.pending.clear()
  }
  close() { this.failAll(new MaitianError('CHROME_DISCONNECTED', '专用 Chrome 连接已关闭')); this.socket?.close() }
}
