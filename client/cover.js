// 合成视频封面：有画面就叠大字，没有画面就用渐变做一张纯文字封面。
import { t } from './i18n.js'
import { coverAssetRatio, coverChoices, selectedCoverIds } from '../src/cover-assets.js'
import { ROLE_NAMES } from '../src/workspace-schema.js'

export function coverSelectOptions(assets, ratio) {
  return coverChoices(assets, ratio).map(asset => {
    const width = Number(asset.width || asset.w), height = Number(asset.height || asset.h)
    const gcd = (a, b) => b ? gcd(b, a % b) : a
    const divisor = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? gcd(width, height) : 0
    const label = coverAssetRatio(asset) || (divisor ? `${width / divisor}:${height / divisor}` : t('比例未知'))
    return { value: asset.id, label: asset.name, thumbnail: asset.src, badges: [t(ROLE_NAMES[asset.role] || '制作素材'), label] }
  })
}

export function coverAssetLabel(asset) {
  return [asset.role === 'cover' ? t('封面') : '', coverAssetRatio(asset), asset.name].filter(Boolean).join(' · ')
}

export function selectPublishCover(draft, asset) {
  if (!asset) return selectPublishCovers(draft, [])
  const ids = [asset.id, ...selectedCoverIds(draft).filter(id => id !== asset.id)]
  const covers = { ...draft.publish?.browser?.covers }
  const ratio = coverAssetRatio(asset)
  if (ratio) covers[ratio.replace(':', 'x')] = asset.id
  return {
    selectedCover: asset.id, selectedCoverIds: ids,
    ...(ratio ? { publish: { ...draft.publish, browser: { ...draft.publish?.browser, covers } } } : {}),
  }
}

export function selectPublishCovers(draft, assets) {
  const ids = [...new Set(assets.map(asset => asset.id))]
  const removed = selectedCoverIds(draft).filter(id => !ids.includes(id))
  const covers = Object.fromEntries(Object.entries(draft.publish?.browser?.covers || {}).filter(([, id]) => !removed.includes(id)))
  for (const asset of assets) {
    const ratio = coverAssetRatio(asset)
    if (ratio) covers[ratio.replace(':', 'x')] = asset.id
  }
  return { selectedCover: ids[0] || '', selectedCoverIds: ids, publish: { ...draft.publish, browser: { ...draft.publish?.browser, covers } } }
}

const WIDTH = 1920
const HEIGHT = 1080

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(t('封面图读取失败')))
    image.src = src
  })
}

// 中文按字断行，英文按词断行，单词本身太长时再按字母拆开
function wrap(ctx, text, maxWidth, maxLines) {
  const lines = []
  let line = ''
  const tokens = text.match(/[\u0021-\u024f]+\s*|\s+|[^\s]/gu) ?? []
  for (const token of tokens) {
    if (ctx.measureText((line + token).trimEnd()).width <= maxWidth || !line.trim()) {
      line += token
      continue
    }
    lines.push(line.trimEnd())
    line = token.trimStart()
  }
  if (line.trim()) lines.push(line.trimEnd())
  const out = []
  for (const row of lines) {
    if (ctx.measureText(row).width <= maxWidth) {
      out.push(row)
      continue
    }
    let part = ''
    for (const ch of row) {
      if (ctx.measureText(part + ch).width > maxWidth && part) {
        out.push(part)
        part = ch
      } else {
        part += ch
      }
    }
    if (part) out.push(part)
  }
  return out.slice(0, maxLines)
}

function drawBackground(ctx) {
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
  base.addColorStop(0, '#1a1b3a')
  base.addColorStop(0.55, '#4a2f6b')
  base.addColorStop(1, '#d9745a')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  const glow = ctx.createRadialGradient(WIDTH * 0.8, HEIGHT * 0.15, 0, WIDTH * 0.8, HEIGHT * 0.15, WIDTH * 0.6)
  glow.addColorStop(0, 'rgba(255, 196, 150, .55)')
  glow.addColorStop(1, 'rgba(255, 196, 150, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
}

/**
 * @param {{src?: string, text: string}} options - 封面图地址和封面大字。
 * @returns {Promise<HTMLCanvasElement>} 1920×1080 的封面。
 */
export async function composeCover({ src, text }) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  drawBackground(ctx)
  if (src) {
    const image = await loadImage(src)
    const scale = Math.max(WIDTH / image.width, HEIGHT / image.height)
    ctx.drawImage(image, (WIDTH - image.width * scale) / 2, (HEIGHT - image.height * scale) / 2, image.width * scale, image.height * scale)
    const shade = ctx.createLinearGradient(0, HEIGHT * 0.35, 0, HEIGHT)
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)')
    shade.addColorStop(1, 'rgba(0, 0, 0, .72)')
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
  }
  // 西文字母大约半个汉字宽
  const units = [...text].reduce((n, ch) => n + (/[\u0000-\u024f]/.test(ch) ? 0.55 : 1), 0)
  const size = units > 12 ? 112 : 148
  ctx.font = `700 ${size}px "Songti SC", "STSong", "Noto Serif SC", serif`
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(0, 0, 0, .35)'
  ctx.shadowBlur = 24
  const lines = wrap(ctx, text, WIDTH - 200, 3)
  const lineHeight = size * 1.24
  lines.forEach((line, index) => {
    ctx.fillText(line, 100, HEIGHT - 100 - (lines.length - 1 - index) * lineHeight)
  })
  return canvas
}

export async function coverDataUrl(options) {
  const canvas = await composeCover(options)
  return canvas.toDataURL('image/jpeg', 0.9)
}

export async function downloadCover(options, name) {
  const url = await coverDataUrl(options)
  const link = document.createElement('a')
  link.href = url
  link.download = `${String(name).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40) || t('视频封面')}.jpg`
  link.click()
}

// Open on a real result, not an empty default aspect ratio.
export function preferredCoverRatio(design, ratios, selectedCover) {
  return (selectedCover && ratios.find(ratio => design.variants[ratio].imageIds.includes(selectedCover)))
    || ratios.find(ratio => design.variants[ratio].imageIds.length)
    || ratios.find(ratio => design.variants[ratio].prompt.trim())
    || ratios.find(ratio => design.ratios.includes(ratio))
    || ratios[0]
}
