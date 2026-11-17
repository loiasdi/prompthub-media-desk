import { BRAND_NAME } from '../src/brand.js'
import { playableVideo, sourceKind, sourceImage } from '../src/inspiration-source.js'
import { FeishuSyncDialog } from './feishu-sync.jsx'
import React from 'react'
import { closeItem, dispatchOps, revealSaved, runProduce, setDesk, toast, useDesk } from './desk.js'
import { t, useLang } from './i18n.js'
import { Dialog, Icon, IconButton, Segmented } from './ui.jsx'
import { PLATFORMS, STATUSES, STATUS_LABEL, displayItem } from './util.js'
import { ASSET_ROLE_NAMES, cancelWorkspaceImport, downloadText, importWorkspaceFiles, recycleWorkspaceAsset, formatBytes, flushWorkspace, promptDocument, runCoverAction, useWorkspace, workspaceId } from './workspace.js'

import { copyVideoPromptSection, indexVideoPrompt, MAX_PROMPT_TEXT } from '../src/video-prompt-document.js'

import { COVER_RATIOS, COVER_STYLES } from '../src/cover-design-schema.js'

const TYPES = [{ id: 'all', name: '全部素材', icon: 'folder' }, { id: 'video', name: '视频', icon: 'film' }, { id: 'image', name: '图片', icon: 'image' }, { id: 'audio', name: '音频', icon: 'play' }]
const ROLE_NAMES = ASSET_ROLE_NAMES
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,.m4a'

function mediaInfo(asset) {
  const parts = [formatBytes(asset.bytes)]
  const width = asset.width || asset.w
  const height = asset.height || asset.h
  if (width && height) parts.push(`${width} × ${height}`)
  if (asset.duration) parts.push(`${Math.floor(asset.duration / 60)}:${String(Math.floor(asset.duration % 60)).padStart(2, '0')}`)
  return parts.join(' · ')
}

function Field({ label, children }) {
  return <label className="md-field"><span>{t(label)}</span>{children}</label>
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('已复制')) }
  catch { toast(t('复制失败，请手动选择文字复制'), { error: true }) }
}

export function ContentWorkspace({ item, children }) {
  const [feishuOpen, setFeishuOpen] = React.useState(false)
  useLang()
  const tab = useDesk(s => s.studioTab === 'script' ? 'prompts' : s.studioTab || 'article')
  const assistantOpen = useDesk(s => s.studioDock) || item.production?.status === 'running'
  const { draft, update, assets, syncPublish, persistence, retrySave, reloadWorkspace } = useWorkspace(item)
  const title = displayItem(item).title
  const tabs = [{ id: 'idea', name: '灵感', icon: 'pen' }, { id: 'outline', name: '大纲', icon: 'pen' }, { id: 'article', name: '稿件', icon: 'pen' }, { id: 'prompts', name: '视频提示词', icon: 'film' }, { id: 'cover', name: '配图与封面', icon: 'image' }, { id: 'assets', name: '素材', icon: 'folder', count: assets.length }, { id: 'publish', name: '发布', icon: 'upRight' }]
  const statusIndex = STATUSES.indexOf(item.status || 'idea')
  const nextStatus = STATUSES[statusIndex + 1]
  const changeStatus = async status => {
    if (status === 'outline' && ['idea', 'outline'].includes(item.status)) {
      await flushWorkspace(item.id)
      const result = await dispatchOps([{ op: 'set_status', id: item.id, status }], { label: t('开始整理大纲') })
      if (!result || result.errors?.length) return
      setDesk({ studioTab: 'outline' })
      return
    }
    if (status === 'draft' && ['idea', 'outline'].includes(item.status) && !(draft.outlineText || '').trim()) {
      setDesk({ studioTab: 'outline' })
      toast(t('先在大纲页整理内容结构，再确认进入写稿'))
      return
    }
    await flushWorkspace(item.id)
    const result = await dispatchOps([...(status === 'draft' && !item.production ? [{ op: 'update_production', id: item.id, article: '' }] : []), { op: 'set_status', id: item.id, status }], { label: t('修改状态') })
    if (!result || result.errors?.length) return
    if (status === 'ready') setDesk({ studioTab: 'publish' })
    else if (status === 'draft') setDesk({ studioTab: 'article' })
    else if (status === 'idea') setDesk({ studioTab: 'idea' })
  }
  const onTab = id => setDesk({ studioTab: id })
  return (
    <div className="md-content-workspace">
      {feishuOpen ? <FeishuSyncDialog item={item} onClose={() => setFeishuOpen(false)} /> : null}
      <header className="md-workspace-header">
        <div className="md-workspace-title"><IconButton icon="chevL" label={t('返回内容')} onClick={closeItem} /><div><span title={t('内容档案')}>{BRAND_NAME}</span><h1 title={title}>{title}</h1></div></div>
        <div className="md-workspace-tools">
          <label className="md-workspace-status"><span>{t('状态')}</span><select aria-label={t('内容状态')} value={item.status || 'idea'} disabled={item.production?.status === 'running'} onChange={e => changeStatus(e.target.value)}>{STATUSES.map(status => <option value={status} key={status}>{t(STATUS_LABEL[status])}</option>)}</select></label>
          {nextStatus ? <button type="button" className="md-btn is-small" disabled={item.production?.status === 'running'} onClick={() => changeStatus(nextStatus)}>{t(nextStatus === 'published' ? '标记已发布' : `进入${STATUS_LABEL[nextStatus]}`)}<Icon name="chevR" size={13} /></button> : null}
          <div className="md-workspace-item-tools">
            {item.production?.savedAt ? <IconButton icon="folder" label={t('打开保存的文件夹')} onClick={() => revealSaved(item.id)} /> : null}
            {item.production?.status === 'done' ? <IconButton icon="refresh" label={t('重新成稿')} onClick={() => setDesk({ dialog: { title: t('重新成稿'), submitLabel: t('重新生成'), fields: [{ name: 'note', label: t('现在的文章、封面和分镜会被替换，也会再消耗一次模型额度。'), type: 'hidden' }], onSubmit: () => runProduce(item.id) } })} /> : null}
            <IconButton icon="gear" label={t('设置')} onClick={() => setDesk({ settingsOpen: true })} />
            <IconButton icon="trash" label={t('删除这条灵感')} onClick={async () => { await dispatchOps([{ op: 'delete_item', id: item.id }], { label: t('删除《{title}》', { title: item.title.slice(0, 10) }) }); closeItem() }} />
          </div><button type="button" className="md-btn is-small" onClick={() => setFeishuOpen(true)}>同步到飞书</button><button type="button" className={`md-btn is-small ${assistantOpen ? 'is-active' : ''}`} aria-expanded={assistantOpen} aria-controls="studio-assistant" onClick={() => setDesk({ studioDock: !assistantOpen })}><Icon name="chat" size={14} />{t('创作助手')}</button><button type="button" className="md-btn is-primary is-small" onClick={() => onTab('publish')}><Icon name="upRight" size={14} />{t('准备发布')}</button></div>
      </header>
      <aside className="md-workspace-nav"><div role="tablist" aria-orientation="vertical" aria-label={t('内容档案')}>{tabs.map(entry => <button key={entry.id} id={`workspace-tab-${entry.id}`} type="button" role="tab" aria-label={t(entry.name)} title={t(entry.name)} aria-selected={tab === entry.id} aria-controls={`workspace-panel-${entry.id}`} tabIndex={tab === entry.id ? 0 : -1} className={tab === entry.id ? 'is-on' : ''} onClick={() => onTab(entry.id)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = tabs.findIndex(row => row.id === entry.id)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length
        onTab(tabs[next].id)
        document.getElementById(`workspace-tab-${tabs[next].id}`)?.focus()
      }}><Icon name={entry.icon} size={15} />{t(entry.name)}{entry.count !== undefined ? <span>{entry.count}</span> : null}</button>)}</div><span className="md-workspace-preview" role="status">{persistence.status === 'error' ? <><span>{t('保存失败')}：{persistence.error}</span><button type="button" onClick={() => persistence.conflict ? setDesk({ dialog: { title: t('重新加载工作区'), fields: [{ name: 'notice', type: 'hidden', label: t('这会丢弃当前窗口未保存的修改，可先导出草稿') }], onSubmit: () => reloadWorkspace().catch(err => toast(err.message, { error: true })) } }) : retrySave().catch(err => toast(err.message, { error: true }))}>{t(persistence.conflict ? '重新加载' : '重试保存')}</button><button type="button" onClick={() => downloadText(JSON.stringify(draft, null, 2), `${item.title}-draft.json`, 'application/json')}>{t('导出草稿')}</button></> : t(persistence.status === 'saved' ? '已保存' : persistence.status === 'saving' ? '正在保存…' : '有未保存修改')}</span></aside>
      <section className={`md-workspace-panel ${tab === 'article' ? 'is-manuscript' : ''}`} role="tabpanel" id={`workspace-panel-${tab}`} aria-labelledby={`workspace-tab-${tab}`} key={`${item.id}:${tab}`}>
        {tab === 'article' ? children : <>
          {tab === 'idea' || tab === 'outline' ? <PlanningPage item={item} draft={draft} update={update} mode={tab} /> : tab === 'prompts' ? <PromptPage item={item} draft={draft} update={update} assets={assets} /> : tab === 'cover' ? <CoverDesignPage item={item} draft={draft} update={update} assets={assets} /> : tab === 'assets' ? <AssetsPage item={item} draft={draft} update={update} assets={assets} persistence={persistence} /> : <PublishPage item={item} draft={draft} update={update} assets={assets} onTab={onTab} syncPublish={syncPublish} />}
        </>}
      </section>
    </div>
  )
}

