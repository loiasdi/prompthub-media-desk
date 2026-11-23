# 麦田集成开发进度

更新日期：2026-11-23。方案：[麦田发布组件兼容方案](maitian-publishing-integration-plan.md)。

全流程代码审查发现的四项问题已修复：独立导出校验器目录、服务端默认关闭直填、离线 runner 能力检查、M4V 导入和导出一致性。修复边界、用例和本轮验证见[完整审查记录](maitian-publishing-flow-review.md)。上游组件代码未修改，产品默认仍需用户在原版助手中选择工程并发布。

修复验证：`npm test` 698/698 通过；`npm run build` 和 `git diff --check` 通过。M4V 导入→工程导出/解压、WebSocket 缺失时离线校验、服务端直填拒绝均有回归测试。

最新检查：用户已确认本地源码版插件可以使用，当前转向工程文件验收。已用实际导出链生成“小红书 / 视频号 × 立即 / 预约”四份工程，原版扫描和命令行校验全部通过；24 次错误输入拒绝符合预期，相关自动测试 10/10 通过。未发现生成器兼容问题，未修改上游或生成器。字段映射、证据和平台实测边界见[发布工程文件检查](maitian-publish-file-audit.md)。下文商店权限及安装前的待测试状态保留为历史记录，不代表当前源码版状态。

本轮用户澄清：当前要交付的是「本项目生成兼容工程文件 → 原版发布助手导入执行」。此前把助手侧栏报错引向麦田监控中控和 Node 直接运行模块，偏离了这条使用路径。已停止本轮启动的中控网页服务（经命令行核实后的 PID 13419、端口 8787）；没有删除下载源码、未提交代码或关闭可能正在使用的测试浏览器。下文直驱实现和对照测试作为历史技术记录保留，当前不要求用户运行中控或 Node 执行器。工程导出与未交付直驱配置的解耦仍待实现，助手侧栏的 `Not allowed` 仍待解决，不宣称原生发布已经可用。

诊断更正（2026-11-23 11:03，Asia/Tokyo）：此前用 `allow_file_access` 缺失判断 Chrome 文件权限无效，Chrome 实际偏好键是 `newAllowFileAccess`。按正确键重新核对后仍未设置；本轮进一步查明商店包 manifest 与调试文件注入要求不匹配，普通商店安装不显示可用的文件授权开关。网站访问已开启，不能归咎于用户漏开。完整证据见文末「源码诊断：商店版 0.5.1 与 Chrome 文件访问」，此前按错误字段作出的权限状态结论以本轮更正为准。

当前集成交付状态：等待真实平台验收，尚未完成完整交付。此前生产与专用验收配置均返回 `COMPONENT_NOT_INSTALLED`；日常资料已安装组件，侧栏文件权限问题已有源码诊断。2026-11-23 11:19（Asia/Tokyo）补充官方中控对照：未修改的中控及已安装发布助手通过本地真实 Chrome 文件选择，平台预检返回小红书、视频号均未登录，未进行上传。该对照使用显式本地组件目录，不改变正式组件发现配置或填写开关。最近全量回归仍为此前的 694 项通过，本轮未重跑；详见[本地对照记录](maitian-upstream-local-check.md)。

当前为 M0/M1 部分实现及 M2 执行、查询和人工核对闭环。已接入发布通道选择、账号确认、准备单和填写确认界面，以及历史记录操作；已补齐自有任务副本清理、七天终态保留、容量检查及正式目录迁移后的归属转交；真实填写开关尚未开放，旧 API 中断核对与升级指引已接入，真实平台验收仍待完成，不能宣称已支持小红书或视频号真实发布。目标仍是直接使用已安装的原版组件、保持上游文件不变，并由新任务自动采用兼容更新。

## 已实现范围

| 范围 | 当前实现 | 验证边界 |
| --- | --- | --- |
| 原版发现与只读加载 | 默认查找专用 profile 商店安装目录，按数字版本选择最新；本地原版目录须显式配置；独立 Node 进程与只读 ESM hook | 合成目录、公开基线、官方商店 CRX3 分发包及用户日常 Chrome 实装 0.5.1_0 通过；分发包签名/扩展 ID 及组件目录不变已核验，专用 Chrome 商店发现仍未验证 |
| 更新与能力探测 | 每次操作重新发现、独立进程 hello；manifest/lib 摘要；分别探测 validate/preflight/run/collectLinks；损坏最新版不回退 | 合成 A→B、规则更新、缺失单项入口、摘要变化和探测副作用拒绝通过；真实商店升级未验证 |
| 工程与导出 | xhs/channels 单视频、文案/话题/短标题、3:4/4:3 封面、显式时区；归属、流式复制、媒体元信息、faststart、原版校验与 tar.gz 下载 | 真实 ffprobe、独立解压、字节一致、修订/复制期间迁移保护通过；官方包和日常实装组件均通过四份工程 validate/scanProjects/check；原版侧栏已列出两份立即工程，小红书摘要可见，视频号详情及完整校验待验收 |
| 专用 Chrome 与兼容层 | 独立 user-data-dir、loopback CDP、进程/启动身份/实例/监听进程核验；tabs/debugger/scripting；按实例和 target 精确重开 | 模拟冲突、真实 headless Chrome 传输及有界面专用 Chrome 的实际安装页打开/原页重开通过；尚未安装扩展，无本项目平台选择器 |
| 配置、登录与预检 | open-install/open-login/preflight/open-page；原版登录预检；页面引用先落盘；重新登录使既有账号 epoch 失效 | 合成与真实 IPC 通过；官方原包在全新有界面 Chrome 中对小红书/视频号均正确返回未登录；登录成功与实际商店安装仍未验收，账号标签来自用户确认，不冒充稳定 ID 验证 |
| 统一记录与迁移 | v1 读取、原字节私有备份、原子 v2 迁移；provider 缺省 api；v2 不降级；执行、防重、目录阻塞分开 | 双 Host 迁移与追加、旧 publishing 保守阻断、API v2 完整投稿回归通过 |
| 旧 API 中断核对 | 所有稿件的旧 publishing 总览；原记录摘要确认、旧 Host 停止与平台检查两项人工确认；原字节 0600 备份后持久化 unknown | 9 项服务/HTTP 与 5 项 UI 测试通过；活动/真实存活进程拒绝、重复/迟到/双 Host 保护、回执防重保留、后续原账号回查及 v2 升级通过；不自动证明无登记旧 Host 已退出 |
| 发布活动登记 | API 账号读取/准备/执行/回查与浏览器准备/执行先登记唯一活动 owner | 尚无任务记录时也不能跨 Host 迁移；真实子进程存活与退出后的回收通过，不按年龄清理存活 owner |
| 浏览器确认单 | 五分钟内同平台原版成功预检、人工账号确认；固定文案、时间、文件/工程/组件摘要和修订；只生成 prepared | 账号失效、组件变化、复制期间修订/跨通道冲突、无上传副作用、真实 HTTP 来源和字段检查通过 |
| 原版填写执行 | queued 原子争抢；runner 取得 profile 锁；原版校验/预检；Host 持久化执行意图后授权原版 publish.run；接收 onChange/shouldStop | 合成入口参数、真实 IPC、双 Host 争抢、真实 Chrome 文件选择通过；没有真实平台上传或最终提交验收 |
| 停止与中断 | 跨 Host 私有停止文件；原版 shouldStop 协作取消；子进程 close 后才停止租约；status 读取时按 PID/启动身份恢复 | 取消当前步骤继续、首条进度前失联、上游 failed、新状态/异常返回、真实存活 runner 与过期租约通过；不会自动重投 |
| 原版结果查询 | 每次重新发现兼容组件；独立 collectLinks runner 与查询租约；只传原任务工程数据，不调用上传校验/预检/run 或读取已释放媒体 | 服务、HTTP、双 Host、IPC、合成组件与真实 Chrome 通过；实际平台查询未验证 |
| 证据与人工核对 | 首次候选不改成功状态；人工关联作品/确认未提交/归档，记录操作者、时间、原因与检查项；同一明确作品 ID 的后续查询可更新状态 | 同标题旧作品、空链接、未知返回、敏感字段、过期候选、重复关联、存活查询和失败恢复通过 |
| 归档与快照释放 | 原状态与防重保留；先持久化释放意图，再核对归属并删除任务副本，最后完成归档；原素材不删除 | 释放失败保留审计/目录阻塞，重试、符号链接/错误 manifest 拒绝、真实快照删除通过；归档与自动清理共用本机存储锁 |
| 快照保留与容量 | 私有工作区归属、跨 profile/Host 存储锁；准备前后清理过期/被替换副本；可信终态七天保留；任务目录 2 GiB 上限、复制/导出打包保留 500 MiB 磁盘余量 | 18 项存储测试与导出容量测试通过；真实进程持锁/退出恢复、终态边界、失败重试、工作区副本隔离和清理后查询覆盖；旧目录无归属时保守保留 |
| 正式迁移副本归属 | 存储锁 → 源 Store 锁 → 目标 Store 锁；复制校验及活动/进程复核；本机私有转交索引原子更新；新目录旧准备单失效、旧备份原字节保留 | 连续迁移、旧 Host 释放拒绝、目标七天清理与查询/归档、双 Host 竞争、真实存活进程、配置激活失败恢复、目标记录变化及实际设置 HTTP 覆盖；直接复制和无归属旧副本不接管 |
| 本地进程保护时限 | 可配置 1–1440 分钟，默认 360 分钟；绑定确认单，修改后重新准备；到时请求原版协作停止，宽限 30 秒后终止执行器 | 真实子进程协作/不响应停止、超时期间迟到 ready、活跃租约与防重、配置 UI 通过；并非上游内部上传时限探测 |
| 正式准备/确认界面 | 手动/API/浏览器通道与 now/scheduled 分开；浏览器不读取 API 参数或显示 API 投稿按钮；账号两项人工确认、完整固定文案/素材/时区、过期与变更失效、开始前保存和防重复点击 | React 组件及真实 React DOM → Host → 原版合成契约 → Chrome 通过；未完成真实平台验收，开始填写按钮仍按 directFill:false 禁用 |
| 配置与历史 UI | 中英文配置/导出、保护时限、历史查询/停止/原页/作品管理/关联/未提交确认/归档，活跃轮询 | UI 测试通过；原页按钮只传任务标识；独立预览不调用真实发布接口 |

