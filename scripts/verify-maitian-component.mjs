// Development-only, offline check against an original directory or a configured store installation.
// Never installs, patches, uploads, logs in, runs publish.run, or enables the live filling gate.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.js'
import { ContentAssets } from '../src/content-assets.js'
import { MaitianConfig } from '../src/publish/maitian/config.js'
import { MaitianPublishing } from '../src/publish/maitian/service.js'
import { discoverEngine, inspectEngine, loadEngine } from '../src/publish/maitian/engine-loader.mjs'
import { probeChrome } from '../src/publish/maitian/contract.js'
import { runComponent } from '../src/publish/maitian/runner-client.js'
import { MAITIAN_PLATFORMS, COVER_RATIOS } from '../src/publish/maitian/platforms.js'

const exec = promisify(execFile)
const script = fileURLToPath(import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function tree(root, prefix = '', result = Object.create(null), budget = { bytes: 0 }) {
  const entries = (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const entry of entries) {
    const relative = join(prefix, entry.name)
    if (entry.isDirectory()) await tree(root, relative, result, budget)
    else {
      assert(entry.isFile(), 'Component tree must contain regular files and directories')
      assert(Object.keys(result).length < 2000, 'Unexpected component file count')
      const info = await lstat(join(root, relative))
      budget.bytes += info.size
      assert(budget.bytes <= 64_000_000, 'Unexpected component size')
      result[relative] = sha256(await readFile(join(root, relative)))
    }
  }
  return result
}

// Only the File System Access methods consumed by original scanProjects/check are supplied.
function directoryHandle(path) {
  return {
    kind: 'directory', name: basename(path),
    async *entries() {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        assert(entry.isDirectory() || entry.isFile(), 'Export must not contain links')
        yield [entry.name, entry.isDirectory() ? directoryHandle(child) : {
          kind: 'file', name: entry.name,
          async getFile() { return { lastModified: (await lstat(child)).mtimeMs, text: () => readFile(child, 'utf8') } },
        }]
      }
    },
  }
}

async function scan(component, folder) {
  const { publish } = await loadEngine(await inspectEngine(component), probeChrome())
  assert.equal(typeof publish.scanProjects, 'function', 'Original project scanner is unavailable')
  assert.equal(typeof publish.check, 'function', 'Original project checker is unavailable')
  const projects = await publish.scanProjects(directoryHandle(folder))
  const result = []
  for (const project of projects) {
    assert(!project.error && !project.draft, 'Original scanner could not read the exported project')
    const validation = await publish.check(project)
    assert.equal(validation.errors.length, 0, JSON.stringify(validation))
    result.push({ dir: project.dir, data: project.data, validation })
  }
  return { runtimeVersion: process.version, projects: result }
}

