import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { processIdentity } from './profile-lock.js'
import { MaitianError } from './errors.js'

const exec = promisify(execFile)
async function listenerPids(port) {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3000, maxBuffer: 64_000 })
    return stdout.trim().split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0)
  } catch (error) {
    if (error.code === 1) return []
    throw new MaitianError('PORT_CHECK_FAILED', '无法核对专用 Chrome 端口，请检查本机环境')
  }
}
const ownsPort = async (pid, port) => (await listenerPids(port)).includes(pid)
async function saveRecord(file, record) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  await rename(temporary, file)
}

async function version(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
  if (!response.ok) throw new Error('unavailable')
  const value = await response.json()
  const websocket = new URL(value.webSocketDebuggerUrl)
  if (websocket.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(websocket.hostname) || Number(websocket.port) !== port || !/^\/devtools\/browser\/[^/]+$/.test(websocket.pathname)) throw new MaitianError('INVALID_BROWSER_ENDPOINT', '专用 Chrome 调试地址无效')
  return { websocketURL: websocket.href, instanceId: websocket.pathname.split('/').at(-1) }
}

// Must be called under acquireProfileLock. It never adopts an unknown process found on the port.
export async function ensureBrowser({ profileDir, chromePath, port, headless = false, existingOnly = false }) {
  if (process.platform !== 'darwin' && !headless) throw new MaitianError('UNSUPPORTED_OS', '当前浏览器执行器先支持本机 macOS Chrome')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const canonical = await realpath(profileDir)
  const recordFile = join(canonical, '.media-desk-browser.json')
  let existing
  try { existing = JSON.parse(await readFile(recordFile, 'utf8')) } catch {}
  let endpoint
  try { endpoint = await version(port) } catch (error) { if (error instanceof MaitianError) throw error }
  if (endpoint) {
    if (!existing || existing.profileDir !== canonical || existing.port !== port || existing.instanceId && existing.instanceId !== endpoint.instanceId || await processIdentity(existing.pid) !== existing.identity || !existing.identity?.includes(`--user-data-dir=${canonical}`) || !await ownsPort(existing.pid, port)) throw new MaitianError('CHROME_PORT_CONFLICT', '调试端口属于其他浏览器实例，请选择空闲端口')
    if (!existing.instanceId) await saveRecord(recordFile, { ...existing, instanceId: endpoint.instanceId })
    return { ...endpoint, pid: existing.pid, profileDir: canonical, created: false }
  }
  if ((await listenerPids(port)).length) throw new MaitianError('CHROME_PORT_CONFLICT', '调试端口被其他进程占用，请选择空闲端口')
  // A live browser for this profile without its expected CDP endpoint must not be launched a second time.
  if (existing?.identity && await processIdentity(existing.pid) === existing.identity) throw new MaitianError('CHROME_NOT_READY', '专用 Chrome 仍在运行但调试连接不可用，请先检查该窗口')
  if (existingOnly) throw new MaitianError('BROWSER_CHANGED', '原专用 Chrome 已停止，无法恢复原页面，请核对平台结果')
  const args = [
    `--user-data-dir=${canonical}`, '--profile-directory=Default', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []), 'about:blank',
  ]
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' })
  let failed = false
  child.on('error', () => { failed = true })
  child.unref()
  let record
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250)
    if (failed) throw new MaitianError('CHROME_START_FAILED', '无法启动专用 Chrome，请检查浏览器路径')
    if (!record) {
      const identity = await processIdentity(child.pid)
      if (identity?.includes(`--user-data-dir=${canonical}`)) {
        record = { pid: child.pid, identity, profileDir: canonical, port, instanceId: null, startedAt: new Date().toISOString() }
        await saveRecord(recordFile, record)
      }
    }
    try { endpoint = await version(port) } catch (error) { if (error instanceof MaitianError) throw error }
    if (!endpoint) continue
    const identity = await processIdentity(child.pid)
    if (!record || !identity || !identity.includes(`--user-data-dir=${canonical}`) || !await ownsPort(child.pid, port)) throw new MaitianError('CHROME_OWNERSHIP_FAILED', '无法确认专用 Chrome 进程归属，请检查端口')
    await saveRecord(recordFile, { ...record, identity, instanceId: endpoint.instanceId })
    return { ...endpoint, pid: child.pid, profileDir: canonical, created: true }
  }
  throw new MaitianError('CHROME_START_TIMEOUT', '专用 Chrome 启动超时，请检查该窗口与端口')
}
