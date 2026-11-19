// 内容编辑台：正文为主，右侧查看制作参考，助手按需展开。
import React from 'react'
import { ChatPanel } from './chat.jsx'
import { useWorkspace } from './workspace.js'
import { ContentWorkspace } from './content-workspace.jsx'
import { cancelProduce, closeItem, dispatchOps, regenAsset, runProduce, saveProduced, setDesk, toast, useDesk, watchProduction } from './desk.js'
import { plural, t } from './i18n.js'
import { Icon, IconButton } from './ui.jsx'
import { SPRING_SNAP, SPRING_SOFT, STYLE_CATEGORIES, fmtDate, fmtWhen, reducedMotion, renderMarkdown, styleIcon, textLength, toLocalInput } from './util.js'

const isBusy = asset => ['pending', 'running'].includes(asset?.status)

function unescapeJson(text) {
  try {
    return JSON.parse(`"${text}"`)
  } catch {
    return text
  }
}

function AutoText({ value, onCommit, className, label, disabled, allowEmpty = false, placeholder }) {
  const [draft, setDraft] = React.useState(value ?? '')
  const ref = React.useRef(null)
  React.useEffect(() => setDraft(value ?? ''), [value])
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  return (
    <textarea ref={ref} rows={1} aria-label={label} className={className} value={draft} disabled={disabled} placeholder={placeholder}
      onChange={e => setDraft(e.target.value)} onBlur={() => { if ((allowEmpty || draft.trim()) && draft !== (value ?? '')) onCommit(draft) }} />
  )
}

function askAbout(label, text = '') {
  setDesk({ chatQuote: { label, text }, studioDock: true })
}

/** 一张图。空的时候只有底色和淡淡的记号，不放文字。 */
function Plate({ asset, paper = false, mark = null, alt = '', onOpen, onRetry }) {
  const status = asset?.status ?? 'idle'
  const clickable = Boolean(asset?.src && onOpen)
  const retry = onRetry && ['failed', 'skipped', 'idle'].includes(status) && !asset?.src
  return (
    <div className={`md-plate ${paper ? 'is-paper' : 'is-wash'} ${clickable ? 'is-clickable' : ''}`} data-status={status} onClick={clickable ? onOpen : undefined} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} onKeyDown={clickable ? (event) => { if (event.key === 'Enter') onOpen(event) } : undefined} aria-label={clickable ? t('查看 {name}', { name: alt }).trim() : undefined}>
      {asset?.src ? <img key={asset.src} src={asset.src} alt={alt} draggable={false} /> : mark ? <span className="md-plate-mark" aria-hidden="true">{mark}</span> : null}
      {retry ? <button type="button" className="md-plate-failed" title={asset?.error} onClick={(event) => { event.stopPropagation(); onRetry() }}><Icon name="refresh" size={12} />{status === 'failed' ? t('没画成，重画') : t('画这张')}</button>
        : status === 'failed' ? <span className="md-plate-failed" title={asset.error}><Icon name="refresh" size={12} />{t('没画成')}</span> : null}
    </div>
  )
}

/** 进度：放在对话栏里，像助手在汇报。 */
function ProgressCard({ production, live, settings }) {
  const running = production.status === 'running'
  const ready = settings?.imageReady
  const words = textLength(production.article || live?.text || '')
  const visuals = [production.cover, ...(production.images ?? [])].filter(Boolean)
  const shots = production.shots ?? []
  const count = list => list.filter(a => a.src).length
  const planned = production.stage !== 'brief'
  const steps = [
    { label: t('标题和封面字'), done: planned, active: !planned },
    { label: production.article ? t('脚本 {n} 字', { n: words, s: plural(words, '', 's') }) : words ? t('正在写 {n} 字', { n: words, s: plural(words, '', 's') }) : t('脚本'), done: Boolean(production.article), active: planned && !production.article },
    ...(ready ? [
      { label: t('封面和配图 {done}/{total}', { done: count(visuals), total: visuals.length || 1 + (settings?.imageCount ?? 2) }), done: planned && visuals.length > 0 && !visuals.some(isBusy), active: visuals.some(isBusy) },
      { label: t('分镜 {done}/{total}', { done: count(shots), total: shots.length || settings?.shotCount || 6 }), done: planned && shots.length > 0 && !shots.some(isBusy), active: shots.some(isBusy) },
    ] : []),
  ]
  return (
    <div className="md-progress-card">
      {steps.map((step, index) => (
        <div key={index} className={`md-progress-step ${step.done ? 'is-done' : step.active && running ? 'is-active' : ''}`}>
          <i>{step.done ? <Icon name="check" size={10} stroke={2.6} /> : null}</i>
          <span>{step.active && running ? <span className="md-shimmer">{step.label}</span> : step.label}</span>
        </div>
      ))}
      {running ? <button type="button" className="md-link-btn" onClick={() => cancelProduce(production.id)}>{t('取消')}</button> : null}
    </div>
  )
}