function InspirationSource({ item, compact = false, single = false }) {
  const mediaItems = item.mediaItems || []
  const [broken, setBroken] = React.useState(false)
  const kind = sourceKind(item)
  const labels = { image: '图片灵感', video: '视频灵感', web: '网页灵感', quote: '金句灵感', note: '笔记灵感' }
  const image = sourceImage(item)
  if (!single && mediaItems.length > 1) return <section className="md-inspiration-collection"><div className="md-inspiration-source-head">{t('灵感素材')} · {mediaItems.length}</div><div className="md-inspiration-gallery">{mediaItems.map(media => <InspirationSource key={media.src} item={{ title: media.name || item.title, kind: media.kind, media }} compact={compact} single />)}</div>{item.body ? <p className="md-inspiration-source-text">{item.body}</p> : null}</section>
  return <section className={`md-inspiration-source ${compact ? 'is-compact' : ''}`}>
    <div className="md-inspiration-source-head"><span>{t(labels[kind] || '灵感来源')}</span>{item.source ? <small>{item.source}</small> : null}</div>
    {playableVideo(item) ? <video key={item.media.src} controls playsInline preload="metadata" src={item.media.src} poster={item.media.poster} onError={() => setBroken(true)} /> : image && !broken ? <a href={item.url || image} target="_blank" rel="noreferrer"><img src={image} alt={item.title || t('灵感图片')} referrerPolicy="no-referrer" onError={() => setBroken(true)} /></a> : null}
    {broken ? <p className="md-inspiration-source-note">{t('媒体预览暂不可用，可打开原始来源查看')}</p> : null}
    {kind === 'video' && !playableVideo(item) ? <p className="md-inspiration-source-note">{t('这是视频分享页面，点击原视频到平台观看')}</p> : null}
    <h3>{item.title}</h3>
    {kind === 'quote' ? <blockquote>{item.body || item.title}</blockquote> : item.body ? <p className="md-inspiration-source-text">{item.body}</p> : null}
    {item.url ? <a className="md-inspiration-source-link" href={item.url} target="_blank" rel="noreferrer"><Icon name="upRight" size={14} />{t(kind === 'video' ? '打开原视频' : kind === 'image' ? '打开原图' : '打开原始链接')}</a> : null}
    {!item.url && item.media?.src ? <a className="md-inspiration-source-link" href={item.media.src} target="_blank" rel="noreferrer">{t(kind === 'video' ? '打开视频文件' : '查看原图')}</a> : null}
  </section>
}