导出不会创建发布记录或把稿件标记为已发布。已知已有结果时导出须明确确认；外部原版面板执行后的上传不受工作台防重控制。

配置与运行文件位于 `dshHome()/media-desk-publishing/maitian/`，不进入普通稿件同步。公开响应不返回组件目录、Node/Chrome 路径、CDP 地址和原 target。页面记录在本机 `browser-operations/`，固定工程在 `runs/`，跨 Host 停止指令在 `task-controls/`，任务副本原始归属在 `snapshot-owners/`，正式目录迁移的有效归属覆盖在 `snapshot-transfers.json`；归属文件含本机工作区路径，只保存在私有运行目录。

## 本轮 M2 关键约束

1. 纯 API 工作区继续写 v1；首次浏览器准备在 profile 锁、Store 锁保护下升级 v2，保留原文件字节备份。旧 publishing 即使超时也先拒绝迁移，不能凭 deadline 推断旧进程退出。现提供人工中断核对入口，确认其他旧 Host 已停、平台已检查后，将原记录持久化为 unknown 并保留回执/防重，才可继续迁移。不提供自动备份还原或降级。
2. 准备阶段只读原版校验、复制文件及落盘，不上传。要求原版近期预检、同 profile/platform/组件摘要、当前账号 epoch 和人工标签。上游目前没有稳定账号 ID，因此无法自动发现所有手动换号。
3. start 需要 id、taskId、完整工程摘要及 confirmed:true。同工作区多 Host 只能领取一次；开始和授权时复核配置、组件、账号 epoch、修订、源素材及固定字节。大文件读取在 Store 锁外完成。
4. IPC 首先发送 prepare-fill 初始化。runner 只能获取 profile 锁、校验固定工程并调用原版预检，然后发送 ready 等待。Host 原子保存 executionIntentAt/runId 后才发送 execute，runner 再复核固定字节与组件并调用原版 publish.run；没有复制或直接调用 adapter.fill。
5. 每条任务事件匹配 requestId/taskId/runId/递增 seq；独立心跳和日志限额。子进程结果消息不代表已退出，Host 等待 close 及前序事件回写结束，才保存 lease.stoppedAt。心跳过期会诊断 unknown，但不会凭时间释放存活进程。
6. 已授权后异常、协作取消、上游 failed 或未知结果均保持 unknown 与防重。已填好仅为 awaiting_user，表单预约成功也不代表平台已经接受预约。不会自动重传、最终发布或撤销 Chrome 已开始的上传。
7. 取消不获取第二份 profile 锁。当前原版步骤可能继续；停止请求返回时仍可为 executionActive:true，直到实际执行器退出。已取消但可能上传的任务不能自动重试。
8. Host 与 runner 均确认退出后才恢复执行租约；活动 owner 信息缺失时保守阻塞。未知、待人工发布等状态继续阻止目录切换；归档不能仅靠 archivedAt 放行，也不会解除内容防重。

9. 查询使用独立 `reviewLease`，不替换原填写 runId 或页面记录。需要再次人工确认原账号及身份限制；每次重新检测最新版查询能力。查询失败、没找到、状态未识别均保留原发布状态和防重。查询期间阻止并发查询、人工核对和目录切换；查询中断不把已发布任务降为 unknown。
10. 首次返回即使带 URL/作品 ID，也仅作为候选。首次人工关联后，仅上游明确返回同一作品 ID 且状态与字段有效时自动更新；不从 URL 推导 ID，不把标题一致当关联。上游 time 保留原文；实际预约时间只能由明确证据或人工核对提供。
11. 人工解除需确认流程停止、平台和原页无本次提交、残留已处理；既有已发布/处理中/预约证据不能按未提交解除。归档需确认原页与结果已处理、同意释放副本；不会将 unknown 改成 failed，也不会解除防重。释放失败时保留 release-pending 审计及目录阻塞。
12. 本地填写总时限默认 360 分钟，配置范围 1–1440；确认单固定该值。到期先记录停止请求并经原版 shouldStop 协作，30 秒后仍未退出才终止 runner；实际 close 前保持活跃租约。可能已经上传的任务保留 unknown，Chrome 上传可能继续，不能据此重投。

13. 准备操作前后按需清理本工作区拥有的副本，不运行按文件年龄删除的后台定时器。仅有私有归属记录、匹配 manifest/工程摘要且所有任务引用均允许释放时才删除；过期或被替换的准备副本无上传意图，可信 published 或可安全重试的 failed/cancelled 满七天可释放。unknown、awaiting_user、pending_review、scheduled、未核对 rejected、未知状态和活跃进程继续保留。
14. 本机 runs 总量上限 2 GiB；创建前及每份文件复制前从已验证文件描述符获取实际字节数，同时给元数据留 2 MiB 预算、给磁盘留 500 MiB 余量；不足返回 507，不删除尚未成功替换的有效准备单来挤出空间。导出不计入 runs 配额或自动清理，但复制和 tar 打包前均检查磁盘余量。
15. 只有设置页正式迁移在复制校验、双 Store 锁与活动/进程检查后原子转交自有副本；新目录旧确认单失效，旧备份保持原字节但不能开始或释放已转交副本。普通复制/打开不接管归属；现存无归属任务副本须先原地核对归档，飞书 storageIdentityRoot 不提供归属证明。转交后配置激活失败可打开已校验目标继续管理；查询、防重和七天保留起点不重置。

