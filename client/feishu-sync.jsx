import React from 'react'
import { Dialog } from './ui.jsx'
import { flushWorkspace, formatBytes } from './workspace.js'

async function request(path, data) {
  const response = await fetch('media-desk/feishu/' + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw Error(result.error || '飞书请求失败')
  return result
}
const actions = { reuse: '无需上传', new: '新增上传', update: '重新上传' }
export function FeishuSyncDialog({ item, onClose }) {
  const [config, setConfig] = React.useState(null), [form, setForm] = React.useState({}), [settingsOpen, setSettingsOpen] = React.useState(false)
  const [preview, setPreview] = React.useState(null), [selected, setSelected] = React.useState([]), [overwrite, setOverwrite] = React.useState(false)
  const [busy, setBusy] = React.useState(''), [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [job, setJob] = React.useState(null)
  const running = job?.status === 'running'
  React.useEffect(() => {
    let active = true
    request('config').then(c => { if (active) { setConfig(c); setForm({ ...c, appSecret: '' }); setSettingsOpen(!c.ready) } }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [])
  React.useEffect(() => {
    if (!running) return undefined
    let active = true, timer
    const poll = async () => {
      try { const next = await request('job?id=' + job.id); if (active) { setJob(next); if (next.status === 'running') timer = setTimeout(poll, 1000) } }
      catch (e) { if (active) { setError(e.message); timer = setTimeout(poll, 3000) } }
    }
    timer = setTimeout(poll, 500)
    return () => { active = false; clearTimeout(timer) }
  }, [job?.id, running])
  const act = async (name, fn) => { setBusy(name); setError(''); setNotice(''); try { await fn() } catch (e) { setError(e.message) } finally { setBusy('') } }
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const save = async () => { const c = await request('config', form); setConfig(c); setForm({ ...c, appSecret: '' }); setPreview(null); setNotice('配置已保存在本机，未写入 Obsidian') }
  const inspect = () => act('preview', async () => {
    await flushWorkspace(item.id)
    const p = await request('preview', { id: item.id })
    setPreview(p); setSelected(p.assets.filter(a => a.type === 'image').map(a => a.id)); setOverwrite(false); setJob(null)
  })
  const close = () => { if (!running && !busy) onClose() }
  const disabled = Boolean(busy || running)
  return <Dialog title="同步到飞书" onClose={close} width={760}>
    <div className="md-form md-feishu-form">
      <p>将当前稿件、视频提示词、封面提示词及选定素材同步到飞书。本地文件始终保留，飞书的修改不会回写工作台。</p>
      <details open={settingsOpen} onToggle={e => setSettingsOpen(e.currentTarget.open)}>
        <summary>首次配置与创建指引</summary>
        <ol>
          <li>到 <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开放平台</a> 创建企业自建应用，开启机器人能力。记下凭证页的 App ID 和 App Secret。</li>
          <li>申请云文档读写、云空间文件读写和多维表格读写权限，创建版本并发布。个人租户或企业管理员须批准这些权限。</li>
          <li>在飞书云空间建一个专用文件夹，给应用授予编辑权限（可将应用机器人加入群，再让群成为文件夹协作者）。填写文件夹链接中 <code>folder/</code> 后的标识。</li>
          <li>新建多维表格，给应用添加编辑权限。链接中 <code>base/</code> 后是 App Token，<code>table=</code> 后是 Table ID。请使用独立表格；同步时会补建标题、制作状态、稿件文档、素材链接、最近同步时间和工作台ID字段，主字段用作标题。</li>
          <li>填写下方配置，保存后检查连接。连接成功再预览同步内容。</li>
        </ol>
        {[['appId', 'App ID'], ['appSecret', config?.hasSecret ? 'App Secret（已保存，留空保留）' : 'App Secret'], ['folderToken', '目标文件夹 Token'], ['appToken', '多维表格 App Token'], ['tableId', '数据表 Table ID']].map(([key, label]) => <label key={key} className="md-field"><span>{label}</span><input disabled={disabled || !config} type={key === 'appSecret' ? 'password' : 'text'} autoComplete="off" value={form[key] || ''} onChange={e => set(key, e.target.value)} /></label>)}
        <div className="md-work-actions"><button type="button" className="md-btn" disabled={disabled || !config} onClick={() => act('save', save)}>保存配置</button><button type="button" className="md-btn" disabled={disabled || !config?.ready} onClick={() => act('test', async () => { const r = await request('test', {}); setNotice(r.missingFields.length ? `连接成功，同步时将创建字段：${r.missingFields.join('、')}` : '连接成功，文件夹和表格可读取') })}>检查连接</button></div>
      </details>
      <div className="md-work-actions"><button type="button" className="md-btn is-primary" disabled={disabled || !config?.ready} onClick={inspect}>{busy === 'preview' ? '正在读取飞书与核对文件…' : '读取飞书并预览同步'}</button></div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert" className="md-feishu-error">{error}</p> : null}
      {preview ? <>
        <section className="md-work-panel"><h3>飞书已有内容</h3>
          {preview.syncedAt ? <p>上次同步：{new Date(preview.syncedAt).toLocaleString()}</p> : null}
          {preview.document ? <><a href={preview.document.url} target="_blank" rel="noreferrer">打开稿件文档：{preview.document.title}</a><details><summary>查看飞书文档内容</summary><pre>{preview.document.text}</pre></details></> : <p>这篇稿件尚未同步过文档。</p>}
          {preview.record ? <details><summary>查看多维表格已有字段</summary><pre>{JSON.stringify(preview.record, null, 2)}</pre></details> : null}
          <details><summary>文件夹中的文件（{preview.files.length}）</summary>{preview.files.map((f, i) => <div key={i}>{f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a> : f.name} · {f.type}</div>)}</details>
          <small>只对工作台已记录的文件按内容指纹去重。以前手动上传的文件可查看，目前不会自动判为相同文件。</small>
        </section>
        <section className="md-work-panel"><h3>本次同步计划</h3><p>稿件及提示词：{preview.textAction === 'reuse' ? '内容未变化' : preview.textAction === 'new' ? '新建文档和记录' : '更新已有文档和记录'}。文件内容相同则复用；仅改文件名不重传。图片会直接展示在这篇稿件的文档中，视频和音频保留文件链接。视频需手动勾选。</p>
          {preview.missingFields.length ? <p>将新增表格字段：{preview.missingFields.join('、')}</p> : null}
          {preview.assets.map(a => <label className="md-feishu-asset" key={a.id}><input type="checkbox" disabled={disabled} checked={selected.includes(a.id)} onChange={e => setSelected(s => e.target.checked ? [...s, a.id] : s.filter(id => id !== a.id))} /><span>{a.name}<small>{formatBytes(a.size)} · {actions[a.action]}{a.type === 'video' ? ' · 视频' : ''}</small></span></label>)}
          {!preview.assets.length ? <p>暂无可上传的本地素材。</p> : null}
          {preview.remoteEdited ? <label><input type="checkbox" disabled={disabled} checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> 飞书内容有修改，确认用本地内容更新工作台管理的文档与表格字段</label> : null}
          <p><small>旧版文件和未选素材不会从飞书删除。同步前会再次核对内容；变化后需重新预览。</small></p>
          <button type="button" className="md-btn is-primary" disabled={disabled || (preview.remoteEdited && !overwrite) || Boolean(job)} onClick={() => act('sync', async () => { await flushWorkspace(item.id); setJob(await request('sync', { token: preview.token, assetIds: selected, overwrite })) })}>确认同步到飞书</button>
        </section>
      </> : null}
      {job ? <div role="status"><p>{job.message}</p>{running ? <progress max="100" value={job.percent} /> : null}{job.status === 'done' ? <p>新上传 {job.uploaded} 个，复用 {job.reused} 个。<a href={job.url} target="_blank" rel="noreferrer">打开飞书文档</a></p> : null}{job.status === 'error' ? <p>已完成的文件会保留记录，请重新预览后重试。</p> : null}</div> : null}
    </div>
  </Dialog>
}
