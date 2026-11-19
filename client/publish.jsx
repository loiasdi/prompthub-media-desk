import React from 'react'
import { PUBLISH_PLATFORMS, publishUsesArticleImages, publishUsesCover } from '../src/publish/capabilities.js'
import { articleImageMarker, replaceArticleImages } from '../src/publish/article-images.js'
import { blueskyCaption, douyinCaption, facebookCaption, instagramCaption, kuaishouCaption, linkedInCaption, pinterestCaption, threadsCaption, tikTokCaption, xCaption } from '../src/publish/draft-copy.js'
import { THREADS_REPLY, TIKTOK_VISIBILITY } from '../src/publish/media-rules.js'
import { lang, t } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'
import { API_PLATFORMS, INITIAL_PUBLISH_FIELDS, publishAccountIssue, publishOptions, publishReadiness } from './publish-readiness.js'
import { flushWorkspace, formatBytes, prepareWorkspacePublish } from './workspace.js'

const STATUS = { publishing: '正在投稿', pending_review: '平台处理中', published: '投稿完成', failed: '投稿失败', rejected: '平台拒绝', unknown: '请到平台核对' }
const PRIVACY = { private: '私密', unlisted: '不公开列出', public: '公开' }
const DOUYIN_PRIVACY = { private: '仅自己可见', friends: '好友可见', public: '公开' }
const TIKTOK_PRIVACY = { ...DOUYIN_PRIVACY, followers: '关注者可见' }
const platformName = key => PUBLISH_PLATFORMS[key]?.name || '—'
const safeWorkLink = job => PUBLISH_PLATFORMS[job.platform]?.workUrl?.test(job.url || '')
const textConfirmation = {
  bluesky: '确认后，DSH Host 会将下列文字直接公开发布到 Bluesky。',
  kuaishou: '确认后，DSH Host 会将本地视频通过快手官方上传网关上传，并公开发布到快手。视频上传网关使用未加密 HTTP。',
  facebook: '确认后，DSH Host 会将下列文字直接发布到 Facebook 公共主页，不读取已选素材。',
  threads: '确认后，DSH Host 会将下列文字直接发布到 Threads。',
  linkedin: '确认后，DSH Host 会将下列文字直接发布到 LinkedIn，不读取已选素材。',
  x: '确认后，DSH Host 会将下列文字直接发布到 X，不读取已选素材。',
}
function confirmationIntro(platform, preparation) {
  if (platform === 'kuaishou') return '确认后，DSH Host 会把本地视频通过快手官方 HTTP 上传网关上传，并创建公开作品；该视频传输未加密。'
  if (platform === 'bluesky' && preparation.images?.length) return '确认后，DSH Host 会将下列文字与本地图片直传到 Bluesky。帖子将公开可见。'
  if (platform === 'facebook' && preparation.draft.destination === 'photo_story') return '确认后，DSH Host 会将一张本地图片上传到 Facebook，并发布为公共主页照片快拍；不发送标题、正文或话题。快拍展示期限由 Facebook 决定。'
  if (platform === 'facebook' && preparation.draft.destination === 'story') return '确认后，DSH Host 会将成片直传并发布为 Facebook 公共主页视频快拍，不发送标题、正文、话题或独立封面。快拍展示期限由 Facebook 决定。'
  if (platform === 'wechat') return preparation.images?.length ? '确认后，DSH Host 会将封面和正文配图直传微信，按标记位置生成文章并提交发表，不调用群发接口。' : '确认后，DSH Host 会上传封面到微信、创建草稿并提交发表，不调用群发接口。'
  if (!preparation.video && !preparation.images?.length && textConfirmation[platform]) return textConfirmation[platform]
  return '确认后，DSH Host 会将下列内容直接上传到平台。'
}

