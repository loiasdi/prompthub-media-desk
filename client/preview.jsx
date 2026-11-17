// 独立开发预览：使用与 DSH 完全相同的页面组件，数据由本地预览服务提供。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Desk } from './index.jsx'
import { setDesk, useDesk } from './desk.js'
import { setLanguagePreference } from './i18n.js'

function Preview() {
  const ready = useDesk(s => Boolean(s.state))
  const started = React.useRef(false)
  React.useEffect(() => {
    if (!ready || started.current) return
    started.current = true
    const query = new URLSearchParams(location.search)
    const tab = query.get('tab')
    setDesk({ view: 'content', dockOpen: false, ...(tab ? { focusId: 'seed_1', studioTab: tab === 'script' ? 'prompts' : ['idea', 'outline', 'article', 'prompts', 'cover', 'assets', 'publish'].includes(tab) ? tab : 'assets' } : {}) })
  }, [ready])
  return <Desk />
}

const query = new URLSearchParams(location.search)
const en = query.get('lang') === 'en'
document.documentElement.lang = en ? 'en' : 'zh-CN'
setLanguagePreference(en ? 'en' : 'zh')
if (query.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
const previewWidth = Number(query.get('width'))
if (previewWidth >= 320 && previewWidth <= 1920) {
  Object.assign(document.getElementById('root').style, { width: `${previewWidth}px`, maxWidth: '100%', margin: '0 auto', position: 'relative' })
}
createRoot(document.getElementById('root')).render(<Preview />)
