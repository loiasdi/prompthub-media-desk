import { cp, mkdir, readdir, readFile, writeFile, rename, rm, realpath, mkdtemp, lstat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, basename, join, resolve, isAbsolute, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { Settings } from './settings.js'
import { activeRecord, readPublishRecords } from './publish/records.js'
import { tr } from './i18n.js'

const fail = message => Object.assign(new Error(tr(message)), { status: 400 })
const inside = (parent, child) => { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
const missing = err => { if (err.code !== 'ENOENT') throw err; return null }
const configHomeOf = env => env.DSH_HOME || join(homedir(), '.dsh')

function requestedPath(input, env) {
  if (typeof input !== 'string' || !isAbsolute(input.trim())) throw fail('文档目录需要填写绝对路径')
  if (env.MEDIA_DESK_DATA_DIR) throw fail('当前目录由 MEDIA_DESK_DATA_DIR 指定，请先移除环境变量后再修改')
  return resolve(input.trim())
}

async function checkSwitch(source, target, configHome) {
  if (source === target) return
  if (inside(source, target) || inside(target, source)) throw fail('新旧文档目录不能互相包含，请选择独立文件夹')
  const appHome = await realpath(configHome).catch(missing) ?? resolve(configHome)
  if (inside(target, appHome)) throw fail('文档目录不能包含应用配置目录')
  if ((await readPublishRecords(source)).some(activeRecord)) throw Object.assign(new Error(tr('有投稿任务正在进行，请完成后再更换目录')), { status: 409 })
}

async function activate(store, configHome, root, markdown = store.markdown) {
  await mkdir(configHome, { recursive: true })
  const path = join(configHome, 'media-desk-storage.json')
  const config = JSON.parse(await readFile(path, 'utf8').catch(missing) ?? '{}')
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ ...config, root, markdown }, null, 2), { mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
  } finally { await rm(tmp, { force: true }) }
  store.useRoot(root, markdown)
}

// 打开已有工作台只切换本机配置，不复制数据，也不应用当前工作台的设置。
export async function openStorage(store, input, { env = process.env } = {}) {
  const requested = requestedPath(input, env)
  const invalid = () => fail('该目录不是有效的 MediaDesk 工作台，请选择包含原有 state.json 的目录')
  return store.run(async () => {
    if (!(await lstat(requested).catch(missing))?.isDirectory()) throw invalid()
    const root = await realpath(requested)
    const configHome = configHomeOf(env)
    await checkSwitch(await realpath(store.root), root, configHome)
    const stateFile = join(root, 'state.json')
    if (!(await lstat(stateFile).catch(missing))?.isFile()) throw invalid()
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) }
    catch (err) { if (err instanceof SyntaxError || err.code === 'ENOENT') throw invalid(); throw err }
    if (state?.version !== 1 || !['items', 'people', 'angles', 'skills', 'accounts', 'metrics', 'chat'].every(key => Array.isArray(state[key])) ||
      !state.items.every(item => typeof item?.id === 'string' && /^[\w-]+$/.test(item.id))) throw invalid()
    for (const path of ['files', '内容', '回收站', join('回收站', '内容')]) {
      const info = await lstat(join(root, path)).catch(missing)
      if (info && !info.isDirectory()) throw invalid()
    }
    const [settingsFile, markdownManifest] = await Promise.all(['settings.json', '.markdown-manifest.json'].map(path => lstat(join(root, path)).catch(missing)))
    if ([settingsFile, markdownManifest].some(info => info && !info.isFile())) throw invalid()
    let settings
    try { settings = await new Settings(root).read() }
    catch (err) { if (err instanceof SyntaxError || err instanceof TypeError) throw invalid(); throw err }
    if (![1, 3, 7, 15].includes(settings.trashRetentionDays) || typeof settings.image.apiKey !== 'string') throw invalid()
    const markdown = store.markdown || Boolean(markdownManifest)
    await activate(store, configHome, root, markdown)
    return { storage: { root, moved: false, opened: true }, settings }
  })
}

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function verify(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.state-lock')) continue
    if (entry.isSymbolicLink()) throw fail('文档目录中存在符号链接，请先移除后重试')
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) await verify(from, to)
    else if (!entry.isFile() || await digest(from) !== await digest(to)) throw fail(`目录迁移校验失败：${entry.name}`)
  }
}

// 旧目录保留为备份；所有文件校验完毕后才更新全局配置并切换。
export async function relocateStorage(store, input, { env = process.env, settingsPatch } = {}) {
  const requested = requestedPath(input, env)
  return store.run(async () => {
    await store.refresh()
    const source = await realpath(store.root)
    await mkdir(dirname(requested), { recursive: true })
    const target = join(await realpath(dirname(requested)), basename(requested))
    if (target === source) return { root: store.root, moved: false }
    const configHome = configHomeOf(env)
    await checkSwitch(source, target, configHome)
    const existing = await readdir(target).catch(err => { if (err.code !== 'ENOENT') throw err; return [] })
    if (existing.length) throw fail('目标目录不是空目录，请选择一个新的或空的文件夹')
    const staging = await mkdtemp(join(dirname(target), `.${basename(target)}-迁移-`))
    let published = false
    try {
      for (const entry of await readdir(source)) {
        if (!entry.startsWith('.state-lock')) await cp(join(source, entry), join(staging, entry), { recursive: true, preserveTimestamps: true, dereference: false })
      }
      await verify(source, staging)
      // 飞书同步身份继续沿用迁移前的工作台，避免重复建文档和上传。
      const state = JSON.parse(await readFile(join(staging, 'state.json'), 'utf8'))
      state.storageIdentityRoot ||= store.root
      await writeFile(join(staging, 'state.json'), JSON.stringify(state))
      if (settingsPatch) await new Settings(staging).update(settingsPatch)
      await rename(staging, target)
      published = true
      await activate(store, configHome, target)
      await store.refresh()
      return { root: target, moved: true, backupRoot: source }
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true })
    }
  })
}