API 升级辅助入口为 `GET publish/interrupted` 和 `POST publish/recover-interrupted`：总览不受单稿最近二十条历史限制；恢复只接受 id/taskId/recordDigest/actor/reason/confirmed:true/oldHostsStopped:true/platformChecked:true，不接受任意路径、目标状态或解除防重字段。所有当前已登记发布活动都会阻止恢复；无登记旧版进程依赖明确人工停机确认。

服务端已提供 `POST publish/maitian/prepare`、`start`、`cancel`、`review`、`reconcile`、`open-page`、`open-management`，均要求同源 JSON 且拒绝任意路径/target 等额外字段。任务原页仅接收 id/taskId，Host 内部精确解析；管理页使用当前原版 ADAPTERS 的入口。统一 `GET publish/status?id=…` 返回历史与跨通道防重信息。`canLocatePage` 仅表示可尝试精确定位；实际激活成功才返回 canOpenPage:true，丢失页面不会新建重放。

## 当前使用方式

完整入口需在 DSH Host 中使用。打开稿件「发布」页，选择「浏览器填写」，麦田配置面板会自动展开。原「手动发布」和「API 投稿」保留独立通道；旧手动草稿不会自动切到 API。

以下为准备、导出与人工核对流程；直接开始上传仍未开放。

1. 保存并启用专用 Chrome 设置；默认来源为商店安装。Node/Chrome 无法启动时配置本机路径，端口冲突时使用空闲端口。
2. 点击安装引导，在这份独立 Chrome 资料中安装原版。日常 Chrome 已安装不代表专用资料已安装。
3. 检测原版组件。结构兼容表示可加载和可发现入口，不表示真实平台验收通过。
4. 选择小红书或视频号，打开平台登录页并调用原版登录预检。账号仍须在专用 Chrome 人工核对。
5. 选成片、比例封面、文案及短标题；浏览器通道单独选择「立即填写」或「平台预约（北京时间）」。预约显示输入的完整时间、Asia/Shanghai 与对应 UTC，最终提交仍需在平台完成。
6. 在成功预检五分钟内填写目标账号标签，勾选人工核对与身份限制两项确认，再点「检查并准备浏览器填写」。这一步先保存编辑、固定文件并调用原版校验，不上传。确认单显示实际固定文案、文件字节/SHA-256、组件版本、账号和预约时间。
7. 准备单中的「确认并开始填写」暂时禁用，并明确提示真实平台验收未完成。正式开启前仍可校验并导出工程，在原版插件面板打开；原版实际导入也待验收。
8. 「打开刚才的原页面」只激活原实例与 target；原页关闭或 Chrome 重启时不可恢复，不新建页面重放。
9. 已有浏览器任务的投稿记录提供原发布页、作品管理页、请求停止、查询、人工关联、确认未提交和归档。查询前再次确认原账号；关联/解除/归档需填写操作者、原因及对应核对项。
10. 配置页可调整「填写保护时限（分钟）」。这是本地进程总时限，默认 360 分钟，不等于原版上传等待时限。修改配置会使原确认单失效。
11. 如首次浏览器准备提示旧投稿尚未核对，在麦田面板点「检查升级前的 API 投稿」，读取整个工作区的旧记录，其他稿件及已删除稿件也可处理。先完全停止其他/旧版 Host，在原账号检查平台，再填写操作者/原因并完成两项确认。核对只将旧执行状态持久化为结果未知，仍防重；处理完后重新准备会继续升级，不会重投原任务。

服务端执行链路及正式确认界面已实现。`implementation.directFillUI:true` 表示准备与确认界面已接入，`fillExecution:true` 表示内部执行能力存在；`directFill:false`、`liveVerified:false` 表示真实填写入口尚未交付。界面可生成准备单，但不能开始实际上传。自动化测试使用本项目自行编写的原版契约样本检验开始分支，不能据此声称平台已经支持。

发布文案、媒体摘要、组件/配置、目标账号变化会清除界面确认；预检或准备单过期则不能开始。正式开始分支先保存并复核当前草稿，再发送 id/taskId/projectDigest/confirmed:true；组件路径、targetId、媒体绝对路径均不从界面传入。

独立预览 `http://127.0.0.1:4311` 仅用于页面与本地编辑，继续拒绝真实发布和浏览器接口。2026-11-23 已按请求再次重新构建前端（726.3 KB）并重启同时提供页面与接口的本地预览服务；页面、脚本、state 及发布状态接口均为 HTTP 200，旧 API 中断总览接口在独立预览中按设计返回 HTTP 409。最近一次重启日志：`/tmp/dsh-media-desk-preview-20261123-restart.log`。

## 本轮验证记录

2026-11-23，开发机 macOS、Node v24.22.3：

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| npm test | 693 项通过，0 失败、0 跳过 | 原 API 全量回归、记录迁移/目录约束、通道隔离/正式确认界面、确认单、执行/停止/保护时限/恢复、查询证据/人工核对/快照归档、真实 IPC 子进程、工作区归属/快照保留/配额、旧 API 核对升级与 UI、正式目录迁移/失败恢复/双 Host 归属竞争 |
| npm run build | 通过，client.js 约 726.3 KiB | DSH 插件前端构建 |
| git diff --check | 通过 | 已跟踪文件差异格式 |
| npm pack --dry-run --json --ignore-scripts | 通过，190 个包文件、31 个麦田运行文件 | 使用已验证构建；含新增归属模块，连接层、runner/ESM hook、文档及声明齐全；不含原版组件、平台实现、测试样本及私有记录 |
| 专用真实 Chrome 填写/查询/归档冒烟 | 通过，Chrome/157.0.8103.79 | 服务 → 独立 runner → 只读合成组件 → shim → CDP 文件选择/查询；首次人工关联、同 ID 后续更新、归档释放且保留防重；明确未使用真实平台 |
| 真实浏览器正式准备界面 | 通过，1440 px / 420 px | 实际 React 页面、保存队列、Host 路由、原版合成预检/校验及确认单；无平台请求，验收开关阻止开始 |

全量测试日志：`/tmp/maitian-development-tests-20261123-relocation.log`。包清单：`/tmp/maitian-package-manifest-20261123-store-verification.json`。真实传输报告：`/tmp/maitian-review-smoke-20261123.log`，脚本为同名 `.mjs`。临时日志仅为本轮本机证据，不是运行依赖，也不随包分发。

新增或扩展测试包括：`test/publish-api-recovery.test.js`、`publish-api-recovery-ui.test.js`、`publish-records.test.js`、`publish-entry.test.js`、`maitian-prepare.test.js`、`maitian-tasks.test.js`、`maitian-fill-operation.test.js`、`maitian-task-ipc.test.js`、`maitian-results.test.js`、`maitian-review-operation.test.js`、`maitian-review.test.js`、`maitian-history-ui.test.js`、`maitian-ui.test.js`、`maitian-prepare-ui.test.js`、`maitian-snapshot-storage.test.js`、`maitian-export.test.js`、`publish-readiness.test.js`。合成组件与 IPC peer 均自行编写，不包含上游平台实现。

真实 Chrome 冒烟使用一次性独立资料与空闲端口，在 data: 页面中的本地文件输入框选择固定视频，实际读取 49,551 字节。验证了执行意图先落盘、执行器退出后租约停止、最终 awaiting_user、精确原 target 重开且页面数量不增加、同一合成组件目录摘要前后一致。随后在原版合成 collectLinks 中创建并关闭 data: 查询页，首次已发布候选仍保持 awaiting_user；人工关联显式作品 ID 后，再查询同 ID 才更新为 published。两次查询子进程均退出，原填写 runId 与执行意图未变。归档实际删除固定工程，仍保留防重，原素材字节和组件摘要保持一致。此处 published 是合成结果，不能当作真实平台成功。

完成后仅终止测试创建的 Chrome 并清理临时资料；没有平台请求、账号、外部上传或点击发布。

