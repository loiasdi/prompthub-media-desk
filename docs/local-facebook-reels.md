# Facebook 公共主页：Reels、视频快拍与文字/图文动态本地直传

## 开始前

此适配器支持向授权的 **Facebook 公共主页（Page）** 公开发布 Reels、视频快拍（Story）、照片快拍、纯文字动态和 1–10 张本地图文。不支持个人账号、群组或预约发布。照片快拍仅支持单张本地 JPEG/PNG，且接口没有 AI 声明字段，因此 AI 生成或编辑的照片必须改用 Facebook 官方发布器。不支持把照片快拍的标题、正文或话题发送到平台。使用对应 **Page access token**，不是用户令牌或应用令牌。启用前先获取自有 Meta 应用授权，按应用模式、账号和接口需要完成审核与权限配置。本项目不提供 Meta 登录换码或令牌自动刷新。

Reels 需要操作者能在目标 Page 执行 `CREATE_CONTENT`，应用获得 `pages_show_list`、`pages_read_engagement`、`pages_manage_posts`。普通动态按官方 Pages Posts 指南检查 `CREATE_CONTENT`、`MANAGE`、`MODERATE` 任务，以及 `pages_manage_engagement`、`pages_manage_posts`、`pages_read_engagement`、`pages_read_user_engagement`；图片上传参考还列出 `pages_show_list`。视频接口另受 `publish_video` 等权限要求约束，不能以插件已配置推断应用已经获得所有权限。

在 DSH **Host 的私有环境**设置下面变量，之后重启 Host。不要把令牌写进稿件、Git 或前端配置：

| 变量 | 作用 |
| --- | --- |
| `MEDIA_DESK_FACEBOOK_PUBLISH=1` | 启用，默认关闭 |
| `MEDIA_DESK_FACEBOOK_PAGE_ID` | 目标公共主页的数字 ID；Host 校验令牌的 `/me` 身份与之匹配 |
| `MEDIA_DESK_FACEBOOK_ACCESS_TOKEN` | 上述公共主页的 Page access token |
| `MEDIA_DESK_FACEBOOK_GRAPH_VERSION` | 默认仍为 `v25.0`，保留既有 Reels 行为；**视频快拍、AI 文字/图文动态设为 `v27.0`**，升级后重新核对账号并联调。此处不宣称最新版本 |

## 视频：Reels 发布与回查

1. 打开普通稿件 → **发布 → Facebook → API 投稿**。选本地 MP4（推荐）或 MOV 成片，填标题、简介、话题；话题作为 `#标签` 附加到简介。API 发布的成片上限为 **250 MB**。导入已读取媒体信息时，准备清单会验证 9:16、至少 540×960、24–60 fps、3–90 秒。不重编码、不传独立封面；旧导入缺少媒体信息时，剩余格式校验由 Meta 执行。建议以 H.264/AAC MP4 联调。
2. 显式选择「公开」，声明是否使用 AI 生成或编辑。点「检查并准备发布」，核对目标公共主页、公开范围、文案和成片。这一步不调用上传或发布接口。
3. 点「确认投稿」后才开始向 Meta 发送数据。`graph.facebook.com` 初始化会话 → `rupload.facebook.com` 以 HTTPS 接收本地文件流 → `graph.facebook.com` 提交 `PUBLISHED` 与 AI 声明。支持 Meta 文档两种上传地址形式；域名、路径、版本和视频 ID 均校验，不跟随跳转，不向 AiToEarn/第三方网盘上载。
4. 提交后可点击「查询平台状态」。编码 `ready` 不代表已公开；只有回查确认 publishing 阶段公开完成才显示作品链接。上传完成后会在最终提交前保存视频 ID；如果提交响应丢失，可凭该回执回查，不能自动重投。回查异常时保留已有记录，可去 Meta Business Suite 人工核对。

## 视频：快拍（Story）发布与回查

