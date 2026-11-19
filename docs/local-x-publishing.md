# X 视频、图文与纯文字发帖：DSH Host 本地直传

## 授权和 Host 配置

将 AiToEarn 的 X 视频/图片上传及纯文字发帖 API 流程接入统一发布入口。不使用 AiToEarn 的账号、API Key、云端存储或浏览器扩展。素材从运行 DSH Host 的机器发送到官方 `https://api.x.com`，不接受外部素材 URL。图片复用上游初始化、分片、完成、状态查询链路，不另建一个公共图床或平行投稿服务。

使用自有 X Developer 应用，为目标账号通过 OAuth 2.0 Authorization Code with PKCE 获取用户访问令牌，需授权 `tweet.read`、`users.read`、`tweet.write`、`media.write`。不能使用只代表开发者应用的 app-only bearer token。API 可用性、额度和计费取决于 X 给应用的实际访问权限；不要用真实账号执行本项目的模拟测试。

在 DSH Host 私有进程环境配置并重启：

| 变量 | 说明 |
| --- | --- |
| `MEDIA_DESK_X_PUBLISH=1` | 显式启用，默认关闭 |
| `MEDIA_DESK_X_USER_ID` | 用户授权后 `/2/users/me` 返回的数字 ID，不是用户名或主页 URL |
| `MEDIA_DESK_X_ACCESS_TOKEN` | 同一账号的有效 OAuth 2.0 用户访问令牌 |

Host 在准备、提交和最终创建帖子前核对账号，只接受配置 ID 对应的非受保护公开账号。前端不能传令牌、改作者或配置 API 地址。当前没有网页登录换码或自动续期；令牌过期由 Host 运维方更新，不要把凭据放进 Git、聊天或同步文档。

## 工作台操作

1. 稿件 → 发布，平台选「X」，方式选 API 投稿。视频选择稿件内的本地 MP4 成片；图文按顺序勾选 1–4 张本地 JPEG/PNG，每张不超过 5,000,000 字节；纯文字不要求或读取素材。均不上传独立封面；图文不会混入旧视频，纯文字不会混入旧图片。
2. 填标题、正文和话题。X 没有单独的标题字段，三项拼成确认单里的实际正文。首版按普通帖的 280 加权字符校验，复用官方 `twitter-text`：中文和大部分 emoji 按权重计数，URL 按固定权重处理，不是直接按字符串长度截断。不接 Premium 长文。
3. 显式确认公开，选择是否使用 AI 生成或编辑、是否为付费商业合作。分别发送官方 `made_with_ai`、`paid_partnership` 字段，不用普通文案替代声明。
4. 信息齐全后点「检查并准备发布」，Host 先保存并核对当前文案、账号、适用素材及指纹，生成确认单，不发送素材。图文确认单按实际顺序列出文件名和大小；文案、类型或选材变化后必须重新检查。
5. 只有点击「确认投稿」，Host 才固定本地素材快照。视频/图片逐个初始化上传，流式逐片发送，完成上传并等待平台返回的处理信息；图片使用实际 JPEG/PNG MIME 和 `tweet_image`，不是冒充视频。全部可用后再核对账号及所有会话有效期，写入持久化提交检查点，创建一次帖子。纯文字不调用上传 API，最终请求省略整个 `media` 字段，不发送空媒体数组。
6. 平台确认创建并返回帖子 ID 后，保存投稿记录及 `https://x.com/i/web/status/{id}` 链接。点击「查询平台状态」读取这个确切帖子并核对原作者；查询失败保留已有结果，删除、不可见或暂时读不到不等同于允许重新发帖。最终创建请求断线且无回执时标记未知，需要先在 X 核对，不自动重投。

范围限单个公开账号的普通视频、1–4 张图文或纯文字帖子。视频为 MP4、0.5 秒至 20 分钟、最高 60 fps，尺寸和宽高比按官方视频规范做可读取元数据的预检，API 发布文件上限为 250 MB。图片暂只接 JPEG/PNG，不含 GIF、WebP、图视频混发、逐图替代文本编辑、线程、回复、引用、广告、定时、受保护账号和独立封面。缺少编码元数据时由 X 最终校验兼容性；上传成功不保证帖子创建一定被平台接受。图片失败不静默改发首图、多条帖子或纯文字。

## 复用和实现

`src/publish/x/` 的初始化、APPEND、FINALIZE、STATUS、创建和回查结构参考 AiToEarn `twitter.service.ts`、`twitter-publish.provider.ts`，基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558`，MIT 声明随适配器发布。直接使用官方 v2 路径，不使用旧版 command 式上传：

- `POST /2/media/upload/initialize`：JSON `media_type`、`total_bytes`；视频 `media_category=tweet_video`，JPEG/PNG 图片为 `tweet_image`。固定官方 v2，未切到旧 v1.1 或第三方 API。
- `POST /2/media/upload/{id}/append`：multipart `segment_index` 从 0 开始，每片至多 5,000,000 字节，直接从本地文件范围流读取。固定文件名，JPEG/PNG 文件部分发送对应真实 MIME。
- `POST /2/media/upload/{id}/finalize`：若返回 `processing_info`，等待其变为 `succeeded`；未返回处理信息的完成响应可直接使用。回查按 `check_after_secs` 等待，本地限制单次至多 60 秒、最多 60 次查询，不自动重新上传。
- `GET /2/media/upload?media_id={id}&command=STATUS`：回查媒体处理；缺失状态不能当作处理完成。
- `POST /2/tweets`：实际正文、适用的已完成媒体 ID 数组及两项声明；图片保持选择顺序，纯文字省略 `media`。必须收到 `201` 及有效帖子 ID 才记录为完成。
- `GET /2/tweets/{id}?tweet.fields=id,author_id`：只核对已记录帖子和原作者。

复用统一 `service.js` 的本地快照、手动确认、跨 Host 锁和持久化任务。媒体上传 ID、原始响应、令牌及分片字节不进入投稿记录。回查只确认帖子 ID 和作者，不声称核对了远端图片字节或顺序。重启不会重放任务。自动化测试覆盖纯文字不读素材、1/2/4 张图片顺序和真实字节、JPEG/PNG multipart、全部会话过期检查、处理失败、账号变化、缺回执/部分错误/断线防重投和原有视频回归；浏览器验证使用模拟 X API，没有真实账号联调或发帖。

协议参考（核对日期 2026-11-18）：[账号查询](https://docs.x.com/x-api/users/get-my-user) · [分片上传](https://docs.x.com/x-api/media/quickstart/media-upload-chunked) · [视频限制](https://docs.x.com/x-api/media/introduction) · [视频格式](https://docs.x.com/x-api/media/quickstart/best-practices) · [创建帖子与声明](https://docs.x.com/x-api/posts/create-post) · [读取帖子](https://docs.x.com/x-api/posts/get-post-by-id) · [官方文字计数](https://github.com/twitter/twitter-text/tree/master/js)。
