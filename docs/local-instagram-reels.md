# Instagram Reels：本地视频直传

## 启用前

此入口只发单条 Reel 到 **关联 Facebook 公共主页的 Instagram 专业账号（Business 或 Creator）**。采用 Meta 的 **Facebook Login for Business** 发布路径，不是 Instagram Login 的 `video_url` 拉取模式，不支持普通个人账号、Story、图文、轮播、协作发布或预约。

1. 在 Meta 自有应用配置 Facebook Login for Business，关联目标主页和 Instagram 专业账号。授权者应能在关联主页执行 `MANAGE` 或 `CREATE_CONTENT`；根据应用模式完成所需审核与 Page Publishing Authorization。按 Meta 授权流程配置 `instagram_basic`、`instagram_content_publish`、`pages_read_engagement`，枚举主页时需要 `pages_show_list`，部分 Business Manager 角色还需额外权限，以应用的审核与端点要求为准。
2. 按 Meta 的端点参考取得该 Facebook 登录流程的发布访问令牌（`media_publish` 参考示例使用 Facebook User access token）。不要沿用仅授权 Facebook Reels 的令牌，也不要提供 Instagram Login 的令牌。当前版本不内置登录换码或刷新。
3. 在 **DSH Host 的私有环境**设置变量并重启。不要把令牌放进稿件、Git 或前端。

| 变量 | 含义 |
| --- | --- |
| `MEDIA_DESK_INSTAGRAM_PUBLISH=1` | 开启，目前默认关闭 |
| `MEDIA_DESK_INSTAGRAM_PAGE_ID` | 关联的 Facebook 公共主页数字 ID，**不是 Instagram ID** |
| `MEDIA_DESK_INSTAGRAM_ACCESS_TOKEN` | 具备上述目标账号读取、上传及发布权限的令牌 |
| `MEDIA_DESK_INSTAGRAM_GRAPH_VERSION` | 可选，默认固定 `v27.0`，与实施时 Meta 的端点示例一致；修改版本后需重新联调 |

Host 用指定主页的 `instagram_business_account` 读取 Instagram ID 和用户名；若主页未关联账号，或从准备到确认期间关联目标变更，禁止继续。先用可公开发布的自有测试账号与素材验证权限，不把显示用户名当作发帖权限已经通过的证明。

## 如何准备、发布、回查

- **准备**：稿件 → 发布 → Instagram → API 投稿，选本地 MP4/MOV，填标题、说明和话题。标题作为第一行，话题以 `#标签` 附加到说明，确认单展示实际发送的完整文字。选择是否分享到动态，以及是否使用 AI 生成或编辑。**只发 Reels 不是私密草稿**；此入口没有私密发布，不传独立封面。
- **素材**：API 发布的成片上限为 250 MB。推荐 9:16、启用 fast start 的 H.264/AAC MP4；导入读到规格时会预检 23–60 fps、3 秒至 15 分钟、宽度及长宽比。无元数据的旧素材仍须经过 Meta 的格式验证；工作台不自动转码。
- **确认后直传**：准备阶段只读账号及本地素材，不创建容器。用户确认后，Host 在 `graph.facebook.com` 创建可上传容器，再向 `rupload.facebook.com` 流式发送本地字节。上传目标须与官方 HTTPS 域名、接口、版本和容器 ID 匹配；不跟随跳转、不引入公共素材链接。随后最多检查五次容器状态，间隔约一分钟；只有状态为 `FINISHED` 才调用一次 `media_publish`。
- **结果**：处理超时或失败且未调用 `media_publish` 时，可重新准备；最终请求结果不明时保留容器回执，禁止重投。回查优先核对已收到的作品 ID；只有容器回执时用 `PUBLISHED` 确认是否发布，不编造作品链接，可到 Instagram 核对。**不会自动发帖、恢复上传或重放提交。**

## 移植范围与验证

从 AiToEarn 提交 `11dd1957d0c69ae2b27a0b8a47acdf6675715558` 的 `instagram.service.ts` 和 `instagram-publish.provider.ts` 移植容器、处理等待、发布及作品查询流程，并保留 MIT 声明。上游采用 `video_url`；本适配器替换为 Meta 的本地文件上传方式，与 Facebook Reels 共用请求、地址验证与授权头处理，不依赖 AiToEarn 服务。

官方参考：[Meta 内容发布](https://developers.facebook.com/documentation/instagram-platform/content-publishing) · [IG User Media（可上传容器和媒体规格）](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media) · [Media Publish](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish) · [Facebook Login 授权](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started)。自动化使用模拟响应，不证明真实账号已获得权限，也未向实际平台发帖。
