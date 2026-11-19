import { constants } from 'node:fs'
import { open, realpath, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { PublishError } from './errors.js'

const invalid = () => new PublishError('INVALID_LOCAL_MEDIA', '本地发布素材不可读取或不在暂存目录内')

// For verified snapshots under a Host-private directory, NOT caller-supplied workspace paths.
// The descriptor is opened once; replacing its path cannot change the bytes of later parts.
export async function withLocalUploadSource(root, snapshotPath, { filename, mime, width, height, duration, frameRate }, use) {
  if (typeof snapshotPath !== 'string' || typeof filename !== 'string' || !filename || /[\\/\x00-\x1f\x7f]/.test(filename)) throw invalid()
  let file, sizeBytes
  try {
    const base = await realpath(root)
    const relativePath = relative(resolve(root), resolve(snapshotPath))
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw invalid()
    // Reject symlinks even when they point back inside the private directory.
    let path = base
    for (const part of relativePath.split(sep)) {
      path = join(path, part)
      if ((await lstat(path)).isSymbolicLink()) throw invalid()
    }
    if (await realpath(path) !== path) throw invalid()
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    const info = await file.stat()
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1) throw invalid()
    sizeBytes = info.size
  } catch {
    await file?.close()
    throw invalid()
  }
  try {
    return await use(Object.freeze({
      filename, mime, sizeBytes, width, height, duration, frameRate,
      stream({ start = 0, end = sizeBytes - 1 } = {}) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= sizeBytes) throw invalid()
        // Each part has its own cursor. Destroying a part must not close the shared descriptor.
        return Readable.from((async function* () {
          for (let offset = start; offset <= end;) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - offset + 1))
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
            if (!bytesRead) throw invalid()
            offset += bytesRead
            yield buffer.subarray(0, bytesRead)
          }
        })(), { objectMode: false })
      },
    }))
  } finally {
    await file.close()
  }
}
