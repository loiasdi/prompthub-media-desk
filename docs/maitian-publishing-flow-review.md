# 麦田工程交接流程代码审查

日期：2026-11-23。审查目标：DSH 插件保存内容和素材 → 导出完整工程 → 下载并解压 → 用户在日常浏览器原版助手中选择工程父目录并填写 → 用户核对及最终发布。原版上游代码保持不变。

结论：**审查确认的四项流程问题已修复并加入回归覆盖。** 工程导出校验路径现在独立于专用 Chrome；直填默认在服务端拒绝；离线 runner 不要求 WebSocket；M4V 已贯通导入与导出。修复不修改上游组件，直接填写保持关闭。

## 问题 1：P1，日常浏览器插件可用仍可能无法在 DSH 导出

审查时位置：`src/publish/maitian/service.js`、`src/publish/maitian/engine-loader.mjs`、`client/maitian-publish.jsx`。

`export()` 首先调用 `resolve()`。默认 `source: store` 只扫描本项目维护的专用资料目录 `profiles/default/Default/Extensions/<商店ID>`，不会识别用户日常 Chrome 中安装的组件，也不会识别不同 ID 的未打包源码扩展。当前已安装的源码版就在日常 Chrome，实际运行目录也独立于这套专用资料。

审查时结果：日常浏览器插件可以导入工程，但 DSH 导出会报 `COMPONENT_NOT_INSTALLED`，要求用户再去专用 Chrome 安装。

离线复现：在有有效稿件、成片的隔离工作区使用默认商店发现规则，调用正式 `service.export()`，得到 `请先在专用 Chrome 中安装麦田发布助手`。此前四份工程验收使用了显式本地组件配置，因此没有覆盖这个默认配置断点。

建议：将工程导出所需的原版校验器来源，与专用 Chrome、登录预检、CDP 端口及直驱准备配置分开。工程导出仍可复用原版校验器，但不应要求用户把执行扩展装进本项目专用资料。主界面直接说明“下载解压 → 原版助手选择父目录和同一路径”，避免把未交付直驱配置当作导出必经步骤。

## 问题 2：P1，直接填写的关闭状态只在前端生效

审查时位置：`src/publish/maitian/service.js`、`src/publish/maitian/tasks.js`、`src/host.js`。

公开状态恒定返回 `implementation.directFill: false`，准备界面据此禁用开始按钮；但 `POST publish/maitian/start` 和 `startTask()` 不检查该能力状态。有有效确认单时，发送带 `confirmed: true` 和工程摘要的同源请求，仍会排队并进入填写执行器。现有修订、素材、账号及二阶段确认检查仍然有效，本问题不是绕过这些检查，而是“未交付功能已关闭”的状态没有服务端约束。

离线复现：使用隔离确认单和模拟填写执行器，公开 `directFill` 为 false，正式 `service.start()` 仍返回 `queued`，模拟 `fill` 被调用一次。未启动浏览器、未上传文件。

建议：服务端在领取任务及授权执行前检查实际功能开关；关闭时返回明确错误且不创建执行意图。开始、界面能力响应应共用同一开关。内部执行测试通过显式测试依赖开启分支，不依赖绕过产品开关。

## 问题 3：P2，离线生成工程也被要求具备浏览器传输运行时

审查时位置：`src/publish/maitian/runner.mjs`、`src/publish/maitian/service.js`。

runner 在区分操作前统一检查全局 `WebSocket` 和 `fetch`。`hello` 和 `validate` 只加载原版模块、校验字段，不需要联网或 CDP；它们也会因缺少 WebSocket 而直接失败。由于导出依赖这两项操作，原本仅浏览器直驱需要的运行时条件同时阻断了工程导出。

离线复现：通过当前 Node 的 `--no-experimental-websocket` 启动隔离 runner，保留 fetch，分别调用 `hello`、`validate`，均返回 `UNSUPPORTED_RUNTIME`。这是能力缺失的复现，不是声称已经测试了所有 Node 20 版本。项目整体声明 Node >=20，浏览器专用能力应独立检测。

