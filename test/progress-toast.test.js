import assert from 'node:assert/strict'
import test from 'node:test'
import { getDesk, setDesk, startProgressToast } from '../client/desk.js'

test('进度 Toast 与普通提示独立，先结束的请求不会关闭后启动的提示', () => {
  const feedback = { text: '已保存' }
  setDesk({ toast: feedback })
  const finishFirst = startProgressToast('正在推荐标题…')
  assert.equal(getDesk().progressToast.text, '正在推荐标题…')
  assert.equal(getDesk().toast, feedback)
  const finishSecond = startProgressToast('正在生成封面图…')
  finishFirst()
  assert.equal(getDesk().progressToast.text, '正在生成封面图…')
  finishSecond()
  assert.equal(getDesk().progressToast, null)
  assert.equal(getDesk().toast, feedback)
  setDesk({ toast: null })
})
