// Default video limit for API publishing, not for local imports.
export const MAX_ASSET_BYTES = 250_000_000
export const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' }

export const validAssetPath = value => typeof value === 'string' && /^(?:[\w-]+\/)?[\w-][\w.-]*$/.test(value) && !value.split('/').some(p => p === '.' || p === '..')

export function assetFileName(src) {
  const name = typeof src === 'string' && /^\/?media-desk\/files\/(.+)$/.exec(src)?.[1]
  return validAssetPath(name) ? name : ''
}
