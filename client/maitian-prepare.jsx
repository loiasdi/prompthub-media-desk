import React from 'react'
import { t } from './i18n.js'
import { Dialog } from './ui.jsx'
import { flushWorkspace, formatBytes, prepareMaitianPublish } from './workspace.js'

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/
function validatePreparation(value, platform, label) {
  const p = value?.preparation
  if (!p || p.provider !== 'maitian' || p.status !== 'prepared' || p.platform !== platform || !ID.test(p.taskId) || !HASH.test(p.projectDigest) ||
      !Number.isFinite(p.expiresAt) || !/^[a-zA-Z0-9_-]{1,60}$/.test(p.profileId || '') || typeof p.engineVersion !== 'string' || !p.engineVersion ||
      !p.draft || !['now', 'scheduled'].includes(p.draft.mode) || typeof p.draft.title !== 'string' || typeof p.draft.description !== 'string' || typeof p.draft.tags !== 'string' ||
      p.draft.mode === 'scheduled' && (typeof p.draft.when !== 'string' || typeof p.draft.timezone !== 'string' || !Number.isFinite(Date.parse(p.draft.schedule))) ||
      p.account?.label !== label || p.account?.verification !== 'user-confirmed' || p.account?.identityLimitAcknowledged !== true || !Array.isArray(p.assets) || !p.assets.length || !Array.isArray(p.warnings) ||
      p.assets.some(row => typeof row.filename !== 'string' || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0 || !HASH.test(row.digest)) || p.warnings.some(row => typeof row !== 'string')) throw new Error(t('浏览器确认单响应不完整，请重新检查。'))
  return p
}

