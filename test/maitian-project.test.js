import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, scheduleISO, topicsOf } from '../src/publish/maitian/project.js'
import { checkFaststart } from '../src/publish/maitian/media.js'

test('单目标工程映射保留文案、话题去重、视频号独立短标题；无预约不生成空值', () => {
  const copy = { platform: '小红书', format: 'video', mode: 'manual', title: '一个标题', description: '一段正文', tags: '#主题一，#主题二 #主题一' }
  const data = createProject({ id: 'piece-job', copy, platform: 'xhs', video: 'video.mp4', covers: { '3x4': 'cover-3x4.png' }, durationSec: 90 })
  assert.deepEqual(Object.keys(data.platforms), ['xhs'])
  assert.deepEqual(data.platforms.xhs.topics, ['主题一', '主题二'])
  assert.equal(Object.hasOwn(data, 'schedule'), false)
  assert.deepEqual(data.platforms.xhs.covers, ['3x4'])
  const channels = createProject({ id: 'piece-job', copy: { ...copy, platform: '视频号', browser: { shortTitle: '独立短标题' } }, platform: 'channels', video: 'video.mp4' })
  assert.equal(channels.platforms.channels.shortTitle, '独立短标题')
  assert.equal(Object.hasOwn(channels.platforms.channels, 'title'), false)
  assert.throws(() => createProject({ id: 'piece-job', copy, platform: 'xhs', video: '../secret.mp4' }), /文件名无效/)
  assert.deepEqual(topicsOf(' #a #a, #b\n#中文 '), ['a', 'b', '中文'])
})

test('时区转换独立于宿主，拒绝无效日期及 DST 重复/不存在时间', () => {
  assert.equal(scheduleISO('2026-12-01T18:00', 'Asia/Shanghai'), '2026-12-01T10:00:00.000Z')
  assert.equal(scheduleISO('2026-12-01T18:00', 'Asia/Tokyo'), '2026-12-01T09:00:00.000Z')
  assert.throws(() => scheduleISO('2026-02-30T12:00', 'Asia/Shanghai'), /日期无效/)
  assert.throws(() => scheduleISO('2026-12-01T18:00', 'not-a-timezone'), /时区无效/)
  assert.throws(() => scheduleISO('2026-03-08T02:30', 'America/New_York'), /不存在或重复/)
  assert.throws(() => scheduleISO('2026-11-01T01:30', 'America/New_York'), /不存在或重复/)
})

const box = (name, bytes = 0) => { const buffer = Buffer.alloc(bytes + 8); buffer.writeUInt32BE(buffer.length); buffer.write(name, 4); return buffer }
test('MP4 faststart 检查跨过大 padding，拒绝尾 moov、截断和缺失媒体 box', async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-mp4-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'video.mp4')
  await writeFile(file, Buffer.concat([box('ftyp'), box('free', 100_000), box('moov'), box('mdat', 12)]))
  await checkFaststart(file)
  for (const bytes of [Buffer.concat([box('ftyp'), box('mdat'), box('moov')]), box('ftyp'), Buffer.concat([box('ftyp'), Buffer.from('1234')])]) {
    await writeFile(file, bytes)
    await assert.rejects(checkFaststart(file), error => error.code === 'INVALID_FASTSTART')
  }
})
