# 麦田原版助手 `Not allowed` 诊断

日期：2026-11-23（Asia/Tokyo）。环境：Chrome 157.0.8103.79，Chrome 应用商店安装的麦田发布助手 0.5.1，扩展 ID `eaaipbilkhibicihiollecmbpneikpnj`。

## 已确认的故障

**当前商店版扩展没有获得本地文件访问授权，调用 `DOM.setFileInputFiles` 被 Chrome 拒绝。** 这项故障已在用户实际安装的原版扩展中复现，不再只是源码推断。网站访问开关已开启；扩展详情确实没有「允许访问文件网址」选项，不能要求用户开启一个未显示的控件。

当前集成目标仍为：本项目导出 `publish.json`、视频及封面 → 原版助手导入并填写 → 用户在平台最终发布。麦田监控中控和自定义 Node 执行器均不是这条流程的前置条件。

## 最小复现与实测结果

1. 在原版扩展 Service Worker 的 DevTools 读取扩展 ID、版本及 `chrome.extension.isAllowedFileSchemeAccess()`，返回 0.5.1、上述 ID、`false`。
2. 本机 `127.0.0.1:8765` 提供只有一个 `<input type="file">` 的空白页。该地址已在原包的 host 权限中；页面 CSP 禁止脚本、联网和表单提交。使用无敏感内容的 52 字节文本文件作为夹具。
3. 在同一已安装扩展的原版 `sidepanel.html` 页面 DevTools 中，导入其原装 `lib/cdp.js`，创建临时本地页，调用原版 `waitFor()`、`evaluate()`、`setFiles()`。本步骤在扩展页面中运行；不是声称重新触发了用户此前的后台平台任务。
4. 再通过原版 `send()` 分别执行获取 input objectId 的 `Runtime.evaluate` 和设置文件的 `DOM.setFileInputFiles`，记录准确失败命令。
5. 每次测试在 `finally` 中断开 debugger 并关闭临时测试标签；诊断面板已关闭，本地夹具服务器已停止，8765 端口确认无监听。

后台权限实测：

```json
{"id":"eaaipbilkhibicihiollecmbpneikpnj","version":"0.5.1","fileAccess":false}
```

原版 `setFiles()` 实测：

```json
{
  "test": "MAITIAN_ORIGINAL_EXTENSION_LOCAL_FILE",
  "context": "extension-page",
  "version": "0.5.1",
  "fileAccess": false,
  "phase": "setFiles",
  "tabCreated": true,
  "inputReady": true,
  "evaluateSucceeded": true,
  "fileSelectionSucceeded": false,
  "error": "{\"code\":-32000,\"message\":\"Not allowed\"}"
}
```

准确命令实测：

```json
{
  "test": "MAITIAN_EXACT_METHOD_DIAG",
  "fileAccess": false,
  "inputReady": true,
  "phase": "DOM.setFileInputFiles",
  "inputObjectResolved": true,
  "error": "{\"code\":-32000,\"message\":\"Not allowed\"}"
}
```

这次复现完全不读取 `publish.json`，不访问平台上传接口。它证明本地文件注入存在独立阻塞，与工程文案、视频封面或平台登录无关；不能据此保证解除这一阻塞后所有平台步骤都会成功。

最初曾尝试在 Service Worker 控制台动态 `import()`，被 Service Worker 自身限制拒绝，尚未创建测试标签。随后转到扩展页面导入成功。该诊断脚本限制与用户的 `Not allowed` 是两个不同错误。

## 源码如何解释实测

