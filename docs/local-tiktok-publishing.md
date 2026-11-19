# TikTok 本机视频 Direct Post

## 先确认用途与准入，不是配个令牌就能公开发布

本轮完成本地适配器、统一 UI 和离线验证，不代表 TikTok 已批准本项目或用户应用。默认关闭，没有用真实账号发帖。

官方 Direct Post 开发指南明确要求应用面向广泛创作者，不接受只给自己或团队管理账号上传的内部工具，也不接受搬运其他平台任意内容。本插件必须按实际面向创作者的产品用途申请；若目的仅是个人/团队内部上传，不能靠接入代码或自备令牌绕过此限制，应使用官方发布器。

未审核应用只能在官方允许的测试范围内使用 `SELF_ONLY`，且测试账号本身须按官方要求设为私密；审核通过也仍受创作者和发布配额限制。不能把 `creator_info` 返回「公开」选项当作应用已通过审核的证据。

`FILE_UPLOAD` 仅用于用户设备上的成片；本入口要求 DSH Host 运行在保存素材的用户本机。若素材已经在远程 Host 的服务端文件存储，官方要求改用已验证域名的 `PULL_FROM_URL`，不应启用此入口。本项目没有为此引入公共素材服务、AiToEarn CDN 或外链模式。

## Host 配置

使用自有应用的有效用户访问令牌，目标用户授权 `user.info.basic` 和 `video.publish`；不是客户端令牌，也不是 AiToEarn Key。私有进程环境配置后重启 DSH Host：

| 变量 | 用途 |
| --- | --- |
| `MEDIA_DESK_TIKTOK_PUBLISH=1` | 显式启用；默认关闭 |
| `MEDIA_DESK_TIKTOK_OPEN_ID` | 该应用下 `/v2/user/info/` 返回的 `open_id`，不是用户名 |
| `MEDIA_DESK_TIKTOK_ACCESS_TOKEN` | 同一用户的有效访问令牌 |

当前不含网页登录换码和自动续期。令牌只在 Host，不能粘贴到聊天、同步文档或 Git。每次准备、开始投稿及初始化前核对账号和最新创作者权限。

## 统一发布页

1. 非示例稿件 → 发布 → TikTok → 视频 → API 投稿，选择该稿件本机归档的 MP4、MOV 或 WebM 成片。标题、说明和话题合并为实际 caption，按 2,200 UTF-16 单元校验。
2. 显示最新创作者昵称及账号名，可见范围仅列出最新 `privacy_level_options`，无默认选择。勾选互动才会开启评论、合拍或拼接；默认全部关闭，平台禁用项显示灰色。
3. 视频必须有已读取到的有效时长，至少 3 秒，不能超过该账号的 `max_video_post_duration_sec`。未读取到时长请安装可用 ffprobe 并重新导入，不将未知时长视为已通过。已知帧率校验 23–60，宽高 360–4096；API 投稿文件上限 250 MB。编码仍由平台最终校验。
4. 确认原创、AI 生成或编辑声明。商业内容开关默认关闭；开启后至少选「自己的品牌」「第三方品牌」之一，可两者都选。自己的品牌提示推广内容，第三方品牌提示付费合作且不能设为仅自己可见。
5. 发布前显示并要求确认音乐使用条款；第三方品牌还须确认品牌内容政策。最终确认单再次显示政策链接、实际 caption 和全部设置。未选择独立封面，使用视频首帧。
6. 信息齐全后点击「检查并准备发布」：先保存编辑，只读取账号与权限并核验本地文件，不初始化、不上传、不发帖。文案、素材或账号/权限变化，旧确认单失效。
7. 「确认投稿」后固定私有快照，重新读取最新权限，写入最终提交检查点，再初始化 `FILE_UPLOAD`。拿到 `publish_id` 后先持久化回执，然后才传视频。响应上传成功只表示平台处理中，不等于发布完成；提示等待数分钟。
8. 点击「查询平台状态」查询该回执。`PUBLISH_COMPLETE` 才记为完成；非公开或尚未返回公开作品 ID 时不伪造作品链接，可打开 TikTok 核对。API 返回公开作品 ID 时保留 int64 精度，结合此次投稿保存的用户名生成链接；用户名后续更改可在平台查找。回查不依赖可继续发帖的权限，达到发布配额后仍可尝试查询原回执。

## 协议、状态与防重投

- 固定 `https://open.tiktokapis.com/v2`：`GET /user/info/`，只读 `POST /post/publish/creator_info/query/`，`POST /post/publish/video/init/`，只读 `POST /post/publish/status/fetch/`。只读查询采用 POST 并不创建远端稿件。
- Direct Post 初始化即是有副作用的步骤，因此在初始化前持久化 `submissionStarted`，收到回执后再持久化一次。此后即使最后一个上传分片断线也不会丢掉已收到的回执或自动重投。
- 视频仅流式 PUT 到官方文档给出的 `open-upload.tiktokapis.com/video/` 或 `upload.us.tiktokapis.com/video/`，保留官方 `upload_id`、`upload_token`，不附带 OAuth Header、不跟随跳转。其他域名/参数先拒绝，不向任意外部地址发送素材。
- 以 10,000,000 字节为分片基准，数量向下取整，尾部并入最后一片；小文件整片发送。依次发送准确 `Content-Length` / `Content-Range`，中间片需 HTTP 206，最后一片需 201。不整体读取视频、不自动重传分片。
- 上传完成保留 `pending_review`；`PROCESSING_UPLOAD` / `PROCESSING_DOWNLOAD` 表示处理中，`PUBLISH_COMPLETE` 表示完成，`FAILED` 表示平台明确拒绝。非本流程的 inbox 状态、未知状态或查询失败保留原记录。
- 初始化明确拒绝可重新准备；初始化结果不确定、上传出错等先记为未知并禁止重投。有回执可查询，没有回执则到平台人工核对。重启不会重放任务。
- 复用现有 Host `service.js`、快照、跨 Host 锁和投稿记录；不存令牌、上传地址、分片或原始响应。前端没有改 API 地址、指定其他作者或注入令牌的入口。

## 复用与验证

参考 AiToEarn 基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558` 的 `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/tiktok/tiktok.service.ts`、`tiktok-publish.provider.ts`。保留 `src/publish/tiktok/UPSTREAM-LICENSE.txt`，复用其 creator → init → upload → status 流程，移除素材外链与云服务依赖。首版不包含图片、inbox 草稿、定时、批量和刷新令牌。

自动测试和浏览器 smoke 全部 mock 平台 API，涵盖实时权限、双检查点、断线上传、防重投、原始 int64 作品 ID、政策声明和回查；没有真实平台联调。

官方依据（核对日期 2026-11-18）：[开发与 UX 要求](https://developers.tiktok.com/doc/content-sharing-guidelines)、[创作者权限](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info)、[Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)、[媒体传输](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)、[状态回查](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status)、[用户身份](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info)。