async function verify(component, destination, installedConfigDir) {
  const installedConfig = installedConfigDir ? new MaitianConfig(await realpath(installedConfigDir)) : null
  const installedConfigBytes = installedConfig ? await readFile(installedConfig.file) : null
  if (installedConfig) assert.equal(installedConfig.read().source, 'store', 'Installed verification requires source: store')
  // Discover before creating an output directory; never fall back to a research copy.
  const installedOptions = installedConfig?.resolve()
  const installedEngine = installedConfig ? await discoverEngine(installedOptions) : null
  const original = await realpath(installedEngine?.dir || component)
  const before = await tree(original)
  // Resolve existing parent links before writing, so an alias cannot place reports in the original.
  const target = destination && resolve(destination)
  const root = target ? join(await realpath(dirname(target)), basename(target)) : join(await realpath(tmpdir()), `maitian-component-check-${randomUUID()}`)
  assert(!inside(original, root), 'Report directory must be outside the original component')
  if (installedConfig) assert(!inside(installedConfig.root, root), 'Report directory must be outside the installed configuration')
  // Explicit destinations must be new: existing workspaces and reports are never overwritten.
  await mkdir(root, { mode: 0o700 })
  const fixtures = join(root, 'fixtures'), unpacked = join(root, 'unpacked')
  await mkdir(fixtures); await mkdir(unpacked)
  const sourceVideo = fileURLToPath(new URL('../assets/v-ink.mp4', import.meta.url))
  const sourceImage = fileURLToPath(new URL('../assets/ink.jpg', import.meta.url))
  const sourceDigests = [sha256(await readFile(sourceVideo)), sha256(await readFile(sourceImage))]
  for (const [ratio, size] of [['3x4', '300:400'], ['4x3', '400:300'], ['16x9', '640:360']]) {
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', sourceImage, '-vf', `scale=${size}`, '-frames:v', '1', join(fixtures, `${ratio}.jpg`)], { timeout: 20_000 })
  }
  const store = new Store(join(root, 'workspace'), { markdown: false })
  const isolatedConfig = new MaitianConfig(join(root, 'local-config'))
  let config = isolatedConfig
  if (installedConfig) {
    // Export to the new report directory, but use the actual installed profile and Node settings.
    config = { root: isolatedConfig.root, resolve: () => installedOptions, public: () => installedConfig.public() }
  } else await isolatedConfig.save({ source: 'local', localComponentDir: original })
  const nodePath = config.resolve().nodePath
  const operations = [], runners = []
  const service = new MaitianPublishing(store, { config, run: request => {
    assert(['hello', 'validate'].includes(request.op), `Unexpected browser operation: ${request.op}`)
    assert.equal(request.nodePath, nodePath, 'Engine operation must use the configured Node runtime')
    operations.push(request.op)
    return runComponent({ ...request, onSpawn: ({ pid }) => { runners.push(pid) } })
  } })
  const probe = await service.probe()
  assert.equal(probe.diagnostic.compatibility, 'structural-compatible', JSON.stringify(probe.diagnostic))
  assert.equal(probe.implementation.directFill, false)
  if (installedEngine) assert.equal(probe.diagnostic.fingerprint, installedEngine.fingerprint, 'Installed component changed during verification')
  const cases = [], assets = new ContentAssets(store)
  const targets = [...MAITIAN_PLATFORMS.map(p => ({ platform: p.id, name: p.name, platforms: [p.id] })), { platform: 'all', name: '小红书', platforms: MAITIAN_PLATFORMS.map(p => p.id) }]
  for (const { platform, name, platforms } of targets) {
    for (const target of platforms) assert(probe.diagnostic.platforms[target]?.fields, `Original platform is unavailable: ${target}`)
    for (const mode of ['now', 'scheduled']) {
      const id = `${platform}-${mode}`
      await store.mutate('', state => { state.items.push({ id, title: '本地工程验收', body: '核对文案、封面与话题，仅检查工程格式。', platform: name, tags: ['工程校验', '验证样例'] }) }, { undoable: false })
      const video = await assets.import(id, createReadStream(sourceVideo), { name: '成片.mp4', revision: 0 })
      const vertical = await assets.import(id, createReadStream(join(fixtures, '3x4.jpg')), { name: '竖封面.jpg', revision: video.workspace.revision })
      const horizontal = await assets.import(id, createReadStream(join(fixtures, '4x3.jpg')), { name: '横封面.jpg', revision: vertical.workspace.revision })
      const wide = await assets.import(id, createReadStream(join(fixtures, '16x9.jpg')), { name: '宽屏封面.jpg', revision: horizontal.workspace.revision })
      const allCovers = { '3x4': vertical.asset.id, '4x3': horizontal.asset.id, '16x9': wide.asset.id }
      const covers = Object.fromEntries([...new Set(platforms.flatMap(p => COVER_RATIOS[p]))].map(ratio => [ratio, allCovers[ratio]]))
      const when = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(Date.now() + 24 * 3600_000)).replace(' ', 'T')
      const workspace = await assets.save(id, wide.workspace.revision, { ...wide.workspace, selectedVideo: video.asset.id,
        publish: { ...wide.workspace.publish, provider: 'maitian', mode, when: mode === 'scheduled' ? when : '', timezone: 'Asia/Shanghai', browser: { profileId: 'default', shortTitle: '本地工程校验短标题', covers, platforms } } })
      const { engineRef: exportEngine } = await service.resolve()
      const result = await service.export({ id, revision: workspace.revision, ...(platform === 'all' ? { platforms } : { platform }) })
      const archive = await service.archive(result.exportId)
      await exec('/usr/bin/tar', ['-xzf', archive.file, '-C', unpacked], { timeout: 30_000 })
      const folder = join(unpacked, result.exportId)
      const data = JSON.parse(await readFile(join(folder, 'publish.json'), 'utf8'))
      const manifest = JSON.parse(await readFile(join(folder, 'media-desk-manifest.json'), 'utf8'))
      assert.deepEqual(Object.keys(data.platforms), platforms)
      for (const target of platforms) {
        const entry = data.platforms[target]
        const selected = COVER_RATIOS[target].filter(ratio => covers[ratio])
        assert.deepEqual(entry.covers, target === 'instagram' ? selected.slice(0, 1) : selected)
        if (['x', 'instagram'].includes(target)) {
          assert.equal(entry[target === 'x' ? 'text' : 'caption'], '本地工程验收\n\n核对文案、封面与话题，仅检查工程格式。\n\n#工程校验 #验证样例')
        } else {
          assert.deepEqual(entry[target === 'bilibili' || target === 'youtube' ? 'tags' : 'topics'], ['工程校验', '验证样例'])
          assert.equal(entry[target === 'bilibili' || target === 'youtube' ? 'desc' : 'body'], '核对文案、封面与话题，仅检查工程格式。')
          assert.equal(entry[target === 'channels' ? 'shortTitle' : 'title'], target === 'channels' ? '本地工程校验短标题' : '本地工程验收')
        }
      }
      assert.equal(Object.hasOwn(data, 'schedule'), mode === 'scheduled')
      if (mode === 'scheduled') assert.equal(data.schedule, new Date(`${when}:00+08:00`).toISOString())
      for (const ratio of Object.keys(covers)) assert.equal(sha256(await readFile(join(folder, data.covers[ratio]))), sha256(await readFile(join(fixtures, `${ratio}.jpg`))))
      for (const asset of manifest.assets) assert.equal(sha256(await readFile(join(folder, asset.file))), asset.digest)
      assert.equal(sha256(await readFile(join(folder, data.video))), sourceDigests[0])
      const engineRef = await inspectEngine(original), files = ['publish.json', ...manifest.assets.map(asset => asset.file)]
      const exported = await service.run({ nodePath, op: 'validate', engineRef: exportEngine, data, files })
      assert.equal(exported.errors.length, 0, JSON.stringify(exported))
      const missing = await service.run({ nodePath, op: 'validate', engineRef, data, files: files.filter(file => file !== data.video) })
      assert(missing.errors.length > 0, 'Original validator accepted a missing video')
      const firstPlatform = platforms[0]
      const [field, [, maximum]] = Object.entries(probe.diagnostic.platforms[firstPlatform].fields)[0]
      assert(Number.isInteger(maximum), 'Original field range is unavailable')
      const excessive = structuredClone(data)
      excessive.platforms[firstPlatform][field] = '字'.repeat(maximum + 1)
      const rejected = await service.run({ nodePath, op: 'validate', engineRef, data: excessive, files })
      assert(rejected.errors.length > 0, 'Original validator accepted an excessive field')
      cases.push({ platform, platforms, mode, exportId: result.exportId, schedule: data.schedule || null, covers: Object.keys(covers), assets: manifest.assets,
        warnings: result.warnings, missingMediaRejected: true, excessiveFieldRejected: true })
    }
  }
  const { stdout } = await exec(nodePath, [script, '--scan-exports', original, unpacked], { timeout: 30_000, maxBuffer: 2_000_000 })
  const scanner = JSON.parse(stdout), scanned = scanner.projects
  assert.equal(scanner.runtimeVersion, probe.diagnostic.runtimeVersion, 'Scanner and engine runtime versions differ')
  assert.equal(scanned.length, cases.length)
  for (const result of scanned) assert.deepEqual(result.data, JSON.parse(await readFile(join(unpacked, result.dir, 'publish.json'), 'utf8')))
  assert.equal((await readdir(store.root)).includes('.publish-records.json'), false)
  assert.deepEqual(await tree(original), before, 'Original component was changed')
  if (installedConfig) {
    assert.deepEqual(await readFile(installedConfig.file), installedConfigBytes, 'Installed configuration was changed')
    const discoveredAgain = await discoverEngine(installedConfig.resolve())
    assert.equal(discoveredAgain.dir, installedEngine.dir, 'Installed component changed during verification; rerun')
    assert.equal(discoveredAgain.fingerprint, installedEngine.fingerprint, 'Installed component changed during verification; rerun')
  }
  assert.deepEqual([sha256(await readFile(sourceVideo)), sha256(await readFile(sourceImage))], sourceDigests)
  assert.equal(new Set(runners).size, runners.length, 'An engine process was reused')
  const report = { checkedAt: new Date().toISOString(), runtime: {
    verifier: { node: process.version, executable: process.execPath, os: process.platform, arch: process.arch },
    component: { node: probe.diagnostic.runtimeVersion, executable: nodePath },
    scanner: { node: scanner.runtimeVersion, executable: nodePath },
  },
    component: { source: installedConfig ? 'store' : 'local', directory: original, version: probe.diagnostic.detectedVersion, fingerprint: probe.diagnostic.fingerprint, files: Object.keys(before).length, treeDigest: sha256(JSON.stringify(before)) },
    contract: probe.diagnostic, cases, originalScannerProjects: scanned.map(project => ({ dir: project.dir, validation: project.validation })),
    operations, distinctRunnerCount: runners.length, componentUnchanged: true, sourceMediaUnchanged: true, publishRecordsCreated: false,
    installedConfigUnchanged: installedConfig ? true : null,
    verified: [...(installedConfig ? ['installed-store-discovery'] : []), 'read-only-module-loading', 'original-validation', 'project-export', 'original-project-scanner'],
    notVerified: ['store-installation-provenance', 'browser-extension-panel', 'login', 'platform-fill', 'final-submit-behaviour', 'result-query', 'installed-version-update'],
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ report: join(root, 'report.json'), componentVersion: report.component.version, cases: cases.length, componentUnchanged: true, originalScannerProjects: scanned.length, distinctRunnerCount: runners.length }, null, 2))
}

try {
  const args = process.argv.slice(2)
  if (args[0] === '--scan-exports' && args.length === 3) console.log(JSON.stringify(await scan(args[1], args[2])))
  else if (!args.length || args[0] === '--help') console.log('Usage: node scripts/verify-maitian-component.mjs (--component-dir /absolute/original | --installed-config-dir /absolute/maitian-config-root) [--output-dir /new/report-folder]\nOnly offline compatibility checks; no browser, installation, login or upload. Installed mode requires an existing config.json with source: store; exports and reports use a separate new directory.')
  else {
    assert(['--component-dir', '--installed-config-dir'].includes(args[0]) && args[1] && (args.length === 2 || args.length === 4 && args[2] === '--output-dir' && args[3]), 'Invalid arguments; use --help')
    await verify(args[0] === '--component-dir' ? args[1] : null, args[3], args[0] === '--installed-config-dir' ? args[1] : null)
  }
} catch (error) { console.error(error.stack || error.message); process.exitCode = 1 }
