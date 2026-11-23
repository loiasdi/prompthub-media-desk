import React from 'react'
import { t } from './i18n.js'

export const publishMethod = publish => publish.mode === 'manual' ? 'manual' : publish.provider === 'maitian' ? 'maitian' : publish.mode === 'now' ? 'api' : 'manual'

export function PublishMethod({ id, publish, patch }) {
  const method = publishMethod(publish)
  const browserSupported = ['小红书', '视频号'].includes(publish.platform) && publish.format === 'video'
  const choose = value => patch({ provider: value === 'maitian' ? 'maitian' : 'api', mode: value === 'manual' ? 'manual' : value === 'maitian' && method === 'maitian' && publish.mode === 'scheduled' ? 'scheduled' : 'now' })
  return <section className="md-work-panel">
    <div className="md-work-panel-title"><h3>{t('发布方式')}</h3></div>
    <div className="md-publish-modes">{[
      { id: 'manual', name: '手动发布', desc: '复制文案，下载选定素材' },
      { id: 'api', name: 'API 投稿', desc: '核对信息后确认投稿' },
      { id: 'maitian', name: '浏览器填写', desc: '调用原版麦田，最终发布由你确认' },
    ].map(option => <label key={option.id} className={method === option.id ? 'is-on' : ''}>
      <input type="radio" name={`publish-method-${id}`} value={option.id} checked={method === option.id} disabled={option.id === 'maitian' && !browserSupported} onChange={() => choose(option.id)} />
      <div><strong>{t(option.name)}</strong><span>{t(option.desc)}</span></div>
    </label>)}</div>
    {!browserSupported ? <p className="md-publish-pending">{t('浏览器填写目前只接入小红书和视频号单篇视频。')}</p> : null}
    {publish.provider !== 'maitian' && publish.mode === 'scheduled' ? <p className="md-publish-pending">{t('原定时设置不会自动执行，请选择发布方式。')}</p> : null}
  </section>
}
