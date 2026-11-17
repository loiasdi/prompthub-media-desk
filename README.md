# PromptHub MediaDesk

**PromptHub 自媒体工作台：把灵感、稿件、提示词和素材放在同一个创作空间。**

[GitHub](https://github.com/loiasdi/prompthub-media-desk) · [反馈问题](https://github.com/loiasdi/prompthub-media-desk/issues) · [English](README.en.md) · [安装与开发](#安装与开发) · [存储与设置](#存储与设置) · [改编说明](#项目来源与改编说明)

本项目基于「蜗牛的科技笔记」开发的开源项目 [dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) 改编，在原项目基础上围绕自媒体日常创作调整与扩展。原项目采用 MIT 许可证，原作者及贡献者的版权声明保留在 [LICENSE](LICENSE) 中。

## 创作流程

**收集灵感 → 讨论大纲 → 写稿与改稿 → 视频提示词 → 配图与封面 → 发布。**

以稿件为核心，每个阶段有独立页面。灵感、大纲和正文分别保存，阶段切换不会直接代替创作内容。配置文字模型后，可以和 AI 讨论选题、整理大纲、修改稿件。

- **灵感收集**：文字、金句、网页链接、短视频分享文案、图片和视频；一次多选的素材保存在同一条灵感里。
- **稿件编辑**：独立的大纲与正文，保存标题、描述和话题，作为后续封面与发布文案的来源。
- **视频提示词**：保存全局视频参数与分段提示词，支持复制、编辑和按稿件管理。
- **配图与封面**：统一管理参考素材、封面提示词、多个比例版本和正文配图；封面文字默认使用稿件标题。
- **素材归档**：每篇稿件独立保存图片、视频及相关文件，支持素材预览、用途标记和发布选材。
- **飞书同步**：配置飞书应用后，预览同步差异，将稿件与图片同步到对应文档，复用未变化的文件。
- **内容管理**：保留灵感墙、排期、复盘与风格管理，并支持中文与英文界面。

文字讨论使用 DeepSeek Harness 中配置的模型。生图可以连接兼容 OpenAI 图片接口的服务，或使用 DSH 已注册、且受工作台支持的订阅生图工具。模型和生图服务的费用由所用服务决定；本项目不附带密钥。PromptHub 的品牌命名不代表已经自动接入 PromptHub 账号或生成服务。

## 存储与设置

「设置」分为两个 Tab：

| 页面 | 内容 |
| --- | --- |
| 普通设置 | 语言、文档存储目录、回收站自动清理时间、成稿导出目录与生成数量 |
| API 设置 | 生图来源、接口地址、模型、密钥、高级参数与试画 |

默认数据目录为 `~/.dsh/media-desk/`。可以在「普通设置 → 文档存储目录」中指定独立文件夹，也可放在 Obsidian Vault 内。更换目录时，工作台复制并校验已有稿件、素材、设置和回收站，再切换保存位置；旧目录保留为备份。

```text
文档目录/
├── state.json
├── 内容/
│   └── 稿件ID/
│       ├── 灵感.md
│       ├── 大纲.md
│       ├── 稿件.md
│       ├── 视频提示词.md
│       ├── 封面设计.md
│       ├── 配图设计.md
│       ├── 素材.md
│       └── 素材/
└── 回收站/
    └── 内容/
```

Markdown 输出随存储配置启用；Obsidian 中手动修改的文件不会被静默覆盖，冲突时另存工作台更新版本。

删除稿件时，文档和素材一同进入本地回收站。保留时间可选 **1、3、7、15 天**，默认 **7 天**，到期后永久清理。工作台运行时每小时检查，关闭期间到期的内容会在下次启动时清理。

改名后保留原有 `/media-desk` 接口、数据目录与配置文件标识，以继续读取已有内容。已有存储目录不会因品牌改名而自动搬迁。

## 安装与开发

项目包名为 **`prompthub-media-desk`**，显示名称为 **PromptHub MediaDesk**。当前说明使用本地构建与安装，不要求该包已发布到 npm。

需要 Node.js 20+。作为插件运行时，需要 DeepSeek Harness `0.2.1-rc.5` 及以上的 `0.2.x`。

获取源码并进入项目目录：

```bash
git clone https://github.com/loiasdi/prompthub-media-desk.git
cd prompthub-media-desk
```

然后执行：

```bash
npm install
npm test
npm run build
npm run preview
```

本地预览地址默认是 `http://127.0.0.1:4311`。独立预览不连接 DSH 文字模型；完整 AI 功能需在配置了模型的 DSH 中使用。

安装本地插件：

```bash
dsh plugin --profile desktop add "file:$PWD"
# 或安装到网页版
dsh plugin --profile web add "file:$PWD"
```

如果同一 DSH 配置已装原版 `dsh-media-desk`，先移除原版，避免两个插件同时注册相同页面和接口；移除插件不会删除本地稿件数据。桌面版安装前完全退出，安装后重新打开；网页版重启 `dsh web`。

也可运行 `npm pack` 生成 `prompthub-media-desk-*.tgz` 安装包，用 `file:` 路径安装。修改 `src/` 后需重启对应的 DSH 服务。

更多说明：[本地预览与 Obsidian](docs/content-workspace-preview.md) · [飞书同步](docs/feishu-sync.md)。这些文档中的旧路径和标识用于兼容已有数据。

## 项目来源与改编说明

PromptHub MediaDesk 基于 [dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) 改编，原作者为「蜗牛的科技笔记」。本版本的流程调整、存储管理、素材归档与飞书同步等新增功能由改编版本维护，行为可能与原项目不同。

本文中的原项目链接用于说明来源及历史贡献，不代表该版本由原作者维护或背书。感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供插件运行环境。

### 原项目贡献者

以下贡献记录来自原项目，感谢原作者及这些贡献者：

- [secountAiAccount](https://github.com/secountAiAccount)：发现深色模式下风格下拉框看不清（[#1](https://github.com/woniuniuniu/dsh-media-desk/issues/1)），设置图标容易被当成切换深浅色（[#2](https://github.com/woniuniuniu/dsh-media-desk/issues/2)）
- [isxiaokunos](https://github.com/isxiaokunos)：定位到生图网关返回相对地址时必定失败、误报和白白重画的根因，还附上了补丁和实测数据（[#3](https://github.com/woniuniuniu/dsh-media-desk/issues/3)）
- [townmi（Harry Tang）](https://github.com/townmi)：查清 opencode-go 网关缺少会话头导致模型调用失败，并指出面板误报「模型未连接」（[#4](https://github.com/woniuniuniu/dsh-media-desk/issues/4)）
- [zach22-1999](https://github.com/zach22-1999)：修好了 X 帖子媒体字段格式不一时导入崩溃的问题（[#6](https://github.com/woniuniuniu/dsh-media-desk/pull/6)）
- [chenxupeng1990-eng](https://github.com/chenxupeng1990-eng)：让助手可以在工作台里自选模型，不必跟随 DSH 默认模型（[#5](https://github.com/woniuniuniu/dsh-media-desk/pull/5)）
- [dsh-agent-sixtyseven](https://github.com/dsh-agent-sixtyseven)：查清 Windows 上导入账号一直显示「还没装好 Monid」的两处根因，并修好了定位和调用（[#7](https://github.com/woniuniuniu/dsh-media-desk/issues/7)、[#8](https://github.com/woniuniuniu/dsh-media-desk/pull/8)）
- [smallflycar](https://github.com/smallflycar)：让工作台可以直接用 GPT 订阅生图，不用再另配图片 API（[#9](https://github.com/woniuniuniu/dsh-media-desk/pull/9)）

以上 Issue、PR 与贡献者链接均指向原项目。

### 贡献者

谢谢每一位提交过代码的朋友：

[![贡献者](https://contrib.rocks/image?repo=woniuniuniu/dsh-media-desk)](https://github.com/woniuniuniu/dsh-media-desk/graphs/contributors)

## 许可证

[MIT](LICENSE)。保留原作者及贡献者的版权与许可声明。PromptHub MediaDesk 是社区项目，与 DeepSeek 官方无关。