function PlanningPage({ item, draft, update, mode }) {
  const [busy, setBusy] = React.useState(false)
  const isOutline = mode === 'outline'
  const idea = draft.ideaText ?? (item.body || (item.kind === 'quote' ? item.title : '') || item.url || '')
  const outline = draft.outlineText || ''
  const advance = async () => {
    setBusy(true)
    try {
      await flushWorkspace(item.id)
      if (['idea', 'outline'].includes(item.status)) {
        const result = await dispatchOps([...(isOutline && !item.production ? [{ op: 'update_production', id: item.id, article: '' }] : []), { op: 'set_status', id: item.id, status: isOutline ? 'draft' : 'outline' }], { label: t(isOutline ? '确认大纲，开始写稿' : '开始整理大纲') })
        if (!result || result.errors?.length) return
      }
      setDesk({ studioTab: isOutline ? 'article' : 'outline' })
    } catch (err) { toast(err.message, { error: true }) }
    finally { setBusy(false) }
  }
  const brief = `请根据以下灵感整理视频口播大纲，先明确核心观点、开场钩子、论点与例子顺序、结尾互动，不写完整正文。\n标题：${item.production?.title || item.title}\n灵感来源：${item.url || item.media?.src || item.kind}\n原始内容：${item.body || item.title}\n补充想法：${idea}\n已有大纲：${outline}`
  return <div className="md-production-page md-planning-page">
    <div className="md-production-heading"><div><h2>{t(isOutline ? '大纲' : '灵感')}</h2><p>{t(isOutline ? '整理开场、内容顺序和结尾，确定后再写正文' : '记录选题、想表达的观点和已有素材')}</p></div><button type="button" className="md-btn is-small" onClick={() => setDesk({ studioDock: true })}><Icon name="chat" size={14} />{t(isOutline ? '和 AI 完善大纲' : '和 AI 讨论选题')}</button><button type="button" className="md-btn is-primary" disabled={busy || item.production?.status === 'running' || !(isOutline ? outline.trim() : idea.trim() || item.title?.trim() || item.media?.src || item.url)} onClick={advance}>{t(isOutline ? '大纲确定，开始写稿' : '整理大纲')}<Icon name="chevR" size={14} /></button></div>
    <div className={`md-planning-layout ${!isOutline ? 'has-source' : ''}`}>
      <section className="md-work-panel md-planning-editor">{!isOutline ? <InspirationSource item={item} /> : null}<Field label={isOutline ? '内容大纲' : '补充想法'}><textarea aria-label={t(isOutline ? '内容大纲' : '原始灵感')} value={isOutline ? outline : idea} maxLength={200000} placeholder={t(isOutline ? '开场：用什么问题或画面抓住观众？\n\n核心观点：这期只讲清楚什么？\n\n内容顺序：\n1. 观点与例子\n2. 解释或演示\n3. 结论\n\n结尾：希望观众记住什么、做什么？' : '为什么想做这个选题？想给谁看？有什么经历、观点或素材？')} onChange={e => update({ [isOutline ? 'outlineText' : 'ideaText']: e.target.value })} /></Field></section>
      <aside className="md-work-panel md-planning-reference"><h3>{t(isOutline ? '灵感参考' : '如何整理')}</h3>{isOutline ? <><InspirationSource item={item} compact />{draft.ideaText ? <p>{draft.ideaText}</p> : null}</> : <p>{t('先记下想法，再进入大纲页组织结构。灵感、大纲和正文分别保存，随时可以回来修改。')}</p>}<button type="button" className="md-btn is-small" onClick={() => copy(brief)}>{t('复制大纲创作任务')}</button>{isOutline ? <button type="button" className="md-btn is-small" onClick={() => setDesk({ studioTab: 'idea' })}>{t('编辑灵感')}</button> : null}</aside>
    </div>
  </div>
}

