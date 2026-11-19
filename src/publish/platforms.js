import { createBilibiliAdapter } from './bilibili/index.js'
import { createLinkedInAdapter } from './linkedin/index.js'
import { createXAdapter } from './x/index.js'
import { createPinterestAdapter } from './pinterest/index.js'
import { createTikTokAdapter } from './tiktok/index.js'
import { createThreadsAdapter } from './threads/index.js'
import { createWeChatAdapter } from './wechat/index.js'
import { createYouTubeAdapter } from './youtube/index.js'
import { createInstagramAdapter } from './instagram/index.js'
import { createDouyinAdapter } from './douyin/index.js'
import { validVideoId } from './douyin/client.js'
import { createFacebookAdapter } from './facebook/index.js'
import { createBlueskyAdapter } from './bluesky/index.js'
import { createKuaishouAdapter } from './kuaishou/index.js'
import { PUBLISH_PLATFORMS } from './capabilities.js'
import { splitPublishTopics } from './draft-copy.js'
import { fail } from '../workspace-schema.js'

const categoryId = value => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) throw fail('请选择有效的发布分区')
  return value
}
const drivers = {
  bluesky: {
    create: createBlueskyAdapter,
    account: data => [data?.id, data?.name],
    draft: (options, copy) => ({ privacyStatus: options.privacyStatus, format: copy.format }),
  },
  kuaishou: {
    create: createKuaishouAdapter,
    account: data => [data?.id, data?.name],
    draft: options => ({ privacyStatus: options.privacyStatus, requiresAiLabel: options.requiresAiLabel }),
  },
  wechat: {
    create: createWeChatAdapter,
    account: data => [data?.id, data?.name],
    draft: options => ({ privacyStatus: options.privacyStatus, author: typeof options.author === 'string' ? options.author.trim() : '', digest: typeof options.digest === 'string' ? options.digest.trim() : '', allowComment: options.allowComment, onlyFansComment: options.onlyFansComment, requiresNativeDeclaration: options.requiresNativeDeclaration }),
  },
  threads: {
    create: createThreadsAdapter,
    account: data => [data?.id, data?.name],
    draft: options => ({ privacyStatus: options.privacyStatus, replyControl: options.replyControl, isAiGenerated: options.isAiGenerated }),
  },
  tiktok: {
    create: createTikTokAdapter,
    account: data => [data?.id, data?.name],
    constraints: data => data.constraints,
    draft: options => Object.fromEntries(['privacyStatus', 'original', 'musicConsent', 'allowComment', 'allowDuet', 'allowStitch', 'isAiGenerated', 'commercialContent', 'ownBrand', 'brandedContent', 'brandedConsent'].map(key => [key, options[key]])),
  },
  pinterest: {
    create: createPinterestAdapter,
    account: data => [data?.id, data?.name],
    categories: ({ adapter, accessToken }, signal) => adapter.categories(accessToken, signal),
    draft: options => ({ categoryId: options.categoryId, privacyStatus: options.privacyStatus, original: options.original, isAiGenerated: options.isAiGenerated, syntheticPerformer: options.syntheticPerformer }),
  },
  x: {
    create: createXAdapter,
    account: data => [data?.id, data?.name],
    draft: (options, copy) => ({ privacyStatus: options.privacyStatus, isAiGenerated: options.isAiGenerated, isPaidPartnership: options.isPaidPartnership, ...(copy.format !== 'video' && { format: copy.format }) }),
  },
  linkedin: {
    create: createLinkedInAdapter,
    account: data => [data?.id, data?.name],
    draft: (options, copy) => ({ privacyStatus: options.privacyStatus, ...(copy.format !== 'video' && { format: copy.format }) }),
  },
  bilibili: {
    create: createBilibiliAdapter,
    account: data => [data?.openid, data?.name],
    async categories({ adapter, accessToken }, signal) {
      const data = await adapter.categories(accessToken, signal)
      if (!Array.isArray(data)) return null
      // AiToEarn selects the child types (their IDs are the archive tid).
      return data.flatMap(parent => Array.isArray(parent?.children) ? parent.children.filter(row => Number.isSafeInteger(row?.id) && row.id > 0 && typeof row.name === 'string').map(row => ({ id: String(row.id), title: `${parent.name || ''} / ${row.name}` })) : [])
    },
    draft: options => ({ categoryId: Number(categoryId(options.categoryId)), copyright: options.copyright, source: options.copyright === 2 && typeof options.source === 'string' ? options.source.trim() : '', noReprint: false }),
  },
  youtube: {
    create: createYouTubeAdapter,
    account: data => [data?.channelId, data?.title],
    categories: ({ adapter, accessToken, region }, signal) => adapter.categories(accessToken, region, signal),
    draft: options => ({ categoryId: categoryId(options.categoryId), privacyStatus: options.privacyStatus ?? 'private', selfDeclaredMadeForKids: options.selfDeclaredMadeForKids, containsSyntheticMedia: options.containsSyntheticMedia, notifySubscribers: false }),
  },
  facebook: {
    create: createFacebookAdapter,
    account: data => [data?.id, data?.name],
    constraints: data => data?.constraints,
    canReview: job => ['story', 'photo_story'].includes(job.plan.draft.destination) ? job.plan.draft.privacyStatus === 'public' && typeof job.receiptId === 'string' && /^[1-9]\d{0,31}$/.test(job.receiptId) : true,
    draft: (options, copy) => ({ privacyStatus: options.privacyStatus, isAiGenerated: options.isAiGenerated, ...(copy.format !== 'video' ? { format: copy.format, ...(options.destination && { destination: options.destination }) } : options.destination !== undefined && { destination: options.destination }) }),
  },
  instagram: {
    create: createInstagramAdapter,
    account: data => [data?.id, data?.name],
    draft: options => ({ shareToFeed: options.shareToFeed, isAiGenerated: options.isAiGenerated }),
  },
  douyin: {
    create: createDouyinAdapter,
    canReview: job => job.plan.draft.privacyStatus === 'public' && validVideoId(job.workId),
    account: data => [data?.id, data?.name],
    draft: options => ({ privacyStatus: options.privacyStatus, allowDownload: options.allowDownload, requiresAiLabel: options.requiresAiLabel, original: options.original }),
  },
}

