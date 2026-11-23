import React from 'react'
import { workURL } from '../src/publish/maitian/results.js'
import { Dialog } from './ui.jsx'
import { t } from './i18n.js'

const STATES = { published: '已在平台发布', pending_review: '平台处理中', scheduled: '已在平台确认定时', rejected: '平台拒绝' }
const TITLES = { query: '查询发布结果', associate: '人工关联作品', 'confirmed-not-submitted': '确认未提交', archive: '归档任务' }
const CHECKS = {
  query: [['confirmed', '我已在专用 Chrome 核对原任务账号'], ['identityLimitAcknowledged', '我理解登录预检不能验证账号身份']],
  associate: [['platformChecked', '我已在平台核对这条作品及其状态']],
  'confirmed-not-submitted': [['automationStopped', '我已确认自动执行流程停止'], ['platformChecked', '我已检查平台作品管理页，没有本次提交'], ['originalPageChecked', '我已检查原上传页面'], ['residualsCleared', '我已处理残留上传或草稿，可以重新准备']],
  archive: [['automationStopped', '我已确认自动执行流程停止'], ['pagesResolved', '我已核对并处理原页面与平台结果'], ['snapshotReleaseConfirmed', '我同意释放本机任务副本，保留防重记录']],
}
const safeURL = (platform, value) => { try { return workURL(platform, value) } catch { return null } }