另完成真实 Chrome 页面冒烟：实际 PublishPage/useWorkspace/React DOM 通过原生输入事件编辑文案，调用真实 workspace/save、Host 预检/prepare 路由与独立 runner；自编契约组件仅打开 data: 页面，不访问平台。准备单包含编辑后固定标题、人工账号及 SHA-256，最终确认勾选后开始按钮仍受当前验收开关限制。检查没有调用 API prepare/start 或浏览器 start，无 JavaScript 异常，原组件摘要不变；420 px 宽对话框无横向溢出。报告 `/tmp/maitian-form-browser-smoke-20261123.log`，脚本同名 `.mjs`，截图为 `/tmp/maitian-form-browser-20261123.png` 与 `maitian-form-browser-narrow-20261123.png`。开始分支及重复点击/保存期间改稿由组件测试覆盖；此次真实浏览器页面验证没有开始上传。

此前公开研究基线 0.5.1 的只读 hello 已通过，识别 7 个平台与四类操作，原目录未修改。该基线未打包，也不是默认运行来源。以上合成、公开基线与无账号 Chrome 证据，均不能证明实际商店最新版的模块或平台行为。

## 本轮存储开发记录

新增 `src/publish/maitian/snapshot-storage.js`，为本机任务目录分配和删除提供独立跨进程锁；原版组件和平台代码未改动。私有归属记录先于 staging 建立，提交前固定工程摘要，处理中断可在下一次准备时识别自有的未引用 staging/工程。自动清理先写释放意图，再删除并记录 `snapshotReleasedAt/snapshotCleanup`；删除失败保留 `snapshotCleanupAttempt`，修复后可重试。终态时间 `snapshotTerminalAt` 与展示用 updatedAt 分开，重复结果查询不重新计七天。

新增 18 项存储测试，另加 1 项导出容量测试：覆盖实际字节配额、磁盘检测失败与精确边界、过期/替换清理、七天前后、未知与多任务引用保留、损坏归属/manifest、符号链接、复制工作区不可认领、释放失败重试、真实独立 Host 持锁/退出恢复以及释放媒体后原版查询仍有效。测试日志 `/tmp/maitian-snapshot-storage-tests-20261123.log`；该轮全量 661 项通过。构建检查发现纯结果模块引入 Node 存储代码的问题，已拆出纯 `record-policy.js`，714.6 KiB 前端重新构建通过。

真实 Chrome 准备页面已按最新代码再次冒烟，报告 `/tmp/maitian-form-browser-smoke-20261123-storage.log`：编辑保存、固定确认单、420 px 无横向溢出、无 JavaScript 异常、无 API/浏览器开始请求、原版合成组件摘要不变；没有平台上传。此轮没有增加真实平台验收结论。

自动清理是准备前后的按需维护，不表示后台七天到点立即删除。没有可信终态时间的旧记录、不属于当前工作区的有效归属、无归属旧目录、摘要异常及任何不确定任务保持原样；需要在有效归属工作区显式核对归档。不使用飞书 storageIdentityRoot 推断副本所有权。

## 本轮旧 API 核对开发记录

新增 `src/publish/api-recovery.js` 和 `client/api-recovery.jsx`，提供跨稿件旧执行记录总览及人工确认界面。历史单稿也可进入核对，麦田面板的总览可找到最近二十条之外及原稿已删除的旧记录。服务端核对完整原记录 SHA-256，拒绝过期确认覆盖后来回执或状态；先保存整份 `.publish-records.json` 原字节到 `.publish-records.recovery-<UUID>.backup.json`，再写人工审计和 unknown。备份权限 0600；原 receiptId/workId/submissionStarted/封面结果/计划不改，公开界面只投影核对人和时间，不泄露备份文件名。

入口需明确确认所有其他桌面/网页/旧版 Host 已完全停止和原平台已核对；当前版本活动登记或其他仍有效 API 执行存在时，人工声明也不能绕过。没有活动登记的旧版本无法自动核验进程是否停止，界面如实说明这一限制。重复确认幂等，已恢复记录拒绝迟到的 updateClaim；已有成功或新的平台状态不能被旧确认覆盖。此功能只恢复可升级的持久状态，结果未知和防重保持，不提供 API 未提交解除或自动重投。

新增 9 项服务/真实 HTTP 与 5 项 React UI 测试，覆盖确认字段、原字节备份、回执/防重、活动与真实子进程、重复/迟到/双 Host、其他/已删除稿件、v1/v2、后续原账号原回执查询。定向日志 `/tmp/maitian-api-recovery-tests-20261123.log`。全量 675 项通过，725.2 KiB 构建通过；打包 189 文件，30 个麦田运行文件，无上游平台源码、私有记录和测试样本。

真实 Chrome / React DOM / Host 冒烟也完成：合成一个已删除稿件的 v1 中断记录，在界面填操作者、原因和两项确认，经真实 HTTP 保存精确备份与 unknown；随后准备浏览器任务，原记录无损升级到 v2，新 prepared 正常生成。1440/420 px 检查通过，无 JavaScript 异常或平台/上传请求，上游合成组件摘要不变。渲染检查发现新核对框继承普通输入框尺寸，已使用专用 checkbox 样式修复并重新检查。报告 `/tmp/maitian-api-recovery-browser-smoke-20261123.log`，脚本同名 `.mjs`，截图 `/tmp/maitian-api-recovery-browser-20261123.png`、`/tmp/maitian-api-recovery-browser-narrow-20261123.png`。以上均是本地合成数据，不能替代真实平台验收。

## 本轮目录迁移开发记录

新增 `src/publish/maitian/snapshot-ownership.js`，正式迁移复用原设置入口。锁顺序为本机副本存储锁 → 源 Store 锁 → 目标 Store 锁；先检查活动与真实进程身份，完成目录复制和字节校验，再复核目标发布记录和活动。已有可信归属的全部源副本（包括未记账遗留副本）通过本机 0600 的 `snapshot-transfers.json` 一次原子写入转交，记录规范路径、原归属和工程摘要、迁移 ID/时间。查询、原 runId、平台状态、防重和七天保留起点不改变；旧目录发布记录保持原字节，只有新目录的 prepared 失效。

清理、开始和归档均读取有效归属；连续迁移后，旧目录和中间目录无法释放最后目标拥有的副本。清理完副本和原归属文件后移除对应转交项。文件管理器复制、直接打开副本、飞书身份继承都不能获得副本所有权；缺少可信归属的现存任务副本在复制前即拒绝迁移，先在原目录核对归档。复制失败时不发布目标；归属提交后配置激活失败则保留已校验目标，重新打开该目标可恢复管理，不回滚已提交归属。目标在公布后被另一写入修改时拒绝覆盖和转交，保留两个目录供核对。

新增 `test/maitian-storage-relocation.test.js` 共 18 项测试，包含真实独立进程持锁/退出、存活执行器、双 Host 竞争、源/目标隔离、多副本一起转交、连续迁移、原字节备份、过期准备替换、七天保留、只调用 collectLinks 的查询/归档、旧归属和损坏索引拒绝、目标记录变化、配置失败恢复及实际设置 HTTP 路径。定向日志 `/tmp/maitian-storage-relocation-tests-20261123.log`。全量 693 项通过，726.3 KiB 构建、190 文件打包与格式检查通过；包内有 31 个麦田运行文件，不含上游平台源码、私有记录、运行目录或测试样本。独立预览页面、脚本、state/发布状态接口继续 200，真实发布接口继续 409。此轮没有平台上传或新增真实账号验收结论。

## 本轮官方分发包离线核验

本机常用 Chrome 配置和麦田专用目录仍未发现目标扩展，麦田本机配置未启用。通过原生 Chrome 查看官方商店页面，显示版本 0.5.1、更新日期 2026-11-18；从 Google 官方更新服务下载 CRX3 发布包，82,905 字节，SHA-256 为 `5c13383d76c3a8da28af7dcb03f3ee0bb9398c14e98c2631ef10abe23e068ab4`。参照 Chromium 官方 CRX3 协议，验证三份签名 proof 均有效，开发者公钥摘要生成的 ID 与 `eaaipbilkhibicihiollecmbpneikpnj` 一致。包内 `LICENSE` 为 Apache-2.0；没有进行安装、接受新的安装条款、授权浏览器权限或登录平台。

