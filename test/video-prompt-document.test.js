import assert from 'node:assert/strict'
import test from 'node:test'
import { indexVideoPrompt, copyVideoPromptSection, MAX_PROMPT_TEXT } from '../src/video-prompt-document.js'
import { emptyWorkspace, sanitizeWorkspace } from '../src/workspace-schema.js'
import { createWorkspaceDraft, promptDocument } from '../client/workspace.js'

const text = '全局视频参数：\n视觉风格：自然真实\n技术规格：4K, 24fps\n角色设定：关关，B-roll开启\n\n分镜脚本：\n\n【第1段 - 13.3秒】\n镜头一：|35mm|3.8秒|画面|台词|whoosh\n镜头二：|全景|2.1秒|B-roll|画外音|click\n\n【第2段 - 12.4秒】\n镜头三：|近景|3.6秒|画面|台词|音乐\n'
test('完整文档原样保存与导出，分段复制携带全局参数并保留多镜头', () => {
  const item = { id: 'piece', title: '稿件' }
  const draft = { ...createWorkspaceDraft(item), promptText: text }
  const saved = sanitizeWorkspace(item, draft, emptyWorkspace(item))
  assert.equal(saved.promptText, text)
  assert.equal(promptDocument(item, saved), text)
  const doc = indexVideoPrompt(text)
  assert.deepEqual(doc.sections.map(row => [row.seconds, row.shots]), [[13.3, 2], [12.4, 1]])
  assert.equal(Number(doc.seconds.toFixed(1)), 25.7)
  const part = copyVideoPromptSection(text, 1)
  assert.ok(part.startsWith('全局视频参数：'))
  assert.ok(part.includes('角色设定：关关'))
  assert.ok(part.includes('镜头三：'))
  assert.ok(!part.includes('镜头一：'))
  assert.ok(!part.includes('分镜脚本：'))
})
test('不认识的格式、空文档和超长文本均不被静默重写或截断', () => {
  const item = { id: 'piece', title: '稿件' }
  const current = emptyWorkspace(item)
  for (const value of ['', '任意格式\r\n|台词|音效|']) {
    const saved = sanitizeWorkspace(item, { ...current, promptText: value }, current)
    assert.equal(saved.promptText, value)
    assert.equal(promptDocument(item, saved), value)
  }
  assert.deepEqual(indexVideoPrompt('任意格式').sections, [])
  assert.equal(copyVideoPromptSection(text, 99), '')
  assert.throws(() => sanitizeWorkspace(item, { ...current, promptText: '字'.repeat(MAX_PROMPT_TEXT + 1) }, current))
  assert.throws(() => sanitizeWorkspace(item, { ...current, promptText: {} }, current))
  assert.equal(sanitizeWorkspace(item, { ...current, promptText: undefined }, { ...current, promptText: text }).promptText, text)
})
