import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Synthetic contract fixtures; no upstream platform implementation is bundled or modified.
export async function component(root, version = '1.0.0', { limit = 20, fill = true, sideEffect = false, validation = null } = {}) {
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ name: 'Contract fixture', version }))
  await writeFile(join(root, 'lib/init.js'), 'chrome.debugger.onDetach.addListener(() => {}); export const value = 1;')
  await writeFile(join(root, 'lib/bundle.js'), `export const PLATFORMS = {xhs: {name:'小红书',fields:{title:[1,${limit}],body:[1,1000]}}};
    export function validate(data, files) { ${validation || `if (data.version !== 1 || !(files instanceof Set) || !files.has(data.video)) throw Error('invalid envelope'); return {errors: data.platforms.xhs.title.length > ${limit} ? ['上游标题规则'] : [], warnings: ['上游原始提示']}`} }
  `)
  await writeFile(join(root, 'lib/publish.js'), `import './init.js';
    ${sideEffect ? 'chrome.tabs.create({url:"https://example.invalid"});' : ''}
    export const ADAPTERS = {xhs: {url: 'https://example.invalid/upload', links: {}}};
    export async function preflight() { return {} }
    ${fill ? 'export async function run(project) { if (!project.data || typeof project.dir !== "string") throw Error("invalid project"); return {} }' : ''}
    export async function collectLinks() { return {} }
  `)
  return root
}