1. 沿用 **发布 → Facebook → 视频 → API 投稿**，在「视频发布位置」选择「视频快拍（Story）」。默认仍是 Reels，不会把既有稿件静默改成快拍。Host 的 `storySupported` 能力由配置的 Graph 版本推导；当前入口只对 v27.0 及以上开放，旧版本的选项禁用，Host 同样拦截。无需新增 AiToEarn 账号、Key、云服务或浏览器插件。
2. 选择 **3–60 秒的本地 MP4**，API 发布的成片上限为 250 MB。时长、宽、高和帧率元数据都必须可读，缺失不能绕过；按 9:16、至少 540×960、24–60 fps 验证，编码与其余平台规格由 Meta 校验，不替用户重编码。显式确认公开和 AI 声明。上游 `facebook.service.ts::publishVideoStory` 的会话、直传和最终提交顺序可复用，URL 来源改成 Host 的私有快照文件流。
3. **快拍不附带标题、正文、话题或独立封面。** 这些文案只留在本地记录；需要展示的文字必须制作在视频中。参数提示和确认单明确说明这一点，确认单将标题标为「本地记录标题（不发送）」，不假装正文已经发送。
4. 准备只读。人工确认后才核对 `/me` → `POST /{page-id}/video_stories`，`upload_phase=start` → 校验官方 `rupload.facebook.com/video-upload/{version}/{video-id}` → 以 `OAuth`、`offset=0`、真实 `file_size`/`Content-Length` 上传本地流。每次初始化新媒体，不复用已发布的视频 ID；官方不允许用已发过帖的媒体创建 Story。
5. 上传确认 `success=true` 后再次核对 Page，将视频 ID 和最终提交检查点先写入原有 `.publish-records.json`；然后向同一个 `video_stories` 发出唯一一次 `upload_phase=finish`，参数只有 `video_id` 与同次 `is_ai_generated`。不发送 Reel 专用 `video_state`、文字或上游未在当前指南列出的 `content_category`。要求 `success=true` 和有效 `post_id`；支持官方示例的安全整数和完整数字字符串，不舍入不安全 JSON 数字，复合帖子 ID 必须归属当前 Page。视频 ID 作为回查回执，帖子 ID 单独持久化。
6. 响应丢失、回执不完整或公开结果未知时，保留视频 ID、锁定重投，不自动重发 finish，也不因封装错误回退成 Reels。重启后仍可只读 `GET /{video-id}?fields=id,status`；只有 publishing 阶段已完成且 `publish_status=published` 才确认已发布，`ready` 仅代表转码就绪。不能把 Story 构造成 `/reel/…` 链接，提供公共主页/Meta Business Suite 人工核对入口。快拍有平台展示期限，`expired` 不等于拒稿或可重新投稿；回查请求失败保留原状态与回执。