原包共有 33 个 ZIP 成员，其中 29 个普通文件；与公开研究基线相比，只有商店 manifest 和 `_metadata/verified_contents.json` 不同。该比较仅针对本次取得的具体包，不将 0.5.1 作为未来运行版本锁。只读加载后的 manifest/lib 引擎摘要为 `4a36e52b3151b74863c5eb749e6c50ce8b1854b5ccadc5148815969ce0a415dd`，完整 29 文件树摘要为 `f0b723524c60f6ed3c77fce3fa6b8d673ebc9dccc05fcdc79c08de642c01a5ad`。核验前后所有文件清单和字节摘要一致，未向原版目录添加 package.json 或修改模块。

新增开发脚本 `scripts/verify-maitian-component.mjs`，仅针对明确提供的原版目录执行离线兼容检查。它生成独立的测试工作区、使用仓库测试视频及真实 3:4/4:3 封面，经过实际 ContentAssets、ffprobe、快照、原版校验、tar 导出与独立解压，逐项核对文案、话题、短标题、封面字节、视频摘要和完整预约 UTC。小红书/视频号各 now/scheduled 一份，共四份工程通过；每份的缺失视频与超过当前组件字段上限两个反例也被原版拒绝。

实际调用仅为 hello/validate，共 17 个独立 runner；另一个独立子进程调用原版 scanProjects/check，四份解压工程全部被识别且无校验错误。该扫描使用只读 File System Access 方法适配器，不是侧栏 UI 导入。源素材与原版全部文件保持不变，没有创建发布记录、运行 Chrome 填写、调用 preflight/run/collectLinks 或开启真实填写开关。四类入口存在只表示结构可发现；真实行为仍待验收。

验收报告原始 UTC 时间为 `2026-11-22T20:24:41.044Z`，Node v24.22.3、macOS arm64；临时目录沿用本会话 `20261123` 标签。报告：`/tmp/maitian-store-verification-20261123/final-acceptance/report.json`；执行日志：同目录上一级的 `final-acceptance.log`；来源/签名记录：`download.json`、`signature.json`，导出的四个工程在 `final-acceptance/local-config/exports/`。这些是本机验收证据，不是运行依赖，也不打包分发。脚本已实际运行通过，并验证现有输出目录不覆盖、组件缺失不创建输出、帮助与参数边界。最近全量回归仍为 693 项通过；本轮没有改动运行代码，不重复把离线检查计入 npm test 数量。

源码检出目录中可复现（输出目录必须是新目录；省略时自动创建临时目录）：

```sh
node scripts/verify-maitian-component.mjs \
  --component-dir /绝对路径/原版组件目录 \
  --output-dir /新的验收输出目录
```

此脚本只供源码开发核验，不随 npm 运行包分发；默认运行时仍只发现专用 Chrome 的商店安装目录，不读取本次研究目录或强制固定组件版本。打包再次核验为 190 个文件、31 个麦田运行文件，不含原版 CRX/平台源码、验收报告、开发核验脚本或私有运行数据；格式检查与独立预览页面/脚本/state 的 HTTP 200 检查通过。M0 的“商店原版可在外部进程只读加载”已有官方包证据；专用 Chrome 实装、侧栏 UI 导入、真实平台填写/人工发布/查询及兼容安装更新仍未通过。

## 本轮专用浏览器与安装验收准备

通过实际 `MaitianPublishing.browser('open-install')` 创建有界面的专用 Chrome，再以同一 operationId 执行 `open-page`，原安装页重开成功。临时配置为 `source:store`、profileId `default`、端口 9333；资料目录是 `/tmp/maitian-store-verification-20261123/browser-acceptance/runtime/profiles/default/Default`。原生产配置没有启用或修改。启动报告 `browser-acceptance/setup-report.json` 的原始 UTC 为 `2026-11-22T20:31:55.962Z`；再次核实进程身份和本地监听的 `browser-acceptance/readiness-report.json` 为 `2026-11-22T20:39:13.815Z`，目录仍沿用 `20261123` 会话标签。该次 Chrome PID 85595、127.0.0.1:9333 的实际监听者一致；这只是本轮进程证据，不是固定 PID 配置。

正式 `probe()` 与脚本实际发现均返回 `COMPONENT_NOT_INSTALLED`，未退回离线研究目录；`directFill:false`、`liveVerified:false` 保持不变。桌面控制工具此时只能绑定日常 Chrome 资料，未能精确绑定这份独立资料，因此未点击日常窗口中的安装按钮。已经请求用户在上述专用资料中完成商店安装；原包会申请 debugger、tabs、scripting、storage、sidePanel、notifications，以及 manifest 列出的平台站点权限，安装授权仍待用户操作。没有授权新权限、平台登录、上传或最终提交。

开发验收脚本补充 `--installed-config-dir` 模式，通过正式 `discoverEngine` 和服务解析路径发现商店安装版本；读取实际 Node/profile 设置，每次导出继续重新发现组件。报告、测试素材和工程仅写入新验收目录；原配置只读，结束时复核原配置字节、实际发现目录、引擎摘要及组件全目录字节。它不安装、不启动浏览器，也不能仅凭目录存在证明商店来源、扩展启用或侧栏可用。安装完成后运行：

```sh
node scripts/verify-maitian-component.mjs \
  --installed-config-dir /tmp/maitian-store-verification-20261123/browser-acceptance/runtime \
  --output-dir /新的实装验收输出目录
```

这是本轮临时环境的复现命令；正式运行或后续更新核验时，将配置目录换成实际 `dshHome()/media-desk-publishing/maitian/`，不把临时路径设为产品默认值。输出目录须不存在。脚本在组件缺失、配置缺失、来源不是 store 和参数错误四种情况下均已实际拒绝，不创建报告目录，专用配置字节保持不变。反例结果在 `configured-verifier-negative-checks.json`。原 `--component-dir` 路径重新运行通过，四个工程、八个原版拒绝反例、17 个独立 runner 和原版 scanProjects/check 均保持通过；报告 `configured-verifier-local-regression/report.json`，日志同名 `.log`，均位于官方分发包临时验收目录下。本轮只改验收脚本和文档，最近全量运行代码回归仍为 693 项；尚无已安装组件的成功报告，不勾选实装项。

## 本轮原版未登录预检实证

通过正式 `MaitianPublishing.browser('preflight')` → 独立 runner → 官方 CRX3 原包的 `publish.preflight` → 本项目 Chrome shim → 实际有界面 Chrome，分别访问小红书与视频号原版指定的入口。为避免与等待用户安装的专用资料互相影响，此检查另建一次性空白 profile，显式使用 `source:local` 指向上述未改动的官方原包，端口 9344；不将这次结果记为商店实装或真实账号验收。测试包装仅允许 hello/preflight，其他操作立即拒绝。

| 平台 | 原版实际返回 | 用时 | 连接层结果 |
| --- | --- | --- | --- |
| 小红书 | `ok:false`，`小红书没有登录（跳到了登录页）` | 57,247 ms | 保留原页面引用，`canOpenPage:true`、`accountVerification:login-only` |
| 视频号 | `ok:false`，`视频号没有登录（跳到了登录页）` | 6,285 ms | 保留原页面引用，`canOpenPage:true`、`accountVerification:login-only` |

报告原始 UTC 为 `2026-11-22T20:43:26.665Z`：`/tmp/maitian-store-verification-20261123/unauthenticated-preflight/report.json`；日志为上级目录 `unauthenticated-preflight.log`，目录仍沿用 `20261123` 会话标签。四个独立 runner 分别执行 hello/preflight/hello/preflight，长预检期间收到 12 条心跳，两个调用均正常结束。原包全部文件摘要和本次配置原字节前后一致；只在核对 PID/启动身份/专属资料路径后终止本次测试创建的 Chrome，9344 已无监听。等待安装的 9333 验收 Chrome 保留，生产配置没有启用或修改。

