import { cp, mkdir, readdir, readFile, writeFile, rename, rm, realpath, mkdtemp } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, basename, join, resolve, isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import { Settings } from './settings.js'

const fail = message => Object.assign(new Error(message), { status: 400 })
const inside = (parent, child) => { const path = relative(parent, child); return !path || (!path.startsWith('..') && !isAbsolute(path)) }
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
  if (typeof input !== 'string' || !isAbsolute(input.trim())) throw fail('文档目录需要填写绝对路径')
  if (env.MEDIA_DESK_DATA_DIR) throw fail('当前目录由 MEDIA_DESK_DATA_DIR 指定，请先移除环境变量后再修改')
  return store.run(async () => {
    await store.refresh()
    const source = await realpath(store.root)
    const requested = resolve(input.trim())
    await mkdir(dirname(requested), { recursive: true })
    const target = join(await realpath(dirname(requested)), basename(requested))
    if (target === source) return { root: store.root, moved: false }
    if (inside(source, target) || inside(target, source)) throw fail('新旧文档目录不能互相包含，请选择独立文件夹')
    const configHome = env.DSH_HOME || join(homedir(), '.dsh')
    if (inside(target, resolve(configHome))) throw fail('文档目录不能包含应用配置目录')
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
      await mkdir(configHome, { recursive: true })
      const configPath = join(configHome, 'media-desk-storage.json')
      const config = JSON.parse(await readFile(configPath, 'utf8').catch(err => { if (err.code !== 'ENOENT') throw err; return '{}' }))
      const tmp = `${configPath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ ...config, root: target, markdown: store.markdown }, null, 2), { mode: 0o600 })
      await rename(tmp, configPath)
      store.useRoot(target)
      await store.refresh()
      return { root: target, moved: true, backupRoot: source }
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true })
    }
  })
}
