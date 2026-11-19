// 设置：开放接入的生图模型和保存位置。
import React from 'react'
import { saveSettings, setDesk, testImage, useDesk } from './desk.js'
import { t, useLang } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'
import { openPublishSettings } from './publish-settings.jsx'

// 常见服务的 OpenAI 兼容地址，模型名以各家文档为准。label 是中文原文，显示时再翻译
const PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', size: '1536x1024', quality: 'medium', extra: '' },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', model: 'grok-2-image', size: '', quality: '', extra: '' },
  { id: 'ark', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', size: '1024x1024', quality: '', extra: '' },
  { id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4', size: '1024x1024', quality: '', extra: '' },
  { id: 'silicon', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: '', size: '', quality: '', extra: '{"image_size":"1024x1024"}' },
  { id: 'custom', label: '其他自定义', baseUrl: '', model: '', size: '1024x1024', quality: '', extra: '' },
]

// 中文和 English 各用自己的语言写，切错了也认得出来
const LANGUAGES = [
  { value: 'auto', label: () => t('跟随 DeepSeek Harness') },
  { value: 'zh', label: () => '中文' },
  { value: 'en', label: () => 'English' },
]

export function SettingsDialog() {
  useLang()
  const open = useDesk(s => s.settingsOpen)
  const settings = useDesk(s => s.settings)
  const publishingOpen = useDesk(s => s.publishSettingsOpen)
  const [form, setForm] = React.useState(null)
  const [testing, setTesting] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [sample, setSample] = React.useState(null)
  const [advanced, setAdvanced] = React.useState(false)
  const [tab, setTab] = React.useState('general')
  React.useEffect(() => { if (open) setTab('general') }, [open])
  const wasOpen = React.useRef(false)
  React.useEffect(() => {
    if (!open) { wasOpen.current = false; return }
    if (!settings || wasOpen.current) return
    wasOpen.current = true
    const { image } = settings
    setForm({ source: image.source ?? 'http', language: settings.language ?? 'auto', baseUrl: image.baseUrl ?? '', model: image.model ?? '', apiKey: '', size: image.size ?? '', quality: image.quality ?? '', toolSize: image.toolSize ?? '1536x1024', toolQuality: image.toolQuality ?? '', extra: image.extra ?? '', exportDir: settings.exportDir ?? '', documentDir: settings.documentDir ?? '', trashRetentionDays: settings.trashRetentionDays ?? 7, imageCount: settings.imageCount, shotCount: settings.shotCount })
    setSample(null)
  }, [open, settings])
  if (!open || !form || publishingOpen) return null
  const close = () => setDesk({ settingsOpen: false })
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const payload = () => ({
    language: form.language,
    documentDir: form.documentDir, trashRetentionDays: Number(form.trashRetentionDays),
    image: { source: form.source, baseUrl: form.baseUrl, model: form.model, apiKey: form.apiKey, size: form.size, quality: form.quality, toolSize: form.toolSize, toolQuality: form.toolQuality, extra: form.extra },
    exportDir: form.exportDir, imageCount: Number(form.imageCount), shotCount: Number(form.shotCount),
  })
  const activePreset = PRESETS.find(p => p.baseUrl && p.baseUrl === form.baseUrl)?.id ?? (form.baseUrl ? 'custom' : null)
  return (
    <Dialog title={t('设置')} onClose={close} width={520}>
      <form className="md-form" onSubmit={async (event) => {
        event.preventDefault()
        if (saving || testing) return
        setSaving(true)
        try { if (await saveSettings(payload())) close() }
        finally { setSaving(false) }
      }}>
        <fieldset disabled={saving || testing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
        <div className="md-capture-tabs" role="tablist" aria-label={t('设置分类')}>
          {[['general', '普通设置'], ['api', 'API 设置'], ['publishing', '发布账号']].map(([id, label]) => <button type="button" key={id} id={`md-settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`md-settings-panel-${id}`} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{t(label)}</button>)}
        </div>
        {tab === 'general' ? <section className="md-settings-panel" role="tabpanel" id="md-settings-panel-general" aria-labelledby="md-settings-tab-general">
        <div className="md-field">
          <span>{t('语言')}</span>
          <div className="md-presets" role="radiogroup" aria-label={t('语言')}>
            {LANGUAGES.map(option => (
              <button type="button" key={option.value} role="radio" aria-checked={form.language === option.value} className={form.language === option.value ? 'is-on' : ''} onClick={() => set('language', option.value)}>{option.label()}</button>
            ))}
          </div>
        </div>
        <label className="md-field">
          <span>{t('文档存储目录')}</span>
          <input required value={form.documentDir} onChange={e => set('documentDir', e.target.value)} placeholder="/Users/…/自媒体工作台" />
          <small>{t('填写完整目录路径。更换后自动迁移稿件、素材和回收站，旧目录保留为备份。')}</small>
        </label>
        <label className="md-field">
          <span>{t('回收站自动清理')}</span>
          <select value={form.trashRetentionDays} onChange={e => set('trashRetentionDays', e.target.value)}>
            {[1, 3, 7, 15].map(days => <option key={days} value={days}>{t('删除 {days} 天后彻底清理', { days })}</option>)}
          </select>
          <small>{t('按删除时间计算，到期后永久删除。工作台运行时每小时检查，关闭期间到期的内容会在下次启动时清理。')}</small>
        </label>
        <label className="md-field">
          <span>{t('成稿保存到')}</span>
          <input value={form.exportDir} onChange={e => set('exportDir', e.target.value)} placeholder={settings.defaultExportDir} />
        </label>

        <div className="md-field-row">
          <label className="md-field"><span>{t('配图数量')}</span><input type="number" min="0" max="4" value={form.imageCount} onChange={e => set('imageCount', e.target.value)} /></label>
          <label className="md-field"><span>{t('分镜格数')}</span><input type="number" min="0" max="12" value={form.shotCount} onChange={e => set('shotCount', e.target.value)} /></label>
        </div>
        </section> : tab === 'api' ? <section className="md-settings-panel" role="tabpanel" id="md-settings-panel-api" aria-labelledby="md-settings-tab-api">

        <div className="md-field">
          <span>{t('生图来源')}</span>
          <div className="md-presets" role="radiogroup" aria-label={t('生图来源')}>
            {[['http', '图片 API'], ['tool', 'DSH 生成工具']].map(([value, label]) => <button type="button" key={value} role="radio" aria-checked={form.source === value} className={form.source === value ? 'is-on' : ''} onClick={() => set('source', value)}>{t(label)}</button>)}
          </div>
          {form.source === 'tool' ? <>
            <small>{t(settings.imageToolAvailable ? '已检测到生图工具；账号登录和额度以试画结果为准。' : '未找到订阅生图工具，或默认执行器不支持直接调用；请检查插件和执行器后刷新工作台。')}</small>
            <small>{t('复用插件接入 DSH 的订阅生图能力。例如，插件已让你通过 ChatGPT（GPT）订阅在 DSH 中生成图片，工作台就可复用，无需另填图片 API Key。其他国内外服务的订阅也需由插件接入生图功能，并在工作台适配范围内；仅登录订阅或接入聊天模型并不代表支持生图。')}</small>
            <small>{t('当前适配 dsh-plugin-subscriptions。使用的服务、账号及回退规则由该插件决定，工作台不会自动切换到图片 API。')}</small>
            <small>{t('试画和生成图片会消耗订阅账号的生图额度。')}</small>
          </> : null}
        </div>
        {form.source === 'http' ? <>
        <div className="md-field">
          <span>{t('生图模型')}</span>
          <div className="md-presets">
            {PRESETS.map(preset => (
              <button type="button" key={preset.id} className={activePreset === preset.id ? 'is-on' : ''} onClick={() => setForm(f => ({ ...f, baseUrl: preset.baseUrl, model: preset.model, size: preset.size, quality: preset.quality, extra: preset.extra }))}>{t(preset.label)}</button>
            ))}
          </div>
          <small>{t('支持任何兼容 OpenAI 图片接口（/images/generations）的服务。')}</small>
        </div>
        <label className="md-field">
          <span>{t('接口地址')}</span>
          <input type="url" value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder="https://…/v1" />
        </label>
        <label className="md-field">
          <span>{t('模型')}</span>
          <input value={form.model} onChange={e => set('model', e.target.value)} placeholder={t('模型名称')} />
        </label>
        <label className="md-field">
          <span>{t('密钥')}{settings.image.hasKey ? t('（已保存，末四位 {hint}）', { hint: settings.image.keyHint }) : ''}</span>
          <input type="password" autoComplete="off" value={form.apiKey} onChange={e => set('apiKey', e.target.value)} placeholder={settings.image.hasKey ? t('留空表示不修改') : 'sk-…'} />
          <small>{t('只保存在这台电脑上，不会写进内容数据，也不会被打包或发给模型。')}</small>
        </label>
        </> : null}
        <button type="button" className="md-advanced" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Icon name={advanced ? 'chevD' : 'chevR'} size={12} />{t('高级')}</button>
        {advanced ? (
          <>
            {form.source === 'http' ? <div className="md-field-row">
              <label className="md-field"><span>{t('尺寸')}</span><input value={form.size} onChange={e => set('size', e.target.value)} placeholder="1536x1024" /></label>
              <label className="md-field"><span>{t('质量')}</span><input value={form.quality} onChange={e => set('quality', e.target.value)} placeholder="low / medium / high" /></label>
            </div> : <div className="md-field-row">
              <label className="md-field"><span>{t('尺寸')}</span><select value={form.toolSize} onChange={e => set('toolSize', e.target.value)}><option value="">{t('工具默认')}</option>{['1024x1024', '1024x1536', '1536x1024', 'auto'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
              <label className="md-field"><span>{t('质量')}</span><select value={form.toolQuality} onChange={e => set('toolQuality', e.target.value)}><option value="">{t('工具默认')}</option>{['low', 'medium', 'high', 'auto'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            </div>}
            {form.source === 'http' ? <label className="md-field">
              <span>{t('附加参数（JSON）')}</span>
              <input value={form.extra} onChange={e => set('extra', e.target.value)} placeholder='{"output_format":"jpeg"}' />
            </label> : null}
          </>
        ) : null}
        {sample ? <img className="md-test-sample" src={sample} alt={t('测试图')} /> : null}
        </section> : <section className="md-settings-panel md-settings-publishing" role="tabpanel" id="md-settings-panel-publishing" aria-labelledby="md-settings-tab-publishing">
          <div>
            <h3>{t('平台发布账号')}</h3>
            <p>{t('管理各平台的应用凭据和授权账号，查看获取步骤，并验证已保存的账号。')}</p>
          </div>
          <button type="button" className="md-btn" onClick={() => openPublishSettings()}>{t('配置发布账号')}</button>
          <small>{t('凭据保存在 Host 本地；保存配置不会发布内容。')}</small>
        </section>}
        <div className="md-form-foot">
          {tab === 'api' ? <button type="button" className="md-btn" disabled={testing} onClick={async () => {
            setTesting(true)
            setSample(null)
            setSample(await testImage({ image: payload().image }))
            setTesting(false)
          }}>{testing ? <span className="md-shimmer">{t('正在试画…')}</span> : t('试画一张')}</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={close}>{t('取消')}</button>
          {tab !== 'publishing' ? <button type="submit" className="md-btn is-primary">{t('保存')}</button> : null}
        </div>
        </fieldset>
        {saving ? <small role="status">{t('正在保存设置与迁移文件，请稍候…')}</small> : null}
      </form>
    </Dialog>
  )
}