function CoverDesignPage({ item, draft, update, assets }) {
  const fileInput = React.useRef(null)
  const [importing, setImporting] = React.useState(false)
  const design = draft.coverDesign
  const [ratio, setRatio] = React.useState('3:4')
  const [busy, setBusy] = React.useState('')
  const [titles, setTitles] = React.useState([])
  const model = useDesk(s => s.model)
  const imageReady = useDesk(s => s.settings?.imageReady)
  const patch = changes => update(d => ({ coverDesign: { ...d.coverDesign, ...changes } }))
  const variant = design.variants[ratio]
  const images = assets.filter(a => a.type === 'image')
  const patchVariant = changes => update(d => ({ coverDesign: { ...d.coverDesign, variants: { ...d.coverDesign.variants, [ratio]: { ...d.coverDesign.variants[ratio], ...changes } } } }))
  const selectedRefs = [...new Set([...design.personIds, ...design.materialIds])]
  const importImages = async files => {
    if (!files.length) return
    setImporting(true)
    try { await importWorkspaceFiles(item.id, files); toast(t('图片已导入，请勾选要使用的参考图')) }
    catch (err) { toast(err.message, { error: true }) }
    finally { setImporting(false) }
  }
  const selectImages = key => <div className="md-cover-reference-grid">{images.map(asset => <label key={asset.id}><input type="checkbox" checked={design[key].includes(asset.id)} onChange={event => patch({ [key]: event.target.checked ? [...design[key], asset.id] : design[key].filter(id => id !== asset.id) })} /><img src={asset.src} alt="" /><span>{asset.name}</span></label>)}{!images.length ? <p>{t('先到素材页导入参考图片')}</p> : null}</div>
  const generateTitles = async () => {
    setBusy('titles')
    try { setTitles((await runCoverAction(item, 'cover/titles', {})).titles) }
    catch (err) { toast(err.message, { error: true }) }
    finally { setBusy('') }
  }
  const generatePrompts = async () => {
    setBusy('prompts')
    try {
      const result = await runCoverAction(item, 'cover/prompts', {})
      update(d => ({ coverDesign: { ...d.coverDesign, variants: Object.fromEntries(COVER_RATIOS.map(r => [r, { ...d.coverDesign.variants[r], ...(result.variants[r] ? { prompt: result.variants[r] } : {}) }])) } }))
      toast(t('提示词已生成'))
    } catch (err) { toast(err.message, { error: true }) }
    finally { setBusy('') }
  }
  const generateImage = async () => {
    setBusy('image')
    try {
      const result = await runCoverAction(item, 'cover/image', { ratio })
      update(d => ({ coverDesign: { ...d.coverDesign, variants: { ...d.coverDesign.variants, [ratio]: { ...d.coverDesign.variants[ratio], imageIds: [...d.coverDesign.variants[ratio].imageIds, result.asset.id] } } }, edits: { ...d.edits, [result.asset.id]: { ...d.edits[result.asset.id], role: 'cover' } } }))
      toast(t('封面已加入素材库，请检查文字、人物与比例'))
    } catch (err) { toast(err.message, { error: true }) }
    finally { setBusy('') }
  }
  const task = `使用 atutun-xhs-cover Skill。用户本次要求优先于默认模板。\n封面文字：${design.title}\n风格：${design.style}\n标题用色：${design.colors || '无固定用色'}\n本次要求：${design.requirements}\n目标比例：${design.ratios.join('、')}，每种比例独立构图。\n参考图按顺序上传：\n${[...design.personIds.map(id => [id, '人物']), ...design.materialIds.map(id => [id, '参考素材（按画面判断用途，不额外添加人物）']), ...design.colorIds.map(id => [id, '标题用色参考'])].map(([id, role], i) => `${i + 1}. ${role}：${images.find(a => a.id === id)?.name || ''}`).join('\n')}\n\n生成提示词后，使用 ImageGen 按选定比例生成封面。`
  const illustrations = design.illustrations || []
  const patchIllustration = (id, changes) => update(d => ({ coverDesign: { ...d.coverDesign, illustrations: (d.coverDesign.illustrations || []).map(row => row.id === id ? { ...row, ...changes } : row) } }))
  const illustrationTask = row => `正文配图：${row.title || '未命名配图'}\n比例：${row.ratio}\n设计要求：${row.requirements || '根据稿件内容设计，与封面保持视觉一致；按内容决定是否需要文字，不自动重复封面大标题。'}\n${row.prompt ? `已有提示词：${row.prompt}` : ''}`
  const combinedTask = `${task}\n\n同时设计以下正文配图，与封面统一配色、人物和视觉风格。共用上方参考图，分别输出每张图的完整提示词，再使用 ImageGen 逐张生成。\n稿件正文：\n${item.production?.article || item.body || ''}\n\n${illustrations.map(illustrationTask).join('\n\n')}`
  return <div className="md-production-page md-cover-design-page">
    <div className="md-production-heading"><div><h2>{t('配图与封面')}</h2><p>{t('共用参考素材，组合设计一套封面与正文配图')}</p></div></div>
    <div className="md-visual-batch"><span>{t('封面')} · {illustrations.length} {t('张配图')}</span><button type="button" className="md-btn is-small" onClick={() => copy(combinedTask)}>{t('组合复制：封面＋配图')}</button></div>
    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden multiple onChange={e => { importImages([...e.target.files]); e.target.value = '' }} />
    <fieldset className="md-cover-fieldset" disabled={Boolean(busy) || importing}>
    <section className="md-work-panel md-cover-simple-brief">
      <div className="md-work-panel-title"><h3>{t('参考图片')}</h3><button type="button" className="md-btn is-small" onClick={() => fileInput.current?.click()}><Icon name="plus" size={13} />{t(importing ? '正在导入…' : '上传图片')}</button></div>
      {images.length ? <div className="md-cover-reference-grid">{images.map(asset => <label key={asset.id}><input type="checkbox" checked={selectedRefs.includes(asset.id)} onChange={e => {
        if (e.target.checked) patch({ materialIds: [...design.materialIds, asset.id] })
        else patch({ materialIds: design.materialIds.filter(id => id !== asset.id), personIds: design.personIds.filter(id => id !== asset.id) })
      }} /><img src={asset.src} alt="" /><span>{asset.name}</span></label>)}</div> : <p className="md-cover-empty">{t('上传视频截图或素材图片，也可以直接使用素材库里的图片')}</p>}
      <Field label="封面文字"><input value={design.title} placeholder={t('例如：200+自拍动作素材上新')} onChange={e => patch({ title: e.target.value })} /></Field>
      <div className="md-cover-title-tools"><button type="button" onClick={() => patch({ title: item.production?.title || item.title })}>{t('使用当前内容标题')}</button><button type="button" disabled={!model} onClick={generateTitles}>{t('帮我想标题')}</button></div>
      {titles.map(title => <button type="button" className="md-btn md-cover-title-option" key={title} onClick={() => patch({ title })}>{title}</button>)}
      <Field label="补充要求（选填）"><textarea rows={3} value={design.requirements} placeholder={t('例如：文字放中间，不加真人，贴纸拼贴风。不填就交给 Skill 设计。')} onChange={e => patch({ requirements: e.target.value })} /></Field>
      <details className="md-cover-options"><summary>{t('更多设置（选填）')}</summary>
        <Field label="封面风格"><select value={design.style} onChange={e => patch({ style: e.target.value })}>{COVER_STYLES.map(style => <option key={style} value={style}>{t(style)}</option>)}</select></Field>
        <Field label="标题用色"><input value={design.colors} placeholder={t('留空，交给 Skill 搭配')} onChange={e => patch({ colors: e.target.value })} /></Field>
        <Field label="生成比例"><div className="md-cover-ratios">{COVER_RATIOS.map(r => <label key={r}><input type="checkbox" checked={design.ratios.includes(r)} onChange={e => patch({ ratios: e.target.checked ? [...design.ratios, r] : design.ratios.filter(x => x !== r) })} />{r}</label>)}</div></Field>
        <details><summary>{t('指定人物参考')}</summary>{selectImages('personIds')}</details>
        <details><summary>{t('参考过往封面配色')}</summary>{selectImages('colorIds')}</details>
      </details>
      <footer className="md-cover-simple-submit">
        {model ? <><button type="button" className="md-btn is-primary" disabled={!design.title.trim() || !design.ratios.length} onClick={generatePrompts}><Icon name="image" size={15} />{t('生成封面提示词')}</button><button type="button" className="md-btn" disabled={!design.title.trim()} onClick={() => copy(task)}>{t('复制到 Skill 对话')}</button></> : <button type="button" className="md-btn is-primary" disabled={!design.title.trim()} onClick={() => copy(task)}><Icon name="copy" size={15} />{t('复制到 Skill 对话')}</button>}
        <span>{design.ratios.join(' · ')}</span>
      </footer>
      {!model ? <p className="md-cover-preview-note">{t('这里暂未连接模型。复制后，粘贴到你平时的 Skill 对话，并附上选中的参考图即可。')}</p> : null}
    </section>
    <details className="md-work-panel md-cover-versions" open={COVER_RATIOS.some(r => design.variants[r].prompt || design.variants[r].imageIds.length) ? true : undefined}><summary>{t('查看结果 / 粘贴已有提示词')}</summary>
      <div className="md-work-panel-title"><h3>{t('封面版本')}</h3><div className="md-work-actions">{COVER_RATIOS.map(r => <button type="button" key={r} className={`md-btn is-small ${ratio === r ? 'is-primary' : ''}`} aria-pressed={ratio === r} onClick={() => setRatio(r)}>{r}</button>)}</div></div>
      <Field label="封面提示词"><textarea rows={12} value={variant.prompt} maxLength={50000} placeholder={t('使用 Skill 生成，或粘贴这个比例的完整提示词')} onChange={e => patchVariant({ prompt: e.target.value })} /></Field>
      <div className="md-work-actions"><button type="button" className="md-btn" disabled={!variant.prompt} onClick={() => copy(variant.prompt)}>{t('复制提示词')}</button><button type="button" className="md-btn" disabled={!variant.prompt} onClick={() => downloadText(variant.prompt, `${design.title || item.title}-${ratio.replace(':', 'x')}.txt`)}>{t('导出提示词')}</button><button type="button" className="md-btn is-primary" disabled={!imageReady || !variant.prompt.trim()} onClick={generateImage}>{t('生成封面图')}</button></div>
      <p>{t('生成图为候选封面；请检查标题、人物和实际画幅后再选为发布封面')}</p>
      <div className="md-cover-generated">{variant.imageIds.map(id => assets.find(a => a.id === id)).filter(Boolean).map(asset => <figure key={asset.id}><a href={asset.src} target="_blank" rel="noreferrer"><img src={asset.src} alt={design.title || t('封面')} /></a><figcaption>{asset.width && asset.height ? <span>{asset.width} × {asset.height}</span> : null}<button type="button" className="md-btn is-small" onClick={() => update({ selectedCover: asset.id })}>{t(draft.selectedCover === asset.id ? '已选发布封面' : '设为发布封面')}</button><a href={asset.src} download={asset.name}>{t('下载')}</a></figcaption></figure>)}</div>
    </details>
    <section className="md-work-panel md-illustrations">
      <div className="md-work-panel-title"><h3>{t('正文配图')}</h3><button type="button" className="md-btn is-small" disabled={illustrations.length >= 50} onClick={() => update(d => ({ coverDesign: { ...d.coverDesign, illustrations: [...(d.coverDesign.illustrations || []), { id: crypto.randomUUID(), title: `配图 ${(d.coverDesign.illustrations || []).length + 1}`, requirements: '', prompt: '', ratio: '3:4', imageIds: [] }] } }))}><Icon name="plus" size={13} />{t('添加配图')}</button></div>
      {!illustrations.length ? <p className="md-cover-preview-note">{t('添加讲解图、步骤图或组合拼图，和封面一起交给 Skill 设计。')}</p> : null}
      {illustrations.map(row => <details key={row.id} className="md-illustration" open><summary>{row.title || t('未命名配图')} · {row.ratio}</summary>
        <div className="md-illustration-fields"><Field label="配图名称"><input value={row.title} maxLength={2000} onChange={e => patchIllustration(row.id, { title: e.target.value })} /></Field><Field label="比例"><select value={row.ratio} onChange={e => patchIllustration(row.id, { ratio: e.target.value })}>{COVER_RATIOS.map(r => <option key={r}>{r}</option>)}</select></Field></div>
        <Field label="画面要求"><textarea rows={2} value={row.requirements} maxLength={20000} placeholder={t('例如：将三种角色对比组合为一张配图；用于正文第二段，保持封面配色')} onChange={e => patchIllustration(row.id, { requirements: e.target.value })} /></Field>
        <Field label="配图提示词"><textarea rows={5} value={row.prompt} maxLength={50000} placeholder={t('粘贴这张配图的完整提示词，自动保存')} onChange={e => patchIllustration(row.id, { prompt: e.target.value })} /></Field>
        <details className="md-illustration-results"><summary>{t('关联成图')} · {row.imageIds.length}</summary><div className="md-cover-reference-grid">{images.map(asset => <label key={asset.id}><input type="checkbox" checked={row.imageIds.includes(asset.id)} onChange={e => patchIllustration(row.id, { imageIds: e.target.checked ? [...row.imageIds, asset.id] : row.imageIds.filter(id => id !== asset.id) })} /><img src={asset.src} alt="" /><span>{asset.name}</span></label>)}</div><button type="button" className="md-btn is-small" onClick={() => fileInput.current?.click()}>{t('上传成图')}</button></details>
        <div className="md-work-actions"><button type="button" className="md-btn is-small" onClick={() => copy(`${task.replace('生成提示词后，使用 ImageGen 按选定比例生成封面。', '')}\n\n只制作以下正文配图，不生成封面：\n${illustrationTask(row)}\n稿件正文：\n${item.production?.article || item.body || ''}`)}>{t('复制配图任务')}</button><button type="button" className="md-btn is-small" disabled={!row.prompt.trim()} onClick={() => copy(row.prompt)}>{t('复制提示词')}</button><button type="button" className="md-btn is-small" onClick={() => update(d => ({ coverDesign: { ...d.coverDesign, illustrations: (d.coverDesign.illustrations || []).filter(entry => entry.id !== row.id) } }))}>{t('移除配图')}</button></div>
      </details>)}
    </section>
    {draft.coverPromptText != null ? <details className="md-work-panel md-cover-legacy"><summary>{t('原有封面提示词')}</summary><Field label="封面提示词"><textarea rows={6} value={draft.coverPromptText} onChange={e => update({ coverPromptText: e.target.value })} /></Field><button type="button" className="md-btn is-small" onClick={() => patchVariant({ prompt: draft.coverPromptText })}>{t('导入当前比例版本')}</button></details> : null}
    </fieldset>
    {busy ? <p role="status" className="md-cover-busy">{t(busy === 'prompts' ? '正在按 Skill 设计提示词…' : busy === 'titles' ? '正在推荐标题…' : '正在生成封面图…')}</p> : null}
  </div>
}