安装目录与官方商店分发原包 `lib/` 下的 18 个文件逐字节相同，未修改上游代码。详细版本、摘要和先前静态调查见[开发进度](maitian-development-progress.md#源码诊断商店版-051-与-chrome-文件访问)。

| 位置 | 行为 |
| --- | --- |
| 原版 `lib/platforms/xhs.js:32`、`channels.js:45` | 填写从 `setFiles()` 开始，成功后才记录视频开始上传 |
| 原版 `lib/cdp.js:78–81` | 先取得 input objectId，再发送 `DOM.setFileInputFiles` |
| Chromium `debugger_api.cc:847` | 扩展 debugger 客户端通过 `util::AllowFileAccess()` 决定能否读取本地文件 |
| Chromium `dom_handler.cc:42–48` | 本地文件访问为 false 时返回 `ServerError("Not allowed")` |
| Chromium `permissions_parser.cc:129–156` | `activeTab` 或包含 file scheme 的 host 声明可设置 `wants_file_access` |
| Chromium `extension_info_generator.cc:710–714`、`detail_view.html.ts:386` | 根据上述声明或已解压安装方式决定是否显示文件访问控件 |

以上 Chromium 源码固定到本机版本 [157.0.8103.79](https://chromium.googlesource.com/chromium/src/+/157.0.8103.79/)。关键拒绝点：[dom_handler.cc](https://chromium.googlesource.com/chromium/src/+/157.0.8103.79/content/browser/devtools/protocol/dom_handler.cc#42)；授权控件条件：[extension_info_generator.cc](https://chromium.googlesource.com/chromium/src/+/157.0.8103.79/chrome/browser/extensions/api/developer_private/extension_info_generator.cc#710)。

商店包既没有 `file://` host 声明，也没有 `activeTab` 或文件匹配的内容脚本。网站访问权限和本地文件访问权限分别受控。此前误查的 `allow_file_access` 已作废；正确偏好键为 `newAllowFileAccess`，本轮进一步用运行时 API 直接确认了 false。

## 修复方向与验收条件

保留原版代码和商店自动更新渠道的正式方向是：由上游补齐权限声明、提供用户文件授权指引，并在实际商店安装环境重新验证。可供上游评估的声明包括 `activeTab` 或合适的 file host 权限；具体选择应由上游确定并验证，不是本项目修改 manifest 后自行分发。

当前没有验证到能在这个原包、当前商店安装状态下通过正常 UI 完成本地文件授权的方法。重开网站总开关、重装相同包、修改导出文件、启动监控中控均不解决已定位的拒绝点。加载未修改的已解压官方包可能因安装方式而有不同权限，但本轮未测试，且不具备原商店安装的正常更新方式，不能充当既定目标的正式交付。

上游修复后的验收顺序：

1. 正常安装/更新商店版，确认用户能够找到并主动授予文件访问权限；运行时读取返回 true。
2. 在新建 debugger 连接上，重跑上述无网络上传的本地文件选择，确认原版 `setFiles()` 成功。
3. 再用已导出的测试工程验收小红书、视频号的媒体上传、文案与封面；最终发布仍由用户操作。
4. 验证下一次官方更新后无需修改上游代码或复制平台脚本，仍能导入和执行。

本轮未改扩展、Chrome 偏好、授权或安全启动参数，未重传真实平台素材、未最终发布。修复尚未完成，不将诊断完成写成发布能力可用。

## 后续：按用户要求直接调试 GitHub 源码

2026-11-23 用户明确要求直接使用 GitHub 源码调试，不再依赖商店安装包。本节记录这条新获授权的调试方式；前节要求上游修复的结论针对「保持商店安装并使用扩展原生权限」的路线，不表示源码无法独立执行。

已从官方仓库完整 clone 到 `.dsh-sandbox/upstream/maitian-publisher`，实际 HEAD 为 `171a30a3b8db7e4539e74f108f3d789a46172dab`。工作树保持干净。其 `lib/` 下 18 个文件与已核验官方商店原包逐字节一致；manifest 仅 `update_url` 不同，`permissions`、`host_permissions` 相同。因此没有发现商店打包丢失了仓库中原本存在的文件权限声明。

仓库自己提供两套源码调试工具：

- `tools/adapter-loader.mjs` 将适配器对 `lib/cdp.js` 的导入转到作者提供的 `tools/cdp-node.mjs`。
- 设置 `CDP_PORT` 后，`cdp-node.mjs` 可直连调试浏览器；`tools/direct-loader.mjs` 同时把工具层 `tools/cdp.mjs` 转到 `tools/cdp-direct.mjs`。本次组合使用两项官方 loader，没有修改上游文件。
- `tools/try-adapter.mjs` 是作者的真实平台填写调试入口；它会导航平台并上传素材。本次没有直接执行该脚本，以免重新上传平台素材，而是调用它同样使用的原版适配器 `fill()`，目标限定本地测试页。

可复跑入口：

```sh
node .dsh-sandbox/maitian-source-debug/run-local-adapters.mjs
```

该调试入口位于本项目忽略的 sandbox 中，启动全新无头 Chrome 资料和仅本机可访问的临时 HTTP 服务。两张测试页分别提供小红书所需的标题/正文控件和视频号所需的 `wujie-app` Shadow DOM；没有上传服务，CSP 禁止联网及表单提交。输入文件是无敏感内容的文本夹具，不能把原版日志中的「视频开始上传」当作平台实际上传成功。

| 源码调用 | 本地实际读回结果 |
| --- | --- |
| `lib/platforms/xhs.js` 的 `fill()` | file input 中出现 `local-selection.txt`；标题与两行正文完全匹配；无 `ctx.fail` |
| `lib/platforms/channels.js` 的 `fill()` | Shadow DOM 内 file input、短标题与两行正文完全匹配；无 `ctx.fail` |
| 原版 `tools/validate.mjs` | 已导出的小红书、视频号两份工程均校验通过 |
| 原版 `tests/md.test.mjs` | 使用 README 作为文章输入，内置断言全部通过 |

运行报告：`.dsh-sandbox/maitian-source-debug/result.json`。测试使用 Chrome 157.0.8103.79，两个平台核心 `fill()` 均通过；请求记录只有 `/xhs`、`/channels` 两个本机 GET。浏览器正常退出，临时服务器关闭。

这验证了「不安装扩展、不启动麦田主程序，直接用上游源码和其调试工具执行核心填写」可行。传输层使用作者 Node 调试实现，未执行原版扩展 `chrome.debugger` 的授权检查；这解释了为何源码直连通过而商店扩展仍报错。本次不是安装源码版扩展的对照，也没有验证真实平台 DOM、视频处理、封面、话题、预约及最终发布。

后续更新边界：本次 clone 的 README 明确说明公开源码停留在 0.5.1，之后新版本源码进入会员仓库。因此「用公开 GitHub 源码直接运行」与「持续获得未来商店版本能力」不能自动视为同一件事；源码调试不改变此前对持续更新交付条件的要求。

## 源码开发版已安装

2026-11-23 用户明确要求安装。已通过 Chrome 原生「加载未打包的扩展程序」安装到当前 Luming / Default 资料，界面显示麦田发布助手 0.5.1、未打包来源、启用状态，扩展 ID 为 `omlpeokfcpccmdgamiklnkbnfdmhgibe`。

实际加载目录为 `/Users/eric/Developer/Project/mediadesktop/maitian-publisher`，系再次从官方 GitHub clone 的同一提交，工作树保持干净。Chrome 目录选择器最初确认按钮未启用，改用这个可见的固定目录后完成加载；没有证据证明该现象由隐藏路径本身导致。此目录是开发版运行依赖，须保留。

安装后只读核对 Chrome 保存状态：该扩展 `location: 4`，`newAllowFileAccess: true`，路径与上述源码目录一致。未手工改写 Chrome 偏好或切换权限。这与先前商店版未授权状态不同，但安装后尚未重跑扩展原生文件选择或真实平台填写，不能标记完整修复验收。源码版使用独立扩展 ID，需要重新在其面板选择工程父目录并填写本机路径；本轮未上传或发布。