此次证明真实原版未登录返回值、参数调用与传输可用，未输入账号凭证、选择本地媒体或调用上传/结果查询；未测试已登录身份、视频/封面/预约填写以及最终提交行为。因此不开放真实填写开关，不勾选完整 preflight/run/collectLinks 契约或真实平台验收项。

## 下一阶段开发

完成以下真实商店、工程导入和测试账号联调；每项按实际证据记录，不能用合成组件替代。正式迁移的副本归属管理已接入现有设置入口，无需另行传入工程路径或手动修改归属文件。

## 尚未通过的真实验收

- 专用 profile 实际商店组件安装、适用条款、只读加载与契约核验。
- 小红书与视频号各一个工程，在原版插件中加载并核对媒体、文案及封面。
- 测试账号登录、上传、文案/封面/预约填写，并确认原版 run 不点击最终发布。
- 人工最终发布、原版首次查询结果人工关联、真实中断及恢复。
- 实际安装组件 A 升级到兼容 B，下一任务自动采用新版。
- Windows、Linux 和其他独立 Node 版本尚不在已验证范围。

最新状态：日常 Chrome 已实装 0.5.1，实际安装目录只读核验及两份工程列表导入已有证据；专用 profile 仍未安装，尚无已授权的专用测试账号。小红书原版填写遇到本地文件访问相关错误，权限调整与重试结果尚未确认。完整交付仍须补齐以上验收，不能用合成测试或离线工程扫描替代。

## 上轮阻塞与恢复入口

连续目标续轮复查的同一外部前置条件未变化：专用资料内未安装组件。最近正式探测原始 UTC 为 `2026-11-22T20:45:26.257Z`，返回 `COMPONENT_NOT_INSTALLED`；Chrome PID 85595 和 127.0.0.1:9333 的监听归属仍一致，未因等待而重启。已完成本地开发、自动化回归、官方原包离线检查及未登录预检，但不能继续证明实际安装目录、原版面板导入、真实账号填写/查询或实际组件升级。目标据此标记为 blocked，含义是等待外部前置条件，不是开发或验收完成。

恢复所需：用户在验收 Chrome 的专用资料（路径包含 `browser-acceptance/runtime/profiles/default/Default`）中完成官方商店扩展安装并确认；不要在日常资料安装。当前桌面控制接口无法准确绑定该独立进程，且扩展涉及新增 debugger 与站点访问权限，未代替用户授权。收到安装完成信息后，先重新执行正式 probe，成功后运行上述 `--installed-config-dir` 命令验证实际发现目录与原文件不变，再进行原版面板工程导入。真实平台阶段还需用户在专用资料登录测试账号，并明确用于上传/人工发布验收的测试内容。真实安装 A→B 更新仍须取得两版实际证据；这些条件未满足前保留未完成项及关闭的真实填写开关。

## 用户安装后的实证与工程导入交接

2026-11-23 10:13（Asia/Tokyo），用户提供已打开原版侧栏的截图，本机只读检查发现日常 Chrome `Default/Extensions/eaaipbilkhibicihiollecmbpneikpnj/0.5.1_0` 实际安装目录。此前“本机完全未安装”的结论已过时；生产/临时专用 profile 的正式 probe 仍为 `COMPONENT_NOT_INSTALLED`。没有复制日常 Chrome 资料、账号或扩展到专用资料，也没有把默认发现路径改成日常浏览器。

已对上述真实安装目录运行 `verify-maitian-component.mjs --component-dir …`，四份工程、八个原版拒绝反例、17 个独立 runner 及原版 scanProjects/check 全部通过；完整安装组件文件前后不变。报告 `/tmp/maitian-store-verification-20261123/installed-daily-acceptance/report.json`，执行日志 `installed-daily-acceptance.log`。这里使用显式本地只读加载，证明实际安装模块兼容；不记为专用 profile 的 store 发现成功、侧栏导入成功或自动升级通过。

已将该轮新生成的两份 now 工程按字节校验复制到 `/Users/eric/Downloads/麦田工程导入验收-20261123/`，子目录为「小红书-立即填写」「视频号-立即填写」，每份含 publish.json、测试视频及比例封面。提供用户在当前已安装的原版侧栏选择「视频分发」→ NAS 发布目录「选择」→ 该父目录；本机路径填同一父目录。文件夹名称不代表必须使用 NAS，本次为本机测试工程。先检查工程列表、文案与素材，不点击填写或发布；X 长文入口不在本轮接入范围。交接清单 `installed-daily-acceptance/import-handoff.json`；面板实际导入结果仍待观察。由此可以推进 M0 面板导入，专用资料安装继续作为直接驱动的独立前置条件，不要求用户为了查看导出工程立即重复安装。

随后用户提供原版侧栏截图，NAS 发布目录已显示「麦田工程导入验收-20261123」，发布工程列表出现两个「本地工程验收」条目，目录分别为「视频号-立即填写」「小红书-立即填写」。这项直接 UI 证据确认两份 publish.json 在原版面板被扫描和列出；截图尚未显示选中后的校验卡、平台字段或封面元信息，不能记为媒体上传/封面填写通过。核对实际安装的 video.js，点击工程仅执行工程选择、原版 check、元信息与平台摘要渲染（另会读取 AI 文案面板状态）；上传需单独点击填写动作，不由列表选择触发。下一步分别选中条目，检查「校验通过」、video.mp4、对应平台及封面比例；当前不请求上传测试素材。

## 原版小红书填写失败诊断

用户继续提供截图：小红书创作者上传页已打开，原版侧栏显示选中小红书、标题「本地工程验收」、封面 3x4，上一轮状态为「异常」，原始错误 `{"code":-32000,"message":"Not allowed"}`。平台仍显示初始上传框，原版没有「视频开始上传」日志。可确认平台摘要已渲染及一次原版填写尝试失败；截图不能证明远端绝无上传，因此不据此解除任何本项目任务防重，也不标记上传或填写通过。

只读核对实际安装源码：小红书 `fill` 首步调用 `setFiles`；`lib/cdp.js` 先取得文件输入框 objectId，再调用 `DOM.setFileInputFiles`，成功后才记录「视频开始上传」。最初误读该扩展的 Chrome Secure Preferences `allow_file_access` 字段，该字段缺失不能证明实际文件权限状态，此判断已作废。Chromium 官方 `content/browser/devtools/protocol/dom_handler.cc` 的 SetFileInputFiles 在 `allow_file_access_` 为 false 时返回 ServerError("Not allowed")；官方 `chrome/browser/extensions/api/debugger/debugger_api.cc` 的 MayReadLocalFiles 取扩展 AllowFileAccess。

2026-11-23 10:39（Asia/Tokyo），用户补充截图，扩展详情中的「自动允许访问以下网站」总开关已开启，截图列出视频号、小红书等网站权限。该 UI 证实扩展网站 host 权限为开启，纠正先前把用户所说的“访问权限”笼统表述成关闭；截图未显示独立的「允许访问文件网址」控制项。当时仍误读 `allow_file_access` 字段，该项检查不构成文件授权证据；网站 host 列表含对应创作者站点。后续已按正确字段和源码更正，见文末。

在上述截图后执行正式组件探测（`2026-11-23T01:39:14.591Z`），生产与专用验收配置仍均为 `COMPONENT_NOT_INSTALLED`，真实填写仍关闭。原版一次 `Not allowed` 失败的直接原因尚未被确认；若用户已经在扩展详情另行开启文件网址权限，需要以该独立控件的状态或再次获得的原始失败日志继续诊断，不重复触发上传。网站访问权限的确认不解除专用资料未安装和真实平台联调条件。

