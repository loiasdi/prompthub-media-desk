# 麦田原版中控本地对照

日期：2026-11-23，Asia/Tokyo。用户要求下载原版主程序到当前项目并运行，核对与「直接复用发布助手」的关系。

后续更正：此前关于主程序的引导偏离了用户要求的「生成工程文件 → 原版助手导入执行」主流程。本轮启动的 `hub web` 服务已停止（核对命令行后的 PID 13419，端口 8787）；源码、报告及浏览器资料保留。本页的启动命令和测试结果仅为历史对照，不是当前推荐使用步骤。当前回到助手原生工程执行流程，原版侧栏 `Not allowed` 问题仍未修复。

## 结论与范围

目标仍是直接复用用户安装的发布助手，不修改其代码。官方中控并不是本项目的运行前置条件。官方 `src/driver.mjs` 把 `src/chrome-shim.mjs` 的兼容对象赋给 `globalThis.chrome`，随后直接加载扩展的 `lib/publish.js` 与 `lib/cdp.js`；默认 `direct` 模式通过外部 CDP 控制专用 Chrome。发布能力来自扩展，中控提供连接与编排。本次启动中控用于对照，没有替换本项目的任务系统，也没有开放本项目真实填写开关。

此前提到的 `node ~/maitian/hub.mjs` 路径及「设置 → Chrome 节点」菜单不适用于本次下载的源码。真实启动文件为 `src/hub.mjs`；平台界面入口为「系统 → 平台」。

## 本机文件与进程

- 官方源码：工作区 `.dsh-sandbox/upstream/maitian/`，提交 `d1eb1c83b26be6d6f72ebda84e5d9c60cd64a8b6`，主程序 package 版本 `0.4.0`。
- 独立运行目录：`.dsh-sandbox/maitian-check/`，配置、数据库、日志与 Chrome profile 均在这里；父目录已被本项目 `.gitignore` 忽略。
- 启动命令为 `hub web`，网页端口 `8787`，本轮启动 PID `13419`。没有启动 `daemon`、开机自启或隧道；不能根据网页顶栏「守护进程运行中」文字判断调度器已经运行。
- 专用 Chrome 端口 `9334`，本轮 PID `13961`，使用运行目录下的全新 profile；没有复用日常 Chrome 的账号资料，也未占用此前验收浏览器的 `9333` 端口。
- 访问地址含本机随机口令，保存在 `.dsh-sandbox/maitian-check/open-url.txt`，本轮已通过原生 Chrome 界面打开并观察到分发计划。
- 日志：`web.log`、`doctor.log`、`file-input-smoke.log`；报告：`origin.json`、`file-input-report.json`。以上路径均相对于独立运行目录。PID 仅为当时观察值，后续操作前须重新核实。

本次配置沿用官方支持的 `pluginDir` 回退机制，只读引用日常 Chrome 实装的 `eaaipbilkhibicihiollecmbpneikpnj/0.5.1_0`。`plugin` 为 `store`，但新 profile 未安装该扩展，因此实际 `pluginInfo().source` 为 `local`，原版体检显示「本地 0.5.1」。这里的「本地」表示读取来源，不是修改版。这个版本目录只用于本轮对照，不视为专用 profile 商店安装成功或自动更新验收；没有将正式默认发现路径改为日常资料。

## 本轮实际结果

1. 原版 `validate.mjs` 分别校验下载目录内「小红书-立即填写」「视频号-立即填写」工程，均通过。它们是此前生成的测试素材，不是用户成片。
2. 原版 `hub plan <工程目录>` 将两份工程登记到本次独立数据库，网页显示「分发计划」「还没开跑」。不带目录的 `hub plan` 只扫描未来预约，立即工程不会被自动登记。
3. 原版 `hub doctor --only xhs,channels --quiet` 正常加载已安装的发布助手并连接专用 Chrome；结果为两平台均「没有登录（跳到了登录页）」。CLI 退出码为 0 不代表所有平台预检成功，应读取逐平台结果。
4. 11:19:40，本地文件选择测试使用未修改的官方 `driver.ensure/withTab` 和实装扩展 `lib/cdp.js:setFiles`，在仅绑定 `127.0.0.1`、禁止表单提交和网络连接的临时页面选择 52 字节测试文件。实际 `DOM.setFileInputFiles` 成功，读取到正确文件名、数量和大小，没有出现 `Not allowed`。临时服务仅收到一次 GET，没有上传请求；测试页已关闭。
5. 扩展全部 30 个文件前后摘要一致，原版源码 `git status --short` 为空。本地文件测试脚本和运行配置均在原版目录之外，没有修改 Chrome 文件权限或关闭权限检查。

这证明本机外部 CDP 调用原版文件选择能力可行，并为侧栏与中控路径存在差异提供实测证据。没有验证真实平台的视频上传、封面、文案、预约、最终发布、结果查询或版本升级；不能因此将 `liveVerified` 改为 true。之前 694 项回归没有在本轮重新运行。

## 后续使用

网页已在 Chrome 中打开。进入「系统 → 平台」，使用「去登录」打开对应专用 Chrome 登录页，在这份新资料中完成登录后再体检。页面中的两份工程仍为计划状态；实际填写会上传媒体，最终发布由用户在平台完成。后续若执行测试，应先核对测试账号、素材及平台已有草稿，避免重传此前结果不明的任务。

重启网页服务时，在本项目根目录执行；现有实例仍在运行时不重复启动：

```bash
MAITIAN_CONFIG="$PWD/.dsh-sandbox/maitian-check/config.json" \
MAITIAN_DB="$PWD/.dsh-sandbox/maitian-check/hub.db" \
node .dsh-sandbox/upstream/maitian/src/hub.mjs web
```

只读平台预检：

```bash
MAITIAN_CONFIG="$PWD/.dsh-sandbox/maitian-check/config.json" \
MAITIAN_DB="$PWD/.dsh-sandbox/maitian-check/hub.db" \
node .dsh-sandbox/upstream/maitian/src/hub.mjs doctor --only xhs,channels --quiet
```

本地文件选择测试可重跑 `node .dsh-sandbox/maitian-check/file-input-smoke.mjs`，仅用于本地连接层诊断。它不会调用真实平台的 `publish.run`。
