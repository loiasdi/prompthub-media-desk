# Threads 原生纯文字发布

## 范围与素材边界

复用 AiToEarn 的文字「创建容器 → 发布容器 → 查询作品」代码结构，接入现有发布服务，不自部署 AiToEarn，不使用其 Key、云端或浏览器扩展。

当前官方图片/视频流程要求公网 `image_url` / `video_url`，由 Threads 拉取；上游也使用外链。本项目不为此公开本地素材、不引入第三方 CDN，因此本轮只开放原生纯文字。**不代表 Threads 视频已接通**。未来有可验证的官方本地直传方案时再扩展，现阶段图片和视频使用手动发布。

统一能力表新增 `formats`，未声明的平台继续只允许视频；Threads 显式允许 `text`。不是把用户选的视频/图文悄悄降级成文字，选错类型时前后端都拒绝。纯文字任务不读取或上传旧的素材选择；原稿和素材档案不变。

## Host 配置

自有 Meta 应用启用 Threads API，目标用户授权 `threads_basic`、`threads_content_publish`。未获发布权限高级访问时，只能对已配置的应用 Threads 测试账号操作；正式面向用户需经过平台审批。配置开关不代表已获权。

在 DSH Host 私有进程环境配置并重启：

| 变量 | 用途 |
| --- | --- |
| `MEDIA_DESK_THREADS_PUBLISH=1` | 显式启用，默认关闭 |
| `MEDIA_DESK_THREADS_USER_ID` | 同一访问令牌调用 `/v1.0/me` 返回的数字 `id`，不是用户名 |
| `MEDIA_DESK_THREADS_ACCESS_TOKEN` | 目标 Threads 用户的有效访问令牌 |

账号查询、创建、发布和回查固定 `https://graph.threads.com/v1.0`，令牌只放 Host 的 Bearer Header，不放 URL 或前端。没有网页 OAuth 换码、刷新或凭据管理 UI，过期需运维方更新。账号在准备、开始和最终发布前重新核对。

## 发布页

1. 非示例稿件 → 发布 → Threads → **纯文字** → API 投稿。不需要选视频、图片或封面，旧选材也不会被读出发送。
2. 标题与正文以空行合并为实际发帖文字，确认单显示同一份内容；按本地 500 权重预检，常规 Unicode 字符按码点计、emoji 字素按 UTF-8 字节计，不截断或改写内容，平台最终校验仍可能拒绝。
3. 话题至多一个，发送独立 `topic_tag`，不会把话题加到正文后冒充原生话题。本地要求 1–50 字符，不含句点、`&`、`#`、`@` 或控制字符；允许有空格。多话题必须由用户改为一个，不能自动丢弃。
4. 明确选择「遵循 Threads 账号当前隐私设置」。API 不设置单帖私密或修改账号隐私，入口不会承诺公开或私密草稿。选择回复范围：所有人、关注的账号、提及的账号或关注者。单条顶层文字不开放只适用于回复的 `parent_post_author_only`。
5. 明确声明是否 AI 生成/编辑，适用时在创建容器请求发送官方 `is_made_with_ai`。选择否只表示不主动增加声明，不保证平台不会自动标记。
6. 信息齐全后点「检查并准备发布」。先保存最新编辑，只读取账号并生成确认单，不创建远端容器、不发帖。编辑或账号变化后需重新检查。
7. 只有点「确认投稿」后才创建文字容器，固定 `auto_publish_text=false`，防止创建动作直接发帖。检查容器就绪后，再核账号，持久化最终提交检查点及容器 ID，才调用一次 `threads_publish`。
8. 最终响应有有效帖子 ID 才记为完成；尝试读取帖子、核对作者和 `TEXT_POST` 类型，只显示平台返回的官方 permalink。获取链接失败不抹掉成功回执，也不伪造作品地址。确认的发帖任务不自动把原稿状态改成「已发布」。

## 处理、回查和防重复

- `GET /me?fields=id,username,name`：核对令牌所属账号。
- `POST /{userId}/threads`：`media_type=TEXT`、实际文字、回复范围、AI 声明及可选一个原生话题；固定不自动发布。
- `GET /{containerId}?fields=id,status`：等待 `FINISHED`，最多 5 次，间隔 60 秒。`ERROR` / `EXPIRED` 或超时在最终请求前失败，不自动重试。容器不是已发布帖子。
- `POST /{userId}/threads_publish`：提交前将 `submissionStarted` 和容器 ID 原子持久化。最终请求无有效回执、断线或结果不确定时禁止重投。
- `GET /{postId}?fields=id,owner,media_type,permalink`：仅查询已保存的确切帖子，核原作者及纯文字类型。帖子链接只接受官方 `www.threads.com` / `www.threads.net` 用户帖子路径，不跟随重定向。
- 结果未知但已有容器回执时，可以只读查询容器。仅 `PUBLISHED` 可据此确认已发；`FINISHED` 不会被当成「可以重发」。由于容器不一定提供发布后的帖子 ID，此路径可能没有作品链接，需要到 Threads 核对。
- 文字容器明确未发成功时允许重新准备；查询失败或作者变化保留原记录。重启不重放容器或发帖请求，不根据文本搜索猜测作品归属。

沿用 Host 的修订号核验、跨进程锁和投稿记录。纯文字快照保存在投稿单中，不读取视频文件；确认后编辑原稿不会修改已领取任务的文案。没有预约、批量、轮播、回复帖、引用、GIF 或投票入口。

## 复用与验证

参考 AiToEarn 基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558` 的 `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/threads/threads.service.ts`、`threads-publish.provider.ts`；保留 `src/publish/threads/UPSTREAM-LICENSE.txt`。使用当前官方 `.com` API 域名和 `is_made_with_ai` 字段，不沿用旧上游域名/字段假设。

自动测试及浏览器 smoke 使用模拟 API，没有真实账号发帖。覆盖纯文字类型保存、无素材准备、确认前只读、文案修改失效、AI 和原生话题、状态轮询、提交检查点、未知结果防重投、作者归属与链接白名单、既有视频平台回归。

官方依据（核对日期 2026-11-18）：[发帖及 AI/话题规则](https://developers.facebook.com/documentation/threads/posts)、[发布接口](https://developers.facebook.com/documentation/threads/reference/publishing)、[用户资料](https://developers.facebook.com/documentation/threads/threads-profiles)、[媒体读取与 owner](https://developers.facebook.com/documentation/threads/retrieve-and-discover-posts/retrieve-posts)、[容器状态](https://developers.facebook.com/documentation/threads/troubleshooting)。
