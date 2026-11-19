# 快手本地 API 投稿

DSH Host 通过快手开放平台的视频接口发布单条公开作品。素材由 Host 从本地暂存文件流式读取，按快手返回的上传网关直传；不经过 AiToEarn、DSH 云端或第三方存储。

## 重要传输限制

快手官方创建视频文档给出的动态上传网关使用 `http://{endpoint}`，不是 HTTPS。视频分片和短期 `upload_token` 因而以明文经过当前网络；创建/查询作品接口则使用 HTTPS。Host 会拒绝非 `gifshow.com` 域名、非公网解析及跳转，但这些校验不能加密 HTTP 流量，也不能防止受控网络上的监听或中间人攻击。

因此快手发布默认关闭。只有在可信网络（例如受控的本机网络出口）上、确认接受上述传输风险后，才设置 `MEDIA_DESK_KUAISHOU_ALLOW_INSECURE_UPLOAD=1`。不要在公共 Wi-Fi、未受信任的代理或不受控网络中启用。此开关不改变授权凭据保密要求。

## Host 配置

在运行 DSH Host 的环境中设置：

```sh
MEDIA_DESK_KUAISHOU_PUBLISH=1
MEDIA_DESK_KUAISHOU_ALLOW_INSECURE_UPLOAD=1
MEDIA_DESK_KUAISHOU_APP_ID=your_app_id
MEDIA_DESK_KUAISHOU_OPEN_ID=authorized_open_id
MEDIA_DESK_KUAISHOU_ACCESS_TOKEN=authorized_user_access_token
```

App ID 和用户令牌必须来自你自己的快手开放平台应用与账号授权。授权需包含 `user_video_publish`；先在开放平台确认自己的应用已获该发布权限，登录用户同意授权并取得有效令牌。平台的应用审核/能力开放可能有限制，本适配器不会绕过审核。首次版本不实现 OAuth 登录或令牌刷新，令牌过期后需在 Host 环境更新。`OPEN_ID` 必须与所配置的访问令牌对应。快手账号信息接口不返回 `OPEN_ID`，因此 Host 会把 `OPEN_ID` 与访问令牌指纹共同作为内部账号身份；令牌变化后，旧确认单会失效并要求重新核对账号。凭据和令牌指纹仅保存在 Host 私有发布记录中，不写入稿件、浏览器或 Git。改完配置后重启 Host。

## 发布流程

1. 稿件「发布」页选择「快手」「视频」「API 投稿」，选择本地成片和必选封面。
2. 标题不超过 30 字，标题、说明和话题合并后不超过 1,000 字符；确认公开，并确认不需要快手原生 AI 标识。需要原生声明时改用官方发布器。
3. 「检查并准备发布」只保存草稿、核验账号与本地文件并生成确认单，不上传素材。
4. 点击「确认投稿」后，Host 向快手 HTTPS 接口申请上传会话，按 4 MB 分片向已校验的快手上传域名传视频，合并分片后将封面和说明提交到快手 HTTPS API。
5. 发布接口返回作品 ID 后，记录进入「平台处理中」或「投稿完成」。可查询该作品的 `pending` 状态。若最终发布请求没有明确回执，任务会标记未知并阻止重复投稿；因没有作品 ID 可安全查询时，需到快手创作者中心核对。

## 支持范围

- 单账号、单条视频、立即投稿；MP4、MOV 或 WebM，最多 100 MB、最长 30 分钟。该大小/时长上限沿用 AiToEarn 快手 provider 的适配器边界，不代表快手对所有账号的通用配额。
- 必选本地 JPEG 封面，严格小于 10,000,000 字节；首版不接收 PNG 封面。
- 标题 30 字、合并说明 1,000 字是本适配器的保守文案限制，实际账号权限和平台校验可能不同。
- 仅公开发布，不支持排期、可见性选择、挂载商品、多账号批量或自动 OAuth 刷新。
- `start_upload` 返回的上传令牌只用于当前一次传输，不落入发布记录；提交作品前写入本地提交检查点。未知结果不会自动重试创建作品。

## 上游与官方资料

发布步骤参考 AiToEarn 快手实现（基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558`，MIT）；协议调用在本机 Host 重写，移除了上游云端媒体下载与后台任务依赖。许可证随 `src/publish/kuaishou/UPSTREAM-LICENSE.txt` 分发。

快手官方文档：

- [创建视频：发起上传、上传视频、发布视频](https://open.kuaishou.com/platformDocs/openAbility/contentManagement/createAVideo.html)
- [查询视频](https://open.kuaishou.com/platformDocs/openAbility/contentManagement/searchForVideos.html)
- [公开信息与用户授权](https://open.kuaishou.com/platformDocs/openAbility/userInformation/publicInformation)