function PromptPage({ item, draft, update, assets }) {
  const editor = React.useRef(null)
  const [active, setActive] = React.useState(-1)
  const text = draft.promptText ?? ''
  const document = React.useMemo(() => indexVideoPrompt(text), [text])
  const section = document.sections[active]
  const legacy = draft.promptText == null && draft.segments.length > 0
  const save = () => flushWorkspace(item.id).then(() => toast(t('已保存'))).catch(err => toast(err.message, { error: true }))
  const jump = index => {
    setActive(index)
    const row = document.sections[index]
    if (!row || !editor.current) return
    editor.current.focus()
    editor.current.setSelectionRange(row.start, row.end)
  }
  return <div className="md-production-page md-prompt-document-page">
    <div className="md-production-heading"><div><h2>{t('视频提示词')}</h2><p>{t('全局参数与分段镜头保存在同一份文档，保留你的原始格式')}</p></div><div className="md-work-actions">
      <button type="button" className="md-btn" disabled={!text} onClick={() => copy(promptDocument(item, draft))}><Icon name="copy" size={15} />{t('复制整份')}</button>
      <button type="button" className="md-btn" disabled={!text} onClick={() => downloadText(promptDocument(item, draft), `${item.title}-prompts.txt`)}><Icon name="save" size={15} />{t('导出提示词')}</button>
      <button type="button" className="md-btn is-primary" onClick={save}>{t('保存')}</button>
    </div></div>
    {legacy ? <div className="md-prompt-legacy"><span>{t('已有旧版片段，可转换为文档继续编辑，原片段仍保留')}</span><button type="button" className="md-btn is-small" onClick={() => update({ promptText: promptDocument(item, draft) })}>{t('转换旧版提示词')}</button></div> : null}
    <div className="md-prompt-document-layout">
      <section className="md-work-panel md-prompt-document-editor">

        <textarea ref={editor} aria-label={t('完整提示词')} maxLength={MAX_PROMPT_TEXT} value={text} spellCheck={false} placeholder={t('粘贴完整提示词，例如：\n\n全局视频参数：\n视觉风格：…\n技术规格：…\n角色设定：…\n\n分镜脚本：\n\n【第1段 - 13.3秒】\n镜头一：|景别与运镜|3.8秒|画面描述|台词与表演|音乐音效\n\n【第2段 - 12.4秒】\n镜头二：…')} onChange={event => update({ promptText: event.target.value })} />
        <footer><span>{text.length.toLocaleString()} / {MAX_PROMPT_TEXT.toLocaleString()}</span><span>{t('每段可包含多个镜头，支持小数秒')}</span></footer>
      </section>
      <aside className="md-work-panel md-prompt-document-outline" aria-label={t('分段目录')}>
        <div className="md-work-panel-title"><h3>{t('分段目录')}</h3><span>{document.sections.length} {t('段')} · {Number(document.seconds.toFixed(3))}s</span></div>
        {document.sections.length ? <><nav>{document.sections.map((row, index) => <button type="button" key={row.start} aria-pressed={active === index} className={active === index ? 'is-on' : ''} onClick={() => jump(index)}><strong>{row.label}</strong><span>{row.shots} {t('镜头')}</span></button>)}</nav>
        <button type="button" className="md-btn is-wide" disabled={!section} onClick={() => copy(copyVideoPromptSection(text, active))}><Icon name="copy" size={14} />{t('复制全局参数＋当前段')}</button><p>{t('点击目录定位原文；复制时自动带上全局参数')}</p></> : <p>{t('使用【第1段 - 13.3秒】这样的标题即可自动识别目录，其他格式仍可完整保存')}</p>}
        <details className="md-prompt-file-references"><summary>{t('参考素材')} · {assets.length}</summary><p>{t('在素材页管理参考文件，复制提示词后在视频工具中上传')}</p></details>
      </aside>
    </div>
  </div>
}

