import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MaitianConfig } from '../src/publish/maitian/config.js'
import { STORE_ID } from '../src/publish/maitian/engine-loader.mjs'

const exec = promisify(execFile)
const verifier = fileURLToPath(new URL('../scripts/verify-maitian-component.mjs', import.meta.url))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

test('离线验收所有执行器和扫描使用配置的 Node，配置不可用时拒绝回退', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-maitian-verifier-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = new MaitianConfig(join(root, 'config'))
  const component = join(config.resolve().profileDir, 'Default', 'Extensions', STORE_ID, '1.0.0_0')
  await mkdir(join(component, 'lib'), { recursive: true })
  // Synthetic two-platform contract only; this does not prove a real store installation.
  await writeFile(join(component, 'manifest.json'), JSON.stringify({ name: 'Synthetic verifier contract', version: '1.0.0' }))
  await writeFile(join(component, 'lib/bundle.js'), `
    if (process.env.MEDIA_DESK_VERIFIER_RUNTIME !== 'configured') throw Error('Wrong runtime');
    export const PLATFORMS = {
      xhs: { name: '小红书', fields: { title: [1, 20], body: [1, 1000] } },
      channels: { name: '视频号', fields: { shortTitle: [1, 20], body: [1, 1000] } },
    };
    export function validate(data, files) {
      const [platform, fields] = Object.entries(data.platforms)[0];
      const field = platform === 'xhs' ? 'title' : 'shortTitle';
      return { errors: !files.has(data.video) || fields[field].length > 20 ? ['Synthetic rejection'] : [], warnings: [] };
    }
  `)
  await writeFile(join(component, 'lib/publish.js'), `
    import { validate } from './bundle.js';
    export const ADAPTERS = { xhs: {}, channels: {} };
    export async function scanProjects(root) {
      const projects = [];
      for await (const [dir, handle] of root.entries()) {
        if (handle.kind !== 'directory') continue;
        const files = new Set(); let data;
        for await (const [name, file] of handle.entries()) {
          files.add(name);
          if (name === 'publish.json') data = JSON.parse(await (await file.getFile()).text());
        }
        projects.push({ dir, data, files });
      }
      return projects;
    }
    export async function check(project) { return validate(project.data, project.files); }
  `)
  const audit = join(root, 'runtime-audit.jsonl'), guard = join(root, 'runtime-guard.mjs'), nodePath = join(root, 'configured-node')
  await writeFile(guard, `import { appendFileSync } from 'node:fs';
    process.env.MEDIA_DESK_VERIFIER_RUNTIME = 'configured';
    appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ pid: process.pid, argv: process.argv }) + '\\n');`)
  await writeFile(nodePath, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(guard)} "$@"\n`, { mode: 0o700 })
  await config.save({ source: 'store', nodePath })
  const before = await readFile(config.file)
  const alias = join(root, 'component-alias')
  await symlink(component, alias)
  for (const [destination, message] of [
    [join(component, 'report'), /outside the original component/],
    [join(alias, 'report'), /outside the original component/],
    [join(config.root, 'report'), /outside the installed configuration/],
  ]) {
    await assert.rejects(exec(process.execPath, [verifier, '--installed-config-dir', config.root, '--output-dir', destination], { timeout: 30_000 }), error => {
      assert.match(error.stderr, message)
      return true
    })
    await assert.rejects(readFile(destination), { code: 'ENOENT' })
  }
  assert.deepEqual(await readFile(config.file), before)
  await assert.rejects(readFile(audit), { code: 'ENOENT' })
  const output = join(root, 'report')
  await exec(process.execPath, [verifier, '--installed-config-dir', config.root, '--output-dir', output], { timeout: 60_000, maxBuffer: 2_000_000 })
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  const processes = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(processes.length, 18)
  assert.equal(new Set(processes.map(row => row.pid)).size, 18)
  assert.equal(processes.filter(row => row.argv.includes('--scan-exports')).length, 1)
  assert.equal(report.distinctRunnerCount, 17)
  assert.equal(report.operations.filter(op => op === 'validate').length, 12)
  assert.equal(report.cases.length, 4)
  assert.equal(report.originalScannerProjects.length, 4)
  assert.equal(report.runtime.verifier.executable, process.execPath)
  assert.deepEqual(report.runtime.component, { executable: nodePath, node: process.version })
  assert.deepEqual(report.runtime.scanner, report.runtime.component)
  assert.equal(report.componentUnchanged, true)
  assert.equal(report.installedConfigUnchanged, true)
  assert.deepEqual(await readFile(config.file), before)

  await config.save({ nodePath: join(root, 'missing-node') })
  const invalid = await readFile(config.file)
  await assert.rejects(exec(process.execPath, [verifier, '--installed-config-dir', config.root, '--output-dir', join(root, 'failed-report')], { timeout: 30_000 }), error => {
    assert.match(error.stderr, /RUNNER_START_FAILED/)
    return true
  })
  assert.deepEqual(await readFile(config.file), invalid)
  await assert.rejects(readFile(join(root, 'failed-report', 'report.json')), { code: 'ENOENT' })
  assert.equal((await readFile(audit, 'utf8')).trim().split('\n').length, 18)
})