export function MaitianPrepare({ item, draft, assets, platform, config, preflight, disabled, busy, locked, statusKnown, perform, request, refresh }) {
  const [label, setLabel] = React.useState(''), [accountChecked, setAccountChecked] = React.useState(false), [identityChecked, setIdentityChecked] = React.useState(false)
  const [confirmation, setConfirmation] = React.useState(null), [consent, setConsent] = React.useState(false), [clock, setClock] = React.useState(Date.now())
  const latest = React.useRef(''), alive = React.useRef(true)
  const files = [draft.selectedVideo, ...Object.values(draft.publish.browser?.covers || {})].map(id => assets.find(asset => asset.id === id)).filter(Boolean)
  const signature = JSON.stringify([item.id, draft.publish, draft.selectedVideo, files.map(asset => [asset.id, asset.src, asset.bytes, asset.sha256, asset.name]), config, preflight?.operationId])
  const accountKey = JSON.stringify([signature, label.trim(), accountChecked, identityChecked])
  latest.current = accountKey
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  React.useEffect(() => { setAccountChecked(false); setIdentityChecked(false); setConfirmation(null); setConsent(false) }, [signature])
  React.useEffect(() => { setConfirmation(null); setConsent(false) }, [accountKey])
  React.useEffect(() => {
    if (!preflight && !confirmation) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [preflight, confirmation])
  const prepared = confirmation?.key === accountKey ? confirmation.data : null
  const checkedAt = Date.parse(preflight?.checkedAt)
  const freshLogin = preflight?.ok === true && preflight.platform === platform && Number.isFinite(checkedAt) && checkedAt <= clock + 30_000 && clock - checkedAt < 300_000
  const supported = Boolean(platform && draft.publish.format === 'video' && ['now', 'scheduled'].includes(draft.publish.mode))
  const canPrepare = !disabled && !locked && statusKnown && !item.sample && Boolean(draft.selectedVideo) && config?.enabled && config.implementation?.prepare === true && supported && freshLogin && label.trim() && accountChecked && identityChecked
  const close = () => { if (!disabled) { setConfirmation(null); setConsent(false) } }
  const prepare = () => {
    if (!canPrepare) return
    const key = accountKey
    return perform('prepare', async current => {
      setConfirmation(null); setConsent(false)
      const account = { label: label.trim(), confirmed: true, identityLimitAcknowledged: true, preflightOperationId: preflight.operationId }
      const value = await prepareMaitianPublish(item.id, platform, account)
      const result = validatePreparation(value, platform, account.label)
      if (alive.current && current() && latest.current === key) { setClock(Date.now()); setConfirmation({ key, data: result }) }
      await refresh()
    })
  }
  const expired = prepared && clock >= prepared.expiresAt
  const canStart = prepared && !expired && !disabled && !locked && statusKnown && consent && config?.implementation?.directFill === true
  const start = () => {
    if (!canStart) return
    const key = accountKey, plan = prepared
    return perform('start', async current => {
      try {
        await flushWorkspace(item.id)
        if (!alive.current || !current() || latest.current !== key || Date.now() >= plan.expiresAt) throw new Error(t('发布信息已变化或确认单已过期，请重新检查。'))
        await request('start', { id: item.id, taskId: plan.taskId, projectDigest: plan.projectDigest, confirmed: true })
      } finally {
        if (alive.current) { setConfirmation(null); setConsent(false) }
        await refresh()
      }
    })
  }
  if (draft.publish.provider !== 'maitian' || draft.publish.mode === 'manual') return null
  return <div className="md-maitian-prepare">
    <h4>{t('浏览器填写准备')}</h4>
    {config?.implementation?.directFill !== true ? <p role="status">{t('直接填写尚未通过真实平台验收，当前仅开放准备和导出。')}</p> : null}
    <p>{t('准备只固定文案和素材，不上传。确认开始后会上传到专用 Chrome，最终发布需由你在平台完成。')}</p>
    <p>{t('本项目当前成片上限为 250 MB，并非平台上限。')}</p>
    {!supported ? <p>{t('浏览器填写目前只接入小红书和视频号单篇视频。')}</p> : null}
    {locked ? <p role="status">{t('此平台已有投稿记录，请查看投稿记录。')}</p> : null}
    {!statusKnown ? <p role="status">{t('请先刷新投稿记录，确认当前防重状态。')}</p> : null}
    {!freshLogin ? <p>{t('请先检查平台登录；成功预检五分钟内有效，之后需重新预检并核对账号。')}</p> : null}
    <label className="md-field"><span>{t('目标账号标签（人工核对）')}</span><input value={label} maxLength={200} disabled={disabled} onChange={event => { setLabel(event.target.value); setAccountChecked(false); setIdentityChecked(false) }} /></label>
    <label><input type="checkbox" checked={accountChecked} disabled={disabled || !freshLogin} onChange={event => setAccountChecked(event.target.checked)} />{t('我已在专用 Chrome 核对本次目标账号')}</label>
    <label><input type="checkbox" checked={identityChecked} disabled={disabled || !freshLogin} onChange={event => setIdentityChecked(event.target.checked)} />{t('我理解登录预检不能验证账号身份')}</label>
    <button type="button" className="md-btn is-primary" disabled={!canPrepare} onClick={prepare}>{t(busy === 'prepare' ? '正在处理…' : '检查并准备浏览器填写')}</button>
    {prepared ? <Dialog title={t('确认浏览器填写')} onClose={close} width={650}>
      <div className="md-form">
        <p>{t('准备只固定文案和素材，不上传。确认开始后会上传到专用 Chrome，最终发布需由你在平台完成。')}</p>
        <p>{t('目标平台')}：{t(draft.publish.platform)} · {t('目标账号（用户确认）')}：{prepared.account.label}</p>
        <p>{t('浏览器资料')}：{prepared.profileId} · {t('组件版本')}：{prepared.engineVersion}</p>
        <dl style={{ overflowWrap: 'anywhere' }}><dt>{t('发布标题')}</dt><dd>{prepared.draft.title}</dd><dt>{t('发布正文')}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{prepared.draft.description}</dd><dt>{t('发布话题')}</dt><dd>{prepared.draft.tags}</dd></dl>
        {platform === 'channels' ? <p>{t('视频号短标题')}：{prepared.draft.shortTitle}</p> : null}
        {prepared.draft.mode === 'scheduled' ? <div><p>{t('计划预约时间')}：{prepared.draft.when} · {prepared.draft.timezone}</p><p>{t('预约对应 UTC')}：{prepared.draft.schedule}</p><p>{t('预约仅填写表单，仍需在平台确认提交。')}</p></div> : <p>{t('立即填写，等待你在平台发布。')}</p>}
        <ul>{prepared.assets.map(asset => <li key={asset.id} style={{ overflowWrap: 'anywhere' }}><span>{asset.filename} · {formatBytes(asset.sizeBytes)}{asset.ratio ? ` · ${asset.ratio}` : ''}</span><br /><code>SHA-256 {asset.digest}</code></li>)}</ul>
        {prepared.warnings.map((warning, index) => <p key={index}>{t('麦田组件提示')}：{warning}</p>)}
        {prepared.limits ? <p>{t('填写保护时限（分钟）')}：{prepared.limits.fillTimeoutMinutes}</p> : null}
        <p>{t('确认单有效至')}：{new Date(prepared.expiresAt).toISOString()}</p>
        {expired ? <p role="alert">{t('确认单已过期，请返回重新预检和准备。')}</p> : null}
        {config?.implementation?.directFill !== true ? <p>{t('直接填写尚未通过真实平台验收，当前仅开放准备和导出。')}</p> : null}
        <label><input type="checkbox" checked={consent} disabled={disabled || expired} onChange={event => setConsent(event.target.checked)} />{t('我已核对以上内容，确认开始上传和填写；最终发布由我在平台完成')}</label>
        <div className="md-work-actions"><button type="button" className="md-btn" disabled={disabled} onClick={close}>{t('返回修改')}</button><button type="button" className="md-btn is-primary" disabled={!canStart} onClick={start}>{t('确认并开始填写')}</button></div>
      </div>
    </Dialog> : null}
  </div>
}
