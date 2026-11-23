import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MaitianError } from './errors.js'

const fileOf = (profileDir, platform) => {
  if (!['xhs', 'channels'].includes(platform)) throw new MaitianError('INVALID_TARGET', '目标平台无效', 400)
  return join(profileDir, `.media-desk-account-${platform}.json`)
}
export async function accountEpoch(profileDir, platform) {
  const file = fileOf(profileDir, platform)
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > 1000) throw Error('invalid')
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (typeof value.epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(value.epoch)) throw Error('invalid')
    return value.epoch
  } catch (error) {
    if (error.code === 'ENOENT') return 'initial'
    throw new MaitianError('ACCOUNT_STATE_UNREADABLE', '无法核对本机账号确认记录，请重新检查专用浏览器')
  }
}

// Under the profile lock. Opening login may change accounts, even if that operation later fails.
export async function invalidateAccount(profileDir, platform) {
  const file = fileOf(profileDir, platform), temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ epoch: randomUUID(), changedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
