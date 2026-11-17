import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { applyOps } from '../src/ops.js'
import { normalizePlan, applyRevision } from '../src/produce.js'
import { sourceCopy } from '../src/workspace-schema.js'

test('稿件元信息通过操作保存后重启可恢复，也支持清空描述和话题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manuscript-meta-'))
  try {
    const store = new Store(root)
    await store.mutate('', state => { state.items = [{ id: 'piece', title: '灵感', production: { title: '原标题', article: '脚本正文' } }] }, { undoable: false })
    await store.mutate('元信息', state => applyOps(state, [{ op: 'update_production', id: 'piece', title: '稿件标题', description: '发布描述', topics: '#AI #教程' }]))
    const item = (await new Store(root).read()).items[0]
    assert.deepEqual(sourceCopy(item), { title: '稿件标题', description: '发布描述', tags: '#AI #教程', platform: '小红书' })
    applyOps({ items: [item] }, [{ op: 'update_production', id: 'piece', description: '', topics: '' }])
    assert.equal(sourceCopy(item).description, '')
    assert.equal(sourceCopy(item).tags, '')
    assert.equal(item.production.article, '脚本正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('生成规划与助手改稿均包含描述和话题', () => {
  const plan = normalizePlan({ title: '标题', description: '发布简介', topics: ['AI', '#效率', 1] }, { imageCount: 0, shotCount: 0 }, '原题')
  assert.equal(plan.description, '发布简介')
  assert.equal(plan.topics, '#AI #效率')
  const production = { title: '标题', description: '旧简介', topics: '#旧话题' }
  applyRevision(production, { description: '新简介', topics: '#新话题' })
  assert.equal(production.description, '新简介')
  assert.equal(production.topics, '#新话题')
})

test('新建灵感无需先生成即可手写稿件，元信息和正文保存后重启可恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manuscript-new-'))
  try {
    const store = new Store(root)
    await store.mutate('', state => { state.items = [{ id: 'new', title: '新灵感', body: '已有想法', tags: ['AI'], status: 'idea' }] }, { undoable: false })
    for (const patch of [{ title: '手写标题' }, { description: '手写简介', topics: '#教程' }, { article: '第一段\n\n第二段' }]) {
      const result = await store.mutate('手写稿件', state => applyOps(state, [{ op: 'update_production', id: 'new', ...patch }]))
      assert.deepEqual(result.errors, [])
    }
    const item = (await new Store(root).read()).items[0]
    assert.equal(item.production.status, 'done')
    assert.equal(item.status, 'draft')
    assert.equal(item.production.article, '第一段\n\n第二段')
    assert.equal(item.body, '已有想法')
    assert.deepEqual(sourceCopy(item), { title: '手写标题', description: '手写简介', tags: '#教程', platform: '小红书' })
    const result = applyOps({ items: [item] }, [{ op: 'update_production', id: 'new', article: '', description: '', topics: '' }])
    assert.deepEqual(result.errors, [])
    assert.equal(item.production.article, '')
  } finally { await rm(root, { recursive: true, force: true }) }
})
