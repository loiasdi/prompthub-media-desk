# DSH 本地投稿入口

打开一篇非示例稿件 → **发布** → 选择平台、发布类型和 **API 投稿**。视频平台需要本地成片；Pinterest 也可选择「图文」，按顺序勾选本地图片；Threads 选择「纯文字」，不要求或读取素材；公众号选择「文章」，需要本地封面，不读取成片。「发布准备」列出对应的文案、账号、素材和平台必填项；都齐全后才可点「检查并准备发布」。

也可以从内容档案顶部的 **准备发布** 进入同一个发布页。必填项齐全时，右侧会显示「发布信息已齐全，可以检查并准备发布」并启用检查按钮；缺项时列出原因，不会通过修改稿件状态来绕过校验。

点击后，工作台先保存当前编辑，Host 再读取文件、核对账号与适用分区并生成确认单，不发送素材、不创建远端稿件。只有在确认单里点 **确认投稿**，DSH Host 才会把素材直传给对应平台。确认单未提交前仍可返回修改；信息变化后需重新检查。未启用的平台仍可手动发布，独立页面预览不能投稿。

- **B 站**：选择二级分区和原创/转载；选转载时必填来源。使用已选成片、可选 JPEG/PNG 封面。
- **YouTube**：选择分区、可见性和受众；适用时声明合成内容。默认私密，不通知订阅者。可选本地 JPEG/PNG 缩略图（不超过 50 MB），视频处理成功后直传设置；公开视频可能先可见。视频回执与封面结果独立记录，封面失败或未知时去 Studio 补设/核对，不重新上传视频。[流程与边界](local-youtube-publishing-plan.md)。
- **Bluesky**：公开发布纯文字或 1–4 张本地 JPEG/PNG 图文，每张不超过 2 MB。使用 Bluesky App Password，图片直接上传至配置账号的 PDS；发帖前持久化 TID 回执，结果未知时按原记录查询，不自动重发。此入口暂不支持视频或独立封面。[配置与流程](local-bluesky-publishing.md)。
- **快手**：支持立即公开发布单条 MP4/MOV/WebM 视频（本地限制 100 MB、30 分钟）并要求本地 JPEG 封面（小于 10 MB）。快手官方上传网关使用未加密 HTTP，默认关闭，需在可信网络下显式启用 Host 开关；未知结果不自动重发。[配置、传输风险与流程](local-kuaishou-publishing.md)。
- **Facebook**：授权公共主页的 Reels、3–60 秒视频快拍、单张照片快拍、纯文字或 1–10 张本地 JPEG/PNG 普通图文，单张不超过 10 MB。快拍不发送标题、正文、话题或独立封面，展示期限由 Facebook 决定；照片快拍仅支持非 AI 图片（接口无 AI 声明字段）。快拍与 AI 动态需 Host 使用 Graph v27.0，既有 v25 Reels 不变。不支持个人账号或群组，需明确公开和 AI 声明，无分区、独立封面。普通动态先创建未发布草稿，持久化回执后才公开；快拍先持久化媒体回执再最终提交，未知不重投。[详细配置与流程](local-facebook-reels.md)。
- **Instagram Reels**：支持关联到 Facebook 公共主页的 Instagram 专业账号。选择是否分享到 Instagram 动态并声明 AI；仅 Reels 不是私密草稿。标题和话题会并入说明，无分区、不上传独立封面。[配置与流程](local-instagram-reels.md)。
- **抖音**：支持原创视频、可选封面；显式选择可见范围、下载权限和 AI 标识需求。需原生 AI 标识的作品改用官方发布器。[配置与流程](local-douyin-publishing.md)。
- **LinkedIn**：个人账号的公开视频、纯文字或 1–20 张本地图文，标题与话题并入说明；没有分区和独立封面，显式选择公开。视频逐片上传后等待 `AVAILABLE` 再创建帖子；图文保存异步回执并核对后续处理，不强加普通分享令牌无权执行的 Images GET。Posts 回查权限另受 `r_member_social` 准入限制。[配置与流程](local-linkedin-publishing.md)。
- **X**：公开账号的普通视频、纯文字或 1–4 张本地 JPEG/PNG 图文，每张图片不超过 5 MB。标题和话题并入正文，按官方文字权重校验；显式选择 AI 与付费合作声明，不上传独立封面。[配置与流程](local-x-publishing.md)。
- **Pinterest**：发布原创视频或图文 Pin 到本人公开画板；图文按选择顺序直传 1–5 张 JPEG/PNG，不需图床，不混入视频或独立封面。独立标题、说明和话题，明确选择公开、原创及两项 AI 声明。视频可选本地封面，不选时使用首帧。[配置与流程](local-pinterest-publishing.md)。
- **TikTok**：本机成片直传。按实时创作者权限选择可见范围和互动，确认原创、AI、商业内容及音乐/品牌政策；首帧封面。仅完成本地协议接入，应用须符合官方用途与审核要求，不保证内部账号上传工具可获批。[配置、限制与流程](local-tiktok-publishing.md)。
- **Threads**：只发原生纯文字，不需要公共素材链接，不读取已选视频/封面。标题与正文合并、最多一个原生话题，显式确认账号隐私、回复范围和 AI；图片/视频仍手动发布。[配置与范围](local-threads-publishing.md)。
- **微信公众号**：单篇 `news` 文章，必选本地封面，可通过正文标记插入最多 20 张不同的本地 JPEG/PNG 配图（每张小于 1 MB），只读准备、确认后直传微信并按位置插图。任意 HTML 仍转义，支持作者、摘要和评论权限；发表不是群发。需原生 AI/原创声明时走官方发布器。[权限、配置与范围](local-wechat-publishing.md)。
- **投稿记录**：提交后显示平台处理状态；具备可回查的回执时可点「查询平台状态」。查询失败保留已有记录；结果未知时先去平台创作中心核对，不自动重投，也不把整个稿件自动改为「已发布」。一篇稿件对应一个平台的首版入口不重复发送已确认或待核对的任务；确认失败的任务可以重新准备。

