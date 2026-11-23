import { Select as SelectControl } from './select.jsx'
import React from 'react'
import { PUBLISH_PLATFORMS } from '../src/publish/capabilities.js'
import { PUBLISH_CONFIG_FIELDS, publishConfigPlatforms } from '../src/publish/config-schema.js'
import { setDesk, useDesk } from './desk.js'
import { lang, t, useLang } from './i18n.js'
import { Dialog } from './ui.jsx'
import { validatePublishConfigResponse } from './publish-config-response.js'
import { PUBLISH_CONFIG_GUIDES } from '../src/publish/config-guides.js'

export function openPublishSettings(platform) {
  setDesk({ publishSettingsOpen: true, publishSettingsPlatform: platform || 'bilibili' })
}

async function request(path, body) {
  let response, data
  try {
    response = await fetch(`media-desk/publish/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === 'test' ? 35_000 : 15_000),
    })
    data = await response.json()
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(t('读取发布配置超时，请检查 Host 连接后重试'))
    throw new Error(t('无法读取发布账号配置，请检查 Host 连接并重试'))
  }
  if (!response.ok) {
    if (path === 'config' && response.status === 405) throw new Error(t('本地发布配置接口不可用，请更新并重启 DSH Host 后重试。这不是平台凭据验证结果。'))
    throw new Error(data?.error || t('无法读取发布账号配置'))
  }
  if (path === 'config') {
    try { return validatePublishConfigResponse(data) }
    catch (error) { throw new Error(t(error.message)) }
  }
  return data
}

export function PublishSettingsDialog() {
  useLang()
  const open = useDesk(state => state.publishSettingsOpen)
  const initialPlatform = useDesk(state => state.publishSettingsPlatform)
  const [data, setData] = React.useState(null)
  const [platform, setPlatform] = React.useState('bilibili')
  const [drafts, setDrafts] = React.useState({})
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const sequence = React.useRef(0)
  const loadSequence = React.useRef(0)
  const load = React.useCallback(async () => {
    const current = ++loadSequence.current
    setLoading(true); setError('')
    try {
      const value = await request('config')
      if (current === loadSequence.current) setData(value)
    } catch (failure) {
      if (current === loadSequence.current) setError(failure.message)
    } finally {
      if (current === loadSequence.current) setLoading(false)
    }
  }, [])
  React.useEffect(() => {
    if (!open) { setDrafts({}); return }
    setDrafts({})
    setPlatform(Object.hasOwn(PUBLISH_CONFIG_FIELDS, initialPlatform) ? initialPlatform : 'bilibili')
    setData(null); setError(''); setNotice('')
    void load()
    return () => { loadSequence.current++; sequence.current++ }
  }, [open, initialPlatform, load])
  const row = data?.platforms?.[platform]
  const guide = PUBLISH_CONFIG_GUIDES[platform]
  const draft = drafts[platform] || {
    fields: row?.fields || {}, enabled: Boolean(row?.enabled),
    allowInsecureUpload: Boolean(row?.allowInsecureUpload), clearSecrets: [],
  }
  const { fields, enabled, allowInsecureUpload, clearSecrets } = draft
  const updateDraft = (key, value) => setDrafts(previous => {
    const current = previous[platform] || draft
    return { ...previous, [platform]: { ...current, [key]: typeof value === 'function' ? value(current[key]) : value } }
  })
  const setFields = value => updateDraft('fields', value)
  const setEnabled = value => updateDraft('enabled', value)
  const setAllowInsecureUpload = value => updateDraft('allowInsecureUpload', value)
  const setClearSecrets = value => updateDraft('clearSecrets', value)
  React.useEffect(() => { sequence.current++ }, [platform])
  if (!open) return null
  const close = () => { if (!busy) { setDrafts({}); setData(null); setDesk({ publishSettingsOpen: false }) } }
  const save = async () => {
    if (busy || !row) return
    setBusy('save'); setError(''); setNotice('')
    const current = sequence.current
    try {
      const result = await request('config', { platform, enabled, fields, allowInsecureUpload, clearSecrets })
      if (current === sequence.current) {
        setData(result)
        // Saving returns all platforms; discard only the saved platform's draft.
        setDrafts(previous => { const next = { ...previous }; delete next[platform]; return next })
        setNotice(t('发布账号已保存，立即生效'))
      }
    } catch (failure) { setError(failure.message) }
    finally { setBusy('') }
  }
  const test = async () => {
    if (busy) return
    setBusy('test'); setError(''); setNotice('')
    try {
      const result = await request('test', { platform })
      setNotice(`${t('已核对平台账号')}：${result.account}`)
    } catch (failure) { setError(failure.message) }
    finally { setBusy('') }
  }
  return <Dialog title={t('发布账号')} onClose={close} width={960} className="md-publish-settings">
    <div className="md-form md-publish-settings-shell">
      <div className="md-publish-settings-scroll">
      <p className="md-publish-intro">{t('配置各平台自有应用和授权账号。凭据仅保存在 Host 本地，不上传 AiToEarn；不提供自动 OAuth 授权。')}</p>
      <label className="md-field"><span>{t('平台')}</span><SelectControl disabled={Boolean(busy)} value={platform} onChange={event => { setPlatform(event.target.value); setNotice('') }}>{publishConfigPlatforms.map(key => <option key={key} value={key}>{t(PUBLISH_PLATFORMS[key].name)}</option>)}</SelectControl></label>
      <div className="md-publish-settings-grid">
      <details className="md-publish-guide" key={platform} open aria-label={t('如何获取配置')}>
        <summary><strong>{t('如何获取配置')} · {t(PUBLISH_PLATFORMS[platform].name)}</strong></summary>
        <div className="md-publish-guide-content"><ol>{guide.steps.map(step => <li key={step}>{t(step)}</li>)}</ol>
        <nav aria-label={t('官方获取入口')} className="md-presets">{guide.links.map(item => <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer" className="md-btn is-small">{t(item.label)} ↗</a>)}</nav>
        <p>{t(guide.warning)}</p>
        <small>{t('先到官方平台取得凭据，再回这里填写。链接在新窗口打开；菜单、权限及审核要求以官方当前页面为准。')}</small></div>
      </details>
      <div className="md-publish-credentials">
      {loading ? <p role="status">{t('正在读取配置…')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!row && !loading && !error ? <p role="alert">{t('发布配置接口返回不完整，请更新并重启 DSH Host 后重试')}</p> : null}
      {row ? <p>{t(row.configured ? '已配置，可验证账号' : '尚未启用或参数不完整')}</p> : null}
        <label className="md-publish-check"><span><input type="checkbox" disabled={Boolean(busy) || !row} checked={enabled} onChange={event => setEnabled(event.target.checked)} /> {t('启用此平台 API 投稿')}</span></label>
        {PUBLISH_CONFIG_FIELDS[platform].map(field => <label className="md-field" key={`${platform}:${field.key}`}>
          <span>{t(field.label)}{row?.secrets[field.key] ? ` · ${t('已保存')}` : ''}</span>
          <input disabled={Boolean(busy) || !row} type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={fields[field.key] || ''} placeholder={field.secret && row?.secrets[field.key] ? t('留空表示不修改') : ''} onChange={event => { setFields(previous => ({ ...previous, [field.key]: event.target.value })); setNotice('') }} />
          {guide.fields[field.key] || field.help ? <small>{t(guide.fields[field.key] || field.help)}</small> : null}
          {field.secret && row?.secrets[field.key] ? <span className="md-publish-check"><input type="checkbox" disabled={Boolean(busy)} checked={clearSecrets.includes(field.key)} onChange={event => setClearSecrets(previous => event.target.checked ? [...previous, field.key] : previous.filter(key => key !== field.key))} /> {t('清除此凭据（需保存）')}</span> : null}
        </label>)}
        {platform === 'kuaishou' ? <label className="md-publish-check"><span><input type="checkbox" disabled={Boolean(busy) || !row} checked={allowInsecureUpload} onChange={event => setAllowInsecureUpload(event.target.checked)} /> {t('我了解快手视频通过未加密 HTTP 上传，仅在可信网络启用')}</span></label> : null}
        <small>{t('保存不会发布内容；验证账号只读取已保存配置。令牌过期需更新，平台应用权限仍需自行申请。')}</small>
      {notice ? <p role="status">{notice}</p> : null}
      </div>
      </div>
      </div>
      <div className="md-dialog-actions md-publish-actions">
        <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={close}>{t('关闭')}</button>
        {!row ? <button type="button" className="md-btn" disabled={loading} onClick={load}>{t('重试')}</button> : null}
        <button type="button" className="md-btn" disabled={Boolean(busy) || !row?.configured} onClick={test}>{t(busy === 'test' ? '正在核对授权账号…' : '验证已保存账号')}</button>
        <button type="button" className="md-btn is-primary" disabled={Boolean(busy) || !row} onClick={save}>{t(busy === 'save' ? '正在保存…' : '保存账号配置')}</button>
      </div>
    </div>
  </Dialog>
}
