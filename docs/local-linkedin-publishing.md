# LinkedIn 个人动态：DSH Host 本地直传

## 配置与授权

把 AiToEarn 的 LinkedIn 个人账号视频、图片和纯文字投稿流程接到工作台统一发布入口。使用自有 LinkedIn 应用和账号的用户访问令牌，不连接 AiToEarn 云端，不需要 API Key、扫码或浏览器扩展。图片使用本地文件流，不要求公共素材 URL。

在 LinkedIn Developer Portal 给自有应用开通「Sign In with LinkedIn using OpenID Connect」和「Share on LinkedIn」产品，通过 OAuth 获取含 `openid`、`profile`、`w_member_social` 的用户令牌。应用是否获批、产品权限、令牌 scopes 和开放平台配额由 LinkedIn 决定；配置开关不代表已经获准投稿。

将下列值配置在 DSH Host 私有运行环境，重启 Host 生效：

| 变量 | 说明 |
| --- | --- |
| `MEDIA_DESK_LINKEDIN_PUBLISH=1` | 显式启用，默认关闭 |
| `MEDIA_DESK_LINKEDIN_MEMBER_ID` | 同一应用下 `/v2/userinfo` 返回的 `sub`，不是个人主页 URL 或显示名称 |
| `MEDIA_DESK_LINKEDIN_ACCESS_TOKEN` | 对应这个用户的 OAuth access token，不是 ID Token 或应用令牌 |
| `MEDIA_DESK_LINKEDIN_API_VERSION` | 可选，默认 `202611`，显式固定版本；平台弃用时需更新并验证 |

Host 在准备和提交前重新调用 `/v2/userinfo`，核对 `sub` 是否等于配置的会员 ID。账号和令牌只由 Host 决定，不能从前端提交别人的作者 URN。当前没有 OAuth 换码、令牌续期或凭据管理 UI。凭据不要放进 Git、同步文档或浏览器。

`w_member_social` 允许创建帖子；个人帖子读取需要额外获批的 `r_member_social`，不是普通分享授权自动包含的权限。没有读取权限仍可投稿：平台成功创建后保存 `x-restli-id` 回执及官方帖子链接，回查 403 时保留原结果并提示权限限制。图文先记录为「平台处理中」，没有读取权限时需打开链接人工核对，不会自行标记处理成功。最终 POST 超时且未取得回执时不能用素材上传 ID 推导帖子，也不会自动重投。

官方 Images API 特别说明：仅有 `w_member_social` 的令牌不能读取版本化 `rest/images`。因此不添加一个普通分享账号必定失败的图片 GET 门槛，也不伪称已经查到图片 `AVAILABLE`；按上游流程上传完成后创建帖子，通过 Posts 回查或官方链接确认异步处理结果。图片上传可能残留未使用的官方素材，不自动删除。

## 在工作台使用

1. 稿件 → 发布 → 平台选「LinkedIn」→ API 投稿。填写标题、说明、话题。视频选择这篇稿件中的本地 MP4 成片；图文按顺序选择 1–20 张本地 JPEG/PNG，每张最多 10 MiB，已知宽高时须少于 36,152,320 像素；纯文字不要求或读取素材，即使曾选过素材也不会混入。
2. 显式确认「公开」。首版发布到已核对的个人账号动态，标题和话题并入实际说明；没有独立标题字段。确认单显示实际文案。纯文本中的保留字符会按 LinkedIn little text 语法转义，话题单独编码，避免把文案里的 `@` 或括号当作提及语法。
3. 必填项齐全后点「检查并准备发布」，只核对账号和文件、固定确认单，不上传素材。更换文案、素材或账号后需重新准备。
4. 点「确认投稿」后，Host 固定本地素材快照。视频向 Videos API 初始化上传，按返回字节范围逐片流式 PUT，收集 ETag，再完成上传并等待 `AVAILABLE`。图文向 Images API 逐张初始化并流式 PUT；单图使用 `content.media`，2–20 张使用 `content.multiImage.images`，保持选择顺序。不会把缺失图片降级为纯文字。纯文字不调用上传接口。
5. 持久化最终提交检查点后，只发送一次 Posts API 请求。收到 `201` 和合法帖子 URN 才保存回执及官方链接；视频/纯文字显示「投稿完成」，图文保留「平台处理中」，回查确认 `PUBLISHED` 才显示完成。`PUBLISH_REQUESTED` 继续等待，`PUBLISH_FAILED` 标记拒绝并允许重新准备，不自动重投。回查图文时还核对素材 URN 和顺序，读取失败保留原结果。

范围：个人账号的单个公开视频、1–20 张图文或纯文字，不接公司主页、广告、图视频混排、GIF、定时、批量、独立封面或字幕文件。视频为 MP4、至少 75 KiB、最长 30 分钟、最短 3 秒，文件受工作台 250 MB 上限约束；缺少旧素材媒体元数据时交由平台最终校验。图片每张 10 MiB 是工作台本地上限，不宣称是平台最大值。完整说明按本地策略限 3,000 UTF-16 单元。需要平台原生声明而此入口未提供相应字段的作品，应使用官方发布器完成声明。

素材在本地 Host 和 LinkedIn 之间传输。上传只接受官方 `https://www.linkedin.com/dms-uploads/…` 地址，不跟随跳转。注意两类上传鉴权不同：视频分片不带 OAuth；图片按官方 Upload the Image 指引，向已校验的 LinkedIn 上传地址携带 OAuth。不会将令牌转交任意域名。上传地址、会话 token 和分片 ETag 不写入持久化投稿记录；记录包含确认单、帖子回执及视频 URN 或有序图片 URN。未知结果需到 LinkedIn 核对，重新启动 Host 不会重放任务。当前不提供解除未知任务的入口。

## 复用和验证

接口顺序和参数结构复用 AiToEarn `linkedin.service.ts`、`linkedin-publish.provider.ts`，基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558`。本地版本移除 URL 下载素材路径，使用统一 `src/publish/service.js`、本地快照、稿件确认单和投稿记录，补齐分片范围、官方上传地址、ETag、转码状态、账号归属校验。MIT 声明随适配器发布于 `src/publish/linkedin/UPSTREAM-LICENSE.txt`。

自动化测试使用模拟 LinkedIn 响应验证 Host 准备/提交/回查、顺序分片和图片字节、图片与视频的鉴权差异、单图/多图结构、纯文字不读素材、未知提交防重投和凭据隔离；不证明真实应用的准入权限，没有使用真实账号发帖。上游图片创建一律使用 `multiImage`，但当前官方 MultiImage 要求至少 2 张，这里对单图改用官方 `content.media`，并非机械复制。

协议依据（核对日期 2026-11-18）：[身份核对](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2) · [分享权限](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) · [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-11) · [Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-11) · [图片 PUT 鉴权](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api?view=li-lms-2026-11#upload-the-image) · [MultiImage](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-11) · [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-11) · [little text](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format?view=li-lms-2026-11) · [版本管理](https://learn.microsoft.com/en-us/linkedin/marketing/versioning)。
