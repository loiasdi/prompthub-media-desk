# Pinterest 本地视频与图文 Pin 投稿

复用 AiToEarn 的「注册媒体 → 上传 → 等待处理 → 创建 Pin」视频结构及图片 Base64 分支，接入现有统一发布入口，不自部署 AiToEarn，也不使用其 Key、云端、CDN 或浏览器扩展。只创建本人公开画板里的原创视频或图文 Pin。上游 provider 只允许单张图片；这里依据官方 OpenAPI 扩展为 1–5 张，不声称直接照搬了上游多图实现。

## Host 配置

默认关闭。准备自有 Pinterest 开发者应用，以及目标账号授权的有效用户访问令牌；应用访问级别、测试账号范围和正式审批以开发者后台为准。需要 `user_accounts:read`、`boards:read`、`pins:read`、`pins:write`，本入口不创建画板，不要求 `boards:write`。

在 DSH Host 的私有进程环境配置并重启：

| 变量 | 用途 |
| --- | --- |
| `MEDIA_DESK_PINTEREST_PUBLISH=1` | 显式启用，默认关闭 |
| `MEDIA_DESK_PINTEREST_USER_ID` | 同一令牌调用 `/v5/user_account` 得到的数字 `id`，不是用户名或主页地址 |
| `MEDIA_DESK_PINTEREST_ACCESS_TOKEN` | 上述账号的有效用户访问令牌 |

准备、提交和最终创建前核对原账号及本人公开画板。列表排除他人、非公开和广告专用画板；不支持协作画板。凭据只留在 Host，不进浏览器、稿件或投稿记录。当前不提供网页登录授权、换码或令牌自动刷新，过期由 Host 运维方更新。

## 工作台操作

1. 打开非示例稿件 → 发布 → Pinterest → API 投稿。视频选择稿件内已归档的本地 MP4/MOV 成片；图文选择「图文」，按需要的顺序勾选 1–5 张本地 JPEG/PNG 图片。每张不超过 10 MiB，图片合计不超过 20 MiB（本地内存安全边界，不宣称是平台最大值）。取消后重新勾选可调整顺序。
2. 选择本人公开画板；填独立标题（1–100 字符），说明与话题合计不超过 800 字符。话题并入说明，不并入标题。
3. 明确确认公开、原创，分别选择是否使用 AI 生成或编辑、是否包含合成表演者。适用时发送官方 `ai_disclosures.values` 的 `AI_MODIFIED`、`SYNTHETIC_PERFORMER`，不以普通话题代替声明。此入口不得用于搬运他人内容。
4. 视频可选本地 JPEG/PNG 封面，工作台限制 10 MiB；以内联 Base64 发送，不需要公开图片地址。未选封面发送 `cover_image_key_frame_time=0`，使用视频首帧。图文不发送视频或独立封面，即使以前选过也不会混入。
5. 信息准备齐全后点击「检查并准备发布」。先保存最新编辑，再只读核对账号、画板、文案、文件和指纹，显示确认单；不注册媒体、不上传、不创建 Pin。信息变化后需重新检查。
6. 只有点击「确认投稿」，Host 才固定本地快照。视频先注册、流式上传、等待处理成功；图片从已固定的文件按顺序转 Base64。最后重新核对账号和画板，写入持久化提交检查点并请求创建一次 Pin。
7. 保存确切回执和作品链接。可以查询该 Pin 的原账号归属、对应视频/单图/多图类型和原公开画板；读取失败保留原记录。最终创建结果不确定时禁止自动重投，先到 Pinterest 核对。

本地限制成片 250 MB，已知时长须在 4 秒至 15 分钟；编码和平台最终准入由 Pinterest 校验。未读取到时长不代表编码、时长已通过平台检查。不含图视频混排、图片逐项独立标题或外链、广告、外链素材输入、私密画板、批量或定时发布。多图能力以自有应用实际权限为准；平台明确拒绝时展示错误，不静默降级为首图或多条帖子。

## 传输和故障边界

- 元数据调用固定 `https://api.pinterest.com/v5`；视频按注册响应的签名参数直传 Pinterest 指定存储，不经过 AiToEarn。官方存储仍是云存储，但不是第三方中转。
- 当前只接受官方 OpenAPI 示例的 `https://pinterest-media-upload.s3-accelerate.amazonaws.com/`，不跟随跳转，不带用户 OAuth Header。域名、路径、签名字段不符合白名单则停止，不放宽到任意 S3 地址。
- 视频 multipart 流式写入签名字段，最后写文件，视频不整体读入内存。可选封面在 10 MiB 本地上限内读入。图文单张发送 `image_base64`；2–5 张发送 `multiple_image_base64`，保留选择顺序，`index=0`。JPEG/PNG MIME 与实际素材一致，不填公共 URL。图文 Base64/JSON 会占用内存，因此另设原始图片合计 20 MiB 上限。
- 最多查询处理状态 60 次，间隔 5 秒；只有 `succeeded` 可创建 Pin。上传/处理失败不创建；最终创建明确拒绝可重新准备，断线、无效回执等未知结果必须人工核对。重启不重放。
- 复用统一 `service.js`、快照和任务记录；不新增平行发布入口。测试及浏览器验证均模拟平台 API，没有真实账号联调或实际发帖。

## 复用与协议依据

AiToEarn 基线 `11dd1957d0c69ae2b27a0b8a47acdf6675715558`，参考 `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/pinterest/pinterest.service.ts` 与 `pinterest-publish.provider.ts`。保留 `src/publish/pinterest/UPSTREAM-LICENSE.txt`。移除其素材外链、云端依赖及整片内存上传，替换为统一 Host 本地源。

核对日期：2026-11-18。官方依据：[OpenAPI](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml)、[创建 Pin](https://developers.pinterest.com/docs/api/v5/pins-create/)、[画板与 Pin 工作流](https://developers.pinterest.com/docs/api-features/creating-boards-and-pins/)、[视频规格](https://help.pinterest.com/en/business/article/pinterest-product-specs)。以自有应用实际获批能力为准，代码接入不代表已经获得平台权限。
