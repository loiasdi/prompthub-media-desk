# 抖音视频：DSH Host 本地直传

## 启用前

首版只覆盖自有或明确授权账号的原创视频投稿，不接图文、定时、批量、第三方转载、音乐和挂载。需要平台原生 AI 标识的作品，使用工作台的手动发布方式，在抖音官方发布器里完成标识；此入口不把普通文案当作平台声明。

在抖音开放平台用自有应用申请「代替用户发布内容到抖音」能力（应用详情 → 能力管理 → 能力实验室），并由目标抖音账号授权 `video.create.bind`（上传和创建视频）及 `user_info`（核对投稿账号）。平台授予能力及接受账号授权后，再把同一个 OAuth 授权响应中的用户 `open_id` 和有效的用户 `access_token` 配给 DSH Host：

| 变量 | 用途 |
| --- | --- |
| `MEDIA_DESK_DOUYIN_PUBLISH=1` | 显式启用，默认关闭 |
| `MEDIA_DESK_DOUYIN_OPEN_ID` | 同一应用下、与用户令牌配套的账号 Open ID，不是主页抖音号 |
| `MEDIA_DESK_DOUYIN_ACCESS_TOKEN` | 授权用户令牌，不是 `client_token` 或 AiToEarn API Key |

重启 Host 后生效。保持凭据仅在 Host 私有环境，不放进工作区、部署给浏览器或提交到 Git。此版本不代理 OAuth 登录或自动续期。账号核验成功不等于有投稿权限；测试使用模拟响应，没有用真实账号验证开放平台审批或投稿。

## 在工作台使用

1. 稿件 → 发布，选择「抖音」「视频」「API 投稿」。选择稿件中的本地成片，封面可选。首版接收 MP4 / WebM、最长 15 分钟，视频按本地策略限 100 MB；封面为不超过 10 MiB 的 JPEG / PNG。
2. 填标题、说明和话题，确认原创，显式选择公开 / 仅自己 / 好友可见、是否允许下载、是否需要 AI 标识。标题、说明、话题会合成一个发布说明，合计不超过 1,000 字符。
3. 清单齐全后点「检查并准备发布」。Host 核对账号、草稿和素材，显示确认单；不会上传或创建作品。确认单展示实际发送的说明、选定的视频和封面以及可见范围。更换选材或参数后需重新检查。
4. 只有点「确认投稿」，Host 才将已确认的本地视频和可选封面发送到 `https://open.douyin.com`。不经过 AiToEarn 云端，不依赖插件、扫码、公共素材链接或中转存储。
5. 收到回执后进入「平台处理中」，不是已经公开。公开投稿若返回了数值型作品 ID，可点「查询平台状态」，仅在平台接口确认可播放时显示公开作品链接。非公开、无公开视频 ID，或接口尚查不到时，直接去抖音创作中心核对。最终提交断线且无回执时标记结果未知，不自动重投。

## 结构和原始资料

`src/publish/douyin/` 只放抖音适配器，复用统一的账号校验、确认单、素材快照和投稿记录。`upload_video`、`upload_image`、`create_video` 的字段和正文拼接复用 AiToEarn `douyin.service.ts`（`11dd1957d0c69ae2b27a0b8a47acdf6675715558`，MIT 声明随适配器发布）；没有移植其扫码分享 provider。Host 对 50 MB 以内的视频流式单传，更大的视频按分片接口上传：初始化、顺序上传、完成分片。创建作品前写入持久化提交检查点，收到成功回执才记录待审核。上传文件的加密 `video_id`、投稿回执 `item_id` 和公开作品 ID 分开处理，不保留上传会话，也不执行平台返回的 iframe HTML。

官方协议参考（核对日期：2026-11-18）：[账号信息](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-account-open-info) · [上传视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video) · [初始化分片](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload-init) · [上传分片](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload) · [完成分片](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-part-upload-complete) · [上传图片](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-image-text/image-upload) · [创建视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create) · [验证公开视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/iframe-player/get-iframe-by-video)。