async function request(path, body) {
  const res = await fetch(`media-desk/publish/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || t('暂时无法读取发布信息'))
  return data
}

export function usePublishing(id, platformName, enabledMode) {
  const platform = Object.hasOwn(API_PLATFORMS, platformName) ? API_PLATFORMS[platformName] : undefined
  const [info, setInfo] = React.useState(null)
  const [remote, setRemote] = React.useState(null)
  const [statusError, setStatusError] = React.useState('')
  const [reloadKey, reload] = React.useReducer(n => n + 1, 0)
  const statusSequence = React.useRef(0)
  const refresh = React.useCallback(async () => {
    const sequence = ++statusSequence.current
    try {
      const data = await request(`status?id=${encodeURIComponent(id)}`)
      if (sequence === statusSequence.current) { setInfo(data); setStatusError('') }
    } catch (err) { if (sequence === statusSequence.current) setStatusError(err.message) }
  }, [id])
  React.useEffect(() => { void refresh() }, [refresh])
  const configured = Boolean(platform && info?.platforms?.[platform])
  const jobs = info?.jobs || []
  const polling = jobs.some(job => job.status === 'publishing')
  React.useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [polling, refresh])
  React.useEffect(() => {
    if (!configured || !enabledMode) return
    let current = true
    setRemote(null)
    request(`options?platform=${platform}`).then(data => { if (current) setRemote({ ...data, platform, reloadKey }) }, err => { if (current) setRemote({ platform, reloadKey, error: err.message }) })
    return () => { current = false }
  }, [configured, enabledMode, platform, reloadKey])
  const options = enabledMode && remote?.platform === platform && remote?.reloadKey === reloadKey ? remote : null
  return { platform, capabilities: PUBLISH_PLATFORMS[platform], configured, apiMode: enabledMode, known: Boolean(info), options, jobs, refresh, reload, statusError, locked: Boolean(info?.lockedPlatforms?.[platform]) }
}

function Select({ label, value, onChange, children }) {
  return <label className="md-field"><span>{t(label)}</span><select value={value} onChange={event => onChange(event.target.value)}>{children}</select></label>
}

export function PublishAccount({ publishing }) {
  const { configured, options, statusError } = publishing
  const detail = publishAccountIssue(publishing) || '已核对平台账号'
  return <div className="md-publish-account"><Icon name="user" size={18} /><div><strong>{options?.account || t(configured ? '已配置发布账号' : '发布账号')}</strong><span>{t(detail)}</span></div>{statusError ? <button type="button" className="md-btn is-small" onClick={publishing.refresh}>{t('刷新')}</button> : options?.error ? <button type="button" className="md-btn is-small" onClick={publishing.reload}>{t('重试')}</button> : options?.account ? <button type="button" className="md-btn is-small" onClick={publishing.reload}>{t('重新核对账号')}</button> : null}</div>
}

export function usePublishPreparation({ item, publishing, publish, video, cover, images }) {
  const { platform, options, refresh } = publishing
  const [savedFields, setFields] = React.useState({})
  const [confirmation, setConfirmation] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const inFlight = React.useRef(false)
  const storedFields = savedFields[platform] || INITIAL_PUBLISH_FIELDS
  const fields = platform === 'tiktok' && options?.constraints ? { ...storedFields, tiktokComment: storedFields.tiktokComment && !options.constraints.commentDisabled, tiktokDuet: storedFields.tiktokDuet && !options.constraints.duetDisabled, tiktokStitch: storedFields.tiktokStitch && !options.constraints.stitchDisabled } : storedFields
  const readiness = publishReadiness({ itemId: item.id, publish, video, cover, images, publishing, fields })
  const assetKey = asset => asset && [asset.id, asset.name, asset.src, asset.bytes, asset.sha256]
  const signature = JSON.stringify([item.id, publish, fields, options?.account, options?.constraints, readiness.canPrepare, publish.format === 'video' && assetKey(video), (publish.format === 'images' || publishUsesArticleImages(platform, publish.format)) && images.map(assetKey), publishUsesCover(platform, publish.format) && assetKey(cover)])
  const current = React.useRef(signature)
  current.current = signature
  const preparation = confirmation?.signature === signature ? confirmation.data : null
  React.useEffect(() => {
    if (confirmation && !preparation) {
      setConfirmation(null)
      setError(t('发布信息已变化，请重新检查。'))
    }
  }, [confirmation, preparation])
  const set = (key, value) => {
    setError('')
    setFields(previous => ({ ...previous, [platform]: { ...(previous[platform] || INITIAL_PUBLISH_FIELDS), [key]: value } }))
  }
  const close = () => { if (!inFlight.current) setConfirmation(null) }
  const prepare = async () => {
    if (inFlight.current || !readiness.canPrepare) return
    inFlight.current = true
    setBusy('prepare'); setError('')
    try {
      const result = await prepareWorkspacePublish(item.id, platform, publishOptions(platform, fields, publish.format))
      if (current.current === signature) setConfirmation({ signature, data: result.preparation })
      else setError(t('发布信息已变化，请重新检查。'))
    } catch (err) { setError(err.message); void refresh() }
    finally { inFlight.current = false; setBusy('') }
  }
  const submit = async () => {
    if (inFlight.current || !preparation) return
    inFlight.current = true
    setBusy('submit'); setError('')
    try {
      await flushWorkspace(item.id)
      if (current.current !== signature) throw new Error(t('发布信息已变化，请重新检查。'))
      await request('start', { id: item.id, taskId: preparation.taskId, confirmed: true })
    } catch (err) { setError(err.message) }
    finally { setConfirmation(null); await refresh(); inFlight.current = false; setBusy('') }
  }
  return { ...readiness, format: publish.format, fields, set, preparation, busy, error, close, prepare, submit }
}

const CAPTION_OVERRIDES = { bluesky: blueskyCaption, douyin: douyinCaption, facebook: facebookCaption, instagram: instagramCaption, kuaishou: kuaishouCaption, linkedin: linkedInCaption, pinterest: pinterestCaption, threads: threadsCaption, tiktok: tikTokCaption, x: xCaption }

export function ArticleImagePicker({ assets, onInsert }) {
  return <section className="md-work-panel md-publish-article-images">
    <div className="md-work-panel-title"><h3>{t('正文配图')}</h3><span>{t('可选')}</span></div>
    <label className="md-field"><span>{t('插入正文配图')}</span><select value="" onChange={event => { if (event.target.value) onInsert(articleImageMarker(event.target.value)) }}>
      <option value="">{t('选择图片并插入标记')}</option>{assets.filter(asset => asset.type === 'image').map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
    </select></label>
    <p className="md-publish-pending">{t('标记插入正文末尾，可移动到需要的位置；只上传标记引用的本地 JPEG/PNG，每张小于 1 MB，最多 20 张不同配图。同一张图可重复引用，不会重复上传。')}</p>
  </section>
}

function YesNo({ label, value, onChange }) {
  return <Select label={label} value={value} onChange={onChange}><option value="">{t('请选择')}</option><option value="no">{t('否')}</option><option value="yes">{t('是')}</option></Select>
}

function Toggle({ label, value, disabled, onChange }) {
  return <label className="md-field"><span><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => onChange(event.target.checked)} /> {t(label)}</span></label>
}

function TikTokConsent({ branded }) {
  return <p className="md-publish-pending">{t('发布即表示同意 TikTok 的')} <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">{t('音乐使用确认')}</a>{branded ? <> {t('以及')} <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">{t('品牌内容政策')}</a></> : null}。</p>
}

export function PublishControls({ publishing, flow }) {
  const { platform, capabilities, configured, options } = publishing
  const { fields, set, preparation, busy, close, submit } = flow
  const facebookStory = platform === 'facebook' && ['story', 'photo_story'].includes(preparation?.draft.destination)
  const formatCaption = facebookStory ? null : CAPTION_OVERRIDES[platform]
  const captionOnly = !facebookStory && (['bluesky', 'instagram', 'douyin', 'kuaishou', 'linkedin', 'x', 'tiktok', 'threads'].includes(platform) || (platform === 'facebook' && ['text', 'images'].includes(preparation?.draft.format)))
  return <>
    {configured ? <section className="md-work-panel md-publish-settings">
      <div className="md-work-panel-title"><h3>{t('投稿参数')}</h3></div>
      {capabilities.category ? <Select label={capabilities.categoryLabel || '发布分区'} value={fields.categoryId} onChange={value => set('categoryId', value)}><option value="">{t(platform === 'pinterest' ? '请选择画板' : '请选择分区')}</option>{options?.categories?.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</Select> : null}
      {platform === 'bilibili' ? <>
        <Select label="稿件类型" value={fields.copyright} onChange={value => set('copyright', value)}><option value="">{t('请选择稿件类型')}</option><option value="1">{t('原创')}</option><option value="2">{t('转载')}</option></Select>
        {fields.copyright === '2' ? <label className="md-field"><span>{t('转载来源')}</span><input value={fields.source} maxLength={500} onChange={event => set('source', event.target.value)} /></label> : null}
      </> : platform === 'youtube' ? <>
        <Select label="可见性" value={fields.privacyStatus} onChange={value => set('privacyStatus', value)}>{Object.entries(PRIVACY).map(([key, value]) => <option key={key} value={key}>{t(value)}</option>)}</Select>
        <Select label="是否面向儿童" value={fields.kids} onChange={value => set('kids', value)}><option value="">{t('请声明受众')}</option><option value="no">{t('否')}</option><option value="yes">{t('是')}</option></Select>
        <Select label="包含需声明的合成内容" value={fields.synthetic} onChange={value => set('synthetic', value)}><option value="">{t('未填写')}</option><option value="no">{t('否')}</option><option value="yes">{t('是')}</option></Select>
        <p className="md-publish-pending">{t('YouTube 可选本地 JPEG/PNG 缩略图（不超过 50 MB），视频处理完成后设置；公开视频可能先可见。此入口不通知订阅者。')}</p>
      </> : platform === 'facebook' ? <>
        {flow.format === 'video' ? <Select label="视频发布位置" value={fields.facebookDestination} onChange={value => set('facebookDestination', value)}><option value="reels">Reels</option><option value="story" disabled={options?.constraints?.storySupported !== true}>{t('视频快拍（Story）')}</option></Select> : flow.format === 'images' ? <Select label="图片发布位置" value={fields.facebookImageDestination} onChange={value => set('facebookImageDestination', value)}><option value="feed">普通动态</option><option value="photo_story" disabled={options?.constraints?.storySupported !== true}>{t('照片快拍（Story）')}</option></Select> : null}
        <Select label="可见性" value={fields.facebookAudience} onChange={value => set('facebookAudience', value)}><option value="">{t('请确认公开发布')}</option><option value="public">{t('公开')}</option></Select>
        <YesNo label="是否使用 AI 生成或编辑" value={fields.facebookAi} onChange={value => set('facebookAi', value)} />
        <p className="md-publish-pending">{t(flow.format === 'text' ? 'Facebook 纯文字动态公开发布，标题和话题会并入正文。' : flow.format === 'images' && fields.facebookImageDestination === 'photo_story' ? '照片快拍只发布 1 张 JPEG/PNG，不发送标题、正文、话题或封面；AI 照片请用官方发布器完成声明。' : ['text', 'images'].includes(flow.format) ? 'Facebook 动态支持纯文字或 1 至 10 张本地 JPEG/PNG，每张不超过 10 MB。标题和话题会并入正文，不上传独立封面；AI 动态需 Host 使用 Graph v27.0。' : fields.facebookDestination === 'story' ? 'Facebook 视频快拍公开发布，只发送 3–60 秒的本地 MP4；标题、正文和话题仅供本地记录，文字需制作在视频中，不发送独立封面。' : 'Facebook Reels 会公开发布到此公共主页，任何人都能观看和分享。此入口不上传自定义封面。')}</p>
        {['video', 'images'].includes(flow.format) && options?.constraints?.storySupported === false ? <p className="md-publish-pending">{t('Facebook 快拍需要在 Host 将 Graph API 版本设为 v27.0 并重新核对账号；旧版本请使用普通动态/Reels 或官方发布器。')}</p> : null}
      </> : platform === 'instagram' ? <>
        <YesNo label="分享到 Instagram 动态" value={fields.instagramShare} onChange={value => set('instagramShare', value)} />
        <YesNo label="是否使用 AI 生成或编辑" value={fields.instagramAi} onChange={value => set('instagramAi', value)} />
        <p className="md-publish-pending">{t('不分享到动态的 Reel 仍会发布到 Reels，不是私密草稿。标题和话题并入说明，不上传独立封面。')}</p>
      </> : platform === 'wechat' ? <>
        <Select label="可见性" value={fields.wechatAudience} onChange={value => set('wechatAudience', value)}><option value="">{t('请确认公开发表')}</option><option value="public">{t('公开发表（不调用群发接口）')}</option></Select>
        <label className="md-field"><span>{t('文章作者（可选）')}</span><input value={fields.wechatAuthor} onChange={event => set('wechatAuthor', event.target.value)} /></label>
        <label className="md-field"><span>{t('文章摘要（可选）')}</span><textarea rows={2} value={fields.wechatDigest} onChange={event => set('wechatDigest', event.target.value)} /></label>
        <YesNo label="允许评论" value={fields.wechatComment} onChange={value => set('wechatComment', value)} />
        {fields.wechatComment === 'yes' ? <YesNo label="仅粉丝可评论" value={fields.wechatFansComment} onChange={value => set('wechatFansComment', value)} /> : null}
        <YesNo label="是否需要原生 AI 标识或原创声明" value={fields.wechatDeclaration} onChange={value => set('wechatDeclaration', value)} />
        {fields.wechatDeclaration === 'yes' ? <a className="md-btn is-small" href={capabilities.studio} target="_blank" rel="noreferrer">{t('打开微信公众平台')}</a> : null}
        <p className="md-publish-pending">{t('此入口发表单篇文章＋必选封面，正文按段落安全转换，不执行 HTML；仅发送标记引用的正文配图。需要原生声明请改用公众平台。')}</p>
      </> : platform === 'bluesky' ? <>
        <Select label="可见性" value={fields.blueskyAudience} onChange={value => set('blueskyAudience', value)}><option value="">{t('请确认公开发布')}</option><option value="public">{t('公开')}</option></Select>
        <p className="md-publish-pending">{t('Bluesky 此入口只支持公开纯文字或 1 至 4 张本地 JPEG/PNG 图片，每张不超过 2 MB；不支持视频或独立封面。需要 AI 说明时，请写入正文。')}</p>
      </> : platform === 'kuaishou' ? <>
        <Select label="可见性" value={fields.kuaishouAudience} onChange={value => set('kuaishouAudience', value)}><option value="">{t('请确认公开发布')}</option><option value="public">{t('公开')}</option></Select>
        <Select label="是否需要快手原生 AI 标识" value={fields.kuaishouAi} onChange={value => set('kuaishouAi', value)}><option value="">{t('请选择')}</option><option value="no">{t('不需要')}</option><option value="yes">{t('需要')}</option></Select>
        <p className="md-publish-pending">{t('快手 API 仅支持视频并要求封面。官方视频上传网关使用未加密 HTTP；仅在可信网络并显式启用 Host 开关后使用。')}</p>
      </> : platform === 'threads' ? <>
        <Select label="可见性" value={fields.threadsAudience} onChange={value => set('threadsAudience', value)}><option value="">{t('请选择')}</option><option value="account">{t('遵循 Threads 账号当前隐私设置')}</option></Select>
        <Select label="回复范围" value={fields.threadsReply} onChange={value => set('threadsReply', value)}><option value="">{t('请选择')}</option>{Object.entries(THREADS_REPLY).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</Select>
        <YesNo label="是否使用 AI 生成或编辑" value={fields.threadsAi} onChange={value => set('threadsAi', value)} />
        <p className="md-publish-pending">{t('Threads 此入口只发纯文字，不读取选中的素材。标题与正文合并，最多一个原生话题；API 不修改账号隐私。图片和视频请手动发布。')}</p>
      </> : platform === 'tiktok' ? <>
        <Select label="可见性" value={fields.tiktokPrivacy} onChange={value => set('tiktokPrivacy', value)}><option value="">{t('请选择')}</option>{Object.entries(TIKTOK_VISIBILITY).filter(([, value]) => options?.constraints?.privacyLevels?.includes(value)).map(([key]) => <option key={key} value={key} disabled={key === 'private' && fields.tiktokCommercial && fields.tiktokBranded}>{t(TIKTOK_PRIVACY[key])}</option>)}</Select>
        <Select label="确认原创投稿" value={fields.tiktokOriginal} onChange={value => set('tiktokOriginal', value)}><option value="">{t('请选择')}</option><option value="yes">{t('确认原创')}</option></Select>
        <YesNo label="是否使用 AI 生成或编辑" value={fields.tiktokAi} onChange={value => set('tiktokAi', value)} />
        {[[ '允许评论', 'tiktokComment', 'commentDisabled' ], [ '允许合拍', 'tiktokDuet', 'duetDisabled' ], [ '允许拼接', 'tiktokStitch', 'stitchDisabled' ]].map(([label, field, disabled]) => <Toggle key={field} label={label} value={fields[field]} disabled={!options?.constraints || options.constraints[disabled]} onChange={value => set(field, value)} />)}
        <p className="md-publish-pending">{t('互动默认关闭；灰色选项已被账号权限禁用。当前最长视频：')} {options?.constraints?.maxDuration || '—'} {t('秒')}</p>
        <Toggle label="商业内容声明" value={fields.tiktokCommercial} onChange={value => set('tiktokCommercial', value)} />
        {fields.tiktokCommercial ? <>
          <Toggle label="推广自己的品牌" value={fields.tiktokOwnBrand} onChange={value => set('tiktokOwnBrand', value)} />
          <Toggle label="推广第三方品牌（付费合作）" value={fields.tiktokBranded} disabled={fields.tiktokPrivacy === 'private'} onChange={value => set('tiktokBranded', value)} />
          <p className="md-publish-pending">{t(fields.tiktokBranded ? '视频将标记为付费合作，不能设为仅自己可见。' : fields.tiktokOwnBrand ? '视频将标记为推广内容。' : '请选择推广自己的品牌、第三方品牌或两者。')}</p>
        </> : null}
        <TikTokConsent branded={fields.tiktokCommercial && fields.tiktokBranded} />
        <Toggle label="同意音乐使用确认" value={fields.tiktokMusicConsent} onChange={value => set('tiktokMusicConsent', value)} />
        {fields.tiktokCommercial && fields.tiktokBranded ? <Toggle label="同意品牌内容政策" value={fields.tiktokBrandedConsent} onChange={value => set('tiktokBrandedConsent', value)} /> : null}
        <p className="md-publish-pending">{t('TikTok 上传后可能需要几分钟处理。未审核应用只能测试私密发布；私人或团队内部上传工具不属于官方允许的应用用途。')}</p>
      </> : platform === 'pinterest' ? <>
        <Select label="可见性" value={fields.pinterestAudience} onChange={value => set('pinterestAudience', value)}><option value="">{t('请确认公开发布')}</option><option value="public">{t('公开')}</option></Select>
        <Select label="确认原创投稿" value={fields.pinterestOriginal} onChange={value => set('pinterestOriginal', value)}><option value="">{t('请选择')}</option><option value="yes">{t('确认原创')}</option></Select>
        <YesNo label="是否使用 AI 生成或编辑" value={fields.pinterestAi} onChange={value => set('pinterestAi', value)} />
        <YesNo label="是否包含合成表演者" value={fields.pinterestPerformer} onChange={value => set('pinterestPerformer', value)} />
        <p className="md-publish-pending">{t('Pinterest 会公开发布原创视频或图文 Pin 到自己的画板。图文按选择顺序发送 1 至 5 张本地 JPEG/PNG，不发送独立封面；视频未选封面时使用首帧。')}</p>
      </> : platform === 'x' ? <>
        <Select label="可见性" value={fields.xAudience} onChange={value => set('xAudience', value)}><option value="">{t('请确认公开发布')}</option><option value="public">{t('公开')}</option></Select>
        <YesNo label="是否使用 AI 生成或编辑" value={fields.xAi} onChange={value => set('xAi', value)} />
        <YesNo label="是否为付费商业合作" value={fields.xPaid} onChange={value => set('xPaid', value)} />
        <p className="md-publish-pending">{t('X 会公开发布视频、纯文字或 1 至 4 张本地 JPEG/PNG，每张不超过 5 MB。标题和话题并入正文，按 280 加权字符校验，不上传独立封面。')}</p>
      </> : platform === 'linkedin' ? <>
        <Select label="可见性" value={fields.linkedinAudience} onChange={value => set('linkedinAudience', value)}><option value="">{t('请确认公开发布')}</option><option value="public">{t('公开')}</option></Select>
        <p className="md-publish-pending">{t('LinkedIn 会公开发布到此个人账号的动态，支持视频、纯文字或 1 至 20 张本地 JPEG/PNG。标题和话题并入说明，不上传独立封面。图文收到回执后仍需核对处理结果。')}</p>
      </> : platform === 'douyin' ? <>
        <Select label="可见性" value={fields.douyinPrivacy} onChange={value => set('douyinPrivacy', value)}><option value="">{t('请选择')}</option>{Object.entries(DOUYIN_PRIVACY).map(([key, value]) => <option key={key} value={key}>{t(value)}</option>)}</Select>
        <Select label="确认原创投稿" value={fields.douyinOriginal} onChange={value => set('douyinOriginal', value)}><option value="">{t('请选择')}</option><option value="yes">{t('确认原创')}</option></Select>
        <YesNo label="允许下载" value={fields.douyinDownload} onChange={value => set('douyinDownload', value)} />
        <YesNo label="是否需要 AI 标识" value={fields.douyinAi} onChange={value => set('douyinAi', value)} />
        {fields.douyinAi === 'yes' ? <a className="md-btn is-small" href={capabilities.studio} target="_blank" rel="noreferrer">{t('打开平台创作中心')}</a> : null}
        <p className="md-publish-pending">{t('标题和话题会并入抖音发布说明。投稿后由抖音审核，审核期间仅自己可见。')}</p>
      </> : null}
    </section> : null}
    {preparation ? <Dialog title={t('确认投稿')} onClose={close} width={530}>
      <div className="md-publish-confirm">
        <p>{t(confirmationIntro(platform, preparation))}</p>
        {platform === 'youtube' && preparation.cover ? <p>{t('YouTube 可选本地 JPEG/PNG 缩略图（不超过 50 MB），视频处理完成后设置；公开视频可能先可见。此入口不通知订阅者。')}</p> : null}
        <dl>
          <dt>{t('发布账号')}</dt><dd>{preparation.account.name} · {t(platformName(platform))}</dd>
          {capabilities.category ? <><dt>{t(capabilities.categoryLabel || '发布分区')}</dt><dd>{preparation.categoryTitle}</dd></> : null}
          {!captionOnly ? <><dt>{t(facebookStory ? '本地记录标题（不发送）' : '发布标题')}</dt><dd>{preparation.draft.title}</dd></> : null}
          <dt>{t(captionOnly || facebookStory ? '实际发布说明' : '发布正文')}</dt><dd>{facebookStory ? t(preparation.draft.destination === 'photo_story' ? '不发送文字说明。' : '不发送文字说明，文字需制作在视频中。') : (formatCaption ? formatCaption(preparation.draft) : platform === 'wechat' ? replaceArticleImages(preparation.draft.description, id => `【${preparation.images?.find(image => image.id === id)?.filename || id}】`) : preparation.draft.description) || '—'}</dd>
          {(!formatCaption && !facebookStory) || platform === 'threads' ? <><dt>{t(platform === 'threads' ? '原生话题' : '发布话题')}</dt><dd>{preparation.draft.topics.join(' · ') || '—'}</dd></> : null}
          {preparation.video ? <><dt>{t('发布视频')}</dt><dd>{preparation.video.filename} · {formatBytes(preparation.video.sizeBytes)}</dd></> : preparation.images?.length ? <><dt>{t('发布类型')}</dt><dd>{t(platform === 'wechat' ? '文章' : '图文')}</dd><dt>{t(platform === 'wechat' ? '正文配图' : '发布图片（按选择顺序）')}</dt><dd><ol>{preparation.images.map(image => <li key={image.id}>{image.filename} · {formatBytes(image.sizeBytes)}</li>)}</ol></dd></> : <><dt>{t('发布类型')}</dt><dd>{t(platform === 'wechat' ? '文章' : '纯文字')}</dd></>}
          {platform !== 'threads' && preparation.draft.format !== 'text' && (!preparation.images?.length || platform === 'wechat') ? <><dt>{t('发布封面')}</dt><dd>{preparation.cover?.filename || t(['pinterest', 'tiktok'].includes(platform) ? '视频首帧' : '不上传')}</dd></> : null}
          {platform === 'bilibili' ? <><dt>{t('稿件类型')}</dt><dd>{t(preparation.draft.copyright === 1 ? '原创' : '转载')}{preparation.draft.source ? ` · ${preparation.draft.source}` : ''}</dd></> : platform === 'youtube' ? <>
            <dt>{t('可见性')}</dt><dd>{t(PRIVACY[preparation.draft.privacyStatus])}</dd>
            <dt>{t('是否面向儿童')}</dt><dd>{t(preparation.draft.selfDeclaredMadeForKids ? '是' : '否')}</dd>
            <dt>{t('包含需声明的合成内容')}</dt><dd>{t(preparation.draft.containsSyntheticMedia === undefined ? '未填写' : preparation.draft.containsSyntheticMedia ? '是' : '否')}</dd>
          </> : platform === 'facebook' ? <>
            {preparation.video ? <><dt>{t('视频发布位置')}</dt><dd>{facebookStory ? t('视频快拍（Story）') : 'Reels'}</dd></> : preparation.draft.destination === 'photo_story' ? <><dt>{t('图片发布位置')}</dt><dd>{t('照片快拍（Story）')}</dd></> : null}
            <dt>{t('可见性')}</dt><dd><strong>{t('公开 · 任何人都能观看和分享')}</strong></dd>
            <dt>{t('是否使用 AI 生成或编辑')}</dt><dd>{t(preparation.draft.isAiGenerated ? '是' : '否')}</dd>
          </> : platform === 'instagram' ? <>
            <dt>{t('分享到 Instagram 动态')}</dt><dd>{t(preparation.draft.shareToFeed ? 'Reels 和动态' : '仅 Reels，不是私密')}</dd>
            <dt>{t('是否使用 AI 生成或编辑')}</dt><dd>{t(preparation.draft.isAiGenerated ? '是' : '否')}</dd>
          </> : platform === 'wechat' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t('公开发表（不调用群发接口）')}</strong></dd>
            <dt>{t('文章作者（可选）')}</dt><dd>{preparation.draft.author || '—'}</dd>
            <dt>{t('文章摘要（可选）')}</dt><dd>{preparation.draft.digest || t('由微信从正文提取')}</dd>
            <dt>{t('允许评论')}</dt><dd>{t(preparation.draft.allowComment ? '是' : '否')}</dd>
            {preparation.draft.allowComment ? <><dt>{t('仅粉丝可评论')}</dt><dd>{t(preparation.draft.onlyFansComment ? '是' : '否')}</dd></> : null}
            <dt>{t('是否需要原生 AI 标识或原创声明')}</dt><dd>{t('否')}</dd>
          </> : platform === 'bluesky' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t('公开')}</strong></dd>
          </> : platform === 'threads' ? <>
            <dt>{t('可见性')}</dt><dd>{t('遵循 Threads 账号当前隐私设置')}</dd>
            <dt>{t('回复范围')}</dt><dd>{t(THREADS_REPLY[preparation.draft.replyControl])}</dd>
            <dt>{t('是否使用 AI 生成或编辑')}</dt><dd>{t(preparation.draft.isAiGenerated ? '是' : '否')}</dd>
          </> : platform === 'tiktok' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t(TIKTOK_PRIVACY[preparation.draft.privacyStatus])}</strong></dd>
            <dt>{t('稿件类型')}</dt><dd>{t('原创')}</dd>
            <dt>{t('是否使用 AI 生成或编辑')}</dt><dd>{t(preparation.draft.isAiGenerated ? '是' : '否')}</dd>
            {[[ '允许评论', 'allowComment' ], [ '允许合拍', 'allowDuet' ], [ '允许拼接', 'allowStitch' ], [ '商业内容声明', 'commercialContent' ], [ '推广自己的品牌', 'ownBrand' ], [ '推广第三方品牌（付费合作）', 'brandedContent' ]].map(([label, key]) => <React.Fragment key={key}><dt>{t(label)}</dt><dd>{t(preparation.draft[key] ? '是' : '否')}</dd></React.Fragment>)}
          </> : platform === 'pinterest' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t('公开')}</strong></dd>
            <dt>{t('稿件类型')}</dt><dd>{t('原创')}</dd>
            <dt>{t('是否使用 AI 生成或编辑')}</dt><dd>{t(preparation.draft.isAiGenerated ? '是' : '否')}</dd>
            <dt>{t('是否包含合成表演者')}</dt><dd>{t(preparation.draft.syntheticPerformer ? '是' : '否')}</dd>
          </> : platform === 'x' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t('公开')}</strong></dd>
            <dt>{t('是否使用 AI 生成或编辑')}</dt><dd>{t(preparation.draft.isAiGenerated ? '是' : '否')}</dd>
            <dt>{t('是否为付费商业合作')}</dt><dd>{t(preparation.draft.isPaidPartnership ? '是' : '否')}</dd>
          </> : platform === 'linkedin' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t('公开 · 发布到个人动态')}</strong></dd>
          </> : platform === 'kuaishou' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t('公开')}</strong></dd>
            <dt>{t('AI 标识')}</dt><dd>{t('不需要')}</dd>
          </> : platform === 'douyin' ? <>
            <dt>{t('可见性')}</dt><dd><strong>{t(DOUYIN_PRIVACY[preparation.draft.privacyStatus])}</strong></dd>
            <dt>{t('允许下载')}</dt><dd>{t(preparation.draft.allowDownload ? '是' : '否')}</dd>
            <dt>{t('稿件类型')}</dt><dd>{t('原创')}</dd>
            <dt>{t('是否需要 AI 标识')}</dt><dd>{t('否')}</dd>
          </> : null}
        </dl>
        {platform === 'tiktok' ? <TikTokConsent branded={preparation.draft.brandedContent} /> : null}
        <div className="md-work-actions"><button type="button" className="md-btn" disabled={Boolean(busy)} onClick={close}>{t('返回修改')}</button><button type="button" className="md-btn is-primary" disabled={Boolean(busy)} onClick={submit}>{t(busy === 'submit' ? '正在确认…' : '确认投稿')}</button></div>
      </div>
    </Dialog> : null}
  </>
}

export function PublishChecklist({ mode, locked, flow, onCopy }) {
  const { checks, canPrepare, busy, error, prepare } = flow
  const required = checks.filter(row => !row.optional)
  const ready = required.filter(row => row.done).length
  return <section className="md-work-panel md-release-checks">
    <div className="md-work-panel-title"><h3>{t('发布准备')}</h3><span>{ready}/{required.length}</span></div>
    <ul className="md-publish-checklist">{checks.map(row => <li key={row.text} className={row.done ? 'is-done' : ''}>
      <i aria-hidden="true">{row.done ? <Icon name="check" size={12} /> : null}</i>
      <div><span>{t(row.text)}</span>{!row.done && row.issue ? <span className="md-publish-check-issue">{t(row.issue)}</span> : null}</div>
      <small>{t(row.done ? '已准备' : row.optional ? '可选' : '待处理')}</small>
    </li>)}</ul>
    {mode === 'now' ? <div className="md-publish-submit">
      <button type="button" className="md-btn is-primary is-wide" onClick={prepare} disabled={!canPrepare || Boolean(busy)}>{t(busy === 'prepare' ? '正在检查…' : '检查并准备发布')}</button>
      <span role="status">{t(locked ? '此平台已有投稿记录，请查看投稿记录。' : canPrepare ? '发布信息已齐全，可以检查并准备发布。' : '完成必填项后即可检查并准备发布。')}</span>
      {canPrepare ? <span>{t('检查通过后会显示确认单，不会直接发送。')}</span> : null}
      {error ? <p className="md-publish-error" role="alert">{error}</p> : null}
    </div> : mode === 'manual' ? <>
      <p>{t('检查文案和选材后，可手动发布。')}</p>
      <div className="md-publish-submit"><button type="button" className="md-btn is-primary is-wide" onClick={onCopy}><Icon name="copy" size={15} />{t('复制发布文案')}</button><span>{t('素材可在素材页预览和下载')}</span></div>
    </> : null}
  </section>
}

export function PublishHistory({ id, publishing }) {
  const { jobs, refresh } = publishing
  const [checking, setChecking] = React.useState('')
  const [error, setError] = React.useState('')
  const check = async taskId => {
    setChecking(taskId); setError('')
    try { await request('review', { id, taskId }); await refresh() }
    catch (err) { setError(err.message) }
    finally { setChecking('') }
  }
  if (!jobs.length) return null
  return <section className="md-work-panel md-publish-history">
    <div className="md-work-panel-title"><h3>{t('投稿记录')}</h3><button type="button" className="md-btn is-small" onClick={refresh}>{t('刷新')}</button></div>
    {jobs.map(job => <article key={job.taskId}>
      <strong>{job.title} · {t(platformName(job.platform))}</strong>
      <p>{job.account} · {t(STATUS[job.status] || '请到平台核对')}{job.actualPrivacy ? ` · ${t(PRIVACY[job.actualPrivacy])}` : ''}</p>
      {job.platform === 'douyin' && job.status === 'pending_review' && !job.canReview ? <p>{t('已收到投稿回执，请在抖音创作中心核对。')}</p> : null}
      {job.platform === 'linkedin' && job.receiptId ? <p>{t('LinkedIn 已确认创建帖子。API 回查需额外读取权限，也可直接打开帖子核对。')}</p> : null}
      {job.platform === 'facebook' && ['story', 'photo_story'].includes(job.destination) ? <p>{t(job.destination === 'photo_story' ? '照片快拍（Story）' : '视频快拍（Story）')} · {t('快拍的展示期限由 Facebook 决定，发布回执不代表永久可见；请到公共主页核对。')}</p> : null}
      {job.message || job.reviewError ? <p role="status">{job.reviewError || job.message}</p> : null}
      {job.coverResult ? <p role="status">{t(job.coverResult.message || '视频回执已保存，正在等待处理并设置缩略图。')}</p> : null}
      <div className="md-work-actions">
        {safeWorkLink(job) ? <a className="md-btn is-small" href={job.url} target="_blank" rel="noreferrer">{t('查看作品')}</a> : null}
        {(job.status === 'unknown' || job.status === 'pending_review' || (job.status === 'published' && !safeWorkLink(job)) || (job.coverResult && job.coverResult.status !== 'set')) && PUBLISH_PLATFORMS[job.platform]?.studio ? <a className="md-btn is-small" href={PUBLISH_PLATFORMS[job.platform].studio} target="_blank" rel="noreferrer">{t(PUBLISH_PLATFORMS[job.platform].studioLabel || '打开平台创作中心')}</a> : null}
        {job.canReview ? <button type="button" className="md-btn is-small" disabled={Boolean(checking)} onClick={() => void check(job.taskId)}>{t(checking === job.taskId ? '正在查询…' : '查询平台状态')}</button> : null}
      </div>
    </article>)}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
