# Bluesky 本地 API 投稿

DSH Host 使用配置的 Bluesky App Password 登录账号，通过账号所属 PDS 的 AT Protocol XRPC 接口发布。发布页只准备并展示确认单；只有用户点击「确认投稿」后才登录、上传图片和创建公开帖子。不会经 AiToEarn、DSH 云端或其他媒体代理中转。

## Host 配置

在运行 DSH Host 的环境中设置：

```sh
MEDIA_DESK_BLUESKY_PUBLISH=1
MEDIA_DESK_BLUESKY_DID=did:plc:...
MEDIA_DESK_BLUESKY_HANDLE=your-handle.bsky.social
MEDIA_DESK_BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

默认 PDS 为 `https://bsky.social`。使用其他 PDS 时，可选设置 `MEDIA_DESK_BLUESKY_PDS_URL=https://pds.example`。仅允许 HTTPS 公网主机，Host 会在请求前验证目标并拒绝 HTTP 重定向。App Password 应在 Bluesky 账号安全设置中单独创建，不要使用主账号密码；凭据仅由本机 Host 读取，不发送到浏览器。

配置后重启 Host，再在稿件的「发布」页选择 Bluesky 与「纯文字」或「图文」。准备清单会校验账号配置、公开可见性、文案和图片；齐全后点「检查并准备发布」，复核确认单，再点「确认投稿」。

## 支持范围

- 公开纯文字，或 1–4 张本地 JPEG/PNG 图文；每张图片不超过 2,000,000 字节。
- 标题、说明、话题合并后最多 300 个字素。话题会作为正文中的原生 `#tag` 发布；正文内 HTTP(S) 链接和话题会生成 AT Protocol facets。
- 图片由 DSH Host 从本地暂存文件流式直传到 PDS，然后在帖子记录中引用 PDS 返回的 Blob。图片不经第三方存储。
- 不支持视频、单独封面、排期和非公开可见性。AI 声明如有需要，需自行写入正文。

## 回执与故障处理

创建帖子前，Host 会将确定的 AT URI（含 TID record key）写入本地发布记录。若创建请求的响应丢失或回执不完整，任务进入未知状态；请先在发布记录中回查同一 AT URI 或打开 Bluesky 检查，不要重新创建另一条帖子。图片上传失败不会自动重发帖子。

`MEDIA_DESK_BLUESKY_PUBLISH` 未设为 `1`、DID/Handle/App Password 无效或 Host 未重启时，发布页不会将 Bluesky 显示为已配置。配置错误不会在浏览器或发布记录中回显 App Password。

CogSend 的 MIT 许可代码曾作为协议与流程参考；本适配器独立实现直连本机 Host 到 PDS，不依赖 CogSend 服务端或其媒体托管。
