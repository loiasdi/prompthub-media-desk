// 界面预览。配置共享目录后使用该目录；不调用模型、不创建真实发布任务。
import { context } from 'esbuild'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { storageLocation } from '../src/storage-location.js'
import { route } from '../src/host.js'
import { withLang } from '../src/i18n.js'
import { applyOps } from '../src/ops.js'
import { computeInsights } from '../src/learn.js'
import { Settings } from '../src/settings.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = Number(process.env.PORT || process.argv[2] || 4311)
const bundler = await context({ entryPoints: [resolve(root, 'client/preview.jsx')], bundle: true, write: false, format: 'esm', loader: { '.css': 'text' }, jsx: 'transform', sourcemap: 'inline', logLevel: 'warning' })
const location = storageLocation()
const previewRoot = process.env.MEDIA_DESK_PREVIEW_DIR || (location.configured ? location.root : resolve(tmpdir(), 'dsh-media-desk-preview'))
const store = new Store(previewRoot)
let state = await store.read()
const desk = { settings: new Settings(store) }
const previewContext = { get: () => null }
const trashTimer = setInterval(() => store.read().catch(err => console.error('回收站清理失败：', err.message)), 3600000)
trashTimer.unref()
const item = state.items[0]
if (!state.sampleCleared && item?.sample && !item.production) item.production = {
  status: 'done', title: item.title, article: `${item.body}\n\n## 从一个细节开始\n\n记录一个具体的场景，让观众先看到，再理解。\n\n## 让变化被看见\n\n用一个前后对比，把想说的事情讲清楚。\n\n## 留下一个行动\n\n这是一份本地页面预览稿，可以查看稿件、提示词、素材和发布设置。`,
  coverText: '把想法拍出来', cover: { src: 'media-desk/assets/ink.jpg', status: 'done' },
  images: [{ src: 'media-desk/assets/hills.jpg', caption: '远处的风景', status: 'done', anchor: '从一个细节开始' }],
  shots: [
    { src: 'media-desk/assets/stairs.jpg', visual: '从一个细节开始', prompt: 'A slow push-in on a concrete staircase in natural afternoon light. A person enters the frame and pauses. Keep the motion quiet and deliberate.', voice: '先停下来，看见一个细节。', seconds: 10, shot: '近景', status: 'done' },
    { src: 'media-desk/assets/ink.jpg', visual: '让变化被看见', prompt: 'Medium shot of a person comparing two sketches at a desk. The camera moves gently from the first sketch to the second. Soft window light.', voice: '把变化放在同一个画面里。', seconds: 10, shot: '中景', status: 'done' },
    { src: 'media-desk/assets/hills.jpg', visual: '留下一个停顿', prompt: 'Wide static shot of rolling hills in late afternoon. A figure walks along the ridge. Wind and unhurried movement carry the ending. No on-screen text.', voice: '给画面留一点呼吸。', seconds: 10, shot: '全景', status: 'done' },
  ],
}

