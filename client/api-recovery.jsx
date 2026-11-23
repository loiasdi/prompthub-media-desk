import React from 'react'
import { Dialog } from './ui.jsx'
import { lang, t } from './i18n.js'

async function apiRequest(path, body) {
  const response = await fetch(`media-desk/publish/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() },
    ...(body !== undefined && { body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || t('暂时无法读取发布信息'))
  return value
}

export function ApiInterruptionOverview() {
  const [jobs, setJobs] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const flight = React.useRef(false), mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refresh = async () => {
    if (flight.current) return
    flight.current = true; setBusy(true); setError('')
    try {
      const value = await apiRequest('interrupted')
      if (!Array.isArray(value?.jobs)) throw new Error(t('投稿记录响应不完整，请更新并重启 Host'))
      if (mounted.current) setJobs(value.jobs)
    } catch (failure) { if (mounted.current) setError(failure.message) }
    finally { flight.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="md-api-recovery-overview">
    <button type="button" className="md-btn is-small" disabled={busy} onClick={() => void refresh()}>{t('检查升级前的 API 投稿')}</button>
    {error ? <p role="alert">{t(error)}</p> : null}
    {jobs ? <>
      <p>{t(jobs.length ? '以下旧 API 记录会阻止升级；请逐条核对，原结果和防重不会因本操作清除。' : '当前没有阻止升级的旧 API 执行记录。')}</p>
      {jobs.map(job => <article key={job.taskId}>
        <p>{job.title} · {job.account} · {job.platform} · {job.itemId}</p>
        {job.canRecoverInterrupted ? <ApiInterruptionRecovery id={job.itemId} job={job} request={apiRequest} refresh={refresh} /> : <p>{t('投稿仍在执行或缺少有效超时时间，请先停止旧 Host 并核对记录。')}</p>}
      </article>)}
    </> : null}
  </div>
}

export function ApiInterruptionRecovery({ id, job, request, refresh }) {
  const [open, setOpen] = React.useState(false), [actor, setActor] = React.useState(''), [reason, setReason] = React.useState('')
  const [checks, setChecks] = React.useState({}), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const flight = React.useRef(false), generation = React.useRef(0)
  React.useEffect(() => {
    generation.current++; setOpen(false); setActor(''); setReason(''); setChecks({}); setError('')
    return () => { generation.current++ }
  }, [id, job.taskId, job.recoveryRecordDigest])
  const allowed = actor.trim() && reason.trim() && checks.oldHostsStopped && checks.platformChecked
  const submit = async () => {
    if (flight.current || !allowed || !job.canRecoverInterrupted) return
    const current = generation.current
    flight.current = true; setBusy(true); setError('')
    try {
      await request('recover-interrupted', { id, taskId: job.taskId, recordDigest: job.recoveryRecordDigest, actor, reason,
        confirmed: true, oldHostsStopped: true, platformChecked: true })
      await refresh()
      if (generation.current === current) setOpen(false)
    } catch (failure) { if (generation.current === current) setError(failure.message) }
    finally { flight.current = false; setBusy(false) }
  }
  return <>
    {job.interruptionRecovery ? <p>{t('已记录旧 Host 停止核对；结果未知，防重继续保留。')} · {job.interruptionRecovery.actor} · {job.interruptionRecovery.at}</p> : null}
    {job.canRecoverInterrupted ? <button type="button" className="md-btn is-small" disabled={busy} onClick={() => { setChecks({}); setActor(''); setReason(''); setError(''); setOpen(true) }}>{t('核对中断的 API 投稿')}</button> : null}
    {open ? <Dialog title={t('核对中断的 API 投稿')} width={530} onClose={() => { if (!flight.current) setOpen(false) }}>
      <p>{job.title} · {job.account}</p>
      <p>{t('请先完全停止其他桌面版、网页版及旧版 Host 的发布进程，再到原账号的平台创作中心检查。超时不能证明进程已经停止。')}</p>
      <p>{t('确认后仅把旧投稿持久化为结果未知，保留回执和防重，并允许升级记录格式；不会重新上传、解除防重或认定投稿失败。')}</p>
      <label className="md-field"><span>{t('核对操作者')}</span><input value={actor} maxLength={200} disabled={busy} onChange={event => setActor(event.target.value)} /></label>
      <label className="md-field"><span>{t('核对原因与证据')}</span><textarea value={reason} maxLength={2000} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      {[
        ['oldHostsStopped', '我已确认其他 Host 和旧版发布进程完全停止'],
        ['platformChecked', '我已在原账号检查平台结果，理解本次仍保留结果未知和防重'],
      ].map(([key, label]) => <label className="md-api-recovery-check" key={key}><input type="checkbox" checked={checks[key] === true} disabled={busy} onChange={event => setChecks(previous => ({ ...previous, [key]: event.target.checked }))} /><span>{t(label)}</span></label>)}
      {error ? <p role="alert">{t(error)}</p> : null}
      <div className="md-work-actions"><button type="button" className="md-btn" disabled={busy} onClick={() => setOpen(false)}>{t('返回')}</button><button type="button" className="md-btn is-primary" disabled={!allowed || busy} onClick={() => void submit()}>{t(busy ? '正在处理…' : '确认停止并保留未知结果')}</button></div>
    </Dialog> : null}
  </>
}
