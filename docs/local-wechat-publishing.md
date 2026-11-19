# 微信公众号单篇文章发表

## 范围与权限

复用 AiToEarn 的「上传永久封面 / 正文配图 → 新增草稿 → 发表 → 回查」流程，接入现有 Host 发布服务，不自部署 AiToEarn，不使用其 Key、云端或浏览器扩展。封面、正文配图和文章直接给微信 API，不使用第三方图床或中转；发表后的正文配图由微信官方图片 CDN 提供。

支持单篇 `article_type=news` 文章：标题、正文、必选本地 JPEG/PNG 封面、可选正文配图、作者/摘要和评论权限。不是视频、图片消息 `newspic`、多篇图文或群发；不调用群发接口，不自动改变原稿状态。不接任意 HTML、原文链接、商品卡片、版权/AI 原生声明和富文本排版编辑器；文字里的 HTML 会被转义为普通文字，而不是执行或拉取远程图片。只有明确标记引用的本地正文配图会发送，其他已选视频/图片不会发送。

平台权限不是配好密钥就自动拥有。2026-11-18 核对的官方发表接口文档写明，2025 年 7 月起，个人主体、企业未认证和不支持认证的账号会被回收此接口权限；具体看自己账号后台和当前官方适用范围。需要平台原生 AI 标识或原创声明的文章，请改用公众平台完成声明后发表，不能用普通文案代替未提供的原生声明。

## Host 私有配置

| 变量 | 用途 |
| --- | --- |
| `MEDIA_DESK_WECHAT_PUBLISH=1` | 显式启用，默认关闭 |
| `MEDIA_DESK_WECHAT_CLIENT_ID` | 自有公众号的 AppID，形如 `wx…` |
| `MEDIA_DESK_WECHAT_CLIENT_SECRET` | 同一公众号的 AppSecret |

按微信要求配置 Host 出口 IP 白名单及账号接口权限，重启 Host。不要把 AppSecret 放前端、聊天、同步文档或 Git。这里不用 `MEDIA_DESK_WECHAT_ACCESS_TOKEN`，也不使用网页 OAuth 的用户访问令牌。多账号、第三方代授权和自动授权 UI 不在首版范围内。

Host 调用微信 `stable_token`，固定 `force_refresh=false`，缓存并在到期前重新获取，不强制使其他客户端令牌失效。凭据仅留在进程内，既不写入稿件/投稿记录，也不发送给 AiToEarn。

发布账号通过同一 AppID/AppSecret 取得的后台令牌与只读素材权限核对，确认单显示 **AppID** 而不是声称读取到了公众号昵称。请在公众平台核对这个 AppID 确属目标公众号。AppID 变化会要求重新检查；更换 AppSecret 后请重启 Host，并重新生成确认单，系统不会用密钥指纹判断同一 AppID 下的密钥轮换。

## 统一发布页

1. 非示例稿件 → 发布 → 公众号 → **文章** → API 投稿。
2. 填标题和正文。按当前官方新增草稿文档，标题最多 **32 字**（不是直接沿用上游旧 64 字）；正文按段落转为安全 HTML，转换后少于 20,000 UTF-16 单元且小于 1 MB。可选作者最多 16 字、摘要最多 120 字；未填摘要由微信提取。
3. 清空独立话题字段；公众号没有对应的文章话题参数。需要的文字请自己放进正文，不自动丢弃原稿标签。
4. 选该稿件内的本地 JPEG/PNG 封面，首版限制 10,000,000 字节；必填，不会用其他参考图替代。平台仍会校验实际内容及尺寸。
5. 明确确认公开发表，选择评论权限；开启评论时再选择是否仅粉丝可评论。确认是否需要原生 AI/原创声明，选择需要时禁止 API 准备，并提供公众平台入口。
6. 「检查并准备发布」先保存最新编辑，核对账号、封面和被引用配图的指纹，生成确认单。只允许读取账号、获取后台令牌和读取素材数量，不上传图片、不建草稿、不发表。
7. 只有「确认投稿」后才固定封面与配图的私有快照。封面流式上传永久素材；有配图时依次上传到微信并按标记位置安全生成图片段落；创建一篇草稿，再核对账号，持久化最终提交检查点后调用一次发表接口。文案、图片或账号变化必须重新检查。
8. 收到有效 `publish_id` 先显示平台处理中。点击「查询平台状态」，按 `article_detail.item[].article_url` 读取成功文章链接；不是照搬上游把顶层 `article_url` 当作唯一结构。

### 正文配图

