import React from 'react'
import { t } from './i18n.js'
import { MAITIAN_PLATFORMS } from '../src/publish/maitian/platforms.js'

export const publishMethod = publish => publish.mode === 'manual' ? 'manual' : publish.provider === 'maitian' ? 'maitian' : publish.mode === 'now' ? 'api' : 'manual'

export function PublishMethod({ id, publish, patch, channelFirst = false, apiPlatforms, defaultApiPlatform }) {
  const method = publishMethod(publish)
  const browserSupported = channelFirst
    ? publish.format === 'video'
    : MAITIAN_PLATFORMS.some(p => p.name === publish.platform) && publish.format === 'video'
  const choose = value => {
    const next = {
      provider: value === 'maitian' ? 'maitian' : 'api',
      mode: value === 'manual' ? 'manual' : value === 'maitian' && method === 'maitian' && publish.mode === 'scheduled' ? 'scheduled' : 'now',
    }
    if (value === 'api' && channelFirst && apiPlatforms && !apiPlatforms.includes(publish.platform) && defaultApiPlatform) {
      next.platform = defaultApiPlatform
    }
    patch(next)
  }
  const options = channelFirst
    ? [
        { id: 'maitian', name: '麦田工程打包', desc: '一包导出多平台，在原版麦田助手中填写' },
        { id: 'api', name: 'API 投稿', desc: '单平台核对信息后直接投稿' },
        { id: 'manual', name: '手动发布', desc: '复制文案，下载选定素材' },
      ]
    : [
        { id: 'manual', name: '手动发布', desc: '复制文案，下载选定素材' },
        { id: 'api', name: 'API 投稿', desc: '核对信息后确认投稿' },
        { id: 'maitian', name: '浏览器填写', desc: '调用原版麦田，最终发布由你确认' },
      ]
  return <section className="md-work-panel">
    <div className="md-work-panel-title"><h3>{t(channelFirst ? '选择发布渠道' : '发布方式')}</h3></div>
    <div className={`md-publish-modes ${channelFirst ? 'is-horizontal' : ''}`}>{options.map(option => <label key={option.id} className={`${method === option.id ? 'is-on' : ''} ${option.id === 'maitian' && !browserSupported ? 'is-disabled' : ''}`}>
      <input type="radio" name={`publish-method-${id}`} value={option.id} checked={method === option.id} disabled={option.id === 'maitian' && !browserSupported} onChange={() => choose(option.id)} />
      <div><strong>{t(option.name)}</strong><span>{t(option.desc)}</span></div>
    </label>)}</div>
    {!browserSupported ? <p className="md-publish-pending">{t(channelFirst ? '麦田工程打包目前仅支持视频，请返回「资料配齐」切回视频类型。' : '麦田工程支持 B站、小红书、抖音、视频号、YouTube、X、Instagram 单篇视频')}</p> : null}
    {publish.provider !== 'maitian' && publish.mode === 'scheduled' ? <p className="md-publish-pending">{t('原定时设置不会自动执行，请选择发布方式。')}</p> : null}
  </section>
}
