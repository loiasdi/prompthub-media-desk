import React from 'react'
import { lang, t } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'
import { exportMaitianProject } from './workspace.js'
import { MaitianPrepare } from './maitian-prepare.jsx'
import { ApiInterruptionOverview } from './api-recovery.jsx'
import { MAITIAN_PLATFORMS, MAPPED_PLATFORMS, COVER_RATIOS } from '../src/publish/maitian/platforms.js'

const PLATFORMS = Object.fromEntries(MAITIAN_PLATFORMS.map(p => [p.name, p.id]))
const DIRECT_PLATFORMS = MAITIAN_PLATFORMS.filter(p => ['xhs', 'channels'].includes(p.id))
export const MAITIAN_PLATFORM_LIST = MAITIAN_PLATFORMS
const stableJson = value => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
  return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
})

async function request(path, body) {
  const response = await fetch(`media-desk/publish/maitian/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() },
    ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path === 'preflight' ? 135_000 : 45_000),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || t('麦田组件操作失败'))
  if (['config', 'probe'].includes(path) && (!value || typeof value.enabled !== 'boolean' || !['store', 'local'].includes(value.source) || !Number.isInteger(value.port) || typeof value.profileId !== 'string' || !value.diagnostic)) throw new Error(t('麦田配置响应不完整，请更新并重启 DSH Host 后重试'))
  return value
}

export function useMaitianBundle({ item, draft, update, assets, publishing }) {
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)
  const [confirmExisting, setConfirmExisting] = React.useState(false)
  const running = React.useRef(false)
  const generation = React.useRef(0)

  const publish = draft.publish
  const browser = publish.browser || { covers: {}, shortTitle: '' }
  const selectedPlatforms = Array.isArray(browser.platforms)
    ? browser.platforms.filter(id => typeof id === 'string' && Object.hasOwn(MAPPED_PLATFORMS, id))
    : ['xhs', 'channels']
  const neededRatios = [...new Set(MAITIAN_PLATFORM_LIST.filter(p => selectedPlatforms.includes(p.id)).flatMap(p => p.ratios))]
  const hasChannels = selectedPlatforms.includes('channels')
  const anyLocked = selectedPlatforms.some(id => Boolean(publishing?.lockedPlatforms?.[id]))

  const signature = stableJson([item.id, draft.publish, draft.selectedVideo, draft.selectedCover])
  React.useEffect(() => { setResult(null); setConfirmExisting(false); setError(''); generation.current++ }, [signature])
  React.useEffect(() => () => { generation.current++ }, [])

  const patch = value => update({ publish: { ...publish, ...value } })
  const patchBrowser = value => patch({ browser: { ...browser, ...value } })
  const togglePlatform = id => {
    const next = selectedPlatforms.includes(id)
      ? selectedPlatforms.filter(row => row !== id)
      : [...selectedPlatforms, id]
    patchBrowser({ platforms: next })
  }

  const exportProject = async () => {
    if (running.current) return
    running.current = true
    const token = generation.current
    setBusy('export'); setError(''); setResult(null)
    try {
      const value = await exportMaitianProject(item.id, selectedPlatforms, confirmExisting)
      if (token === generation.current) setResult(value)
    } catch (failure) {
      if (token === generation.current) setError(failure.message)
    } finally {
      running.current = false; setBusy('')
    }
  }

  const checks = [
    ...(publish.format !== 'video' ? [{ text: '发布类型为视频', done: false, issue: '麦田工程打包仅支持视频，请返回「资料配齐」切回视频或改选其他渠道。' }] : []),
    { text: '目标平台', done: selectedPlatforms.length > 0, issue: selectedPlatforms.length ? '' : '请至少勾选一个麦田平台。' },
    { text: '发布标题', done: Boolean(publish.title?.trim()), issue: publish.title?.trim() ? '' : '请返回「资料配齐」填写标题。' },
    { text: '本地成片', done: Boolean(draft.selectedVideo), issue: draft.selectedVideo ? '' : '请返回「资料配齐」选择成片视频。' },
    ...(publish.format === 'video' && neededRatios.length ? [{ text: '工程封面（{ratios}）', vars: { ratios: neededRatios.join(' / ') }, done: neededRatios.some(r => Boolean(browser.covers?.[r])), optional: true }] : []),
    ...(publish.mode === 'scheduled' ? [{ text: '预约时间（北京时间）', done: Boolean(publish.when), issue: publish.when ? '' : '请选择预约发布时间。' }] : []),
    ...(hasChannels ? [{ text: '视频号短标题', done: Boolean(browser.shortTitle?.trim()), issue: browser.shortTitle?.trim() ? '' : '勾选视频号时请填写短标题，否则麦田组件会拒绝整个工程。' }] : []),
  ]
  const canExport = !busy && !item.sample && publish.format === 'video' && selectedPlatforms.length > 0 && Boolean(draft.selectedVideo) && Boolean(publish.title?.trim()) && (!hasChannels || Boolean(browser.shortTitle?.trim())) && (publish.mode !== 'scheduled' || Boolean(publish.when)) && (!anyLocked || confirmExisting)

  return {
    publish, browser, selectedPlatforms, neededRatios, hasChannels, anyLocked,
    settingsOpen, setSettingsOpen, busy, error, result, confirmExisting, setConfirmExisting,
    patch, patchBrowser, togglePlatform, exportProject, checks, canExport,
    assets, item, draft, update, publishing,
  }
}

function detectCoverRatio(asset) {
  const width = asset?.width || asset?.w
  const height = asset?.height || asset?.h
  if (!width || !height) return null
  const ratio = width / height
  if (Math.abs(ratio - 3 / 4) <= 0.01) return '3x4'
  if (Math.abs(ratio - 4 / 3) <= 0.01) return '4x3'
  if (Math.abs(ratio - 16 / 9) <= 0.01) return '16x9'
  return null
}

export function MaitianBundlePanel({ bundle }) {
  const { publish, browser, selectedPlatforms, neededRatios, hasChannels, setSettingsOpen, patch, patchBrowser, togglePlatform, assets, item, draft, update, publishing } = bundle
  const images = assets.filter(asset => asset.type === 'image')
  const step1Cover = images.find(asset => asset.id === draft.selectedCover)
  const usedCoverIds = Object.values(browser.covers || {}).filter(Boolean)
  const coverNotMapped = Boolean(neededRatios.length > 0 && step1Cover && !usedCoverIds.includes(step1Cover.id))
  const matchedRatio = coverNotMapped ? detectCoverRatio(step1Cover) : null
  const canQuickFillCover = Boolean(matchedRatio && neededRatios.includes(matchedRatio) && !browser.covers?.[matchedRatio])
  return <>
    <section className="md-work-panel">
      <div className="md-work-panel-title">
        <h3>{t('选择麦田打包平台')}</h3>
        <button type="button" className="md-btn is-small" onClick={() => setSettingsOpen(true)}><Icon name="gear" size={13} />{t('麦田设置')}</button>
      </div>
      {publish.format !== 'video' ? <p className="md-publish-pending">{t('麦田工程打包仅支持视频，请返回「资料配齐」切回视频或改选其他渠道。')}</p> : <>
        <p className="md-publish-pending">{t('勾选的平台会打包进同一份 publish.json，保存到成稿导出目录后，在原版麦田助手一次导入即可分发。')}</p>
        <div className="md-maitian-platforms">
          {MAITIAN_PLATFORM_LIST.map(entry => {
            const on = selectedPlatforms.includes(entry.id)
            const locked = Boolean(publishing?.lockedPlatforms?.[entry.id])
            return <label key={entry.id} className={on ? 'is-on' : ''}>
              <input type="checkbox" checked={on} onChange={() => togglePlatform(entry.id)} />
              <div>
                <strong>{t(entry.name)}{locked ? <small className="md-maitian-badge">{t('已有记录')}</small> : null}</strong>
                <span>{t(entry.desc)}</span>
              </div>
            </label>
          })}
        </div>
      </>}
    </section>
    {selectedPlatforms.length > 0 && publish.format === 'video' ? <section className="md-work-panel">
      <div className="md-work-panel-title"><h3>{t('平台差异与预约设置')}</h3><span>{t('可选')}</span></div>
      {hasChannels ? <label className="md-field"><span>{t('视频号短标题')} *</span><input required value={browser.shortTitle || ''} placeholder={t('请输入视频号短标题，原版组件会校验长度')} onChange={event => patchBrowser({ shortTitle: event.target.value })} /></label> : null}
      {coverNotMapped ? <div className="md-publish-source-notice" style={{ marginTop: 12 }}>
        <p>{canQuickFillCover ? t('第 1 页已选封面「{name}」符合 {ratio} 比例，可直接填入。', { name: step1Cover.name, ratio: matchedRatio }) : t('第 1 页的默认封面不会自动裁剪，如需自定义封面请在下方按平台所需比例指定。')}</p>
        {canQuickFillCover ? <button type="button" className="md-btn is-small" onClick={() => patchBrowser({ covers: { ...browser.covers, [matchedRatio]: step1Cover.id } })}>{t('填入 {ratio} 封面', { ratio: matchedRatio })}</button> : null}
      </div> : null}
      <div className="md-maitian-covers">
        {neededRatios.map(ratio => <label className="md-field" key={ratio}>
          <span>{t('工程封面')} {ratio}</span>
          <select value={browser.covers?.[ratio] || ''} onChange={event => patchBrowser({ covers: { ...browser.covers, [ratio]: event.target.value } })}>
            <option value="">{t('使用平台默认封面')}</option>
            {images.map(asset => <option value={asset.id} key={asset.id}>{asset.name}</option>)}
          </select>
        </label>)}
      </div>
      <div className="md-maitian-schedule">
        <label className="md-field">
          <span>{t('工程预约时间')}</span>
          <select value={publish.mode === 'scheduled' ? 'scheduled' : 'now'} onChange={event => patch({ mode: event.target.value === 'scheduled' ? 'scheduled' : 'now', timezone: 'Asia/Shanghai' })}>
            <option value="now">{t('立即填写')}</option>
            <option value="scheduled">{t('平台预约（北京时间）')}</option>
          </select>
        </label>
        {publish.mode === 'scheduled' ? <label className="md-field"><span>Asia/Shanghai (UTC+08:00)</span><input type="datetime-local" value={publish.when} onChange={event => patch({ when: event.target.value, timezone: 'Asia/Shanghai' })} /></label> : null}
      </div>
    </section> : null}
    {bundle.settingsOpen ? <MaitianSettingsDialog item={item} draft={draft} update={update} assets={assets} publishing={publishing} onClose={() => setSettingsOpen(false)} /> : null}
  </>
}

export function MaitianExportConsole({ bundle }) {
  const { selectedPlatforms, anyLocked, busy, error, result, confirmExisting, setConfirmExisting, exportProject, checks, canExport, item } = bundle
  const required = checks.filter(row => !row.optional)
  const ready = required.filter(row => row.done).length
  const selectedNames = MAITIAN_PLATFORM_LIST.filter(p => selectedPlatforms.includes(p.id)).map(p => t(p.name)).join(' + ')
  return <section className="md-work-panel md-release-checks">
    <div className="md-work-panel-title"><h3>{t('麦田工程包')}</h3><span>{ready}/{required.length}</span></div>
    {selectedNames ? <p className="md-maitian-target-summary">{t('包含平台')}：<strong>{selectedNames}</strong></p> : null}
    <ul className="md-publish-checklist">{checks.map(row => <li key={row.text} className={row.done ? 'is-done' : ''}>
      <i aria-hidden="true">{row.done ? <Icon name="check" size={12} /> : null}</i>
      <div><span>{t(row.text, row.vars)}</span>{!row.done && row.issue ? <span className="md-publish-check-issue">{t(row.issue)}</span> : null}</div>
      <small>{t(row.done ? '已准备' : row.optional ? '可选' : '待处理')}</small>
    </li>)}</ul>
    <div className="md-publish-submit">
      <label className="md-maitian-check">
        <input type="checkbox" checked={confirmExisting} onChange={event => setConfirmExisting(event.target.checked)} />
        <span>{t(anyLocked ? '所选平台已有投稿记录，我已核对并确认导出不会重复发布' : '已核对平台已有内容，确认导出不会造成重复发布')}</span>
      </label>
      <button type="button" className="md-btn is-primary is-wide" disabled={!canExport} onClick={exportProject}>{t(busy === 'export' ? '正在生成工程…' : '校验并生成麦田工程包')}</button>
      {item.sample ? <span role="status">{t('示例稿件不可导出工程包。')}</span> : <span role="status">{t(canExport ? '信息已齐全，生成后可在原版麦田助手导入。' : '完成必填项后即可生成麦田工程包。')}</span>}
      {error ? <p className="md-publish-error" role="alert">{error}</p> : null}
      {result ? <div className="md-maitian-result" role="status">
        <p><strong>{t('麦田工程已保存到项目设置的成稿导出目录')}</strong></p>
        {result.exportDirectory ? <p><code>{result.exportDirectory}</code></p> : null}
        <a className="md-btn is-small is-wide" href={result.downloadPath} download>{t('下载压缩包')}</a>
        {result.warnings?.map((warning, index) => <p key={index}>{t('麦田组件提示')}：{warning}</p>)}
      </div> : null}
    </div>
  </section>
}

export function MaitianSettingsDialog({ item, draft, update, assets, publishing, onClose }) {
  const [config, setConfig] = React.useState(null)
  const [settings, setSettings] = React.useState({ enabled: false, source: 'store', localComponentDir: '', nodePath: '', chromePath: '', port: 9333, fillTimeoutMinutes: 360 })
  const [directPlatform, setDirectPlatform] = React.useState(DIRECT_PLATFORMS.find(p => p.name === draft.publish.platform)?.id || 'xhs')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [browserResult, setBrowserResult] = React.useState(null)
  const running = React.useRef(false)
  const generation = React.useRef(0)

  React.useEffect(() => () => { generation.current++ }, [])
  React.useEffect(() => { setBrowserResult(null) }, [item.id, directPlatform, JSON.stringify(settings)])
  React.useEffect(() => {
    let current = true
    request('config').then(value => {
      if (current) { setConfig(value); setSettings(previous => ({ ...previous, enabled: value.enabled, source: value.source, port: value.port, fillTimeoutMinutes: value.fillTimeoutMinutes ?? 360 })) }
    }, failure => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [])

  const perform = async (label, action) => {
    if (running.current) return
    running.current = true
    const token = generation.current
    setBusy(label); setError('')
    try { await action(() => token === generation.current) }
    catch (failure) { if (token === generation.current) setError(failure.message) }
    finally { running.current = false; setBusy('') }
  }
  const save = () => perform('save', async current => {
    const patch = { enabled: settings.enabled, source: settings.source, port: settings.port, fillTimeoutMinutes: settings.fillTimeoutMinutes }
    if (settings.localComponentDir) patch.localComponentDir = settings.localComponentDir
    if (settings.nodePath) patch.nodePath = settings.nodePath
    if (settings.chromePath) patch.chromePath = settings.chromePath
    const value = await request('config', patch)
    if (current()) { setConfig(value); setSettings(previous => ({ ...previous, localComponentDir: '', nodePath: '', chromePath: '' })) }
  })
  const probe = () => perform('probe', async current => { setBrowserResult(null); const value = await request('probe', {}); if (current()) setConfig(value) })
  const diagnostic = config?.diagnostic
  const dirty = Boolean(config && (settings.source !== config.source || settings.enabled !== config.enabled || settings.port !== config.port || settings.fillTimeoutMinutes !== (config.fillTimeoutMinutes ?? 360) || settings.localComponentDir || settings.nodePath || settings.chromePath))
  const browserDisabled = Boolean(busy) || dirty || !config?.enabled
  const operateBrowser = op => perform(op, async current => {
    const body = op === 'open-page' ? { operationId: browserResult?.value.operationId } : ['open-login', 'preflight'].includes(op) ? { platform: directPlatform } : {}
    const value = await request(op, body)
    if (current() && op !== 'open-page') setBrowserResult({ op, value })
  })

  return <Dialog title={t('麦田设置与高级选项')} onClose={() => { if (!busy) onClose() }} width={640}>
    <div className="md-form md-maitian-settings-dialog">
      <p className="md-publish-pending">{t('日常导出麦田工程包无需配置专用 Chrome；以下设置仅用于实验性本机浏览器直驱与旧记录排障。')}</p>
      {error ? <p role="alert" className="md-publish-error">{error}</p> : null}
      {config ? <>
        <label className="md-maitian-check"><input type="checkbox" checked={settings.enabled} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, enabled: event.target.checked }))} /><span>{t('启用本机专用 Chrome')}</span></label>
        <p className="md-publish-pending">{t('浏览器在 DSH Host 所在机器打开，使用独立资料。安装组件与平台登录均需在这个窗口完成。')}</p>
        <label className="md-field"><span>{t('组件来源')}</span><select value={settings.source} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, source: event.target.value }))}><option value="store">{t('专用 Chrome 已安装的商店版')}</option><option value="local">{t('原版组件本地目录（开发排障）')}</option></select></label>
        {settings.source === 'local' ? <label className="md-field"><span>{t('原版组件绝对目录')}</span><input value={settings.localComponentDir} disabled={Boolean(busy)} placeholder={t(config.localComponentConfigured ? '已配置，留空保留' : '输入本机原版组件目录')} onChange={event => setSettings(value => ({ ...value, localComponentDir: event.target.value }))} /></label> : null}
        <div className="md-maitian-settings-grid">
          <label className="md-field"><span>{t('专用 Chrome 调试端口')}</span><input type="number" min="1024" max="65535" value={settings.port} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, port: Number(event.target.value) }))} /></label>
          <label className="md-field"><span>{t('填写保护时限（分钟）')}</span><input type="number" min="1" max="1440" step="1" value={settings.fillTimeoutMinutes} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, fillTimeoutMinutes: Number(event.target.value) }))} /></label>
        </div>
        <details className="md-maitian-advanced">
          <summary>{t('可执行文件路径与存储说明（可选）')}</summary>
          <label className="md-field"><span>{t('Chrome 可执行文件（可选）')}</span><input value={settings.chromePath} disabled={Boolean(busy)} placeholder={t('留空保留已保存设置')} onChange={event => setSettings(value => ({ ...value, chromePath: event.target.value }))} /></label>
          <label className="md-field"><span>{t('独立 Node 可执行文件（可选）')}</span><input value={settings.nodePath} disabled={Boolean(busy)} placeholder={t('留空保留已保存设置')} onChange={event => setSettings(value => ({ ...value, nodePath: event.target.value }))} /></label>
          <p className="md-publish-pending">{t('这是本机执行器的总时限，默认 360 分钟，并非平台上传时限。到时先请求停止，30 秒后终止执行器；浏览器上传可能继续，需人工核对。')}</p>
          <p className="md-publish-pending">{t('本机任务素材上限 2 GiB，复制时保留 500 MiB 磁盘余量。准备前后自动清理本工作区过期或被替换的准备副本；已核实终态保留七天，未知和待处理任务继续保留。导出文件不自动删除。')}</p>
        </details>
        {dirty ? <p className="md-publish-pending">{t('配置有未保存的修改，请先保存再操作。')}</p> : null}
        <div className="md-work-actions">
          <button type="button" className="md-btn is-primary" disabled={Boolean(busy)} onClick={save}>{t('保存组件配置')}</button>
          <button type="button" className="md-btn" disabled={Boolean(busy) || dirty} onClick={probe}>{t(busy === 'probe' ? '正在检测组件' : '检测原版组件')}</button>
        </div>
        <p role="status" className="md-publish-pending">{diagnostic?.detectedVersion ? `${t('检测到组件版本')} ${diagnostic.detectedVersion} · ${t('仅完成接口探测，未验证真实平台')}` : t(diagnostic?.message || '尚未检测麦田组件')}</p>
        <details className="md-maitian-advanced">
          <summary>{t('实验性：本机浏览器直驱与登录预检')}</summary>
          <label className="md-field">
            <span>{t('直驱目标平台')}</span>
            <select value={directPlatform} disabled={Boolean(busy)} onChange={event => setDirectPlatform(event.target.value)}>
              {DIRECT_PLATFORMS.map(entry => <option key={entry.id} value={entry.id}>{t(entry.name)}</option>)}
            </select>
          </label>
          {PLATFORMS[draft.publish.platform] !== directPlatform ? <div className="md-publish-source-notice" style={{ marginTop: 8 }}>
            <p>{t('直驱快照会按选定目标平台生成，不会修改稿件的平台字段。')}</p>
          </div> : null}
          <div className="md-work-actions">
            <button type="button" className="md-btn is-small" disabled={browserDisabled} onClick={() => operateBrowser('open-install')}>{t('在专用 Chrome 安装麦田组件')}</button>
            <button type="button" className="md-btn is-small" disabled={browserDisabled} onClick={() => operateBrowser('open-login')}>{t('打开平台登录页')}</button>
            <button type="button" className="md-btn is-small" disabled={browserDisabled} onClick={() => operateBrowser('preflight')}>{t(busy === 'preflight' ? '正在调用麦田登录预检' : '检查平台登录')}</button>
          </div>
          {browserResult ? <div role="status" className="md-maitian-result">
            <p>{t(browserResult.op === 'preflight' ? browserResult.value.ok ? '麦田预检：页面可用，请在 Chrome 中核对目标账号。' : '麦田预检：页面未就绪，请完成登录并重试。' : browserResult.op === 'open-install' ? '已打开专用 Chrome 商店页，安装后请重新检测组件。' : '已打开专用 Chrome 平台页，请在窗口中完成登录。')}</p>
            {browserResult.value.reason ? <p>{browserResult.value.reason}</p> : null}
            <p>{t('登录预检不验证账号身份，也不会上传或填写稿件。')}</p>
            {browserResult.value.canOpenPage ? <button type="button" className="md-btn is-small" disabled={browserDisabled} onClick={() => operateBrowser('open-page')}>{t('打开刚才的原页面')}</button> : null}
          </div> : null}
          <MaitianPrepare item={item} draft={draft} assets={assets} platform={directPlatform} config={config}
            preflight={browserResult?.op === 'preflight' ? browserResult.value : null} disabled={browserDisabled} busy={busy}
            locked={Boolean(publishing?.lockedPlatforms?.[directPlatform])} statusKnown={Boolean(publishing?.known && !publishing.statusError)}
            perform={perform} request={request} refresh={publishing?.refresh || (async () => {})} />
        </details>
      </> : null}
      <details className="md-maitian-advanced">
        <summary>{t('排障：检查升级前的 API 投稿')}</summary>
        <ApiInterruptionOverview />
      </details>
    </div>
  </Dialog>
}

export function MaitianExport({ item, draft, update, assets, publishing }) {
  const [open, setOpen] = React.useState(draft.publish.provider === 'maitian')
  const [config, setConfig] = React.useState(null)
  const [settings, setSettings] = React.useState({ enabled: false, source: 'store', localComponentDir: '', nodePath: '', chromePath: '', port: 9333, fillTimeoutMinutes: 360 })
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)
  const [confirmExisting, setConfirmExisting] = React.useState(false)
  const [browserResult, setBrowserResult] = React.useState(null)
  const running = React.useRef(false)
  const generation = React.useRef(0)
  const signature = stableJson([item.id, draft.publish, draft.selectedVideo, draft.selectedCover])
  React.useEffect(() => { setResult(null); setConfirmExisting(false); generation.current++ }, [signature])
  React.useEffect(() => { if (draft.publish.provider === 'maitian') setOpen(true) }, [draft.publish.provider])
  React.useEffect(() => () => { generation.current++ }, [])
  React.useEffect(() => { setBrowserResult(null) }, [item.id, draft.publish.platform, JSON.stringify(settings)])
  const perform = async (label, action) => {
    if (running.current) return
    running.current = true
    const token = generation.current
    setBusy(label); setError('')
    try { await action(() => token === generation.current) }
    catch (failure) { if (token === generation.current) setError(failure.message) }
    finally { running.current = false; setBusy('') }
  }
  React.useEffect(() => {
    if (!open) return
    let current = true
    request('config').then(value => {
      if (current) { setConfig(value); setSettings(previous => ({ ...previous, enabled: value.enabled, source: value.source, port: value.port, fillTimeoutMinutes: value.fillTimeoutMinutes ?? 360 })) }
    }, failure => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [open])
  const publish = draft.publish
  const platform = PLATFORMS[publish.platform]
  const browser = publish.browser || { covers: {}, shortTitle: '' }
  const shortTitleReady = platform !== 'channels' || Boolean(browser.shortTitle?.trim())
  const patch = value => update({ publish: { ...publish, ...value } })
  const patchBrowser = value => patch({ browser: { ...browser, ...value } })
  const save = () => perform('save', async current => {
    const patch = { enabled: settings.enabled, source: settings.source, port: settings.port, fillTimeoutMinutes: settings.fillTimeoutMinutes }
    if (settings.localComponentDir) patch.localComponentDir = settings.localComponentDir
    if (settings.nodePath) patch.nodePath = settings.nodePath
    if (settings.chromePath) patch.chromePath = settings.chromePath
    const value = await request('config', patch)
    if (current()) { setConfig(value); setSettings(previous => ({ ...previous, localComponentDir: '', nodePath: '', chromePath: '' })) }
  })
  const probe = () => perform('probe', async current => { setBrowserResult(null); const value = await request('probe', {}); if (current()) setConfig(value) })
  const exportProject = () => perform('export', async current => {
    setResult(null)
    const value = await exportMaitianProject(item.id, platform, confirmExisting)
    if (current()) setResult(value)
  })
  const diagnostic = config?.diagnostic
  const dirty = Boolean(config && (settings.source !== config.source || settings.enabled !== config.enabled || settings.port !== config.port || settings.fillTimeoutMinutes !== (config.fillTimeoutMinutes ?? 360) || settings.localComponentDir || settings.nodePath || settings.chromePath))
  const browserDisabled = Boolean(busy) || dirty || !config?.enabled
  const operateBrowser = op => perform(op, async current => {
    const body = op === 'open-page' ? { operationId: browserResult?.value.operationId } : ['open-login', 'preflight'].includes(op) ? { platform } : {}
    const value = await request(op, body)
    if (current() && op !== 'open-page') setBrowserResult({ op, value })
  })
  return <section className="md-work-panel">
    <div className="md-work-panel-title"><h3>{t('麦田发布组件')}</h3><button type="button" className="md-btn is-small" onClick={() => setOpen(value => !value)}>{t(open ? '收起' : '配置与导出')}</button></div>
    {open ? <div className="md-form">
      <p className="md-publish-pending">{t('工程保存到项目设置的成稿导出目录，再由日常浏览器里的原版麦田助手选择导入。')}</p>
      <ApiInterruptionOverview />
      {error ? <p role="alert" className="md-publish-pending">{error}</p> : null}
      {config ? <>
        <label><input type="checkbox" checked={settings.enabled} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, enabled: event.target.checked }))} />{t('启用本机专用 Chrome')}</label>
        <p>{t('浏览器在 DSH Host 所在机器打开，使用独立资料。安装组件与平台登录均需在这个窗口完成。')}</p>
        <label className="md-field"><span>{t('组件来源')}</span><select value={settings.source} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, source: event.target.value }))}><option value="store">{t('专用 Chrome 已安装的商店版')}</option><option value="local">{t('原版组件本地目录（开发排障）')}</option></select></label>
        {settings.source === 'local' ? <label className="md-field"><span>{t('原版组件绝对目录')}</span><input value={settings.localComponentDir} disabled={Boolean(busy)} placeholder={t(config.localComponentConfigured ? '已配置，留空保留' : '输入本机原版组件目录')} onChange={event => setSettings(value => ({ ...value, localComponentDir: event.target.value }))} /></label> : null}
        <label className="md-field"><span>{t('Chrome 可执行文件（可选）')}</span><input value={settings.chromePath} disabled={Boolean(busy)} placeholder={t('留空保留已保存设置')} onChange={event => setSettings(value => ({ ...value, chromePath: event.target.value }))} /></label>
        <label className="md-field"><span>{t('独立 Node 可执行文件（可选）')}</span><input value={settings.nodePath} disabled={Boolean(busy)} placeholder={t('留空保留已保存设置')} onChange={event => setSettings(value => ({ ...value, nodePath: event.target.value }))} /></label>
        <label className="md-field"><span>{t('专用 Chrome 调试端口')}</span><input type="number" min="1024" max="65535" value={settings.port} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, port: Number(event.target.value) }))} /></label>
        <label className="md-field"><span>{t('填写保护时限（分钟）')}</span><input type="number" min="1" max="1440" step="1" value={settings.fillTimeoutMinutes} disabled={Boolean(busy)} onChange={event => setSettings(value => ({ ...value, fillTimeoutMinutes: Number(event.target.value) }))} /></label>
        <p>{t('这是本机执行器的总时限，默认 360 分钟，并非平台上传时限。到时先请求停止，30 秒后终止执行器；浏览器上传可能继续，需人工核对。')}</p>
        <p>{t('本机任务素材上限 2 GiB，复制时保留 500 MiB 磁盘余量。准备前后自动清理本工作区过期或被替换的准备副本；已核实终态保留七天，未知和待处理任务继续保留。导出文件不自动删除。')}</p>
        {dirty ? <p>{t('配置有未保存的修改，请先保存再操作。')}</p> : null}
        <div className="md-publish-actions"><button type="button" className="md-btn" disabled={Boolean(busy)} onClick={save}>{t('保存组件配置')}</button><button type="button" className="md-btn" disabled={Boolean(busy) || dirty} onClick={probe}>{t(busy === 'probe' ? '正在检测组件' : '检测原版组件')}</button></div>
        <p role="status">{diagnostic?.detectedVersion ? `${t('检测到组件版本')} ${diagnostic.detectedVersion} · ${t('仅完成接口探测，未验证真实平台')}` : t(diagnostic?.message || '尚未检测麦田组件')}</p>
        <div className="md-publish-actions">
          <button type="button" className="md-btn" disabled={browserDisabled} onClick={() => operateBrowser('open-install')}>{t('在专用 Chrome 安装麦田组件')}</button>
          {platform ? <>
            <button type="button" className="md-btn" disabled={browserDisabled} onClick={() => operateBrowser('open-login')}>{t('打开平台登录页')}</button>
            <button type="button" className="md-btn" disabled={browserDisabled} onClick={() => operateBrowser('preflight')}>{t(busy === 'preflight' ? '正在调用麦田登录预检' : '检查平台登录')}</button>
          </> : null}
        </div>
        {browserResult ? <div role="status">
          <p>{t(browserResult.op === 'preflight' ? browserResult.value.ok ? '麦田预检：页面可用，请在 Chrome 中核对目标账号。' : '麦田预检：页面未就绪，请完成登录并重试。' : browserResult.op === 'open-install' ? '已打开专用 Chrome 商店页，安装后请重新检测组件。' : '已打开专用 Chrome 平台页，请在窗口中完成登录。')}</p>
          {browserResult.value.reason ? <p>{browserResult.value.reason}</p> : null}
          <p>{t('登录预检不验证账号身份，也不会上传或填写稿件。')}</p>
          {browserResult.value.canOpenPage ? <button type="button" className="md-btn" disabled={browserDisabled} onClick={() => operateBrowser('open-page')}>{t('打开刚才的原页面')}</button> : null}
        </div> : null}
      </> : null}
      {platform && publish.format === 'video' ? <>
        {config ? <p>{t('浏览器资料')}：{config.profileId}{(browser.profileId || 'default') !== config.profileId ? <> · <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => patchBrowser({ profileId: config.profileId })}>{t('使用当前专用资料')}</button></> : null}</p> : null}
        {platform === 'channels' ? <label className="md-field"><span>{t('视频号短标题')} *</span><input required value={browser.shortTitle || ''} onChange={event => patchBrowser({ shortTitle: event.target.value })} /></label> : null}
        {COVER_RATIOS[platform].map(ratio => <label className="md-field" key={ratio}><span>{t('工程封面')} {ratio}</span><select value={browser.covers?.[ratio] || ''} onChange={event => patchBrowser({ covers: { ...browser.covers, [ratio]: event.target.value } })}><option value="">{t('使用平台默认封面')}</option>{assets.filter(asset => asset.type === 'image').map(asset => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>)}
        <label className="md-field"><span>{t('工程预约时间')}</span><select value={publish.mode === 'scheduled' ? 'scheduled' : 'now'} onChange={event => patch({ mode: event.target.value === 'scheduled' ? 'scheduled' : publish.provider === 'maitian' ? 'now' : 'manual', timezone: 'Asia/Shanghai' })}><option value="now">{t('立即填写')}</option><option value="scheduled">{t('平台预约（北京时间）')}</option></select></label>
        {publish.mode === 'scheduled' ? <label className="md-field"><span>Asia/Shanghai (UTC+08:00)</span><input type="datetime-local" value={publish.when} onChange={event => patch({ when: event.target.value, timezone: 'Asia/Shanghai' })} /></label> : null}
        <label><input type="checkbox" checked={confirmExisting} onChange={event => setConfirmExisting(event.target.checked)} />{t('已核对平台已有内容，确认导出不会造成重复发布')}</label>
        <button type="button" className="md-btn" disabled={Boolean(busy) || item.sample || !draft.selectedVideo || !shortTitleReady} onClick={exportProject}>{t(busy === 'export' ? '正在生成工程' : '导出麦田工程')}</button>
        {result ? <div role="status"><p>{t('麦田工程已保存到项目设置的成稿导出目录')}</p><a className="md-btn" href={result.downloadPath} download>{t('下载压缩包')}</a>{result.warnings.map((warning, index) => <p key={index}>{t('麦田组件提示')}：{warning}</p>)}</div> : null}
      </> : <p>{t('麦田工程支持 B站、小红书、抖音、视频号、YouTube、X、Instagram 单篇视频')}</p>}
      <MaitianPrepare item={item} draft={draft} assets={assets} platform={platform} config={config}
        preflight={browserResult?.op === 'preflight' ? browserResult.value : null} disabled={browserDisabled} busy={busy}
        locked={Boolean(publishing?.lockedPlatforms?.[platform])} statusKnown={Boolean(publishing?.known && !publishing.statusError)}
        perform={perform} request={request} refresh={publishing?.refresh || (async () => {})} />
    </div> : null}
  </section>
}
