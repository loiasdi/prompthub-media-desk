import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, scheduleISO, topicsOf } from '../src/publish/maitian/project.js'
import { MAITIAN_PLATFORMS } from '../src/publish/maitian/platforms.js'
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
  assert.throws(() => createProject({ id: 'piece-job', copy: { ...copy, platform: '视频号', browser: { shortTitle: '  ' } }, platform: 'channels', video: 'video.mp4' }), /必须填写视频号短标题/)
  assert.throws(() => createProject({ id: 'piece-job', copy, platform: 'xhs', video: '../secret.mp4' }), /文件名无效/)
  assert.deepEqual(topicsOf(' #a #a, #b\n#中文 '), ['a', 'b', '中文'])
})

test('多平台打包导出在同一份 publish.json 中同时映射小红书与视频号并合并封面比例', () => {
  const copy = { platform: 'B站', format: 'video', mode: 'now', title: '多平台标题', description: '共享正文', tags: '#AI #创作', browser: { shortTitle: '视频号短标' } }
  const data = createProject({ id: 'piece-bundle', copy, platforms: ['xhs', 'channels'], video: 'video.mp4', covers: { '3x4': 'cover-3x4.png', '4x3': 'cover-4x3.jpg' }, durationSec: 45 })
  assert.deepEqual(Object.keys(data.platforms), ['xhs', 'channels'])
  assert.deepEqual(data.platforms.xhs, { title: '多平台标题', body: '共享正文', topics: ['AI', '创作'], covers: ['3x4'] })
  assert.deepEqual(data.platforms.channels, { shortTitle: '视频号短标', body: '共享正文', topics: ['AI', '创作'], covers: ['3x4', '4x3'] })
  assert.deepEqual(data.covers, { '3x4': 'cover-3x4.png', '4x3': 'cover-4x3.jpg' })
  assert.throws(() => createProject({ id: 'piece-bundle', copy, platforms: [], video: 'video.mp4' }), /请选择麦田支持/)
})

test('七平台工程按原版字段写入文案和标签，Instagram 优先单张 16:9 封面，X 不引用封面', () => {
  const copy = { platform: 'B站', format: 'video', mode: 'now', title: '完整标题', description: '第一行\n第二行', tags: '#AI #创作', browser: { shortTitle: '独立短标题内容' } }
  const platforms = MAITIAN_PLATFORMS.map(p => p.id)
  const covers = { '3x4': 'vertical.jpg', '4x3': 'horizontal.jpg', '16x9': 'wide.jpg' }
  const data = createProject({ id: 'all-platforms', copy, platforms, video: 'video.mp4', covers })
  assert.deepEqual(Object.keys(data.platforms), ['bilibili', 'xhs', 'douyin', 'channels', 'youtube', 'x', 'instagram'])
  assert.deepEqual(data.platforms.bilibili, { title: copy.title, desc: copy.description, tags: ['AI', '创作'], covers: ['4x3'] })
  assert.deepEqual(data.platforms.douyin, { title: copy.title, body: copy.description, topics: ['AI', '创作'], covers: ['3x4', '4x3'] })
  assert.deepEqual(data.platforms.youtube, { title: copy.title, desc: copy.description, tags: ['AI', '创作'], covers: ['16x9'] })
  assert.deepEqual(data.platforms.x, { text: '完整标题\n\n第一行\n第二行\n\n#AI #创作', covers: [] })
  assert.deepEqual(data.platforms.instagram, { caption: data.platforms.x.text, covers: ['16x9'] })
  const fallback = createProject({ id: 'ig', copy, platforms: ['instagram'], video: 'video.mp4', covers: { '4x3': covers['4x3'] } })
  assert.deepEqual(fallback.platforms.instagram.covers, ['4x3'])
  assert.throws(() => createProject({ id: 'unknown', copy, platforms: ['kuaishou'], video: 'video.mp4' }), /请选择麦田支持/)
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
