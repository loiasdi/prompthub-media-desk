import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { MaitianError, componentChanged } from './errors.js'

export const STORE_ID = 'eaaipbilkhibicihiollecmbpneikpnj'
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ID}`
const fail = () => new MaitianError('COMPONENT_UNREADABLE', '无法只读加载麦田原版组件，请检查安装是否完整')
const versionParts = value => value.split(/[._]/).map(Number)
export function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] || 0) - (y[i] || 0)
    if (difference) return difference
  }
  return 0
}

// This is application-owned discovery only. No upstream code is copied, patched or written.
export async function discoverEngine({ source = 'store', profileDir, localComponentDir } = {}) {
  let directory
  if (source === 'local') directory = localComponentDir
  else if (source === 'store' && profileDir) {
    const base = join(profileDir, 'Default', 'Extensions', STORE_ID)
    let entries
    try { entries = await readdir(base) } catch (error) {
      if (error.code !== 'ENOENT') throw fail()
      entries = []
    }
    const latest = entries.filter(name => /^\d+(?:\.\d+)*_\d+$/.test(name)).sort(compareVersions).at(-1)
    if (latest) directory = join(base, latest)
  }
  if (!directory) throw new MaitianError('COMPONENT_NOT_INSTALLED', '请先在专用 Chrome 中安装麦田发布助手')
  const inspected = await inspectEngine(directory)
  return { source, ...inspected }
}

export async function inspectEngine(directory) {
  try {
    if (typeof directory !== 'string' || !(await lstat(directory)).isDirectory()) throw fail()
    const dir = await realpath(directory)
    const manifestFile = join(dir, 'manifest.json')
    const manifestInfo = await lstat(manifestFile)
    if (!manifestInfo.isFile() || manifestInfo.size > 100_000) throw fail()
    const manifestBytes = await readFile(manifestFile)
    const manifest = JSON.parse(manifestBytes)
    if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || '')) throw fail()
    const hash = createHash('sha256').update('manifest.json\0').update(manifestBytes)
    const modules = []
    let bytes = manifestBytes.length
    async function walk(folder, prefix) {
      const info = await lstat(folder)
      if (!info.isDirectory()) throw fail()
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const relative = `${prefix}/${entry.name}`
        const file = join(folder, entry.name)
        if (entry.isDirectory()) await walk(file, relative)
        else {
          if (!entry.isFile()) throw fail()
          const stat = await lstat(file)
          bytes += stat.size
          if (bytes > 32_000_000 || modules.length >= 2000) throw fail()
          const body = await readFile(file)
          hash.update(relative + '\0').update(String(body.length) + '\0').update(body)
          modules.push(relative)
        }
      }
    }
    await walk(join(dir, 'lib'), 'lib')
    if (!modules.includes('lib/publish.js') || !modules.includes('lib/bundle.js')) throw fail()
    return { dir, version: manifest.version, fingerprint: hash.digest('hex'), modules }
  } catch (error) {
    if (error instanceof MaitianError) throw error
    throw fail()
  }
}

export async function verifyEngine(reference) {
  let current
  try { current = await inspectEngine(reference.dir) } catch { throw componentChanged() }
  if (current.version !== reference.version || current.fingerprint !== reference.fingerprint) throw componentChanged()
  return current
}

let registeredRoot
export async function loadEngine(reference, chrome) {
  await verifyEngine(reference)
  if (registeredRoot && registeredRoot !== resolve(reference.dir)) throw new MaitianError('RUNNER_REUSE', '组件版本必须在新的执行进程中加载')
  globalThis.chrome = chrome
  if (!registeredRoot) {
    register(new URL('./esm-hooks.mjs', import.meta.url), { parentURL: import.meta.url, data: { root: reference.dir, files: reference.modules } })
    registeredRoot = resolve(reference.dir)
  }
  const bundle = await import(pathToFileURL(join(reference.dir, 'lib/bundle.js')).href)
  const publish = await import(pathToFileURL(join(reference.dir, 'lib/publish.js')).href)
  await verifyEngine(reference)
  return { bundle, publish }
}