建议：按操作检测依赖；WebSocket/fetch 条件仅用于实际浏览器操作，`hello`、`validate` 保留纯离线执行。原版模块未来真正需要额外能力时，应给出对应能力错误，而不是提前统一禁止所有操作。

## 问题 4：P3，M4V 被导出层列为支持格式，但无法走完素材导入

审查时位置：`src/publish/maitian/export.js`、`src/asset-rules.js`、`src/content-assets.js`。

导出层、工程文件名校验和任务快照校验接受 `.m4v`，但公共素材 MIME 映射与文件头识别未包含该扩展名。用户使用普通导入流程选择合法 M4V 时，先收到 415，根本无法在发布页选择并导出。

离线复现：将有效 MP4 容器测试素材以 `成片.m4v` 文件名交给正式 `ContentAssets.import()`，返回 `不支持的媒体文件类型`。未修改源素材。

建议：统一导入、文件头识别、选择器和导出的格式支持；若暂不支持 M4V，则移除导出层相关支持声明。MP4/MOV 正常路径不受此问题影响。

## 已检查且未发现断点的环节

| 环节 | 代码和验证 |
| --- | --- |
| 编辑保存后再导出 | `workspaceStore.action()` 在同稿件串行队列中先 `saveNow()`，再使用已保存 revision；保存失败不继续导出 |
| 手动文案与稿件默认值 | 前后端均使用编辑标记；未编辑字段读取稿件来源，已编辑字段保持用户值 |
| 导出过程一致性 | 开始固定稿件及选材，结束在 Store 锁内重读；revision、内容或重复投稿状态变化时拒绝提交工程 |
| 视频与封面复制 | 检查本地文件归属、文件头、大小与摘要；封面读取实际尺寸；MP4/M4V 检查 faststart |
| 工程字段 | 小红书 / 视频号 × 立即 / 预约四份真实导出均被原版扫描并通过 CLI 校验；详见[文件验收](maitian-publish-file-audit.md) |
| 压缩包完整性 | UUID 工程子目录含 JSON 和媒体；tar 使用参数数组，失败清理本次工程和压缩包 |
| 下载 | Host 校验受控 UUID、manifest 与归属文件路径；下载流来自已打开描述符，提供大小、附件名、no-store 与 nosniff |
| 原版助手读取 | 扫描工程父目录，读取相对路径；额外来源 manifest 不影响识别；本机路径必须由用户与所选父目录对齐 |
| 最终发布 | 工程导出不调用平台提交；平台填写后仍需人工核对并最终发布。本轮没有重新验证两个平台所有 DOM 步骤 |

下载部分审查覆盖路由和自动化 HTTP 下载，不代表本轮重新操作了 DSH 桌面下载界面。原版助手公开仓库停留版本及后续更新来源限制沿用之前诊断，不能据本次文件兼容认定未知新版行为已验证。

## 修复验证

- 默认浏览器配置下使用独立 `exportComponentDir` 导出工程通过；不启用专用 Chrome。
- 默认服务配置的有效确认单由 `startTask()` 拒绝，未创建执行任务；内部任务状态机测试显式开启测试注入开关。
- `NODE_OPTIONS=--no-experimental-websocket` 下 runner 的 `hello` 与 `validate` 均通过。
- M4V 经常规素材导入、内容选择、工程导出并解压，保持 `video.m4v` 文件名和媒体字节。
- 本轮全量测试与构建结果见开发进度记录。

## 验证证据及开发顺序

- 本轮全量 `npm test`：694/694 通过，日志 `/tmp/maitian-flow-review-tests-20261123.log`。
- 本轮 `npm run build`：通过。
- 四项问题的隔离复现脚本：`.dsh-sandbox/flow-code-review-20261123/reproduce.mjs`；结果：同目录 `report.json`。只使用临时工作区和模拟填写执行器，不访问真实平台。
- 业务代码与上游代码均未修改。构建输出仅在已忽略的 `dist/` 更新。

建议先完成导出与专用浏览器配置解耦及服务端功能开关，再拆分离线运行时检查，最后统一 M4V 格式支持。修改后需补充覆盖默认配置和真实交接路线的回归，保留已有原版工程扫描与文件摘要检查。
