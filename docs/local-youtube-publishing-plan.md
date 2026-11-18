# MediaDesk 本地投稿：YouTube 适配器

> 已实现协议适配器和离线测试；未接 DSH Host 路由、OAuth 回调、凭据持久化、发布按钮或任务存储。未使用真实 Google 账号投稿。B 站仍是首个联调候选，两者可独立测试和启用。

## 范围和复用来源

第二个平台选择 YouTube。复用 AiToEarn [`11dd1957`](https://github.com/yikart/AiToEarn/tree/11dd1957d0c69ae2b27a0b8a47acdf6675715558) 下 `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/youtube/` 的 `youtube.service.ts`、`youtube-auth.provider.ts` 和 `youtube-publish.provider.ts` 中的 OAuth、`videos.insert` 参数、频道/分区核对与作品回查流程。MIT 声明在 `src/publish/youtube/UPSTREAM-LICENSE.txt`。

上游从媒体 URL 获取视频流，再交给 Google API SDK。MediaDesk 保留官方接口与字段，换成 Host 私有快照的文件流和原生 `fetch`；不引入 AiToEarn 云端、密钥、自部署、扩展、公共素材链接、Google SDK 或新运行时依赖。素材只发送给 YouTube 官方上传端点。

本阶段支持单个本地视频、标题、简介、标签、分区、可见性、受众声明、可选合成内容声明；可见性默认私密，默认不通知订阅者。不支持自定义缩略图、预约、批量和修改/删除远端作品。传入封面或预约参数会报错，不静默忽略。

## 模块及执行顺序

| 模块 | 职责 |
| --- | --- |
| `src/publish/youtube/index.js` | Host 使用的唯一入口 `createYouTubeAdapter()`，提供授权、账号、分区、`submit()` 和 `review()`；和 B 站使用相同的目录分工，平台参数不硬凑成相同字段。 |
| `src/publish/youtube/client.js` | OAuth、官方 HTTP、上传会话地址校验、请求超时与脱敏错误。 |
| `src/publish/youtube/publish.js` | 频道校验、选项/媒体校验、投稿编排及回查映射。 |
| `src/publish/local-source.js`、`src/publish/errors.js` | 两个平台共用私有快照的文件流和错误契约。 |

1. 校验本地输入。用 `channels.list(mine=true)` 确认令牌只对应已选频道，用 `videoCategories.list` 核对投稿分区可用。Google 令牌决定实际投稿频道，不靠向投稿接口透传目标频道 ID 来切换账号。
2. `videos.insert` 创建 resumable 上传会话，传元数据和媒体尺寸；只接受文档示例所用的 Google API HTTPS 上传地址。禁用 HTTP 跳转，不向其他地址转发访问令牌和视频。
3. 调用方通过 `beforeSubmit({ privacyStatus })` 将生效的可见性和投稿检查点一起落盘后，才向新会话发出一个流式 PUT。仅当此次首次 PUT 的 HTTP 404 响应明确说明上传会话已失效或不存在时，才记为 `failed`。普通 404、断线、不完整或回执缺失仍记为 `unknown`，先在 YouTube Studio 核对。两种情况都不自动重投；上传会话 URL 不回显、不写业务日志。
4. 返回的有效视频 ID 作为 `receiptId`。回查必须显式传入检查点保存的可见性，不再默认私密。通过 `videos.list` 核对回执、所属频道、处理状态和原确认的可见性。只有 `processed` 且可见性匹配才算交付成功；结果保留实际 `privacyStatus`。回查请求错误以 `stage: 'review', outcome: 'unknown'` 返回，Host 应保留已有回执和任务状态，单独记录查询错误，不据此开放重新投稿。私密成功不提供公开作品链接，非公开列出（`unlisted`）的链接也不代表会出现在搜索或频道列表中。Host 应显示实际可见性，不把私密成功写成「已公开」。

## 接 DSH 前的验收

- 用户自备启用 YouTube Data API v3 的 Google Cloud 项目及 Desktop App OAuth 客户端。适配器只接受本机 loopback 回调，使用 S256 PKCE，并请求上传和读取所需权限。未来由 Host 生成并绑定一次性 `state` 与 PKCE verifier，完成回调和安全存储；不把凭据嵌进插件产物。远程 DSH Web 不是这个 loopback 流程的支持场景，需另行设计。
- 核对测试账号、项目限制和配额，以自备项目实际返回为准。先经人工确认上传自有短片，默认私密，验证频道、处理状态、可见性和回执；再单独验证需要的其他可见性。网络请求不得访问 AiToEarn。未通过时不显示自动投稿入口，现有手动路径不变。
- 命令 `node --test test/publish-youtube.test.js` 覆盖 OAuth、频道、分区、直传、会话地址、检查点、回查和不重投；`npm test && npm run build` 用于全量回归。

官方参考：[桌面应用 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[创建视频](https://developers.google.com/youtube/v3/docs/videos/insert)、[上传会话协议](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)、[视频资源与状态](https://developers.google.com/youtube/v3/docs/videos)。