2026-11-23 10:22（Asia/Tokyo）续轮只读复查，当时仍误用 `allow_file_access` 字段判断文件权限，后续已撤回该字段依据；生产/临时专用资料返回 `COMPONENT_NOT_INSTALLED` 的独立探测结果不受此更正影响。未代为授权或开始上传。已将目录选择、本机路径、原版文件权限和专用资料差异的处理方式补入 `docs/local-publishing-entry.md`；区分校验与真实上传、原版任务与工作台任务，明确不需要连接知识站生成既有工程文案。方案中“实际扩展目录只读模块加载”按已有四工程实装目录证据勾选，专用商店发现、面板完整校验及真实填写验收仍未完成。此轮只修改文档，使用 `git diff --check` 检查格式，不把既有 693 项回归说成重新运行结果。

## 验收运行环境一致性与输出隔离

2026-11-23 01:29 UTC 的本轮实装报告：修复开发验收工具中八个反例校验和原版工程扫描直接使用 `process.execPath` 的问题；现在 hello、导出校验、反例校验和 scanProjects/check 均使用本轮解析的 `nodePath`。配置模式固定开始时解析的设置，结束前继续核对实际配置字节与组件发现结果。报告的 `runtime.verifier/component/scanner` 分别记录执行路径和实际版本，扫描器版本须与 hello 一致；无效配置路径明确失败。

同时在创建任何输出目录前解析父目录的真实路径，拒绝写入原组件目录及实际配置目录；不能通过符号链接别名绕入。默认临时目录也先完成此检查再创建，不因验收结束时发现文件变化而留下已写入的原版目录。所有显式输出目录仍须不存在。

新增 `test/maitian-verifier.test.js`：使用自行编写的两平台合成契约及带审计的执行器包装，实测 17 个独立 hello/validate runner 与 1 个独立扫描进程全部经过配置路径；四份工程和 12 次 validate（含八个拒绝反例）均有检查。另验证原组件内输出、符号链接别名输出、实际配置内输出均在启动执行器前拒绝，配置字节不变；缺失 Node 时不回退，不生成成功报告。该测试属于配置传递和隔离回归，不是商店安装验收。

对用户日常 Chrome 的真实安装目录再次运行最终脚本，四份工程、八个原版拒绝反例、原版 scanProjects/check 和 17 个独立 runner 均通过。组件的 30 个文件（含 Chrome 元数据）和源素材在本轮前后不变，未创建发布记录、启动浏览器或调用上传。与上一份 `installed-daily-acceptance/report.json` 对比，组件指纹及完整树摘要也保持一致。本轮仍使用显式 `--component-dir`，不冒充专用 profile 的商店发现成功。

- 实装报告：`/tmp/maitian-store-verification-20261123/runtime-path-final/report.json`，原始时间 `2026-11-23T01:29:09.239Z`。
- 实装日志：`/tmp/maitian-store-verification-20261123/runtime-path-final.log`。
- 最终全量回归：`npm test`，**694 项通过，0 失败、0 跳过**，用时 16,160 ms；日志 `/tmp/maitian-development-tests-20261123-runtime-path-final.log`。
- 当前已验证环境：macOS arm64、Node v24.22.3；报告分别记录验收脚本、组件及扫描器的实际运行版本。

已同步方案中的运行时验收约束，并纠正概览中“尚未加载实装目录”“侧栏未导入”的历史表述。真实填写开关继续为 `directFill:false / liveVerified:false`；本轮没有调整扩展权限或重试小红书填写。仍待专用资料实装、原版完整工程校验、用户确认文件权限后的真实平台测试以及实际兼容版本升级，不能标记完整交付。

## 当前阻塞复核与恢复条件

在运行时一致性修复及其后目标续轮中，专用验收 profile 未安装组件这一外部前置条件持续未满足。最新正式 probe 时间为 `2026-11-23T01:39:14.591Z`，生产与临时验收配置均返回 `COMPONENT_NOT_INSTALLED`，`directFill:false / liveVerified:false`。日常 Chrome 网站访问权限已由用户截图确认开启；当时基于 `allow_file_access` 字段的文件权限判断无效，已由文末精确 Chrome 版本源码和 `newAllowFileAccess` 检查取代。最近离线报告和 694 项全量回归日志仍可读取，未出现可取代真实联调的新证据。本轮没有重新运行全量测试，也未修改浏览器权限、安装扩展、触发上传或重启现有进程。

本地实现及可独立完成的已识别问题已处理；现有条件下不能验证专用商店安装、已登录平台填写及人工发布回查。目标据此标记 blocked，表示需要外部条件变化，完整验收保持未完成。恢复时先在专用验收 Chrome 中安装官方组件并确认，重新执行正式 probe 和 `--installed-config-dir`；随后使用用户明确指定的测试账号与允许上传/人工发布的内容完成小红书、视频号联调。日常原版面板的文件权限调整由用户确认，不能将自动续轮视为授权或自动重试。真实安装 A→B 更新仍需两版实际证据，不由合成契约回归代替。

## 视频号原版面板再次报错

2026-11-23 10:47（Asia/Tokyo），用户提供视频号原版侧栏截图：工程摘要显示「视频号」、短标题及 3x4+4x3 封面，但执行后为「异常」和 `{"code":-32000,"message":"Not allowed"}`。这确认原版面板当前同样无法完成视频号填写；截图不证明上传已经开始或绝未开始。

对实际安装的 0.5.1 源码进行只读定位：`channels.js` 的 `fill()` 第一条操作是 `setFiles(...)`，其后才写入「视频开始上传」日志；`cdp.js` 中 `setFiles()` 先取文件输入元素，再调用 `DOM.setFileInputFiles`。小红书 `fill()` 也以同一 `setFiles()` 开始。结合两平台相同 CDP 错误，首次文件注入被 Chrome 拒绝成为诊断方向。用户已确认截图所示网站 host 访问开关开启；此前基于错误偏好字段的状态判断作废，文末已补充正确配置键、文件控件显示条件与实际 Chrome 版本的拒绝分支。本轮没有修改上游文件或 Chrome 设置。

## 源码诊断：商店版 0.5.1 与 Chrome 文件访问

时间：2026-11-23 11:03（Asia/Tokyo）；报告原始时间 `2026-11-23T02:03:39.484Z`。本轮直接核对用户已安装目录、先前通过 CRX3 签名验证的官方原包，以及本机 Chrome **157.0.8103.79** 对应标签的 Chromium 源码，不再仅凭同版本号或界面截图推测。

**源码结论：麦田商店包的权限声明与本地文件注入调用不匹配。** 当前所查日常 Chrome 配置没有本地文件访问授权，插件调用会命中 Chrome 的明确拒绝分支；同时该商店包没有让 Chrome 显示文件授权控件所需的声明。网站总开关开启不能解决这一声明缺口。该条件足以解释两平台相同的错误，不是要求用户不断重开网站权限。

### 版本与源码一致性

安装目录与官方分发原包均为 0.5.1，其 `lib/` 下 **18 个文件逐字节一致**，没有平台实现差异。实际安装目录的完整树摘要仍与 `runtime-path-final/report.json` 一致，本轮调查没有修改上游。Chrome 版本取自本机应用 Info.plist，下面的 Chromium 引用固定到 `157.0.8103.79`，不是用 main 分支代替已安装版本。

### 失败调用链

| 层次 | 源码位置 | 已确认行为 |
| --- | --- | --- |
| 小红书原版 | `lib/platforms/xhs.js:30` | `fill()` 先调用 `setFiles()`，成功后才记录视频开始上传 |
| 视频号原版 | `lib/platforms/channels.js:43` | 与小红书使用相同文件注入函数，文案和封面处理在后 |
| 原版公共调用 | `lib/cdp.js:78` | 取文件输入元素 objectId，再发 `DOM.setFileInputFiles`，传本机绝对路径 |
| 扩展调试客户端 | Chromium `chrome/browser/extensions/api/debugger/debugger_api.cc:847` | `MayReadLocalFiles()` 读取该扩展的 `util::AllowFileAccess()` |
| DOM 调试会话 | Chromium `content/browser/devtools/render_frame_devtools_agent_host.cc:427` | 将上述本地读取许可传入 `DOMHandler` |
| 最终拒绝点 | Chromium `content/browser/devtools/protocol/dom_handler.cc:42` | `allow_file_access_` 为 false 时立即返回 `Response::ServerError("Not allowed")`，尚未把路径交给页面 |