准入按 [Meta Stories API 指南](https://developers.facebook.com/docs/page-stories-api/) 核对：操作者的 `CREATE_CONTENT` 任务与 `pages_manage_posts`、`pages_read_engagement`、`pages_show_list`；使用 business system user 时另需 `business_management`。2026-11-18 获取的官方 v27 示例明确支持本地字节上传、最长 60 秒、finish 同次 `is_ai_generated`、视频状态回查。接口接入和 mock 测试不代表真实应用已取得这些权限。

## 照片：快拍（Story）发布与回查

1. 选择 **Facebook → 图文 → 照片快拍（Story）**。此入口只接受一张本地 JPEG/PNG，图片不超过 10 MB；视频、独立封面和多图均不支持。需使用 Graph v27.0 或更高版本；普通动态仍默认选中，不会自动切换。
2. 明确确认公开发布并声明是否使用 AI。若声明为 AI 生成或编辑，准备校验会阻止 API 投稿，因为 `photo_stories` 请求没有对应 AI 声明字段；请改走 Facebook 官方发布器。
3. 标题、正文和话题只保存在本地投稿记录，不会随照片快拍发送。确认单会列出实际媒体和「不发送文字说明」，并提示快拍展示期限由 Facebook 决定。
4. 人工确认后先将照片以 `published=false` 上传至 `/{page-id}/photos`，保存图片 ID 检查点，再调用 `/{page-id}/photo_stories`。之后通过 `/{page-id}/stories` 按照片 `media_id`、`media_type=photo`、作品 `post_id` 和 `PUBLISHED` 状态回查。回执丢失时只回查、不自动重发；重复或冲突记录返回未知状态。只展示通过 Facebook HTTPS 域名和 Stories 路径校验的平台原生链接。

回归命令：`node --test test/publish-facebook-story.test.js test/publish-facebook-feed.test.js test/publish-readiness.test.js`；`npm test && npm run build` 验证全量。包括只读准备、素材/修订变化、私有快照、回执持久化、AI 字段、版本限制、不安全地址/数字、账号变化、未知防重、回查与过期场景。没有真实发帖。

## 纯文字与图文：普通动态

在同一个发布页选择 **Facebook → 纯文字 / 图文 → API 投稿**，显式确认公开范围和 AI 声明。图文按选择顺序上传 1–10 张本地 JPEG/PNG，单张不超过 **10,000,000 bytes（10 MB）**；不接受公共素材 URL、图床、远程视频或独立封面。纯文字完全不读取残留选材。标题、正文和话题合成同一条 `message`，与确认单一致；合并后不超过本地 16,000 UTF-8 字节限制，该值不是平台最大字数声明。

「检查并准备发布」仍只读取本地文件、核对账号和生成确认单，不创建远端草稿。只有人工「确认投稿」之后才执行：

1. 图文依次 `POST /{page-id}/photos`，以 `multipart/form-data` 的 `source` 字段流式发送本地文件，真实 MIME、固定文件名、精确 Content-Length，且每张都设置 **`published=false`**。纯文字跳过此步。
2. `POST /{page-id}/feed` 创建 **`published=false`** 的未发布动态。图文使用有序 `attached_media[0]`、`attached_media[1]`…，每项引用前一步的 `media_fbid`，不把素材转成 URL。
3. 校验复合回执 `{page-id}_{post-id}` 归属固定 Page，并将它持久化到现有投稿记录。回查草稿的 `id,from,is_published,is_hidden`，只有未发表、未隐藏且作者匹配时才继续；再核对 `/me`，避免长时间上传后账号变化。
4. `POST /{page-id}_{post-id}` 设置 **`is_published=true`**。v27 同一次请求设置 `is_ai_generated`，不会先公开再补标签。v25 的官方 Page Post 更新参数没有该字段，选择 AI 动态时准备清单和 Host 均阻止，提示配置 v27 或改用官方发布器；非 AI 动态可继续使用 v25，不向它发送未知参数。
5. 收到 `success=true` 只记为「平台处理中」，不立即宣称已公开。后续回查同时确认回执、Page 作者、`is_published=true` 和 `is_hidden=false`，才显示从已校验数字 ID 构造的安全作品链接。插件验证发往平台的图片顺序，不声称逐字节核对 Facebook 重编码后的远端图片。

所有请求仅发往固定 HTTPS Graph API，使用 Bearer，不跟随重定向。**这不是本地草稿模式**：确认投稿后会在 Facebook 创建未发布媒体与动态，最终目的是公开发布。部分上传/草稿操作失败可能留下官方未发布素材或草稿；本入口不自动删除。公开请求发出后如果响应丢失，保留回执并锁定重投，先在线回查或到官方核对，不能因为本地超时就再发一次。

## 复用与验证

- 复用 AiToEarn `11dd1957d0c69ae2b27a0b8a47acdf6675715558` 的 `facebook.service.ts` / `facebook-publish.provider.ts` 中 Reels、`publishVideoStory` 和 Feed/多图附加流程，保留 MIT 声明。上游的 `videoUrl`/图片 URL 改为本地文件流；普通动态补上未发布草稿与最终提交检查点，不引入其账户、云素材和任务系统。
- [Meta Reels Publishing API](https://developers.facebook.com/docs/video-api/guides/reels-publishing/) · [Page Stories API](https://developers.facebook.com/docs/page-stories-api/) · [Page Video Reels 参数](https://developers.facebook.com/docs/graph-api/reference/page/video_reels/)。规格、配额、内容政策和授权由 Meta 决定。
- [Pages Posts](https://developers.facebook.com/documentation/pages-api/posts/) · [Page Feed / 未发布动态](https://developers.facebook.com/docs/graph-api/reference/page/feed/?locale=en_US) · [Page Photos / 本地 multipart](https://developers.facebook.com/docs/graph-api/reference/page/photos/?locale=en_US) · [v27 Page Post 更新参数](https://developers.facebook.com/docs/graph-api/reference/v27.0/page-post/?locale=en_US) / [v25 参数对照](https://developers.facebook.com/docs/graph-api/reference/v25.0/page-post/?locale=en_US)。2026-11-18 核对；图片尺寸采用英文版的 10 MB（部分本地化页面仍显示旧 4 MB），PNG 的 1 MB 是清晰度建议，不作为硬性拒绝条件。
- 自动化使用模拟平台响应，不能证明应用已通过 Meta 审核或真实账号有发帖权限。实际联调建议使用专门的测试 Page 和可公开的自有短片；本入口没有「仅自己可见」模式。