/** 对话栏顶部：这条灵感，以及唯一的入口。 */
function IdeaCard({ item, live, settings }) {
  const production = item.production
  const running = production?.status === 'running'
  const styles = useDesk(s => s.state.styles ?? [])
  const activeId = useDesk(s => s.state.activeStyleId)
  return (
    <div className="md-idea-card">
      <span className="md-idea-label">{t('灵感')} · {fmtDate(item.createdAt)}</span>
      <AutoText className="md-idea-text" label={t('灵感')} value={item.title} disabled={running} onCommit={title => dispatchOps([{ op: 'update_item', id: item.id, title }], { label: t('修改灵感'), silent: true })} />
      {!running ? (
        <label className="md-style-pick">
          <span>{t('风格')}</span>
          <select aria-label={t('风格')} value={activeId ?? ''} onChange={e => dispatchOps([{ op: 'set_style', id: e.target.value || null }], { label: t('切换风格'), silent: true })}>
            <option value="">{t('默认')}</option>
            {styles.some(style => !style.preset) ? <optgroup label={t('我的风格')}>{styles.filter(style => !style.preset).map(style => <option key={style.id} value={style.id}>{styleIcon(style)} {style.name}</option>)}</optgroup> : null}
            {STYLE_CATEGORIES.map(name => <optgroup key={name} label={t(name)}>{styles.filter(style => style.preset && style.category === name).map(style => <option key={style.id} value={style.id}>{styleIcon(style)} {style.name}</option>)}</optgroup>)}
          </select>
        </label>
      ) : null}
      {!production || !['running', 'done'].includes(production.status) ? <button type="button" className="md-go" onClick={() => runProduce(item.id)}>{t('一键成稿')}</button> : null}
      {running ? <ProgressCard production={{ ...production, id: item.id }} live={live} settings={settings} /> : null}
      {production?.status === 'failed' ? <p className="md-idea-hint is-error">{production.error}</p> : null}
      {!running && !settings?.imageReady ? <p className="md-idea-hint">{t('接入生图模型后，封面和分镜也会画好。')}<button type="button" onClick={() => setDesk({ settingsOpen: true })}>{t('去接入')}</button></p> : null}
      {production?.notice ? <p className="md-idea-hint">{production.notice}</p> : null}
    </div>
  )
}

function Stat({ icon, value, unit }) {
  return <span className="md-hero-stat"><Icon name={icon} size={13} /><b>{value}</b>{unit}</span>
}