export function MaitianTaskActions({ id, job, request, refresh }) {
  const [action, setAction] = React.useState(''), [fields, setFields] = React.useState({}), [checks, setChecks] = React.useState({})
  const [busy, setBusy] = React.useState(''), [error, setError] = React.useState('')
  const flight = React.useRef(false), generation = React.useRef(0)
  React.useEffect(() => {
    generation.current++
    setAction(''); setChecks({}); setFields({}); setError('')
    return () => { generation.current++ }
  }, [id, job.taskId, job.lastReview?.reviewId])
  const change = (key, value) => setFields(previous => ({ ...previous, [key]: value }))
  const open = value => {
    const candidate = job.lastReview?.result
    setError(''); setAction(value); setChecks({})
    setFields({ actor: '', reason: '', status: candidate?.normalizedStatus || job.association?.status || '',
      workId: candidate?.workId || job.association?.workId || '', url: candidate?.url || job.association?.url || '', actualWhen: '', actualTimezone: 'Asia/Shanghai' })
  }
  const perform = async (operation, body) => {
    if (flight.current) return
    const current = generation.current
    flight.current = true; setBusy(operation); setError('')
    try {
      await request(`maitian/${operation}`, { id, taskId: job.taskId, ...body })
      await refresh()
      if (current === generation.current) setAction('')
    } catch (error) { if (current === generation.current) setError(error.message) }
    finally { flight.current = false; setBusy('') }
  }
  const submit = () => {
    if (action === 'query') return perform('review', { account: { label: job.account, confirmed: checks.confirmed === true, identityLimitAcknowledged: checks.identityLimitAcknowledged === true } })
    const body = { action, actor: fields.actor, reason: fields.reason, confirmed: true, ...checks }
    if (action === 'associate') {
      body.evidence = { status: fields.status, workId: fields.workId || null, url: fields.url || null,
        ...(fields.actualWhen && { actualWhen: fields.actualWhen, actualTimezone: fields.actualTimezone }) }
      if (job.lastReview) body.reviewId = job.lastReview.reviewId
    }
    return perform('reconcile', body)
  }
  const allowed = action && CHECKS[action].every(([key]) => checks[key] === true) && (action === 'query' || Boolean(fields.actor?.trim() && fields.reason?.trim())) && (action !== 'associate' || Boolean(fields.status))
  const candidate = job.lastReview?.result, publishedURL = safeURL(job.platform, job.url), candidateURL = safeURL(job.platform, candidate?.url)
  return <div className="md-maitian-task-actions">
    {job.querying ? <p role="status">{t('正在查询麦田结果，原发布状态保持不变。')}</p> : null}
    {job.cancelRequested && job.executionActive ? <p role="status">{t('已请求停止；当前步骤可能继续，请等待执行器退出。')}</p> : null}
    {candidate ? <div className="md-publish-review">
      <strong>{t('麦田查询候选')}</strong><p>{candidate.status} · {job.lastReview.queriedAt}</p>
      {candidate.workId ? <p>{t('平台作品 ID')}：{candidate.workId}</p> : null}
      {candidate.candidateCount !== undefined ? <p>{t('上游返回的候选数量')}：{candidate.candidateCount}</p> : null}
      {candidate.time ? <p>{t('上游时间原文（含义与时区未核实）')}：{candidate.time}</p> : null}
      {candidate.note ? <p>{candidate.note}</p> : null}
      {candidate.rejectedFields?.length ? <p>{t('查询中的部分字段无法确认，请在平台人工核对。')}</p> : null}
      {job.lastReview.needsConfirmation ? <p>{t('候选可能对应旧作品，需在平台核对后人工关联。')}</p> : null}
      {candidateURL ? <a className="md-btn is-small" href={candidateURL} target="_blank" rel="noreferrer">{t('打开候选作品')}</a> : null}
    </div> : null}
    {job.association ? <p>{t('人工关联时的状态')} · {t(STATES[job.association.status])} · {job.association.actor} · {job.association.confirmedAt}</p> : null}
    {job.association?.actualScheduleAt ? <p>{t('平台实际预约时间')}：{job.association.actualScheduleAt} · {job.association.actualTimezone}</p> : null}
    {job.association?.scheduleMismatch ? <p role="status">{t('实际平台预约时间与原计划不同，请到平台核对。')}</p> : null}
    {job.archivedAt ? <p>{t('已归档；投稿防重记录继续保留。')}</p> : null}
    {job.resolved ? <p>{t('已确认未提交，可以重新准备；原任务不会重新执行。')}</p> : null}
    <div className="md-work-actions">
      {publishedURL ? <a className="md-btn is-small" href={publishedURL} target="_blank" rel="noreferrer">{t('查看作品')}</a> : null}
      {job.canLocatePage ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => void perform('open-page')}>{t('打开原发布页')}</button> : null}
      {job.canOpenManagement ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => void perform('open-management')}>{t('打开作品管理页')}</button> : null}
      {job.canReview ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => open('query')}>{t('查询发布结果')}</button> : null}
      {job.canCancel ? <button type="button" className="md-btn is-small" disabled={Boolean(busy) || job.cancelRequested} onClick={() => void perform('cancel')}>{t('请求停止填写')}</button> : null}
      {job.canAssociate ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => open('associate')}>{t('人工关联作品')}</button> : null}
      {job.canConfirmNotSubmitted ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => open('confirmed-not-submitted')}>{t('确认未提交')}</button> : null}
      {job.canArchive ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={() => open('archive')}>{t('归档任务')}</button> : null}
    </div>
    {error ? <p role="alert">{t(error)}</p> : null}
    {action ? <Dialog title={t(TITLES[action])} onClose={() => { if (!busy) setAction('') }} width={530}>
      <p>{job.title} · {job.account}</p>
      {action === 'query' ? <p>{t('此操作只调用原版结果查询。查询不到不代表没有提交，也不会解除防重。')}</p> : null}
      {action === 'archive' ? <p>{t('归档会释放本机任务副本，并继续保留投稿防重记录。')}</p> : null}
      {action !== 'query' ? <>
        <label className="md-field"><span>{t('核对操作者')}</span><input value={fields.actor || ''} maxLength={200} onChange={event => change('actor', event.target.value)} /></label>
        <label className="md-field"><span>{t('核对原因与证据')}</span><textarea value={fields.reason || ''} maxLength={2000} onChange={event => change('reason', event.target.value)} /></label>
      </> : null}
      {action === 'associate' ? <>
        <label className="md-field"><span>{t('平台实际状态')}</span><select value={fields.status} onChange={event => change('status', event.target.value)}><option value="">{t('请选择')}</option>{Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
        <label className="md-field"><span>{t('平台作品 ID（可选）')}</span><input value={fields.workId} maxLength={200} onChange={event => change('workId', event.target.value)} /></label>
        <label className="md-field"><span>{t('作品链接（可选）')}</span><input value={fields.url} maxLength={4096} onChange={event => change('url', event.target.value)} /></label>
        {fields.status === 'scheduled' ? <>
          <label className="md-field"><span>{t('平台实际预约时间（可选）')}</span><input type="datetime-local" value={fields.actualWhen} onChange={event => change('actualWhen', event.target.value)} /></label>
          <label className="md-field"><span>{t('实际预约时区')}</span><input value={fields.actualTimezone} maxLength={100} onChange={event => change('actualTimezone', event.target.value)} /></label>
        </> : null}
      </> : null}
      {CHECKS[action].map(([key, label]) => <label className="md-field" key={key}><span><input type="checkbox" checked={checks[key] === true} onChange={event => setChecks(previous => ({ ...previous, [key]: event.target.checked }))} /> {t(label)}</span></label>)}
      <div className="md-work-actions"><button type="button" className="md-btn" disabled={Boolean(busy)} onClick={() => setAction('')}>{t('返回')}</button><button type="button" className="md-btn is-primary" disabled={!allowed || Boolean(busy)} onClick={() => void submit()}>{t(busy ? '正在处理…' : action === 'query' ? '确认账号并查询' : '确认核对')}</button></div>
    </Dialog> : null}
  </div>
}