## 试用配置（Host 环境变量）

默认都关闭。拥有已获权限的自有平台应用和测试账号后，在 **DSH Host 进程的私有运行环境**里配置下表并重启 Host。插件不提供网页登录换码或凭据管理 UI；除公众号根据自有 AppID/AppSecret 向微信获取并缓存短期后台令牌外，其余平台需预先授权并提供有效访问令牌，过期由运维方更新。不要把值贴到聊天、提交到 Git、注入前端或放进同步文档。

| 平台 | Host 变量 | 说明 |
| --- | --- | --- |
| B 站 | `MEDIA_DESK_BILIBILI_PUBLISH=1`、`MEDIA_DESK_BILIBILI_CLIENT_ID`、`MEDIA_DESK_BILIBILI_CLIENT_SECRET`、`MEDIA_DESK_BILIBILI_ACCESS_TOKEN` | 自有开放平台应用，令牌对应要投稿的账号；应用需能查询账号、分区及投稿/回查。 |
| YouTube | `MEDIA_DESK_YOUTUBE_PUBLISH=1`、`MEDIA_DESK_YOUTUBE_CLIENT_ID`、`MEDIA_DESK_YOUTUBE_ACCESS_TOKEN`；可选 `MEDIA_DESK_YOUTUBE_REGION`（默认 `US`） | 自有 Google Cloud 应用，启用 YouTube Data API，令牌具备 `youtube.upload` 和 `youtube.readonly` 权限，且挂到目标频道。 |
| Facebook Reels | `MEDIA_DESK_FACEBOOK_PUBLISH=1`、`MEDIA_DESK_FACEBOOK_PAGE_ID`、`MEDIA_DESK_FACEBOOK_ACCESS_TOKEN`；可选 `MEDIA_DESK_FACEBOOK_GRAPH_VERSION`（默认 `v25.0`） | 自有 Meta 应用的 Page access token，须能在指定公共主页创建内容。授权与权限详见 [Facebook Reels](local-facebook-reels.md)。 |
| Instagram Reels | `MEDIA_DESK_INSTAGRAM_PUBLISH=1`、`MEDIA_DESK_INSTAGRAM_PAGE_ID`、`MEDIA_DESK_INSTAGRAM_ACCESS_TOKEN`；可选 `MEDIA_DESK_INSTAGRAM_GRAPH_VERSION`（默认 `v27.0`） | 自有 Meta 应用，经 Facebook 商业登录授权，目标为该主页关联的 Instagram 专业账号。详见 [Instagram Reels](local-instagram-reels.md)。 |
| 抖音 | `MEDIA_DESK_DOUYIN_PUBLISH=1`、`MEDIA_DESK_DOUYIN_OPEN_ID`、`MEDIA_DESK_DOUYIN_ACCESS_TOKEN` | 自有抖音应用，开通「代替用户发布内容到抖音」，目标账号授权 `video.create.bind`、`user_info`。详见 [抖音](local-douyin-publishing.md)。 |
| LinkedIn | `MEDIA_DESK_LINKEDIN_PUBLISH=1`、`MEDIA_DESK_LINKEDIN_MEMBER_ID`、`MEDIA_DESK_LINKEDIN_ACCESS_TOKEN`；可选 `MEDIA_DESK_LINKEDIN_API_VERSION`（默认 `202611`） | 自有 LinkedIn 应用，用户授权 `openid`、`profile`、`w_member_social`，账号 ID 为 userinfo 的 `sub`。详见 [LinkedIn](local-linkedin-publishing.md)。 |
| X | `MEDIA_DESK_X_PUBLISH=1`、`MEDIA_DESK_X_USER_ID`、`MEDIA_DESK_X_ACCESS_TOKEN` | 自有 X 应用，公开用户账号授权 `tweet.read`、`users.read`、`tweet.write`、`media.write`。详见 [X](local-x-publishing.md)。 |
| Pinterest | `MEDIA_DESK_PINTEREST_PUBLISH=1`、`MEDIA_DESK_PINTEREST_USER_ID`、`MEDIA_DESK_PINTEREST_ACCESS_TOKEN` | 自有 Pinterest 应用，用户授权 `user_accounts:read`、`boards:read`、`pins:read`、`pins:write`，只发本人公开画板。详见 [Pinterest](local-pinterest-publishing.md)。 |
| TikTok | `MEDIA_DESK_TIKTOK_PUBLISH=1`、`MEDIA_DESK_TIKTOK_OPEN_ID`、`MEDIA_DESK_TIKTOK_ACCESS_TOKEN` | 自有 TikTok 应用，授权 `user.info.basic`、`video.publish`。公开发布需审核；本机 `FILE_UPLOAD`，不适用于已放在远程 Host 文件服务的素材。详见 [用途与准入限制](local-tiktok-publishing.md)。 |
| Threads | `MEDIA_DESK_THREADS_PUBLISH=1`、`MEDIA_DESK_THREADS_USER_ID`、`MEDIA_DESK_THREADS_ACCESS_TOKEN` | 自有 Meta Threads 应用，授权 `threads_basic`、`threads_content_publish`，未获高级访问时限应用测试账号。这里只接纯文字。详见 [Threads](local-threads-publishing.md)。 |
| 微信公众号 | `MEDIA_DESK_WECHAT_PUBLISH=1`、`MEDIA_DESK_WECHAT_CLIENT_ID`、`MEDIA_DESK_WECHAT_CLIENT_SECRET` | 自有公众号 AppID/AppSecret，不使用网页 OAuth 令牌或 AiToEarn Key。需账号认证、接口权限及微信要求的出口 IP 白名单，详见 [公众号](local-wechat-publishing.md)。 |