function AssetsPage({ item, draft, update, assets, persistence }) {
  const [filter, setFilter] = React.useState('all')
  const [recycleView, setRecycleView] = React.useState(false)
  const [folder, setFolder] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [mode, setMode] = React.useState('grid')
  const [viewing, setViewing] = React.useState(null)
  const [dragging, setDragging] = React.useState(false)
  const fileInput = React.useRef(null)
  const folderInput = React.useRef(null)
  const recycled = draft.assets.filter(a => draft.hidden.includes(a.id)).map(a => ({ ...a, ...draft.edits[a.id] }))
  const visible = recycleView ? recycled.filter(a => a.name.toLowerCase().includes(query.toLowerCase())) : assets.filter(a => (filter === 'all' || a.type === filter) && (!folder || a.folder === folder) && a.name.toLowerCase().includes(query.toLowerCase()))
  const patchAsset = (id, patch) => update(d => ({ edits: { ...d.edits, [id]: { ...d.edits[id], ...patch } } }))
  const importFiles = files => {
    if (!files.length) return
    importWorkspaceFiles(item.id, files, folder).catch(err => toast(err.message, { error: true }))
  }

  const addFolder = () => setDesk({ dialog: { title: t('新建文件夹'), initial: { type: filter === 'all' ? 'video' : filter }, fields: [{ name: 'name', label: t('文件夹名称'), required: true }, { name: 'type', label: t('素材分类'), type: 'select', options: TYPES.filter(row => row.id !== 'all').map(row => ({ value: row.id, label: t(row.name) })) }], onSubmit: ({ name, type }) => { if (name?.trim()) update(d => ({ folders: [...d.folders, { id: workspaceId(), name: name.trim(), type }] })) } } })
  const renameFolder = () => setDesk({ dialog: { title: t('重命名文件夹'), initial: { name: draft.folders.find(row => row.id === folder)?.name || '' }, fields: [{ name: 'name', label: t('文件夹名称'), required: true }], onSubmit: ({ name }) => { if (name?.trim()) update(d => ({ folders: d.folders.map(row => row.id === folder ? { ...row, name: name.trim() } : row) })) } } })

  const editAsset = asset => setDesk({ dialog: { title: t('整理素材'), initial: { name: asset.name, folder: asset.folder || '', role: asset.role }, fields: [{ name: 'name', label: t('文件名称'), required: true }, { name: 'role', label: t('素材用途'), type: 'select', options: (asset.type === 'audio' ? ['source', 'voice', 'music', 'reference'] : asset.type === 'video' ? ['source', 'final', 'clip', 'reference'] : ['source', 'cover', 'figure', 'storyboard', 'reference']).map(value => ({ value, label: t(ROLE_NAMES[value]) })) }, { name: 'folder', label: t('文件夹'), type: 'select', options: [{ value: '', label: t('默认目录') }, ...draft.folders.filter(f => f.type === asset.type).map(f => ({ value: f.id, label: f.name }))] }], onSubmit: values => { if (values.name?.trim()) patchAsset(asset.id, { name: values.name.trim(), folder: values.folder, role: values.role }) } } })
  const restore = asset => recycleWorkspaceAsset(item.id, asset.id, true).then(() => setViewing(null)).catch(err => toast(err.message, { error: true }))
  const remove = asset => setDesk({ dialog: { title: t('移到回收站'), submitLabel: t('移到回收站'), fields: [{ name: 'notice', type: 'hidden', label: t('素材将保留在这篇内容的回收站，可随时恢复；发布选材和参考关联会取消') }], onSubmit: () => { recycleWorkspaceAsset(item.id, asset.id).then(() => setViewing(null)).catch(err => toast(err.message, { error: true })) } } })

  return <div className="md-production-page">
    <div className="md-production-heading"><div><h2>{t('素材')}</h2><p>{t('制作过程和最终成片放在一起，发布时就不用再找')}</p></div><div className="md-work-actions"><button type="button" className="md-btn" onClick={() => folderInput.current?.click()}><Icon name="folder" size={15} />{t('导入文件夹')}</button><button type="button" className="md-btn is-primary" onClick={() => fileInput.current?.click()}><Icon name="plus" size={15} />{t('导入素材')}</button></div></div>
    {persistence.imports.length ? <section className="md-import-queue" aria-label={t('导入队列')}><header><strong>{t('导入队列')}</strong>{persistence.importing ? <button type="button" className="md-btn is-small" onClick={() => cancelWorkspaceImport(item.id)}>{t('取消剩余导入')}</button> : <span>{t('导入结束，失败文件可重新选择导入')}</span>}</header>{persistence.imports.map(row => <div key={row.id}><span title={row.name}>{row.name}</span><progress max="100" value={row.progress} aria-label={row.name} /><small>{t(({ queued: '等待导入', uploading: '正在上传', processing: '读取媒体信息', done: '已导入', failed: '导入失败', cancelled: '已取消' })[row.status])}{row.error ? `：${row.error}` : ''}</small></div>)}</section> : null}
    <input ref={fileInput} type="file" hidden multiple accept={ACCEPT} onChange={e => { importFiles([...e.target.files]); e.target.value = '' }} /><input ref={folderInput} type="file" hidden multiple webkitdirectory="" onChange={e => { importFiles([...e.target.files]); e.target.value = '' }} />
    <div className={`md-asset-browser ${dragging ? 'is-dragover' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }} onDrop={e => { e.preventDefault(); setDragging(false); importFiles([...e.dataTransfer.files]) }}>
      <aside className="md-asset-sidebar"><span className="md-section-kicker">{t('内容文件夹')}</span><nav aria-label={t('素材分类')}>{TYPES.map(type => <React.Fragment key={type.id}><button type="button" className={!recycleView && filter === type.id && !folder ? 'is-on' : ''} aria-pressed={!recycleView && filter === type.id && !folder} onClick={() => { setFilter(type.id); setFolder(''); setRecycleView(false) }}><Icon name={type.icon} size={16} /><span>{t(type.name)}</span><small>{assets.filter(a => type.id === 'all' || a.type === type.id).length}</small></button>{draft.folders.filter(f => f.type === type.id).map(row => <button type="button" className={`md-asset-subfolder ${folder === row.id ? 'is-on' : ''}`} key={row.id} onClick={() => { setFilter(type.id); setFolder(row.id); setRecycleView(false) }}><Icon name="folder" size={14} /><span>{row.name}</span><small>{assets.filter(a => a.folder === row.id).length}</small></button>)}</React.Fragment>)}<button type="button" className={recycleView ? 'is-on' : ''} onClick={() => { setRecycleView(true); setFolder('') }}><Icon name="trash" size={16} /><span>{t('回收站')}</span><small>{recycled.length}</small></button></nav><button type="button" className="md-new-folder" onClick={addFolder}><Icon name="plus" size={14} />{t('新建文件夹')}</button><div className="md-asset-sidebar-note"><Icon name="link" size={15} /><p>{t('文件跟随这篇内容，选好成片和封面就能准备发布')}</p></div></aside>
      <div className="md-asset-main"><div className="md-asset-toolbar"><span>{t('素材')}<Icon name="chevR" size={12} /><strong>{recycleView ? t('回收站') : folder ? draft.folders.find(f => f.id === folder)?.name : t(TYPES.find(row => row.id === filter).name)}</strong></span><div>{folder ? <IconButton icon="edit" label={t('重命名文件夹')} onClick={renameFolder} /> : null}<label className="md-search"><Icon name="search" size={14} /><input aria-label={t('搜索素材')} placeholder={t('搜索素材')} value={query} onChange={e => setQuery(e.target.value)} /></label><Segmented label={t('素材显示方式')} value={mode} onChange={setMode} options={[{ value: 'grid', icon: 'wall', title: t('网格') }, { value: 'list', icon: 'list', title: t('列表') }]} /></div></div>
        <div className={`md-assets ${mode === 'list' ? 'is-list' : ''}`}>{visible.map(asset => <article className="md-asset-card" key={asset.id}><button type="button" className={`md-asset-thumbnail is-${asset.type}`} onClick={() => setViewing(asset)} aria-label={t('预览 {name}', { name: asset.name })}>{asset.type === 'image' ? <img src={asset.src} alt="" loading="lazy" /> : asset.type === 'video' ? <>{asset.poster ? <img src={asset.poster} alt="" loading="lazy" /> : <video src={asset.src} preload="metadata" muted />}<span className="md-media-play"><Icon name="play" size={18} fill /></span></> : <div className="md-audio-art"><Icon name="play" size={28} /><span>{t('音频文件')}</span></div>}<span className="md-file-extension">{asset.name.includes('.') ? asset.name.split('.').pop().slice(0, 5).toUpperCase() : asset.type.toUpperCase()}</span></button><div className="md-asset-caption"><button type="button" onClick={() => setViewing(asset)} title={asset.name}>{asset.name}</button><div><span>{draft.selectedVideo === asset.id ? t('已选发布视频') : draft.selectedCover === asset.id ? t('已选发布封面') : draft.imageIds.includes(asset.id) ? t('已选发布图片') : t(ROLE_NAMES[asset.role] || '制作素材')}</span><small>{mediaInfo(asset)}</small></div></div><div className="md-asset-card-actions">{recycleView ? <IconButton icon="undo" label={t('恢复素材')} onClick={() => restore(asset)} /> : <IconButton icon="edit" label={t('整理素材')} onClick={() => editAsset(asset)} />}<IconButton icon="more" label={t('查看素材详情')} onClick={() => setViewing(asset)} /></div>{draft.selectedVideo === asset.id || draft.selectedCover === asset.id || draft.imageIds.includes(asset.id) ? <span className="md-asset-selected"><Icon name="check" size={12} /></span> : null}</article>)}{!query && !recycleView ? <button type="button" className="md-asset-import" onClick={() => fileInput.current?.click()}><Icon name="plus" size={24} /><strong>{t('拖入或导入素材')}</strong><span>{t('视频、图片和音频')}</span></button> : null}</div>
        {(query || recycleView) && !visible.length ? <div className="md-work-empty"><Icon name="search" size={28} /><h3>{t('没有找到素材')}</h3><p>{t('换一个关键词，或查看其他文件夹')}</p><button type="button" className="md-btn" onClick={() => { setQuery(''); setFilter('all'); setFolder(''); setRecycleView(false) }}>{t('查看全部素材')}</button></div> : null}<footer className="md-asset-browser-foot"><span>{t('{n} 个文件', { n: visible.length })}</span><span>{t('直接拖入文件即可导入')}</span></footer>
      </div>{dragging ? <div className="md-asset-drop"><Icon name="upload" size={32} /><strong>{t('松开，放进这篇内容')}</strong></div> : null}
    </div>
    {viewing ? <Dialog title={viewing.name} onClose={() => setViewing(null)} width={760}><div className="md-asset-viewer">{viewing.type === 'image' ? <img src={viewing.src} alt={viewing.name} /> : viewing.type === 'video' ? <video src={viewing.src} poster={viewing.poster} controls autoPlay /> : <audio src={viewing.src} controls autoPlay />}<div className="md-asset-detail"><span>{t(ROLE_NAMES[viewing.role] || '制作素材')} · {mediaInfo(viewing)}</span><span>{viewing.origin === 'imported' ? t('已保存到本地') : t('内容素材')}</span></div>{viewing.metadataWarning ? <p className="md-media-warning">{t(viewing.metadataWarning)}</p> : null}<div className="md-work-actions">{recycleView ? <button type="button" className="md-btn is-primary" onClick={() => restore(viewing)}>{t('恢复素材')}</button> : viewing.type === 'video' ? <button type="button" className="md-btn is-primary" onClick={() => { update({ selectedVideo: viewing.id }); setViewing(null) }}>{t('设为发布视频')}</button> : viewing.type === 'image' ? <><button type="button" className="md-btn is-primary" onClick={() => { update({ selectedCover: viewing.id }); setViewing(null) }}>{t('设为发布封面')}</button><button type="button" className="md-btn" onClick={() => { update(d => ({ imageIds: d.imageIds.includes(viewing.id) ? d.imageIds.filter(id => id !== viewing.id) : [...d.imageIds, viewing.id] })); setViewing(null) }}>{draft.imageIds.includes(viewing.id) ? t('取消发布图片') : t('加入发布图片')}</button></> : null}<a className="md-btn" href={viewing.src} download={viewing.name}>{t('下载')}</a><span className="md-grow" />{!recycleView ? <button type="button" className="md-btn" onClick={() => remove(viewing)}>{t('移到回收站')}</button> : null}</div></div></Dialog> : null}
  </div>
}

function PublishPage({ item, draft, update, assets, onTab, syncPublish }) {
  const publish = draft.publish
  const video = assets.find(a => a.id === draft.selectedVideo)
  const cover = assets.find(a => a.id === draft.selectedCover)
  const images = draft.imageIds.map(id => assets.find(a => a.id === id)).filter(Boolean)
  const patch = values => update(d => ({ publish: { ...d.publish, ...values } }))
  const checks = [{ text: '发布标题', done: Boolean(publish.title.trim()) }, { text: publish.format === 'video' ? '发布视频' : '发布图片', done: publish.format === 'video' ? Boolean(video) : images.length > 0 }, { text: '发布封面', done: Boolean(cover), optional: publish.format !== 'video' }, { text: '平台账号与发布能力', done: false }]
  const ready = checks.filter(c => c.done || c.optional).length
  const manualPackage = () => {
    const selected = [...(publish.format === 'video' ? [video] : images), cover].filter(Boolean)
    const text = `# ${publish.title}\n\n${publish.description}\n\n${publish.tags}\n\n## ${t('发布素材')}\n\n${selected.map(a => `- ${a.name}`).join('\n')}\n\n${t('发布清单仅包含文案和文件名，请在素材页下载对应文件')}`
    downloadText(text, `${item.title}-publish.md`, 'text/markdown')
  }
  return <div className="md-production-page">
    <div className="md-production-heading"><div><h2>{t('发布')}</h2><p>{t('核对文案与素材，发布时使用同一个版本')}</p></div><button type="button" className="md-btn" onClick={manualPackage}><Icon name="save" size={15} />{t('导出发布清单')}</button></div>
    <div className="md-publish-layout"><div className="md-publish-editor"><section className="md-work-panel"><div className="md-work-panel-title"><h3>{t('发布到哪里')}</h3><span>{t('平台设置')}</span></div><div className="md-platform-options">{PLATFORMS.map(platform => <button type="button" key={platform} aria-pressed={publish.platform === platform} className={publish.platform === platform ? 'is-on' : ''} onClick={() => patch({ platform })}>{t(platform)}</button>)}</div><div className="md-publish-account"><Icon name="user" size={18} /><div><strong>{t('尚未连接发布账号')}</strong><span>{t('账号授权与平台发布能力将在后续接入')}</span></div><span>{t('未连接')}</span></div></section>
      <section className="md-work-panel"><div className="md-work-panel-title"><h3>{t('发布内容')}</h3><Segmented label={t('发布类型')} value={publish.format} onChange={format => patch({ format })} options={[{ value: 'video', label: t('视频') }, { value: 'images', label: t('图文') }]} /></div>{draft.publishChanges.length ? <div className="md-publish-source-notice" role="status"><p>{t('稿件或平台已更新，已保留你编辑的发布内容')}</p><button type="button" className="md-btn is-small" onClick={syncPublish}>{t('同步变化字段')}</button></div> : null}<Field label="发布标题"><input value={publish.title} onChange={e => patch({ title: e.target.value })} /><small>{t('{n} 个字符', { n: [...publish.title].length })}</small></Field><Field label="正文 / 简介"><textarea rows={6} value={publish.description} placeholder={t('写下这一版要发布的正文')} onChange={e => patch({ description: e.target.value })} /></Field><Field label="话题"><input value={publish.tags} placeholder={t('#话题一 #话题二')} onChange={e => patch({ tags: e.target.value })} /></Field><div className="md-publish-media-select">{publish.format === 'video' ? <Field label="发布视频"><select value={draft.selectedVideo} onChange={e => update({ selectedVideo: e.target.value })}><option value="">{t('选择一个完整成片')}</option>{assets.filter(a => a.type === 'video').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field> : <div className="md-publish-images"><span>{t('发布图片（按选择顺序）')}</span>{assets.filter(a => a.type === 'image').map(a => <label key={a.id}><input type="checkbox" checked={draft.imageIds.includes(a.id)} onChange={e => update(d => ({ imageIds: e.target.checked ? [...d.imageIds, a.id] : d.imageIds.filter(id => id !== a.id) }))} /><span>{draft.imageIds.includes(a.id) ? `${draft.imageIds.indexOf(a.id) + 1}. ` : ''}{a.name}</span></label>)}</div>}<Field label="发布封面"><select value={draft.selectedCover} onChange={e => update({ selectedCover: e.target.value })}><option value="">{t('选择封面图片')}</option>{assets.filter(a => a.type === 'image').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field></div></section>
      <section className="md-work-panel"><div className="md-work-panel-title"><h3>{t('什么时候发布')}</h3></div><div className="md-publish-modes">{[{ id: 'manual', name: '手动发布', desc: '复制文案，下载选定素材' }, { id: 'now', name: '立即自动发布', desc: '平台接通后可用' }, { id: 'scheduled', name: '定时自动发布', desc: '按指定时间执行' }].map(mode => <label key={mode.id} className={publish.mode === mode.id ? 'is-on' : ''}><input type="radio" name={`publish-mode-${item.id}`} value={mode.id} checked={publish.mode === mode.id} onChange={() => patch({ mode: mode.id })} /><div><strong>{t(mode.name)}</strong><span>{t(mode.desc)}</span></div></label>)}</div>{publish.mode === 'scheduled' ? <Field label="计划发布时间"><input type="datetime-local" value={publish.when} onChange={e => patch({ when: e.target.value })} /><small>{t('时区')}：{Intl.DateTimeFormat().resolvedOptions().timeZone}</small></Field> : null}{publish.mode !== 'manual' ? <p className="md-publish-pending">{t('当前可预览设置，尚不会创建自动发布任务')}</p> : null}</section>
    </div><aside className="md-publish-review"><section className="md-work-panel md-publish-preview"><div className="md-work-panel-title"><h3>{t('发布预览')}</h3><span>{t(publish.platform)}</span></div><div className="md-release-preview">{publish.format === 'images' ? images[0] ? <img src={images[0].src} alt={t('发布图片')} /> : <Icon name="image" size={36} /> : cover ? <img src={cover.src} alt={t('发布封面')} /> : video ? <video src={video.src} poster={video.poster} preload="metadata" muted /> : <Icon name="film" size={36} />}{publish.format === 'video' ? <span className="md-release-type"><Icon name="play" size={13} fill />{t('视频')}</span> : <span className="md-release-type">{images.length} {t('张图')}</span>}</div><h4>{publish.title || t('还没有标题')}</h4><p>{publish.description || t('还没有正文')}</p><button type="button" className="md-inline-link" onClick={() => onTab('assets')}>{t('去素材页检查文件')}<Icon name="chevR" size={12} /></button></section>
      <section className="md-work-panel md-release-checks"><div className="md-work-panel-title"><h3>{t('发布准备')}</h3><span>{ready}/{checks.length}</span></div>{checks.map(check => <div key={check.text} className={check.done || check.optional ? 'is-done' : ''}><i>{check.done || check.optional ? <Icon name="check" size={12} /> : <span />}</i><span>{t(check.text)}</span><small>{check.optional ? t('可选') : check.done ? t('已准备') : t('待处理')}</small></div>)}<p>{t('当前检查仅核对选材，平台格式与权限将在接入后校验')}</p><div className="md-publish-submit">{publish.mode === 'manual' ? <button type="button" className="md-btn is-primary is-wide" onClick={() => copy(`${publish.title}\n\n${publish.description}\n\n${publish.tags}`)}><Icon name="copy" size={15} />{t('复制发布文案')}</button> : <button type="button" className="md-btn is-primary is-wide" disabled>{publish.mode === 'scheduled' ? t('启用定时发布') : t('立即发布')}</button>}<span>{publish.mode === 'manual' ? t('素材可在素材页预览和下载') : t('等待平台发布接口接入')}</span></div></section>
    </aside></div>
  </div>
}