/** 文档标题与交付操作。 */
function HeroTile({ item, live, onView }) {
  const production = item.production
  const running = production?.status === 'running'
  const liveTitle = production?.stage === 'brief' && live?.title ? unescapeJson(live.title) : null
  const title = liveTitle ?? production?.title ?? item.title
  const words = textLength(production?.article || live?.text || '')
  const done = production?.status === 'done'
  const [saving, setSaving] = React.useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(`# ${production.title}\n\n${production.article}`)
    toast(t('脚本已复制'))
  }
  const save = async () => {
    setSaving(true)
    await saveProduced(item.id)
    setSaving(false)
  }
  return (
    <section className={`md-tile md-tile-hero ${running ? 'is-running' : ''}`}>
      <div className="md-hero-copy">
        {running ? <span className="md-document-label">{t('正在成稿…')}</span> : null}
        <span className="md-manuscript-field-label">{t('标题')}</span>
        <AutoText className={`md-hero-title ${production ? '' : 'is-idle'}`} label={t('标题')} value={title} disabled={running} onCommit={next => dispatchOps([{ op: 'update_production', id: item.id, title: next }], { label: t('修改标题'), silent: true })} />
        <div className="md-manuscript-toolbar"><details className="md-manuscript-publishing"><summary>{t('发布信息：话题与描述')}</summary><div className="md-manuscript-meta">
          <label><span>{t('话题')}</span><AutoText className="md-manuscript-meta-input" label={t('话题')} allowEmpty disabled={running} value={production?.topics ?? (item.tags || []).map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ')} placeholder={t('#话题一 #话题二')} onCommit={topics => dispatchOps([{ op: 'update_production', id: item.id, topics }], { label: t('修改话题'), silent: true })} /></label>
          <label><span>{t('描述')}</span><AutoText className="md-manuscript-meta-input" label={t('描述')} allowEmpty disabled={running} value={production?.description ?? ''} placeholder={t('写一段发布简介，介绍这条内容讲什么')} onCommit={description => dispatchOps([{ op: 'update_production', id: item.id, description }], { label: t('修改描述'), silent: true })} /></label>
        </div></details>
        <div className="md-hero-stats">
          {words ? <Stat icon="pen" value={words} unit={t('字', { s: plural(words, '', 's') })} /> : null}
        </div>
        {done ? (
          <div className="md-hero-actions">
            <button type="button" className="md-pill is-primary" onClick={copy}><Icon name="copy" size={14} />{t('复制脚本')}</button>
            <button type="button" className="md-pill" onClick={save} disabled={saving}><Icon name="save" size={14} />{saving ? t('正在导出…') : t('导出成稿')}</button>
            <label className="md-pill md-date-pill">
              <Icon name="calendar" size={14} />{item.scheduledAt ? fmtWhen(item.scheduledAt) : t('排期')}
              <input type="datetime-local" aria-label={t('排期')} value={toLocalInput(item.scheduledAt)} onClick={(event) => { try { event.currentTarget.showPicker() } catch { /* 不支持时用原生交互 */ } }} onChange={(event) => {
                const when = event.target.value ? new Date(event.target.value).toISOString() : null
                dispatchOps([{ op: 'schedule_item', id: item.id, scheduledAt: when }], { label: t('修改排期'), silent: true })
              }} />
            </label>
          </div>
        ) : null}
        </div>
      </div>

    </section>
  )
}