await store.mutate('', draft => { if (item) draft.items[0] = item }, { undoable: false })

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PromptHub MediaDesk · 页面预览</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}html,body,#root{height:100%;width:100%;overflow:hidden}
body{--dsw-alias-label-primary:#25272b;--dsw-alias-label-secondary:#61656c;--dsw-alias-label-tertiary:#777c84;--dsw-alias-label-caption:#8d9299;--dsw-alias-label-primary-inverted:#fff;--dsw-alias-button-primary-fill:#282b31;--dsw-alias-button-primary-hover:#41454b;--dsw-alias-border-l2:#e6e7ea;--dsw-alias-border-l4:#d3d6db;--dsw-alias-interactive-bg-hover:#f1f2f4;--dsw-alias-interactive-bg-active:#e9ebef;--dsw-alias-bg-base:#f7f8fa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-link:#3e62a8;--dsw-elevation-soft:0 1px 4px #20253008;--dsw-elevation-panel:0 12px 40px #20253018;--dsw-elevation-prominent:0 4px 20px #20253010;--dsw-radius-xs:4px;--dsw-radius-sm:6px;--dsw-radius-md:10px;--dsw-radius-lg:12px;--dsw-radius-xl:16px;--dsw-radius-2xl:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
body[data-ds-dark-theme]{--dsw-alias-label-primary:#e8e9ec;--dsw-alias-label-secondary:#b1b4bb;--dsw-alias-label-tertiary:#969ca7;--dsw-alias-label-caption:#868d98;--dsw-alias-label-primary-inverted:#191b1f;--dsw-alias-button-primary-fill:#e8e9ec;--dsw-alias-button-primary-hover:#fff;--dsw-alias-border-l2:#2e3137;--dsw-alias-border-l4:#414650;--dsw-alias-interactive-bg-hover:#2a2d34;--dsw-alias-interactive-bg-active:#343841;--dsw-alias-bg-base:#1a1c21;--dsw-alias-bg-layer-2:#23262c;--dsw-alias-link:#a8bde7;--dsw-elevation-soft:0 1px 3px #0001;--dsw-elevation-panel:0 12px 40px #0004;--dsw-elevation-prominent:0 4px 20px #0003}
</style></head><body><div id="root"></div><script type="module" src="/preview.js?v=__PREVIEW_VERSION__"></script></body></html>`
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
const mime = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4' }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html.replace('__PREVIEW_VERSION__', String(Date.now()))); return }
    if (url.pathname === '/preview.js') { const result = await bundler.rebuild(); res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(result.outputFiles[0].contents); return }
    if (url.pathname.startsWith('/media-desk/assets/')) {
      const base = resolve(root, 'assets')
      const file = resolve(base, decodeURIComponent(url.pathname.slice('/media-desk/assets/'.length)))
      if (!file.startsWith(base + sep) || !mime[extname(file)]) return json(res, 404, {})
      const info = await stat(file)
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      let start = 0; let end = info.size - 1
      if (range) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end }
      if (start > end || start >= info.size) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); res.end(); return }
      res.writeHead(range ? 206 : 200, { 'content-type': mime[extname(file)], 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}) })
      if (req.method === 'HEAD') res.end(); else createReadStream(file, { start, end }).pipe(res)
      return
    }
    const endpoint = url.pathname.replace(/^\/media-desk\//, '')
    if (['settings', 'capture-url', 'upload'].includes(endpoint) || endpoint.startsWith('feishu/') || endpoint === 'workspace' || endpoint.startsWith('workspace/') || endpoint.startsWith('content-assets/') || endpoint.startsWith('files/')) return await withLang(req.headers['x-media-desk-lang'], () => route(previewContext, store, desk, req, res))
    state = await store.read()
    if (req.method === 'GET') {
      if (endpoint === 'state') return json(res, 200, { state, model: null, canUndo: store.undo.length > 0 })
      if (endpoint === 'insights') return json(res, 200, computeInsights(state))
      if (endpoint === 'models') return json(res, 200, { providers: [], current: null, default: null })
    }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (endpoint === 'ops') { const result = await store.mutate('预览操作', draft => withLang(req.headers['x-media-desk-lang'], () => applyOps(draft, body.ops))); return json(res, 200, { ...result, state: await store.read() }) }
      if (endpoint === 'undo') { const label = await store.undoLast(); return json(res, 200, { state: await store.read(), canUndo: store.undo.length > 0, label }) }
    }
    json(res, 400, { error: '独立页面预览不连接模型或外部服务，请在 DSH 中使用完整功能' })
  } catch (err) { if (!res.headersSent) json(res, err.status || 500, { error: err.message }); else res.end() }
})
server.listen(port, '127.0.0.1', () => console.log(`预览数据：${previewRoot}\n页面预览：http://127.0.0.1:${port}/?tab=assets\n提示词：/?tab=prompts\n发布：/?tab=publish\n深色：添加 &theme=dark；英文：添加 &lang=en`))
async function stop() { server.close(); await bundler.dispose(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