export function configuredPlatform(platform, env = process.env) {
  if (!Object.hasOwn(PUBLISH_PLATFORMS, platform)) return null
  const prefix = `MEDIA_DESK_${platform.toUpperCase()}_`
  if (platform === 'bluesky') {
    if (env[`${prefix}PUBLISH`] !== '1') return null
    try {
      const adapter = drivers.bluesky.create({ did: env[`${prefix}DID`], handle: env[`${prefix}HANDLE`], appPassword: env[`${prefix}APP_PASSWORD`], pdsUrl: env[`${prefix}PDS_URL`] || 'https://bsky.social' })
      return { adapter, accessToken: undefined, region: 'US' }
    } catch { return null }
  }
  if (platform === 'kuaishou') {
    if (env[`${prefix}PUBLISH`] !== '1' || env[`${prefix}ALLOW_INSECURE_UPLOAD`] !== '1') return null
    const accessToken = env[`${prefix}ACCESS_TOKEN`]
    try {
      const adapter = drivers.kuaishou.create({ appId: env[`${prefix}APP_ID`], openId: env[`${prefix}OPEN_ID`] }, { allowInsecureUpload: true })
      if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken)) return null
      return { adapter, accessToken, region: 'CN' }
    } catch { return null }
  }
  const accessToken = env[`${prefix}ACCESS_TOKEN`]
  if (env[`${prefix}PUBLISH`] !== '1' || (platform !== 'wechat' && (!accessToken || !/^[\x21-\x7e]+$/.test(accessToken)))) return null
  try {
    const adapter = drivers[platform].create({
      clientId: env[`${prefix}CLIENT_ID`], clientSecret: env[`${prefix}CLIENT_SECRET`],
      // The initial Host entry uses a provisioned credential; it does not start OAuth.
      redirectUri: env[`${prefix}REDIRECT_URI`] || 'http://127.0.0.1:4311/callback',
      openId: env[`${prefix}OPEN_ID`], pageId: env[`${prefix}PAGE_ID`], graphVersion: env[`${prefix}GRAPH_VERSION`],
      memberId: env[`${prefix}MEMBER_ID`], apiVersion: env[`${prefix}API_VERSION`],
      userId: env[`${prefix}USER_ID`],
    })
    const region = env[`${prefix}REGION`] || 'US'
    if (platform === 'youtube' && !/^[A-Z]{2}$/.test(region)) return null
    return { adapter, accessToken, region }
  } catch { return null }
}

export const canReviewPlatform = job => drivers[job.platform]?.canReview?.(job) ?? true

export async function accountOf(platform, { adapter, accessToken }, signal, { review = false } = {}) {
  const data = await (review && adapter.reviewAccount ? adapter.reviewAccount(accessToken, signal) : adapter.account(accessToken, signal))
  const [id, name] = drivers[platform].account(data)
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || typeof name !== 'string' || !name.trim()) throw fail('平台未返回可确认的发布账号', 502)
  const constraints = drivers[platform].constraints?.(data)
  return { id, name: name.slice(0, 200), ...(constraints && { constraints }) }
}

export async function categoriesOf(platform, config, signal) {
  const getCategories = drivers[platform].categories
  if (!getCategories) return []
  const data = await getCategories(config, signal)
  if (!Array.isArray(data)) throw fail(platform === 'pinterest' ? '平台未返回可用的发布画板' : '平台未返回可用的发布分区', 502)
  return data
}

export async function categoryTitleOf(platform, config, categoryId, changed = false) {
  if (!PUBLISH_PLATFORMS[platform].category) return undefined
  const category = (await categoriesOf(platform, config)).find(row => row.id === categoryId)
  if (!category) {
    if (platform === 'pinterest') throw changed ? fail('投稿画板已失效，请重新检查', 409) : fail('请选择当前可用的自有公开画板')
    throw changed ? fail('投稿分区已失效，请重新检查', 409) : fail('请选择当前可用的投稿分区')
  }
  return category.title
}

export function platformDraft(platform, copy, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('发布参数无效')
  return {
    title: copy.title.trim(), description: copy.description, topics: splitPublishTopics(copy.tags),
    ...drivers[platform].draft(options, copy),
  }
}
