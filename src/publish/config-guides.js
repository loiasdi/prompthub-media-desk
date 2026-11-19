export const PUBLISH_GUIDE_EN = {}
const text = (zh, en) => { PUBLISH_GUIDE_EN[zh] = en; return zh }
const link = (label, href) => ({ label, href })
const optionalVersion = text('可留空，使用本适配器默认版本；如需指定，请从官方版本文档确认应用支持的版本。', 'Leave blank for the adapter default, or check the official version documentation before specifying a version.')
const userToken = text('填写目标账号完成 OAuth 授权后换取的 access_token，不是应用密钥、授权码 code 或 refresh_token。', 'Use the access_token obtained after the target account completes OAuth, not an application key, authorization code, or refresh_token.')

export const PUBLISH_CONFIG_GUIDES = {
  facebook: {
    steps: [
      text('打开 Meta 应用后台，创建或选择自己的应用，按官方 Pages API 入门配置授权；用于发布的公共主页必须由你管理。', 'Create or select your own app in the Meta dashboard and follow the Pages API authorization guide. You must manage the target Page.'),
      text('在 Graph API Explorer 选择该应用，使用管理主页的 Facebook 账号授权。基础主页发布通常涉及 pages_show_list、pages_read_engagement、pages_manage_posts；其他内容类型按官方文档补充权限。', 'Select your app in Graph API Explorer and authorize with the Page manager account. Basic Page publishing generally uses pages_show_list, pages_read_engagement, and pages_manage_posts; check the docs for other content types.'),
      text('在官方工具中执行 GET /me/accounts?fields=id,name,access_token，找到目标主页，把同一条记录的 id 和 access_token 分别填入下方。', 'In the official tool, run GET /me/accounts?fields=id,name,access_token. Copy id and access_token from the same target Page record into the fields below.'),
    ],
    fields: {
      PAGE_ID: text('取 /me/accounts 返回的目标主页 id；不要填个人用户 ID、主页名称或主页网址。', 'Use the target Page id from /me/accounts, not a personal user ID, Page name, or URL.'),
      ACCESS_TOKEN: text('取同一条主页记录中的 access_token，即 Page Access Token；不要填 App Secret 或 App Token。', 'Use access_token from the same Page record: a Page Access Token, not an App Secret or App Token.'),
      GRAPH_VERSION: optionalVersion,
    },
    warning: text('开发模式和测试角色可能受限；向非应用角色提供服务通常还需应用审核。验证账号成功不代表所有发布权限都已获批。', 'Development mode and test roles can limit access. Serving non-role users generally requires app review. Successful account verification does not prove every publishing permission is approved.'),
    links: [link('Meta 应用后台', 'https://developers.facebook.com/apps/'), link('Graph API Explorer', 'https://developers.facebook.com/tools/explorer/'), link('Pages API 官方入门', 'https://developers.facebook.com/docs/pages-api/getting-started/')],
  },
  instagram: {
    steps: [
      text('本入口采用 Instagram API with Facebook Login：先准备 Instagram 专业账号，并关联你管理的 Facebook 公共主页。', 'This adapter uses Instagram API with Facebook Login. Prepare an Instagram professional account linked to a Facebook Page you manage.'),
      text('在 Meta 应用中配置 Facebook Login for Business，按官方流程让管理账号授权；本入口需要 instagram_basic、instagram_content_publish 及所需的 Pages 读取权限。', 'Configure Facebook Login for Business in your Meta app and authorize the managing account. This adapter needs instagram_basic, instagram_content_publish, and applicable Pages read permissions.'),
      text('用官方工具查询 /me/accounts 获取关联主页的 id 和主页令牌，再查询 /{page-id}?fields=instagram_business_account 确认关联账号。', 'Use the official tool to query /me/accounts for the linked Page id and Page token, then /{page-id}?fields=instagram_business_account to verify the linked account.'),
    ],
    fields: { PAGE_ID: text('填关联的 Facebook 公共主页 ID，不是 Instagram 用户 ID。', 'Use the linked Facebook Page ID, not the Instagram user ID.'), ACCESS_TOKEN: text('填写该关联主页的 Page Access Token，来自同一管理账号、应用和主页的授权。', 'Use the linked Page Access Token obtained for the same managing account, app, and Page.'), GRAPH_VERSION: optionalVersion },
    warning: text('个人 Instagram 账号和 Instagram Login 路径的令牌不能直接套用到这个适配器。', 'Personal Instagram accounts and tokens from the Instagram Login flow cannot be substituted into this adapter.'),
    links: [link('Meta 应用后台', 'https://developers.facebook.com/apps/'), link('Instagram 官方接入指南', 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started/'), link('Graph API Explorer', 'https://developers.facebook.com/tools/explorer/')],
  },
  youtube: {
    steps: [
      text('打开 Google Cloud 控制台，创建或选择项目，在 API 库启用 YouTube Data API v3。', 'Create or select a Google Cloud project and enable YouTube Data API v3 in the API Library.'),
      text('配置 Google Auth Platform 的同意屏幕和测试用户，在客户端页面创建适合授权流程的 OAuth 客户端；本地桌面流程选择 Desktop app。', 'Configure the Google Auth Platform consent screen and test users, then create an OAuth client for your flow. Choose Desktop app for a local desktop flow.'),
      text('在你自己的授权工具中完成官方 OAuth 流程，使用要投稿的频道账号授权 youtube.upload 和 youtube.readonly，再将返回的 access_token 填入本页。', 'Complete the official OAuth flow in your own authorization tool using the target channel account with youtube.upload and youtube.readonly, then enter the resulting access_token here.'),
    ],
    fields: { CLIENT_ID: text('取 Google Auth Platform → Clients 中该 OAuth 客户端的 Client ID，不是 API Key 或项目编号。', 'Copy the OAuth Client ID from Google Auth Platform → Clients, not an API key or project number.'), ACCESS_TOKEN: userToken, REGION: text('可留空，默认 US；也可填两位大写地区码，用于查询发布分区，不会改变账号所在地。', 'Optional; defaults to US. Use a two-letter uppercase region code for category lookup; this does not change the account location.') },
    warning: text('本页没有 Google 登录按钮，也不自动刷新令牌。只有 Client ID 或 API Key 不足以投稿；需先通过自己的授权流程取得用户令牌。', 'This page has no Google sign-in flow or automatic token refresh. A Client ID or API key alone cannot publish; obtain a user token through your own authorization flow first.'),
    links: [link('Google Cloud 控制台', 'https://console.cloud.google.com/'), link('Google OAuth 客户端', 'https://console.cloud.google.com/auth/clients'), link('Google 桌面 OAuth 指南', 'https://developers.google.com/identity/protocols/oauth2/native-app')],
  },
  bilibili: {
    steps: [text('进入哔哩哔哩开放平台，注册开发者并创建或选择自有应用。', 'Register as a developer on the Bilibili Open Platform and create or select your own app.'), text('在应用详情中取得 Client ID 和 Client Secret，按应用后台要求申请账号信息、分区、投稿及回查能力。', 'Get the Client ID and Client Secret from the app details and request the account, category, publishing, and review capabilities required by the app console.'), text('按照开放平台为该应用提供的用户授权流程，让要投稿的账号授权，再换取 access_token；本页不负责网页登录换码。', 'Follow the platform authorization flow for your app, authorize the target account, and exchange the code for access_token. This page does not handle the login callback.')],
    fields: { CLIENT_ID: text('填写自有开放平台应用的 Client ID；以应用后台实际名称为准，不是 B 站 UID。', 'Use your Open Platform app Client ID, following the console terminology, not a Bilibili UID.'), CLIENT_SECRET: text('填写同一应用的 Client Secret，仅保存在 Host。', 'Use the Client Secret from the same app; it stays on the Host.'), ACCESS_TOKEN: userToken },
    warning: text('应用是否获准投稿以开放平台审核为准，不能用网页 Cookie 或普通账号密码代替开放平台令牌。', 'Publishing eligibility depends on platform approval. Website cookies and account passwords cannot replace an Open Platform token.'),
    links: [link('哔哩哔哩开放平台', 'https://open.bilibili.com/')],
  },
  douyin: {
    steps: [text('打开抖音开放平台，创建或选择自有应用，申请当前视频发布接口要求的能力。', 'Create or select your own app on the Douyin Open Platform and request the capabilities required by the video publishing API.'), text('为目标账号完成用户授权；本适配器使用 user_info 和 video.create.bind，实际准入以应用后台与官方文档为准。', 'Authorize the target account. This adapter uses user_info and video.create.bind; eligibility is determined by the app console and official documentation.'), text('通过官方 access_token 接口完成授权码换取，把同一次授权响应中的 open_id 和 access_token 填入下方。', 'Exchange the authorization code through the official access_token endpoint and enter open_id and access_token from the same authorization response.')],
    fields: { OPEN_ID: text('从该应用的用户授权响应取得 open_id，不是抖音号、昵称或 union_id。', 'Use open_id from the user authorization response for this app, not a Douyin handle, nickname, or union_id.'), ACCESS_TOKEN: userToken },
    warning: text('开发者应用密钥与用户令牌不是同一个值；不要填 client_token 或网页登录 Cookie。', 'The app secret and user token are different. Do not use client_token or website login cookies.'),
    links: [link('抖音开放平台', 'https://open.douyin.com/'), link('抖音用户授权与公开信息', 'https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-account-open-info')],
  },
  kuaishou: {
    steps: [text('进入快手开放平台，为自有应用申请视频发布与查询能力。', 'Request video publishing and query capabilities for your own app on the Kuaishou Open Platform.'), text('让目标账号完成官方用户授权；准备 user_info、user_video_publish、user_video_info 对应权限，再取得用户访问令牌与 open_id。', 'Authorize the target account with user_info, user_video_publish, and user_video_info, then obtain the user access token and open_id.'), text('将应用 App ID 与该应用同一次用户授权的 open_id、access_token 配对填写；另需确认下方 HTTP 风险开关。', 'Enter the App ID together with open_id and access_token from the same authorization for that app, and explicitly confirm the HTTP risk option below.')],
    fields: { APP_ID: text('从快手开放平台的应用详情取得 App ID。', 'Get the App ID from your Kuaishou app details.'), OPEN_ID: text('取该应用用户授权响应中的 open_id，不是快手号；必须与访问令牌对应。', 'Use open_id from the app user authorization response, not a public Kuaishou handle; it must match the access token.'), ACCESS_TOKEN: userToken },
    warning: text('本适配器的视频上传网关使用未加密 HTTP；不接受风险或没有应用权限时，请改用官方发布器。', 'This adapter uploads video over unencrypted HTTP. Use the official publisher if you do not accept that risk or lack the required permissions.'),
    links: [link('快手开放平台', 'https://open.kuaishou.com/'), link('快手用户信息与授权', 'https://open.kuaishou.com/platformDocs/openAbility/userInformation/publicInformation'), link('快手创建视频官方文档', 'https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo.html')],
  },
  linkedin: {
    steps: [text('进入 LinkedIn Developers 创建应用，按需添加 Sign In with LinkedIn using OpenID Connect 与 Share on LinkedIn 产品。', 'Create a LinkedIn Developers app and add the Sign In with LinkedIn using OpenID Connect and Share on LinkedIn products as needed.'), text('按官方 OAuth 流程让个人账号授权 openid、profile、w_member_social，获得用户 access_token。', 'Authorize your personal account through the official OAuth flow with openid, profile, and w_member_social to obtain a user access_token.'), text('在自己的 API 工具中携带该令牌查询 GET /v2/userinfo，复制响应中的 sub 作为 Member ID。', 'In your own API tool, query GET /v2/userinfo using that token and copy the response sub as Member ID.')],
    fields: { MEMBER_ID: text('取 /v2/userinfo 的 sub，不要填个人主页 URL 或 urn:li:person: 前缀。', 'Use sub from /v2/userinfo, not a profile URL or the urn:li:person: prefix.'), ACCESS_TOKEN: userToken, API_VERSION: optionalVersion },
    warning: text('本入口仅发布个人账号内容；发布后的回查权限另受 LinkedIn 准入限制。', 'This adapter publishes personal account content only; post-review permissions are subject to separate LinkedIn access restrictions.'),
    links: [link('LinkedIn 应用后台', 'https://www.linkedin.com/developers/apps'), link('LinkedIn OIDC 与用户 ID', 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2'), link('Share on LinkedIn', 'https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin')],
  },
  x: {
    steps: [text('在 X Developer Console 创建或选择应用，开启用户身份验证并按官方指南配置 OAuth 2.0 Authorization Code with PKCE。', 'Create or select an app in X Developer Console, enable user authentication, and configure OAuth 2.0 Authorization Code with PKCE.'), text('让要发帖的账号授权 tweet.read、users.read、tweet.write、media.write，获得用户 access_token。', 'Authorize the posting account with tweet.read, users.read, tweet.write, and media.write to get a user access_token.'), text('在自己的 API 工具中用该用户令牌执行 GET /2/users/me，将 data.id 填为 User ID。', 'Use that user token to call GET /2/users/me in your own API tool and enter data.id as User ID.')],
    fields: { USER_ID: text('取 /2/users/me 的 data.id，不是 @用户名或主页链接。', 'Use data.id from /2/users/me, not an @handle or profile URL.'), ACCESS_TOKEN: text('填写 OAuth 2.0 用户访问令牌，不是开发者后台的 App-only Bearer Token 或 OAuth 1.0 Token Secret。', 'Use an OAuth 2.0 user access token, not the console App-only Bearer Token or an OAuth 1.0 Token Secret.') },
    warning: text('账号需符合本适配器的公开发布要求；接口访问额度和费用以 X 开发者后台为准。', 'The account must meet this adapter’s public publishing requirements. API access quotas and billing are determined by X.'),
    links: [link('X 开发者后台', 'https://developer.x.com/'), link('X OAuth 2.0 官方指南', 'https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code')],
  },
  pinterest: {
    steps: [text('用 Pinterest 商业账号进入开发者平台的 My apps，注册应用并申请适用的访问级别。', 'Use a Pinterest business account to register an app in My apps and request the applicable access tier.'), text('配置回调地址，通过官方 OAuth 流程让目标账号授权 user_accounts:read、boards:read、pins:read、pins:write。', 'Configure the redirect URI and authorize the target account through official OAuth with user_accounts:read, boards:read, pins:read, and pins:write.'), text('取得 access_token 后，在自己的 API 工具中查询 GET /v5/user_account，将响应 id 填为 User ID。', 'After obtaining access_token, query GET /v5/user_account in your own API tool and enter the response id as User ID.')],
    fields: { USER_ID: text('取 /v5/user_account 的 id，不是用户名、画板 ID 或 Pin ID；画板在发布时选择。', 'Use id from /v5/user_account, not a username, board ID, or Pin ID. Select the board when preparing a post.'), ACCESS_TOKEN: userToken },
    warning: text('测试令牌可能有时限和接口限制；不要把只适用于测试或受限产品的令牌当成已获完整发布权限。', 'Test tokens may have time and endpoint limits. A test or product-limited token does not imply full publishing permission.'),
    links: [link('Pinterest 开发者平台', 'https://developers.pinterest.com/'), link('Pinterest 应用与授权指南', 'https://developers.pinterest.com/docs/getting-started/connect-app/')],
  },
  tiktok: {
    steps: [text('进入 TikTok for Developers 创建应用，添加 Content Posting API 并启用 Direct Post。', 'Create an app in TikTok for Developers, add Content Posting API, and enable Direct Post.'), text('按官方流程申请 video.publish 及账号信息权限，让要投稿的账号授权。', 'Request video.publish and account information permissions through the official process, then authorize the target account.'), text('通过官方 OAuth 令牌接口换取 access_token 与 open_id，将同一次用户授权得到的两个值配对填写。', 'Exchange the authorization code through the official OAuth token endpoint and enter access_token and open_id from the same authorization.')],
    fields: { OPEN_ID: text('取官方 OAuth 响应的 open_id，不是 TikTok 用户名、昵称或视频 ID。', 'Use open_id from the official OAuth response, not a TikTok username, nickname, or video ID.'), ACCESS_TOKEN: userToken },
    warning: text('未审核客户端的发布可见性受限；开通产品、获批权限与完成用户授权是不同步骤，不能保证个人内部工具能通过审核。', 'Unaudited clients have posting visibility restrictions. Product access, scope approval, and user consent are separate steps; internal personal tools are not guaranteed approval.'),
    links: [link('TikTok 开发者后台', 'https://developers.tiktok.com/'), link('TikTok Direct Post 入门', 'https://developers.tiktok.com/doc/content-posting-api-get-started')],
  },
  threads: {
    steps: [text('进入 Meta 应用后台，创建带 Threads use case 的应用，注意使用 Threads 对应的应用标识和密钥。', 'Create a Meta app with the Threads use case and use its Threads-specific app ID and secret.'), text('按 Threads 官方授权流程，让目标账号同意 threads_basic、threads_content_publish，换取 Threads 用户令牌。', 'Follow the official Threads authorization flow to grant threads_basic and threads_content_publish and obtain a Threads user token.'), text('在官方 API 工具中使用该令牌查询 GET /me?fields=id,username，将返回的 id 填为 User ID。', 'Use that token in an official API tool to query GET /me?fields=id,username and enter the returned id as User ID.')],
    fields: { USER_ID: text('取 Threads API /me 返回的 id，不是 Instagram 用户 ID、Facebook Page ID 或 @用户名。', 'Use the id returned by Threads API /me, not an Instagram user ID, Facebook Page ID, or @handle.'), ACCESS_TOKEN: text('填写 Threads 用户 access_token，不是 Facebook 主页令牌或 Instagram 令牌。', 'Use a Threads user access_token, not a Facebook Page token or Instagram token.') },
    warning: text('本入口当前只接纯文字；测试角色以外的用户授权可能需要应用审核。', 'This adapter currently supports text only; authorization by users outside app test roles may require app review.'),
    links: [link('Meta 应用后台', 'https://developers.facebook.com/apps/'), link('Threads API 官方入门', 'https://developers.facebook.com/docs/threads/get-started/')],
  },
  wechat: {
    steps: [text('登录微信公众平台的目标公众号，在后台开发配置或 API 凭据页面查看 AppID 与 AppSecret；菜单名称以实际后台为准。', 'Sign into the target WeChat Official Account and find AppID and AppSecret in its development or API credentials settings. Menu names may vary.'), text('确认账号具备草稿与发布接口权限，并按微信要求把 DSH Host 的实际公网出口 IP 加入 IP 白名单。', 'Confirm draft and publishing API access, then add the DSH Host’s actual public egress IP to the WeChat IP allowlist as required.'), text('仅填写公众号自己的 AppID/AppSecret。Host 会按官方接口获取后台令牌，不需要在这里填写个人微信密码或网页 OAuth 令牌。', 'Enter the Official Account AppID and AppSecret only. The Host obtains a server token through the official API; do not enter a personal WeChat password or web OAuth token.')],
    fields: { CLIENT_ID: text('这里的 Client ID 对应公众号 AppID，通常以 wx 开头；不是小程序 AppID。', 'Client ID here means the Official Account AppID, typically starting with wx, not a Mini Program AppID.'), CLIENT_SECRET: text('对应同一公众号的 AppSecret。重置会影响其他使用该密钥的服务，请先确认。', 'Use the same Official Account’s AppSecret. Resetting it affects other services using that secret.') },
    warning: text('能够获取令牌不等于拥有发表权限；本入口是公众号文章发表，不是微信群发或视频号发布。', 'Being able to obtain a token does not imply publishing permission. This adapter publishes Official Account articles, not mass messages or Channels videos.'),
    links: [link('微信公众平台', 'https://mp.weixin.qq.com/'), link('微信后台令牌官方文档', 'https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html')],
  },
  bluesky: {
    steps: [text('进入 Bluesky 设置中的 App Passwords，为此工具单独创建应用密码，不要使用主账号密码。', 'Create a dedicated app password for this tool in Bluesky App Passwords. Do not use the main account password.'), text('从个人资料取得完整 Handle，例如 name.bsky.social。通过 AT Protocol 官方身份解析流程把 Handle 解析为 DID。', 'Copy the full profile Handle, such as name.bsky.social, and resolve it to a DID using the official AT Protocol identity resolution flow.'), text('确认账号所属 PDS。默认使用本适配器的 bsky.social；自定义或迁移账号应按 DID 文档中的服务地址填写。', 'Check the account PDS. This adapter defaults to bsky.social; custom or migrated accounts should use the service address in their DID document.')],
    fields: { DID: text('填稳定身份标识 did:plc:… 或受支持的 did:web:…，不能把 Handle 直接填在这里。', 'Use a stable did:plc:… or supported did:web:… identifier, not the Handle.'), HANDLE: text('填写完整账号 Handle，不带 @，不是显示昵称或个人资料网址。', 'Use the full account Handle without @, not a display name or profile URL.'), APP_PASSWORD: text('填写在 Bluesky App Passwords 新建的专用应用密码；妥善保存，不要贴到聊天。', 'Use the dedicated password created in Bluesky App Passwords. Store it securely and do not paste it into chat.'), PDS_URL: text('可留空使用默认值；自定义 PDS 必须填账号实际所属的 HTTPS 服务地址，不要填个人资料页。', 'Leave blank for the default, or use the account’s actual HTTPS PDS endpoint, not a profile page.') },
    warning: text('不需要开发者 App ID 或 OAuth 访问令牌，但 Handle、DID、PDS 和应用密码必须属于同一个账号。', 'No developer App ID or OAuth access token is required, but the Handle, DID, PDS, and app password must all belong to the same account.'),
    links: [link('Bluesky 应用密码设置', 'https://bsky.app/settings/app-passwords'), link('AT Protocol 身份与 DID 指南', 'https://atproto.com/guides/identity')],
  },
}