Chromium 在这条调用中先检查文件读取许可，之后才授权渲染进程读取指定路径。因此这一路的 `Not allowed` 不由工程标题、封面比例、NAS 文件夹名称或视频号话题内容生成。插件找不到元素时自己报「找不到上传框」；Blink 中元素类型错误则报 `Node is not a file input element`，与当前错误不同。平台原版 preflight 已先调用页面表达式，原版 run 将表单填写错误转成侧栏「异常」，不会保留失败 CDP method；当前没有用户那次运行的逐命令跟踪，不能声称已捕获当时的协议帧或排除所有额外问题。

### 为什么网站权限已开仍无效，而且可能没有文件开关

实际 manifest 的 `host_permissions` 只有明确的 HTTP/HTTPS 站点，没有 `file:///*` 或 `<all_urls>`；`permissions` 没有 `activeTab`，也没有文件匹配的内容脚本。Chromium `permissions_parser.cc:129` 与 `:154` 分别处理 activeTab 和文件 scheme，用来设置 `wants_file_access`。`extension_info_generator.cc:710` 仅在扩展需要文件权限或以已解压方式安装时将文件访问控件标为可用；`detail_view.html.ts:386` 再据此决定是否渲染「允许访问文件网址」。普通商店安装不满足这个包的显示条件。因此此前让用户反复寻找/开启该控件的建议不成立。

同版本仍可能因安装方式不同而表现不同：Chromium `extensions/common/manifest.h:98` 明确为「加载已解压扩展」提供初始文件访问。这里解释的是安装方式的差异，未观察作者开发机，也不声称作者一定使用哪种方式。

### 配置字段更正

此前多轮读取的 `allow_file_access` **不是 Chrome 实际的偏好键**，其缺失不能作为权限证据。准确版本 `extensions/browser/extension_prefs.cc:154` 使用 **`newAllowFileAccess`**，`:821` 的布尔读取在键缺失时返回 false。现在只读复查目标扩展，正确键也未设置，安装 location 为 1；普通 Chrome 进程没有 `--disable-extensions-file-access-check`，没有命令行全局豁免。该实际键值与源码拒绝条件相符；没有写入 Chrome 偏好，未改变授权。

### 对方案的影响与处理方向

原版侧栏要从商店版正常调用本地文件注入，上游需要补齐文件授权声明及用户授权流程，再重新连接 debugger 验证；仅重装同一商店包或反复开启网站访问不补齐声明。不能在本项目里改 manifest、加载修改后的副本或关闭 Chrome 的全局文件权限检查。

方案中的独立 Node + 自有 Chrome shim 直接连接专用 Chrome 的 CDP，复用原版平台模块，其协议客户端与扩展 `chrome.debugger` 客户端不同。Chromium `content/public/browser/devtools_agent_host_client.cc:25` 的基础客户端允许本地读取，HTTP/WebSocket 调试客户端使用此路径；本项目 `chrome-shim.mjs:80` 将原版同一 `sendCommand` 转发给外部 CDP。因此不能把侧栏的扩展授权问题泛化成原版模块无法复用，也不能据源码分析就宣布连接层真实平台验收通过。专用资料安装、测试账号、上传/封面/预约/人工发布查询及真实升级验收保持未完成。

### 可复查证据与本轮验证范围

- 机器报告：`/tmp/maitian-store-verification-20261123/debugger-root-cause/diagnosis.json`，含版本、18 个模块一致结论、正确偏好键、进程豁免检查、完整树摘要及固定版本源码 SHA-256。
- 固定版本源码与下载来源：同目录的 `sources.json` 和 `chrome-157-*` 文件，共 14 份成功下载的精确标签源码。
- Chromium 原始源码统一前缀：`https://chromium.googlesource.com/chromium/src/+/157.0.8103.79/`，加表中路径即可复查；`?format=TEXT` 返回可解码的原始内容。没有引用非官方二手说明作为根因依据。
- 原版目录及素材未修改，未启动/控制浏览器、开启权限、选择文件、上传或发布。本轮修改文档并运行 `git diff --check`，没有重跑 694 项全量回归，不把静态源码分支当作已完成修复的真实复测。

## 原版扩展本地最小复现：已确认文件注入拒绝

2026-11-23 后续续查通过原生 Chrome UI 打开实际商店版助手 DevTools，先在 Service Worker 读取到 `isAllowedFileSchemeAccess() === false`，并核实版本 0.5.1、扩展 ID、已启用状态、网站总开关开启及文件控件确实缺失。

随后在同一扩展原版 `sidepanel.html` 的页面上下文导入原装 `lib/cdp.js`，针对只在本机提供的空白文件输入页测试：`waitFor()`、`evaluate()` 和 input objectId 解析成功，原版 `setFiles()` 返回与用户相同的 `-32000 Not allowed`。再逐条使用原版 `send()` 确认失败命令为 **`DOM.setFileInputFiles`**。此测试绕开工程解析与真实平台，不修改或替换上游函数。它补齐了此前仅静态分析的运行时证据，但没有重放用户此前的平台后台任务，也没有证明解除权限后全部平台步骤通过。

完整输出、复现边界、首次 Service Worker 动态导入限制及上游修复验收条件见[诊断文档](maitian-not-allowed-diagnosis.md)。临时测试标签、debugger 连接和诊断面板已关闭，本地 8765 夹具服务器已停止并确认无监听。未改 Chrome 权限或安全参数、未重传平台素材、未最终发布；正式填写仍关闭。仅更新诊断记录，检查文档差异，不重跑全量回归。

## GitHub 源码直接调试：本地核心填写通过

用户进一步明确要求使用 GitHub 源码调试、无需商店安装。已 clone 官方发布助手仓库到 `.dsh-sandbox/upstream/maitian-publisher`，HEAD `171a30a3b8db7e4539e74f108f3d789a46172dab`，工作树干净。18 个核心模块与官方商店原包一致；manifest 差异仅 `update_url`，权限声明相同。

使用仓库自带 `adapter-loader.mjs`、`direct-loader.mjs` 及 Node CDP 工具，在新建无头 Chrome 中针对仅本机测试页执行原版小红书、视频号适配器 `fill()`。两者文件选择、标题与两行正文均实际读回正确，无填写失败日志。未安装扩展、未启动麦田中控、未修改上游、未上传平台素材。原版 CLI 对已导出两份工程校验通过，仓库 Markdown 内置断言通过。调试浏览器和本机服务已正常退出。

复跑脚本为 `.dsh-sandbox/maitian-source-debug/run-local-adapters.mjs`，报告为同目录 `result.json`。此结果验证源码直接调试路径，不能算真实平台联调或商店权限修复；具体传输差异、未覆盖能力及公开仓库停止在 0.5.1 的更新限制已补充到[源码调试记录](maitian-not-allowed-diagnosis.md#后续按用户要求直接调试-github-源码)。正式功能开关未改。

用户随后要求安装源码版。已在当前 Chrome Luming / Default 资料加载并启用原版 0.5.1，ID `omlpeokfcpccmdgamiklnkbnfdmhgibe`，固定源码目录 `/Users/eric/Developer/Project/mediadesktop/maitian-publisher`，上游工作树干净。安装后只读核对 Chrome 保存的 `newAllowFileAccess: true`；未改写偏好，未重传平台素材。原生文件选择及真实平台复测仍待完成，详见[安装记录](maitian-not-allowed-diagnosis.md#源码开发版已安装)。
