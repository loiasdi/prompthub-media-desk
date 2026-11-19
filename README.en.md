# PromptHub MediaDesk

**A workspace for content creators: ideas, manuscripts, prompts and media in one place.**

[GitHub](https://github.com/loiasdi/prompthub-media-desk) · [Issues](https://github.com/loiasdi/prompthub-media-desk/issues) · [简体中文](README.md)

Adapted from [dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk), originally created by 蜗牛的科技笔记 (Snail’s Tech Notes). Original copyright and MIT license notices remain in [LICENSE](LICENSE).

## Workflow

**Collect ideas → Discuss an outline → Write and revise → Video prompts → Images and covers → Publish.**

Each stage has its own page. Ideas, outlines and manuscripts are saved separately. With a text model configured in DeepSeek Harness, discuss topics, develop outlines and revise manuscripts with AI.

- Capture notes, quotes, links, short-video share text, images and videos. Multiple selected files belong to one idea.
- Save manuscript titles, descriptions and topics for use in covers and publishing copy.
- Edit and store global video parameters and segment prompts per manuscript.
- Manage cover prompts, aspect-ratio variants, reference images and manuscript illustrations together.
- Keep assets in the folder of the manuscript they belong to.
- Review the copy, local assets, and account in the Publish tab, then explicitly confirm the submission. Supported formats include video on integrated platforms, Bluesky text and image posts, Kuaishou video with a local JPEG cover, Facebook video and single-photo Stories, Facebook/Pinterest/LinkedIn/X image posts, Facebook/Threads/LinkedIn/X text posts, and single WeChat Official Account articles with optional local body images. Kuaishou's official media upload gateway uses unencrypted HTTP and is disabled unless explicitly enabled; Facebook photo Stories do not support AI declarations. WeChat requires publication permissions, and TikTok has app-audit and intended-use restrictions. [Supported platforms, scope, and Host setup](docs/local-publishing-entry.md)
- Preview and sync content to Feishu documents, reusing unchanged files.
- Manage schedules, performance reviews and writing styles, with Chinese and English interfaces.

Text generation uses your configured DSH model. Images use an OpenAI-compatible image API or a supported image-generation tool registered with DSH. Service charges depend on your provider; no API keys are included. The PromptHub name does not imply automatic account or generation-service integration.

## Settings and storage

Settings has **General** and **API settings** tabs. General contains language, document storage, trash retention, export location and generation counts. API settings contains image sources, endpoints, models, keys, advanced options and test generation.

The default data folder remains `~/.dsh/media-desk/` for compatibility. Choose a new empty folder in General settings, including a folder within an Obsidian vault. Existing manuscripts, assets, settings and trash are copied and verified before switching; the original folder remains as a backup.

Each manuscript has its own folder under `内容/<id>/`, with Markdown documents and a `素材/` asset folder. Markdown output follows the storage configuration. External edits are preserved; conflicts are written as separate update files.

Deleting a manuscript moves its folder and assets to local trash. Retention is **1, 3, 7 or 15 days**, defaulting to **7 days**, followed by permanent deletion. The app checks hourly while running and at the next startup.

The `/media-desk` route and existing storage/configuration identifiers remain compatible. Renaming the project does not automatically move existing data.

## Local installation

Package name: **`prompthub-media-desk`**. Product name: **PromptHub MediaDesk**. These instructions use a local build and do not assume an npm release.

Requires Node.js 20+. Plugin use requires DeepSeek Harness `0.2.1-rc.5` or newer within `0.2.x`.

```bash
git clone https://github.com/loiasdi/prompthub-media-desk.git
cd prompthub-media-desk
npm install
npm test
npm run build
npm run preview
```

The preview runs at `http://127.0.0.1:4311` by default. It does not connect to a DSH text model; use the plugin in a configured DSH instance for AI discussions.

From the project directory:

```bash
dsh plugin --profile desktop add "file:$PWD"
# Or install for the web profile:
dsh plugin --profile web add "file:$PWD"
```

Remove the original `dsh-media-desk` plugin from the same profile first if installed, to avoid duplicate routes and panels. Removing the plugin does not delete your local content. Quit the desktop app before installation and reopen afterward; restart `dsh web` for the web profile.

`npm pack` creates a `prompthub-media-desk-*.tgz` archive for offline installation. Restart the DSH service after changing host code.

See [local preview and Obsidian storage](docs/content-workspace-preview.md) and [Feishu sync](docs/feishu-sync.md) for details (Chinese).

## Attribution

This adaptation changes the original content workflow and adds manuscript-centered editing, video-prompt storage, image and cover management, Obsidian storage, asset archiving, Feishu synchronization and trash management.

The original author does not maintain or endorse this adaptation. See the [Chinese README](README.md#原项目贡献者) for upstream contributor acknowledgments. Thank you to the original author, contributors and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for the foundation.

## License

[MIT](LICENSE). Original copyright and license notices are preserved. PromptHub MediaDesk is a community project and is not affiliated with DeepSeek.
