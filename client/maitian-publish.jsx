import React from 'react'
import { lang, t } from './i18n.js'
import { exportMaitianProject } from './workspace.js'
import { MaitianPrepare } from './maitian-prepare.jsx'
import { ApiInterruptionOverview } from './api-recovery.jsx'

const PLATFORMS = { '小红书': 'xhs', '视频号': 'channels' }
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

export function MaitianExport({ item, draft, update, assets, publishing }) {
  const [open, setOpen] = React.useState(draft.publish.provider === 'maitian')
  const [config, setConfig] = React.useState(null)
  const [settings, setSettings] = React.useState({ enabled: false, source: 'store', localComponentDir: '', exportComponentDir: '', nodePath: '', chromePath: '', port: 9333, fillTimeoutMinutes: 360 })
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)
  const [confirmExisting, setConfirmExisting] = React.useState(false)
  const [browserResult, setBrowserResult] = React.useState(null)
  const running = React.useRef(false)
  const generation = React.useRef(0)
  const signature = JSON.stringify([item.id, draft.publish, draft.selectedVideo, draft.selectedCover])
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
  const patch = value => update({ publish: { ...publish, ...value } })
  const patchBrowser = value => patch({ browser: { ...browser, ...value } })
  const save = () => perform('save', async current => {
    const patch = { enabled: settings.enabled, source: settings.source, port: settings.port, fillTimeoutMinutes: settings.fillTimeoutMinutes }
    if (settings.localComponentDir) patch.localComponentDir = settings.localComponentDir
    if (settings.exportComponentDir) patch.exportComponentDir = settings.exportComponentDir
    if (settings.nodePath) patch.nodePath = settings.nodePath
    if (settings.chromePath) patch.chromePath = settings.chromePath
    const value = await request('config', patch)
    if (current()) { setConfig(value); setSettings(previous => ({ ...previous, localComponentDir: '', exportComponentDir: '', nodePath: '', chromePath: '' })) }
  })
  const probe = () => perform('probe', async current => { setBrowserResult(null); const value = await request('probe', {}); if (current()) setConfig(value) })
  const exportProject = () => perform('export', async current => {
    setResult(null)
    const value = await exportMaitianProject(item.id, platform, confirmExisting)
    if (current()) setResult(value)
  })
  const diagnostic = config?.diagnostic
  const dirty = Boolean(config && (settings.source !== config.source || settings.enabled !== config.enabled || settings.port !== config.port || settings.fillTimeoutMinutes !== (config.fillTimeoutMinutes ?? 360) || settings.localComponentDir || settings.exportComponentDir || settings.nodePath || settings.chromePath))
  const browserDisabled = Boolean(busy) || dirty || !config?.enabled
  const operateBrowser = op => perform(op, async current => {
    const body = op === 'open-page' ? { operationId: browserResult?.value.operationId } : ['open-login', 'preflight'].includes(op) ? { platform } : {}
    const value = await request(op, body)
    if (current() && op !== 'open-page') setBrowserResult({ op, value })
  })
  return <section className="md-work-panel">
    <div className="md-work-panel-title"><h3>{t('麦田发布组件')}</h3><button type="button" className="md-btn is-small" onClick={() => setOpen(value => !value)}>{t(open ? '收起' : '配置与导出')}</button></div>
    {open ? <div className="md-form">
      <p className="md-publish-pending">{t('使用专用 Chrome 中安装的原版麦田组件；也可导出工程，在原版面板打开。')}</p>
        <label className="md-field"><span>{t('工程导出校验组件目录')}</span><input value={settings.exportComponentDir} disabled={Boolean(busy)} placeholder={t(config?.exportComponentConfigured ? '已配置，留空保留' : '填日常浏览器已安装的原版组件目录')} onChange={event => setSettings(value => ({ ...value, exportComponentDir: event.target.value }))} /></label>
        <p>{t('此目录只用于调用原版校验器生成工程，不会启动专用 Chrome；上游文件只读。')}</p>
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
        {platform === 'channels' ? <label className="md-field"><span>{t('视频号短标题')}</span><input value={browser.shortTitle || ''} onChange={event => patchBrowser({ shortTitle: event.target.value })} /></label> : null}
        {(platform === 'channels' ? ['3x4', '4x3'] : ['3x4']).map(ratio => <label className="md-field" key={ratio}><span>{t('工程封面')} {ratio}</span><select value={browser.covers?.[ratio] || ''} onChange={event => patchBrowser({ covers: { ...browser.covers, [ratio]: event.target.value } })}><option value="">{t('使用平台默认封面')}</option>{assets.filter(asset => asset.type === 'image').map(asset => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>)}
        <label className="md-field"><span>{t('工程预约时间')}</span><select value={publish.mode === 'scheduled' ? 'scheduled' : 'now'} onChange={event => patch({ mode: event.target.value === 'scheduled' ? 'scheduled' : publish.provider === 'maitian' ? 'now' : 'manual', timezone: 'Asia/Shanghai' })}><option value="now">{t('立即填写')}</option><option value="scheduled">{t('平台预约（北京时间）')}</option></select></label>
        {publish.mode === 'scheduled' ? <label className="md-field"><span>Asia/Shanghai (UTC+08:00)</span><input type="datetime-local" value={publish.when} onChange={event => patch({ when: event.target.value, timezone: 'Asia/Shanghai' })} /></label> : null}
        <label><input type="checkbox" checked={confirmExisting} onChange={event => setConfirmExisting(event.target.checked)} />{t('已核对平台已有内容，确认导出不会造成重复发布')}</label>
        <button type="button" className="md-btn" disabled={Boolean(busy) || dirty || item.sample || !draft.selectedVideo || !config} onClick={exportProject}>{t(busy === 'export' ? '正在生成工程' : '校验并导出麦田工程')}</button>
        {result ? <div role="status"><p>{t('工程已导出，解压后用原版插件打开')}</p><a className="md-btn" href={result.downloadPath} download>{t('下载麦田工程')}</a>{result.warnings.map((warning, index) => <p key={index}>{t('麦田组件提示')}：{warning}</p>)}</div> : null}
      </> : <p>{t('当前工程导出支持小红书和视频号单篇视频')}</p>}
      <MaitianPrepare item={item} draft={draft} assets={assets} platform={platform} config={config}
        preflight={browserResult?.op === 'preflight' ? browserResult.value : null} disabled={browserDisabled} busy={busy}
        locked={Boolean(publishing?.lockedPlatforms?.[platform])} statusKnown={Boolean(publishing?.known && !publishing.statusError)}
        perform={perform} request={request} refresh={publishing?.refresh || (async () => {})} />
    </div> : null}
  </section>
}
