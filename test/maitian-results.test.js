import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReview, linkResult, workURL } from '../src/publish/maitian/results.js'

test('首次同标题候选不等于本次发布，不从 URL 推测作品 ID 或候选数量', () => {
  const result = linkResult({ xhs: { status: '已发布', url: 'https://www.xiaohongshu.com/explore/old', time: '2026-11-23 10:00', cookie: 'secret' } }, 'xhs')
  const record = { status: 'awaiting_user' }, review = { result }
  applyReview(record, review)
  assert.equal(record.status, 'awaiting_user')
  assert.equal(record.lastReview.needsConfirmation, true)
  assert.equal(Object.hasOwn(result, 'workId'), false)
  assert.equal(Object.hasOwn(result, 'candidateCount'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(result.time, '2026-11-23 10:00')
})

test('只有人工关联 ID 与原版显式同 ID 对上才更新；同 URL、另一个 ID、未知状态和无候选不能推进', () => {
  for (const candidate of [
    { status: '已发布', workId: 'work-a' },
    { status: '已发布', url: 'https://www.xiaohongshu.com/explore/work-a' },
    { status: '已发布', workId: 'work-b' },
    { status: '新状态', workId: 'work-a' },
    { status: '已发布', workId: 'work-a', candidateCount: 0 },
  ]) {
    const record = { status: 'pending_review', association: { source: 'manual-confirmed', workId: 'work-a', url: 'https://www.xiaohongshu.com/explore/work-a' } }
    applyReview(record, { result: linkResult({ xhs: candidate }, 'xhs') })
    const matches = candidate.workId === 'work-a' && candidate.status === '已发布' && candidate.candidateCount !== 0
    assert.equal(record.status, matches ? 'published' : 'pending_review')
    if (matches) assert.equal(record.evidenceSource, 'upstream-matched-id')
  }
})

test('视频号允许无链接，原版 time 不自动当成实际预约；未知返回保留状态', () => {
  const result = linkResult({ channels: { status: '定时', url: '', time: '11月24日 08:00', note: '视频号作品没有网页链接' } }, 'channels')
  assert.equal(result.url, null)
  assert.equal(result.normalizedStatus, 'scheduled')
  assert.equal(Object.hasOwn(result, 'actualScheduleAt'), false)
  const record = { status: 'unknown' }
  applyReview(record, { result })
  assert.equal(record.status, 'unknown')
  assert.equal(record.lastReview.needsConfirmation, true)
  for (const status of ['constructor', '__proto__', 'toString']) assert.equal(linkResult({ channels: { status } }, 'channels').normalizedStatus, null)
})

test('非法网址不保存也不自动推进；过滤凭证、页面原文和本机路径，结构变化明确失败', () => {
  for (const url of ['javascript:alert(1)', 'file:///private/file', 'http://www.xiaohongshu.com/explore/a', 'https://www.xiaohongshu.com.evil.invalid/a', 'https://user:pass@www.xiaohongshu.com/explore/a', 'https://127.0.0.1/a', 'https://www.xiaohongshu.com/explore/a?access_token=secret']) {
    assert.throws(() => workURL('xhs', url), error => error.code === 'INVALID_WORK_URL')
    const result = linkResult({ xhs: { status: '已发布', workId: 'work-a', url } }, 'xhs')
    assert.equal(result.url, null)
    assert.deepEqual(result.rejectedFields, ['url'])
    const record = { status: 'unknown', association: { source: 'manual-confirmed', workId: 'work-a' } }
    applyReview(record, { result })
    assert.equal(record.status, 'unknown')
  }
  const safe = linkResult({ xhs: { status: '出错', note: '/private/engine/lib/module.js ws://127.0.0.1:9333/devtools/browser/id\nCookie: secret\n<html>private page' } }, 'xhs', { privatePaths: ['/private/engine'] })
  assert.doesNotMatch(JSON.stringify(safe), /\/private|devtools|secret|private page/)
  for (const value of [{}, { xhs: { status: true } }, { xhs: { status: '已发布', candidateCount: '1' } }, { xhs: { status: '已发布', note: '<'.repeat(5001) } }]) assert.throws(() => linkResult(value, 'xhs'))
})