/** 把配图插回文章：优先放到对应小标题那一节的末尾。 */
function ArticleBody({ production, text, onView }) {
  const sections = React.useMemo(() => text.split(/\n(?=##\s)/).map(part => ({ text: part, heading: /^##\s+(.+)/.exec(part)?.[1]?.trim() ?? '' })), [text])
  const images = production?.images ?? []
  const placed = React.useMemo(() => {
    const map = new Map()
    images.forEach((image, i) => {
      if (!image.src) return
      let at = sections.findIndex(s => image.anchor && s.heading === image.anchor)
      if (at < 0) at = Math.min(sections.length - 1, Math.round(((i + 1) * sections.length) / (images.length + 1)))
      if (!map.has(at)) map.set(at, [])
      map.get(at).push({ image, i })
    })
    return map
  }, [images, sections])
  return (
    <div className="md-article">
      {sections.map((section, index) => (
        <React.Fragment key={index}>
          {/* renderMarkdown 会先转义，模型输出里的 HTML 不会执行 */}
          <div className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(section.text) }} />
          {(placed.get(index) ?? []).map(({ image, i }) => (
            <figure key={i} className="md-article-figure">
              <Plate asset={image} alt={image.caption} onOpen={() => onView(`image:${i}`)} />
              {image.caption ? <figcaption>{image.caption}</figcaption> : null}
            </figure>
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}

function ArticleTile({ item, live, open, onToggle, onView, tileRef }) {
  const production = item.production
  const running = production?.status === 'running'
  const scroller = React.useRef(null)
  const [editing, setEditing] = React.useState(false)
  const [picked, setPicked] = React.useState(null)
  const article = production?.article ?? item.body ?? ''
  const [draft, setDraft] = React.useState(article)
  React.useEffect(() => setDraft(article), [article])
  const text = article || (live?.text ?? '').replace(/^\s*#\s+.*\n?/, '')
  const streaming = running && !article
  React.useEffect(() => {
    if (streaming && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [text, streaming])
  // 写完之后回到开头，从第一句读起
  React.useEffect(() => {
    if (article && scroller.current) scroller.current.scrollTop = 0
  }, [Boolean(article)]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (draft !== article) dispatchOps([{ op: 'update_production', id: item.id, article: draft }], { label: t('修改文章'), silent: true })
    setEditing(false)
  }
  const copy = async () => {
    await navigator.clipboard.writeText(article)
    toast(t('脚本已复制'))
  }
  // 选中一段，交给助手改
  const onMouseUp = () => {
    const selection = window.getSelection()
    const value = selection?.toString().trim()
    if (!value || value.length < 4 || !article || !scroller.current?.contains(selection.anchorNode)) {
      setPicked(null)
      return
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const box = tileRef.current.getBoundingClientRect()
    setPicked({ text: value, x: Math.max(70, Math.min(rect.left - box.left + rect.width / 2, box.width - 70)), y: rect.top - box.top })
  }
  const words = textLength(text)
  return (
    <>
      <header className="md-tile-head">
        <h2>{t('正文')}</h2>
        <span className="md-grow" />
        {article ? (
          <>
            {editing ? <button type="button" className="md-btn is-small" onClick={save}><Icon name="check" size={13} />{t('完成')}</button> : <IconButton icon="edit" label={t('直接修改')} onClick={() => setEditing(true)} />}
            <IconButton icon="copy" label={t('复制脚本')} onClick={copy} />
            <IconButton icon={open ? 'close' : 'expand'} label={open ? t('收起') : t('放大阅读')} onClick={onToggle} />
          </>
        ) : null}
      </header>
      {!running && (editing || !text) ? (
        <textarea className="md-article-edit" aria-label={t('正文')} placeholder={t('在这里写稿，或粘贴已有正文')} value={draft} onChange={e => setDraft(e.target.value)} onBlur={save} />
      ) : text ? (
        <div className="md-article-scroll" ref={scroller} onMouseUp={onMouseUp} onScroll={() => setPicked(null)}>
          {open ? <ArticleBody production={production} text={text} onView={onView} /> : <div className="md-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
        </div>
      ) : (
        <div className={`md-skeleton ${running ? '' : 'is-still'}`} aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>
      )}
      {picked ? (
        <button type="button" className="md-pick" style={{ left: picked.x, top: picked.y }} onMouseDown={e => e.preventDefault()} onClick={() => {
          askAbout(t('这段'), picked.text)
          setPicked(null)
          window.getSelection()?.removeAllRanges()
        }}><Icon name="chat" size={12} />{t('让助手改这段')}</button>
      ) : null}
      {words && streaming ? <span className="md-tile-foot">{t('{n} 字', { n: words, s: plural(words, '', 's') })}</span> : null}
    </>
  )
}

function assetList(production) {
  return [
    ...(production?.cover?.src || production?.cover ? [{ target: 'cover', asset: production.cover, label: t('视频封面') }] : []),
    ...(production?.images ?? []).map((asset, i) => ({ target: `image:${i}`, asset, label: t('配图 {n}', { n: i + 1 }), note: asset.caption })),
    ...(production?.shots ?? []).map((asset, i) => ({ target: `shot:${i}`, asset, label: t('第 {n} 镜', { n: i + 1 }), note: [asset.visual, asset.voice].filter(Boolean).join(' · '), paper: true })),
  ]
}

/** 查看大图：左右键切换，可以重画、下载，或者让助手改。 */
function Viewer({ item, target, onChange, onClose }) {
  const imageReady = useDesk(s => s.settings?.imageReady)
  const list = assetList(item.production).filter(row => row.asset?.src || isBusy(row.asset))
  const index = Math.max(0, list.findIndex(row => row.target === target))
  const current = list[index]
  const ref = React.useRef(null)
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key === 'ArrowRight' && list[index + 1]) onChange(list[index + 1].target)
      if (event.key === 'ArrowLeft' && list[index - 1]) onChange(list[index - 1].target)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, list, onChange, onClose])
  React.useLayoutEffect(() => {
    if (reducedMotion()) return
    ref.current?.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: SPRING_SNAP.duration, easing: SPRING_SNAP.easing })
  }, [])
  if (!current) return null
  return (
    <div className="md-viewer" role="dialog" aria-label={current.label} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="md-viewer-card" ref={ref}>
        <div className={`md-viewer-image ${current.paper ? 'is-paper' : ''}`}>
          {current.asset.src ? <img key={current.asset.src} src={current.asset.src} alt={current.label} /> : null}
          {isBusy(current.asset) ? <span className="md-viewer-busy"><span className="md-shimmer">{t('正在重画…')}</span></span> : null}
        </div>
        <footer>
          <div className="md-viewer-text"><b>{current.label}</b>{current.note ? <span>{current.note}</span> : null}</div>
          <IconButton icon="chevL" label={t('上一张')} disabled={!list[index - 1]} onClick={() => list[index - 1] && onChange(list[index - 1].target)} />
          <IconButton icon="chevR" label={t('下一张')} disabled={!list[index + 1]} onClick={() => list[index + 1] && onChange(list[index + 1].target)} />
          <button type="button" className="md-pill" onClick={() => { askAbout(current.label); onClose() }}><Icon name="chat" size={13} />{t('让助手改')}</button>
          {imageReady ? <button type="button" className="md-pill" disabled={isBusy(current.asset)} onClick={() => regenAsset(item.id, current.target)}><Icon name="refresh" size={13} />{t('重画')}</button> : null}
          {current.asset.src ? <a className="md-pill" href={current.asset.src} download><Icon name="save" size={13} />{t('下载')}</a> : null}
          <IconButton icon="close" label={t('关闭')} onClick={onClose} />
        </footer>
      </div>
    </div>
  )
}

function Sheet({ item, live }) {
  const { draft: planning } = useWorkspace(item)
  const [open, setOpen] = React.useState(null)
  const [viewing, setViewing] = React.useState(null)
  const bento = React.useRef(null)
  const tiles = React.useRef({})
  const articleRef = React.useRef(null)
  const origin = React.useRef(null)
  const closing = React.useRef(false)

  const expand = (name) => {
    const box = bento.current.getBoundingClientRect()
    const rect = tiles.current[name].getBoundingClientRect()
    origin.current = { left: `${rect.left - box.left}px`, top: `${rect.top - box.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }
    setOpen(name)
  }
  const collapse = React.useCallback(() => {
    setOpen((name) => {
      if (!name || closing.current) return name
      const el = tiles.current[name]
      if (reducedMotion() || !el || !origin.current) return null
      closing.current = true
      const box = bento.current.getBoundingClientRect()
      const animation = el.animate([{ left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px` }, origin.current], { duration: SPRING_SNAP.duration, easing: SPRING_SNAP.easing, fill: 'forwards' })
      animation.onfinish = () => {
        closing.current = false
        animation.cancel()
        setOpen(null)
      }
      return name
    })
  }, [])
  const toggle = name => (open === name ? collapse() : expand(name))

  // 格子从原位放大到铺满
  React.useLayoutEffect(() => {
    if (!open || reducedMotion()) return
    const box = bento.current.getBoundingClientRect()
    tiles.current[open]?.animate([origin.current, { left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px` }], { duration: SPRING_SOFT.duration, easing: SPRING_SOFT.easing })
  }, [open])

  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !viewing) {
        event.preventDefault()
        collapse()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, viewing, collapse])

  const tile = name => ({
    ref: (el) => {
      tiles.current[name] = el
      if (name === 'article') articleRef.current = el
    },
    className: `md-tile md-tile-${name} ${open === name ? 'is-open' : ''}`,
  })
  return (
    <div className="md-sheet">
      <div className={`md-bento is-writing ${open ? 'has-open' : ''}`} ref={bento}>
        <HeroTile item={item} live={live} onView={setViewing} />
        <section {...tile('article')}>
          {planning.outlineText ? <details className="md-writing-outline"><summary>{t('写稿参考：内容大纲')}</summary><div><p>{planning.outlineText}</p><button type="button" className="md-btn is-small" onClick={() => setDesk({ studioTab: 'outline' })}>{t('修改大纲')}</button></div></details> : null}
          <ArticleTile item={item} live={live} open={open === 'article'} onToggle={() => toggle('article')} onView={setViewing} tileRef={articleRef} />
        </section>
        <footer className="md-stage-footer">
          <span>{t(item.status === 'idea' ? '先整理思路，再展开正文' : item.status === 'outline' ? '大纲确定后，开始写草稿' : '稿子确定后，再开始设计画面')}</span>
          <button type="button" className="md-btn is-primary" disabled={item.production?.status === 'running' || (!['idea', 'outline'].includes(item.status) && !(item.production?.article || item.body || '').trim())} onClick={async () => {
            if (item.status === 'idea' || item.status === 'outline') {
              setDesk({ studioTab: 'outline' })
            } else setDesk({ studioTab: 'prompts' })
          }}>{t(item.status === 'idea' ? '下一步：整理大纲' : item.status === 'outline' ? '大纲确定，进入草稿' : '稿件定稿，进入视频提示词')}<Icon name="chevR" size={14} /></button>
        </footer>
      </div>
      {viewing ? <Viewer item={item} target={viewing} onChange={setViewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

const DONE_SUGGESTIONS = ['标题再短一点', '语气轻松一点', '开场再抓人一点', '封面大字更有冲击力']

export function Studio() {
  const id = useDesk(s => s.focusId)
  const item = useDesk(s => s.state?.items.find(i => i.id === s.focusId))
  const live = useDesk(s => s.live[s.focusId])
  const settings = useDesk(s => s.settings)
  const chatOpen = useDesk(s => s.studioDock)
  const creationStage = useDesk(s => s.studioTab)
  const production = item?.production
  const running = production?.status === 'running'
  const watching = running || [production?.cover, ...(production?.images ?? []), ...(production?.shots ?? [])].some(isBusy)

  React.useEffect(() => {
    if (id && watching) return watchProduction(id)
    return undefined
  }, [id, watching])

  React.useEffect(() => {
    if (!id) return undefined
    const onKey = (event) => {
      // 有格子放大或大图打开时，Esc 只收回它们
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.md-tile.is-open,.md-viewer,.md-dialog-mask') && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
        if (chatOpen) setDesk({ studioDock: false })
        else closeItem()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, chatOpen])

  // 工作区直接显示，不为打开稿件逐帧裁切整个可滚动页面。
  // 打开的这条被删掉或撤销掉时，退回灵感墙，不留空白页
  React.useEffect(() => { if (id && !item) closeItem() }, [id, item])
  if (!item) return null
  return (
    <div className={`md-studio md-editor ${chatOpen || running ? 'chat-open' : ''}`} role="dialog" aria-label={t('灵感')}>
      <div className="md-studio-chat" id="studio-assistant" inert={!(chatOpen || running) ? '' : undefined}>
        <ChatPanel
          itemId={item.id}
          head={(
            <>
              <h2>{t('创作助手')}</h2>
              <span className="md-grow" />
              <IconButton icon="close" label={t('收起助手')} onClick={() => setDesk({ studioDock: false })} />
            </>
          )}
          top={['idea', 'outline', 'article'].includes(creationStage) ? <p className="md-discussion-context">{t(creationStage === 'idea' ? '围绕这条灵感讨论选题，确认后整理成大纲。' : creationStage === 'outline' ? '讨论并修改大纲，确认后再开始写稿。' : '依据大纲讨论和修改正文，按你的要求保存稿件。')}</p> : <IdeaCard item={item} live={live} settings={settings} />}
          suggestions={(creationStage === 'idea' ? ['先讨论这个选题的角度和受众', '根据我们的讨论整理并保存大纲'] : creationStage === 'outline' ? ['看看这个大纲哪里需要改进', '按刚才讨论的方案修改并保存大纲'] : creationStage === 'article' ? ['依据大纲先讨论正文怎么写', '根据确认的大纲写出完整口播稿'] : production?.status === 'done' ? DONE_SUGGESTIONS : []).map(row => t(row))}
          placeholder={running ? t('正在成稿，马上就好') : production?.status === 'done' ? t('想怎么改，直接说') : t('补充点想法，或者直接说要什么')}
          disabled={running}
          intro={false}
        />
      </div>

      <ContentWorkspace key={item.id} item={item}><Sheet item={item} live={live} /></ContentWorkspace>
    </div>
  )
}
