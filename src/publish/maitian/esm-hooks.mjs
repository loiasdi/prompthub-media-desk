import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, resolve, sep } from 'node:path'

let root, allowed
export function initialize(data) {
  root = resolve(data.root)
  allowed = new Set(data.files)
}

function owned(url) {
  if (!url?.startsWith('file:')) return false
  const path = relative(root, fileURLToPath(url))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

export async function resolveHook(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (owned(context.parentURL) && !owned(result.url)) throw new Error('Component dependency outside installation directory')
  return result
}
export { resolveHook as resolve }

// Select ESM format for original .js bytes without source transformation or a package.json write.
export async function load(url, context, nextLoad) {
  if (!owned(url)) return nextLoad(url, context)
  const file = fileURLToPath(url)
  const path = relative(root, file).split(sep).join('/')
  if (!allowed.has(path) || await realpath(file) !== file || !path.endsWith('.js')) throw new Error('Unsupported component module')
  return { format: 'module', source: await readFile(file), shortCircuit: true }
}