- 在同一发布页的「正文配图」区选择本篇稿件图片，会向正文末尾插入 `[[image:…]]` 标记。标记中保存的是编码后的工作区文件身份，不是供远端抓取的素材 URL；可以在正文中移动整段标记来指定图片位置。
- 每张正文配图必须为本地 **JPEG/PNG，严格小于 1,000,000 字节**。封面仍按其独立的 10 MB 规则校验，不能因为图片可作封面就认为它也可作正文配图。沿用上游最多 20 张不同配图的限制；同一张图重复插入时只上传一次，但在每个标记位置显示。
- 图片按正文第一次出现的顺序读取、固定快照并上传；不读取遗留的图文勾选列表。配图缺失、回收、格式不符或标记损坏会阻止准备，不自动删标记或漏图。修改文字、标记顺序、封面或图片后需重新检查。
- 确认单把标记显示为对应文件名，另列正文配图和必选封面。标记本身不会作为文章文字发表，任意用户 HTML 仍只按普通文字处理，不获得执行权限。
- `POST /cgi-bin/media/uploadimg` 使用 Host 本地流和真实 MIME，响应只接受固定微信官方 `mmbiz.qpic.cn` 图片地址。官方示例可能返回 HTTP 形式，文章中统一使用同一官方域名的 HTTPS 地址；不下载该地址，不跟随它的跳转，不接纳任意 URL、用户凭据或其他域名。
- 替换为微信 URL 后，再按实际最终 HTML 校验 20,000 字符 / 1 MB 限制，超限不创建草稿，不把未替换的标记或不可信图片地址提交发表。微信已收到的图片可能留下，不自动删除。

## 协议和故障处理

固定 HTTPS `https://api.weixin.qq.com`，不跟随跳转，不允许前端自定 API 地址。微信业务接口要求的令牌放在官方 URL 的 `access_token` 参数中；不要对完整请求 URL 记录日志。异常仅返回脱敏摘要，不回显原始响应、令牌、密钥或上传字节。

- `POST /cgi-bin/stable_token`：自有 AppID/AppSecret 获取短期后台令牌，非强刷，不和用户 OAuth 令牌混用。
- `GET /cgi-bin/material/get_materialcount`：只读验证该后台令牌的公众号素材访问能力，不把素材权限当作发表权限保证。
- `POST /cgi-bin/material/add_material?type=image`：multipart 流式上传固定文件名的本地封面，使用返回的永久 `media_id`，不发送其他素材。
- `POST /cgi-bin/media/uploadimg`：仅已确认、标记引用的正文配图，本地 multipart 流式上传，不占用微信永久图片素材库数量；平台仍会校验图片内容。
- `POST /cgi-bin/draft/add`：单篇 `news`，安全 HTML 正文、永久封面 ID 和已确认的作者/摘要/评论参数。建草稿不是发表。
- `POST /cgi-bin/freepublish/submit`：调用前落盘 `submissionStarted`，拿到有效回执才记录为平台处理中。缺失回执、超时或断线为未知，禁止自动重发；草稿 ID 不能拿来替代发表回执。
- `POST /cgi-bin/freepublish/get`：只查询已保存回执，核对 `publish_id`。状态 0 且单篇详情完整才确认发表；1 处理中；2/3/4 为平台明确失败；5/6 表示成功后删除/封禁，改为待核对且不释放重发锁。查询失败保留原结果。
- 作品链接只接微信官方 `mp.weixin.qq.com/s/…` 或受限的标准 `/s?__biz=…&mid=…&idx=1&sn=…` 形式；不拼接、猜测或跟随外部跳转，无法确认链接时保留发表结果并转公众平台核对。

不自动重试发表请求或重放重启任务。上传/建草稿失败在发表前可重新准备，但可能在微信素材库/草稿箱留有未发表内容；本项目不自动删除这些远端内容，避免误删，必要时到公众平台手动整理。没有后台定时群发或自动审核绕过。

## 复用与验证

参考 AiToEarn 基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558`：

- `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/wechat/wechat.service.ts`
- `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/wechat/wechat-official/wechat-official-publish.provider.ts`

保留 `src/publish/wechat/UPSTREAM-LICENSE.txt`。将上游外链下载/整块图片改为本地文件流，复用其 `uploadImage` → 替换正文图片 → 新增草稿的次序；以显式本地标记替代任意 HTML URL 替换。按当前官方文档更新 token、标题限制和异步详情结构；沿用统一修订号、快照、跨 Host 锁和任务记录，不新增平行发布服务。

自动测试与浏览器 smoke 全部模拟微信 API，覆盖封面必填、配图位置与去重、缺图/大小限制、URL 白名单、最终 HTML 限制、账号凭据/缓存、只读准备、人工确认、正文转义、固定快照、提交检查点、防重发及回查，尚未真实账号联调或发帖。

官方依据（2026-11-18 核对）：[稳定后台令牌](https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html)、[新增草稿](https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html)、[永久素材上传](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial.html)、[素材数量](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_getmaterialcount.html)、[正文图片上传](https://developers.weixin.qq.com/doc/service/api/material/permanent/api_uploadimage.html)、[发表](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_submit.html)、[发表状态](https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_get.html)。
