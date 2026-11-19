import { PUBLISH_PLATFORMS } from './capabilities.js'

const field = (key, label, secret = false, optional = false) => ({ key, label, secret, optional })
const token = field('ACCESS_TOKEN', 'Access Token', true)
const clientId = field('CLIENT_ID', 'Client ID / App ID')
const clientSecret = field('CLIENT_SECRET', 'Client Secret / App Secret', true)
const userId = field('USER_ID', 'User ID')
const openId = field('OPEN_ID', 'Open ID')
const graph = field('GRAPH_VERSION', 'Graph API Version（可选）', false, true)
export const PUBLISH_CONFIG_FIELDS = {
  bilibili: [clientId, clientSecret, token],
  youtube: [clientId, token, field('REGION', 'Region（可选，默认 US）', false, true)],
  facebook: [
    { ...field('PAGE_ID', 'Page ID'), help: '填写用于发布的 Facebook 公共主页 ID，不是个人账号 ID。' },
    { ...token, help: '填写该公共主页的 Page Access Token，不是 AiToEarn Key。' },
    { ...graph, help: '不确定时留空，使用当前发布适配器的默认版本。' },
  ],
  instagram: [field('PAGE_ID', 'Page ID'), token, graph],
  douyin: [openId, token],
  kuaishou: [field('APP_ID', 'App ID'), openId, token],
  linkedin: [field('MEMBER_ID', 'Member ID'), token, field('API_VERSION', 'API Version（可选）', false, true)],
  x: [userId, token],
  pinterest: [userId, token],
  tiktok: [openId, token],
  threads: [userId, token],
  wechat: [clientId, clientSecret],
  bluesky: [field('DID', 'DID'), field('HANDLE', 'Handle'), field('APP_PASSWORD', 'App Password', true), field('PDS_URL', 'PDS URL（可选）', false, true)],
}
export const publishConfigPlatforms = Object.keys(PUBLISH_PLATFORMS)