填入配置不代表平台已经给出投稿权限。真正启用前先运行账号查询、再用测试短片经人工确认联调。YouTube 第一次建议保持「私密」，按回查确认实际可见性；B 站查看创作中心回执及审核。除官方 OAuth 和投稿 API 外不需要 AiToEarn 账号、服务、API Key、公共素材链接或扩展。Host 跑在远程机器时，直传走的是该 Host 的文件和网络。

## 实现边界

- `src/publish/service.js` 是 Host 编排入口；`platforms.js` 按平台投影账号/分区和投稿参数，`snapshot.js` 固定本地素材。平台 HTTP/签名继续留在各自目录。接口复用 DSH 连接鉴权和写入同源约束，`prepare`、`start`、`review` 独立于助手和普通编辑接口。
- 确认单包含当时的修订号、实际要发的文案和素材摘要，图文保留已选图片顺序。提交时重新核对账号、适用分区、草稿和文件指纹；若变化，要求重新检查。发布视频、图片及封面复制到 Host 的私有临时目录后再直传，并在任务结束清理；强制退出时临时副本可能由操作系统稍后清理。
- 发布记录保存在内容目录下的 `.publish-records.json`，不含令牌、上传会话或素材字节。复用 Store 跨 Host 文件锁，原子写入任务及最终提交检查点，不在网络请求期间持有锁。重启不会重放任何任务；中断未收到回执的尝试在超时后提示去平台核对。正在投稿时阻止迁移目录，已完成记录随内容目录迁移。
- 仍未实现的部分：网页 OAuth 回调与令牌自动刷新、人工核对后解除未知任务、预约、批量发帖。真实应用和账号的联调不在自动化测试中。

协议与复用细节：[B 站](local-bilibili-publishing-plan.md) · [YouTube](local-youtube-publishing-plan.md) · [Facebook](local-facebook-reels.md) · [Instagram Reels](local-instagram-reels.md) · [抖音](local-douyin-publishing.md) · [LinkedIn](local-linkedin-publishing.md) · [X](local-x-publishing.md) · [Pinterest](local-pinterest-publishing.md) · [TikTok](local-tiktok-publishing.md) · [Threads](local-threads-publishing.md) · [微信公众号](local-wechat-publishing.md)。

## 后续接入边界

仍按 AiToEarn 固定基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558` 核对，不能把平台目录存在当作已具备可复用 API 投稿能力：

- **小红书**：基线 `rednote/rednote-publish.provider.ts` 只接收已发布的 `workLink` 并解析作品信息，`rednote.constants.ts` 为插件授权；不是可移植的官方 API 发帖流程。保持手动发布，不新增空壳 API 入口。
- **Google Business**：基线只有账号/门店读取，常量中的 `contentLimits.modes=[]`，未找到投稿 provider。不为了增加平台数量另造一个未验证的发布实现。
- **快手**：基线 `kwai.service.ts` 的片段上传/完成 URL 使用 HTTP，公开用户信息查询未提供可核对的稳定账号 ID。尚未证明安全 HTTPS 直传与原账号核对，不能静默降级明文上传或只凭昵称判定账号。

上面三项未接通，不宣称已经完成全平台。已接平台也只对本文列明的类型开放 API：例如 Threads 图片/视频需要公共素材 URL 的路径不满足当前「不使用图床/第三方中转」约束，仍为手动；其他可本地直传的内容类型再逐项核对和接入。自动化验证只能证明本地流程，不替代真实应用权限和测试账号的人工联调。
